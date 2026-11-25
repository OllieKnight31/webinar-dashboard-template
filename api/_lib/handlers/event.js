// POST /api?source=event: updates pushed by other tools (a webinar platform's webhook, Zapier,
// Make, a form). Machines call this, so it is protected by a secret created on the Settings
// page (config.ingest.event_secret); with none set the route stays shut. It answers with its
// own status: 500 when nothing could be saved, so the sender tries again.
//
// Webinar data rides the same route, for platforms with no adapter (or alongside one):
//   • single steps — type webinar_registered | webinar_attended | webinar_stayed |
//     webinar_replay | webinar_purchase — are ordinary EVENTS rows the Webinar tab folds in;
//   • a whole registrant — type webinar_registrant, with the standard registrant fields
//     (email, webinar_id, session_at, attended_live, minutes_watched, percent_watched,
//     stayed_to_pitch, watched_replay, purchased, revenue, utm_*) — is appended to
//     WEBINAR REGISTRANTS instead;
//   • a webinar platform's own webhook body — add &provider=<adapter> to the address and the
//     adapter's mapRegistrant() turns it into the same row. Platforms that cannot send a
//     header may put the event secret on the address as &key=… instead.
//
// Body keys are loose on purpose. Senders are written by different people in different
// tools and humans will curl this by hand, so any of `Event ID`, `event_id`, `eventId`
// lands in the same column: keys are matched to headers with everything but [a-z0-9]
// stripped. Nested `utm:{source,…}` and `origin:{channel,entry,paid}` objects are unpacked.

const crypto = require('crypto');
const { config } = require('../config');
const { TABS, HEADERS, appendRows, isConfigured } = require('../db');

const EVENTS_TAB = TABS.EVENTS;
const EVENTS_HEADERS = HEADERS.EVENTS;

// The event vocabulary. Anything else is stored with an `unknown:` prefix rather than
// dropped — a typo in a sender should show up in the sheet, not vanish.
const EVENT_TYPES = new Set([
  'optin', 'lead', 'lead_magnet_optin', 'community_join',
  'call_booked', 'call_rescheduled', 'call_cancelled', 'no_show',
  'sale', 'payment_failed', 'refund',
  'dm_sent', 'dm_reply', 'link_click',
  'webinar_registered', 'webinar_attended', 'webinar_stayed', 'webinar_replay', 'webinar_purchase',
]);
// A whole registrant row; stored in WEBINAR REGISTRANTS, not EVENTS.
const REGISTRANT_TYPE = 'webinar_registrant';

// Other names senders commonly use for the same thing.
const TYPE_ALIASES = { application: 'lead', opt_in: 'optin' };

const RAW_MAX = 4000;
const MAX_EVENTS_PER_CALL = 500;

// ── Value coercion ──────────────────────────────────────────────────────────

// Absent → '', never the string "undefined" (which String() happily produces and
// which then sits in the sheet forever looking like data). Booleans → Y/N.
function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ');
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return ''; } }
  const s = String(v).trim();
  return s === 'undefined' || s === 'null' ? '' : s;
}

function yn(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  const s = String(v).trim().toLowerCase();
  if (['y', 'yes', 'true', '1', 'paid', 'on'].includes(s)) return 'Y';
  if (['n', 'no', 'false', '0', 'organic', 'off'].includes(s)) return 'N';
  return '';
}

// Money as a decimal string ('7800.00'), whatever symbol or code it arrived with
// ("£7,800", "USD 7800"). Non-numeric input passes through as text.
function money(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(2) : '';
  const bare = String(v).trim().replace(/^[^\d-]+/, '').replace(/[^\d.]+$/, '').replace(/[,\s]/g, '');
  const n = bare === '' ? NaN : Number(bare);
  return Number.isFinite(n) ? n.toFixed(2) : str(v);
}

// ISO-normalise anything Date.parse understands, plus bare epoch seconds / millis.
function isoLoose(v) {
  const s = str(v);
  if (!s) return '';
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    const ms = n < 1e11 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : s;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

function truncateRaw(v) {
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  s = s || '';
  return s.length > RAW_MAX ? s.slice(0, RAW_MAX) : s;
}

// "Call-Booked" / "call booked" → call_booked, then aliases, then the unknown prefix.
function normType(v) {
  const t = str(v).toLowerCase().replace(/[\s-]+/g, '_');
  const known = TYPE_ALIASES[t] || t;
  if (EVENT_TYPES.has(known)) return known;
  return `unknown:${t}`;
}

// ── Key matching ────────────────────────────────────────────────────────────

const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_BY_NORM = new Map(EVENTS_HEADERS.map(h => [normKey(h), h]));

// Extra spellings → header. Only unambiguous ones; `source` alone is deliberately absent
// (senders use it for several different things).
const ALIASES = {
  id: 'Event ID', eventtype: 'Type', kind: 'Type',
  ts: 'Occurred At', timestamp: 'Occurred At', at: 'Occurred At', time: 'Occurred At', occurred: 'Occurred At', created: 'Occurred At', createdat: 'Occurred At',
  fullname: 'Name', phonenumber: 'Phone',
  crmcontactid: 'Contact ID', crmid: 'Contact ID', leadid: 'Contact ID',
  paid: 'Paid Traffic',
  hostemail: 'Host', closer: 'Host',
  event: 'Event Name', eventtypename: 'Event Name',
  offerid: 'Offer', package: 'Offer', tier: 'Offer',
  value: 'Amount', price: 'Amount', total: 'Amount',
  productname: 'Product',
  slug: 'Ref', reference: 'Ref',
  system: 'Source System',
  payload: 'Raw',
};

// Payment tools send their own shape, with the buyer and the money a level or two down
// ({ data: { customer: { email }, amount } }). When the top level names no email or amount,
// the first one found underneath is used.
const BUYER = /^(email|emailaddress|customeremail|buyeremail|payeremail|useremail|contactemail)$/;
const MONEY = /^(amount|total|grandtotal|amounttotal|price|value|amountpaid)$/;
const CENTS = /^(amountcents|amountincents|totalcents|totalincents|amounttotalcents)$/;
const PERSON = /^(name|fullname|customername|buyername)$/;
function dig(obj, wanted, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const [k, v] of Object.entries(obj)) if (wanted.test(normKey(k)) && v !== null && typeof v !== 'object' && String(v).trim() !== '') return v;
  for (const v of Object.values(obj)) { const hit = dig(v, wanted, depth + 1); if (hit !== undefined) return hit; }
  return undefined;
}
/** A payment tool's own message → the plain shape the rest of this file reads. */
function asSale(evt) {
  const out = { ...evt, type: 'sale' };
  const flat = pickColumns(evt);
  if (!str(flat.Email)) { const email = dig(evt, BUYER); if (email !== undefined) out.email = email; }
  if (!str(flat.Amount)) {
    const cents = dig(evt, CENTS), whole = dig(evt, MONEY);
    if (cents !== undefined && Number.isFinite(Number(cents))) out.amount = Number(cents) / 100; else if (whole !== undefined) out.amount = whole;
  }
  if (!str(flat.Name)) { const name = dig(evt, PERSON); if (name !== undefined) out.name = name; }
  if (!str(flat.Currency)) { const c = dig(evt, /^(currency|currencycode)$/); if (c !== undefined) out.currency = c; }
  if (!str(flat['Event ID'])) { const id = dig(evt, /^(transactionid|orderid|paymentid|chargeid|invoiceid)$/); if (id !== undefined) out.event_id = `sale:${id}`; }
  return out;
}

/** Flatten one loose event object into { <Header>: value } using header-normalised keys. */
function pickColumns(evt) {
  const out = {};
  const put = (header, v) => { if (header && (out[header] === undefined || out[header] === '' || out[header] === null) && v !== undefined) out[header] = v; };

  for (const [k, v] of Object.entries(evt || {})) {
    const nk = normKey(k);
    if (HEADER_BY_NORM.has(nk)) { put(HEADER_BY_NORM.get(nk), v); continue; }
    if (ALIASES[nk]) { put(ALIASES[nk], v); continue; }
    if (nk === 'utm' && v && typeof v === 'object') {
      for (const [uk, uv] of Object.entries(v)) put(HEADER_BY_NORM.get(normKey(`utm ${uk}`)), uv);
      continue;
    }
    if (nk === 'origin' && v && typeof v === 'object') {
      put('Channel', v.channel); put('Entry', v.entry); put('Paid Traffic', v.paid);
      continue;
    }
    if (nk === 'utmsource') put('UTM Source', v);
  }
  return out;
}

// ── Row building ────────────────────────────────────────────────────────────

/** Build one EVENTS row (array in EVENTS_HEADERS order) from a loose event object. */
function buildEventRow(evt, receivedAt) {
  const c = pickColumns(evt);
  // {event: "call_booked"} is a common way to say {type: "call_booked"}: when no type was
  // given and the event name is one of ours, it is the type.
  if (!str(c.Type) && !normType(c['Event Name']).startsWith('unknown:')) { c.Type = c['Event Name']; c['Event Name'] = ''; }
  const type = normType(c.Type);
  const occurredAt = isoLoose(c['Occurred At']) || receivedAt;

  let eventId = str(c['Event ID']);
  if (!eventId) {
    // Senders should always supply a stable one ("call_booked:<booking id>"). Fallback is
    // a content hash so a retried identical payload still dedupes on read.
    const h = crypto.createHash('sha1').update(JSON.stringify(evt || {})).digest('hex').slice(0, 16);
    eventId = `${type}:auto:${h}`;
  }

  const raw = c.Raw !== undefined && c.Raw !== null && c.Raw !== '' ? c.Raw : (evt || {});

  const amount = money(c.Amount);
  const byHeader = {
    'Event ID': eventId,
    'Type': type,
    'Occurred At': occurredAt,
    'Received At': receivedAt,
    'Email': str(c.Email).toLowerCase(),
    'Name': str(c.Name),
    'Phone': str(c.Phone),
    'Contact ID': str(c['Contact ID']),
    'Pipeline': str(c.Pipeline),
    'Stage': str(c.Stage),
    'Channel': str(c.Channel),
    'Entry': str(c.Entry),
    'Paid Traffic': yn(c['Paid Traffic']),
    'UTM Source': str(c['UTM Source']),
    'UTM Medium': str(c['UTM Medium']),
    'UTM Campaign': str(c['UTM Campaign']),
    'UTM Content': str(c['UTM Content']),
    'UTM Term': str(c['UTM Term']),
    'Offer': str(c.Offer),
    'Amount': amount,
    // An amount with no currency is in the business's own.
    'Currency': str(c.Currency).toUpperCase() || (amount ? config.command.currency_code : ''),
    'Product': str(c.Product),
    'Host': str(c.Host),
    'Event Name': str(c['Event Name']),
    'Setter': str(c.Setter).toLowerCase(),
    'Ref': str(c.Ref),
    'Source System': str(c['Source System']),
    'Raw': truncateRaw(raw),
  };
  return EVENTS_HEADERS.map(h => byHeader[h] ?? '');
}

// ── Webinar registrants pushed whole ────────────────────────────────────────

const triState = (v) => { const x = yn(v); return x === 'Y' ? true : x === 'N' ? false : null; };
const numberOrNull = (v) => { const n = Number(String(v ?? '').replace(/[%,\s]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };

/** Loose keys (attended_live, "Attended Live", attendedLive) → the standard registrant object. */
function looseRegistrant(evt) {
  const k = {};
  for (const [key, v] of Object.entries(evt || {})) k[normKey(key)] = v;
  const utm = evt && evt.utm && typeof evt.utm === 'object' ? evt.utm : {};
  const first = str(k.firstname), last = str(k.lastname);
  return {
    id: str(k.registrantid || k.id),
    provider: str(k.provider || k.sourcesystem || k.system).toLowerCase() || 'webhook',
    webinar_id: str(k.webinarid), webinar_name: str(k.webinarname || k.webinartitle || k.eventname),
    session_id: str(k.sessionid || k.session), session_at: isoLoose(k.sessionat || k.sessiontime || k.sessiondate),
    email: str(k.email).toLowerCase(), name: str(k.name || k.fullname) || [first, last].filter(Boolean).join(' '), phone: str(k.phone || k.phonenumber),
    registered_at: isoLoose(k.registeredat || k.registeredtime || k.occurredat || k.timestamp),
    attended_live: triState(k.attendedlive ?? k.attended), minutes_watched: numberOrNull(k.minuteswatched), percent_watched: numberOrNull(k.percentwatched),
    stayed_to_pitch: triState(k.stayedtopitch ?? k.stayed), watched_replay: triState(k.watchedreplay ?? k.replay),
    purchased: triState(k.purchased), revenue: numberOrNull(String(k.revenue ?? k.amount ?? '').replace(/^[^\d-]+/, '')),
    utm_source: str(k.utmsource ?? utm.source), utm_medium: str(k.utmmedium ?? utm.medium), utm_campaign: str(k.utmcampaign ?? utm.campaign),
    utm_content: str(k.utmcontent ?? utm.content), utm_term: str(k.utmterm ?? utm.term), join_url: str(k.joinurl), funnel_source: str(k.funnelsource).toLowerCase(),
  };
}

/** One pushed registrant → a WEBINAR REGISTRANTS row, or null when it names nobody. */
function buildRegistrantRow(evt, receivedAt, provider) {
  const webinar = require('../sync/webinar');
  const adapter = provider ? webinar.adapter(provider) : null;
  const r = adapter ? adapter.mapRegistrant(evt) : looseRegistrant(evt);
  if (!r || !r.email) return null;
  if (!r.registered_at) r.registered_at = receivedAt;
  return webinar.toRow(r, receivedAt, 'webhook');
}

/** Body → array of event objects. Accepts one object, an array, or {events:[…]}. */
function extractEvents(body) {
  if (Array.isArray(body)) return body.filter(e => e && typeof e === 'object');
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.events)) return body.events.filter(e => e && typeof e === 'object');
  return Object.keys(body).length ? [body] : [];
}

const appendEnsuring = (rows) => appendRows(EVENTS_TAB, rows);

// ── Auth ────────────────────────────────────────────────────────────────────

// timingSafeEqual THROWS on a length mismatch, so the byte-length check is mandatory.
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}


/**
 * `Authorization: Bearer <event secret>`. No secret configured → 503 (closed, never open).
 * Returns { ok:true } or { ok:false, http, body }.
 */
function checkEventAuth(authHeader) {
  const secret = config.ingest.event_secret;
  if (!secret) {
    console.error('[event] REFUSED: no event secret is configured, route stays closed.');
    return { ok: false, http: 503, body: { status: 'error', message: 'Updates from other tools are switched off. Create the secret on the Settings page first.' } };
  }
  if (!safeEqual(authHeader, `Bearer ${secret}`)) {
    console.error('[event] REFUSED: bad or missing bearer secret');
    return { ok: false, http: 401, body: { status: 'error', message: 'unauthorized' } };
  }
  return { ok: true };
}

const NO_SHEET = 'Nowhere to save yet: storage is not connected.';

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Body = one event object, an array, or {events:[…]}. Returns { http, body }.
 * 200 {status:'ok', appended, event_ids} · 400 nothing to store · 503 no sheet connected ·
 * 500 Sheets failure.
 */
async function handleEvent(body, opts = {}) {
  // &type=sale on the address = every object in the body is a sale, in the sending tool's own shape
  const forced = str(opts.type).toLowerCase();
  const events = extractEvents(body).map(e => (forced === 'sale' ? asSale(e) : e));
  if (!events.length) {
    return { http: 400, body: { status: 'error', appended: 0, message: 'no event in body, send one object or {events:[…]}' } };
  }
  if (events.length > MAX_EVENTS_PER_CALL) {
    return { http: 400, body: { status: 'error', appended: 0, message: `too many events in one call (${events.length} > ${MAX_EVENTS_PER_CALL})` } };
  }
  if (!isConfigured()) return { http: 503, body: { status: 'error', appended: 0, message: NO_SHEET } };
  const receivedAt = new Date().toISOString();
  // &provider=<adapter> = every object in the body is that platform's own registrant payload
  const provider = str(opts.provider).toLowerCase();
  if (provider && !require('../sync/webinar').ADAPTERS[provider]) {
    return { http: 400, body: { status: 'error', appended: 0, message: `unknown provider "${provider}", use one of: ${Object.keys(require('../sync/webinar').ADAPTERS).join(', ')}` } };
  }
  const isRegistrant = (e) => Boolean(provider) || normType(pickColumns(e).Type) === `unknown:${REGISTRANT_TYPE}`;
  const rows = events.filter(e => !isRegistrant(e)).map(e => buildEventRow(e, receivedAt));
  const registrants = events.filter(isRegistrant).map(e => buildRegistrantRow(e, receivedAt, provider)).filter(Boolean);
  try {
    const appended = (rows.length ? await appendEnsuring(rows) : 0)
      + (registrants.length ? await appendRows(TABS.WEBINAR_REGISTRANTS, registrants) : 0);
    // `registrants` is only there when the call carried some — the plain event answer is unchanged
    return { http: 200, body: { status: 'ok', appended, event_ids: rows.map(r => r[0]), ...(registrants.length ? { registrants: registrants.length } : {}) } };
  } catch (e) {
    // Never a false 200: senders retry on failure and a swallowed error loses the event.
    console.error('[event] saving failed:', e.message);
    return { http: 500, body: { status: 'error', appended: 0, message: `saving failed: ${e.message}` } };
  }
}

module.exports = {
  handleEvent, checkEventAuth,
  // exported for tests / other handlers
  buildEventRow, buildRegistrantRow, looseRegistrant, extractEvents, asSale, EVENT_TYPES, RAW_MAX,
};
