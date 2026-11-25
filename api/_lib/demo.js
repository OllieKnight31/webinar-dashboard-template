'use strict';
// Sample data for the Results page ("See it with sample data"): five weeks of a made-up
// weekly webinar, so a new owner can see what the page will look like before anything is
// connected. Built in memory on request and never saved. Deterministic: a seeded generator,
// never Math.random, so the same day always shows the same numbers. Every email is
// @example.com and every name is invented.

const { TABS } = require('./db');

const HOUR = 3600000, DAY = 86400000;
const FIRST = ['Avery', 'Jordan', 'Riley', 'Casey', 'Taylor', 'Jamie', 'Quinn', 'Rowan', 'Skyler', 'Reese', 'Harper', 'Logan', 'Parker', 'Sawyer', 'Blake', 'Drew', 'Elliot', 'Hayden', 'Kai', 'Robin'];
const LAST = ['Ashdown', 'Birchfield', 'Dunmere', 'Elmsworth', 'Fernhill', 'Glenmoor', 'Hazelton', 'Ivywood', 'Kestrel', 'Larkspur', 'Mapleton', 'Oakhurst', 'Pinecrest', 'Rosewater', 'Thistlewood', 'Valemont'];
const ADS = [
  ['Founder story video', 'Webinar, cold audience', 15, 0.013, 34],
  ['Three mistakes image', 'Webinar, cold audience', 19, 0.009, 22],
  ['Client result carousel', 'Webinar, cold audience', 12, 0.016, 28],
  ['Last chance reminder', 'Webinar, people who visited', 24, 0.021, 16],
];
const ORGANIC = [['instagram', 'bio', 40], ['youtube', 'video', 25], ['email', 'newsletter', 25], ['', '', 10]];
const Q1 = 'What is your biggest challenge right now?', Q2 = 'What have you already tried?';
const A1 = [['Not enough leads coming in', 34], ['Leads that never turn into calls', 26], ['No time to do the marketing', 18], ['I charge too little', 14]];
const A2 = [['Paid ads, without much luck', 30], ['Posting on social media', 34], ['Hired an agency', 14], ['Nothing yet', 22]];
// newest week first: this week's show-up dipped, so the page has something to say
const SHOW = [0.33, 0.43, 0.41, 0.4, 0.42];

function random(seed) {
  let a = 0; for (const ch of String(seed)) a = (Math.imul(a ^ ch.charCodeAt(0), 3432918353) << 13) | 0;
  const f = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  const weighted = (pairs) => { let r = f() * pairs.reduce((s, p) => s + p[p.length - 1], 0); for (const p of pairs) { r -= p[p.length - 1]; if (r < 0) return p; } return pairs[pairs.length - 1]; };
  return { f, int, weighted, pick: (xs) => xs[Math.floor(f() * xs.length)] };
}
const iso = (ms) => new Date(ms).toISOString();
const yn = (b) => (b ? 'Y' : 'N');

/** → { [tab name]: [row objects] }, the same shape db.readTabs() returns. */
function tabs(now = Date.now()) {
  const day0 = Math.floor(now / DAY) * DAY;
  const R = random(`webinar-system:${iso(day0).slice(0, 10)}`);
  const out = { [TABS.WEBINAR_REGISTRANTS]: [], [TABS.WEBINAR_SURVEY]: [], [TABS.AD_METRICS]: [], [TABS.BOOKINGS]: [], [TABS.PAYMENTS]: [], [TABS.EVENTS]: [], [TABS.SYNC_LOG]: [] };
  let n = 0;
  for (const back of [32, 25, 18, 11, 4, -3]) {
    const start = day0 - back * DAY + 19 * HOUR;
    const past = start + 2 * HOUR < now;
    const week = Math.min(4, Math.max(0, Math.floor(back / 7)));
    const total = past ? R.int(70, 92) : R.int(24, 36);
    for (let i = 0; i < total; i++) {
      n += 1;
      const email = `${R.pick(FIRST)}.${R.pick(LAST)}.${n}@example.com`.toLowerCase();
      const paid = R.f() < 0.66;
      const ad = R.weighted(ADS), org = R.weighted(ORGANIC);
      const registered = Math.min(start - R.int(2, 140) * HOUR, now - 60000);
      const came = past && R.f() < SHOW[week];
      const minutes = came ? (R.f() < 0.55 ? R.int(48, 88) : R.int(4, 47)) : '';
      const stayedToOffer = came && minutes >= 45;
      out[TABS.WEBINAR_REGISTRANTS].push({
        'Registrant ID': `demo-${n}`, Provider: 'webinarjam', 'Webinar ID': 'demo-webinar', 'Webinar Name': 'Sample live training', 'Session ID': `demo-${back}`,
        'Session At': iso(start), Email: email, 'Registered At': iso(registered), 'Attended Live': past ? yn(came) : '', 'Minutes Watched': String(minutes),
        'Stayed To Pitch': came ? yn(stayedToOffer) : '', 'Watched Replay': past ? yn(!came && R.f() < 0.16) : '', Purchased: '', Revenue: '',
        'UTM Source': paid ? 'facebook' : org[0], 'UTM Medium': paid ? 'paid' : org[1], 'UTM Campaign': paid ? ad[1] : '', 'UTM Content': paid ? ad[0] : '',
        'Funnel Source': paid ? 'paid' : 'organic', Source: 'sync', 'Synced At': iso(now - 4 * 60000),
      });
      if (R.f() < 0.4) out[TABS.WEBINAR_SURVEY].push({ 'Submitted At': iso(Math.min(registered + 5 * 60000, now)), Email: email, 'Question 1': Q1, 'Answer 1': R.weighted(A1)[0], 'Question 2': Q2, 'Answer 2': R.weighted(A2)[0] });
      // about one attendee in six who stayed books a call a day or two later
      if (stayedToOffer && R.f() < 0.2) {
        const created = start + R.int(1, 30) * HOUR, callAt = created + R.int(20, 70) * HOUR;
        if (created < now) {
          const noShow = callAt < now && R.f() < 0.28;
          out[TABS.BOOKINGS].push({ 'Invitee URI': `demo-call-${n}`, 'Event Type': 'Strategy call', Status: 'active', 'Created At': iso(created), 'Start At': iso(callAt), Email: email, 'Calendly No Show': yn(noShow), 'Booking Type': 'self-booked' });
          if (callAt < now && !noShow && R.f() < 0.3) out[TABS.PAYMENTS].push({ 'Object ID': `demo-pay-${n}`, Kind: 'charge', Amount: '3000.00', Status: 'succeeded', 'Created At': iso(Math.min(callAt + 2 * HOUR, now)), Email: email, Excluded: 'N' });
        }
      }
    }
  }
  for (let back = 34; back >= 0; back--) {
    const date = iso(day0 - back * DAY).slice(0, 10);
    ADS.forEach(([ad, campaign, cpm, ctr], i) => {
      const spend = R.int(900, 2100) / 100 * [1.25, 0.9, 1.05, 0.6][i];
      const impressions = Math.round(spend / cpm * 1000), clicks = Math.round(impressions * ctr * (0.85 + R.f() * 0.3)), lpv = Math.round(clicks * 0.78);
      out[TABS.AD_METRICS].push({ 'Row Key': `demo|${date}|${i}`, Provider: 'meta', Date: date, Campaign: campaign, 'Ad ID': `demo-ad-${i}`, Ad: ad, Spend: spend.toFixed(2),
        Impressions: String(impressions), 'Link Clicks': String(clicks), 'Landing Page Views': String(lpv), Leads: String(Math.round(lpv * (0.24 + R.f() * 0.1))) });
    });
  }
  for (const part of ['calendar', 'payments', 'webinar', 'ads']) out[TABS.SYNC_LOG].push({ 'Run At': iso(now - 4 * 60000), Part: part, Rows: '1', Status: 'ok', 'Duration Ms': '900', Message: '', Runner: 'cron' });
  return out;
}

module.exports = { tabs };
