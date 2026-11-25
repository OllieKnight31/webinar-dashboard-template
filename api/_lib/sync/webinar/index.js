// Webinar System sync — `webinar` part: the connected webinar platform →
// WEBINAR REGISTRANTS + WEBINAR SESSIONS.
//
// One interface, one file per platform. Every adapter exports the same things:
//
//   id, label
//   connected()            → true once its credential is saved
//   test()                 → { ok, message }                    never throws
//   listWebinars()         → [{ id, name, type }]               for the picker on /settings
//   pull(ctx, opts)        → { registrants: [registrant], sessions: [session], note }
//                            opts = { webinarIds: [ids ticked on /settings], since: Date }
//   mapRegistrant(raw, w)  → registrant                          pure; what the tests pin down
//   register(person)       → { join_url, registrant_id }         or leave it out and export
//   REGISTER_UNSUPPORTED     a sentence saying why the platform cannot be registered by API
//
// A registrant is the standard object below; toRow() lays it onto the sheet's columns.
// Unknown is never zero: a platform that does not report watch time leaves minutes_watched
// null, and one that cannot say whether somebody stayed leaves stayed_to_pitch null.
//
//   { id, provider, webinar_id, webinar_name, session_id, session_at, email, name, phone,
//     registered_at, attended_live, minutes_watched, percent_watched, stayed_to_pitch,
//     watched_replay, purchased, revenue, utm_source, utm_medium, utm_campaign, utm_content,
//     utm_term, join_url }
//
// ADDING A PLATFORM: write api/_lib/sync/webinar/<name>.js with the exports above, then add
// one line to ADAPTERS below. That is all: /settings offers every key of ADAPTERS in its
// dropdown, the new adapter reads its credential from config.webinar.api_key (the
// "API key for a platform added later" box, WEBINAR_API_KEY), and the engine only reads the tabs.

'use strict';

const { config } = require('../../config');
const db = require('../../db');
const { iso, nowIso } = require('../lib/time');
const { clean, lower } = require('../lib/classify');

// Literal requires only — the bundler does not follow computed ones.
const ADAPTERS = {
  webinarjam: () => require('./webinarjam'),
  ewebinar: () => require('./ewebinar'),
  aevent: () => require('./aevent'),
};

/** The adapter for the chosen platform, or null when the provider is none / unknown. */
function adapter(provider = config.webinar.provider) {
  const load = ADAPTERS[provider];
  return load ? load() : null;
}

// ── The standard row ────────────────────────────────────────────────────────

const yn = (v) => (v === true ? 'Y' : v === false ? 'N' : '');
const number = (v, dp = 1) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : String(Math.round(Number(v) * 10 ** dp) / 10 ** dp));

/** One registrant object → a WEBINAR REGISTRANTS row. `source` = sync | relay | webhook. */
function toRow(r, synced, source = 'sync') {
  const byHeader = {
    'Registrant ID': clean(r.id) || `${r.provider}:${r.webinar_id}:${r.session_id}:${lower(r.email)}`,
    Provider: clean(r.provider),
    'Webinar ID': clean(r.webinar_id),
    'Webinar Name': clean(r.webinar_name),
    'Session ID': clean(r.session_id),
    'Session At': iso(r.session_at) || '',
    Email: lower(r.email),
    Name: clean(r.name),
    Phone: clean(r.phone),
    'Registered At': iso(r.registered_at) || '',
    'Attended Live': yn(r.attended_live),
    'Minutes Watched': number(r.minutes_watched),
    'Percent Watched': number(r.percent_watched),
    'Stayed To Pitch': yn(r.stayed_to_pitch),
    'Watched Replay': yn(r.watched_replay),
    Purchased: yn(r.purchased),
    Revenue: r.revenue === null || r.revenue === undefined || r.revenue === '' ? '' : number(r.revenue, 2),
    'UTM Source': clean(r.utm_source),
    'UTM Medium': clean(r.utm_medium),
    'UTM Campaign': clean(r.utm_campaign),
    'UTM Content': clean(r.utm_content),
    'UTM Term': clean(r.utm_term),
    'Join URL': clean(r.join_url),
    'Funnel Source': clean(r.funnel_source),
    Source: source,
    'Synced At': synced,
  };
  return db.HEADERS.WEBINAR_REGISTRANTS.map((h) => byHeader[h] ?? '');
}

function sessionRow(s, synced) {
  const byHeader = {
    'Session Key': `${s.provider}|${s.webinar_id}|${s.session_id}`,
    Provider: clean(s.provider),
    'Webinar ID': clean(s.webinar_id),
    'Webinar Name': clean(s.webinar_name),
    'Session ID': clean(s.session_id),
    'Session At': iso(s.session_at) || '',
    Type: clean(s.type),
    Registrants: number(s.registrants, 0),
    Attendees: number(s.attendees, 0),
    'Synced At': synced,
  };
  return db.HEADERS.WEBINAR_SESSIONS.map((h) => byHeader[h] ?? '');
}

/**
 * Sessions worked out from the registrants themselves, for platforms with no session list.
 * Attendees stays blank until at least one registrant of the session has attendance data.
 */
function sessionsFrom(registrants) {
  const m = new Map();
  for (const r of registrants) {
    const key = `${r.webinar_id}|${r.session_id}`;
    if (!m.has(key)) m.set(key, { provider: r.provider, webinar_id: r.webinar_id, webinar_name: r.webinar_name, session_id: r.session_id, session_at: r.session_at, type: '', registrants: 0, attendees: null });
    const s = m.get(key);
    s.registrants += 1;
    if (r.attended_live !== null && r.attended_live !== undefined) s.attendees = (s.attendees || 0) + (r.attended_live ? 1 : 0);
  }
  return [...m.values()];
}

// ── The part ────────────────────────────────────────────────────────────────

async function run(ctx) {
  const a = adapter();
  if (!a) throw new Error(`No adapter for the webinar platform "${config.webinar.provider}"`);
  const { registrants, sessions, note } = await a.pull(ctx, { webinarIds: config.webinar.webinar_ids, since: ctx.since });

  const synced = nowIso();
  const rows = registrants.map((r) => toRow(r, synced));
  rows.sort((x, y) => (x[9] < y[9] ? -1 : x[9] > y[9] ? 1 : 0));
  const sessionRows = (sessions && sessions.length ? sessions : sessionsFrom(registrants)).map((s) => sessionRow(s, synced));
  sessionRows.sort((x, y) => (x[5] < y[5] ? -1 : x[5] > y[5] ? 1 : 0));

  ctx.beginWrite();
  // writeTab replaces only what the platform wrote last time: sign-ups appended by the
  // landing page or another tool live in the tab's appended part and are never touched.
  const wR = await db.writeTab(db.TABS.WEBINAR_REGISTRANTS, db.HEADERS.WEBINAR_REGISTRANTS, rows);
  const wS = await db.writeTab(db.TABS.WEBINAR_SESSIONS, db.HEADERS.WEBINAR_SESSIONS, sessionRows);
  const attended = registrants.filter((r) => r.attended_live === true).length;
  return {
    rows: wR + wS,
    message: `${a.id}: registrants=${rows.length} attended=${attended} sessions=${sessionRows.length}${note ? ` · ${note}` : ''}`,
  };
}

module.exports = { run, adapter, ADAPTERS, toRow, sessionRow, sessionsFrom };
