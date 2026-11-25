// Webinar System — runtime config.
// Values come from process.env (Vercel project settings / client.env), overridden by anything
// the owner saved on Setup or Settings (see settings-store.js). See .env.example.

function csv(v, fallback) { return v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : fallback; }
function parseJSON(v, fallback) { if (!v) return fallback; try { return JSON.parse(v); } catch { return fallback; } }
const idList = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(x => String(x).trim()).filter(Boolean);
// A number setting, or null when it is blank ("not set" is not zero).
function optionalNumber(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const CURRENCY_CODES = { '$': 'USD', '£': 'GBP', '€': 'EUR', 'A$': 'AUD', 'C$': 'CAD' };

// The rates the Results page grades, with the target each starts on. Stored as decimals.
const DEFAULT_TARGETS = {
  registration_rate: 0.3, show_up_rate: 0.4, stay_to_pitch_rate: 0.6, booking_rate: 0.1, call_show_rate: 0.7, close_rate: 0.25,
};

function build(env) {
  return {
    brand: {
      name: env.BRAND_NAME || 'Your business',
      timezone: env.TIMEZONE || 'UTC',
      currency_symbol: env.CURRENCY_SYMBOL || '$',
    },

    // Webinar platform. Each one is an adapter under api/_lib/sync/webinar/.
    webinar: {
      provider: (env.WEBINAR_PROVIDER || 'none').toLowerCase(),
      webinarjam: { api_key: env.WEBINARJAM_API_KEY || '', product: (env.WEBINARJAM_PRODUCT || 'webinarjam').toLowerCase() },
      ewebinar: { api_key: env.EWEBINAR_API_KEY || '' },
      // aEvent has no issued key: this is a logged-in user's session token, and it stops
      // working when that user logs in again.
      aevent: { token: env.AEVENT_TOKEN || '' },
      api_key: env.WEBINAR_API_KEY || '',                 // for a platform added later
      webinar_ids: idList(parseJSON(env.WEBINAR_IDS, [])),
      // When the offer starts: "stayed to the offer" = watched at least this many minutes (or
      // this percent). Blank = unknown, and the tile says so rather than guessing.
      pitch_minute: optionalNumber(env.WEBINAR_PITCH_MINUTE),
      pitch_percent: optionalNumber(env.WEBINAR_PITCH_PERCENT),
      confirmation_url: env.WEBINAR_CONFIRMATION_URL || '',
      allowed_origins: csv(env.WEBINAR_ALLOWED_ORIGINS, []).map(o => o.replace(/\/+$/, '').toLowerCase()),
    },

    ads: {
      provider: (env.ADS_PROVIDER || 'none').toLowerCase(),
      meta: { access_token: env.META_ACCESS_TOKEN || '', ad_account_id: env.META_AD_ACCOUNT_ID || '', campaign_filter: env.META_CAMPAIGN_FILTER || '' },
    },

    // Where a new sign-up is saved as a contact.
    crm: {
      provider: (env.CRM_PROVIDER || 'none').toLowerCase(),
      ghl: { api_key: env.GHL_API_KEY || '', location_id: env.GHL_LOCATION_ID || '', pipeline_id: env.GHL_PIPELINE_ID || '' },
      close: { api_key: env.CLOSE_API_KEY || '' },
    },

    // Booked calls. booked_types = the event names that are sales calls (empty = all of them).
    calendly: { token: env.CALENDLY_TOKEN || '', booked_types: parseJSON(env.CALENDLY_BOOKED_TYPES, []), set_types: [], set_regex: '' },
    // Payments (a read-only Stripe key).
    stripe: { secret_key: env.STRIPE_SECRET_KEY || '', exclude_keywords: csv(env.STRIPE_EXCLUDE_KEYWORDS, []) },
    // Which payment tool is read for sales. Each one is an adapter in api/_lib/sync/payments.js.
    // A site set up before there was a choice has a Stripe key and no provider: that is Stripe.
    payments: {
      provider: (env.PAYMENTS_PROVIDER || (env.STRIPE_SECRET_KEY ? 'stripe' : 'none')).toLowerCase(),
      whop: { api_key: env.WHOP_API_KEY || '' },
      commas: { api_key: env.COMMAS_API_KEY || '' },
      paypal: { client_id: env.PAYPAL_CLIENT_ID || '', secret: env.PAYPAL_SECRET || '' },
      kajabi: { client_id: env.KAJABI_CLIENT_ID || '', secret: env.KAJABI_SECRET || '' },
      lemonsqueezy: { api_key: env.LEMONSQUEEZY_API_KEY || '' },
      paddle: { api_key: env.PADDLE_API_KEY || '' },
    },

    targets: { ...DEFAULT_TARGETS, ...parseJSON(env.TARGETS_JSON, {}) },
    ingest: { event_secret: env.EVENT_INGEST_SECRET || '' },
    alerts_webhook: env.ALERTS_WEBHOOK || '',
    build_key: env.BUILD_KEY || '',
    setup_code: env.SETUP_CODE || '',
    min_sample: Number(env.MIN_SAMPLE || 5),

    // Read by the shared sync helpers (lib/time.js, lib/classify.js, stripe.js).
    command: {
      currency_code: (env.CURRENCY_CODE || CURRENCY_CODES[env.CURRENCY_SYMBOL || '$'] || 'USD').toUpperCase(),
      sync: { enabled: String(env.SYNC || 'on').toLowerCase() !== 'off', lookback_days: Number(env.SYNC_LOOKBACK_DAYS || 120) },
      offers: [], tags: { webinar_registered: env.REGISTERED_TAG || 'webinar-registered' }, name_aliases: {},
      crm_fields: parseJSON(env.CRM_FIELDS_JSON, {}),
    },
    roster: {},
  };
}

// One stable object: every module holds a reference and reads at call time, so
// applySettings() can swap values in place.
const config = build(process.env);
function applySettings(overrides) { Object.assign(config, build({ ...process.env, ...(overrides || {}) })); }

// Is the chosen webinar / ad platform connected? Each adapter answers for itself. Required at
// call time: the registries require this module.
function adapterConnected(kind) {
  try {
    const adapter = (kind === 'ads' ? require('./sync/ads') : kind === 'payments' ? require('./sync/payments') : require('./sync/webinar')).adapter();
    return Boolean(adapter && typeof adapter.connected === 'function' && adapter.connected());
  } catch (e) { console.error(`[config] ${kind} adapters failed to load:`, e.message); return false; }
}

/** What is connected. Booleans only, never a key. */
function connections() {
  const c = config;
  return {
    webinar: adapterConnected('webinar'),
    crm: c.crm.provider === 'ghl' ? Boolean(c.crm.ghl.api_key && c.crm.ghl.location_id) : c.crm.provider === 'close' ? Boolean(c.crm.close.api_key) : false,
    calendar: Boolean(c.calendly.token),
    payments: adapterConnected('payments'),
    ads: adapterConnected('ads'),
  };
}

module.exports = { config, applySettings, connections, DEFAULT_TARGETS };
