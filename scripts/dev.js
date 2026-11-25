// Local preview: serves public/ with the vercel.json rewrites and routes /api to the same
// handler Vercel runs. No Vercel account, no database: what you save goes to .data/ (encrypted,
// gitignored).
//
//   npm run dev                    → http://localhost:3210
//   PORT=4000 npm run dev
//   npm run dev -- --no-login      → ignore ACCESS_PASSWORD / SETUP_CODE for this preview, so
//                                    there is no sign-in screen
//
// Reads client.env (written by scripts/configure.js). Without one it uses throwaway secrets.
// With no ACCESS_PASSWORD or SETUP_CODE there is no sign-in at all. The Results page has its own sample
// data ("See it with sample data"), so there is something to look at before a tool is connected.

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
for (const [k, v] of Object.entries(require('./lib/env-file').read())) if (process.env[k] === undefined) process.env[k] = v;
process.env.APP_SECRET = process.env.APP_SECRET || 'preview-secret-not-for-production';
process.env.BUILD_KEY = process.env.BUILD_KEY || 'preview-build-key';

const PORT = Number(process.env.PORT) || 3210;
const NO_LOGIN = process.argv.includes('--no-login');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function main() {
  const handler = require(path.join(root, 'api', 'index.js'));
  const { rewrites } = require(path.join(root, 'vercel.json'));

  // --no-login: switch the sign-in off for this preview only
  if (NO_LOGIN) { delete process.env.ACCESS_PASSWORD; delete process.env.SETUP_CODE; require(path.join(root, 'api', '_lib', 'config.js')).applySettings({}); }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname === '/api' || url.pathname === '/api/') {
      req.query = Object.fromEntries(url.searchParams);
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
      return Promise.resolve(handler(req, res)).catch((e) => {
        console.error('[dev] /api threw:', e);
        if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ status: 'error', message: String((e && e.message) || e) })); }
      });
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end('Bad request'); }
    const rewrite = rewrites.find(r => r.source === pathname);
    const rel = rewrite ? rewrite.destination : (pathname.endsWith('/') ? `${pathname}index.html` : pathname);
    let file = path.join(pub, path.normalize(rel));
    if (file !== pub && !file.startsWith(pub + path.sep)) { res.statusCode = 403; return res.end(); }
    if (!path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Not found'); }
      res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(data);
    });
  });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Run PORT=<another> npm run dev.` : `Preview failed to start: ${e.message}`); process.exit(1); });
  server.listen(PORT, () => {
    const at = `http://localhost:${PORT}`;
    console.log(`Setup      → ${at}/`);
    console.log(`Results    → ${at}/results   (add ?demo=1 for sample data)`);
    console.log(`Settings   → ${at}/settings`);
    const signIn = process.env.ACCESS_PASSWORD ? 'on (ACCESS_PASSWORD)' : process.env.SETUP_CODE ? `on: first visit asks for the setup code in client.env` : 'off (no password set, everything is open)';
    console.log(`Sign-in    → ${signIn}`);
    console.log(`Build key  → ${process.env.BUILD_KEY === 'preview-build-key' ? 'preview-build-key' : 'see BUILD_KEY in client.env'}`);
    console.log('Saved to   → .data/ in this folder (delete it to start again)');
  });
}
main().catch((e) => { console.error('Preview failed to start:', e); process.exit(1); });
