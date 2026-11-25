'use strict';
// Command Centre — shared helpers.
//
//   • calendar-day arithmetic in the business's timezone (Intl.DateTimeFormat, no library)
//   • tolerant parsing of sheet strings (ISO timestamps, Y/N, decimals, blanks)
//   • email / slug / stage-name normalisation
//   • metric() builder: applies the target catalogue and computes the status
//
// Everything here is pure. Nothing reads the sheet or the network.

const DAY_MS = 86400000;

// ── Dates (calendar days in a timezone) ─────────────────────────────────────

const fmtCache = new Map();
function fmt(tz, opts, key) {
  const k = `${tz}|${key}`;
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts }));
  return fmtCache.get(k);
}

/** 'YYYY-MM-DD' of instant `ms` in timezone `tz`. */
function dateIn(ms, tz) {
  if (ms == null || !Number.isFinite(ms)) return null;
  // en-CA renders numeric dates as YYYY-MM-DD.
  return fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'date').format(new Date(ms));
}

/** Hour (0-23) of instant `ms` in timezone `tz`. */
function hourIn(ms, tz) {
  const parts = fmt(tz, { hour: '2-digit', hourCycle: 'h23' }, 'hour').formatToParts(new Date(ms));
  const h = parts.find(p => p.type === 'hour');
  return h ? Number(h.value) % 24 : 0;
}

function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

function dateToUtc(d) {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
}

function addDays(d, n) { return new Date(dateToUtc(d) + n * DAY_MS).toISOString().slice(0, 10); }

/** Inclusive day count between two 'YYYY-MM-DD' strings. */
function daysInclusive(from, to) { return Math.round((dateToUtc(to) - dateToUtc(from)) / DAY_MS) + 1; }

/** 0 = Sunday … 6 = Saturday. */
function dow(d) { return new Date(dateToUtc(d)).getUTCDay(); }
function isWeekday(d) { const w = dow(d); return w >= 1 && w <= 5; }

function* eachDay(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

/** Whole-day difference between two date strings (b − a). */
function dayDiff(a, b) { return Math.round((dateToUtc(b) - dateToUtc(a)) / DAY_MS); }

/** Days in the calendar month that 'YYYY-MM-DD' falls in. */
function daysInMonth(d) {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function str(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s === 'undefined' || s === 'null' ? '' : s;
}

/** Number or null. Strips currency symbols, commas, %, whitespace. */
function num(v) {
  const s = str(v).replace(/[$£€,%\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Y/Yes/true/1 → true; anything else false. */
function bool(v) { return /^(y|yes|true|1)$/i.test(str(v)); }

/** Epoch ms or null. Accepts ISO timestamps and bare YYYY-MM-DD (UTC midnight). */
function ts(v) {
  const s = str(v);
  if (!s) return null;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Lower-cased, trimmed email or null when it does not look like one. */
function email(v) {
  let s = str(v).toLowerCase();
  if (s.startsWith('mailto:')) s = s.slice(7);
  s = s.replace(/^<|>$/g, '').trim();
  return s.includes('@') ? s : null;
}

/** First token, lower-case, alphanumerics only: "Sam Jones" → "sam", "sam.jones@x.com" → "sam". */
function slug(v) {
  const s = str(v).toLowerCase().split('@')[0].trim();
  const first = s.split(/[\s._\-—–]+/)[0] || '';
  return first.replace(/[^a-z0-9]/g, '');
}

/** Stage names: unify dash styles, collapse whitespace, lower-case. */
function normStage(s) {
  return str(s).toLowerCase().replace(/[–—]/g, '-').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
}

/** Collapse whitespace (calendar event names arrive with double spaces). */
function squash(s) { return str(s).replace(/\s+/g, ' ').trim(); }

/** "podcast-jane" → "Podcast Jane" — a readable label for an id nobody has named. */
function titleCase(s) {
  return str(s).replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
}

// ── Small maths ─────────────────────────────────────────────────────────────

function sum(xs) { let t = 0; for (const x of xs) t += Number(x) || 0; return t; }

function median(xs) {
  const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}

/** a/b as a decimal (3 dp) or null when b is 0/absent. */
function ratio(a, b, d = 3) {
  if (b == null || !(b > 0) || a == null) return null;
  return round(a / b, d);
}

function perDay(n, days, d = 2) { return days > 0 && n != null ? round(n / days, d) : null; }

function countBy(xs, fn) {
  const out = {};
  for (const x of xs) { const k = fn(x); if (k == null) continue; out[k] = (out[k] || 0) + 1; }
  return out;
}

function groupBy(xs, fn) {
  const out = {};
  for (const x of xs) { const k = fn(x); if (k == null) continue; (out[k] = out[k] || []).push(x); }
  return out;
}

function uniq(xs) { return [...new Set(xs.filter(x => x != null && x !== ''))]; }

/** Sort object entries by value desc and return [[k, v], …] (top n). */
function topEntries(obj, n = 20) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ── Metric builder ──────────────────────────────────────────────────────────

// Grading a count that should be zero (target 0, lower is better: leads never worked, disputes,
// unmatched payments). The ordinary value ÷ target ratio makes ANY non-zero
// count critical, which cries wolf over one stray item. So: 0 is ok, anything above 0 is a
// warning, and it is only critical once the count is more than this share of the population it
// is drawn from (`of` — e.g. more than 20% of open leads never worked). No population known → warn.
const ZERO_TARGET_CRIT_SHARE = 0.2;
function gradeZeroTarget(value, of) {
  if (value <= 0) return 'ok';
  return of > 0 && value / of > ZERO_TARGET_CRIT_SHARE ? 'crit' : 'warn';
}

const UNIT_DP = { pct: 3, money: 2, minutes: 1, hours: 1, count: 2 };

/**
 * Build one <metric>.
 *
 * @param {object} ctx    needs ctx.target(pipeline, key) → catalogue row | null and ctx.cfg.min_sample
 * @param {string} pipeline
 * @param {object} spec   { key, label?, value, prev?, unit?, source?, owner?, direction?, target?, n?, of?, note? }
 *   `of` is the population a should-be-zero count is drawn from (see gradeZeroTarget).
 *   `n` is the denominator of a rate. Below MIN_SAMPLE the status is `na`; when small it is
 *   appended to the note so the reader knows how thin the number is.
 *   Status: ratio = value ÷ target (inverted for `lower`); ok ≥ 1.0, warn ≥ 0.7, crit below,
 *   na when there is no value, no target, or too small a sample.
 */
function metric(ctx, pipeline, spec) {
  const t = ctx && typeof ctx.target === 'function' ? ctx.target(pipeline, spec.key) : null;
  const minSample = ctx && ctx.cfg && ctx.cfg.min_sample >= 0 ? ctx.cfg.min_sample : 5;
  const unit = spec.unit || (t && t.unit) || 'count';
  const dp = UNIT_DP[unit] == null ? 2 : UNIT_DP[unit];
  const target = spec.target !== undefined ? spec.target : (t ? t.target : null);
  const m = {
    key: spec.key,
    label: spec.label || (t && t.label) || spec.key,
    value: spec.value == null ? null : round(spec.value, dp),
    prev: spec.prev == null ? null : round(spec.prev, dp),
    target: target == null ? null : target,
    direction: spec.direction || (t && t.direction) || 'higher',
    unit,
    status: 'na',
    source: spec.source || (t && t.source) || 'derived',
    owner: spec.owner || (t && t.owner) || '',
    note: str(spec.note),
    n: spec.n == null ? null : spec.n,
  };

  const notes = [];
  if (m.note) notes.push(m.note);

  if (m.value == null) {
    m.status = 'na';
    if (!m.note) notes.push('no data yet');
  } else if (m.n != null && m.n < minSample) {
    m.status = 'na';
    notes.unshift(`n=${m.n}, below min sample ${minSample}`);
  } else if (m.target == null) {
    m.status = 'na';
    if (unit === 'pct' && m.n != null && m.n < 30) notes.push(`n=${m.n}`);
  } else if (m.direction === 'lower' && m.target === 0 && unit === 'count') {
    m.status = gradeZeroTarget(m.value, spec.of);
    if (m.value > 0 && spec.of > 0) notes.push(`${Math.round((m.value / spec.of) * 100)}% of ${spec.of}`);
  } else {
    let r;
    if (m.direction === 'lower') {
      if (m.target === 0) r = m.value <= 0 ? Infinity : 0;
      else r = m.value <= 0 ? Infinity : m.target / m.value;
    } else {
      r = m.target === 0 ? (m.value > 0 ? Infinity : 0) : m.value / m.target;
    }
    m.status = r >= 1 ? 'ok' : r >= 0.7 ? 'warn' : 'crit';
    if (unit === 'pct' && m.n != null && m.n < 30) notes.push(`n=${m.n}`);
  }
  // a per-day count target is either the team's or one person's — say which (load.js sets it)
  if (spec.target === undefined && t && t.basis && m.target != null) notes.push(t.basis);
  m.note = notes.join(' · ');
  return m;
}

/** Stage record. `branch` marks an outcome split (showed / no-show …) rather than a funnel step. */
function stage(key, label, count, extra = {}) {
  return { key, label, count: count == null ? null : count, prev: null, conv_from_prev: null, live: null, ...extra };
}

function table(key, title, columns, rows, note) {
  const t = { key, title, columns, rows: rows || [] };
  if (note) t.note = note;
  return t;
}

module.exports = {
  DAY_MS,
  dateIn, hourIn, isDateStr, addDays, daysInclusive, dow, isWeekday, eachDay, dayDiff, daysInMonth,
  str, num, bool, ts, email, slug, normStage, squash, titleCase,
  sum, median, round, ratio, perDay, countBy, groupBy, uniq, topEntries,
  metric, stage, table, gradeZeroTarget, ZERO_TARGET_CRIT_SHARE,
};
