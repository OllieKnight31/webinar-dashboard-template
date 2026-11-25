// Webinar adapter — eWebinar (REST API v2).
//
// eWebinar's endpoint reference (api.ewebinar.com/docs/rest and its OpenAPI file) sits behind
// an eWebinar login, so only part of the API could be confirmed from public documentation.
// Each line below says which it is. Anything marked UNVERIFIED is written to fail loudly or
// degrade to blank, never to invent a number; check it against the signed-in reference
// before relying on it.
//
// CONFIRMED (api.ewebinar.com/docs, ewebinar.com/help/rest-api-v2, /help/webhook, /help/properties)
//   base        https://api.ewebinar.com/v2
//   auth        Authorization: Bearer <api key>  (keys start ew_api_; created by a team admin
//               under Integrations → API access → New key; shown once). Reading registrants
//               needs the "Registrants" permission on the key; a key without it gets 403.
//   webinars    GET /v2/webinars → { webinars: [...], nextCursor }
//   paging      cursor: send `nextCursor` back as a query parameter; absent or null = last page
//   registrants /v2/registrants exists and takes `updatedSince`, "the supported way to keep a
//               copy in sync"; reading the whole list is throttled much harder
//   limits      per minute per operation (number not published) and 10,000 requests per
//               operation per team per UTC day; 429 carries Retry-After (honoured by lib/http)
//   errors      { errors: [{ message, code }] }; a missing key can also answer plain text
//   fields      the registrant PROPERTY names used by eWebinar's webhook, Zapier and CRM
//               integrations: id, email, firstName, lastName, name, webinarId, webinarTitle,
//               registeredTime, sessionTime, sessionType (Scheduled | JustInTime | OnDemand |
//               Replay), attended ("Hasn't started" | "Joined" | "Didn't join" | "Left early" |
//               "Stayed till the end"), state, totalWatchedPercent, watchedScheduledPercent,
//               watchedReplayPercent, converted, purchaseAmount, utm_source … utm_term, joinLink
//   webhooks    set up in the eWebinar UI (Integrations → Webhook): eWebinar POSTs the
//               registrant object above to a URL of your choice on the trigger you pick
//               (WebinarFinished carries the watched percentages).
//
// UNVERIFIED (behind the login)
//   • the HTTP method and response wrapper of /v2/registrants (GET and `registrants` assumed;
//     any other single array in the body is accepted)
//   • whether the REST registrant object uses the same names as the webhook properties above
//     (assumed — mapRegistrant reads those names)
//   • the format of `updatedSince` (ISO 8601 assumed) and any filter by webinar id (not sent;
//     the webinar filter is applied here)
//   • the webinar object's field names (id / title are tried, then webinarId / name)
//   • the endpoint, method and body for registering somebody (so register() is absent)
//   • the webhook signature header and algorithm (so no signature is checked; the webhook
//     address is protected by the event secret in its query string instead)
//
// What it supplies: attendance, PERCENT watched (live and replay separately), an explicit
// "stayed till the end" flag, replay views, conversions and revenue, and all five UTM
// fields. It has no watch time in minutes and no phone number as a standard field.

'use strict';

const { config } = require('../../config');
const { fetchJson, qs, HttpError } = require('../lib/http');
const { clean, lower } = require('../lib/classify');

const API = 'https://api.ewebinar.com/v2';
const MAX_PAGES = 500;

const id = 'ewebinar';
const label = 'eWebinar';
const REGISTER_UNSUPPORTED = 'eWebinar can register people by API, but the endpoint is only documented behind an eWebinar login and has not been confirmed, so this step is skipped. Send registrants to eWebinar from its own form or widget.';

const connected = () => Boolean(config.webinar.ewebinar.api_key);
const headers = () => ({ Authorization: `Bearer ${config.webinar.ewebinar.api_key}` });

function explain(e) {
  if (e instanceof HttpError && e.status === 401) return 'That did not work: eWebinar rejected the key. Create a new one and check you copied all of it.';
  if (e instanceof HttpError && e.status === 403) return 'That did not work: the key is not allowed to read sign-ups. Create a new key with Registrants ticked.';
  if (e instanceof HttpError && e.status === 429) return 'That did not work: eWebinar asked us to slow down. Wait a few minutes and try again.';
  return 'That did not work: eWebinar did not answer properly. Try again in a minute.';
}

/** Every page of a cursor-paged list. `pick` pulls the array out of one page's body. */
async function pages(path, params, pick, ctx) {
  const out = [];
  let cursor;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error(`eWebinar ${path}: more than ${MAX_PAGES} pages, stopped rather than write a partial list`);
    if (ctx) ctx.checkBudget();
    const data = await fetchJson(`${API}${path}${qs({ ...params, nextCursor: cursor })}`, { headers: headers() });
    out.push(...pick(data || {}));
    cursor = data && data.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/** The documented wrapper key, else the body's only array (the registrants wrapper is unverified). */
function listIn(body, key) {
  if (Array.isArray(body[key])) return body[key];
  const arrays = Object.values(body).filter(Array.isArray);
  if (arrays.length === 1) return arrays[0];
  if (Array.isArray(body)) return body;
  throw new Error(`eWebinar answered in a shape this adapter does not know (no "${key}" list). The endpoint reference is behind an eWebinar login: check it and update api/_lib/sync/webinar/ewebinar.js.`);
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const percent = (v) => { const n = Number(String(v === undefined || v === null ? '' : v).replace('%', '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
const truthy = (v) => (v === undefined || v === null || v === '' ? null : /^(true|yes|1)$/i.test(String(v)));
/** "$1,497.00" → 1497. The property is text with a currency symbol. */
const amount = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
function when(v) { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }

/**
 * One eWebinar registrant (REST row or webhook body — the property names are the same in
 * the documentation's webhook example and properties table) → the standard registrant.
 */
function mapRegistrant(raw) {
  const r = raw || {};
  const attendedText = lower(r.attended);
  const type = lower(r.sessionType);
  const replaySession = type === 'replay';
  const livePct = percent(r.watchedScheduledPercent), replayPct = percent(r.watchedReplayPercent), totalPct = percent(r.totalWatchedPercent);
  // "Hasn't started" = the session has not run: attendance is unknown, not a no.
  let attendedLive = null;
  if (replaySession) attendedLive = false;
  else if (/^(joined|left early|stayed till the end)$/.test(attendedText)) attendedLive = true;
  else if (attendedText === "didn't join" || lower(r.state) === 'missed') attendedLive = false;
  else if (livePct !== null) attendedLive = livePct > 0;
  const sessionAt = when(r.sessionTime);
  return {
    id: `${id}:${clean(r.id) || `${clean(r.webinarId)}:${lower(r.email)}`}`,
    provider: id,
    webinar_id: clean(r.webinarId),
    webinar_name: clean(r.webinarTitle || r.webinarName),
    // eWebinar has no session id on the registrant; the session's start time is the session
    session_id: sessionAt ? sessionAt.toISOString().slice(0, 16) : type,
    session_at: sessionAt,
    email: lower(r.email),
    name: clean(r.name) || [r.firstName, r.lastName].map(clean).filter(Boolean).join(' '),
    phone: clean(r.phone),                              // a custom field on eWebinar; blank unless the team named one "phone"
    registered_at: when(r.registeredTime),
    attended_live: attendedLive,
    minutes_watched: null,                              // not reported by this platform
    percent_watched: replaySession ? (replayPct ?? totalPct) : (livePct ?? totalPct),
    // the one explicit signal; otherwise the engine derives it from percent watched
    stayed_to_pitch: attendedText === 'stayed till the end' ? true : null,
    watched_replay: replayPct !== null ? replayPct > 0 : (replaySession && /^(joined|left early|stayed till the end)$/.test(attendedText) ? true : null),
    purchased: truthy(r.converted),
    revenue: amount(r.purchaseAmount),
    utm_source: clean(r.utm_source), utm_medium: clean(r.utm_medium), utm_campaign: clean(r.utm_campaign),
    utm_content: clean(r.utm_content), utm_term: clean(r.utm_term),
    join_url: clean(r.joinLink),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function listWebinars() {
  const rows = await pages('/webinars', {}, (b) => listIn(b, 'webinars'));
  // field names UNVERIFIED: the public docs show the wrapper but not the webinar object
  return rows.map((w) => ({ id: clean(w.id ?? w.webinarId), name: clean(w.title || w.name || w.webinarTitle) || `Webinar ${w.id ?? w.webinarId}`, type: clean(w.type || w.status) }))
    .filter((w) => w.id);
}

async function pull(ctx, opts = {}) {
  const only = new Set((opts.webinarIds || []).map(String));
  const params = opts.since ? { updatedSince: opts.since.toISOString() } : {};
  const rows = await pages('/registrants', params, (b) => listIn(b, 'registrants'), ctx);
  const registrants = rows.map(mapRegistrant).filter((r) => r.email && (!only.size || only.has(r.webinar_id)));
  return { registrants, sessions: [], note: `${rows.length} read · no watch time in minutes from this platform` };
}

async function test() {
  if (!config.webinar.ewebinar.api_key) return { ok: false, message: 'Paste your eWebinar key first, then check again.' };
  try {
    const picks = await listWebinars();
    return { ok: true, message: `Connected. We found ${picks.length} webinar${picks.length === 1 ? '' : 's'}. Tick the one you are launching.`, picks: picks.map((w) => ({ name: w.id, label: w.name, active: true })) };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

module.exports = { id, label, connected, test, listWebinars, pull, mapRegistrant, listIn, REGISTER_UNSUPPORTED };
