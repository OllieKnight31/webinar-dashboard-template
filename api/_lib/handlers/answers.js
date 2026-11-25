// The questionnaires: what has been answered, and the documents people upload beside them.
//   GET  /api?action=answers         → { catalogue, answers: { key: { question id: answer } }, files, limits }
//   POST /api?source=answers         → save { key, answers: { question id: answer } } (merged, one answer at a time)
//                                      `_link` in answers = a link to their finished copy of the document
//   POST /api?source=upload          → add { key, name, data } (data = the file, base64)   owner only
//   POST /api?source=file_delete     → remove { id }                                       owner only
//   GET  /api?action=file&id=…       → the file itself, as a download
//
// `key` is a questionnaire id, or `id.n` for one that can be filled in several times (one
// client success story per client). Reading is open to the owner and to the build key, so the
// build can pull everything down; see api/index.js.
//
// A file is kept in the same store as everything else, encrypted, cut into pieces small
// enough for any Redis plan. That is why there is a size limit: big things such as videos go
// in as a link to a shared folder instead.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('../settings-store');
const { QUESTIONNAIRES, questionsOf, resolve } = require('../questionnaires');

const MAX_ANSWER = 20000;                 // characters in one answer (a pasted transcript fits)
const MAX_FILE_BYTES = 3 * 1024 * 1024;   // one file. Vercel refuses a request over 4.5 MB, and base64 adds a third
const MAX_FILES = 60;
const PIECE = 400000;                     // base64 characters per stored piece
const ALLOWED = ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'pages', 'csv', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic', 'mp3', 'm4a', 'wav'];
const LIMITS = { file_mb: MAX_FILE_BYTES / 1048576, files: MAX_FILES, types: ALLOWED };

const NO_STORAGE = { code: 503, body: { status: 'error', reason: 'no_storage', message: 'Nowhere to save yet. In Vercel open this project, then Storage, add Upstash Redis, connect it and redeploy.' } };
const bad = (message, code = 400) => ({ code, body: { status: 'error', message } });

// ── Answers ─────────────────────────────────────────────────────────────────
function cleanAnswer(question, value) {
  if (question.type === 'ticks') return (Array.isArray(value) ? value : []).filter(v => question.options.includes(v));
  return value === null || value === undefined || typeof value === 'object' ? '' : String(value).trim().slice(0, MAX_ANSWER);
}
const filled = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

async function readAll() {
  const answers = ((await store.loadDoc('answers')) || {}).answers || {};
  const files = ((await store.loadDoc('files')) || {}).files || [];
  return { answers, files };
}
const publicFile = (f) => ({ id: f.id, key: f.key, name: f.name, size: f.size, added_at: f.added_at });

async function getAnswers() {
  const { answers, files } = await readAll();
  return { code: 200, body: { status: 'ok', storage: store.backend(), catalogue: QUESTIONNAIRES, answers, files: files.map(publicFile), limits: LIMITS } };
}

async function postAnswers(body) {
  if (store.backend() === 'none') return NO_STORAGE;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hit = resolve(b.key);
  if (!hit) return bad('That is not one of the questionnaires.');
  const sent = b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? b.answers : null;
  if (!sent) return bad('Send { key, answers: { question: answer } }.');
  const doc = (await store.loadDoc('answers')) || {};
  const all = { ...(doc.answers || {}) };
  const mine = { ...(all[hit.key] || {}) };
  for (const question of questionsOf(hit.questionnaire)) {
    if (!(question.id in sent)) continue;
    const value = cleanAnswer(question, sent[question.id]);
    if (filled(value)) mine[question.id] = value; else delete mine[question.id];
  }
  // `_link`: where their finished copy lives (a Google Doc, or anything else they can share)
  if ('_link' in sent) {
    const link = String(sent._link === null || sent._link === undefined ? '' : sent._link).trim().slice(0, 1000);
    if (link && !/^https?:\/\/\S+$/i.test(link)) return bad('That does not look like a link. Copy it from the address bar of your document. It starts with https://');
    if (link) mine._link = link; else delete mine._link;
  }
  if (Object.keys(mine).length) all[hit.key] = mine; else delete all[hit.key];
  await store.saveDoc('answers', { answers: all, updated_at: new Date().toISOString() });
  return { code: 200, body: { status: 'ok', key: hit.key, answers: mine } };
}

// ── Files ───────────────────────────────────────────────────────────────────
const pieceName = (id, i) => `file-${id}-${i}`;

async function writePieces(id, base64) {
  const pieces = Math.max(1, Math.ceil(base64.length / PIECE));
  for (let i = 0; i < pieces; i++) {
    const blob = store.encrypt({ d: base64.slice(i * PIECE, (i + 1) * PIECE) });
    if (store.backend() === 'kv') await store.kv(['SET', store.k(pieceName(id, i)), blob]);
    else store.fileWrite(`${pieceName(id, i)}.json`, blob);
  }
  return pieces;
}
async function readPieces(id, pieces) {
  let base64 = '';
  for (let i = 0; i < pieces; i++) {
    const blob = store.backend() === 'kv' ? await store.kv(['GET', store.k(pieceName(id, i))]) : store.fileRead(`${pieceName(id, i)}.json`);
    if (!blob) return null;
    base64 += store.decrypt(blob).d;
  }
  return base64;
}
async function removePieces(id, pieces) {
  for (let i = 0; i < pieces; i++) {
    if (store.backend() === 'kv') await store.kv(['DEL', store.k(pieceName(id, i))]);
    else fs.rmSync(path.join(store.dataDir(), `${pieceName(id, i)}.json`), { force: true });
  }
}

/** A name that is safe to save under and to show: no folders, no odd characters. */
function cleanName(name) {
  const base = String(name === null || name === undefined ? '' : name).split(/[\\/]/).pop().replace(/[^\w .()&,+'@-]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(base) || [])[1];
  return { name: base, ext: ext ? ext.toLowerCase() : '' };
}

async function postUpload(body) {
  if (store.backend() === 'none') return NO_STORAGE;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hit = resolve(b.key);
  if (!hit) return bad('That is not one of the questionnaires.');
  const { name, ext } = cleanName(b.name);
  if (!name || !ALLOWED.includes(ext)) return bad('We cannot take that kind of file. Use a document, a spreadsheet, a slide deck, a picture or a short sound file. For anything else, paste a link to it instead.');
  const base64 = String(b.data || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return bad('That file did not arrive in one piece. Try again.');
  const size = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (size > MAX_FILE_BYTES) return bad(`That file is bigger than ${LIMITS.file_mb} MB. Put it in Google Drive or Dropbox and paste the link instead.`, 413);
  const doc = (await store.loadDoc('files')) || {};
  const files = Array.isArray(doc.files) ? doc.files.slice() : [];
  if (files.length >= MAX_FILES) return bad(`You have added ${MAX_FILES} documents, which is the most this can hold. Remove one, or put the rest in a shared folder and paste the link.`);
  const id = crypto.randomBytes(8).toString('hex');
  const pieces = await writePieces(id, base64);
  files.push({ id, key: hit.key, name, size, pieces, added_at: new Date().toISOString() });
  await store.saveDoc('files', { files });
  return { code: 200, body: { status: 'ok', file: publicFile(files[files.length - 1]), files: files.map(publicFile) } };
}

async function postFileDelete(body) {
  if (store.backend() === 'none') return NO_STORAGE;
  const id = String((body && body.id) || '');
  const doc = (await store.loadDoc('files')) || {};
  const files = Array.isArray(doc.files) ? doc.files : [];
  const file = files.find(f => f.id === id);
  if (!file) return bad('That document is not here any more.', 404);
  await removePieces(file.id, file.pieces);
  const left = files.filter(f => f.id !== id);
  await store.saveDoc('files', { files: left });
  return { code: 200, body: { status: 'ok', files: left.map(publicFile) } };
}

/** → { name, buffer } or null when there is no such file. */
async function getFile(id) {
  const files = ((await store.loadDoc('files')) || {}).files || [];
  const file = files.find(f => f.id === String(id || ''));
  if (!file) return null;
  const base64 = await readPieces(file.id, file.pieces);
  return base64 === null ? null : { name: file.name, buffer: Buffer.from(base64, 'base64') };
}

module.exports = { getAnswers, postAnswers, postUpload, postFileDelete, getFile, LIMITS, MAX_FILE_BYTES };
