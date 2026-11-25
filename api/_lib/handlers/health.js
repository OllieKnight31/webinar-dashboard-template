// "Test every connection": one place that proves each tool really works, not just that a key
// was pasted. Owner only (api/index.js checks).
//   GET  /api?action=connections       → { checks: [{ id, label, status, message, tested_at }], counts, all_working }
//   POST /api?source=connections_test  → run every check (or one: { id }) and save what happened
//   POST /api?source=test_signup       → { first_name, email }: send one sign-up down the real path
//
// status   ok       it works, and we proved it
//          warn     it works, but something needs a look
//          fail     it does not work; the message says what to do
//          off      nothing is connected for this, so there is nothing to test
//          manual   we cannot see inside this tool from here; the message says how to check it by hand
//          untested connected, but nobody has pressed the button yet
//
// A check goes as far as it safely can. For contacts that means adding a test contact and
// removing it again, because a key that can read but not write would lose every sign-up.
// Every message is read by someone who has never set up software.

const { config, applySettings, connections } = require('../config');
const store = require('../settings-store');
const db = require('../db');
const settings = require('./settings');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const CLOSE_BASE = 'https://api.close.com/api/v1';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const TEST_NAME = 'Webinar System connection test';

const ok = (message) => ({ status: 'ok', message });
const warn = (message) => ({ status: 'warn', message });
const fail = (message) => ({ status: 'fail', message });
const off = (message) => ({ status: 'off', message });
const manual = (message) => ({ status: 'manual', message });
const tidy = (m) => String(m || '').replace(/^That did not work: /, '').replace(/^Connected\.?\s*/, '');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const NAMES = { ghl: 'GoHighLevel', close: 'Close', webinarjam: 'WebinarJam', everwebinar: 'EverWebinar', ewebinar: 'eWebinar', aevent: 'aEvent', meta: 'Facebook and Instagram ads' };

async function http(url, { method = 'GET', headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  let json = {};
  try { json = await resp.json(); } catch { /* no body */ }
  return { ok: resp.ok, status: resp.status, json };
}

// ── The checks ──────────────────────────────────────────────────────────────
async function checkStorage() {
  if (store.backend() === 'none') return fail('Nothing can be saved yet. In Vercel open this project, then Storage, add Upstash Redis, connect it and redeploy.');
  const stamp = new Date().toISOString();
  await store.saveDoc('probe', { stamp });
  const back = await store.loadDoc('probe');
  return back && back.stamp === stamp ? ok('Working. We saved something and read it straight back.') : fail('We saved something but could not read it back. Ask whoever set this site up to check its storage.');
}

async function checkWebinar() {
  const adapter = require('../sync/webinar').adapter();
  if (!adapter) return off('No webinar platform is connected. Sign-ups are still counted from your sign-up page.');
  if (!adapter.connected()) return off(`You chose ${adapter.label} but have not pasted its key yet.`);
  const t = await settings.tests.webinar();
  if (!t.ok) return fail(cap(tidy(t.message)));
  const found = (t.picks || []).length;
  const ticked = config.webinar.webinar_ids || [];
  if (!found) return warn(`${adapter.label} let us in, but there are no webinars in the account yet. Create your webinar there, then test again.`);
  if (!ticked.length) return warn(`${adapter.label} is working, but you have not ticked which webinar this is for. Open the webinar platform question, press Check connection and tick it.`);
  const known = new Set((t.picks || []).map(p => String(p.name)));
  if (!ticked.some(id => known.has(String(id)))) return warn(`${adapter.label} is working, but the webinar you ticked is no longer in the account. Tick the right one again.`);
  return ok(`Working. We can read ${adapter.label} and your webinar is chosen.${typeof adapter.register === 'function' ? '' : ' People are signed up by your sign-up page, not through us, on this platform.'}`);
}

async function ghlWrite() {
  const { api_key, location_id } = config.crm.ghl;
  const headers = { Authorization: `Bearer ${api_key}`, Version: '2021-07-28' };
  const made = await http(`${GHL_BASE}/contacts/upsert`, { method: 'POST', headers, body: { locationId: location_id, email: `connection-test-${Date.now()}@example.com`, firstName: TEST_NAME, source: 'Connection test' } });
  if (made.status === 401 || made.status === 403) return fail('GoHighLevel lets us look at contacts but not add them. Create the key again and tick Edit Contacts as well as View Contacts.');
  if (!made.ok) return fail(`GoHighLevel would not let us add a test contact (it answered ${made.status}). Check the key and the location, then test again.`);
  const id = (made.json.contact || {}).id || made.json.id || '';
  const gone = id ? await http(`${GHL_BASE}/contacts/${encodeURIComponent(id)}`, { method: 'DELETE', headers }) : { ok: false };
  return gone.ok ? null : warn(`Working: we added a test contact. We could not remove it again, so delete the contact called "${TEST_NAME}" in GoHighLevel.`);
}
async function closeWrite() {
  const headers = { Authorization: `Basic ${Buffer.from(`${config.crm.close.api_key}:`).toString('base64')}` };
  const made = await http(`${CLOSE_BASE}/lead/`, { method: 'POST', headers, body: { name: TEST_NAME } });
  if (made.status === 401 || made.status === 403) return fail('Close lets us look but not add leads. Create a new key from an account that can add leads.');
  if (!made.ok || !made.json.id) return fail(`Close would not let us add a test lead (it answered ${made.status}). Check the key, then test again.`);
  const gone = await http(`${CLOSE_BASE}/lead/${encodeURIComponent(made.json.id)}/`, { method: 'DELETE', headers });
  return gone.ok ? null : warn(`Working: we added a test lead. We could not remove it again, so delete the lead called "${TEST_NAME}" in Close.`);
}
async function checkContacts() {
  const p = config.crm.provider;
  if (p !== 'ghl' && p !== 'close') return off('Nowhere to keep contacts is connected. Sign-ups are still counted here, but they are not copied into your contacts.');
  if (!connections().crm) return off(`You chose ${NAMES[p]} but have not finished pasting its details yet.`);
  const read = await settings.tests[p]();
  if (!read.ok) return fail(cap(tidy(read.message)));
  if (p === 'ghl' && config.crm.ghl.pipeline_id && !(read.picks || []).some(x => x.name === config.crm.ghl.pipeline_id)) {
    return warn('GoHighLevel is working, but the pipeline you picked is no longer there. Open the contacts question, press Check connection and pick it again.');
  }
  const problem = await (p === 'ghl' ? ghlWrite() : closeWrite());
  return problem || ok(`Working. We added a test contact to ${NAMES[p]} and removed it again, so every sign-up will be saved there.`);
}

async function checkCalendar() {
  if (!config.calendly.token) return off('No booking calendar is connected. Booked calls will say "not known" on your results.');
  const t = await settings.tests.calendar();
  if (!t.ok) return fail(cap(tidy(t.message)));
  const ticked = config.calendly.booked_types || [];
  if (!(t.picks || []).length) return warn('Calendly let us in, but there are no kinds of meeting in the account yet. Create your sales call there, then test again.');
  if (!ticked.length) return warn('Calendly is working, but you have not ticked which meeting is your sales call, so every booking is being counted. Open the booking question, press Check connection and tick it.');
  if (!ticked.some(name => (t.picks || []).some(x => x.name === name))) return warn('Calendly is working, but the meeting you ticked has been renamed or removed. Tick the right one again.');
  return ok('Working. We can read your bookings and your sales call is chosen.');
}

async function checkPayments() {
  const adapter = require('../sync/payments').adapter();
  if (!adapter) {
    // no tool we can read: sales can still be sent to us by the tool itself
    if (!config.ingest.event_secret) return off('No payments are connected. Sales will say "not known" on your results.');
    const sales = db.isConfigured() ? (await db.readTab(db.TABS.EVENTS)).filter(e => String(e.Type).toLowerCase() === 'sale') : [];
    if (!sales.length) return manual('Your sales address is ready, but no sale has been sent to it yet. Make a small test purchase, or use the test button in your payment tool, then test again.');
    const noEmail = sales.filter(e => !e.Email).length;
    if (noEmail === sales.length) return warn(`${sales.length} sale${sales.length === 1 ? ' has' : 's have'} arrived, but none carried the buyer's email address, so we cannot tell which sign-up bought. Set your payment tool to send the email too.`);
    return ok(`Working. ${sales.length} sale${sales.length === 1 ? ' has' : 's have'} been sent to us by your payment tool.`);
  }
  if (!adapter.connected()) return off(`You chose ${adapter.label} but have not pasted its details yet.`);
  const t = await settings.tests.payments();
  if (!t.ok) return fail(cap(tidy(t.message)));
  if (/test key/.test(t.message)) return warn('Stripe is connected with a test key, so only pretend payments will show. Swap it for a live key before you launch.');
  return ok(`Working. We can read your payments from ${adapter.label}.${adapter.id === 'paypal' ? ' PayPal can take up to three hours to show a new one.' : ''}`);
}

async function checkAds() {
  if (config.ads.provider === 'none') return off('No ad account is connected. The cost numbers will say "not known".');
  if (!connections().ads) return off('You chose Facebook and Instagram ads but have not finished pasting the details yet.');
  const t = await settings.tests.ads();
  return t.ok ? ok(`Working. ${cap(tidy(t.message)) || 'We can read what your ads cost.'}`) : fail(cap(tidy(t.message)));
}

/** Only real web addresses, and never this machine or a private network. */
function safeAddress(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith('[')) return null;
  return u;
}
async function opens(raw, what, whereToFix) {
  const u = safeAddress(raw);
  if (!u) return fail(`The address for ${what} does not look right. It should start with https://. ${whereToFix}`);
  try {
    const resp = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (resp.ok) return ok(`Working. ${cap(what)} opens.`);
    if (resp.status === 404 || resp.status === 410) return fail(`${cap(what)} could not be found at that address (the page says it does not exist). ${whereToFix}`);
    if (resp.status === 401 || resp.status === 403 || resp.status === 429) return manual(`The site would not let us look at ${what} automatically. Open it yourself in a private window to make sure a stranger can see it.`);
    return fail(`${cap(what)} answered with an error (${resp.status}). Open it yourself, and if it is broken fix it where the page is built.`);
  } catch (e) {
    return fail(e && e.name === 'TimeoutError' ? `${cap(what)} took too long to open. Try again in a minute.` : `${cap(what)} could not be reached. Check the address is right. ${whereToFix}`);
  }
}

async function checkSignups() {
  if (!db.isConfigured()) return fail('Sign-ups cannot be saved until storage is connected.');
  const rows = (await db.readTab(db.TABS.WEBINAR_REGISTRANTS)).filter(r => r.Source === 'relay');
  if (!rows.length) return manual('No sign-up has come through your sign-up page yet. Press "Send a test sign-up" below, or sign up on your own page.');
  const latest = rows.map(r => r['Registered At']).filter(Boolean).sort().pop() || '';
  return ok(`Working. ${rows.length} sign-up${rows.length === 1 ? ' has' : 's have'} come through${latest ? `, the latest on ${latest.slice(0, 10)}` : ''}.`);
}

// id → [label, run(intake)]. The order is the order on the page.
const CHECKS = [
  ['storage', 'Where your answers and numbers are saved', () => checkStorage()],
  ['webinar', 'Your webinar platform', () => checkWebinar()],
  ['contacts', 'Where you keep your contacts', () => checkContacts()],
  ['signups', 'Your sign-up page reaching this system', () => checkSignups()],
  ['confirmation_page', 'Your confirmation page', () => (config.webinar.confirmation_url
    ? opens(config.webinar.confirmation_url, 'your confirmation page', 'Change it on the last step of Setup, Go live.')
    : off('You have not told us the address of your confirmation page yet. Add it on the last step of Setup, Go live.'))],
  ['booking_link', 'Your booking link', (intake) => (intake.how_people_buy === 'webinar' ? off('People buy on the webinar, so there is no booking link to test.')
    : intake.booking_link ? opens(intake.booking_link, 'your booking link', 'Change it in Setup step 3.') : off('You have not added a booking link yet. Add it in Setup step 3.'))],
  ['calendar', 'Your booking calendar', () => checkCalendar()],
  ['payments', 'Your payments', () => checkPayments()],
  ['ads', 'Your ad account', () => checkAds()],
  ['emails', 'Your emails', (intake) => (intake.email_tool
    ? manual(`We cannot see inside ${intake.email_tool} from here. Sign up on your own page and check the confirmation email arrives, then tick it on the last step of Setup.`)
    : off('You have not said what sends your emails. Add it in Setup step 4.'))],
  ['texts', 'Your texts', (intake) => (intake.sms_tool
    ? manual(`We cannot see inside ${intake.sms_tool} from here. Sign up on your own page with your mobile number and check a text arrives.`)
    : off('You are not sending texts, so there is nothing to test.'))],
];
const IDS = CHECKS.map(c => c[0]);

async function runOne([id, label, run], intake) {
  let result;
  try { result = await run(intake); }
  catch (e) { result = fail(e && e.name === 'TimeoutError' ? 'It did not answer in time. Try again in a minute.' : 'We could not reach it. Check your internet connection and try again.'); }
  return { id, label, ...result, tested_at: new Date().toISOString() };
}

async function context() {
  applySettings(await store.loadSettings({ fresh: true }));
  return ((await store.loadDoc('intake')) || {}).intake || {};
}

function summary(checks) {
  const counts = { ok: 0, warn: 0, fail: 0, off: 0, manual: 0, untested: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const connected = checks.filter(c => c.status !== 'off');
  return { counts, all_working: connected.length > 0 && connected.every(c => c.status === 'ok' || c.status === 'manual') && counts.untested === 0 };
}

/** What we knew last time, without calling any tool. */
async function getConnections() {
  await context();
  const saved = ((await store.loadDoc('health')) || {}).results || {};
  const live = connections();
  const isOn = { storage: store.backend() !== 'none', webinar: live.webinar, contacts: live.crm, calendar: live.calendar, payments: live.payments, ads: live.ads };
  const checks = CHECKS.map(([id, label]) => {
    const was = saved[id];
    // a tool that has been disconnected since it was tested is no longer "working"
    if (id in isOn && !isOn[id]) return { id, label, status: 'off', message: was && was.status === 'off' ? was.message : 'Not connected yet.', tested_at: null };
    return was ? { id, label, status: was.status, message: was.message, tested_at: was.tested_at } : { id, label, status: 'untested', message: 'Not tested yet. Press the button to test it.', tested_at: null };
  });
  return { code: 200, body: { status: 'ok', checks, ...summary(checks) } };
}

async function postConnectionsTest(body) {
  const only = body && body.id;
  if (only && !IDS.includes(only)) return { code: 400, body: { status: 'error', message: 'That is not one of the connections.' } };
  const intake = await context();
  const ran = await Promise.all(CHECKS.filter(c => !only || c[0] === only).map(c => runOne(c, intake)));
  if (store.backend() !== 'none') {
    const doc = (await store.loadDoc('health')) || {};
    const results = { ...(doc.results || {}) };
    for (const r of ran) results[r.id] = { status: r.status, message: r.message, tested_at: r.tested_at };
    await store.saveDoc('health', { results });
  }
  return { code: 200, body: { status: 'ok', checks: ran, ...summary(ran) } };
}

// ── One sign-up, down the real path ─────────────────────────────────────────
const STEP_WORDS = {
  sheet: ['Counted on your Results page', 'It was not saved'],
  crm: ['Saved to your contacts', 'It was not saved to your contacts'],
  platform: ['Signed up on your webinar platform', 'It was not signed up on your webinar platform'],
};
async function postTestSignup(body, meta) {
  const b = body && typeof body === 'object' ? body : {};
  const email = String(b.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { code: 400, body: { status: 'error', message: 'Type an email address of your own, so you can check what arrives.' } };
  await context();
  const { handleRegister } = require('./register');
  const r = await handleRegister({ first_name: String(b.first_name || 'Test').trim() || 'Test', email, utm_source: 'connection-test', funnel_source: 'organic' }, meta || {});
  if (r.http === 429) return { code: 429, body: { status: 'error', message: 'Too many tests in a row. Wait a few minutes and try again.' } };
  const steps = (r.body.steps || []).map(s => {
    const words = STEP_WORDS[s.name] || [s.name, s.name];
    if (s.status === 'ok') return { name: s.name, status: 'ok', message: words[0] + (s.name === 'crm' ? ', tagged webinar-registered.' : '.') };
    if (s.status === 'skipped') return { name: s.name, status: 'off', message: s.name === 'crm' ? 'Not saved to your contacts, because nowhere to keep contacts is connected.' : `Not signed up on a webinar platform through us: ${s.message}.` };
    return { name: s.name, status: 'fail', message: `${words[1]}: ${s.message}.` };
  });
  const order = ['sheet', 'crm', 'platform'];
  steps.sort((a, z) => order.indexOf(a.name) - order.indexOf(z.name));
  const failed = steps.some(s => s.status === 'fail');
  return { code: 200, body: {
    status: 'ok', ok: Boolean(r.body.ok) && !failed, steps, join_url: r.body.join_url || '',
    message: failed ? 'Part of the path is broken. Fix the line marked below, then send another.' : `It went through. Now check ${email} for the confirmation email. This counts as one sign-up on your Results page.`,
  } };
}

module.exports = { getConnections, postConnectionsTest, postTestSignup, IDS, safeAddress };
