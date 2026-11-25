#!/usr/bin/env node
// Webinar System sync — runner.
//
//   API:  const { runSync, PARTS } = require('./_lib/sync/run');
//         await runSync(['calendar'], { runner: 'cron', budgetMs: 50000 })
//           → { ok, parts: [{ part, rows, ms, status, message }] }      never throws
//   CLI:  node api/_lib/sync/run.js all
//         node api/_lib/sync/run.js calendar,payments
//         node api/_lib/sync/run.js crm --memory        (nothing saved; prints row counts)
//         flags: --memory  --budget=<ms>  --runner=<name>  --env=<file>  (default: client.env)
//
// Parts and the tabs they own:
//   calendar  Calendly                → BOOKINGS
//   payments  the payment tool chosen → PAYMENTS (+ PRICE MAP for Stripe)
//   webinar   the webinar platform    → WEBINAR REGISTRANTS + WEBINAR SESSIONS
//   ads       the ad platform         → AD METRICS
//
// Status per part:
//   skipped  the source is not connected — nothing read, written or logged
//   ok       tabs written, one SYNC LOG row
//   error    nothing (or, if a write itself failed, not everything) written; one SYNC LOG row;
//            and one message for the whole run to the `alerts` channel
// A part that has not finished reading by its time budget stops before its first write, so a
// tab is never half-rewritten, and reports as an error that says what to change.

'use strict';

// CLI only: client.env has to be in process.env before config.js is first required (below).
// Values already in the environment win, so `SYNC_LOOKBACK_DAYS=30 node … all` works.
if (require.main === module) {
  const envFile = require('../../../scripts/lib/env-file');
  const flag = process.argv.find((a) => a.startsWith('--env='));
  const values = flag ? envFile.read(flag.slice('--env='.length)) : envFile.read();
  for (const [k, v] of Object.entries(values)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const { config, connections } = require('../config');
const db = require('../db');
const { alert: sendAlert } = require('../alerts');
const { nowIso, sinceDate, lookbackDays } = require('./lib/time');

const PARTS = ['calendar', 'payments', 'webinar', 'ads'];
const MODULES = {
  calendar: () => require('./calendly'),
  payments: () => require('./payments'),
  webinar: () => require('./webinar'),
  ads: () => require('./ads'),
};
// Which connection each part needs (config.connections()).
const NEEDS = { calendar: 'calendar', payments: 'payments', webinar: 'webinar', ads: 'ads' };
// Parts whose reading shrinks with SYNC_LOOKBACK_DAYS; crm / snapshot read every record.
const DEFAULT_BUDGET_MS = 50000;
const ALERT_COLOR = 0xE74C3C;

class BudgetExceeded extends Error {
  constructor(part, ms) {
    const secs = Math.round(ms / 1000);
    super(`Ran out of time (${secs} s) before anything was saved, so the numbers still show the last update. There is too much history to read in one go: lower "How far back to read" on the Settings page (now ${lookbackDays()} days).`);
    this.name = 'BudgetExceeded';
  }
}

function normaliseParts(parts) {
  const list = Array.isArray(parts) ? parts : String(parts || 'all').split(',');
  const flat = list.flatMap((p) => String(p || '').toLowerCase().split(',')).map((s) => s.trim()).filter(Boolean);
  if (flat.length === 0 || flat.includes('all')) return { parts: [...PARTS], unknown: [] };
  return { parts: PARTS.filter((p) => flat.includes(p)), unknown: [...new Set(flat.filter((p) => !MODULES[p]))] };
}

function trunc(s, n) {
  const str = String(s === undefined || s === null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/**
 * Run one part against its budget. The part calls ctx.checkBudget() between requests and
 * ctx.beginWrite() before its first write; both throw once the budget is spent. A request
 * that is itself slow cannot hold the run past the budget: the timer below gives up on the
 * part — unless it is already writing, in which case it is left to finish (a rewrite cut
 * short is the one outcome worse than a late one).
 */
async function runPart(part, runner, budgetMs) {
  const t0 = Date.now();
  const state = { writing: false, expired: false };
  const over = () => state.expired || (budgetMs > 0 && Date.now() - t0 > budgetMs);
  const ctx = {
    runner,
    since: sinceDate(t0),
    checkBudget() { if (!state.writing && over()) throw new BudgetExceeded(part, budgetMs); },
    beginWrite() { this.checkBudget(); state.writing = true; },
  };

  const work = Promise.resolve().then(() => MODULES[part]().run(ctx));
  if (!(budgetMs > 0)) return work;

  const TIMED_OUT = Symbol('timed out');
  let timer;
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), budgetMs); });
  try {
    const first = await Promise.race([work, clock]);
    if (first !== TIMED_OUT) return first;
    if (state.writing) return await work;
    state.expired = true;
    work.catch(() => {}); // it will stop at its next checkBudget(); nobody is waiting for it
    throw new BudgetExceeded(part, budgetMs);
  } finally {
    clearTimeout(timer);
  }
}

/** One post for the whole run. nothing is sent when no alerts address is saved. */
async function alert(failed) {
  await sendAlert(`${config.brand.name}: an update failed (${failed.map((r) => r.part).join(', ')})`,
    [...failed.map((r) => `${r.part}: ${trunc(r.message, 500)}`), 'The Results page keeps showing the last good numbers.']);
}

/**
 * Run sync parts in PARTS order.
 * @param {string[]|string} parts  part names, or ['all']
 * @param {{runner?: 'cron'|'api'|'manual', budgetMs?: number, log?: Function}} opts
 *   budgetMs — time each part may spend reading before it must have started writing
 *   (default 50 s, inside a 60 s function); 0 = no limit.
 * @returns {Promise<{ok: boolean, parts: Array<{part: string, rows: number, ms: number, status: 'ok'|'error'|'skipped', message: string}>}>}
 */
async function runSync(parts = ['all'], opts = {}) {
  const results = [];
  try {
    const runner = opts.runner || 'manual';
    const budgetMs = opts.budgetMs === undefined ? DEFAULT_BUDGET_MS : Math.max(0, Number(opts.budgetMs) || 0);
    const log = opts.log || ((...a) => console.log('[sync]', ...a));
    const { parts: list, unknown } = normaliseParts(parts);
    for (const part of unknown) {
      results.push({ part, rows: 0, ms: 0, status: 'error', message: `unknown part, valid: ${PARTS.join(', ')}, all` });
    }

    const connected = connections();
    const haveSheet = db.isConfigured();
    for (const part of list) {
      if (!connected[NEEDS[part]]) {
        results.push({ part, rows: 0, ms: 0, status: 'skipped', message: 'not connected' });
        continue;
      }
      if (!haveSheet) {
        // nowhere to write (and nowhere to log) — not an error the owner can be alerted out of
        results.push({ part, rows: 0, ms: 0, status: 'skipped', message: 'nowhere to save yet' });
        continue;
      }
      const t0 = Date.now();
      const res = { part, rows: 0, ms: 0, status: 'ok', message: '' };
      try {
        const out = await runPart(part, runner, budgetMs);
        res.rows = Number((out && out.rows) || 0);
        res.message = trunc((out && out.message) || '', 500);
      } catch (e) {
        res.status = 'error';
        res.message = trunc(e && e.message ? e.message : String(e), 500);
      }
      res.ms = Date.now() - t0;
      results.push(res);
      log(`${part.padEnd(9)} ${res.status.padEnd(7)} rows=${String(res.rows).padStart(6)} ${String(res.ms).padStart(6)} ms  ${res.message}`);
      try {
        await db.appendRows(db.TABS.SYNC_LOG, [[nowIso(), part, String(res.rows), res.status, String(res.ms), res.message, runner]]);
      } catch (e) {
        log(`SYNC LOG append failed for ${part}: ${e.message}`);
      }
    }

    const failed = results.filter((r) => r.status === 'error' && MODULES[r.part]);
    if (failed.length) await alert(failed);
  } catch (e) {
    // runSync never throws: whatever slipped through becomes a result the caller can show.
    results.push({ part: 'sync', rows: 0, ms: 0, status: 'error', message: trunc(e && e.message ? e.message : String(e), 500) });
  }
  return { ok: results.every((r) => r.status !== 'error'), parts: results };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
async function cli(argv) {
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)];
  }));
  const parts = argv.filter((a) => !a.startsWith('--'));

  // What the owner saved on Settings overrides client.env, exactly as in production.
  try {
    const saved = await require('..Settings-store').loadSettings();
    if (saved && Object.keys(saved).length) require('../config').applySettings(saved);
  } catch (e) {
    console.warn('[sync] saved settings not loaded:', e.message);
  }
  if (flags.memory) db.useMemory();

  const r = await runSync(parts.length ? parts : ['all'], {
    runner: flags.runner || 'manual',
    budgetMs: flags.budget === undefined ? 0 : Number(flags.budget), // a local run has no time limit
  });

  console.log('\npart      status    rows      ms  message');
  for (const p of r.parts) {
    console.log(`${p.part.padEnd(9)} ${p.status.padEnd(7)} ${String(p.rows).padStart(6)} ${String(p.ms).padStart(7)}  ${p.message}`);
  }
  if (flags.memory) {
    console.log('\nin memory (nothing was saved), data rows per tab');
    for (const [tab, rows] of Object.entries(db.memoryTabs() || {})) {
      console.log(`  ${tab.padEnd(18)} ${String(Math.max(0, rows.length - 1)).padStart(6)}`);
    }
  }
  console.log(`\n${r.ok ? 'OK' : 'FAILED'}`);
  return r.ok;
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((e) => { console.error('[sync] fatal:', e && e.stack ? e.stack : e); process.exit(1); });
}

module.exports = { runSync, PARTS, BudgetExceeded, normaliseParts };
