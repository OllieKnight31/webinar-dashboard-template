'use strict';
// The Results page: the webinar funnel for one period, the biggest leak in one sentence, and
// what to fix first.
//
// WHO IS COUNTED
//   Everyone who SIGNED UP in the period. Every later step follows those same people, so no
//   step ever divides one set of people by another.
//
//   visits → sign-ups → attended live → stayed to the offer → booked a call → showed → bought
//   (+ watched the replay, off to one side)
//
// WHERE EACH STEP COMES FROM
//   sign-ups, attendance    WEBINAR REGISTRANTS: the webinar platform (Source = sync), sign-ups
//                           sent by your landing page (relay) or another tool (webhook), plus
//                           single steps in EVENTS. One person's rows are merged into one record.
//   visits, ad spend        AD METRICS (Meta)
//   booked, showed          BOOKINGS (Calendly), matched by email, booked after signing up.
//                           A past call counts as "showed" unless it was cancelled or marked a
//                           no-show in Calendly.
//   bought, revenue         PAYMENTS (the payment tool) or a sale the tool sent us, by the same email after signing up, or a purchase
//                           the webinar platform reported.
//
// UNKNOWN IS NOT ZERO
//   attended / stayed / replay / purchased are true, false or null. Something a tool does not
//   report stays null: the step reads "not known yet" and its rate is not judged.

const db = require('./db');
const { config, connections } = require('./config');
const U = require('./util');

const HOUR = 3600000;
const PAID_RE = /paid|cpc|ppc|\bads?\b|sponsored/;
const tri = (v) => { const s = U.str(v); return s === '' ? null : U.bool(s); };
const anyTri = (a, b) => (a === true || b === true ? true : a === false || b === false ? false : null);
const maxNum = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
const pct = (r) => `${Math.round(r * 1000) / 10}%`;

// What each number means, and what to look at first when it is under target. Plain words:
// this is the text on the page.
const GUIDE = {
  registration_rate: { label: 'Sign-up rate', means: 'Of the people who visited your sign-up page, how many signed up.',
    fix: 'Look at your headline first, then whether the page matches what the ad promised, then how many boxes the form asks for.' },
  show_up_rate: { label: 'Show-up rate', means: 'Of the people who signed up, how many came to the webinar live.',
    fix: 'Look at your confirmation page first, then your reminder emails and texts, then shorten the gap between signing up and the webinar.' },
  stay_to_pitch_rate: { label: 'Stayed to the offer', means: 'Of the people who came, how many were still watching when you made your offer.',
    fix: 'Look at your opening ten minutes first, and promise something worth waiting for at the end.' },
  booking_rate: { label: 'Booking rate', means: 'Of the people who came live, how many booked a call with you.',
    fix: 'Give one clear next step and say it three times. Put the booking link in the chat and in the first follow-up email.' },
  call_show_rate: { label: 'Call show rate', means: 'Of the calls that were booked, how many people turned up.',
    fix: 'Look at your booking confirmation messages first, and offer call times within the next 48 hours.' },
  close_rate: { label: 'Close rate', means: 'Of the people who turned up to a call, how many bought.',
    fix: 'Look at who is being booked first, then at the sales conversation itself.' },
  replay_rate: { label: 'Replay rate', means: 'Of the people who signed up, how many watched the replay.',
    fix: 'Send the replay sooner, and give it a real deadline.' },
};
const LEAK = {
  registration_rate: (r, t) => `Your biggest leak is the sign-up page: ${pct(r)} of visitors sign up, and your target is ${pct(t)}.`,
  show_up_rate: (r, t) => `Your biggest leak is show-up: ${pct(r)} of the people who signed up came live, and your target is ${pct(t)}.`,
  stay_to_pitch_rate: (r, t) => `Your biggest leak is people leaving early: ${pct(r)} of the people who came were still there for your offer, and your target is ${pct(t)}.`,
  booking_rate: (r, t) => `Your biggest leak is booking: ${pct(r)} of the people who came live booked a call, and your target is ${pct(t)}.`,
  call_show_rate: (r, t) => `Your biggest leak is missed calls: ${pct(r)} of booked calls turned up, and your target is ${pct(t)}.`,
  close_rate: (r, t) => `Your biggest leak is the sales call: ${pct(r)} of the people who turned up bought, and your target is ${pct(t)}.`,
};

// ── Rows ────────────────────────────────────────────────────────────────────
const norm = (rows) => (rows || []).map(r => { const o = {}; for (const [key, v] of Object.entries(r)) o[key.toLowerCase()] = U.str(v); return o; });

function blank(o) {
  return { id: '', provider: '', webinarId: '', webinarName: '', sessionId: '', sessionMs: null, email: null, registeredMs: null, attended: null,
    minutes: null, percent: null, stayedFlag: null, replay: null, purchased: null, revenue: null, utm_source: '', utm_medium: '', utm_campaign: '',
    utm_content: '', funnelSource: '', source: 'sync', atMs: null, ...o };
}
/** Fold what `b` knows into `a`: `a` keeps what it has, unknowns are filled. */
function merge(a, b) {
  for (const key of ['provider', 'webinarId', 'webinarName', 'sessionId', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'funnelSource']) if (!a[key] && b[key]) a[key] = b[key];
  if (a.sessionMs == null) a.sessionMs = b.sessionMs;
  if (a.registeredMs == null) a.registeredMs = b.registeredMs;
  for (const key of ['attended', 'stayedFlag', 'replay', 'purchased']) a[key] = anyTri(a[key], b[key]);
  for (const key of ['minutes', 'percent', 'revenue']) a[key] = maxNum(a[key], b[key]);
  return a;
}
const fromRow = (r) => blank({
  id: r['registrant id'], provider: r.provider.toLowerCase(), webinarId: r['webinar id'], webinarName: r['webinar name'], sessionId: r['session id'],
  sessionMs: U.ts(r['session at']), email: U.email(r.email), registeredMs: U.ts(r['registered at']), attended: tri(r['attended live']),
  minutes: U.num(r['minutes watched']), percent: U.num(r['percent watched']), stayedFlag: tri(r['stayed to pitch']), replay: tri(r['watched replay']),
  purchased: tri(r.purchased), revenue: U.num(r.revenue), utm_source: r['utm source'], utm_medium: r['utm medium'], utm_campaign: r['utm campaign'],
  utm_content: r['utm content'], funnelSource: r['funnel source'].toLowerCase(), source: r.source.toLowerCase() || 'sync',
  atMs: U.ts(r['registered at']) || U.ts(r['synced at']),
});
const EVENT_KIND = { webinar_registered: 'registered', webinar_attended: 'attended', webinar_stayed: 'stayed', webinar_replay: 'replay', webinar_purchase: 'purchase' };
function fromEvent(e) {
  const kind = EVENT_KIND[e.type.toLowerCase().replace(/^unknown:/, '')];
  const email = U.email(e.email);
  if (!kind || !email) return null;
  let raw = {}; try { raw = e.raw ? JSON.parse(e.raw) : {}; } catch { raw = {}; }
  const at = U.ts(e['occurred at']) || U.ts(e['received at']);
  const o = blank({ email, webinarId: U.str(raw.webinar_id), sessionMs: U.ts(raw.session_at), utm_source: e['utm source'], utm_medium: e['utm medium'],
    utm_campaign: e['utm campaign'], utm_content: e['utm content'], minutes: U.num(raw.minutes_watched), percent: U.num(raw.percent_watched),
    funnelSource: U.str(raw.funnel_source).toLowerCase(), source: 'event', atMs: at });
  if (kind === 'registered') o.registeredMs = at;
  if (kind === 'attended') o.attended = true;
  if (kind === 'stayed') { o.attended = true; o.stayedFlag = true; }
  if (kind === 'replay') o.replay = true;
  if (kind === 'purchase') { o.purchased = true; o.revenue = U.num(e.amount); }
  return o;
}

/**
 * One record per sign-up. Rows sharing an id are folded together; then every row that did not
 * come from the platform is folded into the platform's record for the same email (same
 * webinar when both name one, nearest in time), or stands alone when the platform has none.
 */
function registrants(tabs) {
  const byId = new Map(); const loose = [];
  for (const row of tabs.registrants) {
    const r = fromRow(row);
    if (!r.email) continue;
    if (r.id && byId.has(r.id)) merge(byId.get(r.id), r); else if (r.id) byId.set(r.id, r); else loose.push(r);
  }
  const rows = [...byId.values(), ...loose];
  const primary = rows.filter(r => r.source === 'sync');
  const pushed = [...rows.filter(r => r.source !== 'sync'), ...tabs.events.map(fromEvent).filter(Boolean)].sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  const byEmail = U.groupBy(primary, r => r.email);
  for (const p of pushed) {
    let best = null, gap = Infinity;
    for (const r of (byEmail[p.email] || [])) {
      if (p.webinarId && r.webinarId && r.webinarId !== p.webinarId) continue;
      const g = Math.abs((r.registeredMs || r.atMs || 0) - (p.atMs || 0));
      if (g < gap) { best = r; gap = g; }
    }
    // a second sign-up by the same person, days later, is a sign-up of its own
    if (best && !(p.registeredMs != null && best.registeredMs != null && gap > 36 * HOUR)) { merge(best, p); continue; }
    (byEmail[p.email] = byEmail[p.email] || []).push(p);
    primary.push(p);
  }
  for (const r of primary) if (r.registeredMs == null) r.registeredMs = r.atMs;
  return primary;
}

/** true / false, or null when nothing says. */
function stayed(r) {
  const w = config.webinar;
  if (r.stayedFlag === true) return true;
  if (r.attended === false) return false;
  if (r.minutes != null && w.pitch_minute != null) return r.minutes >= w.pitch_minute;
  if (r.percent != null && w.pitch_percent != null) return r.percent >= w.pitch_percent;
  return r.stayedFlag;
}
const isPaid = (r) => (r.funnelSource ? r.funnelSource === 'paid' : PAID_RE.test(`${r.utm_medium} ${r.utm_source}`.toLowerCase()));
const sourceOf = (r) => (isPaid(r) ? 'Paid ads' : (r.utm_source ? U.titleCase(r.utm_source) : 'Not known'));

function parseRange(query, tz, now) {
  const today = U.dateIn(now, tz);
  let to = U.isDateStr(U.str(query.to)) ? U.str(query.to) : today;
  let from = U.isDateStr(U.str(query.from)) ? U.str(query.from) : U.addDays(to, -6);
  if (from > to) [from, to] = [to, from];
  return { from, to, days: U.daysInclusive(from, to), today };
}
function safeTz(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return 'UTC'; } }

function syncInfo(log, now) {
  const rows = log.map(r => ({ at: U.ts(r['run at']), part: r.part, status: r.status.toLowerCase() || 'ok', message: r.message, rows: U.num(r.rows) || 0 })).filter(r => r.at != null).sort((a, b) => a.at - b.at);
  const latest = {};
  for (const r of rows) latest[r.part] = r;
  const ok = rows.filter(r => r.status === 'ok').pop();
  return {
    last_run: ok ? new Date(ok.at).toISOString() : null, minutes_ago: ok ? Math.round((now - ok.at) / 60000) : null,
    parts: Object.values(latest).map(r => ({ part: r.part, status: r.status, message: r.message, rows: r.rows, at: new Date(r.at).toISOString() })),
  };
}

// ── The page ────────────────────────────────────────────────────────────────
/** @param {object} query from, to   @param {{now?: number}} opts clock override (tests) */
async function getResults(query = {}, opts = {}) {
  const now = opts.now || Date.now();
  // ?demo=1: the same sums over made-up data, built on the spot and never saved
  const demo = Boolean(query.demo);
  const connected = demo ? { webinar: true, crm: false, calendar: true, payments: true, ads: true } : connections();
  const base = { generated_at: new Date(now).toISOString(), demo, brand: { name: config.brand.name, currency_symbol: config.brand.currency_symbol }, connected };
  if (!demo && !db.isConfigured()) return { ...base, status: 'setup', message: 'Nowhere to save data yet. Storage needs to be connected first.' };

  const T = db.TABS;
  const raw = demo ? require('./demo').tabs(now)
    : await db.readTabs([T.WEBINAR_REGISTRANTS, T.EVENTS, T.BOOKINGS, T.PAYMENTS, T.AD_METRICS, T.WEBINAR_SURVEY, T.SYNC_LOG]);
  const tabs = { registrants: norm(raw[T.WEBINAR_REGISTRANTS]), events: norm(raw[T.EVENTS]), bookings: norm(raw[T.BOOKINGS]), payments: norm(raw[T.PAYMENTS]),
    ads: norm(raw[T.AD_METRICS]), survey: norm(raw[T.WEBINAR_SURVEY]), log: norm(raw[T.SYNC_LOG]) };
  const tz = safeTz(config.brand.timezone);
  const range = parseRange(query, tz, now);
  const inRange = (ms) => { if (ms == null) return false; const d = U.dateIn(ms, tz); return d >= range.from && d <= range.to; };
  const min = Math.max(1, config.min_sample);

  const all = registrants(tabs);
  const have = all.length > 0 || connected.webinar;
  const cohort = all.filter(r => inRange(r.registeredMs));

  // attendance: show-up is judged only on people whose webinar has already happened
  const isDue = (r) => (r.sessionMs != null ? r.sessionMs <= now : r.attended !== null);
  const due = cohort.filter(isDue);
  const dueKnown = due.filter(r => r.attended !== null);
  const attKnown = cohort.some(r => r.attended !== null);
  const attended = cohort.filter(r => r.attended === true);
  const stayedOf = attended.map(stayed);
  const stayKnown = stayedOf.filter(v => v !== null).length, stayedN = stayedOf.filter(v => v === true).length;
  const replayKnown = cohort.some(r => r.replay !== null);
  const replayed = cohort.filter(r => r.replay === true);

  // calls: the first sales call each person booked after signing up
  const seen = new Set();
  const calls = tabs.bookings.filter(b => { const id = b['invitee uri']; if (seen.has(id)) return false; seen.add(id); return true; })
    .map(b => ({ email: U.email(b.email), createdMs: U.ts(b['created at']), startMs: U.ts(b['start at']), cancelled: /^cancel/i.test(b.status), noShow: U.bool(b['calendly no show']), other: b['booking type'].toLowerCase() === 'other' }))
    .filter(b => b.email && !b.other && !b.cancelled);
  const callsKnown = connected.calendar || tabs.bookings.length > 0;
  const callsByEmail = U.groupBy(calls, b => b.email);
  const callOf = new Map();
  for (const r of cohort) { const b = (callsByEmail[r.email] || []).find(x => (x.createdMs || 0) >= (r.registeredMs || 0) - HOUR); if (b) callOf.set(r, b); }
  const booked = cohort.filter(r => callOf.has(r));
  const bookedLive = booked.filter(r => r.attended === true);
  const past = booked.filter(r => callOf.get(r).startMs != null && callOf.get(r).startMs <= now);
  const showed = past.filter(r => !callOf.get(r).noShow), noShow = past.filter(r => callOf.get(r).noShow);

  // sales
  const charges = tabs.payments.filter(p => p.kind.toLowerCase() === 'charge' && !U.bool(p.excluded) && U.email(p.email));
  // a payment tool we cannot read can send each sale itself (type "sale"); those count the same way
  const sentSales = tabs.events.filter(e => e.type.toLowerCase() === 'sale' && U.email(e.email) && (U.num(e.amount) || 0) > 0);
  const paidByEmail = U.groupBy([...charges.map(p => ({ email: U.email(p.email), ms: U.ts(p['created at']), amount: U.num(p.amount) || 0 })),
    ...sentSales.map(e => ({ email: U.email(e.email), ms: U.ts(e['occurred at']) || U.ts(e['received at']), amount: U.num(e.amount) || 0 }))], p => p.email);
  const revenueOf = (r) => { const paid = (paidByEmail[r.email] || []).filter(p => (p.ms || 0) >= (r.registeredMs || 0) - HOUR); return paid.length ? U.sum(paid.map(p => p.amount)) : (r.revenue || 0); };
  const bought = (r) => r.purchased === true || revenueOf(r) > 0;
  const salesKnown = connected.payments || tabs.payments.length > 0 || sentSales.length > 0 || cohort.some(r => r.purchased !== null);
  const buyers = cohort.filter(bought);
  const revenue = U.round(U.sum(buyers.map(revenueOf)), 2);

  // ads
  const adsKnown = connected.ads || tabs.ads.length > 0;
  const ads = tabs.ads.filter(a => U.isDateStr(a.date) && a.date >= range.from && a.date <= range.to)
    .map(a => ({ ad: a.ad, adId: a['ad id'], campaign: a.campaign, spend: U.num(a.spend) || 0, impressions: U.num(a.impressions) || 0, clicks: U.num(a['link clicks']) || 0, lpv: U.num(a['landing page views']) || 0, leads: U.num(a.leads) || 0 }));
  const spend = adsKnown ? U.round(U.sum(ads.map(a => a.spend)), 2) : null;
  const lpv = U.sum(ads.map(a => a.lpv)), clicks = U.sum(ads.map(a => a.clicks));
  const visits = adsKnown ? (lpv > 0 ? lpv : clicks) : null;
  // visits are paid traffic, so they are compared with paid sign-ups whenever sign-ups say where they came from
  const attributed = cohort.some(r => r.funnelSource || r.utm_source || r.utm_medium);
  const paidRegs = attributed ? cohort.filter(isPaid).length : cohort.length;

  // rates: [value, how many it is judged on]
  const rate = {
    registration_rate: [have && visits ? U.ratio(paidRegs, visits) : null, visits || 0],
    show_up_rate: [attKnown ? U.ratio(dueKnown.filter(r => r.attended).length, dueKnown.length) : null, dueKnown.length],
    stay_to_pitch_rate: [stayKnown ? U.ratio(stayedN, stayKnown) : null, stayKnown],
    booking_rate: [callsKnown && attKnown ? U.ratio(bookedLive.length, attended.length) : null, attended.length],
    call_show_rate: [callsKnown ? U.ratio(showed.length, past.length) : null, past.length],
    close_rate: [callsKnown && salesKnown ? U.ratio(showed.filter(bought).length, showed.length) : null, showed.length],
    replay_rate: [replayKnown ? U.ratio(replayed.length, due.length) : null, due.length],
  };
  const why = {
    registration_rate: adsKnown ? 'No ad visits in this period yet.' : 'Connect your ads to see this.',
    show_up_rate: have ? 'Nobody’s webinar has happened yet in this period.' : 'Connect your webinar platform to see this.',
    stay_to_pitch_rate: attended.length ? 'Your webinar platform does not say who stayed. Tell us the minute your offer starts (Settings, Webinar platform, More options).' : 'Nobody has attended yet in this period.',
    booking_rate: callsKnown ? 'Nobody has attended yet in this period.' : 'Connect your calendar to see this.',
    call_show_rate: callsKnown ? 'No booked calls have happened yet in this period.' : 'Connect your calendar to see this.',
    close_rate: !callsKnown ? 'Connect your calendar to see this.' : !salesKnown ? 'Connect your payments to see this.' : 'No calls have happened yet in this period.',
    replay_rate: have ? 'Your webinar platform does not report replay views.' : 'Connect your webinar platform to see this.',
  };
  const grade = (key) => {
    const [value, n] = rate[key]; const target = key === 'replay_rate' ? null : config.targets[key];
    if (value == null || !(target > 0) || n < min) return 'na';
    const r = value / target;
    return r >= 1 ? 'ok' : r >= 0.7 ? 'warn' : 'crit';
  };
  const rateTile = (key) => {
    const [value, n] = rate[key]; const status = grade(key); const target = key === 'replay_rate' ? null : (config.targets[key] > 0 ? config.targets[key] : null);
    return { key, label: GUIDE[key].label, value, unit: 'pct', target, status, n, means: GUIDE[key].means,
      fix: status === 'warn' || status === 'crit' ? GUIDE[key].fix : '',
      note: value == null ? why[key] : (n < min && target ? `Only ${n} so far, which is too few to judge.` : '') };
  };
  const per = (n) => (spend != null && n > 0 ? U.round(spend / n, 2) : null);
  const adsWhy = adsKnown ? '' : 'Connect your ads to see this.';
  const moneyTile = (key, label, value, means, note) => ({ key, label, value, unit: 'money', target: null, status: 'na', means, fix: '', note: value == null ? (note || adsWhy || 'Not enough yet to work this out.') : '' });

  const tiles = [
    { key: 'registrations', label: 'Sign-ups', value: have ? cohort.length : null, unit: 'count', target: null, status: 'na', means: 'People who signed up for your webinar in this period.', fix: '',
      note: have ? '' : 'Connect your webinar platform, or point your sign-up form at this app, to see this.' },
    ...['registration_rate', 'show_up_rate', 'stay_to_pitch_rate', 'booking_rate', 'call_show_rate', 'close_rate', 'replay_rate'].map(rateTile),
    moneyTile('revenue', 'Sales from these sign-ups', salesKnown ? revenue : null, 'Money paid by the people who signed up in this period.', 'Connect your payments to see this.'),
    moneyTile('ad_spend', 'Ad spend', spend, 'What you spent on ads in this period.'),
    moneyTile('cost_per_registration', 'Cost per sign-up', per(cohort.length), 'Ad spend divided by sign-ups.'),
    moneyTile('cost_per_attendee', 'Cost per attendee', per(attended.length), 'Ad spend divided by people who came live.'),
    moneyTile('cost_per_booked_call', 'Cost per booked call', per(booked.length), 'Ad spend divided by calls booked.'),
    moneyTile('cost_per_sale', 'Cost per sale', per(buyers.length), 'Ad spend divided by sales.'),
    { key: 'roas', label: 'Return on ad spend', value: spend > 0 && salesKnown ? U.round(revenue / spend, 2) : null, unit: 'times', target: null, status: 'na', means: 'For every 1 you spent on ads, how much came back in sales.', fix: '',
      note: spend > 0 && salesKnown ? '' : (adsWhy || 'Connect your payments to see this.') },
  ];

  const upcoming = cohort.length - due.length;
  const step = (key, label, count, rateKey, note) => ({ key, label, count, rate: rateKey ? rate[rateKey][0] : null, status: rateKey ? grade(rateKey) : 'na', note: note || '' });
  const steps = [
    ...(adsKnown ? [step('visits', lpv > 0 || !clicks ? 'Page visits' : 'Ad clicks', visits, null, 'From your ads')] : []),
    step('registrations', 'Signed up', have ? cohort.length : null, 'registration_rate', upcoming > 0 ? `${upcoming} are for a webinar that has not happened yet` : ''),
    step('attended', 'Came live', have && attKnown ? attended.length : null, 'show_up_rate'),
    step('stayed', 'Stayed to the offer', stayKnown ? stayedN : null, 'stay_to_pitch_rate'),
    step('booked', 'Booked a call', callsKnown ? booked.length : null, 'booking_rate'),
    step('showed', 'Turned up to the call', callsKnown ? showed.length : null, 'call_show_rate'),
    step('bought', 'Bought', salesKnown ? buyers.length : null, 'close_rate'),
  ];
  const side = { key: 'replay', label: 'Watched the replay', count: have && replayKnown ? replayed.length : null, rate: rate.replay_rate[0] };

  // the biggest leak: the graded rate furthest below its target
  let leak = null;
  for (const key of Object.keys(LEAK)) {
    const [value, n] = rate[key]; const target = config.targets[key];
    if (value == null || !(target > 0) || n < min) continue;
    const score = value / target;
    if (!leak || score < leak.score) leak = { key, score: U.round(score, 2), value, target, status: grade(key), sentence: LEAK[key](value, target), fix: GUIDE[key].fix, label: GUIDE[key].label };
  }
  if (leak && leak.status === 'ok') { leak.sentence = 'Every step we can measure is on target. Nice work.'; leak.fix = ''; }

  // ── Tables ──
  const line = (label, rs, extra = []) => {
    const d = rs.filter(r => isDue(r) && r.attended !== null), att = rs.filter(r => r.attended === true);
    return [label, ...extra, rs.length, rs.some(r => r.attended !== null) ? att.length : null, d.length ? U.ratio(att.length, d.length) : null,
      callsKnown ? rs.filter(r => callOf.has(r)).length : null, salesKnown ? rs.filter(bought).length : null];
  };
  const sessionKey = (r) => (r.sessionMs != null ? new Date(r.sessionMs).toISOString().slice(0, 16) : '');
  const bySession = Object.entries(U.groupBy(cohort, sessionKey)).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 40)
    .map(([key, rs]) => line(key ? `${key}:00Z` : 'Date not known', rs));
  const bySource = Object.entries(U.groupBy(cohort, sourceOf)).sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([s, rs]) => line(s, rs));
  const byAd = Object.values(U.groupBy(ads, a => a.adId || `${a.campaign}|${a.ad}`)).map((rs) => {
    const s = U.sum(rs.map(a => a.spend)), imp = U.sum(rs.map(a => a.impressions)), lc = U.sum(rs.map(a => a.clicks)), leads = U.sum(rs.map(a => a.leads));
    return [rs[0].ad || rs[0].campaign, rs[0].campaign, U.round(s, 2), imp > 0 ? U.round(lc / imp, 4) : null, lc > 0 ? U.round(s / lc, 2) : null, leads, leads > 0 ? U.round(s / leads, 2) : null];
  }).sort((a, b) => b[2] - a[2]).slice(0, 30);
  const answers = [];
  for (const r of tabs.survey) {
    const ms = U.ts(r['submitted at']);
    if (!inRange(ms)) continue;
    for (const i of [1, 2, 3]) if (r[`answer ${i}`]) answers.push({ ms, question: r[`question ${i}`] || `Question ${i}`, answer: r[`answer ${i}`] });
  }
  answers.sort((a, b) => b.ms - a.ms);
  const topAnswers = Object.entries(U.countBy(answers, a => `${a.question}\u0001${a.answer.toLowerCase()}`)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, n]) => {
    const [q, a] = key.split('\u0001');
    const spellings = U.countBy(answers.filter(x => x.question === q && x.answer.toLowerCase() === a).reverse(), x => x.answer);
    return [q, Object.entries(spellings).sort((x, y) => y[1] - x[1])[0][0], n];
  });
  const table = (key, title, columns, rows, note) => ({ key, title, columns, rows, note: note || '' });
  const PEOPLE = ['Signed up', 'Came live', 'Show-up rate', 'Booked a call', 'Bought'];
  const tables = [
    table('by_session', 'By webinar date', ['Webinar', ...PEOPLE], bySession, 'People who signed up in this period, grouped by the webinar they signed up for.'),
    table('by_source', 'By where they came from', ['Came from', ...PEOPLE], bySource, attributed || !cohort.length ? '' : 'Your sign-ups do not say where they came from yet. Point your sign-up form at this app (Setup, Go live) to see this.'),
    table('by_ad', 'By ad', ['Ad', 'Campaign', 'Spend', 'Click rate', 'Cost per click', 'Sign-ups (counted by the ad platform)', 'Cost per sign-up'], byAd, adsWhy),
    table('survey_top', 'What people who signed up told us', ['Question', 'Answer', 'How many'], topAnswers, 'From the short survey on your confirmation page.'),
    table('survey_latest', 'Latest answers', ['When', 'Question', 'Answer'], answers.slice(0, 20).map(a => [new Date(a.ms).toISOString(), a.question, a.answer])),
  ];

  return { ...base, status: 'ok', range, steps, side, leak, tiles, tables, sync: syncInfo(tabs.log, now), has_data: all.length > 0,
    notes: [
      'We follow everyone who signed up in this period through every later step.',
      ...(callsKnown ? ['A booked call counts as "turned up" once its time has passed, unless it was cancelled or marked as a no-show in your calendar.'] : []),
      ...(cohort.some(r => r.provider === 'aevent') ? ['aEvent tells us who came, but not for how long, so "stayed to the offer" and replay views are not known.'] : []),
    ] };
}

module.exports = { getResults, registrants, stayed, GUIDE };
