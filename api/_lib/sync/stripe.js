// Webinar System sync — `payments` part: Stripe → PAYMENTS (rewrite) + PRICE MAP (append).
// Read-only; a restricted key with read access to charges, payment intents, refunds, disputes,
// payouts, subscriptions, checkout sessions, invoices, prices and products is enough.
//
// No Stripe-Version header is sent, so each account answers in its own default API version
// (a pinned version can be newer than an account allows). The joins below therefore read both
// shapes: older versions put `invoice` on the charge and `price` on the invoice line; newer
// ones (2025-03 onwards) drop both — the price sits under lines.data[].pricing.price_details
// and a subscription charge's invoice id is on its payment intent
// (payment_details.order_reference).

'use strict';

const { config } = require('../config');
const db = require('../db');
const { fetchJson, qs, HttpError } = require('./lib/http');
const { iso, nowIso, localDate } = require('./lib/time');
const { offerFor, clean, lower } = require('./lib/classify');

const API = 'https://api.stripe.com/v1';

function headers() {
  return { Authorization: `Bearer ${config.stripe.secret_key}` };
}

// Stripe amounts are in the currency's smallest unit — except these, which have none.
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const cur = (c) => String(c || config.command.currency_code || 'USD').toUpperCase();
const major = (minor, currency) => (Number(minor || 0) / (ZERO_DECIMAL.has(cur(currency)) ? 1 : 100)).toFixed(2);
const idOf = (v) => (v && typeof v === 'object' ? v.id : (v || ''));

/** Page a Stripe list with starting_after until has_more is false. */
async function listAll(path, params, ctx, { maxPages = 500 } = {}) {
  const out = [];
  let startingAfter;
  for (let page = 0; ; page += 1) {
    // Stop loudly at the cap — a short PAYMENTS tab would read as a revenue drop.
    if (page >= maxPages) throw new Error(`Stripe ${path} returned more than ${maxPages * 100} rows`);
    ctx.checkBudget();
    const d = await fetchJson(`${API}${path}${qs({ ...params, limit: 100, starting_after: startingAfter })}`, { headers: headers() });
    const data = d.data || [];
    out.push(...data);
    if (!d.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return out;
}

// ── Classification ───────────────────────────────────────────────────────────
// Tier          the label of the first offer (OFFERS_JSON on /settings) whose `match` regex
//               hits the product / price name; no match → "Other".
// Payment Type  a first guess that a human can correct in PRICE MAP:
//                 plan     the price is recurring (Stripe's own flag — no wording involved),
//                          or the name says instalments
//                 deposit  the name says deposit / down payment / half / 50%
//                 balance  the name says balance / remainder
//                 pif      everything else (paid in full)
//               The name check is a short word list in English, German, French, Spanish,
//               Italian, Portuguese and Dutch — a wording guess can only ever be
//               approximate, which is why the column is editable.
// Excluded      "Y" when the name contains a STRIPE_EXCLUDE_KEYWORDS keyword (money that
//               runs through this Stripe account but is not this business's revenue).
//               No keywords → nothing is excluded.
const TYPE_WORDS = [
  ['deposit', /deposit|down[\s-]?payment|\bhalf\b|\b50\s?%|anzahlung|acompte|dep[oó]sito|caparra|aanbetaling/i],
  ['balance', /balance|remaining|remainder|restbetrag|restzahlung|solde|saldo|restante/i],
  ['plan', /instal+ments?|payment[\s-]?plan|split[\s-]?pay|monthly|\/\s?mo\b|ratenzahlung|\braten\b|mensual|mensuel|mensile|\bcuotas?\b|\bplazos\b|\brateale\b|termijn/i],
];

function classify(name, recurring) {
  const n = clean(name);
  let paymentType = 'pif';
  if (recurring) paymentType = 'plan';
  else {
    const hit = TYPE_WORDS.find(([, re]) => re.test(n));
    if (hit) paymentType = hit[0];
  }
  const offer = offerFor(n);
  const low = n.toLowerCase();
  const excluded = (config.stripe.exclude_keywords || []).some((k) => lower(k) && low.includes(lower(k))) ? 'Y' : 'N';
  return { tier: offer ? offer.label : 'Other', paymentType, excluded };
}

function priceCatalogue(prices) {
  const map = new Map();
  for (const p of prices) {
    const prod = p.product && typeof p.product === 'object' ? p.product : { id: p.product, name: '' };
    map.set(p.id, {
      priceId: p.id,
      productId: prod.id || '',
      productName: prod.name || p.nickname || '',
      // what the offer regex and the keywords are tried against: product name + price nickname
      matchName: clean(`${prod.name || ''} ${p.nickname || ''}`),
      amount: major(p.unit_amount, p.currency),
      recurring: Boolean(p.recurring),
    });
  }
  return map;
}

// ── PRICE MAP ────────────────────────────────────────────────────────────────
// The sync only ever APPENDS a row for a price it has not seen; an existing row is never
// written to, so nothing a human typed can be lost. Each auto-filled row records what the
// sync filled in ("auto 2026-01-31 [Other / pif / N] — …") in Notes. While Tier / Payment
// Type / Excluded still equal that record the row is untouched, and PAYMENTS follows the
// current settings (offers added on /settings later still apply). Once a human changes any
// of the three, the row wins.
// (rows written before the wording changed carry a dash where the comma now is)
const AUTO_RE = /^auto \S+ \[(.*)\](?:,| —) /;
const signature = (tier, paymentType, excluded) => `${tier} / ${paymentType} / ${excluded}`;

/** @returns {Promise<{rules: Map<string, {tier, paymentType, excluded, edited: boolean}>, newRows: string[][]}>} */
async function planPriceMap(catalogue) {
  const existing = await db.readTab(db.TABS.PRICE_MAP);
  const rules = new Map();
  for (const r of existing) {
    const id = clean(r['Price ID']);
    if (!id) continue;
    const rule = { tier: clean(r.Tier), paymentType: clean(r['Payment Type']), excluded: clean(r.Excluded).toUpperCase() };
    const auto = AUTO_RE.exec(String(r.Notes || ''));
    rule.edited = !(auto && auto[1] === signature(rule.tier, rule.paymentType, rule.excluded));
    rules.set(id, rule);
  }
  const newRows = [];
  const today = localDate(new Date());
  for (const p of catalogue.values()) {
    if (rules.has(p.priceId)) continue;
    const h = classify(p.matchName, p.recurring);
    newRows.push([
      p.priceId, p.productId, p.productName, p.amount, p.recurring ? 'Y' : 'N',
      h.tier, h.paymentType, h.excluded,
      `auto ${today} [${signature(h.tier, h.paymentType, h.excluded)}], a first guess; edit Tier / Payment Type / Excluded to overrule it`,
    ]);
    rules.set(p.priceId, { ...h, edited: false });
  }
  return { rules, newRows };
}

// ── PAYMENTS ─────────────────────────────────────────────────────────────────
async function run(ctx) {
  const since = { 'created[gte]': Math.floor(ctx.since.getTime() / 1000) };

  // Charges are the revenue and must be readable. Everything else enriches them, so a
  // restricted key without access to one of those resources costs that detail (named in
  // the SYNC LOG message) rather than the whole part.
  const noAccess = [];
  const optional = async (path, params) => {
    try { return await listAll(path, params, ctx); }
    catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 401 && e.status !== 403)) throw e;
      noAccess.push(path.slice(1));
      return [];
    }
  };

  // Subscriptions are current state, not events, so they are not bounded by the window.
  const [charges, prices, pis, refunds, disputes, payouts, subs, sessions, invoices] = await Promise.all([
    listAll('/charges', { ...since, 'expand[]': 'data.customer' }, ctx),
    optional('/prices', { 'expand[]': 'data.product' }),
    optional('/payment_intents', since),
    optional('/refunds', { ...since, 'expand[]': 'data.charge' }),
    optional('/disputes', since),
    optional('/payouts', since),
    optional('/subscriptions', { status: 'all', 'expand[]': 'data.customer' }),
    optional('/checkout/sessions', { ...since, status: 'complete', 'expand[]': 'data.line_items' }),
    optional('/invoices', since),
  ]);
  const catalogue = priceCatalogue(prices);
  const { rules: priceRules, newRows: newPriceRows } = await planPriceMap(catalogue);

  // Joins: payment_intent → checkout line item; invoice → line price; PI → decline code.
  const byPi = new Map();
  for (const s of sessions) {
    const li = s.line_items && s.line_items.data && s.line_items.data[0];
    const price = li && li.price ? li.price : null;
    const info = {
      priceId: price ? price.id : '',
      productId: price ? idOf(price.product) : '',
      description: (li && li.description) || '',
      email: (s.customer_details && s.customer_details.email) || s.customer_email || '',
      name: (s.customer_details && s.customer_details.name) || '',
      subscription: idOf(s.subscription),
      invoice: idOf(s.invoice),
    };
    if (s.payment_intent) byPi.set(idOf(s.payment_intent), info);
    if (info.invoice) byPi.set(info.invoice, info);
  }
  const byInvoice = new Map();
  for (const inv of invoices) {
    const line = inv.lines && inv.lines.data && inv.lines.data[0];
    const pd = line && line.pricing && line.pricing.price_details;
    const info = {
      priceId: (pd && pd.price) || (line && line.price && line.price.id) || '',
      productId: (pd && pd.product) || (line && line.price && idOf(line.price.product)) || '',
      description: (line && line.description) || inv.description || '',
      email: inv.customer_email || '',
      name: inv.customer_name || '',
      number: inv.number || '',
    };
    byInvoice.set(inv.id, info);
    // older API versions: the invoice names its payment intent directly
    const pi = idOf(inv.payment_intent);
    if (pi && !byPi.has(pi)) byPi.set(pi, info);
  }
  const piById = new Map(pis.map((p) => [p.id, p]));

  // A price with a human-edited PRICE MAP row takes that row's values; everything else —
  // untouched rows, and payments with no price at all (classified from their description) —
  // is classified from the current settings.
  const resolve = (priceId, fallbackName, recurring) => {
    const cat = priceId ? catalogue.get(priceId) : null;
    const rule = priceId ? priceRules.get(priceId) : null;
    const h = classify((cat && cat.matchName) || fallbackName || '', recurring || (cat && cat.recurring));
    const edited = rule && rule.edited ? rule : {};
    return {
      product: (cat && cat.productName) || fallbackName || '',
      tier: edited.tier || h.tier,
      paymentType: edited.paymentType || h.paymentType,
      excluded: edited.excluded || h.excluded,
    };
  };

  const synced = nowIso();
  const rows = [];
  const seen = new Set();
  const push = (r) => { if (r[0] && !seen.has(r[0])) { seen.add(r[0]); rows.push(r); } };

  // Charges → charge | failed
  const chargeInfo = new Map(); // charge id → {email, name, priceId, product, pi}
  for (const c of charges) {
    const pi = idOf(c.payment_intent);
    const piObj = piById.get(pi);
    // Newer API versions dropped charge.invoice; a subscription charge's invoice is on its
    // payment intent as payment_details.order_reference ("in_…").
    const invoiceId = idOf(c.invoice)
      || (piObj && piObj.payment_details && String(piObj.payment_details.order_reference || '').startsWith('in_') ? piObj.payment_details.order_reference : '');
    const link = byPi.get(pi) || (invoiceId ? byInvoice.get(invoiceId) : null) || {};
    const customer = c.customer && typeof c.customer === 'object' ? c.customer : {};
    const email = lower((c.billing_details && c.billing_details.email) || c.receipt_email || customer.email || link.email);
    const name = (c.billing_details && c.billing_details.name) || customer.name || link.name || '';
    const cat = link.priceId ? catalogue.get(link.priceId) : null;
    const r = resolve(link.priceId, link.description || c.description, Boolean(cat && cat.recurring));
    chargeInfo.set(c.id, { email, name, priceId: link.priceId || '', product: r.product, pi, tier: r.tier, paymentType: r.paymentType, excluded: r.excluded });
    let kind;
    if (c.status === 'succeeded') kind = 'charge';
    else if (c.status === 'failed') kind = 'failed';
    else continue; // pending
    // Decline code: Stripe's own decline_code first, then the charge outcome reason, then the
    // failure code; the raw network code (e.g. "51") only when nothing readable exists.
    const err = piObj && piObj.last_payment_error ? piObj.last_payment_error : null;
    const decline = kind === 'failed'
      ? (err && (err.decline_code || err.code)) || (c.outcome && c.outcome.reason) || c.failure_code || (c.outcome && c.outcome.network_decline_code) || ''
      : '';
    push([
      c.id, kind, major(c.amount, c.currency), cur(c.currency), c.status, iso(c.created), email, name,
      c.description || link.description || '', link.priceId || '', r.product, r.tier, r.paymentType,
      decline, c.receipt_url || '', pi || invoiceId || '', r.excluded, synced,
    ]);
  }

  // Failed payment intents with no charge attempt behind them
  for (const p of pis) {
    if (!p.last_payment_error) continue;
    if (p.latest_charge && chargeInfo.has(idOf(p.latest_charge))) continue;
    if (p.status === 'succeeded') continue;
    const link = byPi.get(p.id) || {};
    const r = resolve(link.priceId, link.description || p.description, false);
    const err = p.last_payment_error;
    push([
      p.id, 'failed', major(p.amount, p.currency), cur(p.currency), p.status, iso(p.created),
      String(p.receipt_email || link.email || '').trim().toLowerCase(), link.name || '',
      p.description || link.description || '', link.priceId || '', r.product, r.tier, r.paymentType,
      err.decline_code || err.code || '', '', idOf(p.latest_charge) || '', r.excluded, synced,
    ]);
  }

  // Refunds
  for (const rf of refunds) {
    const ch = rf.charge && typeof rf.charge === 'object' ? rf.charge : null;
    const info = chargeInfo.get(idOf(rf.charge)) || {};
    const email = info.email || (ch && ch.billing_details && ch.billing_details.email ? String(ch.billing_details.email).toLowerCase() : '');
    const name = info.name || (ch && ch.billing_details && ch.billing_details.name) || '';
    push([
      rf.id, 'refund', major(rf.amount, rf.currency), cur(rf.currency), rf.status || '', iso(rf.created), email, name,
      rf.reason || (ch && ch.description) || '', info.priceId || '', info.product || '', info.tier || '', info.paymentType || '',
      '', (ch && ch.receipt_url) || '', idOf(rf.payment_intent) || idOf(rf.charge) || '', info.excluded || '', synced,
    ]);
  }

  // Disputes
  for (const d of disputes) {
    const info = chargeInfo.get(idOf(d.charge)) || {};
    push([
      d.id, 'dispute', major(d.amount, d.currency), cur(d.currency), d.status || '', iso(d.created), info.email || '', info.name || '',
      d.reason || '', info.priceId || '', info.product || '', info.tier || '', info.paymentType || '',
      '', '', idOf(d.payment_intent) || idOf(d.charge) || '', info.excluded || '', synced,
    ]);
  }

  // Payouts (account level — the whole Stripe balance, whatever was excluded above)
  for (const p of payouts) {
    push([
      p.id, 'payout', major(p.amount, p.currency), cur(p.currency), p.status || '', iso(p.created), '', '',
      p.description || `arrives ${iso(p.arrival_date).slice(0, 10)}`, '', '', '', '',
      p.failure_code || '', '', idOf(p.balance_transaction) || '', '', synced,
    ]);
  }

  // Subscriptions — one row each, Amount = monthly
  for (const s of subs) {
    const item = s.items && s.items.data && s.items.data[0];
    const price = item && item.price ? item.price : null;
    const qty = Number((item && item.quantity) || 1);
    let monthly = 0;
    if (price && price.unit_amount != null) {
      const rec = price.recurring || {};
      const count = Number(rec.interval_count || 1);
      const perInterval = Number(price.unit_amount) * qty;
      const factor = { day: 30, week: 4.33, month: 1, year: 1 / 12 }[rec.interval] || 1;
      monthly = perInterval * factor / count;
    }
    const customer = s.customer && typeof s.customer === 'object' ? s.customer : {};
    const r = resolve(price ? price.id : '', price ? price.nickname : '', true);
    push([
      s.id, 'subscription', major(monthly, s.currency), cur(s.currency), s.status || '', iso(s.created),
      String(customer.email || '').trim().toLowerCase(), customer.name || '',
      r.product || s.description || '', price ? price.id : '', r.product, r.tier, r.paymentType,
      '', '', idOf(s.latest_invoice) || '', r.excluded, synced,
    ]);
  }

  rows.sort((a, b) => (a[5] < b[5] ? -1 : a[5] > b[5] ? 1 : 0));
  ctx.beginWrite();
  const added = await db.appendRows(db.TABS.PRICE_MAP, newPriceRows);
  const written = await db.writeTab(db.TABS.PAYMENTS, db.HEADERS.PAYMENTS, rows);
  const kinds = {};
  rows.forEach((r) => { kinds[r[1]] = (kinds[r[1]] || 0) + 1; });
  const gross = rows.filter((r) => r[1] === 'charge').reduce((a, r) => a + Number(r[2]), 0);
  return {
    rows: written + added,
    message: `payments=${written} (${Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join(' ')}) gross=${gross.toFixed(2)} prices=${catalogue.size} priceMapAdded=${added} since=${iso(ctx.since).slice(0, 10)}${noAccess.length ? `, key has no access to: ${noAccess.join(', ')}` : ''}`,
  };
}

module.exports = { run, classify };
