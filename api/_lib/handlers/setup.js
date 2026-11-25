// Setup handlers: the answers, the look, the build board and the go-live checklist.
//   GET  /api?action=intake          → { intake, design, tools, progress, complete, missing, catalogue }
//   POST /api?source=intake          → save { intake?, design?, progress? } (each merged over what is saved)
//   GET  /api?action=build_status    → { items: [{ id, label, status, link, note, updated_at }] }
//   POST /api?source=build_status    → upsert { items: [{ id, status?, link?, note?, label? }] } or one item
//   GET  /api?action=golive          → { checks: [{ id, label, help, done }] }
//   POST /api?source=golive          → tick or untick { id, done }
//
// Who may call them is decided in api/index.js: a signed-in owner, or (intake and the build
// board only) the skill's scripts with `Authorization: Bearer <BUILD_KEY>`.
// Everything is saved through the settings store: encrypted, in Redis on Vercel and .data/
// locally, never in env vars. The Setup page saves on every change, so every POST merges.

const { backend, loadDoc, saveDoc } = require('../settings-store');

const NO_STORAGE = { code: 503, body: { status: 'error', reason: 'no_storage', message: 'Nowhere to save yet. In Vercel open this project, then Storage, add Upstash Redis, connect it and redeploy.' } };

// ── Intake ──────────────────────────────────────────────────────────────────
const text = (max) => (v) => (v === null || v === undefined || typeof v === 'object' ? '' : String(v).trim().slice(0, max));
const list = (maxItems, maxLength) => (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? v.split('\n') : []))
  .map(text(maxLength)).filter(Boolean).slice(0, maxItems);
const choice = (...allowed) => (v) => { const x = String(v === null || v === undefined ? '' : v).trim().toLowerCase(); return allowed.includes(x) ? x : ''; };
const results = (v) => (Array.isArray(v) ? v : []).filter(r => r && typeof r === 'object').slice(0, 3).map(r => ({
  name: text(120)(r.name), before: text(600)(r.before), after: text(600)(r.after), permission: r.permission === true || /^(yes|y|true)$/i.test(String(r.permission || '')),
})).filter(r => r.name || r.before || r.after);

// field → [cleaner, required?]. The page lays these out; the build reads them by these names.
const INTAKE = {
  business_name: [text(120), true],
  hosts: [list(6, 120), true],
  webinar_title: [text(200), true],
  webinar_format: [choice('live', 'automated'), true],
  webinar_date: [text(40)],                 // live: the date, YYYY-MM-DD
  webinar_time: [text(20)],                 // live: the start time, HH:MM
  timezone: [text(60)],
  schedule: [text(300)],                    // automated: how often it runs, in words
  offer_name: [text(200), true],
  offer_price: [text(60), true],
  how_people_buy: [choice('call', 'webinar')],      // book a call, or buy on the webinar itself
  booking_link: [text(500)],
  audience: [text(2000), true],
  pains: [list(10, 400), true],
  outcomes: [list(10, 400), true],
  objections: [list(12, 400), true],
  client_results: [results],
  compliance_notes: [text(3000)],
  webinar_platform: [choice('webinarjam', 'everwebinar', 'ewebinar', 'aevent', 'other', 'none'), true],
  crm: [choice('ghl', 'close', 'other', 'none'), true],
  page_host: [choice('ghl', 'lovable', 'other', 'none'), true],
  email_tool: [text(120), true],
  sms_tool: [text(120)],
  calendar: [choice('calendly', 'other', 'none')],
  payments: [choice('stripe', 'whop', 'commas', 'paypal', 'ghl', 'kajabi', 'lemonsqueezy', 'paddle', 'other', 'none')],
  ads: [choice('meta', 'other', 'none')],
};
// The "which one do you use?" answers, also returned on their own as `tools`.
const TOOL_KEYS = ['webinar_platform', 'crm', 'page_host', 'email_tool', 'sms_tool', 'calendar', 'payments', 'ads'];
const LIST_MINIMUM = { pains: 5, outcomes: 5, objections: 1 };

function cleanIntake(raw, base = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, [clean]] of Object.entries(INTAKE)) {
    out[key] = clean(key in src ? src[key] : base[key]);
    // a choice we do not recognise never wipes a good answer that is already saved
    if (key in src && out[key] === '' && typeof src[key] === 'string' && src[key].trim() !== '') out[key] = clean(base[key]);
  }
  return out;
}

/** What still has to be filled in before the build can start. */
function missingFields(intake) {
  const missing = [];
  for (const [key, [, required]] of Object.entries(INTAKE)) {
    const v = intake[key];
    const min = LIST_MINIMUM[key] || 1;
    if (required && (Array.isArray(v) ? v.length < min : !v)) missing.push(key);
  }
  if (intake.webinar_format === 'live' && !(intake.webinar_date && intake.webinar_time && intake.timezone)) missing.push('webinar_date');
  if (intake.webinar_format === 'automated' && !intake.schedule) missing.push('schedule');
  if ((intake.client_results || []).length < 3) missing.push('client_results');
  if (intake.how_people_buy !== 'webinar' && !intake.booking_link) missing.push('booking_link');
  return missing;
}

// ── Design ──────────────────────────────────────────────────────────────────
// The visual choices, as a small object a page generator can take as is. The page draws its
// preview cards from this same catalogue (sent with every GET), so what is clicked is what
// is stored.
const PRESETS = [
  { id: 'dark_bold', label: 'Dark bold', mode: 'dark', background: '#0B0D12', surface: '#151923', text: '#F5F7FA', muted: '#9AA4B2', brand: '#FF5A1F', fonts: 'grotesk', radius: 'rounded' },
  { id: 'clean_light', label: 'Clean light', mode: 'light', background: '#FFFFFF', surface: '#F4F6F9', text: '#111827', muted: '#5B6472', brand: '#2563EB', fonts: 'modern', radius: 'rounded' },
  { id: 'editorial_serif', label: 'Editorial serif', mode: 'light', background: '#FBF8F3', surface: '#F1EBE1', text: '#1C1917', muted: '#6B625A', brand: '#9A3412', fonts: 'editorial', radius: 'square' },
  { id: 'warm_minimal', label: 'Warm minimal', mode: 'light', background: '#FAF6F0', surface: '#F0E9DF', text: '#2B2622', muted: '#7A6F66', brand: '#C2410C', fonts: 'humanist', radius: 'pill' },
  { id: 'high_contrast', label: 'High contrast', mode: 'dark', background: '#000000', surface: '#111111', text: '#FFFFFF', muted: '#C7C7C7', brand: '#FACC15', fonts: 'impact', radius: 'square' },
];
const FONT_PAIRS = [
  { id: 'modern', label: 'Inter and Inter', heading: 'Inter', body: 'Inter' },
  { id: 'grotesk', label: 'Space Grotesk and Inter', heading: 'Space Grotesk', body: 'Inter' },
  { id: 'editorial', label: 'Playfair Display and Source Sans 3', heading: 'Playfair Display', body: 'Source Sans 3' },
  { id: 'humanist', label: 'DM Serif Display and DM Sans', heading: 'DM Serif Display', body: 'DM Sans' },
  { id: 'impact', label: 'Anton and Inter', heading: 'Anton', body: 'Inter' },
];
const HERO_LAYOUTS = [
  { id: 'video_popup', label: 'Video above the button, form opens in a pop-up' },
  { id: 'split_form', label: 'Split hero with the form visible' },
];
const BUTTON_SHAPES = [{ id: 'square', label: 'Square' }, { id: 'rounded', label: 'Rounded' }, { id: 'pill', label: 'Pill' }];
const CATALOGUE = { presets: PRESETS, font_pairs: FONT_PAIRS, hero_layouts: HERO_LAYOUTS, button_shapes: BUTTON_SHAPES };

const HEX = /^#[0-9a-fA-F]{6}$/;
const known = (items) => (id) => items.some(x => x.id === id);

/**
 * Whatever was sent → a complete design object. Each choice is taken from what was sent if
 * that is valid, else from what is already saved, else from the preset's own default — so a
 * bad value never overwrites a good one.
 */
function cleanDesign(raw, base = {}) {
  const sent = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const saved = base && typeof base === 'object' ? base : {};
  const choose = (key, valid, fallback) => (valid(sent[key]) ? sent[key] : valid(saved[key]) ? saved[key] : fallback);
  const preset = PRESETS.find(p => p.id === choose('preset', known(PRESETS), PRESETS[1].id));
  const fontId = choose('font_pairing', known(FONT_PAIRS), preset.fonts);
  const fonts = FONT_PAIRS.find(f => f.id === fontId);
  const brand = String(choose('brand_color', (v) => HEX.test(String(v || '')), preset.brand)).toUpperCase();
  return {
    preset: preset.id,
    mode: preset.mode,
    brand_color: brand,
    colours: { brand, background: preset.background, surface: preset.surface, text: preset.text, muted: preset.muted },
    font_pairing: fontId,
    fonts: { heading: fonts.heading, body: fonts.body },
    hero_layout: choose('hero_layout', known(HERO_LAYOUTS), 'video_popup'),
    button_shape: choose('button_shape', known(BUTTON_SHAPES), preset.radius),
  };
}

async function readIntake() {
  const doc = (await loadDoc('intake')) || {};
  const intake = cleanIntake(doc.intake || {});
  const missing = missingFields(intake);
  const tools = Object.fromEntries(TOOL_KEYS.map(key => [key, intake[key]]));
  // where the owner is in the guide, so it reopens on the same step on any device
  const progress = { step: Number.isInteger((doc.progress || {}).step) ? doc.progress.step : 1 };
  return { status: 'ok', storage: backend(), intake, design: cleanDesign(doc.design || {}), design_chosen: Boolean(doc.design), tools, progress, complete: missing.length === 0, missing, updated_at: doc.updated_at || null, catalogue: CATALOGUE };
}

async function getIntake() { return { code: 200, body: await readIntake() }; }

async function postIntake(body) {
  if (backend() === 'none') return NO_STORAGE;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!('intake' in b) && !('design' in b) && !('progress' in b)) return { code: 400, body: { status: 'error', message: 'Send { intake: {...} }, { design: {...} } or { progress: { step } }.' } };
  const doc = (await loadDoc('intake')) || {};
  const next = { ...doc, updated_at: new Date().toISOString() };
  if ('intake' in b) next.intake = cleanIntake(b.intake, doc.intake || {});
  if ('design' in b) next.design = cleanDesign(b.design, doc.design || {});
  if ('progress' in b) { const n = Math.round(Number((b.progress || {}).step)); if (n >= 1 && n <= 7) next.progress = { step: n }; }
  await saveDoc('intake', next);
  const view = await readIntake();
  // A finished intake ticks its own line on the build board (never un-ticks one somebody set).
  if (view.complete) {
    const board = await readBoard();
    const item = board.find(i => i.id === 'intake');
    if (item && (item.status === 'not_started' || item.status === 'in_progress')) await writeBoard(board, [{ id: 'intake', status: 'done' }]);
  }
  return { code: 200, body: view };
}

// ── Build board ─────────────────────────────────────────────────────────────
const STATUSES = ['not_started', 'in_progress', 'needs_review', 'done', 'blocked'];
// The ids are fixed: the skill's build scripts address the board by them.
const SEED = [
  ['intake', 'Intake complete'], ['access', 'Tool access connected'], ['messaging', 'Messaging approved'],
  ['landing_page', 'Landing page'], ['confirmation_page', 'Confirmation page'],
  ['landing_video', 'Landing page video script'], ['confirmation_video', 'Confirmation video script'], ['breakout_videos', 'Breakout video scripts'],
  ['pre_emails', 'Pre-webinar emails'], ['post_emails', 'Post-webinar emails'], ['sms', 'SMS sequence'], ['call_sequences', 'Call booking sequences'],
  ['ad_scripts', 'Ad scripts'], ['static_ads', 'Static image ads'], ['webinar_script', 'Webinar script and deck'],
  ['crm_loaded', 'CRM loaded'], ['platform_wired', 'Webinar platform wired'], ['pages_published', 'Pages published'],
  ['tracking_live', 'Tracking live'], ['e2e_test', 'End-to-end test passed'],
];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const MAX_ITEMS = 100;

const blankItem = (id, label) => ({ id, label: label || id, status: 'not_started', link: '', note: '', updated_at: null });

/** The seeded list with whatever is saved laid over it; items added later keep their place at the end. */
async function readBoard() {
  const doc = (await loadDoc('build')) || {};
  const saved = Array.isArray(doc.items) ? doc.items : [];
  const byId = new Map(saved.filter(i => i && i.id).map(i => [i.id, i]));
  const items = SEED.map(([id, label]) => ({ ...blankItem(id, label), ...(byId.get(id) || {}), id }));
  for (const i of saved) if (i && i.id && !SEED.some(([id]) => id === i.id)) items.push({ ...blankItem(i.id), ...i });
  return items;
}

/** Apply updates (already validated) and save. Returns the whole board. */
async function writeBoard(board, updates) {
  const now = new Date().toISOString();
  for (const u of updates) {
    let item = board.find(i => i.id === u.id);
    if (!item) { item = blankItem(u.id, u.label); board.push(item); }
    for (const k of ['status', 'link', 'note', 'label']) if (u[k] !== undefined) item[k] = u[k];
    item.updated_at = now;
  }
  await saveDoc('build', { items: board, updated_at: now });
  return board;
}

/** One loose update → a clean one, or a string saying what is wrong with it. */
function cleanUpdate(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return 'each item must be an object with an id';
  const id = String(u.id === null || u.id === undefined ? '' : u.id).trim().toLowerCase();
  if (!ID_RE.test(id)) return `"${String(u.id).slice(0, 40)}" is not a usable id (lower-case letters, numbers, _ or -)`;
  const out = { id };
  if (u.status !== undefined) {
    const s = String(u.status).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!STATUSES.includes(s)) return `"${u.status}" is not a status (${STATUSES.join(', ')})`;
    out.status = s;
  }
  if (u.link !== undefined) out.link = text(1000)(u.link);
  if (u.note !== undefined) out.note = text(2000)(u.note);
  if (u.label !== undefined && text(120)(u.label)) out.label = text(120)(u.label);
  return out;
}

const summary = (items) => Object.fromEntries(STATUSES.map(s => [s, items.filter(i => i.status === s).length]));

async function getBuildStatus() {
  const items = await readBoard();
  return { code: 200, body: { status: 'ok', storage: backend(), statuses: STATUSES, items, counts: summary(items) } };
}

async function postBuildStatus(body) {
  if (backend() === 'none') return NO_STORAGE;
  const b = body && typeof body === 'object' ? body : {};
  const raw = Array.isArray(b) ? b : Array.isArray(b.items) ? b.items : (b.id !== undefined ? [b] : []);
  if (!raw.length) return { code: 400, body: { status: 'error', message: 'Send { items: [{ id, status, link, note }] } or one { id, status, link, note }.' } };
  const updates = raw.map(cleanUpdate);
  const bad = updates.filter(u => typeof u === 'string');
  if (bad.length) return { code: 400, body: { status: 'invalid', message: bad[0], errors: bad } };
  const board = await readBoard();
  const fresh = updates.filter(u => !board.some(i => i.id === u.id)).length;
  if (board.length + fresh > MAX_ITEMS) return { code: 400, body: { status: 'invalid', message: `The board can hold ${MAX_ITEMS} items at most.` } };
  const items = await writeBoard(board, updates);
  return { code: 200, body: { status: 'ok', statuses: STATUSES, updated: updates.map(u => u.id), items, counts: summary(items) } };
}

// ── Go live: the end-to-end test, as a checklist the owner ticks ────────────
const GOLIVE = [
  ['signup', 'Sign up on your own landing page', 'Use a real email address of yours. You should land on your confirmation page.'],
  ['shows_here', 'Your sign-up shows on the Results page', 'Open Results and press Refresh now. You should see 1 sign-up.'],
  ['contact', 'You appear in your contacts', 'Look for your email address where you keep your contacts. It should carry the tag webinar-registered.'],
  ['confirmation_email', 'The confirmation email arrived', 'Check the join link in it opens your webinar.'],
  ['reminder', 'A reminder email or text arrived', 'If your webinar is days away, send yourself a test from your email tool.'],
  ['webinar_room', 'The webinar opens and plays', 'Open the join link on a phone as well as a computer.'],
  ['booking', 'The booking link works', 'Book a test call, then cancel it.'],
  ['survey', 'The survey on your confirmation page saves', 'Answer it once. It should show on the Results page.'],
];
async function readGoLive() {
  const done = ((await loadDoc('golive')) || {}).done || {};
  return GOLIVE.map(([id, label, help]) => ({ id, label, help, done: Boolean(done[id]), done_at: done[id] || null }));
}
async function getGoLive() { return { code: 200, body: { status: 'ok', checks: await readGoLive() } }; }
async function postGoLive(body) {
  if (backend() === 'none') return NO_STORAGE;
  const b = body && typeof body === 'object' ? body : {};
  if (!GOLIVE.some(([id]) => id === b.id)) return { code: 400, body: { status: 'error', message: 'That is not one of the checks.' } };
  const doc = (await loadDoc('golive')) || {};
  const done = { ...(doc.done || {}) };
  if (b.done) done[b.id] = new Date().toISOString(); else delete done[b.id];
  await saveDoc('golive', { done });
  const checks = await readGoLive();
  // every check ticked = the last line of the build board is done (and un-ticking reopens it)
  const all = checks.every(c => c.done);
  const board = await readBoard();
  const item = board.find(i => i.id === 'e2e_test');
  if (item && (all ? item.status !== 'done' : item.status === 'done')) await writeBoard(board, [{ id: 'e2e_test', status: all ? 'done' : 'in_progress' }]);
  return { code: 200, body: { status: 'ok', checks } };
}

module.exports = {
  getIntake, postIntake, getBuildStatus, postBuildStatus, getGoLive, postGoLive,
  cleanIntake, cleanDesign, missingFields, INTAKE, TOOL_KEYS, STATUSES, SEED, CATALOGUE, GOLIVE,
};
