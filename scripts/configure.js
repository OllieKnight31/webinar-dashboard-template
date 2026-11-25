// One command that prepares this app for a business. Writes client.env and the schedule.
//
//   node scripts/configure.js --name "Acme Coaching" --tz Europe/London [--currency "£"] [--with-login]
//
// It creates the secrets the app needs and keeps them on later runs:
//   APP_SECRET    encrypts everything the owner saves and signs the sign-in cookie
//   BUILD_KEY     lets the skill's build scripts read the answers and update the build board
//   CRON_SECRET   lets Vercel's schedule run the hourly update
//   SETUP_CODE    only with --with-login: typed once by the owner on their first visit, to
//                 choose their own password. Without it (and without ACCESS_PASSWORD) the app
//                 has no sign-in at all. For one shared password instead, use
//                 --set ACCESS_PASSWORD=<your password>.
// Everything else (which tools, their keys, targets) is entered by the owner in the app.
// Safe to re-run: it merges into the existing client.env. `--set KEY=VALUE` (repeatable) puts
// any other setting from .env.example straight in.

const crypto = require('crypto');
const envFile = require('./lib/env-file');
const { setCrons } = require('./set-cron');
const { FIELD_BY_KEY } = require('../api/_lib/settings-store');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const next = { ...envFile.read() };
for (const [flag, key] of Object.entries({ name: 'BRAND_NAME', tz: 'TIMEZONE', currency: 'CURRENCY_SYMBOL' })) if (arg(flag) !== undefined) next[key] = arg(flag);
args.forEach((a, i) => {
  if (a !== '--set') return;
  const pair = args[i + 1] || '', eq = pair.indexOf('=');
  if (eq < 1) die(`--set needs KEY=VALUE (got "${pair}")`);
  if (pair.slice(eq + 1) === '') delete next[pair.slice(0, eq).trim()]; else next[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
});

// The same checks the app applies, so a typo fails here and not in production.
const errors = [];
for (const [key, value] of Object.entries(next)) {
  const f = FIELD_BY_KEY[key];
  if (!f || !f.clean || value === '') continue;
  try { next[key] = f.clean(String(value).trim()); } catch (e) { errors.push(`${key}: ${f.label} ${e.message}`); }
}
if (errors.length) die(`Fix these and run again:\n  ${errors.join('\n  ')}`);

const made = {};
const secret = (key, bytes, encoding = 'base64url') => { if (!next[key]) { next[key] = crypto.randomBytes(bytes).toString(encoding); made[key] = true; } };
secret('APP_SECRET', 32);
secret('BUILD_KEY', 24);
secret('CRON_SECRET', 24);
// short enough to read out or type from a message: 8 letters and digits, no look-alikes
if (args.includes('--with-login') && !next.SETUP_CODE) { const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; next.SETUP_CODE = Array.from(crypto.randomBytes(8), b => abc[b % abc.length]).join(''); made.SETUP_CODE = true; }

setCrons({ on: true });
envFile.write(next);

const line = (label, value) => console.log(`  ${label.padEnd(14)} ${value}`);
console.log(`\n✓ client.env written for ${next.BRAND_NAME || 'this business'}\n`);
line('Timezone', next.TIMEZONE || 'UTC');
if (next.ACCESS_PASSWORD) line('Sign-in', 'on: one shared password (ACCESS_PASSWORD in client.env)');
else if (next.SETUP_CODE) line('Setup code', `${next.SETUP_CODE}${made.SETUP_CODE ? '   (new)' : ''}   give this to the owner: they type it on their first visit to choose a password`);
else line('Sign-in', 'off: anyone with the address can open the app. Add --set ACCESS_PASSWORD=... to protect it');
line('Build key', made.BUILD_KEY ? 'created (BUILD_KEY in client.env): the build scripts send it as a Bearer token' : 'unchanged (see client.env)');
line('App secret', made.APP_SECRET ? 'created (APP_SECRET in client.env). Do not change it later: saved answers are encrypted with it' : 'unchanged');
console.log('\nNext: npm run dev  (preview)  then  vercel link && node scripts/push-env.js && vercel --prod');
console.log('      In Vercel: Storage, add Upstash Redis, connect it to this project, redeploy.');
