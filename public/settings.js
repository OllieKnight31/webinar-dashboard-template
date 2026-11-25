/* Settings: the same tool cards as Setup step 4, plus targets, the password and the build key.
   Nothing here that Setup did not already explain. */
(function () {
  'use strict';
  var el = App.el, $ = App.$, api = App.api;
  var view = $('#view');
  var TARGETS = [
    ['registration_rate', 'Sign-up rate', 'Of the people who visit your sign-up page, how many sign up.'],
    ['show_up_rate', 'Show-up rate', 'Of the people who sign up, how many come live.'],
    ['stay_to_pitch_rate', 'Stayed to the offer', 'Of the people who come, how many are still watching when you make your offer.'],
    ['booking_rate', 'Booking rate', 'Of the people who come live, how many book a call.'],
    ['call_show_rate', 'Call show rate', 'Of the calls booked, how many people turn up.'],
    ['close_rate', 'Close rate', 'Of the people who turn up to a call, how many buy.'],
  ];
  var section = function (title, why) { var s = el('section', { className: 'ai-stack' }, el('h2', { className: 'ai-h3', textContent: title }), why ? el('p', { className: 'ws-note', textContent: why }) : null); return s; };

  function draw(intake, settings, session) {
    view.replaceChildren();
    var saveSettings = function (values, clear) { return api('source=settings', { values: values || {}, clear: clear || [] }).then(function (r) { if (r.code === 200) settings = r.data; return r; }); };
    var saveIntake = function (key, value) { var b = { intake: {} }; b.intake[key] = value; intake[key] = value; return api('source=intake', b); };

    var health = section('Are your tools working?', 'Tests every tool you have connected and tells you what to fix. Run it after you change anything below.');
    health.append(Health.panel());
    view.append(health);

    var tools = section('Your tools', 'Change which tool you use, or paste a new key. Press “Check connection” after any change.');
    Tools.SETS.forEach(function (set) {
      var box = el('div', { className: 'ai-card' });
      Tools.render(box, set, { intake: intake, fields: settings.fields, connected: settings.connected, addresses: settings.addresses, saveIntake: saveIntake, saveSettings: saveSettings,
        test: function (target) { return api('source=settings_test', { target: target }).then(function (r) { return r.data; }); } });
      tools.append(box);
    });
    view.append(tools);

    // targets, typed as whole percentages
    var targets = section('Your targets', 'The Results page marks each number as on target or under, against these. They start on sensible numbers for a webinar; change them once you know your own.');
    var card = el('div', { className: 'ai-card ai-stack' }), boxes = {}, said = el('span', { className: 'ws-note', attrs: { role: 'status' } });
    TARGETS.forEach(function (t) {
      var input = el('input', { className: 'ai-input', type: 'number', min: '0', max: '100', step: '1', id: 't_' + t[0], value: String(Math.round((settings.targets[t[0]] || 0) * 100)), style: { maxWidth: '120px' } });
      boxes[t[0]] = input;
      card.append(el('div', { className: 'ai-field' }, el('label', { htmlFor: input.id, textContent: t[1] + ' (%)' }), input, el('div', { className: 'ai-hint', textContent: t[2] + ' We suggest ' + Math.round(settings.default_targets[t[0]] * 100) + '%.' })));
    });
    var save = el('button', { type: 'button', className: 'ai-btn', textContent: 'Save targets' });
    save.onclick = function () {
      var out = {}, bad = '';
      TARGETS.forEach(function (t) { var n = Number(boxes[t[0]].value); if (!(n >= 0 && n <= 100)) bad = t[1]; out[t[0]] = n / 100; });
      if (bad) { said.textContent = bad + ' needs a number from 0 to 100.'; return; }
      saveSettings({ TARGETS_JSON: JSON.stringify(out) }).then(function (r) { said.textContent = r.code === 200 ? 'Saved.' : (r.data.message || 'That did not save. Try again.'); });
    };
    card.append(el('div', { className: 'ai-row' }, save, said));
    targets.append(card);
    view.append(targets);

    // password: only in setup mode can it be changed here
    var mode = (session && session.mode) || 'open';
    if (mode !== 'setup') {
      var lock = section('Password', mode === 'password'
        ? 'This site is protected by a password set in your hosting settings (ACCESS_PASSWORD). To change it, change it there and redeploy.'
        : 'This site has no password, so anyone with the address can open it. To add one, set ACCESS_PASSWORD in your hosting settings and redeploy.');
      view.append(lock);
    } else {
    var pw = section('Your password', 'Changing it signs you out everywhere else.');
    var cur = el('input', { className: 'ai-input', type: 'password', id: 'pwCur', autocomplete: 'current-password' }), nw = el('input', { className: 'ai-input', type: 'password', id: 'pwNew', autocomplete: 'new-password' });
    var pwSaid = el('span', { className: 'ws-note', attrs: { role: 'status' } }), pwBtn = el('button', { type: 'button', className: 'ai-btn', textContent: 'Change password' });
    pwBtn.onclick = function () { api('source=change_password', { current: cur.value, password: nw.value }).then(function (r) { pwSaid.textContent = r.data.message || (r.code === 200 ? 'Password changed.' : 'That did not work. Try again.'); if (r.code === 200) { cur.value = ''; nw.value = ''; } }); };
    pw.append(el('div', { className: 'ai-card ai-stack' },
      el('div', { className: 'ai-field' }, el('label', { htmlFor: 'pwCur', textContent: 'Your password now' }), App.reveal(cur)),
      el('div', { className: 'ai-field' }, el('label', { htmlFor: 'pwNew', textContent: 'Your new password' }), App.reveal(nw), el('div', { className: 'ai-hint', textContent: 'At least 8 characters.' })),
      el('div', { className: 'ai-row' }, pwBtn, pwSaid)));
    view.append(pw);
    }

    // for whoever runs the build
    var build = section('For the person building your webinar', 'The build runs in Claude Code. It uses this key to read your answers and to update the “What we are building for you” list. Only share it with whoever is doing your build.');
    build.append(el('div', { className: 'ai-card ai-stack' },
      el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Build key' }), settings.build_key ? App.copyRow(settings.build_key) : el('p', { className: 'ws-note', textContent: 'No build key has been set for this site yet. Whoever set it up can create one.' })),
      el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Address for sign-ups' }), App.copyRow(settings.addresses.register)),
      el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Address for the confirmation page survey' }), App.copyRow(settings.addresses.survey))));
    view.append(build);

    $('#novoice').classList.toggle('ws-hide', Voice.supported());
  }

  App.start('/settings', function (session) {
    Promise.all([api('action=intake'), api('action=settings')]).then(function (r) {
      if (r[0].code !== 200 || r[1].code !== 200) { view.textContent = (r[1].data || {}).message || 'We could not load your settings. Reload the page.'; return; }
      draw(r[0].data.intake, r[1].data, session);
    });
  });
})();
