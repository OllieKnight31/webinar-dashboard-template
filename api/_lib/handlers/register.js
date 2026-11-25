// POST /api?source=register   — the public registration relay
// POST /api?source=survey     — the confirmation page's survey
//
// The funnel pages are hosted somewhere else (GoHighLevel, Lovable, anywhere) and post here,
// so the CRM, the webinar platform and the dashboard all see every registrant. Both routes
// are public: no login, no key in the page. What protects them instead:
//   • a honeypot field (`company_website`) that a person never fills — a submission with it
//     filled is answered 200 ok and dropped, so a bot learns nothing;
//   • validation (a real-looking email, bounded lengths);
//   • a rate limit per IP address and per email (shared across instances when Redis is attached);
//   • "Sites allowed to send sign-ups" on Settings: when filled, a request whose Origin is not on the
//     list is refused.
// No platform or CRM key ever leaves the server: the response carries only the join link the
// platform returned, the confirmation address and a list of steps.
//
// register does, in order — and a failure in 1 or 2 never stops 3:
//   1. crm        upsert the contact (tag / status + UTM fields)            api/_lib/crm-write.js
//   2. platform   register on the webinar platform, where its API allows    sync/webinar/<adapter>.register
//   3. sheet      save the row to WEBINAR REGISTRANTS (Source = relay). The step keeps its old
//                 name in the answer because pages already read it.
// A failed step is posted to the alerts channel.

const { config } = require('../config');
const db = require('../db');
const { alert } = require('../alerts');
const crm = require('../crm-write');
const { rateLimit } = require('../settings-store');

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
const LIMITS = { ip: [20, 600], email: [5, 3600] };     // [requests, per seconds]

const text = (v, max = 200) => (v === null || v === undefined || typeof v === 'object' ? '' : String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max));
const step = (name, status, message = '') => ({ name, status, message });

// ── Origin ──────────────────────────────────────────────────────────────────
/**
 * Which Origin may call these two routes. → { allowed, header }
 * No list saved = any origin (`*`). A list = only those origins; a request with no Origin
 * header at all (a server, curl) is let through, because the list is about browsers.
 */
function checkOrigin(origin) {
  const list = config.webinar.allowed_origins || [];
  const o = String(origin || '').replace(/\/+$/, '').toLowerCase();
  if (!list.length) return { allowed: true, header: '*' };
  if (!o) return { allowed: true, header: list[0] };
  return list.includes(o) ? { allowed: true, header: o } : { allowed: false, header: list[0] };
}

// ── Redirect ────────────────────────────────────────────────────────────────
/** The saved confirmation page address with first_name and email added. '' when none is saved. */
function buildRedirect(firstName, email, base = config.webinar.confirmation_url) {
  if (!base) return '';
  let u;
  try { u = new URL(base); } catch { return ''; }
  if (firstName) u.searchParams.set('first_name', firstName);
  u.searchParams.set('email', email);
  return u.toString();
}

// ── Validation ──────────────────────────────────────────────────────────────
function normalise(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const full = text(b.name || b.full_name, 120);
  const first = text(b.first_name || b.firstName, 80) || full.split(/\s+/)[0] || '';
  const source = text(b.funnel_source, 20).toLowerCase();
  return {
    honeypot: text(b.company_website, 500),
    first_name: first,
    last_name: text(b.last_name || b.lastName, 80) || full.split(/\s+/).slice(1).join(' '),
    email: text(b.email, 256).toLowerCase(),
    phone: text(b.phone, 40).replace(/[^\d+()\-.\s]/g, ''),
    webinar_id: text(b.webinar_id, 80),
    session: text(b.session, 80),
    utm_source: text(b.utm_source), utm_medium: text(b.utm_medium), utm_campaign: text(b.utm_campaign),
    utm_content: text(b.utm_content), utm_term: text(b.utm_term),
    fbclid: text(b.fbclid, 400), page_url: text(b.page_url, 500),
    funnel_source: source === 'paid' || source === 'organic' ? source : '',
  };
}

function invalid(p, needName) {
  const fields = {};
  if (!p.email) fields.email = 'Enter your email address.';
  else if (!EMAIL_RE.test(p.email)) fields.email = 'That email address does not look right.';
  if (needName && !p.first_name) fields.first_name = 'Enter your first name.';
  return Object.keys(fields).length ? fields : null;
}

async function limited(p, ip) {
  const [ipMax, ipWindow] = LIMITS.ip, [emailMax, emailWindow] = LIMITS.email;
  if (ip && !(await rateLimit(`ip:${ip}`, ipMax, ipWindow))) return true;
  return !(await rateLimit(`email:${p.email}`, emailMax, emailWindow));
}

const TOO_MANY = { http: 429, body: { ok: false, status: 'error', message: 'Too many attempts. Please wait a few minutes and try again.', steps: [] } };

async function alertFailed(what, p, failed) {
  await alert(`${config.brand.name}: ${what} needs attention`, [`${p.email} was saved, but:`, ...failed.map(s => `${s.name}: ${s.message}`)]);
}

// ── register ────────────────────────────────────────────────────────────────
/**
 * @param {object} body  first_name, email, phone?, webinar_id?, session?, utm_*, fbclid, page_url, funnel_source, company_website (honeypot)
 * @param {{ip?: string}} meta
 * → { http, body: { ok, status, join_url?, redirect, steps: [{name, status, message}] } }
 */
async function handleRegister(body, meta = {}) {
  const p = normalise(body);
  // A filled honeypot gets the same answer a real registration does, and nothing happens.
  if (p.honeypot) return { http: 200, body: { ok: true, status: 'ok', redirect: buildRedirect('', ''), steps: [] } };
  const fields = invalid(p, true);
  if (fields) return { http: 400, body: { ok: false, status: 'invalid', message: 'Some fields need fixing', fields, steps: [] } };
  if (await limited(p, meta.ip)) return TOO_MANY;

  const steps = [];
  const now = new Date().toISOString();
  const webinar = require('../sync/webinar');
  const adapter = webinar.adapter();
  const webinarId = p.webinar_id || (config.webinar.webinar_ids || [])[0] || '';

  // 1. CRM
  const c = await crm.upsertRegistrant(p);
  steps.push(step('crm', c.status, c.message));

  // 2. Webinar platform
  let joinUrl = '', platformId = '';
  if (!adapter) steps.push(step('platform', 'skipped', 'no webinar platform connected'));
  else if (typeof adapter.register !== 'function') steps.push(step('platform', 'skipped', adapter.REGISTER_UNSUPPORTED || `${adapter.label} cannot be registered by API`));
  else if (!webinarId) steps.push(step('platform', 'skipped', 'no webinar chosen yet: pick one under Webinar platform on the Settings page'));
  else {
    try {
      const out = await adapter.register({ ...p, webinar_id: webinarId, ip: meta.ip });
      joinUrl = out.join_url || ''; platformId = out.registrant_id || '';
      steps.push(step('platform', 'ok', `registered on ${adapter.label}`));
    } catch (e) {
      steps.push(step('platform', 'error', String((e && e.message) || 'registration failed').slice(0, 200)));
    }
  }

  // 3. Sheet — always attempted, whatever happened above
  const provider = adapter ? adapter.id : 'relay';
  const registrant = {
    id: `relay:${provider}:${webinarId}:${p.email}:${now.slice(0, 10)}`,
    provider, webinar_id: webinarId, webinar_name: '', session_id: p.session, session_at: '',
    email: p.email, name: [p.first_name, p.last_name].filter(Boolean).join(' '), phone: p.phone, registered_at: now,
    attended_live: null, minutes_watched: null, percent_watched: null, stayed_to_pitch: null, watched_replay: null, purchased: null, revenue: null,
    utm_source: p.utm_source, utm_medium: p.utm_medium, utm_campaign: p.utm_campaign, utm_content: p.utm_content, utm_term: p.utm_term,
    join_url: joinUrl, funnel_source: p.funnel_source,
  };
  let saved = false;
  if (!db.isConfigured()) steps.push(step('sheet', 'error', 'nowhere to save yet: storage is not connected'));
  else {
    try {
      await db.appendRows(db.TABS.WEBINAR_REGISTRANTS, [webinar.toRow(registrant, now, 'relay')]);
      saved = true;
      steps.push(step('sheet', 'ok', 'saved'));
    } catch (e) {
      steps.push(step('sheet', 'error', `saving failed: ${e.message}`));
    }
  }

  const failed = steps.filter(s => s.status === 'error');
  if (failed.length) await alertFailed('a webinar registration', p, failed);
  const out = { ok: saved, status: saved ? 'ok' : 'error', redirect: buildRedirect(p.first_name, p.email), steps };
  if (joinUrl) out.join_url = joinUrl;
  if (!saved) out.message = 'The registration could not be saved. Please try again.';
  // 500 when nothing was stored, so the page can ask the visitor to try again
  return { http: saved ? 200 : 500, body: out };
}

// ── survey ──────────────────────────────────────────────────────────────────
/** Up to three {question, answer} pairs from `answers: [...]`, or question_1 / answer_1 … keys. */
function surveyPairs(b) {
  const pairs = [];
  const list = Array.isArray(b.answers) ? b.answers : [];
  for (const a of list) if (a && typeof a === 'object') pairs.push([text(a.question || a.q, 300), text(a.answer || a.a, 1000)]);
  for (const i of [1, 2, 3]) {
    const a = text(b[`answer_${i}`] ?? b[`a${i}`], 1000);
    if (a) pairs.push([text(b[`question_${i}`] ?? b[`q${i}`], 300), a]);
  }
  return pairs.filter(([, a]) => a).slice(0, 3);
}

/**
 * @param {object} body  email, name?, webinar_id?, page_url?, answers: [{question, answer}] (up to 3), company_website (honeypot)
 * → { http, body: { ok, status, steps } }
 */
async function handleSurvey(body, meta = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const p = normalise(b);
  if (p.honeypot) return { http: 200, body: { ok: true, status: 'ok', steps: [] } };
  const fields = invalid(p, false);
  const pairs = surveyPairs(b);
  if (fields || !pairs.length) {
    return { http: 400, body: { ok: false, status: 'invalid', message: fields ? 'Some fields need fixing' : 'Send at least one answer', fields: fields || { answers: 'Send at least one answer.' }, steps: [] } };
  }
  if (await limited(p, meta.ip)) return TOO_MANY;

  const steps = [];
  const now = new Date().toISOString();
  const flatPairs = [0, 1, 2].flatMap(i => (pairs[i] ? pairs[i] : ['', '']));
  let saved = false;
  if (!db.isConfigured()) steps.push(step('sheet', 'error', 'nowhere to save yet: storage is not connected'));
  else {
    try {
      await db.appendRows(db.TABS.WEBINAR_SURVEY, [[now, p.email, [p.first_name, p.last_name].filter(Boolean).join(' '), p.webinar_id, ...flatPairs, p.page_url]]);
      saved = true;
      steps.push(step('sheet', 'ok', 'saved'));
    } catch (e) { steps.push(step('sheet', 'error', `saving failed: ${e.message}`)); }
  }
  const note = ['Webinar survey answers:', ...pairs.map(([q, a], i) => `${q || `Question ${i + 1}`}: ${a}`)].join('\n');
  const c = await crm.addNote(p.email, note);
  steps.push(step('crm', c.status, c.message));

  const failed = steps.filter(s => s.status === 'error');
  if (failed.length && saved) await alertFailed('a webinar survey answer', p, failed);
  return { http: saved ? 200 : 500, body: { ok: saved, status: saved ? 'ok' : 'error', steps, ...(saved ? {} : { message: 'The answers could not be saved. Please try again.' }) } };
}

module.exports = { handleRegister, handleSurvey, checkOrigin, buildRedirect, normalise, surveyPairs, LIMITS };
