// The data store: named tabs of rows, kept in the Redis database attached to the project
// (or files under .data/ in the local preview). No spreadsheet, no service account.
//
// A tab is a header row plus rows of strings, in two parts:
//   base      what a sync REWRITES each run (the whole list from a tool), stored in chunks
//   appended  rows ADDED one at a time (a sign-up, a survey answer, a log line), in a capped list
// readTab() returns base then appended, as header-keyed objects. writeTab() replaces the base
// only, so a sign-up arriving while a sync rewrites its tab can never be lost.
//
// Contract: every cell is a string; timestamps are ISO-8601 UTC; yes / no is 'Y' / 'N';
// blank means "not known", never zero.
//
// Size: a chunk holds CHUNK rows (well under Redis' request limit) and every appended list is
// capped at its CAP, oldest rows dropped first. The syncs only read SYNC_LOOKBACK_DAYS back,
// so the base stays bounded too.
//
// In-memory mode (useMemory) swaps all of it for a plain object: the local preview's sample
// data and the tests run every code path with no storage and no network.

const store = require('./settings-store');

const TABS = {
  WEBINAR_REGISTRANTS: 'WEBINAR REGISTRANTS',   // base: the webinar platform · appended: sign-ups from your pages
  WEBINAR_SESSIONS: 'WEBINAR SESSIONS',         // base: one row per session
  WEBINAR_SURVEY: 'WEBINAR SURVEY',             // appended: confirmation page answers
  AD_METRICS: 'AD METRICS',                     // base: spend per ad per day
  BOOKINGS: 'BOOKINGS',                         // base: booked calls (Calendly)
  PAYMENTS: 'PAYMENTS',                         // base: payments (Stripe)
  PRICE_MAP: 'PRICE MAP',                       // appended: what each Stripe price is
  EVENTS: 'EVENTS',                             // appended: single steps sent by other tools
  SYNC_LOG: 'SYNC LOG',                         // appended: one line per sync
};

const HEADERS = {
  // Source says who wrote the row: sync (the platform) · relay (your landing page) · webhook
  WEBINAR_REGISTRANTS: [
    'Registrant ID', 'Provider', 'Webinar ID', 'Webinar Name', 'Session ID', 'Session At', 'Email', 'Name', 'Phone',
    'Registered At', 'Attended Live', 'Minutes Watched', 'Percent Watched', 'Stayed To Pitch', 'Watched Replay',
    'Purchased', 'Revenue', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Content', 'UTM Term', 'Join URL',
    'Funnel Source', 'Source', 'Synced At',
  ],
  WEBINAR_SESSIONS: ['Session Key', 'Provider', 'Webinar ID', 'Webinar Name', 'Session ID', 'Session At', 'Type', 'Registrants', 'Attendees', 'Synced At'],
  WEBINAR_SURVEY: ['Submitted At', 'Email', 'Name', 'Webinar ID', 'Question 1', 'Answer 1', 'Question 2', 'Answer 2', 'Question 3', 'Answer 3', 'Page URL'],
  AD_METRICS: [
    'Row Key', 'Provider', 'Date', 'Account ID', 'Campaign ID', 'Campaign', 'Ad Set ID', 'Ad Set', 'Ad ID', 'Ad',
    'Spend', 'Impressions', 'Link Clicks', 'Landing Page Views', 'Leads', 'Currency', 'Synced At',
  ],
  BOOKINGS: [
    'Invitee URI', 'Event URI', 'Event Type', 'Event Type UUID', 'Host', 'Host Email', 'Status', 'Created At',
    'Start At', 'End At', 'Cancelled At', 'Cancelled By', 'Canceler Type', 'Cancel Reason', 'Rescheduled',
    'Old Invitee URI', 'Calendly No Show', 'Email', 'Name', 'Phone', 'UTM Source', 'UTM Medium', 'UTM Campaign',
    'UTM Content', 'UTM Term', 'Setter', 'Lead Time Hours', 'Booking Type', 'Synced At',
  ],
  PAYMENTS: [
    'Object ID', 'Kind', 'Amount', 'Currency', 'Status', 'Created At', 'Email', 'Name', 'Description', 'Price ID',
    'Product', 'Tier', 'Payment Type', 'Decline Code', 'Receipt URL', 'Related ID', 'Excluded', 'Synced At',
  ],
  PRICE_MAP: ['Price ID', 'Product ID', 'Product Name', 'Amount', 'Recurring', 'Tier', 'Payment Type', 'Excluded', 'Notes'],
  EVENTS: [
    'Event ID', 'Type', 'Occurred At', 'Received At', 'Email', 'Name', 'Phone', 'Contact ID', 'Pipeline', 'Stage', 'Channel', 'Entry',
    'Paid Traffic', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Content', 'UTM Term', 'Offer', 'Amount', 'Currency', 'Product',
    'Host', 'Event Name', 'Setter', 'Ref', 'Source System', 'Raw',
  ],
  SYNC_LOG: ['Run At', 'Part', 'Rows', 'Status', 'Duration Ms', 'Message', 'Runner'],
};
// How many appended rows a tab keeps (oldest dropped first).
const CAP = { WEBINAR_REGISTRANTS: 50000, WEBINAR_SURVEY: 20000, EVENTS: 50000, PRICE_MAP: 2000, SYNC_LOG: 600 };
const DEFAULT_CAP = 20000;
const CHUNK = 400;

const keyOf = (tabName) => Object.keys(TABS).find(key => TABS[key] === tabName);
const headersFor = (tabName) => HEADERS[keyOf(tabName)] || null;
const slug = (tabName) => tabName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const cell = (v) => (v === null || v === undefined ? '' : String(v).trim());

// ── In-memory backend ───────────────────────────────────────────────────────
// MEM.tabs[tabName] = [headerRow, ...rows] (base and appended together).
const MEM = { on: false, tabs: {} };
function useMemory(tabs) { MEM.on = true; MEM.tabs = tabs || {}; return MEM.tabs; }
const memoryTabs = () => (MEM.on ? MEM.tabs : null);
/** Back to the real store (the tests use it to exercise Redis and the local folder). */
function leaveMemory() { MEM.on = false; MEM.tabs = {}; }
const isMemory = () => MEM.on;
/** Is there somewhere to keep data? (Always, except on Vercel before Redis is attached.) */
const isConfigured = () => MEM.on || (store.backend() !== 'none');

// ── Persistent backends ─────────────────────────────────────────────────────
// file: one JSON file per tab {base: [...rows], list: [...rows]}
function fileTab(tabName) {
  try { return JSON.parse(store.fileRead(`tab-${slug(tabName)}.json`) || 'null') || { base: [], list: [] }; } catch { return { base: [], list: [] }; }
}
const fileSave = (tabName, t) => store.fileWrite(`tab-${slug(tabName)}.json`, JSON.stringify(t));

const kMeta = (tabName) => store.k(`tab:${slug(tabName)}:chunks`);
const kChunk = (tabName, i) => store.k(`tab:${slug(tabName)}:c${i}`);
const kList = (tabName) => store.k(`tab:${slug(tabName)}:list`);

async function rawRows(tabName) {
  if (store.backend() === 'file') { const t = fileTab(tabName); return [...t.base, ...t.list]; }
  if (store.backend() !== 'kv') return [];
  const [n, list] = await store.kv([['GET', kMeta(tabName)], ['LRANGE', kList(tabName), '0', '-1']]);
  const count = Number(n) || 0;
  const chunks = count ? await store.kv(Array.from({ length: count }, (_, i) => ['GET', kChunk(tabName, i)])) : [];
  return [...chunks.flatMap(c => (c ? JSON.parse(c) : [])), ...(list || []).map(r => JSON.parse(r))];
}

function toObjects(headers, rows) {
  const out = [];
  for (const r of rows) {
    const o = {}; let any = false;
    headers.forEach((h, i) => { const v = cell(r[i]); if (v) any = true; o[h] = v; });
    if (any) out.push(o);
  }
  return out;
}

/** All rows of one tab as header-keyed string objects. A tab nobody has written yet is []. */
async function readTab(tabName) {
  if (MEM.on) { const t = MEM.tabs[tabName] || []; return toObjects((t[0] || []).map(cell), t.slice(1)); }
  const headers = headersFor(tabName);
  return headers ? toObjects(headers, await rawRows(tabName)) : [];
}
/** Several tabs at once → { [tabName]: rows }. */
async function readTabs(tabNames) {
  const names = [...new Set((tabNames || []).filter(Boolean))];
  const lists = await Promise.all(names.map(readTab));
  return Object.fromEntries(names.map((n, i) => [n, lists[i]]));
}

function shape(tabName, rows, headers) {
  const hdr = (headers && headers.length ? headers : headersFor(tabName) || []).map(cell);
  if (!hdr.length) throw new Error(`${tabName}: no columns known for this tab`);
  return { hdr, data: (rows || []).filter(r => Array.isArray(r) && r.length).map(r => hdr.map((_, i) => cell(r[i]))) };
}

/** Add rows to the end of a tab. Returns how many. Throws when there is nowhere to keep them. */
async function appendRows(tabName, rows) {
  const { hdr, data } = shape(tabName, rows);
  if (!data.length) return 0;
  if (MEM.on) { if (!MEM.tabs[tabName]) MEM.tabs[tabName] = [hdr]; MEM.tabs[tabName].push(...data); return data.length; }
  const cap = CAP[keyOf(tabName)] || DEFAULT_CAP;
  if (store.backend() === 'file') { const t = fileTab(tabName); t.list = [...t.list, ...data].slice(-cap); fileSave(tabName, t); return data.length; }
  if (store.backend() !== 'kv') throw new Error('No storage is connected yet');
  await store.kv([['RPUSH', kList(tabName), ...data.map(r => JSON.stringify(r))], ['LTRIM', kList(tabName), String(-cap), '-1']]);
  return data.length;
}

/** Replace a tab's base with a fresh full list (what a sync does). Appended rows are kept. Returns how many. */
async function writeTab(tabName, headers, rows) {
  const { hdr, data } = shape(tabName, rows, headers);
  if (MEM.on) {
    // in memory the two parts share one array, so rows a sync did not write are carried over by Source
    const at = hdr.indexOf('Source');
    const kept = at < 0 ? [] : (MEM.tabs[tabName] || []).slice(1).filter(r => r[at] && r[at] !== 'sync');
    MEM.tabs[tabName] = [hdr, ...data, ...kept];
    return data.length;
  }
  if (store.backend() === 'file') { const t = fileTab(tabName); t.base = data; fileSave(tabName, t); return data.length; }
  if (store.backend() !== 'kv') throw new Error('No storage is connected yet');
  const old = Number(await store.kv(['GET', kMeta(tabName)])) || 0;
  const chunks = [];
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
  // new chunks first, then the count, then anything left over from a longer previous run:
  // a reader never sees an empty tab part way through
  for (let i = 0; i < chunks.length; i += 20) {
    await store.kv(chunks.slice(i, i + 20).map((c, j) => ['SET', kChunk(tabName, i + j), JSON.stringify(c)]));
  }
  await store.kv(['SET', kMeta(tabName), String(chunks.length)]);
  if (old > chunks.length) await store.kv(Array.from({ length: old - chunks.length }, (_, i) => ['DEL', kChunk(tabName, chunks.length + i)]));
  return data.length;
}

module.exports = { TABS, HEADERS, CAP, CHUNK, headersFor, readTab, readTabs, appendRows, writeTab, isConfigured, useMemory, leaveMemory, memoryTabs, isMemory };
