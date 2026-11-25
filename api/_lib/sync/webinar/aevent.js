// Webinar adapter — aEvent.
//
// READ THIS FIRST: aEvent publishes no API documentation and issues no API keys. Everything
// here follows endpoints the aEvent web app itself calls, observed on a live account; none of
// it is a supported contract and any of it can change without notice.
//
//   base   https://app.aevent.com
//   auth   Authorization: Bearer <the `token` cookie of a logged-in app.aevent.com session>.
//          aEvent invalidates that token when the same user logs in again, whatever expiry
//          the token itself carries. A 401 here almost always means "somebody logged in":
//          paste a fresh token on /settings. Use a login nobody else uses.
//   GET /api/webinars?page=0&type=past|upcoming
//          → { success: { "<uniqueID>": [event] } }. Event: uniqueID, webinarID (the meeting
//          id), webinarTimeline (the campaign id), timestamp (unix seconds, UTC), and on past
//          events `registrants` and `attendees` counts.
//   GET /api/registrants?page=N&filter=all
//          → { success: [registrant] } (or an object of arrays). Registrant: email,
//          webinarID, registrationTime, attendance.groups (["Attendee"] | ["Non-Attendee"]),
//          name, phone. Server-side filters do not work, so every page is read from 0 until
//          the registrations are older than the lookback.
//
// What it supplies: registrants, live attendance (attendee / non-attendee) and per-session
// counts. What it does NOT supply through these endpoints: watch time, percent watched,
// stayed to the pitch, replay views, purchases, or any UTM field. Those columns stay blank
// and the matching tiles read n/a. (Watch time exists only in a CSV the app downloads.)
//
// UNVERIFIED, written defensively: whether registrationTime is unix seconds or millis (both
// are read), the exact spelling of the name / phone fields (several are tried), and the
// "Full" / "Partial" attendee groups aEvent uses internally (not relied on).
// Registration by API is not available: the public form posts to a per-account host behind a
// captcha, so register() is deliberately absent.

'use strict';

const { config } = require('../../config');
const { fetchJson, HttpError } = require('../lib/http');
const { clean, lower } = require('../lib/classify');

const API = 'https://app.aevent.com';
const MAX_PAGES = 300;

const id = 'aevent';
const label = 'aEvent';
const REGISTER_UNSUPPORTED = 'aEvent has no documented way to register somebody by API, so this step is skipped. Send registrants to aEvent from its own form or its CRM integration.';

const connected = () => Boolean(config.webinar.aevent.token);
const headers = () => ({ Authorization: `Bearer ${config.webinar.aevent.token}` });

const EXPIRED = 'That did not work: aEvent no longer accepts this token. It stops working whenever that person logs in again. Log in to aEvent, copy the token again and paste the new one.';
async function get(path) {
  try { return await fetchJson(`${API}${path}`, { headers: headers() }); }
  catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw new Error(EXPIRED);
    throw e;
  }
}

/** `success` is an array, or an object of arrays keyed by id. */
const flat = (success) => (Array.isArray(success) ? success : Object.values(success || {}).flat()).filter((x) => x && typeof x === 'object');

function when(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n); }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Mapping ─────────────────────────────────────────────────────────────────

/** attendance.groups → true (Attendee) | false (Non-Attendee) | null (no attendance yet). */
function attended(raw) {
  const groups = ((raw.attendance || {}).groups || []).map((g) => lower(g));
  if (!groups.length) return null;
  if (groups.some((g) => g === 'non-attendee' || g === 'non attendee')) return false;
  return groups.some((g) => g.includes('attendee')) ? true : null;
}

/** `event` is the session this registrant's webinarID belongs to, when it is known. */
function mapRegistrant(raw, event = {}) {
  const r = raw || {};
  const meeting = clean(r.webinarID);
  return {
    id: `${id}:${meeting}:${lower(r.email)}`,
    provider: id,
    webinar_id: clean(event.webinarTimeline),
    webinar_name: '',
    session_id: meeting,
    session_at: when(event.timestamp) || when(event.timeStamp),
    email: lower(r.email),
    name: clean(r.name) || [r.firstName || r.first_name, r.lastName || r.last_name].map(clean).filter(Boolean).join(' '),
    phone: clean(r.phone || r.phoneNumber),
    registered_at: when(r.registrationTime),
    attended_live: attended(r),
    minutes_watched: null, percent_watched: null, stayed_to_pitch: null,   // not available
    watched_replay: null, purchased: null, revenue: null,                  // not available
    utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '',
    join_url: '',
  };
}

function mapSession(e) {
  const past = e._past === true;
  return {
    provider: id,
    webinar_id: clean(e.webinarTimeline),
    webinar_name: '',
    session_id: clean(e.webinarID) || clean(e.uniqueID),
    session_at: when(e.timestamp) || when(e.timeStamp),
    type: past ? 'past' : 'upcoming',
    registrants: Number.isFinite(Number(e.registrants)) ? Number(e.registrants) : null,
    // an event that has not run has no attendance — blank, not 0
    attendees: past && Number.isFinite(Number(e.attendees)) ? Number(e.attendees) : null,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function events() {
  const [past, upcoming] = await Promise.all([
    get('/api/webinars?page=0&type=past'),
    get('/api/webinars?page=0&type=upcoming').catch(() => ({ success: {} })),
  ]);
  const seen = new Set();
  const out = [];
  for (const e of flat(past && past.success)) { seen.add(e.uniqueID); out.push({ ...e, _past: true }); }
  for (const e of flat(upcoming && upcoming.success)) if (!seen.has(e.uniqueID)) out.push({ ...e, _past: false });
  return out;
}

/** The picker lists campaigns (timelines). aEvent's event list carries no campaign name. */
async function listWebinars() {
  const byCampaign = new Map();
  for (const e of await events()) {
    const key = clean(e.webinarTimeline);
    if (!key) continue;
    const at = when(e.timestamp) || when(e.timeStamp);
    const c = byCampaign.get(key) || { id: key, sessions: 0, latest: null };
    c.sessions += 1;
    if (at && (!c.latest || at > c.latest)) c.latest = at;
    byCampaign.set(key, c);
  }
  return [...byCampaign.values()].map((c) => ({
    id: c.id, type: 'campaign',
    name: `Campaign ${c.id} (${c.sessions} session${c.sessions === 1 ? '' : 's'}${c.latest ? `, latest ${c.latest.toISOString().slice(0, 10)}` : ''})`,
  }));
}

async function pull(ctx, opts = {}) {
  const only = new Set((opts.webinarIds || []).map(String));
  const all = await events();
  const mine = only.size ? all.filter((e) => only.has(clean(e.webinarTimeline))) : all;
  const byMeeting = new Map(mine.map((e) => [clean(e.webinarID), e]));
  const since = opts.since ? opts.since.getTime() : 0;

  const registrants = [];
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error(`aEvent registrants: more than ${MAX_PAGES} pages, stopped rather than write a partial list`);
    if (ctx) ctx.checkBudget();
    const data = await get(`/api/registrants?page=${page}&filter=all`);
    const rows = flat(data && data.success);
    if (!rows.length) break;
    let oldest = Infinity;
    for (const raw of rows) {
      const event = byMeeting.get(clean(raw.webinarID));
      const at = when(raw.registrationTime);
      if (at) oldest = Math.min(oldest, at.getTime());
      if (only.size && !event) continue;                 // another campaign's registrant
      const r = mapRegistrant(raw, event || {});
      if (!r.email || (since && at && at.getTime() < since)) continue;
      registrants.push(r);
    }
    if (since && oldest < since) break;                  // newest first: the rest is older still
  }
  const sessions = mine.map(mapSession).filter((s) => !since || !s.session_at || s.session_at.getTime() >= since);
  return { registrants, sessions, note: `${mine.length} of ${all.length} sessions · no watch time or UTM data from this platform` };
}

async function test() {
  if (!config.webinar.aevent.token) return { ok: false, message: 'Paste your aEvent token first, then check again.' };
  try {
    const picks = await listWebinars();
    return { ok: true, message: `Connected. We found ${picks.length} campaign${picks.length === 1 ? '' : 's'}. Remember: this stops working the next time that person logs in to aEvent.`, picks: picks.map((w) => ({ name: w.id, label: w.name, active: true })) };
  } catch (e) {
    return { ok: false, message: e.message === EXPIRED ? EXPIRED : 'That did not work: aEvent did not answer properly. Try again in a minute.' };
  }
}

module.exports = { id, label, connected, test, listWebinars, pull, mapRegistrant, mapSession, attended, REGISTER_UNSUPPORTED };
