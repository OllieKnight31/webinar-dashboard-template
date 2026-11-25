// Storage and settings.
//
// Everything this app remembers lives in ONE place: the Redis database attached to the Vercel
// project (Upstash; Vercel injects KV_REST_API_URL + KV_REST_API_TOKEN when it is connected).
// Off Vercel (local preview, tests) the same data goes to files under .data/ instead.
//
//   settings   what the owner enters on Setup / Settings (keys, choices, targets), one
//              encrypted blob. Values are keyed by the env var they replace and win over it.
//   documents  larger encrypted JSON: `intake` (answers + design), `build` (the build board),
//              `auth` (the password hash), `golive` (the launch checklist)
//   rate limit small counters for the public routes
//   data tabs  api/_lib/db.js builds on kv() / file() below
//
// One env var protects all of it: APP_SECRET (scripts/configure.js generates it). It is the
// encryption key for everything above and the signing key for the sign-in cookie.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Validators ──────────────────────────────────────────────────────────────
// Each throws a short sentence a person can act on.
const oneOf = (...allowed) => (v) => { const x = v.toLowerCase(); if (!allowed.includes(x)) throw new Error(`must be one of: ${allowed.join(', ')}`); return x; };
const wholeNumber = (min, max) => (v) => { if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`must be a whole number from ${min} to ${max}`); return String(Number(v)); };
const token = (what, min) => (v) => { if (/\s/.test(v) || v.length < min) throw new Error(`does not look like ${what}. It is one long string with no spaces. Check you copied all of it.`); return v; };
function jsonList(v) {
  let j; try { j = JSON.parse(v); } catch { throw new Error('could not be read'); }
  if (!Array.isArray(j)) throw new Error('must be a list');
  return JSON.stringify([...new Set(j.map(x => String(x).trim()).filter(Boolean))].slice(0, 200));
}
function httpUrl(v) {
  let u; try { u = new URL(v); } catch { throw new Error('must be a full web address starting with https://'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('must start with https://');
  return u.toString();
}
function originList(v) {
  return [...new Set(v.split(',').map(s => s.trim()).filter(Boolean).map((raw) => {
    try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin.toLowerCase(); }
    catch { throw new Error(`has an entry that is not a web address ("${raw}")`); }
  }))].join(',');
}
function metaAccount(v) {
  const m = /act[=_](\d{5,20})/i.exec(v) || /^(\d{5,20})$/.exec(v);
  if (!m) throw new Error('should be the ad account number, for example 1234567890');
  return `act_${m[1]}`;
}
function stripeKey(v) {
  if (/^pk_/.test(v)) throw new Error('is a publishable key (it starts pk_), which cannot read payments. Use the restricted key that starts rk_');
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(v)) throw new Error('should start with rk_live_');
  return v;
}
function ghlLocation(v) { const m = v.match(/location\/([\w-]{6,})/); const id = m ? m[1] : v; if (!/^[\w-]{6,}$/.test(id)) throw new Error('should be the code from the address bar'); return id; }
function timezone(v) { try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw new Error('is not a timezone we know. Use the Region/City form, for example Europe/London'); } return v; }
function alertsUrl(v) {
  if (!/^https:\/\/(hooks\.slack\.com\/|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)/.test(v)) throw new Error('must be a Slack or Discord incoming webhook address');
  return v;
}
// {"show_up_rate": 0.4}: targets as decimals, only for the rates the Results page grades.
const TARGET_KEYS = ['registration_rate', 'show_up_rate', 'stay_to_pitch_rate', 'booking_rate', 'call_show_rate', 'close_rate'];
function targets(v) {
  let j; try { j = JSON.parse(v); } catch { throw new Error('could not be read'); }
  const out = {};
  for (const [k, raw] of Object.entries(j && typeof j === 'object' ? j : {})) {
    if (!TARGET_KEYS.includes(k) || raw === '' || raw === null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('targets must be between 0% and 100%');
    out[k] = n;
  }
  return JSON.stringify(out);
}

// Every setting. `secret` values are never sent back to the browser, only a masked tail.
const FIELDS = [
  { key: 'BRAND_NAME', label: 'Business name' },
  { key: 'TIMEZONE', label: 'Timezone', clean: timezone },
  { key: 'CURRENCY_SYMBOL', label: 'Currency symbol', clean: (v) => { if (v.length > 4) throw new Error('must be 4 characters or fewer'); return v; } },

  { key: 'WEBINAR_PROVIDER', label: 'Webinar platform' },                 // validated against the adapter registry on save
  { key: 'WEBINARJAM_PRODUCT', label: 'WebinarJam or EverWebinar', clean: oneOf('webinarjam', 'everwebinar') },
  { key: 'WEBINARJAM_API_KEY', label: 'WebinarJam key', secret: true, clean: token('a WebinarJam key', 32) },
  { key: 'EWEBINAR_API_KEY', label: 'eWebinar key', secret: true, clean: token('an eWebinar key', 16) },
  { key: 'AEVENT_TOKEN', label: 'aEvent token', secret: true, clean: token('an aEvent token', 20) },
  { key: 'WEBINAR_API_KEY', label: 'Webinar platform key', secret: true, clean: token('a key', 8) },
  { key: 'WEBINAR_IDS', label: 'Which webinars count', clean: jsonList },
  { key: 'WEBINAR_PITCH_MINUTE', label: 'Minute the offer starts', clean: wholeNumber(0, 600) },
  { key: 'WEBINAR_PITCH_PERCENT', label: 'Percent of the webinar where the offer starts', clean: wholeNumber(0, 100) },
  { key: 'WEBINAR_CONFIRMATION_URL', label: 'Confirmation page address', clean: httpUrl },
  { key: 'WEBINAR_ALLOWED_ORIGINS', label: 'Sites allowed to send sign-ups', clean: originList },

  { key: 'ADS_PROVIDER', label: 'Ads', clean: oneOf('none', 'meta') },
  { key: 'META_ACCESS_TOKEN', label: 'Meta key', secret: true, clean: token('a Meta key', 40) },
  { key: 'META_AD_ACCOUNT_ID', label: 'Ad account number', clean: metaAccount },
  { key: 'META_CAMPAIGN_FILTER', label: 'Only count campaigns whose name contains' },

  { key: 'CRM_PROVIDER', label: 'CRM', clean: oneOf('none', 'ghl', 'close') },
  { key: 'GHL_API_KEY', label: 'GoHighLevel key', secret: true, clean: token('a GoHighLevel key', 10) },
  { key: 'GHL_LOCATION_ID', label: 'GoHighLevel location', clean: ghlLocation },
  { key: 'GHL_PIPELINE_ID', label: 'Pipeline for new sign-ups', clean: (v) => { if (!/^[\w-]{6,}$/.test(v)) throw new Error('was not recognised. Pick it from the list'); return v; } },
  { key: 'CLOSE_API_KEY', label: 'Close key', secret: true, clean: (v) => { if (!/^api_[\w.]{10,}$/.test(v)) throw new Error('should start with api_'); return v; } },

  { key: 'CALENDLY_TOKEN', label: 'Calendly key', secret: true, clean: token('a Calendly key', 40) },
  { key: 'CALENDLY_BOOKED_TYPES', label: 'Which calendar events are sales calls', clean: jsonList },
  { key: 'PAYMENTS_PROVIDER', label: 'Payment tool', clean: oneOf('none', 'stripe', 'whop', 'commas', 'paypal', 'ghl', 'kajabi', 'lemonsqueezy', 'paddle') },
  { key: 'STRIPE_SECRET_KEY', label: 'Stripe key', secret: true, clean: stripeKey },
  { key: 'WHOP_API_KEY', label: 'Whop key', secret: true, clean: token('a Whop key', 16) },
  { key: 'COMMAS_API_KEY', label: 'Commas key', secret: true, clean: token('a Commas key', 12) },
  { key: 'PAYPAL_CLIENT_ID', label: 'PayPal Client ID', clean: token('a PayPal Client ID', 20) },
  { key: 'PAYPAL_SECRET', label: 'PayPal Secret', secret: true, clean: token('a PayPal Secret', 20) },
  { key: 'KAJABI_CLIENT_ID', label: 'Kajabi Client ID', clean: token('a Kajabi Client ID', 8) },
  { key: 'KAJABI_SECRET', label: 'Kajabi Client secret', secret: true, clean: token('a Kajabi Client secret', 12) },
  { key: 'LEMONSQUEEZY_API_KEY', label: 'Lemon Squeezy key', secret: true, clean: token('a Lemon Squeezy key', 20) },
  { key: 'PADDLE_API_KEY', label: 'Paddle key', secret: true, clean: token('a Paddle key', 20) },

  { key: 'EVENT_INGEST_SECRET', label: 'Secret for tools that send us updates', secret: true, clean: (v) => { if (!/^[\w.-]{16,200}$/.test(v)) throw new Error('must be at least 16 letters and numbers'); return v; } },
  { key: 'ALERTS_WEBHOOK', label: 'Where to send alerts', secret: true, clean: alertsUrl },
  { key: 'TARGETS_JSON', label: 'Targets', clean: targets },
  { key: 'SYNC_LOOKBACK_DAYS', label: 'How far back to read (days)', clean: wholeNumber(1, 730) },
];
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));
const MAX_VALUE_LENGTH = 20000;

// ── Secret + encryption ─────────────────────────────────────────────────────
const secretConfigured = () => Boolean(process.env.APP_SECRET);
let keyFor = '', key = null;
function cryptoKey() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET is not set');
  if (keyFor !== secret) { key = crypto.scryptSync(secret, 'webinar-system-v1', 32); keyFor = secret; }
  return key;
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}
function decrypt(blob) {
  const [version, iv, tag, body] = String(blob).split(':');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('unrecognised saved data');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  try { return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')); }
  catch { throw new Error('Saved data could not be read: APP_SECRET has changed since it was saved.'); }
}

// ── Backends ────────────────────────────────────────────────────────────────
const PREFIX = process.env.STORE_PREFIX || 'webinar-system';
const dataDir = () => path.join(process.cwd(), '.data');

function kvCreds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && tok ? { url, token: tok } : null;
}
/** 'kv' with Redis attached · 'file' off Vercel · 'none' on Vercel with nothing attached. */
function backend() { return kvCreds() ? 'kv' : (!process.env.VERCEL ? 'file' : 'none'); }

/** One Redis command, or several as a pipeline (an array of commands → an array of results). */
async function kv(command) {
  const { url, token: tok } = kvCreds();
  const many = Array.isArray(command[0]);
  const resp = await fetch(many ? `${url.replace(/\/+$/, '')}/pipeline` : url, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(`storage error: ${data.error || resp.status}`);
  if (!many) return data.result;
  const bad = data.find(d => d && d.error);
  if (bad) throw new Error(`storage error: ${bad.error}`);
  return data.map(d => d.result);
}
const k = (name) => `${PREFIX}:${name}`;

function fileRead(name) { try { return fs.readFileSync(path.join(dataDir(), name), 'utf8').trim() || null; } catch { return null; } }
function fileWrite(name, text) { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(path.join(dataDir(), name), text, { mode: 0o600 }); }

async function readBlob(name) {
  const b = backend();
  if (b === 'kv') return kv(['GET', k(name)]);
  return b === 'file' ? fileRead(`${name}.json`) : null;
}
async function writeBlob(name, blob) {
  const b = backend();
  if (b === 'kv') return kv(['SET', k(name), blob]);
  if (b === 'file') return fileWrite(`${name}.json`, blob);
  throw new Error('No storage is connected');
}

// ── Documents ───────────────────────────────────────────────────────────────
const DOC_NAMES = ['intake', 'build', 'auth', 'golive', 'answers', 'files', 'health', 'probe'];
async function loadDoc(name) {
  if (!DOC_NAMES.includes(name)) throw new Error(`unknown document: ${name}`);
  if (!secretConfigured()) return null;
  const blob = await readBlob(`doc-${name}`);
  return blob ? decrypt(blob) : null;
}
async function saveDoc(name, value) {
  if (!DOC_NAMES.includes(name)) throw new Error(`unknown document: ${name}`);
  await writeBlob(`doc-${name}`, encrypt(value));
  return value;
}

// ── Rate limit (fixed window per key) ───────────────────────────────────────
const memoryHits = new Map();
async function rateLimit(name, limit, windowSeconds) {
  try {
    if (backend() === 'kv') {
      const [n] = await kv([['INCR', k(`rl:${name}`)], ['EXPIRE', k(`rl:${name}`), String(windowSeconds), 'NX']]);
      return Number(n) <= limit;
    }
    const now = Date.now(), hit = memoryHits.get(name);
    if (!hit || now - hit.at > windowSeconds * 1000) { memoryHits.set(name, { at: now, n: 1 }); return true; }
    hit.n += 1;
    return hit.n <= limit;
  } catch (e) {
    console.error('[store] rate limit failed, letting the request through:', e.message);
    return true;
  }
}
const resetRateLimits = () => memoryHits.clear();

// ── Settings ────────────────────────────────────────────────────────────────
const CACHE_MS = 30000;
let cache = null;
async function loadSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.values;
  let values = {};
  if (secretConfigured() && backend() !== 'none') { const blob = await readBlob('settings'); if (blob) values = decrypt(blob); }
  cache = { values, at: Date.now() };
  return values;
}
/** values {KEY: 'new'} (blank = leave as is) · clear ['KEY'] (forget it). Throws with .fields = {KEY: sentence}. */
async function saveSettings({ values = {}, clear = [] }) {
  const errors = {};
  const next = { ...(await loadSettings({ fresh: true })) };
  for (const key of clear) if (FIELD_BY_KEY[key]) delete next[key];
  for (const [key, raw] of Object.entries(values)) {
    const field = FIELD_BY_KEY[key];
    if (!field || typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    if (value.length > MAX_VALUE_LENGTH) { errors[key] = `${field.label} is too long`; continue; }
    try {
      if (key === 'WEBINAR_PROVIDER') {
        const known = ['none', ...Object.keys(require('./sync/webinar').ADAPTERS)];
        if (!known.includes(value.toLowerCase())) throw new Error(`must be one of: ${known.join(', ')}`);
        next[key] = value.toLowerCase();
      } else next[key] = field.clean ? field.clean(value) : value;
    } catch (e) { errors[key] = `${field.label} ${e.message}`; }
  }
  if (Object.keys(errors).length) { const err = new Error('Some answers need fixing'); err.fields = errors; throw err; }
  await writeBlob('settings', encrypt(next));
  cache = { values: next, at: Date.now() };
  return next;
}
const forgetCache = () => { cache = null; };

const maskTail = (v) => (String(v).length > 8 ? `••••${String(v).slice(-4)}` : '••••');
/** What the browser may see: plain values in full, secrets as "saved, ends 1234". */
function describe(saved) {
  const out = {};
  for (const f of FIELDS) {
    const value = saved[f.key] || process.env[f.key] || '';
    out[f.key] = f.secret ? { secret: true, saved: Boolean(value), hint: value ? maskTail(value) : '' } : { value };
  }
  return out;
}

module.exports = {
  FIELDS, FIELD_BY_KEY, TARGET_KEYS, secretConfigured, backend, kv, k, fileRead, fileWrite, dataDir,
  encrypt, decrypt, loadSettings, saveSettings, describe, forgetCache, loadDoc, saveDoc, rateLimit, resetRateLimits,
};
