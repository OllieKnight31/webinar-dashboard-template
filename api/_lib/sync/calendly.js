// Webinar System sync — `calendar` part: Calendly → BOOKINGS (rewrite).
// Read-only: users/me (→ the organisation the token belongs to) → scheduled_events starting
// inside the lookback window → invitees per event → event type per distinct URI. Round-robin
// types are not listed under /event_types?organization=, so each event's event_type URI is
// resolved individually and cached.

'use strict';

const { config } = require('../config');
const db = require('../db');
const { fetchJson, mapLimit, qs, HttpError } = require('./lib/http');
const { iso, hoursBetween, nowIso } = require('./lib/time');
const { clean, lower, safeRegex } = require('./lib/classify');

const API = 'https://api.calendly.com';

function headers() {
  return { Authorization: `Bearer ${config.calendly.token}` };
}

/** Calendly event names carry stray double spaces ("Intro  Call") — collapse them. */
const cleanName = clean;

const nameSet = (list) => new Set((Array.isArray(list) ? list : []).map(lower).filter(Boolean));

/**
 * set          a setter booked it: the name is in CALENDLY_SET_TYPES, or — only while that
 *              list is empty — it matches CALENDLY_SET_REGEX
 * self-booked  any other event type that counts as a sales call
 * other        CALENDLY_BOOKED_TYPES is filled in and this name is not on it (listed on the
 *              tab, left out of booked-call numbers)
 * An explicit set type is `set` whatever the booked list says; a regex guess never promotes
 * a type the owner left off the booked list.
 */
function bookingType(eventTypeName) {
  const name = lower(eventTypeName);
  const booked = nameSet(config.calendly.booked_types);
  const set = nameSet(config.calendly.set_types);
  if (set.size) {
    if (set.has(name)) return 'set';
    return booked.size && !booked.has(name) ? 'other' : 'self-booked';
  }
  if (booked.size && !booked.has(name)) return 'other';
  const re = safeRegex(config.calendly.set_regex);
  return re && re.test(name) ? 'set' : 'self-booked';
}

/** The setter's slug rides in utm_content on links a setter sends (utm_medium=setter|dm). */
function setterFrom(tracking) {
  const medium = lower(tracking.utm_medium);
  const source = lower(tracking.utm_source);
  const content = clean(tracking.utm_content);
  if (!content) return '';
  if (medium === 'setter' || medium === 'dm' || source === 'dm') return content.toLowerCase();
  return '';
}

function phoneFrom(invitee) {
  if (invitee.text_reminder_number) return String(invitee.text_reminder_number);
  for (const qa of invitee.questions_and_answers || []) {
    if (/phone|mobile|number/i.test(qa.question || '') && qa.answer) return String(qa.answer).trim();
  }
  return '';
}

async function listAll(url, ctx) {
  const out = [];
  let next = url;
  while (next) {
    ctx.checkBudget();
    const page = await fetchJson(next, { headers: headers() });
    out.push(...(page.collection || []));
    next = page.pagination && page.pagination.next_page ? page.pagination.next_page : null;
  }
  return out;
}

async function fetchEvents(ctx) {
  const me = await fetchJson(`${API}/users/me`, { headers: headers() });
  const user = (me && me.resource) || {};
  if (!user.current_organization) throw new Error('Calendly did not return an organisation for this token, create a new personal access token');
  const params = { min_start_time: iso(ctx.since), count: 100, sort: 'start_time:asc' };
  try {
    return await listAll(`${API}/scheduled_events${qs({ organization: user.current_organization, ...params })}`, ctx);
  } catch (e) {
    // Only an owner / admin token may list the whole organisation. A member's token still
    // gives that member's own calendar, which is the right answer for a one-person business.
    if (!(e instanceof HttpError) || e.status !== 403) throw e;
    return listAll(`${API}/scheduled_events${qs({ user: user.uri, ...params })}`, ctx);
  }
}

async function run(ctx) {
  const events = await fetchEvents(ctx);

  // Event type names, one GET per distinct URI, cached.
  const typeUris = [...new Set(events.map((e) => e.event_type).filter(Boolean))];
  const typeNames = new Map();
  await mapLimit(typeUris, 4, async (uri) => {
    try {
      const d = await fetchJson(uri, { headers: headers() });
      typeNames.set(uri, cleanName(d.resource && d.resource.name));
    } catch (e) {
      typeNames.set(uri, ''); // deleted type — fall back to the event's own name below
    }
  });

  ctx.checkBudget();
  const inviteesPerEvent = await mapLimit(events, 8, async (ev) => {
    const inv = await listAll(`${ev.uri}/invitees?count=100`, ctx);
    return inv.map((i) => ({ ev, i }));
  });

  const synced = nowIso();
  const rows = [];
  const seen = new Set();
  for (const { ev, i } of inviteesPerEvent.flat()) {
    if (!i.uri || seen.has(i.uri)) continue;
    seen.add(i.uri);
    const created = i.created_at || ev.created_at;
    const typeName = typeNames.get(ev.event_type) || cleanName(ev.name);
    const host = (ev.event_memberships || [])[0] || {};
    const tracking = i.tracking || {};
    const canc = i.cancellation || null;
    rows.push([
      i.uri,
      ev.uri,
      typeName,
      String(ev.event_type || '').split('/').pop(),
      host.user_name || '',
      host.user_email || '',
      i.status || ev.status || '',
      iso(created),
      iso(ev.start_time),
      iso(ev.end_time),
      canc && canc.created_at ? iso(canc.created_at) : '',
      canc ? (canc.canceled_by || '') : '',
      canc ? (canc.canceler_type || '') : '',
      canc ? (canc.reason || '') : '',
      i.rescheduled === true ? 'Y' : 'N',
      i.old_invitee || '',
      i.no_show ? 'Y' : 'N',
      lower(i.email),
      i.name || [i.first_name, i.last_name].filter(Boolean).join(' '),
      phoneFrom(i),
      tracking.utm_source || '',
      tracking.utm_medium || '',
      tracking.utm_campaign || '',
      tracking.utm_content || '',
      tracking.utm_term || '',
      setterFrom(tracking),
      hoursBetween(created, ev.start_time),
      bookingType(typeName),
      synced,
    ]);
  }
  rows.sort((a, b) => (a[7] < b[7] ? -1 : a[7] > b[7] ? 1 : 0));

  ctx.beginWrite();
  const written = await db.writeTab(db.TABS.BOOKINGS, db.HEADERS.BOOKINGS, rows);
  const types = {};
  rows.forEach((r) => { types[r[27]] = (types[r[27]] || 0) + 1; });
  return {
    rows: written,
    message: `events=${events.length} types=${typeUris.length} bookings=${written} (${Object.entries(types).map(([k, v]) => `${k}:${v}`).join(' ')}) since=${iso(ctx.since).slice(0, 10)}`,
  };
}

module.exports = { run, bookingType, setterFrom, cleanName };
