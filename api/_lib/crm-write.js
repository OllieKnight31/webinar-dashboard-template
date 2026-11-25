// CRM write-back for the public registration relay: put a webinar registrant (and later
// their survey answers) on the connected CRM. GoHighLevel or Close, by config.crm.provider.
//
//   upsertRegistrant(person) → { status: 'ok'|'skipped'|'error', contact_id, message }
//   addNote(email, text, contactId?) → the same shape
//
// Never throws: the relay must still save the row when the CRM is down.
//
// GoHighLevel   POST /contacts/upsert (keys on email within the location) with the UTM values
//               in the custom fields named in CRM_FIELDS_JSON, then POST /contacts/{id}/tags
//               to ADD the registration tag (TAG_MAP_JSON webinar_registered). The tag goes
//               in a second call because tags sent on the upsert replace the contact's tags.
//               Needs the contacts.write scope the settings guide already asks for.
// Close         Close has no tags. The lead is found by email (or created), the UTM values go
//               into the lead custom fields named in CRM_FIELDS_JSON, the lead status is set
//               when CRM_FIELDS_JSON carries "webinar_registered_status" (a lead status id),
//               and a note records the registration either way.

const { config } = require('./config');
const CLOSE_BASE = 'https://api.close.com/api/v1';
// Close: HTTP Basic with the key as the username and an empty password.
const closeHeaders = (apiKey) => ({ Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, Accept: 'application/json' });

const GHL_BASE = 'https://services.leadconnectorhq.com';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

const tagName = () => String((config.command.tags && config.command.tags.webinar_registered) || 'webinar-registered');
/** [[custom field id, value]] for the UTM values this business has a CRM field for. */
function utmFields(person) {
  const ids = config.command.crm_fields || {};
  return UTM_KEYS.filter(k => ids[k] && person[k]).map(k => [String(ids[k]), String(person[k])]);
}

function crmWritable() {
  const c = config.crm;
  if (c.provider === 'ghl') return Boolean(c.ghl.api_key && c.ghl.location_id);
  if (c.provider === 'close') return Boolean(c.close.api_key);
  return false;
}

async function call(url, { method = 'GET', headers, body }) {
  const resp = await fetch(url, {
    method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
  });
  let json = {};
  try { json = await resp.json(); } catch { /* empty body */ }
  return { ok: resp.ok, status: resp.status, json };
}
const fail = (step, r) => ({ status: 'error', message: `${step} answered ${r.status}${r.json && r.json.message ? `: ${String(r.json.message).slice(0, 160)}` : ''}` });

// ── GoHighLevel ─────────────────────────────────────────────────────────────
// GoHighLevel sits behind Cloudflare, which turns away the default Node user agent.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const ghlHeaders = () => ({ Authorization: `Bearer ${config.crm.ghl.api_key}`, Version: '2021-07-28', Accept: 'application/json', 'User-Agent': BROWSER_UA });

async function ghlUpsert(person) {
  const up = await call(`${GHL_BASE}/contacts/upsert`, { method: 'POST', headers: ghlHeaders(), body: {
    locationId: config.crm.ghl.location_id,
    email: person.email,
    firstName: person.first_name || undefined,
    lastName: person.last_name || undefined,
    phone: person.phone || undefined,
    source: 'Webinar registration',
    customFields: utmFields(person).map(([id, value]) => ({ id, field_value: value })),
  } });
  if (!up.ok) return fail('GoHighLevel contact upsert', up);
  const contactId = (up.json.contact || {}).id || up.json.id || '';
  if (!contactId) return { status: 'error', message: 'GoHighLevel returned no contact id' };
  const tag = await call(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, { method: 'POST', headers: ghlHeaders(), body: { tags: [tagName()] } });
  if (!tag.ok) return { ...fail('GoHighLevel add tag', tag), contact_id: contactId };
  // With a pipeline chosen on Setup, the sign-up also gets a card in it (the pipeline's first stage).
  const pipelineId = config.crm.ghl.pipeline_id;
  if (pipelineId) {
    const name = [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email;
    const opp = await call(`${GHL_BASE}/opportunities/upsert`, { method: 'POST', headers: ghlHeaders(), body: { pipelineId, locationId: config.crm.ghl.location_id, contactId, name: `${name} (webinar)`, status: 'open' } });
    if (!opp.ok) return { ...fail('GoHighLevel add to pipeline', opp), contact_id: contactId };
  }
  return { status: 'ok', contact_id: contactId, message: `contact saved and tagged ${tagName()}${pipelineId ? ', added to your pipeline' : ''}` };
}

async function ghlContactId(email) {
  const r = await call(`${GHL_BASE}/contacts/upsert`, { method: 'POST', headers: ghlHeaders(), body: { locationId: config.crm.ghl.location_id, email } });
  return r.ok ? ((r.json.contact || {}).id || r.json.id || '') : '';
}

async function ghlNote(email, text, contactId) {
  const id = contactId || await ghlContactId(email);
  if (!id) return { status: 'error', message: 'GoHighLevel contact not found' };
  const r = await call(`${GHL_BASE}/contacts/${encodeURIComponent(id)}/notes`, { method: 'POST', headers: ghlHeaders(), body: { body: text } });
  return r.ok ? { status: 'ok', contact_id: id, message: 'note added' } : { ...fail('GoHighLevel add note', r), contact_id: id };
}

// ── Close ───────────────────────────────────────────────────────────────────
const closeAuth = () => closeHeaders(config.crm.close.api_key);

async function closeLeadId(email) {
  const q = encodeURIComponent(`email:"${String(email).replace(/"/g, '')}"`);
  const r = await call(`${CLOSE_BASE}/lead/?query=${q}&_fields=id&_limit=1`, { headers: closeAuth() });
  return r.ok && r.json.data && r.json.data[0] ? r.json.data[0].id : '';
}

async function closeUpsert(person) {
  const ids = config.command.crm_fields || {};
  const custom = Object.fromEntries(utmFields(person).map(([id, value]) => [`custom.${id}`, value]));
  const status = ids.webinar_registered_status ? { status_id: String(ids.webinar_registered_status) } : {};
  let leadId = await closeLeadId(person.email);
  if (leadId) {
    if (Object.keys(custom).length || status.status_id) {
      const put = await call(`${CLOSE_BASE}/lead/${leadId}/`, { method: 'PUT', headers: closeAuth(), body: { ...custom, ...status } });
      if (!put.ok) return { ...fail('Close lead update', put), contact_id: leadId };
    }
  } else {
    const name = [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email;
    const made = await call(`${CLOSE_BASE}/lead/`, { method: 'POST', headers: closeAuth(), body: {
      name, ...custom, ...status,
      contacts: [{ name, emails: [{ email: person.email, type: 'office' }], phones: person.phone ? [{ phone: person.phone, type: 'mobile' }] : [] }],
    } });
    if (!made.ok) return fail('Close lead create', made);
    leadId = made.json.id || '';
  }
  const utm = UTM_KEYS.filter(k => person[k]).map(k => `${k}=${person[k]}`).join(', ');
  const note = await closeNote(person.email, `Registered for the webinar (${tagName()}).${utm ? ` ${utm}` : ''}`, leadId);
  if (note.status !== 'ok') return { ...note, contact_id: leadId };
  return { status: 'ok', contact_id: leadId, message: `lead saved${status.status_id ? ' and status set' : ''}, registration noted` };
}

async function closeNote(email, text, leadId) {
  const id = leadId || await closeLeadId(email);
  if (!id) return { status: 'error', message: 'Close lead not found' };
  const r = await call(`${CLOSE_BASE}/activity/note/`, { method: 'POST', headers: closeAuth(), body: { lead_id: id, note: text } });
  return r.ok ? { status: 'ok', contact_id: id, message: 'note added' } : { ...fail('Close add note', r), contact_id: id };
}

// ── Public ──────────────────────────────────────────────────────────────────
async function guarded(run) {
  if (!crmWritable()) return { status: 'skipped', message: 'no CRM connected' };
  try { return await run(); }
  catch (e) { return { status: 'error', message: e && e.name === 'TimeoutError' ? 'the CRM did not answer in time' : (e && e.message) || 'CRM request failed' }; }
}

const upsertRegistrant = (person) => guarded(() => (config.crm.provider === 'close' ? closeUpsert(person) : ghlUpsert(person)));
const addNote = (email, text, contactId) => guarded(() => (config.crm.provider === 'close' ? closeNote(email, text, contactId) : ghlNote(email, text, contactId)));

module.exports = { upsertRegistrant, addNote, crmWritable, tagName };
