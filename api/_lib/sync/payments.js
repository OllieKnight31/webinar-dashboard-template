// Webinar System sync — `payments` part: whichever payment tool is connected → PAYMENTS.
//
// One interface, one entry per tool. Each adapter has:
//
//   id, label
//   connected()   → true once its key is saved
//   test()        → { ok, message }, never throws ("Check connection")
//   pull(ctx)     → [payment]   every payment since ctx.since, newest or oldest first
//
// A payment is { id, amount, currency, status, created, email, name, product } with `amount`
// in whole currency (29.99, not 2999) and status one of paid | refunded | failed | pending.
// Only `paid` rows count as sales on the Results page; a payment refunded in full is stored
// as a refund so it stops counting. Results match a sale to a sign-up by email, so a payment
// with no email can never be credited to the webinar.
//
// Stripe keeps its own, fuller module (./stripe.js: price map, instalments, disputes). The
// tools below are read with one list call each.
//
// A tool with no adapter can still report sales: it sends each one to the "updates" address
// (POST /api?source=event&type=sale), directly or through Zapier or Make. See handlers/event.js.
//
// LIVE TESTED: none of the adapters below has been run against a real account yet. Each is
// written from the tool's published documentation; the address of that documentation is on
// every adapter. The first real connection of each one should be checked against the tool's
// own dashboard before its numbers are trusted.
//
// ADDING A TOOL: add an adapter here, its key to FIELDS in settings-store.js and to build()
// in config.js, and its card to the payments set in public/tools.js.

'use strict';

const { config } = require('../config');
const db = require('../db');
const { fetchJson, HttpError } = require('./lib/http');
const { iso, nowIso } = require('./lib/time');

const MAX_PAGES = 200;
const num = (v) => { const n = Number(String(v === null || v === undefined ? '' : v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const date = (v) => { if (v === null || v === undefined || v === '') return null; const d = typeof v === 'number' || /^\d{9,13}$/.test(String(v)) ? new Date(Number(v) * (Number(v) < 1e12 ? 1000 : 1)) : new Date(String(v).replace(/\s+/g, '')); return Number.isNaN(d.getTime()) ? null : d; };
const bearer = (key) => ({ Authorization: `Bearer ${key}` });
const basic = (user, pass) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/** Turn a failed request into a sentence for the owner. */
function explain(label, e) {
  const status = e instanceof HttpError ? e.status : 0;
  if (status === 401) return `That did not work: ${label} rejected the key. Check you copied all of it.`;
  if (status === 403) return `That did not work: the key is not allowed to read payments. Check what you ticked when creating it.`;
  if (status === 404) return `That did not work: ${label} could not find the account. Check the details and try again.`;
  if (status) return `That did not work: ${label} answered with an error (${status}). Try again in a minute.`;
  return `That did not work: ${/timeout/i.test(String(e && e.message)) ? `${label} did not answer in time` : `we could not reach ${label}`}. Try again in a minute.`;
}
/** A test that is simply "can we read one page?". */
const reads = (label, need, probe) => async () => {
  if (need) return { ok: false, message: need };
  try { await probe(); return { ok: true, message: 'Connected. We can read your payments.' }; }
  catch (e) { return { ok: false, message: explain(label, e) }; }
};

// ── Whop ────────────────────────────────────────────────────────────────────
// https://docs.whop.com/api-reference/payments/list-payments
// GET /api/v1/payments, cursor paging (first / after → page_info). Amounts are decimals,
// the buyer's email is at user.email and needs the member email permission.
const whop = {
  id: 'whop', label: 'Whop',
  connected: () => Boolean(config.payments.whop.api_key),
  get(params) { return fetchJson(`https://api.whop.com/api/v1/payments?${form(params)}`, { headers: bearer(config.payments.whop.api_key) }); },
  test() { return reads('Whop', this.connected() ? '' : 'Paste your Whop key first, then check again.', () => this.get({ first: 1 }))(); },
  async pull(ctx) {
    const out = []; let after = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      ctx.checkBudget();
      const d = await this.get({ first: 100, order: 'created_at', direction: 'desc', created_after: iso(ctx.since), ...(after ? { after } : {}) });
      for (const p of d.data || []) {
        const sub = text(p.substatus).toLowerCase(), st = text(p.status).toLowerCase();
        const refunded = num(p.refunded_amount), total = num(p.total !== null && p.total !== undefined ? p.total : p.subtotal);
        const status = /^(refunded|auto_refunded)$/.test(sub) || (refunded > 0 && refunded >= total) ? 'refunded' : st === 'paid' ? 'paid' : /failed|canceled|void|uncollectible/.test(`${st} ${sub}`) ? 'failed' : 'pending';
        const user = p.user || {};
        out.push({ id: `whop:${p.id}`, amount: status === 'paid' ? total - refunded : total, currency: p.currency, status, created: date(p.paid_at) || date(p.created_at),
          email: user.email, name: user.name || user.username, product: (p.product && (p.product.title || p.product.name)) || (p.plan && p.plan.title) || '' });
      }
      const info = d.page_info || {};
      if (!info.has_next_page || !info.end_cursor) break;
      after = info.end_cursor;
    }
    return out;
  },
};

// ── Commas (the new name of Fanbasis) ───────────────────────────────────────
// https://apidocs.fan  ·  GET /public-api/checkout-sessions/transactions on www.fanbasis.com,
// header x-api-key, page / per_page (max 100). There is no date filter, so pages are read
// until every row on one is older than the window. Amounts are decimals; there is no currency
// on a row, so the account's own currency is used.
const commas = {
  id: 'commas', label: 'Commas',
  connected: () => Boolean(config.payments.commas.api_key),
  get(page, perPage) { return fetchJson(`https://www.fanbasis.com/public-api/checkout-sessions/transactions?page=${page}&per_page=${perPage}`, { headers: { 'x-api-key': config.payments.commas.api_key } }); },
  test() { return reads('Commas', this.connected() ? '' : 'Paste your Commas key first, then check again.', () => this.get(1, 1))(); },
  async pull(ctx) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      ctx.checkBudget();
      const d = ((await this.get(page, 100)) || {}).data || {};
      const rows = d.transactions || [];
      let inWindow = 0;
      for (const t of rows) {
        const created = date(t.transaction_date);
        if (created && created < ctx.since) continue;
        inWindow += 1;
        const fan = t.fan || {}, amount = num(t.amount);
        const refunded = (t.refunds || []).reduce((sum, r) => sum + num(r.amount !== undefined ? r.amount : r.refund_amount), 0);
        const full = (t.refunds || []).length > 0 && (refunded === 0 || refunded >= amount);
        out.push({ id: `commas:${t.id}`, amount: full ? amount : amount - refunded, currency: '', status: full ? 'refunded' : 'paid', created,
          email: fan.email, name: fan.name, product: ((t.product || t.service || {}).title) || '' });
      }
      const pg = d.pagination || {};
      if (!rows.length || !pg.has_more || inWindow === 0) break;
    }
    return out;
  },
};

// ── PayPal ──────────────────────────────────────────────────────────────────
// https://developer.paypal.com/api/transaction-search/v1/search-get
// A token from the client id and secret, then /v1/reporting/transactions, at most 31 days per
// call. PayPal can take three hours to show a new payment. Only "T00.." rows are payments
// received; everything else (fees, payouts, transfers) is left out.
const paypal = {
  id: 'paypal', label: 'PayPal',
  connected: () => Boolean(config.payments.paypal.client_id && config.payments.paypal.secret),
  async token() {
    const c = config.payments.paypal;
    const d = await fetchJson('https://api-m.paypal.com/v1/oauth2/token', { method: 'POST', headers: { ...basic(c.client_id, c.secret), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    return d.access_token;
  },
  search(token, from, to, page) {
    return fetchJson(`https://api-m.paypal.com/v1/reporting/transactions?${form({ start_date: iso(from), end_date: iso(to), fields: 'transaction_info,payer_info', page_size: 500, page })}`, { headers: bearer(token) });
  },
  async test() {
    if (!this.connected()) return { ok: false, message: 'Paste your PayPal Client ID and Secret first, then check again.' };
    try {
      const token = await this.token();
      try { await this.search(token, new Date(Date.now() - 86400000), new Date(), 1); }
      catch (e) { if (e instanceof HttpError && (e.status === 403 || e.status === 401)) return { ok: false, message: 'That did not work: PayPal let us in, but Transaction Search is not switched on for this app. Tick it on the app in PayPal, wait a few hours, then check again.' }; throw e; }
      return { ok: true, message: 'Connected. We can read your payments. PayPal can take up to three hours to show a new one.' };
    } catch (e) { return { ok: false, message: explain('PayPal', e) }; }
  },
  async pull(ctx) {
    const token = await this.token(), out = [], end = Date.now(), step = 30 * 86400000;
    for (let a = ctx.since.getTime(); a < end; a += step) {
      let pages = 1;
      for (let page = 1; page <= pages && page <= MAX_PAGES; page += 1) {
        ctx.checkBudget();
        const d = await this.search(token, new Date(a), new Date(Math.min(a + step, end)), page);
        pages = num(d.total_pages) || 1;
        for (const t of d.transaction_details || []) {
          const i = t.transaction_info || {}, payer = t.payer_info || {}, amount = num((i.transaction_amount || {}).value), code = text(i.transaction_event_code);
          if (!/^T00/.test(code) || amount <= 0) continue;
          const s = text(i.transaction_status).toUpperCase();
          out.push({ id: `paypal:${i.transaction_id}`, amount, currency: (i.transaction_amount || {}).currency_code, status: s === 'S' ? 'paid' : s === 'V' ? 'refunded' : s === 'D' ? 'failed' : 'pending',
            created: date(i.transaction_initiation_date), email: payer.email_address, name: [((payer.payer_name || {}).given_name), ((payer.payer_name || {}).surname)].filter(Boolean).join(' '), product: text(i.transaction_subject || i.transaction_note) });
        }
      }
    }
    return out;
  },
};

// ── GoHighLevel payments ────────────────────────────────────────────────────
// https://marketplace.gohighlevel.com/docs/ghl/payments/list-transactions
// The same key and location as the contacts connection, with "View Payment Transactions"
// ticked as well. Whether `amount` is whole currency or its smallest unit is not stated in
// the documentation; the example reads as whole currency, and that is what is assumed here.
const ghl = {
  id: 'ghl', label: 'GoHighLevel',
  connected: () => Boolean(config.crm.ghl.api_key && config.crm.ghl.location_id),
  get(params) {
    return fetchJson(`https://services.leadconnectorhq.com/payments/transactions?${form({ altId: config.crm.ghl.location_id, altType: 'location', ...params })}`, { headers: { ...bearer(config.crm.ghl.api_key), Version: '2021-07-28' } });
  },
  test() { return reads('GoHighLevel', this.connected() ? '' : 'Connect GoHighLevel under "Where do you keep your contacts?" first. Payments use the same key.', () => this.get({ limit: 1 }))(); },
  async pull(ctx) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      ctx.checkBudget();
      const d = await this.get({ limit: 100, offset: page * 100, startAt: iso(ctx.since).slice(0, 10), endAt: iso(new Date(Date.now() + 86400000)).slice(0, 10) });
      const rows = d.data || d.transactions || [];
      for (const t of rows) {
        const amount = num(t.amount), refunded = num(t.amountRefunded), s = text(t.status).toLowerCase();
        const status = refunded > 0 && refunded >= amount ? 'refunded' : s === 'succeeded' ? 'paid' : /fail|declin/.test(s) ? 'failed' : 'pending';
        out.push({ id: `ghl:${t._id || t.id}`, amount: status === 'paid' ? amount - refunded : amount, currency: t.currency, status, created: date(t.createdAt),
          email: t.contactEmail || (t.contactSnapshot || {}).email, name: t.contactName || [((t.contactSnapshot || {}).firstName), ((t.contactSnapshot || {}).lastName)].filter(Boolean).join(' '), product: text(t.entitySourceName || t.entitySourceType) });
      }
      if (rows.length < 100) break;
    }
    return out;
  },
};

// ── Kajabi ──────────────────────────────────────────────────────────────────
// https://developers.kajabi.com/api-reference/transactions/list-transactions
// A token from the client id and secret, then /v1/transactions. A transaction row names its
// customer only by id, so each new customer is looked up once for the email address.
const kajabi = {
  id: 'kajabi', label: 'Kajabi',
  connected: () => Boolean(config.payments.kajabi.client_id && config.payments.kajabi.secret),
  async token() {
    const c = config.payments.kajabi;
    const d = await fetchJson('https://api.kajabi.com/v1/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.secret }) });
    return d.access_token;
  },
  async test() {
    if (!this.connected()) return { ok: false, message: 'Paste your Kajabi Client ID and Client secret first, then check again.' };
    try { const token = await this.token(); await fetchJson('https://api.kajabi.com/v1/transactions?page[size]=1', { headers: bearer(token) }); return { ok: true, message: 'Connected. We can read your payments.' }; }
    catch (e) { return { ok: false, message: explain('Kajabi', e) }; }
  },
  async pull(ctx) {
    const headers = bearer(await this.token()), out = [], people = new Map();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      ctx.checkBudget();
      const d = await fetchJson(`https://api.kajabi.com/v1/transactions?page[number]=${page}&page[size]=100&filter[start_date]=${encodeURIComponent(iso(ctx.since))}`, { headers });
      const rows = d.data || [];
      for (const t of rows) {
        const a = t.attributes || {}, customer = ((((t.relationships || {}).customer) || {}).data || {}).id || '';
        const action = text(a.action).toLowerCase(), state = text(a.state).toLowerCase();
        out.push({ id: `kajabi:${t.id}`, amount: num(a.amount_in_cents) / 100, currency: a.currency, status: /refund/.test(action) ? 'refunded' : /fail|declin/.test(state) ? 'failed' : 'paid', created: date(a.created_at), customer, product: text(a.offer_title || a.title) });
      }
      if (rows.length < 100) break;
    }
    for (const id of [...new Set(out.map(p => p.customer).filter(Boolean))]) {
      ctx.checkBudget();
      try { const c = ((await fetchJson(`https://api.kajabi.com/v1/customers/${encodeURIComponent(id)}`, { headers })).data || {}).attributes || {}; people.set(id, { email: c.email, name: c.name }); }
      catch { people.set(id, {}); }
    }
    return out.map(p => ({ ...p, ...(people.get(p.customer) || {}) }));
  },
};

// ── Lemon Squeezy ───────────────────────────────────────────────────────────
// https://docs.lemonsqueezy.com/api/orders/list-all-orders  ·  totals are in cents.
const lemonsqueezy = {
  id: 'lemonsqueezy', label: 'Lemon Squeezy',
  connected: () => Boolean(config.payments.lemonsqueezy.api_key),
  get(page, size) { return fetchJson(`https://api.lemonsqueezy.com/v1/orders?page[number]=${page}&page[size]=${size}`, { headers: { ...bearer(config.payments.lemonsqueezy.api_key), Accept: 'application/vnd.api+json' } }); },
  test() { return reads('Lemon Squeezy', this.connected() ? '' : 'Paste your Lemon Squeezy key first, then check again.', () => this.get(1, 1))(); },
  async pull(ctx) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      ctx.checkBudget();
      const rows = (await this.get(page, 100)).data || [];
      let inWindow = 0;
      for (const o of rows) {
        const a = o.attributes || {}, created = date(a.created_at);
        if (created && created < ctx.since) continue;
        inWindow += 1;
        const s = text(a.status).toLowerCase();
        out.push({ id: `lemonsqueezy:${o.id}`, amount: num(a.total) / 100, currency: a.currency, status: a.refunded || s === 'refunded' ? 'refunded' : s === 'paid' ? 'paid' : s === 'failed' ? 'failed' : 'pending',
          created, email: a.user_email, name: a.user_name, product: text((a.first_order_item || {}).product_name) });
      }
      if (rows.length < 100 || inWindow === 0) break;
    }
    return out;
  },
};

// ── Paddle (Paddle Billing) ─────────────────────────────────────────────────
// https://developer.paddle.com/api-reference/transactions/list-transactions  ·  totals are in
// the currency's smallest unit; the buyer comes back with include=customer.
const paddle = {
  id: 'paddle', label: 'Paddle',
  connected: () => Boolean(config.payments.paddle.api_key),
  test() { return reads('Paddle', this.connected() ? '' : 'Paste your Paddle key first, then check again.', () => fetchJson('https://api.paddle.com/transactions?per_page=1', { headers: bearer(config.payments.paddle.api_key) }))(); },
  async pull(ctx) {
    const out = [];
    let url = `https://api.paddle.com/transactions?include=customer&per_page=30&order_by=${encodeURIComponent('billed_at[DESC]')}&${encodeURIComponent('billed_at[GTE]')}=${encodeURIComponent(iso(ctx.since))}`;
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      ctx.checkBudget();
      const d = await fetchJson(url, { headers: bearer(config.payments.paddle.api_key) });
      for (const t of d.data || []) {
        const s = text(t.status).toLowerCase(), customer = t.customer || {};
        if (!/^(paid|completed|past_due|canceled)$/.test(s)) continue;
        out.push({ id: `paddle:${t.id}`, amount: num((((t.details || {}).totals) || {}).grand_total) / 100, currency: t.currency_code, status: /^(paid|completed)$/.test(s) ? 'paid' : s === 'past_due' ? 'pending' : 'failed',
          created: date(t.billed_at || t.created_at), email: customer.email, name: customer.name, product: text((((((t.items || [])[0] || {}).price) || {}).description) || '') });
      }
      const pg = (d.meta || {}).pagination || {};
      url = pg.has_more ? pg.next : '';
    }
    return out;
  },
};

const stripe = {
  id: 'stripe', label: 'Stripe',
  connected: () => Boolean(config.stripe.secret_key),
};

const ADAPTERS = { stripe, whop, commas, paypal, ghl, kajabi, lemonsqueezy, paddle };
const PROVIDERS = Object.keys(ADAPTERS);

/** The adapter for the tool chosen on Setup, or null when none is. */
function adapter() { return ADAPTERS[config.payments.provider] || null; }

const KIND = { paid: 'charge', refunded: 'refund', failed: 'failed', pending: 'pending' };
/** One payment → one PAYMENTS row (see db.HEADERS.PAYMENTS for the columns). */
function toRow(p, syncedAt) {
  const currency = text(p.currency || config.command.currency_code || 'USD').toUpperCase();
  return [text(p.id), KIND[p.status] || 'pending', (Number(p.amount) || 0).toFixed(2), currency, p.status === 'paid' ? 'succeeded' : p.status, p.created ? iso(p.created) : '',
    text(p.email).toLowerCase(), text(p.name), text(p.product), '', text(p.product), 'Other', 'pif', '', '', '', 'N', syncedAt];
}

async function run(ctx) {
  const a = adapter();
  if (!a) return { rows: 0, message: 'no payment tool chosen' };
  if (a.id === 'stripe') return require('./stripe').run(ctx);
  const seen = new Set();
  const payments = (await a.pull(ctx)).filter(p => p && p.id && !seen.has(p.id) && seen.add(p.id));
  const now = nowIso();
  const rows = payments.map(p => toRow(p, now));
  ctx.beginWrite();
  const written = await db.writeTab(db.TABS.PAYMENTS, db.HEADERS.PAYMENTS, rows);
  const paid = payments.filter(p => p.status === 'paid');
  const noEmail = paid.filter(p => !text(p.email)).length;
  return { rows: written, message: `${a.label}: payments=${written} paid=${paid.length} gross=${paid.reduce((s, p) => s + (Number(p.amount) || 0), 0).toFixed(2)} since=${iso(ctx.since).slice(0, 10)}${noEmail ? `, ${noEmail} paid with no email (cannot be matched to a sign-up)` : ''}` };
}

module.exports = { run, adapter, toRow, ADAPTERS, PROVIDERS };
