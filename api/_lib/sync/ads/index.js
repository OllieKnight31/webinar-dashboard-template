// Webinar System sync — `ads` part: the connected ad platform → AD METRICS (rewrite).
//
// One row per day per ad, with the campaign and ad set it belongs to, so the engine can add
// spend up at any level. Every adapter exports:
//
//   id, label
//   connected()       → true once its credentials are saved
//   test()            → { ok, message }           never throws
//   pull(ctx, opts)   → { rows: [metric], note }  opts = { since: Date }
//   mapRow(raw)       → metric                    pure; what the tests pin down
//
//   metric = { date, account_id, campaign_id, campaign, adset_id, adset, ad_id, ad, spend,
//              impressions, link_clicks, landing_page_views, leads, currency }
//
// ADDING A PLATFORM: write api/_lib/sync/ads/<name>.js with the exports above and add one line
// to ADAPTERS below (/settings offers every key of ADAPTERS). Its credentials need their own
// fields in settings-store.js.

'use strict';

const { config } = require('../../config');
const db = require('../../db');
const { nowIso } = require('../lib/time');
const { clean } = require('../lib/classify');

// Literal requires only — the bundler does not follow computed ones.
const ADAPTERS = {
  meta: () => require('./meta'),
};

function adapter(provider = config.ads.provider) {
  const load = ADAPTERS[provider];
  return load ? load() : null;
}

const n = (v, dp) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(dp));

function toRow(m, provider, synced) {
  const byHeader = {
    'Row Key': `${provider}|${m.date}|${m.ad_id || m.adset_id || m.campaign_id}`,
    Provider: provider,
    Date: clean(m.date),
    'Account ID': clean(m.account_id),
    'Campaign ID': clean(m.campaign_id), Campaign: clean(m.campaign),
    'Ad Set ID': clean(m.adset_id), 'Ad Set': clean(m.adset),
    'Ad ID': clean(m.ad_id), Ad: clean(m.ad),
    Spend: n(m.spend, 2), Impressions: n(m.impressions, 0), 'Link Clicks': n(m.link_clicks, 0),
    'Landing Page Views': n(m.landing_page_views, 0), Leads: n(m.leads, 0),
    Currency: clean(m.currency).toUpperCase(),
    'Synced At': synced,
  };
  return db.HEADERS.AD_METRICS.map((h) => byHeader[h] ?? '');
}

async function run(ctx) {
  const a = adapter();
  if (!a) throw new Error(`No adapter for the ad platform "${config.ads.provider}"`);
  const { rows, note } = await a.pull(ctx, { since: ctx.since });
  const synced = nowIso();
  const out = rows.map((m) => toRow(m, a.id, synced));
  out.sort((x, y) => (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0));

  ctx.beginWrite();
  const written = await db.writeTab(db.TABS.AD_METRICS, db.HEADERS.AD_METRICS, out);
  const spend = rows.reduce((s, m) => s + (Number(m.spend) || 0), 0);
  return { rows: written, message: `${a.id}: rows=${written} spend=${spend.toFixed(2)}${note ? ` · ${note}` : ''}` };
}

module.exports = { run, adapter, ADAPTERS, toRow };
