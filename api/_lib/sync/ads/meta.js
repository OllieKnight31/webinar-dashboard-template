// Ads adapter — Meta (Facebook / Instagram), Marketing API insights.
//
//   GET https://graph.facebook.com/v21.0/act_<id>/insights
//       level=ad · time_increment=1 (one row per ad per day) · time_range={since,until}
//       fields=campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,
//              inline_link_clicks,actions,account_currency
//       paging: follow paging.next until it is absent
//   auth   an access token with ads_read (a system user token does not expire). It travels in
//          the Authorization header, never in the URL, so it cannot end up in a log.
//
// Leads = the registration conversion the pixel reported, taken from `actions` by the first
// action type present in LEAD_ACTIONS. Landing page views likewise from LPV_ACTIONS. Both are
// what Meta attributes to the ad, not what the webinar platform counted.
// Insights go back 37 months at most; the lookback is capped accordingly.

'use strict';

const { config } = require('../../config');
const { fetchJson, qs, HttpError } = require('../lib/http');
const { localDate } = require('../lib/time');
const { clean, lower } = require('../lib/classify');

const GRAPH = 'https://graph.facebook.com/v21.0';
const FIELDS = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,inline_link_clicks,actions,account_currency';
const MAX_PAGES = 400;
const MAX_LOOKBACK_DAYS = 36 * 30;

const id = 'meta';
const label = 'Meta ads';

// A webinar registration, by priority: the first type present wins (they overlap, so they
// are never added together).
const LEAD_ACTIONS = [
  'omni_complete_registration', 'offsite_conversion.fb_pixel_complete_registration',
  'offsite_complete_registration_add_meta_leads', 'complete_registration',
  'offsite_conversion.fb_pixel_lead', 'lead',
];
const LPV_ACTIONS = ['omni_landing_page_view', 'landing_page_view'];

function pickAction(actions, types) {
  if (!Array.isArray(actions)) return null;
  for (const t of types) {
    const a = actions.find((x) => x && x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}

const connected = () => Boolean(config.ads.meta.access_token && config.ads.meta.ad_account_id);
const headers = () => ({ Authorization: `Bearer ${config.ads.meta.access_token}` });
const account = () => { const a = clean(config.ads.meta.ad_account_id); return a.startsWith('act_') ? a : `act_${a}`; };

function explain(e) {
  const body = e instanceof HttpError ? String(e.body || '') : '';
  if (/OAuthException|access token|190/i.test(body) || (e instanceof HttpError && e.status === 401)) return 'That did not work: Meta rejected the key. It may have expired. Create a new one with ads_read ticked.';
  if (e instanceof HttpError && e.status === 403) return 'That did not work: the key cannot see this ad account. Give the system user access to the ad account, then try again.';
  return 'That did not work: Meta did not answer properly. Try again in a minute.';
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function mapRow(raw) {
  const d = raw || {};
  return {
    date: clean(d.date_start),
    account_id: account(),
    campaign_id: clean(d.campaign_id), campaign: clean(d.campaign_name),
    adset_id: clean(d.adset_id), adset: clean(d.adset_name),
    ad_id: clean(d.ad_id), ad: clean(d.ad_name),
    spend: num(d.spend) || 0,
    impressions: num(d.impressions) || 0,
    link_clicks: num(d.inline_link_clicks) || 0,
    // no `actions` at all on a row = Meta reported no conversions for it, which is a real 0
    landing_page_views: pickAction(d.actions, LPV_ACTIONS) || 0,
    leads: pickAction(d.actions, LEAD_ACTIONS) || 0,
    currency: clean(d.account_currency),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function pull(ctx, opts = {}) {
  const floor = Date.now() - MAX_LOOKBACK_DAYS * 86400000;
  const since = localDate(new Date(Math.max(floor, opts.since ? opts.since.getTime() : floor)));
  const until = localDate(new Date());
  let url = `${GRAPH}/${account()}/insights${qs({ level: 'ad', time_increment: 1, time_range: JSON.stringify({ since, until }), fields: FIELDS, limit: 500 })}`;
  const raw = [];
  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGES) throw new Error(`Meta insights: more than ${MAX_PAGES} pages, lower "How far back to sync" on the settings page`);
    if (ctx) ctx.checkBudget();
    let data;
    try { data = await fetchJson(url, { headers: headers() }); } catch (e) { throw new Error(explain(e)); }
    raw.push(...((data && data.data) || []));
    url = data && data.paging && data.paging.next ? data.paging.next : null;
  }
  const filter = lower(config.ads.meta.campaign_filter);
  const rows = raw.map(mapRow).filter((m) => m.date && (!filter || lower(m.campaign).includes(filter)));
  return { rows, note: `${since} to ${until}${filter ? ` · campaigns containing "${filter}"` : ''}` };
}

async function test() {
  const { access_token, ad_account_id } = config.ads.meta;
  if (!access_token || !ad_account_id) return { ok: false, message: 'Paste your Meta key and your ad account first, then check again.' };
  try {
    const d = await fetchJson(`${GRAPH}/${account()}${qs({ fields: 'name,currency,account_status' })}`, { headers: headers(), retries: 1 });
    const live = Number(d.account_status) === 1 ? '' : ' The account is not active, so there may be no spend to read.';
    return { ok: true, message: `Connected. We found your ad account “${clean(d.name) || account()}”.${live}`, name: clean(d.name), currency: clean(d.currency) };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

module.exports = { id, label, connected, test, pull, mapRow, pickAction, LEAD_ACTIONS, LPV_ACTIONS };
