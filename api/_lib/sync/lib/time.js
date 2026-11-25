// Webinar System sync — time helpers. "Local day" means config.brand.timezone, read at call
// time (the owner can change it on /settings without a redeploy).

'use strict';

const { config } = require('../../config');

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    let f;
    const opts = { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' };
    // A mistyped zone must not take the whole sync down — fall back to UTC.
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }); }
    catch { f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }); }
    fmtCache.set(tz, f);
  }
  return fmtCache.get(tz);
}

function timezone() { return (config.brand && config.brand.timezone) || 'UTC'; }

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v); // epoch s or ms
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local wall-clock parts in the business's zone (or tz). */
function localParts(v, tz = timezone()) {
  const d = toDate(v);
  if (!d) return null;
  const out = {};
  for (const p of fmt(tz).formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** YYYY-MM-DD in the business's zone (or tz). */
function localDate(v, tz = timezone()) {
  const p = localParts(v, tz);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

/** ISO-8601 UTC, seconds precision, or '' when unparseable. */
function iso(v) {
  const d = toDate(v);
  return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
}

function nowIso() { return iso(new Date()); }

/** Hours between two instants, 1 decimal, '' when either is missing. */
function hoursBetween(a, b) {
  const da = toDate(a); const db = toDate(b);
  if (!da || !db) return '';
  return ((db.getTime() - da.getTime()) / 3600000).toFixed(1);
}

/** How far back every time-windowed pull reads (SYNC_LOOKBACK_DAYS on /settings). */
function lookbackDays() {
  const n = Number(config.command.sync.lookback_days);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 120;
}

/** Start of the sync window as a Date. */
function sinceDate(now = Date.now()) {
  return new Date(now - lookbackDays() * 86400000);
}

module.exports = { timezone, toDate, localParts, localDate, iso, nowIso, hoursBetween, lookbackDays, sinceDate };
