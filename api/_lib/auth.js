// The sign-in. It is OPTIONAL: with no password settings the app is open to anyone who has
// the address, and every page and owner route works without signing in.
//
// Three modes, chosen by environment variables (checked on every request):
//
//   open       neither ACCESS_PASSWORD nor SETUP_CODE is set. No sign-in screen, no password.
//   password   ACCESS_PASSWORD is set. One shared password, typed on the sign-in screen. To
//              change it, change the env var and redeploy (every device is signed out).
//   setup      SETUP_CODE is set (and ACCESS_PASSWORD is not). The owner chooses their own
//              password on the first visit, as described below, and can change it on Settings.
//
// Setup mode in detail:
//   First visit   nobody has a password yet. The owner types the SETUP CODE (printed once by
//                 scripts/configure.js, held in the SETUP_CODE env var) and chooses a password.
//                 The code only ever works while no password exists.
//   After that    one login page. A correct password sets a signed cookie that lasts 30 days.
//   Scripts       the skill's build scripts send `Authorization: Bearer <BUILD_KEY>` instead;
//                 that key opens the intake and build board routes only.
//
// The password is stored as a salted scrypt hash in the `auth` document (encrypted like
// everything else). The cookie is `<expiry>.<version>.<signature>`, signed with APP_SECRET;
// changing the password raises the version, which signs every other device out.

const crypto = require('crypto');
const { config } = require('./config');
const store = require('./settings-store');

const COOKIE = 'ws_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

const hash = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('base64');
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8'), B = Buffer.from(String(b || ''), 'utf8');
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}
const sign = (text) => crypto.createHmac('sha256', process.env.APP_SECRET || '').update(text).digest('base64url');

/** 'open' | 'password' | 'setup' */
function mode() {
  if (process.env.ACCESS_PASSWORD) return 'password';
  if (config.setup_code) return 'setup';
  return 'open';
}
const loginRequired = () => mode() !== 'open';
// the cookie version in password mode: changes whenever the password does, never reveals it
const envVersion = () => 'p' + crypto.createHmac('sha256', process.env.APP_SECRET || '').update(`pw:${process.env.ACCESS_PASSWORD || ''}`).digest('base64url').slice(0, 16);

async function account() { return (await store.loadDoc('auth')) || null; }
const hasPassword = async () => Boolean(((await account()) || {}).hash);

function cookieOf(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(String((req.headers && req.headers.cookie) || ''));
  return m ? decodeURIComponent(m[1]) : '';
}
function sessionCookie(version, secure) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const body = `${exp}.${version}`;
  return `${COOKIE}=${body}.${sign(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Is this request signed in? */
async function signedIn(req) {
  if (mode() === 'open') return true;
  if (!store.secretConfigured()) return false;
  const [exp, version, sig] = cookieOf(req).split('.');
  if (!exp || !sig || !safeEqual(sig, sign(`${exp}.${version}`)) || Number(exp) < Date.now()) return false;
  if (mode() === 'password') return safeEqual(version, envVersion());
  const acc = await account();
  return Boolean(acc && acc.hash && String(acc.version) === String(version));
}

/** Does this request carry the build key? */
function hasBuildKey(req) {
  return Boolean(config.build_key) && safeEqual((req.headers && req.headers.authorization) || '', `Bearer ${config.build_key}`);
}

const fail = (code, message, extra) => ({ code, body: { ok: false, status: 'error', message, ...(extra || {}) } });
const NOT_READY = () => fail(503, 'This site is not finished being set up: APP_SECRET is missing. Run scripts/configure.js and push the settings.', { reason: 'no_secret' });
const NO_STORAGE = () => fail(503, 'Nowhere to save yet. In Vercel open this project, then Storage, add Upstash Redis, connect it and redeploy.', { reason: 'no_storage' });

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Choose a password of at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'That password is too long.';
  return '';
}

async function save(password, previous) {
  const salt = crypto.randomBytes(16).toString('base64');
  const acc = { hash: hash(password, salt), salt, version: ((previous && previous.version) || 0) + 1, updated_at: new Date().toISOString() };
  await store.saveDoc('auth', acc);
  return acc;
}

/** First visit: the setup code plus a new password. → { code, body, cookie? } */
async function createPassword({ code, password } = {}, secure) {
  if (mode() !== 'setup') return fail(409, mode() === 'open' ? 'This site has no sign-in, so there is no password to choose.' : 'This site uses a fixed password. Sign in with it.');
  if (!store.secretConfigured()) return NOT_READY();
  if (store.backend() === 'none') return NO_STORAGE();
  if (await hasPassword()) return fail(409, 'A password has already been chosen. Sign in with it.');
  if (!config.setup_code) return fail(503, 'No setup code has been set for this site. Run scripts/configure.js again and push the settings.');
  if (!safeEqual(String(code || '').trim(), config.setup_code)) return fail(401, 'That setup code is not right. It was printed when the site was set up. Check it and try again.');
  const bad = checkPassword(password);
  if (bad) return fail(400, bad);
  const acc = await save(password, null);
  return { code: 200, body: { ok: true, status: 'ok' }, cookie: sessionCookie(acc.version, secure) };
}

async function login({ password } = {}, secure) {
  if (mode() === 'open') return { code: 200, body: { ok: true, status: 'ok' } };
  if (!store.secretConfigured()) return NOT_READY();
  if (mode() === 'password') {
    if (!safeEqual(String(password || ''), process.env.ACCESS_PASSWORD)) return fail(401, 'That password is not right. Try again.');
    return { code: 200, body: { ok: true, status: 'ok' }, cookie: sessionCookie(envVersion(), secure) };
  }
  const acc = await account();
  if (!acc || !acc.hash) return fail(409, 'No password has been chosen yet.', { needs_setup: true });
  if (!safeEqual(hash(password || '', acc.salt), acc.hash)) return fail(401, 'That password is not right. Try again.');
  return { code: 200, body: { ok: true, status: 'ok' }, cookie: sessionCookie(acc.version, secure) };
}

async function changePassword({ current, password } = {}, secure) {
  if (mode() === 'open') return fail(409, 'This site has no sign-in. To add one, set ACCESS_PASSWORD in your hosting settings and redeploy.');
  if (mode() === 'password') return fail(409, 'This password is set by ACCESS_PASSWORD in your hosting settings. Change it there and redeploy.');
  const acc = await account();
  if (!acc || !safeEqual(hash(current || '', acc.salt), acc.hash)) return fail(401, 'Your current password is not right.');
  const bad = checkPassword(password);
  if (bad) return fail(400, bad);
  const next = await save(password, acc);
  return { code: 200, body: { ok: true, status: 'ok', message: 'Password changed. Other devices have been signed out.' }, cookie: sessionCookie(next.version, secure) };
}

/** What the sign-in screen needs to know. Never says anything secret. */
async function sessionInfo(req) {
  const ready = store.secretConfigured();
  const storage = store.backend();
  const m = mode();
  return {
    status: 'ok', ready, storage, mode: m, login_required: m !== 'open',
    needs_setup: ready && m === 'setup' ? !(await hasPassword()) : false,
    signed_in: m === 'open' ? true : (ready ? await signedIn(req) : false),
  };
}

module.exports = { COOKIE, mode, loginRequired, signedIn, hasBuildKey, createPassword, login, changePassword, sessionInfo, clearCookie, MIN_PASSWORD };
