/* Setup: the guide. Seven steps, one question per screen, saved as you go.
   Every answer is saved the moment it changes (typing, a tap, or dictation ending), so there
   is no Save button to forget. Back and Next move one screen; the place you reached is
   remembered on this device and on the server, so it reopens where you left off. */
(function () {
  'use strict';
  var el = App.el, $ = App.$, api = App.api;
  // the build board's lines in everyday words (the build scripts address them by id)
  var PLAIN = { intake: 'Your answers', access: 'Your tools connected', messaging: 'Your core message, agreed with you', landing_page: 'Sign-up page', confirmation_page: 'Confirmation page',
    landing_video: 'Script for the video on your sign-up page', confirmation_video: 'Script for the video on your confirmation page', breakout_videos: 'Short videos that answer each hesitation',
    pre_emails: 'Reminder emails before the webinar', post_emails: 'Follow-up emails after the webinar', sms: 'Reminder texts', call_sequences: 'Messages for people who book a call',
    ad_scripts: 'Scripts for your video ads', static_ads: 'Image ads', webinar_script: 'The webinar itself: script and slides', crm_loaded: 'Emails and texts loaded into your tools',
    platform_wired: 'Your webinar platform set up', pages_published: 'Pages published', tracking_live: 'Results page receiving your numbers', e2e_test: 'Tested from start to finish' };
  var STATUS = { not_started: ['Not started', 'na'], in_progress: ['Being built', 'warn'], needs_review: ['Ready for you to check', 'warn'], done: ['Done', 'ok'], blocked: ['Waiting on something', 'crit'] };

  var state = { intake: {}, design: {}, catalogue: {}, missing: [], settings: null, board: [], checks: [], step: 1, screen: 0, deep: null };
  var view = $('#view'), saved = $('#saved');

  // ── saving ────────────────────────────────────────────────────────────────
  var timers = {};
  function said(text, bad) { saved.textContent = text; saved.classList.toggle('is-bad', Boolean(bad)); }
  function saveIntake(key, value) {
    state.intake[key] = value;
    said('Saving…');
    var body = { intake: {} }; body.intake[key] = value;
    return api('source=intake', body).then(function (r) {
      if (r.code !== 200) { said(r.data.message || 'That did not save. Check your connection.', true); return r; }
      state.missing = r.data.missing || []; state.intake = r.data.intake;
      said('Saved');
      return r;
    });
  }
  /** Save a moment after typing stops, and straight away when the field is left or dictation ends. */
  function autosave(input, key, read) {
    var go = function () { clearTimeout(timers[key]); saveIntake(key, read()); };
    input.addEventListener('input', function () { said('…'); clearTimeout(timers[key]); timers[key] = setTimeout(go, 700); });
    input.addEventListener('change', go);
  }
  function saveSettings(values, clear) {
    return api('source=settings', { values: values || {}, clear: clear || [] }).then(function (r) { if (r.code === 200) state.settings = r.data; return r; });
  }

  // ── question building blocks ──────────────────────────────────────────────
  function question(q, body) {
    var node = el('section', { className: 'ws-q' },
      el('h2', { className: 'ws-q__title', textContent: q.title }),
      el('p', { className: 'ws-q__why', textContent: q.why }), body,
      q.example ? el('p', { className: 'ws-q__eg' }, el('b', { textContent: 'For example: ' }), q.example) : null);
    if (q.deep && Deep.get(q.deep)) {
      var more = el('a', { className: 'ws-link', href: '#', textContent: 'Open “' + Deep.get(q.deep).title + '”' });
      more.onclick = function (e) { e.preventDefault(); openDeep(q.deep); };
      node.append(el('p', { className: 'ws-q__more' }, q.deepWhy || 'Not sure what to write, or have more to say? There is a ready-made questionnaire for this. ', more));
    }
    return node;
  }
  function textQ(q) {
    var input = el(q.long ? 'textarea' : 'input', { className: q.long ? 'ai-textarea' : 'ai-input', id: 'i_' + q.key, value: state.intake[q.key] || '', placeholder: q.placeholder || '' });
    if (!q.long) input.type = q.type || 'text';
    if (q.long) input.rows = 5;
    if (!q.type && !q.noVoice) input.dataset.voice = '';
    if (q.kind) input.dataset.kind = q.kind;
    input.setAttribute('aria-label', q.title);
    autosave(input, q.key, function () { return input.value.trim(); });
    return question(q, el('div', { className: 'ai-field' }, input, q.helper ? el('div', { className: 'ai-hint', textContent: q.helper }) : null));
  }
  function choiceQ(q, after) {
    var tiles = el('div', { className: 'ws-tiles', attrs: { role: 'group', 'aria-label': q.title } });
    q.options.forEach(function (o) {
      var b = el('button', { type: 'button', className: 'ws-tile', attrs: { 'aria-pressed': state.intake[q.key] === o[0] ? 'true' : 'false' } }, o[1], o[2] ? el('small', { textContent: o[2] }) : null);
      b.onclick = function () {
        Array.prototype.forEach.call(tiles.children, function (t) { t.setAttribute('aria-pressed', t === b ? 'true' : 'false'); });
        saveIntake(q.key, o[0]).then(function () { if (after) after(); });
      };
      tiles.append(b);
    });
    return question(q, tiles);
  }
  function listQ(q) {
    var items = (state.intake[q.key] || []).slice();
    while (items.length < Math.min(q.min, 3)) items.push('');
    var box = el('div', { className: 'ws-list' }), count = el('div', { className: 'ai-hint' });
    var add = el('button', { type: 'button', className: 'ai-btn ai-btn--secondary ai-btn--sm', textContent: 'Add another' });
    var save = function () { clearTimeout(timers[q.key]); saveIntake(q.key, items.map(function (s) { return s.trim(); }).filter(Boolean)); };
    var tally = function () {
      var n = items.filter(function (s) { return s.trim(); }).length;
      count.textContent = q.min > 1 ? n + ' so far. Aim for ' + q.min + ' to ' + q.max + '.' : n + ' so far.';
      add.disabled = items.length >= q.max;
    };
    var draw = function (focusLast) {
      box.replaceChildren();
      items.forEach(function (value, i) {
        var input = el('input', { className: 'ai-input', type: 'text', value: value, placeholder: q.placeholder || '' });
        input.dataset.voice = ''; input.setAttribute('aria-label', q.title + ', number ' + (i + 1));
        input.addEventListener('input', function () { items[i] = input.value; tally(); said('…'); clearTimeout(timers[q.key]); timers[q.key] = setTimeout(save, 700); });
        input.addEventListener('change', function () { items[i] = input.value; save(); });
        var x = el('button', { type: 'button', className: 'ws-x', textContent: '×', title: 'Remove this one', attrs: { 'aria-label': 'Remove number ' + (i + 1) } });
        x.onclick = function () { items.splice(i, 1); draw(); save(); };
        box.append(el('div', { className: 'ws-list__row' }, el('span', { className: 'ws-list__n', textContent: String(i + 1) }), input, x));
      });
      tally(); Voice.enhance(box);
      if (focusLast) { var all = box.querySelectorAll('input'); if (all.length) all[all.length - 1].focus(); }
    };
    add.onclick = function () { items.push(''); draw(true); };
    draw();
    return question(q, el('div', { className: 'ai-stack' }, box, el('div', { className: 'ai-row' }, add, count)));
  }
  function resultsQ(q) {
    var rows = (state.intake.client_results || []).map(function (r) { return { name: r.name, before: r.before, after: r.after, permission: r.permission }; });
    while (rows.length < 3) rows.push({ name: '', before: '', after: '', permission: false });
    var save = function () { clearTimeout(timers.client_results); saveIntake('client_results', rows); };
    var wrap = el('div', { className: 'ai-stack' });
    rows.slice(0, 3).forEach(function (r, i) {
      var box = function (key, label, placeholder, long) {
        var input = el(long ? 'textarea' : 'input', { className: long ? 'ai-textarea' : 'ai-input', value: r[key] || '', placeholder: placeholder });
        if (!long) input.type = 'text'; else input.rows = 2;
        input.dataset.voice = ''; input.setAttribute('aria-label', label + ', result ' + (i + 1));
        input.addEventListener('input', function () { r[key] = input.value; said('…'); clearTimeout(timers.client_results); timers.client_results = setTimeout(save, 700); });
        input.addEventListener('change', function () { r[key] = input.value; save(); });
        return el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: label }), input);
      };
      var tick = el('input', { type: 'checkbox', checked: r.permission === true });
      tick.onchange = function () { r.permission = tick.checked; save(); };
      wrap.append(el('div', { className: 'ws-result' }, el('div', { className: 'ai-label', textContent: 'Result ' + (i + 1) }),
        box('name', 'Who was it?', 'For example Sarah, a physiotherapist', false),
        box('before', 'Where were they before?', 'For example fully booked but only earning 3k a month', true),
        box('after', 'What changed?', 'For example 9k a month within 90 days, working four days a week', true),
        el('label', { className: 'ai-check' }, tick, 'They have said we can use their name and result')));
    });
    return question(q, wrap);
  }

  // ── the ready-made questionnaires ─────────────────────────────────────────
  var deepOpts = { open: function (id) { openDeep(id); }, business: function () { return state.intake.business_name || ''; }, moved: function (copy) { if (state.deep) state.deep.copy = copy; } };
  function deeper(step) { return function () { return Deep.stepScreen(step, deepOpts); }; }
  /** Open one questionnaire on top of the guide. Back returns to the screen you were on. */
  function openDeep(id) {
    var q = Deep.get(id);
    if (!q) return;
    state.deep = { id: id, copy: 1 };
    if (q.step !== state.step) { state.step = q.step; state.screen = STEPS[q.step - 1].screens.length - 1; }
    draw(); window.scrollTo(0, 0);
  }
  function closeDeep() { state.deep = null; draw(); window.scrollTo(0, 0); }

  // ── the screens ───────────────────────────────────────────────────────────
  var live = function () { return state.intake.webinar_format !== 'automated'; };
  var STEPS = [
    { title: 'Your webinar', screens: [
      function () { return textQ({ key: 'business_name', required: true, title: 'What is your business called?', why: 'We use it on your pages and in your emails.', example: 'Acme Coaching' }); },
      function () { return listQ({ deep: 'origin_story', deepWhy: 'Want the presenter’s story on the page? There is a ready-made questionnaire for it. ', key: 'hosts', required: true, min: 1, max: 6, title: 'Who presents the webinar?', why: 'Their names go on the sign-up page and in the reminders.', example: 'Sam Jones', placeholder: 'A presenter’s name' }); },
      function () { return textQ({ deep: 'webinar_plan', key: 'webinar_title', required: true, title: 'What is the webinar called?', why: 'A working title is fine. We will sharpen it with you later.', example: 'How to fill your diary without cold calling' }); },
      function () { return choiceQ({ key: 'webinar_format', required: true, title: 'Is it live or pre-recorded?', why: 'This changes the reminders we write and which tools suit you.', options: [['live', 'Live', 'You present it at a set time'], ['automated', 'Pre-recorded', 'It plays on its own, again and again']] }); },
      function () {
        if (!live()) return textQ({ key: 'schedule', required: true, title: 'How often does it run?', why: 'So the sign-up page can show people when they can watch.', example: 'Every day at 7pm, or every 15 minutes' });
        var tz = state.intake.timezone || (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
        if (!state.intake.timezone && tz) saveIntake('timezone', tz);
        var date = el('input', { className: 'ai-input', type: 'date', value: state.intake.webinar_date || '', attrs: { 'aria-label': 'Date' } });
        var time = el('input', { className: 'ai-input', type: 'time', value: state.intake.webinar_time || '', attrs: { 'aria-label': 'Start time' } });
        var zone = el('input', { className: 'ai-input', type: 'text', value: tz, placeholder: 'Europe/London', attrs: { 'aria-label': 'Timezone' } });
        date.onchange = function () { saveIntake('webinar_date', date.value); }; time.onchange = function () { saveIntake('webinar_time', time.value); };
        zone.onchange = function () { saveIntake('timezone', zone.value.trim()); };
        return question({ key: 'webinar_date', required: true, title: 'When is it?', why: 'We count the reminders back from this. If you have not picked a date yet, skip this for now.' },
          el('div', { className: 'ai-grid', style: { '--ai-min': '160px' } },
            el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Date' }), date),
            el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Start time' }), time),
            el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Timezone' }), zone, el('div', { className: 'ai-hint', textContent: 'We filled this in from your computer. Change it if the webinar is somewhere else.' }))));
      },
      deeper(1),
    ] },
    { title: 'Your audience', screens: [
      function () { return textQ({ deep: 'ideal_client', key: 'audience', required: true, long: true, title: 'Who is the webinar for?', why: 'The clearer the person, the better every page and email reads.', example: 'Owners of small physiotherapy clinics who are fully booked but not earning enough', helper: 'Say what they do, where they are now, and what they have already tried.' }); },
      function () { return listQ({ key: 'pains', required: true, min: 5, max: 10, title: 'What are their biggest frustrations?', why: 'These become the opening lines of your page and your ads. Use the words they use.', example: '“I am busy all week and still worry about paying the bills”', placeholder: 'One frustration' }); },
      function () { return listQ({ key: 'outcomes', required: true, min: 5, max: 10, title: 'What do they want instead?', why: 'These become the promises on your page.', example: '“A full diary of the right clients, and Fridays off”', placeholder: 'One thing they want' }); },
      function () { return listQ({ deep: 'ideal_client', key: 'objections', required: true, min: 1, max: 12, title: 'Why do they hesitate?', why: 'Each reason becomes a short video and an email that answers it.', example: '“I have tried something like this before and it did not work”', placeholder: 'One reason they hold back' }); },
      deeper(2),
    ] },
    { title: 'Your offer and proof', screens: [
      function () { return textQ({ deep: 'offer', key: 'offer_name', required: true, title: 'What do you offer at the end of the webinar?', why: 'The thing people can buy or book once they have watched.', example: 'The 12 week Clinic Growth Programme' }); },
      function () { return textQ({ key: 'offer_price', required: true, title: 'What does it cost?', why: 'So the messaging fits the price. It is not shown anywhere unless you want it to be.', example: '£3,000, or from £250 a month' }); },
      function () { return choiceQ({ key: 'how_people_buy', title: 'How do people buy?', why: 'This decides what the webinar asks people to do at the end.', options: [['call', 'They book a call first', 'Best for higher prices'], ['webinar', 'They buy on the webinar', 'No call needed']] }); },
      function () {
        if (state.intake.how_people_buy === 'webinar') return question({ key: 'booking_link', title: 'Booking link', why: 'You said people buy on the webinar, so there is no call to book. Press Next.' }, '');
        return textQ({ key: 'booking_link', required: true, kind: 'link', noVoice: true, title: 'What is your booking link?', why: 'Where people go to book a call with you. We put it in the webinar and the follow-up emails.', example: 'https://calendly.com/your-name/call', helper: 'Paste the address of your booking page. No booking page yet? Skip this for now.' });
      },
      function () { return resultsQ({ deep: 'case_study', deepWhy: 'Want the full story from each client? There is a ready-made questionnaire you can send them. ', key: 'client_results', required: true, title: 'Tell us about three clients you have helped', why: 'Real results are the most convincing thing on the page. Tick the box only if the client has agreed.' }); },
      function () { return textQ({ deep: 'rules', key: 'compliance_notes', long: true, title: 'Is there anything you are not allowed to say?', why: 'Rules from your industry, your ad platform, or simply words you dislike. We will keep to them everywhere.', example: 'No income promises. Never say “guaranteed”. Always add a disclaimer under results.' }); },
      deeper(3),
    ] },
    { title: 'Your tools', screens: Tools.SETS.map(function (set) {
      return function () {
        var box = el('div');
        Tools.render(box, set, {
          intake: state.intake, fields: state.settings.fields, connected: state.settings.connected, addresses: state.settings.addresses,
          saveIntake: saveIntake, saveSettings: saveSettings,
          test: function (target) { return api('source=settings_test', { target: target }).then(function (r) { return r.data; }); },
          changed: function () { api('action=settings').then(function (r) { if (r.code === 200) state.settings = r.data; }); },
        });
        return box;
      };
    }).concat([healthScreen, deeper(4)]) },
    { title: 'Your look', screens: [lookScreen, deeper(5)] },
    { title: 'Build', screens: [buildScreen] },
    { title: 'Go live', screens: [goLiveScreen] },
  ];
  // which screen asks for which answer, so "still needed" can link straight to it
  var WHERE = { business_name: [1, 0], hosts: [1, 1], webinar_title: [1, 2], webinar_format: [1, 3], webinar_date: [1, 4], schedule: [1, 4], audience: [2, 0], pains: [2, 1], outcomes: [2, 2], objections: [2, 3],
    offer_name: [3, 0], offer_price: [3, 1], booking_link: [3, 3], client_results: [3, 4], webinar_platform: [4, 0], crm: [4, 1], page_host: [4, 2], email_tool: [4, 3] };
  var NAMES = { business_name: 'Business name', hosts: 'Who presents', webinar_title: 'Webinar title', webinar_format: 'Live or pre-recorded', webinar_date: 'Date and time', schedule: 'How often it runs', audience: 'Who it is for',
    pains: 'Their frustrations (at least 5)', outcomes: 'What they want (at least 5)', objections: 'Why they hesitate', offer_name: 'Your offer', offer_price: 'The price', booking_link: 'Booking link',
    client_results: 'Three client results', webinar_platform: 'Webinar platform', crm: 'Where you keep contacts', page_host: 'Where your pages live', email_tool: 'What sends your emails' };

  // ── step 4, last question: prove every connection works ──────────────────
  function healthScreen() {
    return question({ title: 'Test that everything is connected', why: 'A key being saved is not the same as a tool working. This checks each one properly and tells you in plain words what to fix. Run it again any time you change a tool.' }, Health.panel());
  }

  // ── step 5: your look ─────────────────────────────────────────────────────
  var radius = function (s) { return { square: '4px', rounded: '10px', pill: '999px' }[s] || '10px'; };
  var family = function (n) { return "'" + n + "', system-ui, sans-serif"; };
  function inkOn(hex) { var m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#fff'; var c = [0, 2, 4].map(function (i) { return parseInt(m[1].slice(i, i + 2), 16); }); return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 150 ? '#111' : '#fff'; }
  function lookScreen() {
    var cat = state.catalogue, box = el('div');
    var fontsOf = function (id) { return cat.font_pairs.filter(function (f) { return f.id === id; })[0] || { heading: 'Inter', body: 'Inter' }; };
    var saveDesign = function (change) {
      said('Saving…');
      var body = { design: {} }; Object.keys(state.design).forEach(function (k) { body.design[k] = state.design[k]; }); Object.keys(change).forEach(function (k) { body.design[k] = change[k]; });
      api('source=intake', body).then(function (r) { if (r.code !== 200) { said(r.data.message || 'That did not save.', true); return; } state.design = r.data.design; said('Saved'); draw(); });
    };
    var picks = function (items, isOn, drawOne, choose) {
      var grid = el('div', { className: 'ws-picks' });
      items.forEach(function (item) {
        var b = el('button', { type: 'button', className: 'ws-pick', attrs: { 'aria-pressed': isOn(item) ? 'true' : 'false' } }, drawOne(item), el('span', { className: 'ws-pick__name', textContent: item.label }));
        b.onclick = function () { choose(item); };
        grid.append(b);
      });
      return grid;
    };
    function hero() {
      var d = state.design, p = cat.presets.filter(function (x) { return x.id === d.preset; })[0] || cat.presets[0], f = d.fonts || fontsOf(d.font_pairing), brand = d.brand_color || p.brand;
      var btn = el('span', { className: 'ws-hero__btn', textContent: 'Save my seat', style: { background: brand, color: inkOn(brand), borderRadius: radius(d.button_shape) } });
      var video = el('div', { className: 'ws-hero__video', textContent: 'Your video', style: { background: p.surface, color: p.muted } });
      var copy = el('div', {}, el('div', { className: 'ws-hero__eyebrow', textContent: live() ? 'Free live training' : 'Free training, watch now', style: { color: brand } }),
        el('h3', { textContent: (state.intake.webinar_title || '').trim() || 'The headline of your webinar page', style: { fontFamily: family(f.heading) } }),
        el('p', { textContent: (state.intake.audience || '').split(/[.\n]/)[0].slice(0, 140) || 'A line that says who it is for and what they will learn.', style: { color: p.muted } }));
      var h;
      if (d.hero_layout === 'split_form') {
        var line = function (t) { return el('span', { textContent: t, style: { background: p.background, color: p.muted } }); };
        btn.style.textAlign = 'center';
        copy.append(el('div', { style: { height: '16px' } }), video);
        h = el('div', { className: 'ws-hero split' }, copy, el('div', { className: 'ws-hero__form', style: { background: p.surface } }, line('First name'), line('Email address'), btn));
      } else h = el('div', { className: 'ws-hero popup' }, copy, video, btn, el('p', { textContent: 'The form opens when the button is pressed.', style: { fontSize: '12px', color: p.muted } }));
      h.style.background = p.background; h.style.color = p.text; h.style.fontFamily = family(f.body);
      return el('div', { className: 'ws-preview' }, h);
    }
    function draw() {
      var d = state.design;
      var colour = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(d.brand_color || '') ? d.brand_color : '#2563EB', attrs: { 'aria-label': 'Pick your brand colour' } });
      colour.onchange = function () { saveDesign({ brand_color: colour.value.toUpperCase() }); };
      box.replaceChildren(
        question({ title: 'Which look feels most like you?', why: 'Click one. This sets the colours and style of your sign-up and confirmation pages. You can change it any time.' },
          picks(cat.presets, function (p) { return p.id === d.preset; }, function (p) {
            var f = fontsOf(p.fonts);
            var m = el('span', { className: 'ws-mini', style: { background: p.background, color: p.text, fontFamily: family(f.body) } }, el('i', { textContent: 'Free live training' }), el('b', { textContent: 'The headline of your page', style: { fontFamily: family(f.heading) } }),
              el('s', { textContent: 'Who it is for and what they will learn.', style: { color: p.muted } }), el('u', { textContent: 'Save my seat', style: { background: p.brand, color: inkOn(p.brand), borderRadius: radius(p.radius) } }));
            return m;
          }, function (p) { saveDesign({ preset: p.id, brand_color: p.brand, font_pairing: p.fonts, button_shape: p.radius }); })),
        question({ title: 'What is your brand colour?', why: 'Used for buttons and highlights on your pages. Click the square to pick one.' },
          el('div', { className: 'ws-colour' }, colour, el('span', { className: 'ai-code', textContent: d.brand_color || '' }),
            el('button', { type: 'button', className: 'ai-btn ai-btn--secondary ai-btn--sm', textContent: 'Use this look’s own colour', onclick: function () { var p = cat.presets.filter(function (x) { return x.id === d.preset; })[0]; if (p) saveDesign({ brand_color: p.brand }); } }))),
        question({ title: 'Which lettering do you prefer?', why: 'The first is for headlines, the second for everything else.' },
          picks(cat.font_pairs, function (f) { return f.id === d.font_pairing; }, function (f) { return el('span', { className: 'ws-fontpick' }, el('b', { textContent: 'A clear headline', style: { fontFamily: family(f.heading) } }), el('span', { textContent: 'And the text underneath it.', style: { fontFamily: family(f.body) } })); }, function (f) { saveDesign({ font_pairing: f.id }); })),
        question({ title: 'How should the top of your sign-up page be laid out?', why: 'Either the video first with a button, or the sign-up form showing straight away.' },
          picks(cat.hero_layouts, function (l) { return l.id === d.hero_layout; }, function (l) {
            return l.id === 'split_form' ? el('span', { className: 'ws-wire split' }, el('span', {}, el('i', { style: { height: '10px' } }), el('i', { className: 'v', style: { height: '44px' } })), el('span', { className: 'f' }, el('i'), el('i'), el('i', { className: 'c' })))
              : el('span', { className: 'ws-wire popup' }, el('i', { style: { width: '70%', justifySelf: 'center' } }), el('i', { className: 'v' }), el('i', { className: 'c' }));
          }, function (l) { saveDesign({ hero_layout: l.id }); })),
        question({ title: 'What shape should buttons be?', why: 'A small thing that changes the feel of the page.' },
          picks(cat.button_shapes, function (s) { return s.id === d.button_shape; }, function (s) { return el('span', { className: 'ws-shape' }, el('span', { textContent: 'Save my seat', style: { borderRadius: radius(s.id), background: d.brand_color, color: inkOn(d.brand_color) } })); }, function (s) { saveDesign({ button_shape: s.id }); })),
        question({ title: 'Here is how it looks together', why: 'A rough preview of the top of your sign-up page with your choices.' }, hero()));
    }
    draw();
    return box;
  }

  // ── step 6: build ─────────────────────────────────────────────────────────
  var boardTimer = null;
  function buildScreen() {
    var list = el('div', { className: 'ws-board' }), head = el('div'), need = el('div');
    function draw() {
      var done = state.board.filter(function (i) { return i.status === 'done'; }).length, total = state.board.length;
      head.replaceChildren(el('div', { className: 'ws-progress' }, el('div', { className: 'ws-progress__top' }, el('b', { textContent: done + ' of ' + total + ' done' })), el('div', { className: 'ws-progress__bar' }, el('i', { style: { width: (total ? Math.round(done / total * 100) : 0) + '%' } }))));
      var missing = state.missing.filter(function (k) { return WHERE[k]; });
      need.replaceChildren(missing.length ? el('div', { className: 'ai-banner ai-banner--warn' }, el('span', {}, el('b', { textContent: 'A few answers are still needed before the build can start: ' }),
        missing.map(function (k) { var a = el('a', { className: 'ws-link', href: '#', textContent: NAMES[k] || k }); a.onclick = function (e) { e.preventDefault(); go(WHERE[k][0], WHERE[k][1]); }; return a; }).reduce(function (f, a, i) { if (i) f.append(', '); f.append(a); return f; }, document.createDocumentFragment()), '.')) : '');
      // do not redraw a row somebody is typing in
      var focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.ws-item') : null;
      if (focused) return;
      list.replaceChildren();
      state.board.forEach(function (item) {
        var st = STATUS[item.status] || STATUS.not_started;
        var meta = el('div', { className: 'ws-item__meta' });
        if (/^https?:\/\//i.test(item.link || '')) meta.append(el('a', { className: 'ws-link', href: item.link, target: '_blank', rel: 'noopener', textContent: 'Open it' }), item.note ? '  ·  ' : '');
        if (item.note) meta.append(item.note);
        var row = el('div', { className: 'ws-item', dataset: { id: item.id } }, el('div', { className: 'ws-item__name', textContent: PLAIN[item.id] || item.label }), el('span', { className: 'ai-chip ai-chip--' + st[1], textContent: st[0] }), meta);
        if (item.status === 'needs_review') {
          var note = el('input', { className: 'ai-input', type: 'text', placeholder: 'Anything to change? Say it here', attrs: { 'aria-label': 'What to change in ' + (PLAIN[item.id] || item.label) } });
          note.dataset.voice = '';
          var ok = el('button', { type: 'button', className: 'ai-btn ai-btn--sm', textContent: 'Looks good' });
          var change = el('button', { type: 'button', className: 'ai-btn ai-btn--secondary ai-btn--sm', textContent: 'Send this change' });
          ok.onclick = function () { setItem({ id: item.id, status: 'done' }); };
          change.onclick = function () { if (!note.value.trim()) { note.focus(); return; } setItem({ id: item.id, status: 'in_progress', note: 'Change asked for: ' + note.value.trim() }); };
          row.append(el('div', { className: 'ai-stack', style: { gridColumn: '1 / -1', '--ai-stack': '8px' } }, note, el('div', { className: 'ai-row' }, ok, change)));
        }
        list.append(row);
      });
      Voice.enhance(list);
    }
    function setItem(update) { said('Saving…'); api('source=build_status', { items: [update] }).then(function (r) { if (r.code === 200) { state.board = r.data.items; said('Saved'); if (document.activeElement) document.activeElement.blur(); draw(); } else said(r.data.message || 'That did not save.', true); }); }
    function refresh() { api('action=build_status').then(function (r) { if (r.code === 200) { state.board = r.data.items; draw(); } }); }
    clearInterval(boardTimer); boardTimer = setInterval(function () { if (!document.hidden && state.step === 6) refresh(); }, 20000);
    draw(); refresh();
    return el('div', {}, question({ title: 'What we are building for you', why: 'Every piece of your webinar, and where it is up to. The build runs in Claude Code and updates this page as it goes, so you can leave it open. When something says “Ready for you to check”, open it and tell us if it looks good.' },
      el('div', { className: 'ai-stack' }, need, head, list)));
  }

  // ── step 7: go live ───────────────────────────────────────────────────────
  function goLiveScreen() {
    var a = state.settings.addresses, f = state.settings.fields;
    var ticks = el('div', { className: 'ws-board' });
    var drawTicks = function () {
      ticks.replaceChildren();
      state.checks.forEach(function (c) {
        var box = el('input', { type: 'checkbox', checked: c.done });
        box.onchange = function () { said('Saving…'); api('source=golive', { id: c.id, done: box.checked }).then(function (r) { if (r.code === 200) { state.checks = r.data.checks; said('Saved'); } else said(r.data.message || 'That did not save.', true); }); };
        ticks.append(el('label', { className: 'ws-tick' }, box, el('b', { textContent: c.label }), el('span', { textContent: c.help })));
      });
    };
    drawTicks();
    var conf = el('input', { className: 'ai-input', type: 'url', value: (f.WEBINAR_CONFIRMATION_URL || {}).value || '', placeholder: 'https://your-site.com/confirmed', attrs: { 'aria-label': 'Confirmation page address' } });
    var confOut = el('div', { className: 'ai-hint', textContent: 'The page people land on straight after signing up. Paste its address here.' });
    conf.onchange = function () {
      var v = conf.value.trim();
      saveSettings(v ? { WEBINAR_CONFIRMATION_URL: v } : {}, v ? [] : ['WEBINAR_CONFIRMATION_URL']).then(function (r) { confOut.textContent = r.code === 200 ? 'Saved.' : ((r.data.fields || {}).WEBINAR_CONFIRMATION_URL || r.data.message || 'That did not save.') + ' It should look like https://your-site.com/confirmed'; });
    };
    var sites = el('input', { className: 'ai-input', type: 'text', value: (f.WEBINAR_ALLOWED_ORIGINS || {}).value || '', placeholder: 'https://your-site.com', attrs: { 'aria-label': 'Sites allowed to send sign-ups' } });
    sites.dataset.kind = 'link';
    sites.onchange = function () { var v = sites.value.trim(); saveSettings(v ? { WEBINAR_ALLOWED_ORIGINS: v } : {}, v ? [] : ['WEBINAR_ALLOWED_ORIGINS']); };
    return el('div', {},
      question({ title: 'Check every connection one last time', why: 'Before you send people to your webinar, make sure every tool is still working and that a sign-up goes all the way through.' }, Health.panel()),
      question({ title: 'Connect your sign-up page', why: 'Your sign-up form sends each new sign-up to the first address below. That is how they reach your contacts, your webinar platform and your results. Whoever builds your page pastes it in; if we are building it, this is already done.' },
        el('div', { className: 'ai-stack' },
          el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Address for sign-ups' }), App.copyRow(a.register)),
          el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Address for the short survey on your confirmation page' }), App.copyRow(a.survey)),
          el('div', { className: 'ai-field' }, el('label', { textContent: 'Your confirmation page address' }), conf, confOut),
          el('details', { className: 'ws-more' }, el('summary', { textContent: 'More options' }),
            el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Only accept sign-ups from these sites' }), sites, el('div', { className: 'ai-hint', textContent: 'Optional. Type the address of the site your pages are on. Sign-ups sent from anywhere else are then refused. Separate more than one with a comma.' }))))),
      question({ title: 'Test it from start to finish', why: 'Go through your own webinar as if you were a stranger, and tick each line as it works. When every line is ticked, you are ready to send people to it.' }, ticks));
  }

  // ── moving about ──────────────────────────────────────────────────────────
  function total() { return STEPS.length; }
  function remember() {
    try { localStorage.setItem('ws-setup', JSON.stringify({ step: state.step, screen: state.screen })); } catch (e) { /* private mode */ }
    api('source=intake', { progress: { step: state.step } });
  }
  function go(step, screen) {
    state.deep = null;
    if (tour.asked && (step !== state.step || (screen || 0) !== state.screen)) tour.asked = false;
    state.step = Math.max(1, Math.min(total(), step));
    var screens = STEPS[state.step - 1].screens;
    state.screen = Math.max(0, Math.min(screens.length - 1, screen || 0));
    draw(); remember();
    window.scrollTo(0, 0);
  }
  function next() { var s = STEPS[state.step - 1].screens; if (state.screen < s.length - 1) go(state.step, state.screen + 1); else if (state.step < total()) go(state.step + 1, 0); else location.href = '/results'; }
  function back() { if (state.deep) return closeDeep(); if (state.screen > 0) go(state.step, state.screen - 1); else if (state.step > 1) go(state.step - 1, STEPS[state.step - 2].screens.length - 1); }

  function draw() {
    var step = STEPS[state.step - 1], screens = step.screens, last = state.step === total() && state.screen === screens.length - 1;
    var before = STEPS.slice(0, state.step - 1).reduce(function (n, s) { return n + s.screens.length; }, 0) + state.screen;
    var all = STEPS.reduce(function (n, s) { return n + s.screens.length; }, 0);
    $('#where').textContent = 'Step ' + state.step + ' of ' + total() + (screens.length > 1 ? ' · question ' + (state.screen + 1) + ' of ' + screens.length : '');
    $('#stepTitle').textContent = step.title;
    $('#bar').style.width = Math.round((before + 1) / all * 100) + '%';
    var nav = $('#stepnav'); nav.replaceChildren();
    STEPS.forEach(function (s, i) {
      // only the step you are on shows its name, so all seven fit on a phone
      var on = i + 1 === state.step;
      var b = el('a', { href: '#', title: s.title, className: 'ai-step' + (on ? ' is-active' : ' ws-step--n') + (i + 1 < state.step ? ' is-done' : ''), attrs: { 'aria-label': 'Step ' + (i + 1) + ': ' + s.title } }, el('span', { className: 'ai-step__n', textContent: String(i + 1) }), on ? s.title : null);
      if (i + 1 === state.step) b.setAttribute('aria-current', 'step');
      b.onclick = function (e) { e.preventDefault(); go(i + 1, 0); };
      nav.append(b);
    });
    showTour();
    $('#back').textContent = state.deep ? 'Back to Setup' : 'Back';
    $('#next').classList.toggle('ws-hide', Boolean(state.deep));
    if (state.deep) {
      // a questionnaire is open: same page, its own title, and Back closes it
      $('#where').textContent = 'Step ' + state.step + ' of ' + total() + ' · questionnaire';
      $('#stepTitle').textContent = Deep.get(state.deep.id).title;
      view.replaceChildren(Deep.view(state.deep.id, { copy: state.deep.copy, business: deepOpts.business, moved: deepOpts.moved }));
      Voice.enhance(view);
      $('#novoice').classList.toggle('ws-hide', Voice.supported());
      $('#back').disabled = false;
      $('#skip').classList.add('ws-hide');
      said('');
      return null;
    }
    view.replaceChildren(screens[state.screen]());
    var mics = Voice.enhance(view);
    $('#novoice').classList.toggle('ws-hide', Voice.supported() || !view.querySelector('[data-voice]'));
    $('#back').disabled = state.step === 1 && state.screen === 0;
    $('#next').textContent = last ? 'See your results' : 'Next';
    $('#skip').classList.toggle('ws-hide', state.step >= 5);
    said('');
    return mics;
  }
  $('#back').onclick = back; $('#next').onclick = next; $('#skip').onclick = next;

  // ── the walkthrough video: shown at the very start, and whenever it is asked for ──
  var tour = { asked: false, hidden: false };
  try { tour.hidden = localStorage.getItem('ws-tour-hidden') === '1'; } catch (e) { /* private mode */ }
  if (/[?&](tour=off|capture=1)\b/.test(location.search)) tour.hidden = true;
  function showTour() {
    var first = state.step === 1 && state.screen === 0 && !state.deep;
    var on = tour.asked || (first && !tour.hidden);
    $('#tour').classList.toggle('ws-hide', !on);
    if (!on) $('#tourVideo').pause();
  }
  $('#tourOpen').onclick = function () { tour.asked = true; showTour(); $('#tour').scrollIntoView({ block: 'start' }); $('#tourVideo').play().catch(function () { /* the play button is right there */ }); };
  $('#tourClose').onclick = function () { tour.asked = false; tour.hidden = true; try { localStorage.setItem('ws-tour-hidden', '1'); } catch (e) { /* private mode */ } showTour(); };

  App.start('/', function () {
    Deep.init({ said: said });
    Promise.all([api('action=intake'), api('action=settings'), api('action=build_status'), api('action=golive'), Deep.load()]).then(function (r) {
      if (r[0].code !== 200) { view.textContent = r[0].data.message || 'We could not load your answers. Reload the page.'; return; }
      state.intake = r[0].data.intake; state.design = r[0].data.design; state.catalogue = r[0].data.catalogue; state.missing = r[0].data.missing || [];
      state.settings = r[1].data; state.board = r[2].data.items || []; state.checks = r[3].data.checks || [];
      $('#nostore').classList.toggle('ws-hide', r[0].data.storage !== 'none');
      var here = null; try { here = JSON.parse(localStorage.getItem('ws-setup') || 'null'); } catch (e) { here = null; }
      var m = /^#step-(\d)(?:-(\d+))?$/.exec(location.hash);
      var dq = /^#q-([a-z_]+)$/.exec(location.hash);   // a link straight to one questionnaire
      if (dq && Deep.get(dq[1])) openDeep(dq[1]);
      else if (m) go(Number(m[1]), Number(m[2] || 1) - 1);
      else if (here && here.step) go(here.step, here.screen); else go((r[0].data.progress || {}).step || 1, 0);
    });
  });
})();
