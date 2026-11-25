/* The tools a webinar runs on, and how to connect each one. Used by Setup step 4 and by the
   Settings page, so both show exactly the same cards.

   For each kind of tool: first "Which one do you use?" as tiles, then ONLY the chosen tool's
   card: numbered steps, a link to the right page, a box to paste into, "Check connection",
   and a plain result. Anything optional sits under "More options".

   Tools.render(container, set, ctx)
     ctx = { intake, fields, connected, saveIntake(key, value), saveSettings(values) → Promise<{code, data}>,
             test(target) → Promise<{ok, message, picks}>, changed() } */
(function () {
  'use strict';
  var el = App.el;

  var key = function (k, label, helper, example) { return { key: k, label: label, helper: helper, example: example, kind: 'key' }; };

  var SETS = [
    {
      key: 'webinar_platform', title: 'Where does your webinar run?', conn: 'webinar', provider: 'WEBINAR_PROVIDER', test: 'webinar',
      why: 'Connecting it lets us show who signed up and who came, without you counting anything.',
      choices: [
        { id: 'webinarjam', label: 'WebinarJam', hint: 'Live webinars', provider: 'webinarjam', also: { WEBINARJAM_PRODUCT: 'webinarjam' } },
        { id: 'everwebinar', label: 'EverWebinar', hint: 'Pre-recorded', provider: 'webinarjam', also: { WEBINARJAM_PRODUCT: 'everwebinar' } },
        { id: 'ewebinar', label: 'eWebinar', hint: 'Pre-recorded', provider: 'ewebinar' },
        { id: 'aevent', label: 'aEvent', hint: 'Runs on Zoom', provider: 'aevent' },
        { id: 'other', label: 'Something else', provider: 'none', note: 'That is fine. We cannot read it directly, so sign-ups are counted from your sign-up page instead (you set that up in the last step, Go live).' },
        { id: 'none', label: 'I do not have one yet', provider: 'none', note: 'Our suggestion: WebinarJam for a live webinar, eWebinar for a pre-recorded one. Pick one, then come back here.' },
      ],
      cards: {
        webinarjam: {
          link: ['Open WebinarJam', 'https://app.webinarjam.com/'],
          steps: ['Open WebinarJam and log in.', 'Click your name at the top right, then <b>API</b>. (On some accounts it is under Integrations.)', 'If there is no key yet, press <b>Apply</b>. Approval can take a couple of working days.', 'Copy the long key and paste it below.'],
          fields: [key('WEBINARJAM_API_KEY', 'Your WebinarJam key', 'One long string of 64 letters and numbers.', 'a1b2c3d4… (64 characters)')],
          pick: { key: 'WEBINAR_IDS', label: 'Which webinar is this for?', helper: 'Tick the one you are launching. You can tick more than one.' },
          more: [{ key: 'WEBINAR_PITCH_MINUTE', label: 'How many minutes in do you make your offer?', helper: 'Lets us tell you how many people were still watching when you made it.', example: '45', kind: 'number' }],
        },
        ewebinar: {
          link: ['Open eWebinar integrations', 'https://app.ewebinar.com/home/setup/settings/integrations'],
          steps: ['Open eWebinar. You need to be an admin of the team.', 'Click your name, then <b>Integrations</b>.', 'Open <b>API access</b> and press <b>New key</b>. Tick <b>Registrants</b>, then press <b>Create key</b>.', 'Copy the key straight away (eWebinar only shows it once) and paste it below.'],
          fields: [key('EWEBINAR_API_KEY', 'Your eWebinar key', 'It starts with ew_api_', 'ew_api_…')],
          pick: { key: 'WEBINAR_IDS', label: 'Which webinar is this for?', helper: 'Tick the one you are launching. You can tick more than one.' },
          more: [{ key: 'WEBINAR_PITCH_PERCENT', label: 'How far through do you make your offer? (percent)', helper: 'eWebinar tells us how much of the webinar each person watched. If your offer starts two thirds of the way in, type 66.', example: '66', kind: 'number' }],
          note: 'eWebinar keeps part of its instructions for developers behind a login, so we could not test every part of this connection. If the check works but numbers do not arrive within a day, tell whoever set this up.',
        },
        aevent: {
          link: ['Open aEvent', 'https://app.aevent.com/'],
          warn: 'aEvent does not give out keys. We use the pass your browser holds while you are logged in, and it stops working the next time that same person logs in to aEvent. When that happens your numbers pause and you paste a new one here. A separate aEvent login used only for this avoids it.',
          steps: ['Log in to aEvent in Google Chrome.', 'Open Chrome’s menu, then <b>More tools</b>, then <b>Developer tools</b>. Click the <b>Application</b> tab.', 'On the left, open <b>Cookies</b> and click the aevent.com line.', 'Find the row called <b>token</b>, double-click its value, copy it and paste it below.'],
          fields: [key('AEVENT_TOKEN', 'Your aEvent token', 'One very long string.', 'eyJ…')],
          pick: { key: 'WEBINAR_IDS', label: 'Which webinar is this for?', helper: 'Tick the campaign you are launching.' },
          note: 'aEvent tells us who signed up and who came. It does not tell us how long people watched or who watched the replay, so those two numbers will say “not known”.',
        },
      },
    },
    {
      key: 'crm', title: 'Where do you keep your contacts?', conn: 'crm', provider: 'CRM_PROVIDER', test: 'crm',
      why: 'Often called a CRM. Connecting it means every sign-up is saved there as a contact, tagged “webinar-registered”.',
      choices: [
        { id: 'ghl', label: 'GoHighLevel', provider: 'ghl' }, { id: 'close', label: 'Close', provider: 'close' },
        { id: 'other', label: 'Something else', provider: 'none', note: 'That is fine. Sign-ups are still counted here; they just will not be copied into your contacts for you.' },
        { id: 'none', label: 'I do not have one yet', provider: 'none', note: 'Our suggestion: GoHighLevel, because it can also host your pages and send your emails and texts.' },
      ],
      cards: {
        ghl: {
          link: ['Open GoHighLevel', 'https://app.gohighlevel.com/'],
          steps: ['Open GoHighLevel and go into the account your business uses (the sub-account).', 'Click <b>Settings</b>, then <b>Private Integrations</b>, then <b>Create new integration</b>.', 'Tick: View Contacts, Edit Contacts, View Opportunities, Edit Opportunities.', 'Press Create, copy the key and paste it below.', 'For the location: copy the whole address from the top of your browser while you are in the account, and paste that in the second box. We pick the right part out.'],
          fields: [key('GHL_API_KEY', 'Your GoHighLevel key', 'It starts with pit-', 'pit-…'),
            { key: 'GHL_LOCATION_ID', label: 'Your GoHighLevel location', helper: 'Paste the address from your browser bar. It has /location/ in it.', example: 'https://app.gohighlevel.com/v2/location/AbC123…/dashboard', kind: 'link' }],
          pick: { key: 'GHL_PIPELINE_ID', single: true, none: 'No, just save them as contacts', label: 'Add each sign-up to a pipeline as well?', helper: 'A pipeline is the board where you move people along. This is optional.' },
        },
        close: {
          link: ['Open Close keys', 'https://app.close.com/settings/developer/api-keys/'],
          steps: ['Open Close, then <b>Settings</b>, <b>Developer</b>, <b>API Keys</b>.', 'Press <b>New API Key</b> and call it “Webinar System”.', 'Copy the key straight away (Close only shows it once) and paste it below.'],
          fields: [key('CLOSE_API_KEY', 'Your Close key', 'It starts with api_', 'api_…')],
        },
      },
    },
    {
      key: 'page_host', title: 'Where will your webinar pages live?', why: 'Your sign-up page and your confirmation page. We build them to fit whichever you choose.',
      choices: [
        { id: 'ghl', label: 'GoHighLevel' }, { id: 'lovable', label: 'Lovable' },
        { id: 'other', label: 'Somewhere else', note: 'That is fine. You will get the page content and the sign-up form details to put in yourself.' },
        { id: 'none', label: 'I do not know yet', note: 'Our suggestion: GoHighLevel if you already use it for contacts, otherwise Lovable.' },
      ],
    },
    {
      key: 'messages', title: 'What sends your emails and texts?', why: 'We write the reminder and follow-up messages to load into it. Just type the name of the tool.',
      text: [
        { key: 'email_tool', label: 'Emails are sent by', helper: 'The tool your emails go out from.', example: 'GoHighLevel, ActiveCampaign, Mailchimp' },
        { key: 'sms_tool', label: 'Texts are sent by', helper: 'Leave this empty if you do not send texts.', example: 'GoHighLevel, Twilio' },
      ],
    },
    {
      key: 'calendar', title: 'How do people book a call with you?', conn: 'calendar', test: 'calendar',
      why: 'Connecting your calendar shows how many people booked a call after the webinar, and how many turned up.',
      choices: [
        { id: 'calendly', label: 'Calendly' },
        { id: 'other', label: 'Something else', note: 'That is fine. Booked calls will say “not known” on your results until a calendar is connected.' },
        { id: 'none', label: 'People buy on the webinar, no call', note: 'Then you can skip this one.' },
      ],
      cards: {
        calendly: {
          link: ['Open Calendly keys', 'https://calendly.com/integrations/api_webhooks'],
          steps: ['Open Calendly, then <b>Integrations and apps</b>, then <b>API and webhooks</b>.', 'Under <b>Personal access tokens</b> press <b>Generate new token</b> and call it “Webinar System”.', 'Press <b>Copy token</b> (Calendly only shows it once) and paste it below.'],
          fields: [key('CALENDLY_TOKEN', 'Your Calendly key', 'One long string. Calendly calls it a personal access token.', 'eyJ…')],
          pick: { key: 'CALENDLY_BOOKED_TYPES', label: 'Which of these is your sales call?', helper: 'Tick the meeting people book after the webinar. Only ticked ones are counted.' },
          note: 'This needs a paid Calendly plan. We only read your bookings. Nothing is ever changed in Calendly.',
        },
      },
    },
    {
      key: 'payments', title: 'How do you take payment?', conn: 'payments', provider: 'PAYMENTS_PROVIDER', test: 'payments',
      why: 'Connecting it shows how many sales came from the webinar, and what it earned. Pick whatever you take money through.',
      choices: [
        { id: 'stripe', label: 'Stripe', provider: 'stripe' },
        { id: 'whop', label: 'Whop', provider: 'whop' },
        { id: 'commas', label: 'Commas', hint: 'Was Fanbasis', provider: 'commas' },
        { id: 'paypal', label: 'PayPal', provider: 'paypal' },
        { id: 'ghl', label: 'GoHighLevel', hint: 'Its own payments', provider: 'ghl' },
        { id: 'kajabi', label: 'Kajabi', provider: 'kajabi' },
        { id: 'lemonsqueezy', label: 'Lemon Squeezy', provider: 'lemonsqueezy' },
        { id: 'paddle', label: 'Paddle', provider: 'paddle' },
        { id: 'other', label: 'Something else', hint: 'ThriveCart, SamCart, Skool and others', provider: 'none', sales: true },
        { id: 'none', label: 'I am not taking payments yet', provider: 'none', note: 'That is fine. Sales will say “not known” on your results. You can add this later.' },
      ],
      cards: {
        stripe: {
          link: ['Open Stripe keys', 'https://dashboard.stripe.com/apikeys/create'],
          steps: ['Open Stripe, then <b>Developers</b>, <b>API keys</b>, <b>Create restricted key</b>. Check “Test mode” is switched off.', 'Call it “Webinar System”.', 'Set these to <b>Read</b> and leave everything else on None: Charges, Payment Intents, Refunds, Customers, Products, Prices.', 'Press <b>Create key</b>, then copy it and paste it below.'],
          fields: [key('STRIPE_SECRET_KEY', 'Your Stripe key', 'It starts with rk_live_. This kind of key can look at payments but can never move money.', 'rk_live_…')],
        },
        whop: {
          link: ['Open Whop', 'https://whop.com/dashboard'],
          steps: ['Open Whop and choose your business.', 'Open the <b>Developer</b> page and find <b>API keys</b>.', 'Press <b>Create</b> and call it “Webinar System”.', 'Give it permission to read <b>payments</b> and to read <b>member email addresses</b>. Without the email one we cannot tell which sign-up bought.', 'Copy the key and paste it below.'],
          fields: [key('WHOP_API_KEY', 'Your Whop key', 'One long string.', 'apik_…')],
          note: 'We only read your payments. Nothing is ever changed in Whop.',
        },
        commas: {
          link: ['Open Commas', 'https://www.fanbasis.com/'],
          steps: ['Open Commas (the new name for Fanbasis) and log in.', 'Open <b>Account</b>, then <b>API Keys</b>.', 'Create a key and call it “Webinar System”. It only needs the <b>payments</b> permission.', 'Copy the key and paste it below.'],
          fields: [key('COMMAS_API_KEY', 'Your Commas key', 'One long string.', '')],
          note: 'We only read your payments. Nothing is ever changed in Commas.',
        },
        paypal: {
          link: ['Open PayPal developer', 'https://developer.paypal.com/dashboard/applications/live'],
          steps: ['Open PayPal’s developer page and log in with your business account. Check the switch at the top says <b>Live</b>.', 'Press <b>Create App</b> and call it “Webinar System”.', 'Open the app, find <b>Features</b> and tick <b>Transaction Search</b>, then save.', 'Copy the <b>Client ID</b> and the <b>Secret</b> and paste them below.'],
          fields: [{ key: 'PAYPAL_CLIENT_ID', label: 'Your PayPal Client ID', helper: 'One long string.', example: 'AY…', kind: 'plain' }, key('PAYPAL_SECRET', 'Your PayPal Secret', 'One long string, shown when you press Show.', 'EK…')],
          note: 'PayPal can take a few hours to switch Transaction Search on, and up to three hours to show a new payment.',
        },
        ghl: {
          link: ['Open GoHighLevel', 'https://app.gohighlevel.com/'],
          steps: ['This uses the same key as your contacts, so connect GoHighLevel under “Where do you keep your contacts?” first.', 'In GoHighLevel open <b>Settings</b>, then <b>Private Integrations</b>, and open the key you made.', 'Tick <b>View Payment Transactions</b> as well, and save.', 'Press Check connection below.'],
          fields: [],
        },
        kajabi: {
          link: ['Open Kajabi settings', 'https://app.kajabi.com/admin/settings/public_api'],
          steps: ['Open Kajabi, then <b>Settings</b>, then <b>Public API</b>. This is only on some Kajabi plans.', 'Create a key and call it “Webinar System”.', 'Copy the <b>Client ID</b> and the <b>Client secret</b> and paste them below.'],
          fields: [{ key: 'KAJABI_CLIENT_ID', label: 'Your Kajabi Client ID', helper: 'One long string.', example: '', kind: 'plain' }, key('KAJABI_SECRET', 'Your Kajabi Client secret', 'One long string.', '')],
        },
        lemonsqueezy: {
          link: ['Open Lemon Squeezy keys', 'https://app.lemonsqueezy.com/settings/api'],
          steps: ['Open Lemon Squeezy, then <b>Settings</b>, then <b>API</b>.', 'Press the plus button, call the key “Webinar System” and create it.', 'Copy the key straight away (it is only shown once) and paste it below.'],
          fields: [key('LEMONSQUEEZY_API_KEY', 'Your Lemon Squeezy key', 'One very long string.', 'eyJ…')],
        },
        paddle: {
          link: ['Open Paddle', 'https://vendors.paddle.com/authentication-v2'],
          steps: ['Open Paddle, then <b>Developer tools</b>, then <b>Authentication</b>.', 'Create an API key and call it “Webinar System”. It only needs to <b>read transactions</b>.', 'Copy the key and paste it below.'],
          fields: [key('PADDLE_API_KEY', 'Your Paddle key', 'One long string.', 'pdl_live_…')],
        },
      },
    },
    {
      key: 'ads', title: 'Do you run ads for the webinar?', conn: 'ads', provider: 'ADS_PROVIDER', test: 'ads',
      why: 'Connecting your ad account shows what each sign-up, attendee and sale cost you.',
      choices: [
        { id: 'meta', label: 'Facebook and Instagram', hint: 'Meta ads', provider: 'meta' },
        { id: 'other', label: 'Somewhere else', provider: 'none', note: 'That is fine. The cost numbers will say “not known”; everything else still works.' },
        { id: 'none', label: 'No ads', provider: 'none', note: 'Then you can skip this one.' },
      ],
      cards: {
        meta: {
          link: ['Open Meta Business settings', 'https://business.facebook.com/settings/system-users'],
          steps: ['Open Meta Business settings, then <b>Users</b>, then <b>System users</b>. You need to be an admin of the business.', 'Press <b>Add</b>, call it “Webinar System” and choose <b>Employee</b>.', 'Press <b>Assign assets</b>, choose <b>Ad accounts</b>, pick your ad account and switch on <b>View performance</b>.', 'Press <b>Generate token</b>, set it to <b>never expire</b>, tick <b>ads_read</b>, then copy the key and paste it below.', 'For the ad account number: open Ads Manager, copy the whole address from the top of your browser and paste it in the second box.'],
          fields: [key('META_ACCESS_TOKEN', 'Your Meta key', 'It starts with EAA', 'EAA…'),
            { key: 'META_AD_ACCOUNT_ID', label: 'Your ad account', helper: 'Paste the Ads Manager address, or just the number after act=', example: '1234567890', kind: 'link' }],
          more: [{ key: 'META_CAMPAIGN_FILTER', label: 'Only count campaigns with this word in their name', helper: 'Useful if the same ad account also runs other campaigns.', example: 'webinar', kind: 'plain' }],
        },
      },
    },
  ];

  function field(def, ctx, values) {
    var saved = ctx.fields[def.key] || {};
    var input = el('input', { className: 'ai-input', id: 'f_' + def.key, type: def.kind === 'number' ? 'number' : 'text', autocomplete: 'off', spellcheck: false });
    input.dataset.kind = def.kind || 'plain';
    if (def.kind === 'key') { input.placeholder = saved.saved ? 'Saved (ends ' + String(saved.hint || '').replace(/^•+/, '') + '). Paste a new one to replace it.' : 'Paste it here'; }
    else { input.value = saved.value || ''; input.placeholder = def.example ? 'For example ' + def.example : ''; }
    input.addEventListener('input', function () { values[def.key] = input.value.trim(); });
    return el('div', { className: 'ai-field' }, el('label', { htmlFor: input.id, textContent: def.label }), input,
      el('div', { className: 'ai-hint', textContent: def.helper }));
  }

  function picker(card, ctx, picks, out) {
    var pick = card.pick, saved = (ctx.fields[pick.key] || {}).value || '';
    var chosen = pick.single ? (saved ? [saved] : []) : (function () { try { return JSON.parse(saved || '[]'); } catch (e) { return []; } })();
    var box = el('div', { className: 'ai-row' });
    var save = function () {
      var value = pick.single ? (chosen[0] || '') : JSON.stringify(chosen);
      var body = value && value !== '[]' ? { values: {} } : { values: {}, clear: [pick.key] };
      if (!body.clear) body.values[pick.key] = value;
      ctx.saveSettings(body.values, body.clear).then(function (r) { out.textContent = r.code === 200 ? 'Saved.' : (r.data.message || 'That did not save. Try again.'); out.className = 'ws-check__out ' + (r.code === 200 ? 'is-ok' : 'is-bad'); });
    };
    var items = (pick.single && pick.none ? [{ name: '', label: pick.none }] : []).concat(picks);
    items.forEach(function (p) {
      var on = pick.single ? (chosen[0] || '') === p.name : chosen.indexOf(p.name) >= 0;
      var b = el('button', { type: 'button', className: 'ai-choice' + (on ? ' is-on' : ''), textContent: p.label || p.name, attrs: { 'aria-pressed': on ? 'true' : 'false' } });
      b.onclick = function () {
        if (pick.single) chosen = p.name ? [p.name] : [];
        else if (chosen.indexOf(p.name) >= 0) chosen = chosen.filter(function (x) { return x !== p.name; }); else chosen.push(p.name);
        Array.prototype.forEach.call(box.children, function (c, i) { var is = pick.single ? (chosen[0] || '') === items[i].name : chosen.indexOf(items[i].name) >= 0; c.classList.toggle('is-on', is); c.setAttribute('aria-pressed', is ? 'true' : 'false'); });
        save();
      };
      box.append(b);
    });
    return el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: pick.label }), box, el('div', { className: 'ai-hint', textContent: pick.helper }));
  }

  function connectionCard(set, card, ctx) {
    var values = {};
    var out = el('div', { className: 'ws-check__out', attrs: { role: 'status' } });
    var pickSlot = el('div');
    var check = el('button', { type: 'button', className: 'ai-btn', textContent: 'Check connection' });
    var isOn = Boolean(set.conn && ctx.connected[set.conn]);
    if (isOn) { out.textContent = 'Connected.'; out.className = 'ws-check__out is-ok'; }
    check.onclick = function () {
      check.disabled = true; out.className = 'ws-check__out'; out.textContent = 'Checking…';
      var filled = {}; Object.keys(values).forEach(function (k) { if (values[k]) filled[k] = values[k]; });
      var save = Object.keys(filled).length ? ctx.saveSettings(filled) : Promise.resolve({ code: 200, data: {} });
      save.then(function (r) {
        if (r.code !== 200) { var f = r.data.fields || {}; return { ok: false, message: 'That did not work: ' + (Object.keys(f).length ? f[Object.keys(f)[0]] : (r.data.message || 'it could not be saved')) + '.' }; }
        return ctx.test(set.test);
      }).then(function (t) {
        check.disabled = false;
        out.textContent = t.message || (t.ok ? 'Connected.' : 'That did not work. Try again.');
        out.className = 'ws-check__out ' + (t.ok ? 'is-ok' : 'is-bad');
        pickSlot.replaceChildren(t.ok && card.pick && t.picks && t.picks.length ? picker(card, ctx, t.picks, out) : '');
        if (ctx.changed) ctx.changed();
      });
    };
    var more = (card.more || []).length ? el('details', { className: 'ws-more' }, el('summary', { textContent: 'More options' })) : null;
    if (more) {
      var extra = {};
      card.more.forEach(function (def) { more.append(field(def, ctx, extra)); });
      var saveMore = el('button', { type: 'button', className: 'ai-btn ai-btn--secondary ai-btn--sm', textContent: 'Save these', style: { marginTop: '12px' } });
      var said = el('span', { className: 'ws-note', style: { marginLeft: '10px' } });
      saveMore.onclick = function () { ctx.saveSettings(extra).then(function (r) { said.textContent = r.code === 200 ? 'Saved.' : (r.data.message || 'That did not save.'); }); };
      more.append(el('div', {}, saveMore, said));
    }
    var steps = el('ol', { className: 'ws-howto' });
    card.steps.forEach(function (s) { steps.append(el('li', { innerHTML: s })); });
    return el('div', { className: 'ai-card ws-tool' },
      card.warn ? el('div', { className: 'ai-banner ai-banner--warn', textContent: card.warn }) : null,
      el('div', { className: 'ai-label', textContent: 'How to connect it' }), steps,
      card.link ? el('div', {}, el('a', { className: 'ai-btn ai-btn--secondary ai-btn--sm', href: card.link[1], target: '_blank', rel: 'noopener', textContent: card.link[0], title: 'Opens in a new tab' })) : null,
      el('div', { className: 'ai-stack' }, card.fields.map(function (def) { return field(def, ctx, values); }).reduce(function (frag, n) { frag.append(n); return frag; }, document.createDocumentFragment())),
      el('div', { className: 'ws-check' }, check, out), pickSlot,
      card.note ? el('div', { className: 'ws-note', textContent: card.note }) : null, more);
  }

  /** For a payment tool we cannot read: an address it sends each sale to, made on the spot. */
  function salesCard(ctx) {
    var made = Boolean((ctx.fields.EVENT_INGEST_SECRET || {}).saved);
    var slot = el('div', { className: 'ai-stack' });
    var create = el('button', { type: 'button', className: 'ai-btn' });
    function draw(address) {
      slot.replaceChildren();
      if (address) {
        slot.append(el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Your sales address' }), App.copyRow(address),
          el('div', { className: 'ai-hint', textContent: 'Copy it now. For safety we cannot show it again, only make a new one. Treat it like a password.' })));
      } else if (made) slot.append(el('div', { className: 'ws-check__out is-ok', textContent: 'Your sales address has been made. If you have lost it, make a new one. The old one stops working.' }));
      create.textContent = made ? 'Make a new address' : 'Make my sales address';
      slot.append(el('div', {}, create));
    }
    create.onclick = function () {
      var bytes = new Uint8Array(20); window.crypto.getRandomValues(bytes);
      var secret = Array.prototype.map.call(bytes, function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
      create.disabled = true;
      ctx.saveSettings({ EVENT_INGEST_SECRET: secret }).then(function (r) {
        create.disabled = false;
        if (r.code !== 200) { slot.prepend(el('div', { className: 'ws-check__out is-bad', textContent: r.data.message || 'That did not save. Try again.' })); return; }
        made = true; draw((ctx.addresses || {}).sales + '&key=' + secret);
        if (ctx.changed) ctx.changed();
      });
    };
    draw('');
    var steps = el('ol', { className: 'ws-howto' });
    ['Press the button below to make your sales address, and copy it.',
      'In your payment tool, look for <b>Webhooks</b> or <b>Notifications</b>. Add a new one for a <b>successful payment</b> and paste the address in. In ThriveCart it is under Settings, then API and webhooks.',
      'If your tool has no such setting (Skool, for example), use <b>Zapier</b> or <b>Make</b>: choose your tool’s “new sale” as the start, and “send a webhook” to this address as the action.',
      'Make sure it sends the buyer’s <b>email address</b> and the <b>amount</b>. The email is how we know which sign-up bought.',
      'Make a small test purchase, then open “Test that everything is connected” to see that it arrived.'].forEach(function (t) { steps.append(el('li', { innerHTML: t })); });
    return el('div', { className: 'ai-card ws-tool' }, el('div', { className: 'ai-label', textContent: 'How to connect it' }), steps, slot,
      el('div', { className: 'ws-note', textContent: 'This works for any tool that can tell another tool when someone pays. We never see your payment account, only the sales it sends.' }));
  }

  /** Draw one kind of tool: the question, the tiles, then the chosen tool's card (or note). */
  function render(container, set, ctx) {
    container.replaceChildren();
    var body = el('div', { className: 'ai-stack' });
    if (set.text) {
      set.text.forEach(function (def) {
        var input = el('input', { className: 'ai-input', type: 'text', id: 'i_' + def.key, value: ctx.intake[def.key] || '', placeholder: 'For example ' + def.example });
        input.dataset.voice = '';
        input.addEventListener('change', function () { ctx.saveIntake(def.key, input.value.trim()); });
        body.append(el('div', { className: 'ai-field' }, el('label', { htmlFor: input.id, textContent: def.label }), input, el('div', { className: 'ai-hint', textContent: def.helper })));
      });
    } else {
      var current = ctx.intake[set.key] || '';
      var tiles = el('div', { className: 'ws-tiles', attrs: { role: 'group', 'aria-label': set.title } });
      var detail = el('div');
      var show = function () {
        var choice = set.choices.filter(function (c) { return c.id === current; })[0];
        var card = choice && set.cards && set.cards[choice.provider || choice.id];
        detail.replaceChildren(card ? connectionCard(set, card, ctx) : choice && choice.sales ? salesCard(ctx) : (choice && choice.note ? el('div', { className: 'ai-banner', textContent: choice.note }) : ''));
      };
      set.choices.forEach(function (c) {
        var b = el('button', { type: 'button', className: 'ws-tile', attrs: { 'aria-pressed': c.id === current ? 'true' : 'false' } }, c.label, c.hint ? el('small', { textContent: c.hint }) : null);
        b.onclick = function () {
          current = c.id;
          Array.prototype.forEach.call(tiles.children, function (t, i) { t.setAttribute('aria-pressed', set.choices[i].id === current ? 'true' : 'false'); });
          ctx.saveIntake(set.key, c.id);
          if (set.provider) { var v = {}; v[set.provider] = c.provider || 'none'; Object.keys(c.also || {}).forEach(function (k) { v[k] = c.also[k]; }); ctx.saveSettings(v).then(show); } else show();
        };
        tiles.append(b);
      });
      body.append(tiles, detail);
      show();
    }
    var chip = set.conn ? el('span', { className: 'ai-chip ' + (ctx.connected[set.conn] ? 'ai-chip--ok' : 'ai-chip--na'), textContent: ctx.connected[set.conn] ? 'Connected' : 'Not connected yet' }) : null;
    container.append(el('div', { className: 'ws-q' }, el('div', { className: 'ai-row', style: { justifyContent: 'space-between' } }, el('h2', { className: 'ws-q__title', textContent: set.title }), chip),
      el('p', { className: 'ws-q__why', textContent: set.why }), body));
    if (window.Voice) Voice.enhance(container);
  }

  window.Tools = { SETS: SETS, render: render };
})();
