// Settings handlers: the tool connections, targets and addresses behind Setup step 4 and the
// Settings page. All of them need the signed-in owner (api/index.js checks).
//   GET  /api?action=settings        → what is saved (keys masked), what is connected, the addresses
//   POST /api?source=settings        → save { values, clear }
//   POST /api?source=settings_test   → "Check connection" for one tool { target }
//
// Every message here is read by someone who has never set up software: say what happened and
// what to do next, and never echo a key back.

const { config, applySettings, connections, DEFAULT_TARGETS } = require('../config');
const store = require('../settings-store');

const GHL_BASE = 'https://services.leadconnectorhq.com';
const CALENDLY_API = 'https://api.calendly.com';
// Calendly and GoHighLevel sit behind Cloudflare, which turns away the default Node user agent.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

function view(saved, baseUrl = '') {
  applySettings(saved);
  const fields = store.describe(saved);
  // what is in force for the things that have a default, so the page never shows an empty box that secretly means something
  const effective = {
    BRAND_NAME: config.brand.name, TIMEZONE: config.brand.timezone, CURRENCY_SYMBOL: config.brand.currency_symbol,
    PAYMENTS_PROVIDER: config.payments.provider, WEBINAR_PROVIDER: config.webinar.provider, WEBINARJAM_PRODUCT: config.webinar.webinarjam.product, ADS_PROVIDER: config.ads.provider,
    CRM_PROVIDER: config.crm.provider, SYNC_LOOKBACK_DAYS: String(config.command.sync.lookback_days),
  };
  for (const [key, value] of Object.entries(effective)) if (fields[key] && !fields[key].value) fields[key].value = String(value);
  return {
    status: 'ok', storage: store.backend(), connected: connections(), fields,
    targets: config.targets, default_targets: DEFAULT_TARGETS,
    // the two public addresses the funnel pages send to, and the one other tools send updates to
    addresses: { register: `${baseUrl}/api?source=register`, survey: `${baseUrl}/api?source=survey`, updates: `${baseUrl}/api?source=event`, sales: `${baseUrl}/api?source=event&type=sale` },
    // shown on Settings so the owner can hand it to whoever runs the build
    build_key: config.build_key,
  };
}

async function getSettings(baseUrl) { return view(await store.loadSettings({ fresh: true }), baseUrl); }

async function postSettings(body, baseUrl) {
  if (store.backend() === 'none') return { code: 503, body: { status: 'error', reason: 'no_storage', message: 'Nowhere to save yet. In Vercel open this project, then Storage, add Upstash Redis, connect it and redeploy.' } };
  try {
    const saved = await store.saveSettings({ values: body.values && typeof body.values === 'object' ? body.values : {}, clear: Array.isArray(body.clear) ? body.clear : [] });
    return { code: 200, body: view(saved, baseUrl) };
  } catch (e) {
    if (e.fields) return { code: 400, body: { status: 'invalid', message: e.message, fields: e.fields } };
    throw e;
  }
}

// ── Check connection ────────────────────────────────────────────────────────
// Each returns { ok, message, picks? } and never throws. `picks` = things to choose from.
const slow = (e) => (e && e.name === 'TimeoutError' ? 'it did not answer in time. Try again in a minute.' : 'we could not reach it. Check your internet connection and try again.');
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function testWebinar() {
  const adapter = require('../sync/webinar').adapter();
  if (!adapter) return { ok: false, message: 'Choose your webinar platform first.' };
  if (!adapter.connected()) return { ok: false, message: 'Paste your key first, then check again.' };
  try { return await adapter.test(); } catch (e) { return { ok: false, message: `That did not work: ${slow(e)}` }; }
}
async function testAds() {
  const adapter = require('../sync/ads').adapter();
  if (!adapter) return { ok: false, message: 'Choose where you run ads first.' };
  try { return await adapter.test(); } catch (e) { return { ok: false, message: `That did not work: ${slow(e)}` }; }
}

async function testCalendly() {
  const tok = config.calendly.token;
  if (!tok) return { ok: false, message: 'Paste your Calendly key first, then check again.' };
  const get = async (url) => {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json', 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15000) });
    return { status: resp.status, ok: resp.ok, data: await resp.json().catch(() => ({})) };
  };
  try {
    const me = await get(`${CALENDLY_API}/users/me`);
    if (me.status === 401 || me.status === 403) return { ok: false, message: 'That did not work: Calendly rejected the key. Create a new one and check you copied all of it.' };
    if (!me.ok) return { ok: false, message: `That did not work: Calendly answered with an error (${me.status}). Try again in a minute.` };
    const user = me.data.resource || {};
    const names = new Map();
    for (const query of [user.current_organization && `organization=${encodeURIComponent(user.current_organization)}`, user.uri && `user=${encodeURIComponent(user.uri)}`].filter(Boolean)) {
      const r = await get(`${CALENDLY_API}/event_types?${query}&count=100`);
      for (const t of (r.ok && r.data.collection) || []) { const n = String(t.name || '').replace(/\s+/g, ' ').trim(); if (n) names.set(n, Boolean(names.get(n)) || Boolean(t.active)); }
    }
    const picks = [...names].map(([name, active]) => ({ name, label: name, active })).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, message: `Connected. We found ${count(picks.length, 'kind')} of meeting. Tick the ones that are sales calls.`, picks };
  } catch (e) { return { ok: false, message: `That did not work: ${slow(e)}` }; }
}

async function testStripe() {
  const key = config.stripe.secret_key;
  if (!key) return { ok: false, message: 'Paste your Stripe key first, then check again.' };
  try {
    const resp = await fetch('https://api.stripe.com/v1/charges?limit=1', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (resp.status === 401) return { ok: false, message: 'That did not work: Stripe rejected the key. Check you copied all of it.' };
    if (resp.status === 403) return { ok: false, message: 'That did not work: the key is not allowed to read payments. Set Charges to "Read" on the key and try again.' };
    if (!resp.ok) return { ok: false, message: `That did not work: Stripe answered with an error (${resp.status}). Try again in a minute.` };
    return { ok: true, message: /_test_/.test(key) ? 'Connected, but this is a test key, so only test payments will show.' : 'Connected. We can read your payments.' };
  } catch (e) { return { ok: false, message: `That did not work: ${slow(e)}` }; }
}

async function testGHL() {
  const { api_key, location_id } = config.crm.ghl;
  if (!api_key || !location_id) return { ok: false, message: 'Paste your key and your location first, then check again.' };
  try {
    const resp = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${encodeURIComponent(location_id)}`, {
      headers: { Authorization: `Bearer ${api_key}`, Version: '2021-07-28', Accept: 'application/json', 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401) return { ok: false, message: 'That did not work: GoHighLevel rejected the key. Check you copied all of it.' };
    if (resp.status === 403) return { ok: false, message: 'That did not work: the key is not allowed in. Check the boxes you ticked when creating it, and the location.' };
    if (!resp.ok) return { ok: false, message: `That did not work: GoHighLevel answered with an error (${resp.status}). Try again in a minute.` };
    const picks = (data.pipelines || []).map(p => ({ name: p.id, label: p.name, active: true }));
    return { ok: true, message: `Connected. We found ${count(picks.length, 'pipeline')}. New sign-ups are saved as contacts; pick a pipeline if you also want a card for each.`, picks };
  } catch (e) { return { ok: false, message: `That did not work: ${slow(e)}` }; }
}

async function testClose() {
  const key = config.crm.close.api_key;
  if (!key) return { ok: false, message: 'Paste your Close key first, then check again.' };
  try {
    const resp = await fetch('https://api.close.com/api/v1/me/', { headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401) return { ok: false, message: 'That did not work: Close rejected the key. Check you copied all of it.' };
    if (!resp.ok) return { ok: false, message: `That did not work: Close answered with an error (${resp.status}). Try again in a minute.` };
    const org = ((data.organizations || [])[0] || {}).name || '';
    return { ok: true, message: `Connected${org ? ` to ${org}` : ''}. New sign-ups will be saved as leads.` };
  } catch (e) { return { ok: false, message: `That did not work: ${slow(e)}` }; }
}

/** Whichever payment tool is chosen. Stripe has its own, more exact check above. */
async function testPayments() {
  const adapter = require('../sync/payments').adapter();
  if (!adapter) return { ok: false, message: 'Choose how you take payment first.' };
  if (adapter.id === 'stripe') return testStripe();
  try { return await adapter.test(); } catch (e) { return { ok: false, message: `That did not work: ${slow(e)}` }; }
}

const TESTS = { webinar: testWebinar, ads: testAds, calendar: testCalendly, payments: testPayments, ghl: testGHL, close: testClose };

async function postSettingsTest(body) {
  const target = body.target === 'crm' ? config.crm.provider : body.target;
  const run = TESTS[target];
  if (!run) return { code: 400, body: { status: 'error', ok: false, message: 'Choose a tool first.' } };
  applySettings(await store.loadSettings({ fresh: true }));
  return { code: 200, body: { status: 'ok', target: body.target, ...(await run()) } };
}

module.exports = { getSettings, postSettings, postSettingsTest, view, tests: TESTS };
