'use strict';
// Webinar System — the whole app, without a network or a database.
//
//   node --test
//
// global.fetch answers from a table and fails the test on any address it was not told about
// (or, for the storage tests, plays the part of the Redis database). Saved data goes to an
// empty temp folder. Every name, email and id in the fixtures is made up; the fixtures are the
// SHAPES each tool documents (for aEvent, the shape its own web app returns).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FAKE = '0123456789abcdef';   // obviously fake key bodies for the adapter tests

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webinar-system-test-'));
process.chdir(tmp);
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|VERCEL)/.test(k)) delete process.env[k];
Object.assign(process.env, { APP_SECRET: 'app-secret-for-tests', SETUP_CODE: 'K7MP2QXD', BUILD_KEY: 'build-key-for-tests', CRON_SECRET: 'cron-secret-for-tests' });
for (const level of ['log', 'warn', 'error']) console[level] = () => {};

const store = require(path.join(root, 'api/_lib/settings-store.js'));
const { config, applySettings, connections } = require(path.join(root, 'api/_lib/config.js'));
const db = require(path.join(root, 'api/_lib/db.js'));
const webinar = require(path.join(root, 'api/_lib/sync/webinar'));
const webinarjam = require(path.join(root, 'api/_lib/sync/webinar/webinarjam.js'));
const ewebinar = require(path.join(root, 'api/_lib/sync/webinar/ewebinar.js'));
const aevent = require(path.join(root, 'api/_lib/sync/webinar/aevent.js'));
const meta = require(path.join(root, 'api/_lib/sync/ads/meta.js'));
const { runSync, PARTS } = require(path.join(root, 'api/_lib/sync/run.js'));
const { getResults } = require(path.join(root, 'api/_lib/results.js'));
const register = require(path.join(root, 'api/_lib/handlers/register.js'));
const setupHandlers = require(path.join(root, 'api/_lib/handlers/setup.js'));
const handler = require(path.join(root, 'api/index.js'));

const { TABS, HEADERS } = db;
const KEYS = store.FIELDS.map(f => f.key);
const wipe = () => { fs.rmSync(path.join(tmp, '.data'), { recursive: true, force: true }); store.forgetCache(); };
/** A clean slate: only the settings given (as env, because the API re-reads config on every request), an empty in-memory data store. */
function setup(settings = {}) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { TIMEZONE: 'UTC', ...settings });
  delete process.env.MIN_SAMPLE; process.env.MIN_SAMPLE = '1';
  applySettings({});
  store.resetRateLimits();
  return db.useMemory({});
}
const rows = (key) => { const raw = db.memoryTabs()[TABS[key]] || []; return raw.slice(1).map(r => Object.fromEntries(HEADERS[key].map((h, i) => [h, r[i]]))); };
function tab(key, objs) {
  for (const o of objs) for (const k of Object.keys(o)) assert.ok(HEADERS[key].includes(k), `${key} has no column "${k}"`);
  return [HEADERS[key], ...objs.map(o => HEADERS[key].map(h => (o[h] == null ? '' : String(o[h]))))];
}

const realFetch = global.fetch;
function stubFetch(routes) {
  const seen = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push({ url: u, init });
    const hit = routes.find(([m]) => (m instanceof RegExp ? m.test(u) : u.startsWith(m)));
    if (!hit) throw new Error(`unexpected network call in a test: ${u}`);
    const out = typeof hit[1] === 'function' ? hit[1](u, init) : hit[1];
    if (out instanceof Error) throw out;
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return seen;
}
test.afterEach(() => { global.fetch = realFetch; });

async function call({ method = 'GET', query = {}, headers = {}, body } = {}) {
  const req = { method, query, headers: { host: 'acme.test', ...headers }, body };
  const res = { code: 0, body: undefined, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await handler(req, res);
  return res;
}
const quiet = { runner: 'manual', budgetMs: 0, log: () => {} };
const builder = { authorization: `Bearer ${process.env.BUILD_KEY}` };
const cookieFrom = (res) => String(res.headers['set-cookie'] || '').split(';')[0];
/** A signed-in owner's cookie header (creates the password on first use). */
async function owner() {
  let r = await call({ method: 'POST', query: { source: 'setup_password' }, body: { code: 'K7MP2QXD', password: 'correct horse' } });
  if (r.code !== 200) r = await call({ method: 'POST', query: { source: 'login' }, body: { password: 'correct horse' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  return { cookie: cookieFrom(r) };
}

// ════════════════════════════════════════════════════════════════════════════
// Storage: Redis is the data store; no spreadsheet anywhere
// ════════════════════════════════════════════════════════════════════════════

/** A tiny Redis that speaks the Upstash REST API (one command, or a pipeline). */
function fakeRedis() {
  const data = new Map(); const commands = [];
  const run = ([cmd, key, ...args]) => {
    commands.push(cmd);
    if (cmd === 'GET') return data.has(key) ? data.get(key) : null;
    if (cmd === 'SET') { data.set(key, args[0]); return 'OK'; }
    if (cmd === 'DEL') return data.delete(key) ? 1 : 0;
    if (cmd === 'RPUSH') { const l = data.get(key) || []; l.push(...args); data.set(key, l); return l.length; }
    if (cmd === 'LTRIM') { const l = data.get(key) || []; data.set(key, l.slice(Number(args[0]))); return 'OK'; }
    if (cmd === 'LRANGE') return data.get(key) || [];
    if (cmd === 'INCR') { const n = Number(data.get(key) || 0) + 1; data.set(key, n); return n; }
    if (cmd === 'EXPIRE') return 1;
    throw new Error(`fake redis: ${cmd}`);
  };
  global.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer kv-token');
    const body = JSON.parse(init.body);
    const out = String(url).endsWith('/pipeline') ? body.map(c => ({ result: run(c) })) : { result: run(body) };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { data, commands };
}
function withRedis(fn) {
  return async () => {
    Object.assign(process.env, { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'kv-token' });
    try { await fn(fakeRedis()); } finally { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; db.useMemory({}); }
  };
}
/** The data store out of memory mode, so Redis or the local folder is really used. */
function freshDb() { db.leaveMemory(); return db; }

test('storage on Redis: a sync rewrites its part in chunks, sign-ups are appended and never lost, old chunks are cleaned up', withRedis(async (redis) => {
  const d = freshDb();
  assert.equal(store.backend(), 'kv');
  assert.equal(d.isConfigured(), true);
  const row = (i, source) => HEADERS.WEBINAR_REGISTRANTS.map(h => (h === 'Email' ? `p${i}@example.com` : h === 'Source' ? source : h === 'Registrant ID' ? `id-${i}` : ''));

  assert.equal(await d.appendRows(TABS.WEBINAR_REGISTRANTS, [row(9001, 'relay')]), 1);
  assert.equal(await d.writeTab(TABS.WEBINAR_REGISTRANTS, null, Array.from({ length: 950 }, (_, i) => row(i, 'sync'))), 950);
  const chunkKeys = () => [...redis.data.keys()].filter(k => /:c\d+$/.test(k));
  assert.equal(chunkKeys().length, Math.ceil(950 / d.CHUNK), 'the base is stored in chunks');
  assert.ok(Math.max(...chunkKeys().map(k => redis.data.get(k).length)) < 400000, 'each chunk stays well under the request limit');
  let read = await d.readTab(TABS.WEBINAR_REGISTRANTS);
  assert.equal(read.length, 951);
  assert.equal(read[950].Email, 'p9001@example.com', 'the appended sign-up survived the rewrite');
  assert.equal(read[0]['Registrant ID'], 'id-0');

  // a later, shorter sync: the leftover chunks go, the sign-up stays
  await d.writeTab(TABS.WEBINAR_REGISTRANTS, null, [row(1, 'sync')]);
  assert.equal(chunkKeys().length, 1);
  read = await d.readTab(TABS.WEBINAR_REGISTRANTS);
  assert.deepEqual(read.map(r => r.Email), ['p1@example.com', 'p9001@example.com']);
  assert.ok(redis.commands.includes('LTRIM'), 'appended lists are capped');
  assert.deepEqual(await d.readTab(TABS.BOOKINGS), [], 'a tab nobody has written is empty, not an error');
  assert.ok(![...redis.data.keys()].some(k => /sheet|google/i.test(k)));
}));

test('storage in a local folder: the same two parts, capped', async () => {
  wipe();
  const d = freshDb();
  assert.equal(store.backend(), 'file');
  await d.appendRows(TABS.SYNC_LOG, Array.from({ length: d.CAP.SYNC_LOG + 25 }, (_, i) => [`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, 'webinar', String(i), 'ok', '5', '', 'cron']));
  const log = await d.readTab(TABS.SYNC_LOG);
  assert.equal(log.length, d.CAP.SYNC_LOG, 'oldest rows are dropped at the cap');
  assert.equal(log[log.length - 1].Rows, String(d.CAP.SYNC_LOG + 24));
  await d.appendRows(TABS.WEBINAR_SURVEY, [['2026-01-01T00:00:00Z', 'a@example.com', '', '', 'Q', 'A']]);
  await d.writeTab(TABS.AD_METRICS, null, [['k1', 'meta', '2026-01-01']]);
  await d.writeTab(TABS.AD_METRICS, null, [['k2', 'meta', '2026-01-02']]);
  assert.deepEqual((await d.readTab(TABS.AD_METRICS)).map(r => r['Row Key']), ['k2'], 'a rewrite replaces the base');
  assert.equal((await d.readTabs([TABS.WEBINAR_SURVEY]))[TABS.WEBINAR_SURVEY][0]['Answer 1'], 'A');
  assert.ok(fs.readdirSync(path.join(tmp, '.data')).some(f => f.startsWith('tab-')));
  db.useMemory({});
  wipe();
});

test('nothing asks for a Google Sheet any more', () => {
  assert.equal(store.FIELDS.some(f => /SPREADSHEET|GOOGLE|SHEET/.test(f.key)), false);
  assert.deepEqual(Object.keys(require(path.join(root, 'package.json')).dependencies || {}), []);
  assert.deepEqual(Object.keys(connections()).sort(), ['ads', 'calendar', 'crm', 'payments', 'webinar']);
});

// ════════════════════════════════════════════════════════════════════════════
// One sign-in
// ════════════════════════════════════════════════════════════════════════════

test('sign-in: the setup code works once, then one password and a signed cookie', async () => {
  setup({}); wipe();
  const first = await call({ query: { action: 'session' } });
  assert.deepEqual([first.body.needs_setup, first.body.signed_in, first.body.ready], [true, false, true]);
  assert.equal((await call({ query: { action: 'settings' } })).code, 401, 'nothing private without signing in');

  const post = (source, body, headers) => call({ method: 'POST', query: { source }, body, headers });
  const wrong = await post('setup_password', { code: 'NOPE1234', password: 'correct horse' });
  assert.equal(wrong.code, 401);
  assert.match(wrong.body.message, /setup code is not right/);
  assert.equal((await post('setup_password', { code: 'K7MP2QXD', password: 'short' })).code, 400);
  assert.equal((await post('login', { password: 'anything' })).code, 409, 'no password exists yet');

  const made = await post('setup_password', { code: 'K7MP2QXD', password: 'correct horse' });
  assert.equal(made.code, 200);
  assert.match(made.headers['set-cookie'], /^ws_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  const me = { cookie: cookieFrom(made) };
  assert.equal((await call({ query: { action: 'session' }, headers: me })).body.signed_in, true);
  assert.equal((await call({ query: { action: 'settings' }, headers: me })).code, 200);

  // the setup code is dead the moment a password exists
  const again = await post('setup_password', { code: 'K7MP2QXD', password: 'another password' });
  assert.equal(again.code, 409);
  assert.equal((await post('login', { password: 'wrong password' })).code, 401);
  const back = await post('login', { password: 'correct horse' });
  assert.equal(back.code, 200);

  // a forged or edited cookie is refused
  const [exp, version, sig] = me.cookie.replace('ws_session=', '').split('.');
  for (const forged of [`${Number(exp) + 1}.${version}.${sig}`, `${exp}.${version}.${'x'.repeat(sig.length)}`, 'garbage', '']) {
    assert.equal((await call({ query: { action: 'settings' }, headers: { cookie: `ws_session=${forged}` } })).code, 401, forged);
  }
  // the password is stored hashed and encrypted, never as typed
  const blob = fs.readFileSync(path.join(tmp, '.data', 'doc-auth.json'), 'utf8');
  assert.match(blob, /^v1:/);
  assert.ok(!blob.includes('correct horse'));

  // changing it signs every other device out
  assert.equal((await post('change_password', { current: 'nope', password: 'a brand new one' }, me)).code, 401);
  const changed = await post('change_password', { current: 'correct horse', password: 'a brand new one' }, me);
  assert.equal(changed.code, 200);
  assert.equal((await call({ query: { action: 'settings' }, headers: me })).code, 401, 'the old cookie no longer works');
  assert.equal((await call({ query: { action: 'settings' }, headers: { cookie: cookieFrom(changed) } })).code, 200);
  assert.match((await post('logout', {})).headers['set-cookie'], /Max-Age=0/);
  wipe();
});

test('sign-in is optional: with no password settings everything is open; ACCESS_PASSWORD turns on one shared password', async () => {
  const saved = process.env.SETUP_CODE;
  try {
    delete process.env.SETUP_CODE; delete process.env.ACCESS_PASSWORD;
    setup({}); wipe();
    const s = (await call({ query: { action: 'session' } })).body;
    assert.deepEqual([s.mode, s.login_required, s.signed_in, s.needs_setup], ['open', false, true, false]);
    assert.equal((await call({ query: { action: 'settings' } })).code, 200, 'open mode needs no cookie');
    assert.equal((await call({ query: { action: 'results' } })).code, 200);
    assert.equal((await call({ method: 'POST', query: { source: 'change_password' }, body: { current: 'x', password: 'whatever123' } })).code, 409);

    const shared = crypto.randomBytes(9).toString('hex');   // made up per run, never stored
    process.env.ACCESS_PASSWORD = shared;
    setup({}); wipe();
    assert.equal((await call({ query: { action: 'session' } })).body.mode, 'password');
    assert.equal((await call({ query: { action: 'settings' } })).code, 401);
    assert.equal((await call({ method: 'POST', query: { source: 'login' }, body: { password: 'wrong one' } })).code, 401);
    const ok = await call({ method: 'POST', query: { source: 'login' }, body: { password: shared } });
    assert.equal(ok.code, 200);
    const me = { cookie: cookieFrom(ok) };
    assert.equal((await call({ query: { action: 'settings' }, headers: me })).code, 200);
    // changing the env password signs every device out
    process.env.ACCESS_PASSWORD = shared + '-changed';
    assert.equal((await call({ query: { action: 'settings' }, headers: me })).code, 401);
  } finally {
    delete process.env.ACCESS_PASSWORD;
    process.env.SETUP_CODE = saved;
    setup({}); wipe();
  }
});

test('who can reach what: public routes open, the build key for the build routes only, the rest needs the owner', async () => {
  setup({}); wipe();
  const me = await owner();
  assert.equal((await call({ query: { action: 'health' } })).body.service, 'Webinar System');
  for (const route of ['intake', 'build_status', 'answers']) {
    assert.equal((await call({ query: { action: route } })).code, 401);
    assert.equal((await call({ query: { action: route }, headers: { authorization: 'Bearer nope' } })).code, 401);
    assert.equal((await call({ query: { action: route }, headers: builder })).code, 200);
    assert.equal((await call({ query: { action: route }, headers: me })).code, 200);
  }
  for (const route of ['settings', 'results', 'golive', 'connections']) {
    assert.equal((await call({ query: { action: route }, headers: builder })).code, 401, `${route} is not for the build key`);
    assert.equal((await call({ query: { action: route }, headers: me })).code, 200);
  }
  for (const source of ['settings', 'settings_test', 'golive', 'sync_now', 'change_password', 'upload', 'file_delete', 'connections_test', 'test_signup']) assert.equal((await call({ method: 'POST', query: { source }, headers: builder, body: {} })).code, 401, source);
  assert.equal((await call({ query: { action: 'cron' } })).code, 401);
  assert.equal((await call({ query: { action: 'cron' }, headers: { authorization: 'Bearer cron-secret-for-tests' } })).code, 200);
  // too many password tries from one address are slowed down
  store.resetRateLimits();
  let last;
  for (let i = 0; i < 11; i++) last = await call({ method: 'POST', query: { source: 'login' }, headers: { 'x-forwarded-for': '203.0.113.50' }, body: { password: 'guess' } });
  assert.equal(last.code, 429);
  wipe();
});

// ════════════════════════════════════════════════════════════════════════════
// Setup: answers save one at a time, the build board, go live
// ════════════════════════════════════════════════════════════════════════════

test('setup autosave: each answer is saved on its own and nothing else is disturbed', async () => {
  setup({}); wipe();
  const me = await owner();
  const save = (body, headers = me) => call({ method: 'POST', query: { source: 'intake' }, headers, body });
  const start = await call({ query: { action: 'intake' }, headers: me });
  assert.equal(start.body.complete, false);
  assert.equal(start.body.progress.step, 1);
  assert.deepEqual(Object.keys(start.body.tools), ['webinar_platform', 'crm', 'page_host', 'email_tool', 'sms_tool', 'calendar', 'payments', 'ads']);

  // exactly what the page sends: one key per change
  assert.equal((await save({ intake: { business_name: '  Acme Coaching ' } })).body.intake.business_name, 'Acme Coaching');
  await save({ intake: { hosts: ['Sam Jones', '', ' Jo Lee '] } });
  await save({ intake: { pains: ['Too few leads', 'No time'] } });
  await save({ intake: { webinar_platform: 'ewebinar' } });
  await save({ intake: { calendar: 'calendly' } });
  await save({ intake: { webinar_format: 'LIVE' } });
  const now = (await save({ intake: { how_people_buy: 'webinar' } })).body;
  assert.deepEqual([now.intake.business_name, now.intake.hosts, now.intake.pains.length, now.intake.webinar_format], ['Acme Coaching', ['Sam Jones', 'Jo Lee'], 2, 'live'], 'earlier answers are all still there');
  assert.deepEqual([now.tools.webinar_platform, now.tools.calendar, now.tools.crm], ['ewebinar', 'calendly', '']);
  assert.ok(now.missing.includes('pains'), 'two frustrations is fewer than the five asked for');
  assert.ok(!now.missing.includes('booking_link'), 'no booking link is needed when people buy on the webinar');
  assert.ok(now.missing.includes('webinar_date'));
  assert.equal((await save({ intake: { webinar_platform: 'carrier pigeon' } })).body.intake.webinar_platform, 'ewebinar', 'a choice we do not know never wipes a good answer');

  // where they got to is remembered, and the design saves the same way
  assert.equal((await save({ progress: { step: 4 } })).body.progress.step, 4);
  assert.equal((await save({ progress: { step: 99 } })).body.progress.step, 4);
  const look = (await save({ design: { preset: 'dark_bold', button_shape: 'pill' } })).body;
  assert.deepEqual([look.design.preset, look.design.button_shape, look.design.fonts.heading, look.design.colours.brand, look.progress.step, look.intake.business_name],
    ['dark_bold', 'pill', 'Space Grotesk', '#FF5A1F', 4, 'Acme Coaching']);
  assert.equal((await save({ design: { brand_color: 'red' } })).body.design.brand_color, '#FF5A1F', 'a bad colour does not overwrite a good one');
  assert.equal((await save({ nothing: true })).code, 400);

  // the build scripts read the very same thing with the build key
  const viaKey = await call({ query: { action: 'intake' }, headers: builder });
  assert.equal(viaKey.body.intake.business_name, 'Acme Coaching');
  assert.equal(viaKey.body.design.preset, 'dark_bold');
  assert.equal(viaKey.body.tools.webinar_platform, 'ewebinar');
  // saved encrypted, on disk here (Redis when deployed), never readable as typed
  assert.ok(!fs.readFileSync(path.join(tmp, '.data', 'doc-intake.json'), 'utf8').includes('Acme'));
  wipe();
});

test('build board: the same 20 ids and 5 status words the build scripts use', async () => {
  setup({}); wipe();
  const IDS = ['intake', 'access', 'messaging', 'landing_page', 'confirmation_page', 'landing_video', 'confirmation_video', 'breakout_videos', 'pre_emails', 'post_emails', 'sms',
    'call_sequences', 'ad_scripts', 'static_ads', 'webinar_script', 'crm_loaded', 'platform_wired', 'pages_published', 'tracking_live', 'e2e_test'];
  const start = await call({ query: { action: 'build_status' }, headers: builder });
  assert.deepEqual(start.body.items.map(i => i.id), IDS);
  assert.deepEqual(start.body.statuses, ['not_started', 'in_progress', 'needs_review', 'done', 'blocked']);
  const post = (body) => call({ method: 'POST', query: { source: 'build_status' }, headers: builder, body });
  const many = await post({ items: [{ id: 'landing_page', status: 'needs_review', link: 'https://example.com/draft', note: 'Draft ready' }, { id: 'custom_step', status: 'blocked' }] });
  assert.equal(many.code, 200);
  const lp = many.body.items.find(i => i.id === 'landing_page');
  assert.deepEqual([lp.status, lp.link, lp.note, lp.label], ['needs_review', 'https://example.com/draft', 'Draft ready', 'Landing page']);
  const custom = many.body.items[many.body.items.length - 1];
  assert.deepEqual([custom.id, custom.label, custom.status], ['custom_step', 'custom_step', 'blocked'], 'an unknown id is created');
  const one = await post({ id: 'landing_page', status: 'done' });
  assert.deepEqual([one.body.items.find(i => i.id === 'landing_page').status, one.body.items.find(i => i.id === 'landing_page').link], ['done', 'https://example.com/draft']);
  assert.equal((await post({ items: [{ id: 'sms', status: 'finished' }] })).code, 400);
  assert.equal((await post({})).code, 400);

  // go live: ticking every check finishes the last line of the board
  const me = await owner();
  const checks = (await call({ query: { action: 'golive' }, headers: me })).body.checks;
  assert.equal(checks.length, setupHandlers.GOLIVE.length);
  assert.ok(checks.every(c => c.done === false && c.label && c.help));
  let last;
  for (const c of checks) last = await call({ method: 'POST', query: { source: 'golive' }, headers: me, body: { id: c.id, done: true } });
  assert.ok(last.body.checks.every(c => c.done));
  assert.equal((await call({ query: { action: 'build_status' }, headers: builder })).body.items.find(i => i.id === 'e2e_test').status, 'done');
  await call({ method: 'POST', query: { source: 'golive' }, headers: me, body: { id: checks[0].id, done: false } });
  assert.equal((await call({ query: { action: 'build_status' }, headers: builder })).body.items.find(i => i.id === 'e2e_test').status, 'in_progress');
  assert.equal((await call({ method: 'POST', query: { source: 'golive' }, headers: me, body: { id: 'nope', done: true } })).code, 400);
  wipe();
});

test('settings: keys are masked, mistakes are explained in plain words, each tool has a check', async () => {
  setup({}); wipe();
  const me = await owner();
  const post = (source, body) => call({ method: 'POST', query: { source }, headers: me, body });
  const saved = await post('settings', { values: { WEBINAR_PROVIDER: 'WebinarJam', WEBINARJAM_API_KEY: 'k'.repeat(64), WEBINAR_IDS: '["123"]', ADS_PROVIDER: 'meta', META_ACCESS_TOKEN: 'EAAtoken0123456789012345678901234567890123',
    META_AD_ACCOUNT_ID: 'https://adsmanager.facebook.com/adsmanager/manage?act=1234567890', GHL_LOCATION_ID: 'https://app.gohighlevel.com/v2/location/AbC123xyz/dashboard', TARGETS_JSON: '{"show_up_rate":0.5,"made_up":1}' } });
  assert.equal(saved.code, 200, JSON.stringify(saved.body));
  const v = saved.body;
  assert.deepEqual([v.connected.webinar, v.connected.ads, v.connected.crm], [true, true, false]);
  assert.deepEqual(v.fields.WEBINARJAM_API_KEY, { secret: true, saved: true, hint: '••••kkkk' });
  assert.equal(v.fields.META_AD_ACCOUNT_ID.value, 'act_1234567890');
  assert.equal(v.fields.GHL_LOCATION_ID.value, 'AbC123xyz');
  assert.deepEqual([v.targets.show_up_rate, v.targets.registration_rate, 'made_up' in v.targets], [0.5, 0.3, false]);
  assert.deepEqual(v.addresses, { register: 'http://acme.test/api?source=register', survey: 'http://acme.test/api?source=survey', updates: 'http://acme.test/api?source=event', sales: 'http://acme.test/api?source=event&type=sale' });
  assert.equal(v.build_key, 'build-key-for-tests');
  assert.ok(!JSON.stringify(v).includes('k'.repeat(20)) && !JSON.stringify(v).includes('EAAtoken'), 'no key is ever sent back');

  const bad = await post('settings', { values: { WEBINAR_PROVIDER: 'zoom', STRIPE_SECRET_KEY: 'pk_live_abcdefghijklmnop', WEBINAR_CONFIRMATION_URL: 'my page', TIMEZONE: 'Mars/Phobos' } });
  assert.equal(bad.code, 400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), ['STRIPE_SECRET_KEY', 'TIMEZONE', 'WEBINAR_CONFIRMATION_URL', 'WEBINAR_PROVIDER']);
  assert.match(bad.body.fields.STRIPE_SECRET_KEY, /cannot read payments/);
  for (const m of Object.values(bad.body.fields)) assert.doesNotMatch(m, /undefined|JSON|\[object|token at position/);

  stubFetch([['https://api.webinarjam.com/webinarjam/webinars', () => ({ status: 'success', webinars: [{ webinar_id: 123, name: 'Sample Training' }, { webinar_id: 124, name: 'Another' }] })]]);
  const t = await post('settings_test', { target: 'webinar' });
  assert.deepEqual([t.body.ok, t.body.message], [true, 'Connected. We found 2 webinars. Tick the one you are launching.']);
  assert.deepEqual(t.body.picks[0], { name: '123', label: 'Sample Training', active: true });
  stubFetch([['https://api.webinarjam.com/', () => ({ status: 'error', message: 'Invalid API key' })]]);
  assert.match((await post('settings_test', { target: 'webinar' })).body.message, /^That did not work: WebinarJam rejected the key\. Check you copied all of it/);
  assert.match((await post('settings_test', { target: 'calendar' })).body.message, /Paste your Calendly key first/);
  assert.match((await post('settings_test', { target: 'crm' })).body.message, /Choose a tool first/);
  wipe();
});

// ════════════════════════════════════════════════════════════════════════════
// Webinar platforms and ads: one interface, honest about what each can tell us
// ════════════════════════════════════════════════════════════════════════════

const col = (row, header) => row[HEADERS.WEBINAR_REGISTRANTS.indexOf(header)];
const WJ = { lead_id: 456, webinar_id: 123, event_id: 9001, first_name: 'Jane', last_name: 'Doe', email: 'Jane.Doe@Example.com', phone_country_code: '+44', phone_number: '7700900000', event_date: '2026-03-05 19:00',
  signup_date: 1772445600, live_room_url: 'https://event.webinarjam.com/go/live/1/abc', attended_live: 'Yes', time_live: '01:02:30', purchased_live: '1', revenue_live: '997.00', attended_replay: 'No', purchased_replay: '0', revenue_replay: '0.00',
  utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'launch', utm_term: 'coaching', utm_content: 'ad-1' };
const EW = { id: 'abCD1234Efg56', name: 'John Doe', email: 'John.Doe@defaultmail.example.com', state: 'Watched', attended: 'Left early', joinLink: 'https://ilove.ewebinar.com/webinar/1234/join/1234', webinarId: 14166,
  sessionTime: '2024-05-10T08:25:00.000Z', sessionType: 'JustInTime', webinarTitle: 'eWebinar Overview and Demo', registeredTime: '2024-05-10T08:24:01.263Z', totalWatchedPercent: 72, watchedScheduledPercent: 72,
  converted: 'true', purchaseAmount: '$1,497.00', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand', utm_content: 'headline-a', utm_term: 'webinar software' };
const AE_PAST = { success: { 17: [{ uniqueID: 17, webinarID: '880011', webinarTimeline: 'campA', timestamp: 1772737200, registrants: 2, attendees: 1 }], 3: [{ uniqueID: 3, webinarID: '770022', webinarTimeline: 'campB', timestamp: 1772130000, registrants: 9, attendees: 4 }] } };
const AE_REGS = { success: [
  { email: 'Ann@Example.com', name: 'Ann Lee', webinarID: '880011', registrationTime: 1772600000, attendance: { groups: ['Attendee'] } },
  { email: 'bob@example.com', webinarID: '880011', registrationTime: 1772610000, attendance: { groups: ['Non-Attendee'] } },
  { email: 'other@example.com', webinarID: '770022', registrationTime: 1772000000, attendance: { groups: ['Attendee'] } },
] };

test('each platform maps onto the one standard row, and leaves blank what it cannot tell us', () => {
  setup({ WEBINAR_PROVIDER: 'webinarjam', WEBINARJAM_API_KEY: 'k'.repeat(64) });
  const wj = webinarjam.mapRegistrant(WJ, { webinar_id: '123', name: 'Sample Training' });
  assert.deepEqual([wj.email, wj.attended_live, wj.minutes_watched, wj.percent_watched, wj.stayed_to_pitch, wj.watched_replay, wj.purchased, wj.revenue, wj.utm_content],
    ['jane.doe@example.com', true, 62.5, null, null, false, true, 997, 'ad-1'], 'WebinarJam: minutes, no percent, no stayed flag');
  assert.equal(wj.registered_at.toISOString(), '2026-03-02T10:00:00.000Z');
  const none = webinarjam.mapRegistrant({ lead_id: 1, email: 'x@example.com', attended_live: 'No' });
  assert.deepEqual([none.attended_live, none.minutes_watched, none.purchased, none.revenue], [false, null, null, null], 'missing is unknown, not zero');

  const ew = ewebinar.mapRegistrant(EW);
  assert.deepEqual([ew.webinar_id, ew.attended_live, ew.percent_watched, ew.minutes_watched, ew.stayed_to_pitch, ew.purchased, ew.revenue, ew.utm_medium],
    ['14166', true, 72, null, null, true, 1497, 'cpc'], 'eWebinar: percent, never minutes');
  assert.equal(ewebinar.mapRegistrant({ ...EW, attended: 'Stayed till the end' }).stayed_to_pitch, true);
  assert.equal(ewebinar.mapRegistrant({ id: 'x', email: 'a@example.com', attended: "Hasn't started", sessionType: 'Scheduled' }).attended_live, null);
  const replay = ewebinar.mapRegistrant({ id: 'z', email: 'a@example.com', attended: 'Joined', sessionType: 'Replay', watchedReplayPercent: 40 });
  assert.deepEqual([replay.attended_live, replay.watched_replay, replay.percent_watched], [false, true, 40]);

  const ae = aevent.mapRegistrant(AE_REGS.success[0], AE_PAST.success[17][0]);
  assert.deepEqual([ae.email, ae.attended_live, ae.webinar_id, ae.session_id], ['ann@example.com', true, 'campA', '880011']);
  for (const k of ['minutes_watched', 'percent_watched', 'stayed_to_pitch', 'watched_replay', 'purchased', 'revenue']) assert.equal(ae[k], null, `aEvent cannot tell us ${k}`);
  const row = webinar.toRow(ae, '2026-03-10T00:00:00Z');
  for (const h of ['Minutes Watched', 'Percent Watched', 'Stayed To Pitch', 'Watched Replay', 'Purchased', 'Revenue', 'UTM Source']) assert.equal(col(row, h), '', `${h} must be blank`);
  assert.equal(col(webinar.toRow(wj, 'now'), 'Minutes Watched'), '62.5');

  for (const [name, load] of Object.entries(webinar.ADAPTERS)) {
    const a = load();
    for (const fn of ['connected', 'test', 'listWebinars', 'pull', 'mapRegistrant']) assert.equal(typeof a[fn], 'function', `${name}.${fn}`);
    assert.ok(typeof a.register === 'function' || typeof a.REGISTER_UNSUPPORTED === 'string');
  }
  assert.deepEqual(PARTS, ['calendar', 'payments', 'webinar', 'ads']);
});

test('the hourly update: each platform is read its own way and saved; failures change nothing', async () => {
  // WebinarJam: form posts with the key in the body, both page shapes
  setup({ WEBINAR_PROVIDER: 'webinarjam', WEBINARJAM_API_KEY: 'k'.repeat(64), WEBINAR_IDS: '["123"]', SYNC_LOOKBACK_DAYS: '730' });
  await db.appendRows(TABS.WEBINAR_REGISTRANTS, [webinar.toRow({ id: 'relay:1', provider: 'webinarjam', email: 'relay@example.com', registered_at: '2026-03-04T10:00:00Z', utm_source: 'facebook' }, 'now', 'relay')]);
  let seen = stubFetch([
    ['https://api.webinarjam.com/webinarjam/webinars', () => ({ status: 'success', webinars: [{ webinar_id: 123, name: 'Sample Training' }, { webinar_id: 999, name: 'Old' }] })],
    ['https://api.webinarjam.com/webinarjam/registrants', (u, init) => (new URLSearchParams(init.body).get('page') === '1'
      ? { status: 'success', webinar: { registrants: { current_page: 1, last_page: 2, data: [WJ] } } }
      : { status: 'success', registrants: { current_page: 2, last_page: 2, data: [{ lead_id: 457, webinar_id: 123, event_id: 9001, email: 'sam@example.com', signup_date: '2026-03-03 08:15:00', attended_live: 'No' }] } })],
  ]);
  let r = await runSync(['webinar'], quiet);
  assert.equal(r.ok, true, JSON.stringify(r.parts));
  for (const s of seen) { assert.equal(new URLSearchParams(s.init.body).get('api_key'), 'k'.repeat(64)); assert.ok(!s.url.includes('kkkk')); }
  assert.ok(!seen.some(s => new URLSearchParams(s.init.body).get('webinar_id') === '999'), 'a webinar that was not ticked is not read');
  assert.deepEqual(rows('WEBINAR_REGISTRANTS').map(x => [x.Email, x['Attended Live'], x.Source]), [['jane.doe@example.com', 'Y', 'sync'], ['sam@example.com', 'N', 'sync'], ['relay@example.com', '', 'relay']], 'the sign-up from the landing page is kept');
  stubFetch([['https://api.webinarjam.com/', () => ({ status: 'error', message: 'Invalid API key' })]]);
  r = await runSync(['webinar'], quiet);
  assert.equal(r.parts[0].status, 'error');
  assert.equal(rows('WEBINAR_REGISTRANTS').length, 3, 'a failed update leaves the data alone');
  assert.equal(rows('SYNC_LOG').length, 2);

  // eWebinar: Bearer key, cursor paging, and an unknown shape fails loudly
  setup({ WEBINAR_PROVIDER: 'ewebinar', EWEBINAR_API_KEY: 'ew_api_' + FAKE, WEBINAR_IDS: '["14166"]' });
  seen = stubFetch([['https://api.ewebinar.com/v2/registrants', (u) => (new URL(u).searchParams.get('nextCursor')
    ? { registrants: [{ ...EW, id: 'second', email: 'two@example.com' }, { ...EW, id: 'other', email: 'other@example.com', webinarId: 5 }], nextCursor: null }
    : { registrants: [EW], nextCursor: 'ah0s976dhs' })]]);
  assert.equal((await runSync(['webinar'], quiet)).ok, true);
  for (const s of seen) assert.equal(s.init.headers.Authorization, 'Bearer ew_api_0123456789abcdef');
  assert.equal(new URL(seen[1].url).searchParams.get('nextCursor'), 'ah0s976dhs');
  assert.deepEqual(rows('WEBINAR_REGISTRANTS').map(x => x.Email).sort(), ['john.doe@defaultmail.example.com', 'two@example.com']);
  stubFetch([['https://api.ewebinar.com/v2/registrants', () => ({ total: 3, page: { items: [] } })]]);
  assert.match((await runSync(['webinar'], quiet)).parts[0].message, /shape this adapter does not know/);

  // aEvent: the session token, and a clear message when it has rotated
  setup({ WEBINAR_PROVIDER: 'aevent', AEVENT_TOKEN: 'session-token-0123456789abcdef', WEBINAR_IDS: '["campA"]', SYNC_LOOKBACK_DAYS: '730' });
  stubFetch([['https://app.aevent.com/api/webinars?page=0&type=past', () => AE_PAST], ['https://app.aevent.com/api/webinars?page=0&type=upcoming', () => ({ success: {} })],
    ['https://app.aevent.com/api/registrants?page=0', () => AE_REGS], ['https://app.aevent.com/api/registrants?page=1', () => ({ success: [] })]]);
  const realNow = Date.now; Date.now = () => Date.parse('2026-03-10T12:00:00Z');
  try { r = await runSync(['webinar'], quiet); } finally { Date.now = realNow; }
  assert.equal(r.ok, true, JSON.stringify(r.parts));
  assert.deepEqual(rows('WEBINAR_REGISTRANTS').map(x => [x.Email, x['Attended Live']]), [['ann@example.com', 'Y'], ['bob@example.com', 'N']], 'another campaign is left out');
  assert.deepEqual(rows('WEBINAR_SESSIONS').map(s => [s['Session ID'], s.Registrants, s.Attendees]), [['880011', '2', '1']]);
  stubFetch([['https://app.aevent.com/', () => new Response('{}', { status: 401 })]]);
  assert.match((await runSync(['webinar'], quiet)).parts[0].message, /stops working whenever that person logs in again/);

  // Meta: one row per ad per day, the key in a header, the campaign filter
  setup({ ADS_PROVIDER: 'meta', META_ACCESS_TOKEN: 'EAAtoken0123456789012345678901234567890123', META_AD_ACCOUNT_ID: 'act_1234567890', META_CAMPAIGN_FILTER: 'webinar' });
  const ad = { date_start: '2026-03-03', campaign_name: 'Webinar cold', ad_id: 'a1', ad_name: 'Founder video', spend: '120.50', impressions: '10000', inline_link_clicks: '150',
    actions: [{ action_type: 'landing_page_view', value: '110' }, { action_type: 'lead', value: '99' }, { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '31' }] };
  assert.deepEqual([meta.mapRow(ad).spend, meta.mapRow(ad).landing_page_views, meta.mapRow(ad).leads], [120.5, 110, 31], 'the first sign-up action present wins');
  seen = stubFetch([[/graph\.facebook\.com\/v21\.0\/act_1234567890\/insights/, () => ({ data: [ad, { ...ad, campaign_name: 'Evergreen', ad_id: 'a9' }] })]]);
  assert.equal((await runSync(['ads'], quiet)).ok, true);
  assert.ok(!seen.some(s => s.url.includes('EAAtoken')));
  assert.deepEqual(rows('AD_METRICS').map(x => [x.Ad, x.Spend, x.Leads]), [['Founder video', '120.50', '31']]);

  setup({});
  assert.deepEqual((await runSync(['all'], quiet)).parts.map(p => [p.part, p.status]), PARTS.map(p => [p, 'skipped']), 'a tool that is not connected is skipped, never an error');
});

// ════════════════════════════════════════════════════════════════════════════
// Results
// ════════════════════════════════════════════════════════════════════════════

const NOW = Date.parse('2026-03-10T12:00:00Z');
const PERIOD = { from: '2026-03-02', to: '2026-03-08' };
function funnel() {
  const S1 = '2026-03-05T19:00:00Z';
  const reg = (id, email, o) => ({ 'Registrant ID': id, Provider: 'webinarjam', 'Webinar ID': 'w1', 'Session ID': 's1', 'Session At': S1, Email: email, 'Registered At': '2026-03-02T10:00:00Z', Source: 'sync', ...o });
  const paid = { 'UTM Source': 'facebook', 'UTM Medium': 'paid' };
  const book = (email, o) => ({ 'Invitee URI': `inv-${email}`, 'Event Type': 'Strategy Call', Status: 'active', 'Created At': '2026-03-06T09:00:00Z', 'Start At': '2026-03-07T15:00:00Z', Email: email, 'Calendly No Show': 'N', 'Booking Type': 'self-booked', ...o });
  return {
    [TABS.WEBINAR_REGISTRANTS]: tab('WEBINAR_REGISTRANTS', [
      reg('r-a', 'a@example.com', { 'Attended Live': 'Y', 'Minutes Watched': '60', 'Watched Replay': 'N', ...paid }),
      reg('r-b', 'b@example.com', { 'Attended Live': 'Y', 'Minutes Watched': '20', 'Watched Replay': 'N', ...paid }),
      reg('r-c', 'c@example.com', { 'Attended Live': 'N', 'Watched Replay': 'Y', 'UTM Source': 'instagram' }),
      reg('r-d', 'd@example.com', { 'Attended Live': 'N', 'Watched Replay': 'N', 'UTM Source': 'instagram' }),
      reg('r-e', 'e@example.com', { 'Session ID': 's2', 'Session At': '2026-03-12T19:00:00Z', 'Registered At': '2026-03-06T10:00:00Z', 'UTM Source': 'email' }),
      reg('r-f', 'f@example.com', { 'Registered At': '2026-02-20T10:00:00Z', 'Attended Live': 'Y' }),
      { 'Registrant ID': 'relay:a', 'Webinar ID': 'w1', Email: 'a@example.com', 'Registered At': '2026-03-02T10:00:05Z', 'UTM Content': 'ad-1', 'Funnel Source': 'paid', Source: 'relay' },
      { 'Registrant ID': 'relay:g', 'Webinar ID': 'w1', Email: 'g@example.com', 'Registered At': '2026-03-07T10:00:00Z', 'UTM Source': 'youtube', 'Funnel Source': 'organic', Source: 'relay' },
    ]),
    [TABS.BOOKINGS]: tab('BOOKINGS', [book('a@example.com'), book('b@example.com', { 'Calendly No Show': 'Y' }), book('c@example.com', { Status: 'canceled' }), book('d@example.com', { 'Booking Type': 'other' })]),
    [TABS.PAYMENTS]: tab('PAYMENTS', [
      { 'Object ID': 'ch_1', Kind: 'charge', Amount: '3000.00', Status: 'succeeded', 'Created At': '2026-03-07T16:00:00Z', Email: 'a@example.com', Excluded: 'N' },
      { 'Object ID': 'ch_0', Kind: 'charge', Amount: '500.00', Status: 'succeeded', 'Created At': '2026-02-01T16:00:00Z', Email: 'a@example.com', Excluded: 'N' },      // before they signed up
      { 'Object ID': 'ch_2', Kind: 'failed', Amount: '3000.00', Status: 'failed', 'Created At': '2026-03-07T16:00:00Z', Email: 'b@example.com', Excluded: 'N' },
    ]),
    [TABS.AD_METRICS]: tab('AD_METRICS', [
      { 'Row Key': '1', Date: '2026-03-03', Campaign: 'Webinar cold', 'Ad ID': 'a1', Ad: 'Founder video', Spend: '100.00', Impressions: '10000', 'Link Clicks': '200', 'Landing Page Views': '40', Leads: '3' },
      { 'Row Key': '2', Date: '2026-03-04', Campaign: 'Webinar cold', 'Ad ID': 'a1', Ad: 'Founder video', Spend: '50.00', Impressions: '5000', 'Link Clicks': '50', 'Landing Page Views': '10', Leads: '1' },
      { 'Row Key': '3', Date: '2026-02-20', Campaign: 'Webinar cold', 'Ad ID': 'a1', Ad: 'Founder video', Spend: '999.00', Impressions: '1', 'Link Clicks': '1', 'Landing Page Views': '1', Leads: '1' },
    ]),
    [TABS.WEBINAR_SURVEY]: tab('WEBINAR_SURVEY', [
      { 'Submitted At': '2026-03-02T10:05:00Z', Email: 'a@example.com', 'Question 1': 'Biggest challenge?', 'Answer 1': 'Not enough leads' },
      { 'Submitted At': '2026-03-03T10:05:00Z', Email: 'b@example.com', 'Question 1': 'Biggest challenge?', 'Answer 1': 'not enough leads' },
    ]),
  };
}
async function results(settings = {}, tabs = funnel(), query = {}) {
  setup({ WEBINAR_PITCH_MINUTE: '45', ...settings });
  db.useMemory(tabs);
  const d = await getResults({ ...PERIOD, ...query }, { now: NOW });
  assert.equal(d.status, 'ok', d.message);
  return { d, step: (k) => d.steps.find(s => s.key === k), tile: (k) => d.tiles.find(t => t.key === k), table: (k) => d.tables.find(t => t.key === k) };
}

test('results: the people who signed up, followed step by step, with what each step cost', async () => {
  const { d, step, tile, table } = await results();
  assert.deepEqual(d.steps.map(s => [s.key, s.count]), [['visits', 50], ['registrations', 6], ['attended', 2], ['stayed', 1], ['booked', 2], ['showed', 1], ['bought', 1]]);
  assert.match(step('registrations').note, /2 are for a webinar that has not happened yet/);
  assert.deepEqual([d.side.count, d.side.rate], [1, 0.25]);

  assert.deepEqual([tile('registration_rate').value, tile('registration_rate').target], [0.04, 0.3], 'two paid sign-ups from 50 page visits');
  assert.deepEqual([tile('show_up_rate').value, tile('show_up_rate').n, tile('show_up_rate').status], [0.5, 4, 'ok'], 'judged only on the four whose webinar has happened');
  assert.equal(tile('stay_to_pitch_rate').value, 0.5, '60 minutes is past the 45 minute offer, 20 is not');
  assert.equal(tile('booking_rate').value, 1, 'a cancelled call and a call of another kind do not count');
  assert.deepEqual([tile('call_show_rate').value, tile('call_show_rate').status], [0.5, 'warn'], 'one of the two past calls was marked a no-show');
  assert.equal(tile('close_rate').value, 1);
  assert.equal(tile('revenue').value, 3000, 'only money paid after they signed up; a failed payment is not a sale');
  assert.deepEqual(['ad_spend', 'cost_per_registration', 'cost_per_attendee', 'cost_per_booked_call', 'cost_per_sale', 'roas'].map(k => tile(k).value), [150, 25, 75, 75, 150, 20]);

  // every tile says what it means; a tile under target says what to fix first
  for (const t of d.tiles) assert.ok(t.means && t.label, `${t.key} explains itself`);
  assert.match(tile('call_show_rate').fix, /booking confirmation messages.*48 hours/);
  assert.equal(tile('show_up_rate').fix, '', 'a tile on target has nothing to fix');
  assert.equal(tile('registration_rate').status, 'crit');

  // the biggest leak, in one sentence, with what to fix first
  assert.equal(d.leak.key, 'registration_rate');
  assert.equal(d.leak.sentence, 'Your biggest leak is the sign-up page: 4% of visitors sign up, and your target is 30%.');
  assert.match(d.leak.fix, /headline first.*ad promised.*form/);

  assert.deepEqual(table('by_session').rows.map(r => [r[0], r[1], r[2], r[3]]), [['2026-03-12T19:00:00Z', 1, null, null], ['2026-03-05T19:00:00Z', 4, 2, 0.5], ['Date not known', 1, null, null]]);
  assert.deepEqual(table('by_source').rows.find(r => r[0] === 'Paid ads'), ['Paid ads', 2, 2, 1, 2, 1]);
  assert.deepEqual(table('by_ad').rows, [['Founder video', 'Webinar cold', 150, 0.0167, 0.6, 4, 37.5]]);
  assert.deepEqual(table('survey_top').rows, [['Biggest challenge?', 'Not enough leads', 2]]);
  assert.ok(!JSON.stringify(table('survey_latest')).includes('@'), 'no email addresses on the page');
});

test('results: the leak moves to whichever step is furthest behind, and every fix follows the mapping', async () => {
  const a = await results({ TARGETS_JSON: '{"registration_rate":0}' });
  assert.equal(a.d.leak.key, 'call_show_rate');
  assert.equal(a.d.leak.sentence, 'Your biggest leak is missed calls: 50% of booked calls turned up, and your target is 70%.');
  const b = await results({ TARGETS_JSON: '{"registration_rate":0,"call_show_rate":0,"show_up_rate":0.9}' });
  assert.equal(b.d.leak.key, 'show_up_rate');
  assert.match(b.d.leak.fix, /confirmation page first.*reminder emails and texts.*shorten the gap/);
  const c = await results({ TARGETS_JSON: '{"registration_rate":0,"call_show_rate":0.4,"stay_to_pitch_rate":0.5}' });
  assert.equal(c.d.leak.status, 'ok');
  assert.match(c.d.leak.sentence, /on target/);
  const G = require(path.join(root, 'api/_lib/results.js')).GUIDE;
  assert.match(G.stay_to_pitch_rate.fix, /opening ten minutes.*at the end/);
  assert.match(G.booking_rate.fix, /one clear next step.*three times.*chat.*first follow-up email/);
  assert.match(G.close_rate.fix, /who is being booked.*sales conversation/);
  assert.match(G.replay_rate.fix, /sooner.*real deadline/);
});

test('results: what a tool cannot tell us reads "not known", never zero', async () => {
  const noOffer = await results({ WEBINAR_PITCH_MINUTE: '' });
  assert.deepEqual([noOffer.step('stayed').count, noOffer.tile('stay_to_pitch_rate').value, noOffer.tile('stay_to_pitch_rate').status], [null, null, 'na']);
  assert.match(noOffer.tile('stay_to_pitch_rate').note, /minute your offer starts/);

  const only = { [TABS.WEBINAR_REGISTRANTS]: tab('WEBINAR_REGISTRANTS', [
    { 'Registrant ID': 'x1', Provider: 'aevent', 'Session At': '2026-03-05T19:00:00Z', Email: 'a@example.com', 'Registered At': '2026-03-02T10:00:00Z', 'Attended Live': 'Y', Source: 'sync' },
    { 'Registrant ID': 'x2', Provider: 'aevent', 'Session At': '2026-03-05T19:00:00Z', Email: 'b@example.com', 'Registered At': '2026-03-02T11:00:00Z', 'Attended Live': 'N', Source: 'sync' }]) };
  const ae = await results({}, only);
  assert.deepEqual(ae.d.steps.map(s => [s.key, s.count]), [['registrations', 2], ['attended', 1], ['stayed', null], ['booked', null], ['showed', null], ['bought', null]], 'no visits step without ads; later steps unknown');
  for (const k of ['registration_rate', 'stay_to_pitch_rate', 'booking_rate', 'call_show_rate', 'close_rate', 'replay_rate', 'revenue', 'ad_spend', 'cost_per_registration', 'roas']) assert.equal(ae.tile(k).value, null, k);
  assert.match(ae.tile('booking_rate').note, /Connect your calendar/);
  assert.match(ae.tile('ad_spend').note, /Connect your ads/);
  assert.ok(ae.d.notes.some(n => /aEvent tells us who came, but not for how long/.test(n)));

  const empty = await results({}, {});
  assert.ok(empty.d.steps.every(s => s.count === null));
  assert.deepEqual([empty.d.leak, empty.d.has_data], [null, false]);

  // single steps sent by another tool count with no platform connected at all
  const ev = (id, type, email, at, o) => ({ 'Event ID': id, Type: type, 'Occurred At': at, 'Received At': at, Email: email, ...o });
  const pushed = await results({ WEBINAR_PITCH_MINUTE: '' }, { [TABS.EVENTS]: tab('EVENTS', [
    ev('e1', 'webinar_registered', 'p@example.com', '2026-03-03T09:00:00Z'), ev('e2', 'webinar_registered', 'q@example.com', '2026-03-03T10:00:00Z'),
    ev('e3', 'webinar_stayed', 'p@example.com', '2026-03-05T19:50:00Z'), ev('e4', 'webinar_purchase', 'p@example.com', '2026-03-05T20:10:00Z', { Amount: '497.00' })]) });
  assert.deepEqual(pushed.d.steps.filter(s => ['registrations', 'attended', 'stayed', 'bought'].includes(s.key)).map(s => s.count), [2, 1, 1, 1]);
  assert.equal(pushed.tile('revenue').value, 497);
});

test('results: sample data is built on the spot, is full, and is never saved', async () => {
  setup({}); wipe();
  const me = await owner();
  const res = await call({ query: { action: 'results', demo: '1' }, headers: me });
  assert.equal(res.code, 200);
  const d = res.body;
  assert.deepEqual([d.status, d.demo, d.has_data], ['ok', true, true]);
  assert.ok(d.steps.every(s => typeof s.count === 'number'), JSON.stringify(d.steps.map(s => [s.key, s.count])));
  assert.ok(d.leak && d.leak.sentence);
  assert.ok(d.tables.every(t => t.rows.length > 0));
  assert.deepEqual(db.memoryTabs(), {}, 'nothing was written');
  const mine = await call({ query: { action: 'results' }, headers: me });
  assert.deepEqual([mine.body.demo, mine.body.has_data], [false, false]);
  const again = (await call({ query: { action: 'results', demo: '1' }, headers: me })).body;
  assert.deepEqual([again.steps, again.tiles.map(t => t.value)], [d.steps, d.tiles.map(t => t.value)], 'the same day shows the same sample');
  wipe();
});

// ════════════════════════════════════════════════════════════════════════════
// The public sign-up and survey routes (unchanged for the pages that post to them)
// ════════════════════════════════════════════════════════════════════════════

const post = (source, body, headers = {}) => call({ method: 'POST', query: { source }, headers: { 'x-forwarded-for': '203.0.113.9', ...headers }, body });
const GHL = { CRM_PROVIDER: 'ghl', GHL_API_KEY: 'pit-test-token', GHL_LOCATION_ID: 'loc123456' };
const WJS = { WEBINAR_PROVIDER: 'webinarjam', WEBINARJAM_API_KEY: 'k'.repeat(64), WEBINAR_IDS: '["123"]' };
const PERSON = { first_name: ' Jane ', email: ' Jane@Example.com ', phone: '+44 7700 900000', utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'launch', utm_content: 'ad-1', fbclid: 'fb.1', page_url: 'https://go.example.com/webinar', funnel_source: 'paid', company_website: '' };

test('register: no login, no key in the page; contact saved, platform sign-up, row stored, redirect built', async () => {
  setup({ ...GHL, ...WJS, GHL_PIPELINE_ID: 'pipe123456', WEBINAR_CONFIRMATION_URL: 'https://go.example.com/confirmed?v=2' });
  const seen = stubFetch([
    ['https://services.leadconnectorhq.com/contacts/upsert', () => ({ contact: { id: 'ghl-1' } })],
    ['https://services.leadconnectorhq.com/contacts/ghl-1/tags', () => ({})],
    ['https://services.leadconnectorhq.com/opportunities/upsert', () => ({ opportunity: { id: 'opp-1' } })],
    ['https://api.webinarjam.com/webinarjam/register', () => ({ status: 'success', user: { lead_id: 456, live_room_url: 'https://event.webinarjam.com/go/live/1/abc' } })],
  ]);
  const res = await post('register', PERSON);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { ok: true, status: 'ok', redirect: 'https://go.example.com/confirmed?v=2&first_name=Jane&email=jane%40example.com',
    steps: [{ name: 'crm', status: 'ok', message: 'contact saved and tagged webinar-registered, added to your pipeline' }, { name: 'platform', status: 'ok', message: 'registered on WebinarJam / EverWebinar' }, { name: 'sheet', status: 'ok', message: 'saved' }],
    join_url: 'https://event.webinarjam.com/go/live/1/abc' });
  assert.ok(!JSON.stringify(res.body).includes('pit-test-token') && !JSON.stringify(res.body).includes('kkkk'));
  assert.equal('tags' in JSON.parse(seen[0].init.body), false, 'the tag is added in its own call so existing tags survive');
  assert.deepEqual(JSON.parse(seen[1].init.body), { tags: ['webinar-registered'] });
  assert.equal(JSON.parse(seen[2].init.body).pipelineId, 'pipe123456');
  const [row] = rows('WEBINAR_REGISTRANTS');
  assert.deepEqual([row.Email, row.Name, row['UTM Content'], row['Funnel Source'], row.Source, row['Join URL']], ['jane@example.com', 'Jane', 'ad-1', 'paid', 'relay', 'https://event.webinarjam.com/go/live/1/abc']);
});

test('register: honeypot, validation, and a CRM or platform failure never loses the sign-up', async () => {
  setup({ ...GHL, ...WJS, WEBINAR_CONFIRMATION_URL: 'https://go.example.com/confirmed', ALERTS_WEBHOOK: 'https://hooks.slack.com/services/T0/B0/abc' });
  let seen = stubFetch([]);
  const bot = await post('register', { ...PERSON, company_website: 'https://spam.example' });
  assert.deepEqual([bot.code, bot.body.ok, bot.body.steps.length], [200, true, 0]);
  for (const [body, field] of [[{ ...PERSON, email: 'not-an-email' }, 'email'], [{ ...PERSON, email: '' }, 'email'], [{ ...PERSON, first_name: '' }, 'first_name']]) {
    const res = await post('register', body);
    assert.deepEqual([res.code, res.body.status, Boolean(res.body.fields[field])], [400, 'invalid', true]);
  }
  assert.equal(seen.length, 0, 'nothing is called for a refused sign-up');
  assert.equal(rows('WEBINAR_REGISTRANTS').length, 0);

  const alerts = [];
  stubFetch([
    ['https://services.leadconnectorhq.com/contacts/upsert', () => new Response(JSON.stringify({ message: 'Invalid token' }), { status: 401 })],
    ['https://api.webinarjam.com/webinarjam/register', () => ({ status: 'error', message: 'Webinar schedule not found' })],
    ['https://hooks.slack.com/', (u, init) => { alerts.push(JSON.parse(init.body)); return new Response('ok'); }],
  ]);
  const res = await post('register', PERSON);
  assert.equal(res.code, 200, 'the sign-up was saved, so the page carries on');
  assert.deepEqual(res.body.steps.map(s => [s.name, s.status]), [['crm', 'error'], ['platform', 'error'], ['sheet', 'ok']]);
  assert.equal(res.body.redirect, 'https://go.example.com/confirmed?first_name=Jane&email=jane%40example.com');
  assert.deepEqual(rows('WEBINAR_REGISTRANTS').map(r => [r.Email, r.Source]), [['jane@example.com', 'relay']]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /jane@example\.com/);
  assert.ok(!JSON.stringify(alerts).includes('pit-test-token'));

  // skipped steps say why
  setup({ WEBINAR_PROVIDER: 'aevent', AEVENT_TOKEN: 'session-token-0123456789abcdef' });
  stubFetch([]);
  const ae = await post('register', PERSON);
  assert.deepEqual(ae.body.steps.map(s => [s.name, s.status]), [['crm', 'skipped'], ['platform', 'skipped'], ['sheet', 'ok']]);
  assert.match(ae.body.steps[1].message, /aEvent has no documented way/);
  assert.equal(ae.body.redirect, '');
  assert.equal(register.buildRedirect('Mary Ann', 'm+a@example.com', 'https://go.example.com/c?step=2#top'), 'https://go.example.com/c?step=2&first_name=Mary+Ann&email=m%2Ba%40example.com#top');
  assert.equal(register.buildRedirect('Jane', 'j@example.com', 'not a url'), '');
});

test('register and survey: allowed sites, rate limits, survey answers and a note on the contact', async () => {
  setup({ WEBINAR_ALLOWED_ORIGINS: 'https://go.example.com' });
  assert.equal((await post('register', PERSON, { origin: 'https://go.example.com' })).headers['access-control-allow-origin'], 'https://go.example.com');
  assert.equal((await post('register', { ...PERSON, email: 'no@example.com' }, { origin: 'https://evil.example' })).code, 403);
  assert.equal((await call({ method: 'OPTIONS', query: { source: 'survey' }, headers: { origin: 'https://evil.example' } })).code, 403);
  assert.deepEqual(rows('WEBINAR_REGISTRANTS').map(r => r.Email), ['jane@example.com']);

  setup({});
  const [emailMax] = register.LIMITS.email;
  for (let n = 0; n < emailMax; n++) assert.equal((await post('register', PERSON, { 'x-forwarded-for': `198.51.100.${n}` })).code, 200);
  assert.equal((await post('register', PERSON, { 'x-forwarded-for': '198.51.100.200' })).code, 429);

  setup({ ...GHL });
  const seen = stubFetch([['https://services.leadconnectorhq.com/contacts/upsert', () => ({ contact: { id: 'ghl-1' } })], ['https://services.leadconnectorhq.com/contacts/ghl-1/notes', () => ({})]]);
  const res = await post('survey', { email: 'Jane@Example.com', first_name: 'Jane', company_website: '', answers: [{ question: 'Biggest challenge?', answer: 'Not enough leads' }, { question: 'Tried?', answer: 'Ads' }, { question: 'Budget?', answer: 'Under 5k' }, { question: 'Fourth?', answer: 'dropped' }] });
  assert.deepEqual(res.body, { ok: true, status: 'ok', steps: [{ name: 'sheet', status: 'ok', message: 'saved' }, { name: 'crm', status: 'ok', message: 'note added' }] });
  const [row] = rows('WEBINAR_SURVEY');
  assert.deepEqual([row.Email, row['Answer 1'], row['Answer 3']], ['jane@example.com', 'Not enough leads', 'Under 5k']);
  assert.ok(!JSON.stringify(row).includes('dropped'));
  assert.match(JSON.parse(seen[1].init.body).body, /Biggest challenge\?: Not enough leads/);
  assert.equal((await post('survey', { email: 'x@example.com', answers: [] })).code, 400);
  assert.equal((await post('survey', { email: 'bot@example.com', company_website: 'x', answers: [{ question: 'q', answer: 'a' }] })).body.steps.length, 0);
  assert.equal(rows('WEBINAR_SURVEY').length, 1);
});

test('updates from other tools: shut without a secret; a whole sign-up or a platform’s own message', async () => {
  setup({});
  assert.equal((await call({ method: 'POST', query: { source: 'event' }, body: { type: 'webinar_attended', email: 'a@example.com' } })).code, 503);
  setup({ EVENT_INGEST_SECRET: 'event-secret-0123456789' });
  const auth = { authorization: 'Bearer event-secret-0123456789' };
  assert.equal((await call({ method: 'POST', query: { source: 'event' }, headers: { authorization: 'Bearer wrong' }, body: {} })).code, 401);
  assert.equal((await call({ method: 'POST', query: { source: 'event' }, headers: auth, body: { type: 'webinar_registrant', email: 'Zed@Example.com', attended_live: true, minutes_watched: 52 } })).body.registrants, 1);
  assert.equal((await call({ method: 'POST', query: { source: 'event', provider: 'ewebinar', key: 'event-secret-0123456789' }, body: EW })).code, 200);
  assert.equal((await call({ method: 'POST', query: { source: 'event' }, headers: auth, body: { type: 'webinar_attended', email: 'a@example.com' } })).body.appended, 1);
  assert.deepEqual(rows('WEBINAR_REGISTRANTS').map(r => [r.Email, r.Provider, r['Minutes Watched'], r['Percent Watched'], r.Source]), [['zed@example.com', 'webhook', '52', '', 'webhook'], ['john.doe@defaultmail.example.com', 'ewebinar', '', '72', 'webhook']]);
  assert.deepEqual(rows('EVENTS').map(r => r.Type), ['webinar_attended']);
});

// ════════════════════════════════════════════════════════════════════════════
// Payments: whichever tool the business takes money through
// ════════════════════════════════════════════════════════════════════════════

test('payments: each tool is read its own way onto the same rows, and only money that was really paid counts', async () => {
  setup({}); wipe(); freshDb();
  const payments = require(path.join(root, 'api/_lib/sync/payments.js'));
  assert.deepEqual(payments.PROVIDERS, ['stripe', 'whop', 'commas', 'paypal', 'ghl', 'kajabi', 'lemonsqueezy', 'paddle']);
  const since = new Date('2026-01-01T00:00:00Z');
  const ctx = { since, checkBudget() {}, beginWrite() {} };
  const use = async (values) => { await store.saveSettings({ values }); applySettings(await store.loadSettings({ fresh: true })); };
  const rows = async () => (await db.readTab(TABS.PAYMENTS)).map(r => [r['Object ID'], r.Kind, r.Amount, r.Currency, r.Email]);

  // a site set up before there was a choice has a Stripe key and nothing else: that is still Stripe
  applySettings({ STRIPE_SECRET_KEY: ['rk', 'live', '0123456789abcdefghij'].join('_') });
  assert.deepEqual([config.payments.provider, connections().payments], ['stripe', true]);
  applySettings({});
  assert.deepEqual([config.payments.provider, connections().payments, payments.adapter()], ['none', false, null]);

  // Whop: decimals, the buyer under user, refunds in substatus
  await use({ PAYMENTS_PROVIDER: 'whop', WHOP_API_KEY: 'apik_' + FAKE });
  assert.equal(connections().payments, true);
  let seen = stubFetch([['https://api.whop.com/api/v1/payments', (u) => (u.includes('after=c2') ? { data: [], page_info: { has_next_page: false } } : { data: [
    { id: 'pay_1', total: 997, currency: 'usd', status: 'paid', substatus: 'succeeded', created_at: '2026-03-01T10:00:00.000Z', user: { email: 'Jane@Example.com', name: 'Jane' }, product: { title: 'Programme' } },
    { id: 'pay_2', total: 997, currency: 'usd', status: 'paid', substatus: 'refunded', refunded_amount: 997, created_at: '2026-03-02T10:00:00.000Z', user: { email: 'bob@example.com' } },
    { id: 'pay_3', total: 500, currency: 'usd', status: 'paid', substatus: 'partially_refunded', refunded_amount: 100, created_at: '2026-03-03T10:00:00.000Z', user: { email: 'cat@example.com' } },
    { id: 'pay_4', total: 49, currency: 'usd', status: 'open', substatus: 'failed', created_at: '2026-03-04T10:00:00.000Z', user: { email: 'dan@example.com' } },
  ], page_info: { has_next_page: true, end_cursor: 'c2' } })]]);
  let out = await payments.run(ctx);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer apik_0123456789abcdef');
  assert.match(seen[0].url, /created_after=2026-01-01/);
  assert.deepEqual(await rows(), [['whop:pay_1', 'charge', '997.00', 'USD', 'jane@example.com'], ['whop:pay_2', 'refund', '997.00', 'USD', 'bob@example.com'], ['whop:pay_3', 'charge', '400.00', 'USD', 'cat@example.com'], ['whop:pay_4', 'failed', '49.00', 'USD', 'dan@example.com']]);
  assert.match(out.message, /^Whop: payments=4 paid=2 gross=1397\.00/);

  // Commas (was Fanbasis): its own header, no date filter so it stops at the first page that is all too old
  await use({ PAYMENTS_PROVIDER: 'commas', COMMAS_API_KEY: 'fb_' + FAKE });
  seen = stubFetch([['https://www.fanbasis.com/public-api/checkout-sessions/transactions', (u) => ({ status: 'success', data: u.includes('page=1&') ? { transactions: [
    { id: 919049, transaction_date: '2026-06-30T14:55:09.000000Z', fan: { name: 'Jane Doe', email: 'jane@example.com' }, product: { title: 'Pro Monthly' }, refunds: [], amount: 29.99 },
    { id: 919050, transaction_date: '2026-06-29T14:55:09.000000Z', fan: { email: 'bob@example.com' }, refunds: [{ amount: 29.99 }], amount: 29.99 },
  ], pagination: { has_more: true } } : { transactions: [{ id: 1, transaction_date: '2025-06-30T14:55:09.000000Z', fan: { email: 'old@example.com' }, refunds: [], amount: 10 }], pagination: { has_more: true } } })]]);
  await payments.run(ctx);
  assert.equal(seen[0].init.headers['x-api-key'], 'fb_0123456789abcdef');
  assert.equal(seen.length, 2, 'it stops once a page is entirely older than the window');
  assert.deepEqual(await rows(), [['commas:919049', 'charge', '29.99', 'USD', 'jane@example.com'], ['commas:919050', 'refund', '29.99', 'USD', 'bob@example.com']]);

  // PayPal: a token first, only payments received, never fees or payouts
  await use({ PAYMENTS_PROVIDER: 'paypal', PAYPAL_CLIENT_ID: 'A'.repeat(40), PAYPAL_SECRET: 'E'.repeat(40) });
  seen = stubFetch([
    ['https://api-m.paypal.com/v1/oauth2/token', () => ({ access_token: 'tok_1' })],
    ['https://api-m.paypal.com/v1/reporting/transactions', (u) => ({ total_pages: 1, transaction_details: u.includes('start_date=2026-01-01') ? [
      { transaction_info: { transaction_id: 'T1', transaction_event_code: 'T0006', transaction_status: 'S', transaction_amount: { value: '1500.00', currency_code: 'GBP' }, transaction_initiation_date: '2026-01-05T10:00:00+0000' }, payer_info: { email_address: 'jane@example.com', payer_name: { given_name: 'Jane', surname: 'Doe' } } },
      { transaction_info: { transaction_id: 'T2', transaction_event_code: 'T0400', transaction_status: 'S', transaction_amount: { value: '-900.00', currency_code: 'GBP' } } },
      { transaction_info: { transaction_id: 'T3', transaction_event_code: 'T0006', transaction_status: 'V', transaction_amount: { value: '200.00', currency_code: 'GBP' }, transaction_initiation_date: '2026-01-06T10:00:00+0000' }, payer_info: { email_address: 'bob@example.com' } },
    ] : [] })],
  ]);
  await payments.run(ctx);
  assert.match(seen[0].init.headers.Authorization, /^Basic /);
  assert.equal(seen[1].init.headers.Authorization, 'Bearer tok_1');
  assert.deepEqual(await rows(), [['paypal:T1', 'charge', '1500.00', 'GBP', 'jane@example.com'], ['paypal:T3', 'refund', '200.00', 'GBP', 'bob@example.com']]);

  // every tool explains a bad key in plain words, and never repeats the key
  const me = await owner();
  for (const [values, url, label] of [[{ PAYMENTS_PROVIDER: 'whop' }, 'https://api.whop.com/', 'Whop'], [{ PAYMENTS_PROVIDER: 'commas' }, 'https://www.fanbasis.com/', 'Commas'],
    [{ PAYMENTS_PROVIDER: 'lemonsqueezy', LEMONSQUEEZY_API_KEY: 'l'.repeat(40) }, 'https://api.lemonsqueezy.com/', 'Lemon Squeezy'], [{ PAYMENTS_PROVIDER: 'paddle', PADDLE_API_KEY: 'p'.repeat(40) }, 'https://api.paddle.com/', 'Paddle']]) {
    await use(values);
    stubFetch([[url, () => new Response('{"message":"nope"}', { status: 401 })]]);
    const t = await call({ method: 'POST', query: { source: 'settings_test' }, headers: me, body: { target: 'payments' } });
    assert.deepEqual([t.body.ok, t.body.message], [false, `That did not work: ${label} rejected the key. Check you copied all of it.`]);
  }
  await use({ PAYMENTS_PROVIDER: 'kajabi' });
  assert.match((await call({ method: 'POST', query: { source: 'settings_test' }, headers: me, body: { target: 'payments' } })).body.message, /Paste your Kajabi Client ID and Client secret first/);
  assert.equal((await call({ method: 'POST', query: { source: 'settings' }, headers: me, body: { values: { PAYMENTS_PROVIDER: 'cash' } } })).code, 400);
  wipe(); db.useMemory({});
});

test('payments: a tool we cannot read sends each sale itself, in its own shape, and it counts on the results', async () => {
  setup({}); wipe(); freshDb();
  const { asSale, buildEventRow } = require(path.join(root, 'api/_lib/handlers/event.js'));
  const col = (row, h) => row[HEADERS.EVENTS.indexOf(h)];
  // the buyer and the money are found wherever the tool put them; cents are turned into whole currency
  let row = buildEventRow(asSale({ event: 'order.success', order_id: 77, customer: { email: 'Jane@Example.com', name: 'Jane Doe' }, order: { total: '1,497.00', currency: 'gbp' } }), '2026-03-01T00:00:00.000Z');
  assert.deepEqual([col(row, 'Type'), col(row, 'Email'), col(row, 'Amount'), col(row, 'Currency'), col(row, 'Name'), col(row, 'Event ID')], ['sale', 'jane@example.com', '1497.00', 'GBP', 'Jane Doe', 'sale:77']);
  row = buildEventRow(asSale({ data: { buyer: { email_address: 'bob@example.com' }, amount_cents: 2999 } }), '2026-03-01T00:00:00.000Z');
  assert.deepEqual([col(row, 'Email'), col(row, 'Amount')], ['bob@example.com', '29.99']);

  const me = await owner();
  await call({ method: 'POST', query: { source: 'settings' }, headers: me, body: { values: { EVENT_INGEST_SECRET: 'sales-secret-0123456789' } } });
  assert.equal((await call({ method: 'POST', query: { source: 'event', type: 'sale', key: 'wrong' }, body: { email: 'x@example.com', amount: 5 } })).code, 401);
  let r = await call({ method: 'POST', query: { source: 'connections_test' }, headers: me, body: { id: 'payments' } });
  assert.equal(r.body.checks[0].status, 'manual'); assert.match(r.body.checks[0].message, /no sale has been sent to it yet/);

  store.resetRateLimits();
  await call({ method: 'POST', query: { source: 'register' }, body: { first_name: 'Jane', email: 'jane@example.com' } });
  r = await call({ method: 'POST', query: { source: 'event', type: 'sale', key: 'sales-secret-0123456789' }, body: { customer: { email: 'jane@example.com' }, total: 1497, transaction_id: 'tx_1' } });
  assert.deepEqual([r.code, r.body.appended], [200, 1]);
  r = await call({ method: 'POST', query: { source: 'connections_test' }, headers: me, body: { id: 'payments' } });
  assert.deepEqual([r.body.checks[0].status, r.body.checks[0].message], ['ok', 'Working. 1 sale has been sent to us by your payment tool.']);
  const res = await getResults({});
  const tile = JSON.stringify(res);
  assert.match(tile, /1497/, 'the sale shows as revenue from that sign-up');
  wipe(); db.useMemory({});
});

// ════════════════════════════════════════════════════════════════════════════
// Test every connection: proof that each tool works, not just that a key is saved
// ════════════════════════════════════════════════════════════════════════════

test('connections: every tool is really tested, contacts by adding one and removing it, and each result says what to do', async () => {
  setup({}); wipe(); freshDb(); store.resetRateLimits();
  const me = await owner();
  const post = (source, body) => call({ method: 'POST', query: { source }, headers: me, body });
  const byId = (r) => Object.fromEntries(r.body.checks.map(c => [c.id, c]));

  // nothing connected: nothing pretends to work
  let r = await call({ query: { action: 'connections' }, headers: me });
  assert.deepEqual(r.body.checks.map(c => c.id), ['storage', 'webinar', 'contacts', 'signups', 'confirmation_page', 'booking_link', 'calendar', 'payments', 'ads', 'emails', 'texts']);
  assert.equal(byId(r).storage.status, 'untested');
  for (const id of ['webinar', 'contacts', 'calendar', 'payments', 'ads']) assert.equal(byId(r)[id].status, 'off', id);
  assert.equal(r.body.all_working, false);

  await post('intake', { intake: { booking_link: 'https://calendly.com/acme/call', email_tool: 'GoHighLevel', how_people_buy: 'call' } });
  await post('settings', { values: { WEBINAR_PROVIDER: 'webinarjam', WEBINARJAM_API_KEY: 'k'.repeat(64), WEBINAR_IDS: '["123"]', CRM_PROVIDER: 'ghl', GHL_API_KEY: 'pit-' + FAKE, GHL_LOCATION_ID: 'AbC123xyz',
    STRIPE_SECRET_KEY: ['rk', 'test', '0123456789abcdefghij'].join('_'), WEBINAR_CONFIRMATION_URL: 'https://acme.test/confirmed' } });
  const seen = stubFetch([
    ['https://api.webinarjam.com/webinarjam/webinars', () => ({ status: 'success', webinars: [{ webinar_id: 123, name: 'Sample Training' }] })],
    ['https://services.leadconnectorhq.com/opportunities/pipelines', () => ({ pipelines: [{ id: 'pipe_1', name: 'Webinar' }] })],
    ['https://services.leadconnectorhq.com/contacts/upsert', () => ({ contact: { id: 'contact_test_1' } })],
    ['https://services.leadconnectorhq.com/contacts/contact_test_1', () => ({ succeded: true })],
    ['https://api.stripe.com/v1/charges', () => ({ data: [] })],
    ['https://acme.test/confirmed', () => new Response('<html>ok</html>', { status: 200 })],
    ['https://calendly.com/acme/call', () => new Response('gone', { status: 404 })],
  ]);
  r = await post('connections_test', {});
  let c = byId(r);
  assert.equal(c.storage.status, 'ok');
  assert.deepEqual([c.webinar.status, c.webinar.message], ['ok', 'Working. We can read WebinarJam / EverWebinar and your webinar is chosen.']);
  assert.deepEqual([c.contacts.status, c.contacts.message], ['ok', 'Working. We added a test contact to GoHighLevel and removed it again, so every sign-up will be saved there.']);
  const made = seen.find(x => x.url.endsWith('/contacts/upsert')), gone = seen.find(x => x.url.endsWith('/contacts/contact_test_1'));
  assert.equal(JSON.parse(made.init.body).firstName, 'Webinar System connection test');
  assert.equal(gone.init.method, 'DELETE', 'the test contact is removed again');
  assert.equal(c.confirmation_page.status, 'ok');
  assert.equal(c.booking_link.status, 'fail'); assert.match(c.booking_link.message, /could not be found.*Change it in Setup step 3/);
  assert.equal(c.payments.status, 'warn'); assert.match(c.payments.message, /test key/);
  assert.equal(c.signups.status, 'manual');
  assert.equal(c.emails.status, 'manual'); assert.match(c.emails.message, /cannot see inside GoHighLevel/);
  for (const id of ['calendar', 'ads', 'texts']) assert.equal(c[id].status, 'off', id);
  assert.deepEqual([r.body.counts.fail, r.body.all_working], [1, false]);
  for (const x of r.body.checks) { assert.ok(x.message && x.tested_at, x.id); assert.doesNotMatch(x.message, /undefined|\[object|pit-|kkkk/); }

  // what happened is remembered, without calling any tool again
  stubFetch([]);
  r = await call({ query: { action: 'connections' }, headers: me });
  assert.deepEqual([byId(r).contacts.status, byId(r).booking_link.status], ['ok', 'fail']);

  // a key that can read but not write would lose every sign-up, so that is a failure
  stubFetch([
    ['https://services.leadconnectorhq.com/opportunities/pipelines', () => ({ pipelines: [] })],
    ['https://services.leadconnectorhq.com/contacts/upsert', () => new Response('{"message":"The token does not have access to this scope"}', { status: 403 })],
  ]);
  r = await post('connections_test', { id: 'contacts' });
  assert.equal(r.body.checks.length, 1);
  assert.deepEqual([r.body.checks[0].status, r.body.checks[0].message], ['fail', 'GoHighLevel lets us look at contacts but not add them. Create the key again and tick Edit Contacts as well as View Contacts.']);
  // the webinar ticked is gone from the account
  stubFetch([['https://api.webinarjam.com/webinarjam/webinars', () => ({ status: 'success', webinars: [{ webinar_id: 999, name: 'Other' }] })]]);
  r = await post('connections_test', { id: 'webinar' });
  assert.equal(r.body.checks[0].status, 'warn'); assert.match(r.body.checks[0].message, /no longer in the account/);
  assert.equal((await post('connections_test', { id: 'nope' })).code, 400);
  // an address on this machine or a private network is never opened
  const { safeAddress } = require(path.join(root, 'api/_lib/handlers/health.js'));
  for (const bad of ['http://localhost:3000', 'http://127.0.0.1/', 'http://10.0.0.5/x', 'http://192.168.1.1', 'file:///etc/passwd', 'not a link']) assert.equal(safeAddress(bad), null, bad);

  // one sign-up down the real path, each step in plain words
  stubFetch([
    ['https://services.leadconnectorhq.com/contacts/upsert', () => ({ contact: { id: 'contact_9' } })],
    ['https://services.leadconnectorhq.com/contacts/contact_9/tags', () => ({ tags: ['webinar-registered'] })],
    ['https://api.webinarjam.com/webinarjam/register', () => ({ status: 'success', user: { lead_id: 77, live_room_url: 'https://event.webinarjam.com/go/live/1/xyz' } })],
  ]);
  assert.equal((await post('test_signup', { email: 'nope' })).code, 400);
  r = await post('test_signup', { first_name: 'Sam', email: 'sam@example.com' });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.steps.map(s => [s.name, s.status]), [['sheet', 'ok'], ['crm', 'ok'], ['platform', 'ok']]);
  assert.equal(r.body.join_url, 'https://event.webinarjam.com/go/live/1/xyz');
  assert.match(r.body.message, /check sam@example\.com for the confirmation email/);
  stubFetch([]);
  r = await post('connections_test', { id: 'signups' });
  assert.equal(r.body.checks[0].status, 'ok'); assert.match(r.body.checks[0].message, /^Working\. 1 sign-up has come through/);
  wipe(); db.useMemory({});
});

// ════════════════════════════════════════════════════════════════════════════
// Questionnaires: answered on the page, downloaded, or uploaded as a document
// ════════════════════════════════════════════════════════════════════════════

test('questionnaires: every information step has one, answers save one at a time, and the copy keeps to the plain language rules', async () => {
  setup({}); wipe();
  const me = await owner();
  const { QUESTIONNAIRES, questionsOf } = require(path.join(root, 'api/_lib/questionnaires.js'));
  for (const step of [1, 2, 3, 4, 5]) assert.ok(QUESTIONNAIRES.some(q => q.step === step), `step ${step} has a questionnaire`);
  for (const q of QUESTIONNAIRES) {
    const ids = questionsOf(q).map(x => x.id);
    assert.equal(new Set(ids).size, ids.length, `${q.id} repeats a question id`);
    assert.ok(q.blurb && q.files && q.minutes > 0, q.id);
    for (const x of questionsOf(q)) if (x.type === 'ticks') assert.ok(x.options.length > 1, `${q.id}.${x.id}`);
  }
  const words = JSON.stringify(QUESTIONNAIRES);
  assert.doesNotMatch(words, /[–—]/, 'a dash in a questionnaire');
  for (const banned of [/\bICP\b/, /\bCTA\b/, /\bURLs?\b/, /\bNPS\b/, /\bROI\b/, /psychographic/i, /\bfunnel\b/i, /unique mechanism/i]) assert.doesNotMatch(words, banned, `a questionnaire says "${(words.match(banned) || [''])[0]}"`);

  let r = await call({ query: { action: 'answers' }, headers: me });
  assert.equal(r.body.catalogue.length, QUESTIONNAIRES.length);
  assert.deepEqual(r.body.answers, {});
  // one answer at a time, like the page sends them; nothing else is disturbed
  r = await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'offer', answers: { price: ' 3,000 pounds ' } } });
  assert.deepEqual(r.body.answers, { price: '3,000 pounds' });
  r = await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'offer', answers: { guarantee: 'None', not_a_question: 'x' } } });
  assert.deepEqual(r.body.answers, { price: '3,000 pounds', guarantee: 'None' });
  // an emptied answer is removed; ticks keep only the options on offer
  r = await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'offer', answers: { guarantee: '' } } });
  assert.deepEqual(r.body.answers, { price: '3,000 pounds' });
  r = await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'proof', answers: { have: ['Video testimonials', 'Made up'] } } });
  assert.deepEqual(r.body.answers, { have: ['Video testimonials'] });
  // a link to their finished copy sits beside the answers; anything that is not a link is refused
  r = await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'proof', answers: { _link: 'https://docs.google.com/document/d/abc/edit' } } });
  assert.equal(r.body.answers._link, 'https://docs.google.com/document/d/abc/edit');
  assert.equal((await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'proof', answers: { _link: 'my doc' } } })).code, 400);
  r = await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'proof', answers: { _link: '' } } });
  assert.deepEqual(r.body.answers, { have: ['Video testimonials'] });
  // a questionnaire opens in Google Docs as a copy (never the original) only when a Doc id is configured
  for (const q of QUESTIONNAIRES) assert.match(q.google_doc, /^(https:\/\/docs\.google\.com\/document\/d\/[\w-]{20,}\/copy)?$/, q.id);
  // one client success story per client, up to five
  r = await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key: 'case_study.2', answers: { client_name: 'Sam P.' } } });
  assert.equal(r.body.key, 'case_study.2');
  for (const key of ['case_study.6', 'case_study.0', 'offer.1', 'nope', '']) assert.equal((await call({ method: 'POST', query: { source: 'answers' }, headers: me, body: { key, answers: {} } })).code, 400, key);
  // the build reads them, and may fill them in from documents it already has
  r = await call({ query: { action: 'answers' }, headers: builder });
  assert.deepEqual(Object.keys(r.body.answers).sort(), ['case_study.2', 'offer', 'proof']);
  assert.equal((await call({ method: 'POST', query: { source: 'answers' }, headers: builder, body: { key: 'rules', answers: { regulated: 'No' } } })).code, 200);
  wipe();
});

async function uploadRoundTrip(me) {
  const bytes = Buffer.from('%PDF-1.4 a made-up document '.repeat(40000));    // about 1.1 MB, so it is stored in pieces
  let r = await call({ method: 'POST', query: { source: 'upload' }, headers: me, body: { key: 'offer', name: '../../Sales page (final).pdf', data: `data:application/pdf;base64,${bytes.toString('base64')}` } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.file.name, 'Sales page (final).pdf');
  assert.equal(r.body.file.size, bytes.length);
  assert.equal(r.body.file.pieces, undefined, 'how it is stored is nobody else’s business');
  const id = r.body.file.id;
  const got = await require(path.join(root, 'api/_lib/handlers/answers.js')).getFile(id);
  assert.ok(got.buffer.equals(bytes), 'the file comes back byte for byte');
  // it is always served as a download, to the owner and to the build
  for (const headers of [me, builder]) {
    const res = await call({ query: { action: 'file', id }, headers });
    assert.equal(res.code, 200);
    assert.match(res.headers['content-disposition'], /^attachment; filename\*=UTF-8''Sales%20page%20\(final\)\.pdf$/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal((await call({ query: { action: 'file', id } })).code, 401);
  assert.equal((await call({ query: { action: 'file', id: 'nope' }, headers: me })).code, 404);
  // refused, in plain words: the wrong kind, too big, not a questionnaire
  r = await call({ method: 'POST', query: { source: 'upload' }, headers: me, body: { key: 'offer', name: 'run.exe', data: 'AAAA' } });
  assert.equal(r.code, 400); assert.match(r.body.message, /cannot take that kind of file/);
  r = await call({ method: 'POST', query: { source: 'upload' }, headers: me, body: { key: 'offer', name: 'big.pdf', data: 'A'.repeat(4 * 1024 * 1024 + 4) } });
  assert.equal(r.code, 413); assert.match(r.body.message, /bigger than 3 MB.*paste the link/);
  assert.equal((await call({ method: 'POST', query: { source: 'upload' }, headers: me, body: { key: 'nope', name: 'a.pdf', data: 'AAAA' } })).code, 400);
  assert.equal((await call({ query: { action: 'answers' }, headers: me })).body.files.length, 1);
  // removing it removes every piece
  r = await call({ method: 'POST', query: { source: 'file_delete' }, headers: me, body: { id } });
  assert.deepEqual(r.body.files, []);
  assert.equal((await call({ query: { action: 'file', id }, headers: me })).code, 404);
  return id;
}

test('documents: uploaded beside a questionnaire, kept encrypted in pieces, downloaded intact, removed cleanly (local folder)', async () => {
  setup({}); wipe();
  const id = await uploadRoundTrip(await owner());
  assert.deepEqual(fs.readdirSync(path.join(tmp, '.data')).filter(f => f.includes(id)), []);
  wipe();
});

test('documents: the same on Redis, and no single request to it is large', withRedis(async (redis) => {
  const me = await owner();
  const id = await uploadRoundTrip(me);
  assert.deepEqual([...redis.data.keys()].filter(k => k.includes(id)), [], 'every piece is deleted');
  await call({ method: 'POST', query: { source: 'upload' }, headers: me, body: { key: 'brand_assets', name: 'logo.png', data: Buffer.alloc(900000, 7).toString('base64') } });
  const pieces = [...redis.data.entries()].filter(([k]) => /:file-[0-9a-f]{16}-\d+$/.test(k));
  assert.equal(pieces.length, 3);
  for (const [, blob] of pieces) { assert.ok(blob.length < 800000); assert.match(blob, /^v1:/, 'encrypted at rest'); }
}));

// ════════════════════════════════════════════════════════════════════════════
// Voice typing, and the words on the page
// ════════════════════════════════════════════════════════════════════════════

test('voice typing: every text box and text area marked for it gets a microphone; keys, links, numbers, dates and passwords never do', () => {
  // a browser that supports speech, just enough of one for the helper to wire itself up
  globalThis.SpeechRecognition = function () {};
  delete require.cache[require.resolve(path.join(root, 'public/voice.js'))];
  const Voice = require(path.join(root, 'public/voice.js'));
  const field = (tagName, type, dataset = { voice: '' }, extra = {}) => ({ tagName, type, dataset: { ...dataset }, getAttribute: () => null, ...extra });

  assert.equal(Voice.eligible(field('TEXTAREA')), true);
  assert.equal(Voice.eligible(field('INPUT', 'text')), true);
  assert.equal(Voice.eligible(field('INPUT', undefined)), true, 'an input with no type is a text input');
  for (const type of ['password', 'number', 'date', 'time', 'color', 'url', 'email', 'tel', 'checkbox', 'hidden']) assert.equal(Voice.eligible(field('INPUT', type)), false, type);
  assert.equal(Voice.eligible(field('INPUT', 'text', {})), false, 'not marked for voice');
  assert.equal(Voice.eligible(field('INPUT', 'text', { voice: '', kind: 'key' })), false, 'a key is pasted, never dictated');
  assert.equal(Voice.eligible(field('INPUT', 'text', { voice: '', kind: 'link' })), false);
  assert.equal(Voice.eligible(field('INPUT', 'text', { voice: 'off' })), false);
  assert.equal(Voice.eligible(field('TEXTAREA', undefined, { voice: '' }, { readOnly: true })), false);
  assert.equal(Voice.eligible(field('SELECT')), false);
  assert.equal(Voice.eligible(null), false);

  // enhance(): wraps each eligible field once, adds a real button and a live status line
  const made = [];
  const node = (tag) => { const n = { tag, children: [], attrs: {}, classList: { add() {}, remove() {} }, listeners: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); c.parentNode = this; }, insertBefore(c) { this.children.push(c); c.parentNode = this; }, addEventListener(e, f) { this.listeners[e] = f; } }; made.push(n); return n; };
  const doc = { createElement: node };
  const parent = node('div');
  const mk = (tagName, type, dataset) => ({ ...field(tagName, type, dataset), ownerDocument: doc, parentNode: parent, labels: [{ textContent: 'Who is it for?' }] });
  const fields = [mk('TEXTAREA', undefined, { voice: '' }), mk('INPUT', 'text', { voice: '' }), mk('INPUT', 'text', { voice: '' }), mk('INPUT', 'password', { voice: '' }), mk('INPUT', 'text', { voice: '', kind: 'key' }), mk('INPUT', 'date', { voice: '' })];
  const rootNode = { querySelectorAll: (sel) => { assert.equal(sel, 'input[data-voice], textarea[data-voice]'); return fields; } };
  assert.equal(Voice.enhance(rootNode), 3);
  const buttons = made.filter(n => n.tag === 'button');
  assert.equal(buttons.length, 3, 'one microphone per eligible field');
  for (const b of buttons) { assert.equal(b.type, 'button'); assert.equal(b.attrs['aria-pressed'], 'false'); assert.match(b.attrs['aria-label'], /^Speak your answer for Who is it for\?$/); assert.equal(typeof b.listeners.click, 'function'); }
  assert.equal(made.filter(n => n.tag === 'span' && n.attrs['aria-live'] === 'polite').length, 3, 'each has a status line screen readers hear');
  assert.deepEqual(fields.map(f => Boolean(f.dataset.voiceReady)), [true, true, true, false, false, false]);
  assert.equal(Voice.enhance(rootNode), 3);
  assert.equal(made.filter(n => n.tag === 'button').length, 3, 'calling it again after a redraw does not add a second microphone');

  // dictated words go in where the cursor was, with sensible spacing
  assert.deepEqual(Voice.insertAt('', 0, 0, 'owners of small clinics'), { value: 'Owners of small clinics', caret: 23 });
  assert.equal(Voice.insertAt('Busy all week', 13, 13, 'and still worried').value, 'Busy all week and still worried');
  assert.equal(Voice.insertAt('One. Three.', 5, 5, 'two.').value, 'One. Two. Three.');
  assert.equal(Voice.insertAt('keep this', 0, 9, '  ').value, 'keep this');

  // a browser without speech recognition: no buttons, and the page shows its one quiet line
  delete globalThis.SpeechRecognition;
  delete require.cache[require.resolve(path.join(root, 'public/voice.js'))];
  const Plain = require(path.join(root, 'public/voice.js'));
  assert.equal(Plain.supported(), false);
  assert.equal(Plain.enhance(rootNode), 0);
  assert.equal(Plain.UNSUPPORTED, 'Voice typing works in Google Chrome.');
});

test('the pages: every box people type words into is marked for voice, and the copy keeps to the plain language rules', () => {
  const read = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
  const pages = ['index.html', 'results.html', 'settings.html', 'login.html'], scripts = ['app.js', 'setup.js', 'results.js', 'settings.js', 'tools.js', 'voice.js', 'deep.js', 'health.js'];
  const setupJs = read('setup.js'), toolsJs = read('tools.js');

  // the three kinds of text answer in the guide, the list rows, the client results, the tool names and the change notes
  assert.match(setupJs, /function textQ[\s\S]*?if \(!q\.type && !q\.noVoice\) input\.dataset\.voice = ''/);
  assert.match(setupJs, /function listQ[\s\S]*?input\.dataset\.voice = ''[\s\S]*?Voice\.enhance\(box\)/);
  assert.match(setupJs, /function resultsQ[\s\S]*?input\.dataset\.voice = ''/);
  assert.match(setupJs, /Anything to change\?[\s\S]*?note\.dataset\.voice = ''/);
  assert.match(read('deep.js'), /x\.type === 'short' \? 'input' : 'textarea'[\s\S]*?input\.dataset\.voice = ''/, 'every questionnaire answer box');
  assert.match(toolsJs, /set\.text\.forEach[\s\S]*?input\.dataset\.voice = ''/);
  assert.match(setupJs, /view\.replaceChildren\(screens\[state\.screen\]\(\)\);\s*var mics = Voice\.enhance\(view\)/, 'every screen is enhanced after it is drawn');
  // and the ones that must not be: keys and links are tagged so the helper skips them
  assert.match(toolsJs, /input\.dataset\.kind = def\.kind \|\| 'plain'/);
  assert.doesNotMatch(toolsJs, /function field[\s\S]*?dataset\.voice[\s\S]*?function picker/, 'a paste box for a key is never marked for voice');
  assert.match(setupJs, /key: 'booking_link'[^}]*kind: 'link', noVoice: true/);
  assert.match(read('index.html'), /id="novoice">Voice typing works in Google Chrome\.</);

  for (const f of [...pages, ...scripts, 'app.css']) {
    const text = read(f);
    assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ''), /[–—]/, `${f} has a dash in its copy`);
    assert.doesNotMatch(text, /Command Centre|command centre/, f);
  }
  // words a first-time user should never meet (addresses of other sites are not copy)
  const copy = [...pages, ...scripts].map(f => read(f).replace(/https?:\/\/[^\s'"<)]+/g, '').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')).join('\n');
  const strings = (copy.match(/'(?:[^'\\\n]|\\.)*'|>[^<>{}]+</g) || []).join('\n');
  for (const banned of [/\bendpoints?\b/i, /\bJSON\b/, /\benv(ironment)? var/i, /\bingest/i, /funnel map/i, /sync part/i, /\bAPI tokens?\b/i, /\bURLs?\b/, /pipeline id/i, /Google Sheet/i, /scorecard|EOD|dialler|setter/i]) {
    assert.doesNotMatch(strings, banned, `the pages say "${(strings.match(banned) || [''])[0]}"`);
  }
  for (const f of ['README.md', 'package.json', '.env.example']) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /Command Centre/i, f);
  assert.equal(require(path.join(root, 'package.json')).name, 'webinar-system');
  assert.deepEqual(fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.html')).sort(), ['index.html', 'login.html', 'results.html', 'settings.html']);
});
