// Vercel serverless entry: one function, routed by ?action= (GET) and ?source= (POST).
//
// Sign-in is optional (see _lib/auth.js). With no ACCESS_PASSWORD and no SETUP_CODE every
// "signed-in owner" route below is open to anyone with the address.
//
// Open to anyone
//   GET  /api?action=ping | health         → is the site up
//   GET  /api?action=session               → signed in? first visit? (never anything secret)
//   POST /api?source=setup_password        → first visit: { code, password }
//   POST /api?source=login                 → { password }
//   POST /api?source=logout
//   POST /api?source=register              → a sign-up from a landing page (see handlers/register.js)
//   POST /api?source=survey                → confirmation page survey answers
// Their own secret
//   POST /api?source=event                 → updates from other tools (Bearer event secret, or &key=)
//   GET  /api?action=cron | sync           → the hourly update (Bearer CRON_SECRET)
// Signed-in owner OR `Authorization: Bearer <BUILD_KEY>` (the skill's scripts)
//   GET  /api?action=intake                POST /api?source=intake
//   GET  /api?action=build_status          POST /api?source=build_status
//   GET  /api?action=answers               POST /api?source=answers      (the questionnaires)
//   GET  /api?action=file&id=…             → a document somebody uploaded
// Signed-in owner only
//   GET  /api?action=results               → the Results page
//   GET  /api?action=settings | golive     POST /api?source=settings | settings_test | golive
//   POST /api?source=sync_now              → "Refresh now"
//   POST /api?source=change_password
//   POST /api?source=upload | file_delete  → add or remove a document
//   GET  /api?action=connections           POST /api?source=connections_test | test_signup
//
// This is the ONLY file under api/ outside api/_lib/: Vercel turns every other api/*.js into
// its own function, and the free plan caps how many a project has.

const crypto = require('crypto');
const { config, applySettings } = require('./_lib/config');
const { loadSettings, rateLimit } = require('./_lib/settings-store');
const auth = require('./_lib/auth');
const db = require('./_lib/db');
const setup = require('./_lib/handlers/setup');
const settings = require('./_lib/handlers/settings');
const answers = require('./_lib/handlers/answers');
const health = require('./_lib/handlers/health');
const { handleRegister, handleSurvey, checkOrigin } = require('./_lib/handlers/register');
const { handleEvent, checkEventAuth } = require('./_lib/handlers/event');

const SYNC_PARTS = ['calendar', 'payments', 'webinar', 'ads'];
const PART_BUDGET_MS = 50000;          // one part gets the function's whole budget (maxDuration is 60 s)
const SELF_REQUEST_TIMEOUT_MS = 55000;
const PUBLIC_SOURCES = new Set(['register', 'survey']);
const BUILD_ROUTES = new Set(['intake', 'build_status', 'answers', 'file']);

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

async function readBody(req) {
  // Accessing req.body throws on Vercel when the payload is malformed JSON: degrade to {}.
  let parsed;
  try { parsed = req.body; } catch { return {}; }
  if (parsed && typeof parsed === 'object') return parsed;
  const from = (raw) => { try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); } };
  if (typeof parsed === 'string') return from(parsed);
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => resolve(raw ? from(raw) : {}));
    req.on('error', () => resolve({}));
  });
}

const hostOf = (req) => String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
const protoOf = (req) => String(req.headers['x-forwarded-proto'] || (process.env.VERCEL ? 'https' : 'http')).split(',')[0].trim();
const baseUrl = (req) => `${protoOf(req)}://${hostOf(req)}`;
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '').trim();
}
function bearerOk(authHeader, secret) {
  if (!secret) return false;
  const got = Buffer.from(String(authHeader || ''), 'utf8'), want = Buffer.from(`Bearer ${secret}`, 'utf8');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ── The update ("sync") ─────────────────────────────────────────────────────
function syncModule() {
  try { const mod = require('./_lib/sync/run'); return mod && typeof mod.runSync === 'function' ? mod : null; }
  catch (e) { console.error('[api] the update code failed to load:', e.message); return null; }
}
const failedPart = (part, message) => ({ part, rows: 0, ms: 0, status: 'error', message });

// One part as its own invocation of this same function, so each gets a full time budget.
async function syncViaSelf(req, part, runner) {
  try {
    const resp = await fetch(`https://${hostOf(req)}/api?action=sync&part=${part}&runner=${runner}`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(SELF_REQUEST_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null);
    const row = data && Array.isArray(data.parts) ? data.parts.find(p => p && p.part === part) : null;
    return row || failedPart(part, `the update did not answer (${resp.status})`);
  } catch (e) {
    return failedPart(part, e && e.name === 'TimeoutError' ? 'the update took too long' : 'the update could not be started');
  }
}

/** Run parts: fanned out one request each on Vercel, one after another locally. Never throws. */
async function runParts(req, parts, runner) {
  if (process.env.VERCEL && process.env.CRON_SECRET && parts.length > 1) {
    return Promise.all(parts.map(p => syncViaSelf(req, p, runner)));
  }
  const mod = syncModule();
  if (!mod) return parts.map(p => failedPart(p, 'the update code is not available'));
  const out = [];
  for (const part of parts) {
    try { out.push(...(((await mod.runSync([part], { runner, budgetMs: process.env.VERCEL ? PART_BUDGET_MS : 0 })) || {}).parts || [])); }
    catch (e) { out.push(failedPart(part, (e && e.message) || 'failed')); }
  }
  return out;
}

module.exports = async (req, res) => {
  setCORS(res);
  const { action, source } = req.query || {};
  if (req.method === 'OPTIONS' && !PUBLIC_SOURCES.has(source)) return res.status(200).end();
  const send = (out) => { if (out.cookie) res.setHeader('Set-Cookie', out.cookie); return res.status(out.code).json(out.body); };

  try {
    // Layer what the owner saved over the env config. A broken store must not take the public
    // routes down, so fall back to env only and carry on.
    try { applySettings(await loadSettings()); }
    catch (e) { console.error('[api] saved settings could not be read, using env only:', e.message); }

    // ── Open to anyone ──
    // The sign-up and survey routes. Any site may post unless "Sites allowed to send sign-ups"
    // is filled in on Settings; then a page on any other site is refused here (403), not just
    // by the browser.
    if (PUBLIC_SOURCES.has(source)) {
      const origin = checkOrigin(req.headers.origin);
      res.setHeader('Access-Control-Allow-Origin', origin.header);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') return res.status(origin.allowed ? 200 : 403).end();
      if (req.method !== 'POST') return res.status(405).json({ ok: false, status: 'error', message: 'Send this as a POST.' });
      if (!origin.allowed) return res.status(403).json({ ok: false, status: 'error', message: 'This page is not allowed to send sign-ups here.' });
      const r = await (source === 'register' ? handleRegister : handleSurvey)(await readBody(req), { ip: clientIp(req) });
      return res.status(r.http).json(r.body);
    }
    if (req.method === 'GET' && (!action || action === 'ping' || action === 'health')) {
      return res.status(200).json({ status: 'ok', service: 'Webinar System', storage: db.isConfigured() ? 'connected' : 'not connected' });
    }
    if (req.method === 'GET' && action === 'config') return res.status(200).json({ status: 'ok', brand: { name: config.brand.name } });
    if (req.method === 'GET' && action === 'session') return res.status(200).json(await auth.sessionInfo(req));
    if (req.method === 'POST' && (source === 'login' || source === 'setup_password')) {
      // a handful of tries per address every ten minutes blunts password guessing
      if (!(await rateLimit(`login:${clientIp(req)}`, 10, 600))) return res.status(429).json({ ok: false, status: 'error', message: 'Too many tries. Wait ten minutes and try again.' });
      const body = await readBody(req);
      return send(await (source === 'login' ? auth.login : auth.createPassword)(body, protoOf(req) === 'https'));
    }
    if (req.method === 'POST' && source === 'logout') { res.setHeader('Set-Cookie', auth.clearCookie()); return res.status(200).json({ ok: true, status: 'ok' }); }

    // ── Their own secret ──
    if (req.method === 'POST' && source === 'event') {
      // a tool that cannot send a header may put the secret on the address as &key=… instead
      const gate = checkEventAuth(req.headers.authorization || (req.query.key ? `Bearer ${req.query.key}` : ''));
      if (!gate.ok) return res.status(gate.http).json(gate.body);
      const r = await handleEvent(await readBody(req), { provider: req.query.provider, type: req.query.type });
      return res.status(r.http).json(r.body);
    }
    if (req.method === 'GET' && (action === 'cron' || action === 'sync')) {
      if (!bearerOk(req.headers.authorization, process.env.CRON_SECRET)) return res.status(401).json({ status: 'error', message: 'unauthorized' });
      if (action === 'cron' && (!config.command.sync.enabled || !db.isConfigured())) return res.status(200).json({ status: 'skipped' });
      const part = String(req.query.part || 'all').toLowerCase();
      if (part !== 'all' && !SYNC_PARTS.includes(part)) return res.status(400).json({ status: 'error', message: `part must be one of: ${SYNC_PARTS.join(', ')}, all` });
      const runner = action === 'cron' ? 'cron' : (req.query.runner || 'api');
      const parts = await runParts(req, part === 'all' ? SYNC_PARTS : [part], runner);
      return res.status(200).json({ status: parts.every(p => p.status !== 'error') ? 'ok' : 'error', parts });
    }

    // ── Everything below needs the owner, or (two routes) the build key ──
    const owner = await auth.signedIn(req);
    const route = req.method === 'GET' ? action : source;
    if (!owner && !(BUILD_ROUTES.has(route) && auth.hasBuildKey(req))) {
      return res.status(401).json({ status: 'unauthorized', message: 'Sign in first.' });
    }

    if (req.method === 'GET') {
      if (action === 'intake') return send(await setup.getIntake());
      if (action === 'build_status') return send(await setup.getBuildStatus());
      if (action === 'golive') return send(await setup.getGoLive());
      if (action === 'answers') return send(await answers.getAnswers());
      if (action === 'connections') { if (!owner) return res.status(401).json({ status: 'unauthorized', message: 'Sign in first.' }); return send(await health.getConnections()); }
      if (action === 'file') {
        const file = await answers.getFile(req.query.id);
        if (!file) return res.status(404).json({ status: 'error', message: 'That document is not here any more.' });
        // always a download, never opened in the page, whatever kind of file it is
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        return res.status(200).end(file.buffer);
      }
      if (action === 'settings') return res.status(200).json(await settings.getSettings(baseUrl(req)));
      if (action === 'results') return res.status(200).json(await require('./_lib/results').getResults(req.query));
      return res.status(404).json({ status: 'error', message: 'Not found.' });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (source === 'intake') return send(await setup.postIntake(body));
      if (source === 'build_status') return send(await setup.postBuildStatus(body));
      if (source === 'golive') return send(await setup.postGoLive(body));
      if (source === 'answers') return send(await answers.postAnswers(body));
      if (source === 'upload' || source === 'file_delete') {
        if (!owner) return res.status(401).json({ status: 'unauthorized', message: 'Sign in first.' });
        return send(await (source === 'upload' ? answers.postUpload : answers.postFileDelete)(body));
      }
      if (source === 'settings') return send(await settings.postSettings(body, baseUrl(req)));
      if (source === 'settings_test') return send(await settings.postSettingsTest(body));
      if (source === 'connections_test') return send(await health.postConnectionsTest(body));
      if (source === 'test_signup') return send(await health.postTestSignup(body, { ip: clientIp(req) }));
      if (source === 'change_password') return send(await auth.changePassword(body, protoOf(req) === 'https'));
      if (source === 'sync_now') {
        if (!db.isConfigured() || db.isMemory()) return res.status(200).json({ status: 'skipped', parts: [], message: db.isMemory() ? 'This is sample data, so there is nothing to refresh.' : 'Storage is not connected yet.' });
        const parts = await runParts(req, SYNC_PARTS, 'manual');
        return res.status(200).json({ status: parts.every(p => p.status !== 'error') ? 'ok' : 'error', parts });
      }
      return res.status(404).json({ status: 'error', message: 'Not found.' });
    }
    return res.status(405).json({ status: 'error', message: 'Not allowed.' });
  } catch (e) {
    console.error('[api] error:', e);
    return res.status(500).json({ status: 'error', message: 'Something went wrong on our side. Try again in a minute.' });
  }
};
