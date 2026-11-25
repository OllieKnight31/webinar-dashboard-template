// Webinar System sync — HTTP helper.
// Node 18+ global fetch. Every request carries a browser-like User-Agent because Calendly
// and GoHighLevel sit behind Cloudflare and a bare/default UA gets 403 / error 1010.
// Error messages never contain a credential: keys travel in headers, and query-string
// secrets are masked by safeUrl().
// Retries with backoff on 429 and 5xx (honours Retry-After), and on network errors.

'use strict';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Strip query-string secrets before an error message ever reaches a log, the SYNC LOG tab or an alert. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|secret|auth/i.test(k)) u.searchParams.set(k, '***');
    }
    return u.toString();
  } catch {
    return String(url).slice(0, 200);
  }
}

/**
 * fetch with retries. Resolves to the Response on any non-retryable status (caller decides),
 * throws HttpError after the retry budget on 429/5xx, or on repeated network failure.
 */
async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, retries = 3, timeoutMs = 20000, backoffMs = 800,
  } = opts;
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', ...headers },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        lastErr = new HttpError(`HTTP ${res.status} ${safeUrl(url)} ${text.slice(0, 200)}`, { status: res.status, url: safeUrl(url), body: text.slice(0, 500) });
        if (attempt === retries) throw lastErr;
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs * 2 ** attempt;
        await sleep(Math.min(wait, 15000));
        attempt += 1;
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError) throw e;
      lastErr = new HttpError(`${e.name === 'AbortError' ? 'timeout' : e.message} ${safeUrl(url)}`, { url: safeUrl(url) });
      if (attempt === retries) throw lastErr;
      await sleep(backoffMs * 2 ** attempt);
      attempt += 1;
    }
  }
  throw lastErr || new Error('request failed');
}

/** GET/POST and parse JSON. Throws HttpError with status + body excerpt on non-2xx. */
async function fetchJson(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const excerpt = (data && (data.message || data.error || data.error_description)) || text.slice(0, 300);
    throw new HttpError(`HTTP ${res.status} ${safeUrl(url)}, ${typeof excerpt === 'string' ? excerpt : JSON.stringify(excerpt).slice(0, 300)}`, {
      status: res.status, url: safeUrl(url), body: text.slice(0, 1000),
    });
  }
  return data;
}

/** Run `fn` over items with at most `limit` in flight; preserves order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => u.append(k, String(x)));
    else u.append(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

module.exports = { BROWSER_UA, HttpError, request, fetchJson, mapLimit, qs, sleep, safeUrl };
