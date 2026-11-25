// Webinar System sync — the business rules every source shares, all driven by config:
// CRM tags → channel / entry / offer / setter / flags, product or tag text → offer, a phone
// system's display name → the roster name, and which pipeline cards are tests.

'use strict';

const { config } = require('../../config');

const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
const lower = (s) => clean(s).toLowerCase();
/** "Zoë O'Neil" → "zoeoneil": compare names without case, accents or punctuation. */
const slug = (s) => lower(s).normalize('NFKD').replace(/[^a-z0-9]+/g, '');

// Owner-typed patterns (OFFERS_JSON match, CALENDLY_SET_REGEX) can be invalid; a bad one
// matches nothing rather than failing the sync.
const reCache = new Map();
function safeRegex(pattern) {
  const key = String(pattern || '');
  if (!key) return null;
  if (!reCache.has(key)) {
    let re = null;
    try { re = new RegExp(key, 'i'); } catch { re = null; }
    reCache.set(key, re);
  }
  return reCache.get(key);
}

/** The first configured offer whose `match` regex hits the text, or null. */
function offerFor(text) {
  const t = clean(text);
  if (!t) return null;
  for (const o of config.command.offers || []) {
    const re = safeRegex(o.match);
    if (re && re.test(t)) return o;
  }
  return null;
}

// A tag setting may be one tag, a comma list or an array ("booked": ["call-booked","booked"]).
function tagList(v) {
  return (Array.isArray(v) ? v : String(v || '').split(',')).map(lower).filter(Boolean);
}

/** Value of the first tag carrying one of the prefixes ("src-instagram" → "instagram"). */
function prefixed(tags, prefixes) {
  for (const p of prefixes) {
    const hit = tags.find((t) => t.startsWith(p) && t.length > p.length);
    if (hit) return hit.slice(p.length);
  }
  return '';
}

/**
 * Classify a contact from its CRM tags using config.command.tags.
 * @param {string[]} rawTags
 * @returns {{tags: string[], channel: string, entry: string, offer: string, setter: string,
 *   paid: 'Y'|'N', application: 'Y'|'N', booked: 'Y'|'N', cancelled: 'Y'|'N', community: 'Y'|'N'}}
 */
function classifyTags(rawTags) {
  const cfg = config.command.tags || {};
  const tags = (rawTags || []).map(lower).filter(Boolean);
  const has = (v) => (tagList(v).some((t) => tags.includes(t)) ? 'Y' : 'N');
  return {
    tags,
    channel: prefixed(tags, tagList(cfg.channel_prefix)),
    entry: prefixed(tags, tagList(cfg.entry_prefix)),
    offer: prefixed(tags, tagList(cfg.offer_prefix)),
    setter: prefixed(tags, tagList(cfg.setter_prefix)),
    paid: has(cfg.paid),
    application: has(cfg.application),
    booked: has(cfg.booked),
    cancelled: has(cfg.cancelled),
    community: has(cfg.community),
  };
}

/**
 * The contact's offer: the offer-prefix tag, else the CRM offer field, else any tag a
 * configured offer's regex recognises. Returned as the offer id when it maps onto a
 * configured offer, otherwise as the raw value lower-cased (so nothing is silently lost).
 */
function contactOffer(tagOffer, fieldValue, tags) {
  for (const raw of [tagOffer, fieldValue]) {
    if (!clean(raw)) continue;
    const o = offerFor(raw);
    return o ? o.id : lower(raw);
  }
  for (const t of tags || []) {
    const o = offerFor(t);
    if (o) return o.id;
  }
  return '';
}

/**
 * A CRM / phone-system display name → the name on the roster, so calls and EOD reports land
 * on one person. Order: exact roster name; NAME_ALIASES_JSON (keyed by full name or first
 * name); a unique first-name match on the roster. No match → the name as it came.
 */
function rosterName(display) {
  const name = clean(display);
  if (!name) return '';
  const people = [...new Set(Object.values(config.roster || {}).flat().map((p) => clean(p && p.name)).filter(Boolean))];
  const exact = people.find((p) => p.toLowerCase() === name.toLowerCase());
  if (exact) return exact;

  const aliases = {};
  for (const [k, v] of Object.entries(config.command.name_aliases || {})) {
    if (clean(v)) aliases[slug(k)] = clean(v);
  }
  const [first, ...rest] = name.split(' ');
  const alias = aliases[slug(name)] || aliases[slug(first)] || '';
  if (alias) {
    const full = people.find((p) => p.toLowerCase() === alias.toLowerCase());
    if (full) return full;
  }

  const firstSlug = slug(alias ? alias.split(' ')[0] : first);
  const matches = people.filter((p) => slug(p.split(' ')[0]) === firstSlug);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // two people share the first name — only the surname can tell them apart
    const last = slug(rest.join(' '));
    const byLast = matches.filter((p) => slug(p.split(' ').slice(1).join(' ')) === last);
    if (byLast.length === 1) return byLast[0];
  }
  if (!alias) return name;
  // Aliased but not on the roster: "katherine" → "kate" turns "Katherine Smith" into "Kate Smith".
  return alias.includes(' ') ? alias : [alias.charAt(0).toUpperCase() + alias.slice(1), ...rest].join(' ');
}

// Pipeline cards made while testing an automation. Generic conventions only: the card says
// "test" (as a word) or carries a __VERIFY__ marker, the value is exactly 1, or the email is
// on the reserved example.com domain.
const TEST_NAME_RE = /__verify__|\btest\b/i;
const TEST_EMAIL_RE = /@example\.com$/i;
function isTest(name, monetaryValue, email) {
  const one = monetaryValue !== '' && monetaryValue !== null && monetaryValue !== undefined && Number(monetaryValue) === 1;
  return TEST_NAME_RE.test(String(name || '')) || one || TEST_EMAIL_RE.test(clean(email)) ? 'Y' : 'N';
}

module.exports = { clean, lower, slug, safeRegex, offerFor, tagList, classifyTags, contactOffer, rosterName, isTest };
