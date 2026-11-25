// Webinar adapter — WebinarJam and EverWebinar (one API, one key; `product` picks the path).
//
//   base      https://api.webinarjam.com/{webinarjam|everwebinar}/…
//   auth      the 64-character API key as an `api_key` FORM FIELD on every request. No headers.
//   verbs     every endpoint is POST with a form-encoded body
//   errors    business errors come back as HTTP 200 {"status":"error","message":…}; the only
//             other status worth expecting is 429 (limit: 20 requests a second)
//   webinars     → { webinars: [{ webinar_id, name, type, schedules, timezone }] }
//   registrants  → paged ~20-25 a page. Depending on the API version the page is at
//                  { registrants: {…} } or { webinar: { registrants: {…} } }; both are read.
//                  There is no date filter worth using (date_range is all time or today), so
//                  every page is read and the lookback is applied here.
//   register     → { user: { lead_id, live_room_url, replay_url, thank_you_url } }
//
// What it supplies: attendance (attended_live), watch TIME (time_live, HH:MM:SS → minutes),
// replay, purchases and revenue, and all five UTM fields. It has no percent watched and no
// "stayed to the pitch" flag: that is worked out by the engine from minutes watched and the
// "minute the pitch starts" setting.

'use strict';

const { config } = require('../../config');
const { request, sleep } = require('../lib/http');
const { clean, lower } = require('../lib/classify');

const API = 'https://api.webinarjam.com';
const MAX_PAGES = 600;
const PAGE_PAUSE_MS = 120;        // well inside 20 requests a second

const id = 'webinarjam';
const label = 'WebinarJam / EverWebinar';
const connected = () => Boolean(config.webinar.webinarjam.api_key);
const product = () => (config.webinar.webinarjam.product === 'everwebinar' ? 'everwebinar' : 'webinarjam');

/** POST a form with the key in it; surface body-level errors. The key never reaches a message. */
async function post(path, params = {}) {
  const body = new URLSearchParams({ api_key: config.webinar.webinarjam.api_key });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
  const res = await request(`${API}/${product()}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(`WebinarJam ${path} answered HTTP ${res.status}`);
  if (!data) throw new Error(`WebinarJam ${path} did not answer with JSON`);
  if (data.status && data.status !== 'success') throw new Error(`WebinarJam ${path}: ${clean(data.message) || data.status}`);
  return data;
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const yes = (v) => /^(yes|y|1|true)$/i.test(clean(v));
/** "Yes"/"No"/1/0 → true/false; absent → null (the platform did not say). */
const flag = (v) => (v === undefined || v === null || v === '' ? null : yes(v));

/** "01:02:30" → 62.5 minutes. Blank or unparseable → null. */
function minutes(v) {
  const s = clean(v);
  if (!s) return null;
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (!m) { const n = Number(s); return Number.isFinite(n) ? n : null; }
  const [h, mm, ss] = m[3] === undefined ? [0, Number(m[1]), Number(m[2])] : [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.round((h * 60 + mm + ss / 60) * 10) / 10;
}

/** Unix seconds, unix millis, ISO, or "2026-04-01 14:00" → Date | null. */
function when(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n); }
  const d = new Date(String(v).replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapRegistrant(raw, webinar = {}) {
  const r = raw || {};
  const webinarId = clean(r.webinar_id || webinar.webinar_id);
  // event_date names the session the person registered for; it is a display string on some
  // accounts, so it is kept verbatim as the session id when no numeric id is present.
  const sessionAt = when(r.event_date) || when(r.date_live);
  const sessionId = clean(r.event_id) || clean(r.event_date) || clean(r.schedule_id) || clean(r.schedule);
  const live = minutes(r.time_live), replay = minutes(r.time_replay);
  const revenue = [r.revenue_live, r.revenue_replay].map(Number).filter(Number.isFinite);
  const purchased = [flag(r.purchased_live), flag(r.purchased_replay)];
  return {
    id: `${id}:${webinarId}:${clean(r.lead_id) || lower(r.email)}:${sessionId}`,
    provider: product(),
    webinar_id: webinarId,
    webinar_name: clean(r.webinar_name || webinar.name),
    session_id: sessionId,
    session_at: sessionAt,
    email: lower(r.email),
    name: [r.first_name, r.last_name].map(clean).filter(Boolean).join(' '),
    phone: [r.phone_country_code, r.phone_number || r.phone].map(clean).filter(Boolean).join(' '),
    registered_at: when(r.signup_date) || when(r.registration_date),
    attended_live: flag(r.attended_live),
    minutes_watched: live,
    percent_watched: null,                       // not reported by this platform
    stayed_to_pitch: null,                       // derived by the engine from minutes watched
    watched_replay: flag(r.attended_replay) === null && replay !== null ? replay > 0 : flag(r.attended_replay),
    purchased: purchased.every((p) => p === null) ? null : purchased.some(Boolean),
    revenue: revenue.length ? revenue.reduce((a, b) => a + b, 0) : null,
    utm_source: clean(r.utm_source), utm_medium: clean(r.utm_medium), utm_campaign: clean(r.utm_campaign),
    utm_content: clean(r.utm_content), utm_term: clean(r.utm_term),
    join_url: clean(r.live_room_url),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function listWebinars() {
  const data = await post('webinars');
  return (data.webinars || []).map((w) => ({ id: String(w.webinar_id), name: clean(w.name) || `Webinar ${w.webinar_id}`, type: clean(w.type) }));
}

async function registrantsOf(webinar, ctx) {
  const out = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) throw new Error(`WebinarJam registrants: more than ${MAX_PAGES} pages for webinar ${webinar.id}, stopped rather than write a partial list`);
    if (ctx) ctx.checkBudget();
    const data = await post('registrants', { webinar_id: webinar.id, schedule_id: 0, page });
    const pg = data.registrants || (data.webinar && data.webinar.registrants) || null;
    const rows = (pg && pg.data) || [];
    out.push(...rows);
    if (!pg || !rows.length || Number(pg.current_page) >= Number(pg.last_page)) break;
    await sleep(PAGE_PAUSE_MS);
  }
  return out;
}

async function pull(ctx, opts = {}) {
  const all = await listWebinars();
  const only = new Set((opts.webinarIds || []).map(String));
  const webinars = only.size ? all.filter((w) => only.has(w.id)) : all;
  const since = opts.since ? opts.since.getTime() : 0;
  const registrants = [];
  for (const w of webinars) {
    for (const raw of await registrantsOf(w, ctx)) {
      const r = mapRegistrant(raw, { webinar_id: w.id, name: w.name });
      if (!r.email) continue;
      const at = r.registered_at ? r.registered_at.getTime() : null;
      if (since && at !== null && at < since) continue;
      registrants.push(r);
    }
  }
  return { registrants, sessions: [], note: `${webinars.length} of ${all.length} webinars` };
}

async function test() {
  if (!config.webinar.webinarjam.api_key) return { ok: false, message: 'Paste your WebinarJam key first, then check again.' };
  try {
    const picks = await listWebinars();
    return { ok: true, message: `Connected. We found ${picks.length} webinar${picks.length === 1 ? '' : 's'}. Tick the one you are launching.`, picks: picks.map((w) => ({ name: w.id, label: w.name, active: true })) };
  } catch (e) {
    return { ok: false, message: /api key|unauthori/i.test(e.message) ? 'That did not work: WebinarJam rejected the key. Check you copied all of it, and that your key has been approved.' : 'That did not work: WebinarJam did not answer properly. Try again in a minute.' };
  }
}

// ── Registration (documented: POST /register) ───────────────────────────────

/** `schedule` 0 = the webinar's first / default schedule. */
async function register(person) {
  const data = await post('register', {
    webinar_id: person.webinar_id,
    first_name: person.first_name,
    last_name: person.last_name,
    email: person.email,
    schedule: person.session || 0,
    phone: person.phone,
    ip_address: person.ip,
  });
  const u = data.user || {};
  return { registrant_id: clean(u.lead_id), join_url: clean(u.live_room_url), replay_url: clean(u.replay_url), thank_you_url: clean(u.thank_you_url) };
}

module.exports = { id, label, connected, test, listWebinars, pull, mapRegistrant, register, minutes, when };
