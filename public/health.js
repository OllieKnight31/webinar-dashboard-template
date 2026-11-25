/* Test every connection. One button proves each tool really works (not just that a key was
   pasted), and one form sends a sign-up down the real path. Shown on Setup step 4, on the
   last step, and at the top of Settings, so it is always the same panel.

     Health.panel({ goTo: function (id) {} })   → the element */
(function () {
  'use strict';
  var el = App.el, api = App.api;
  var CHIP = { ok: ['Working', 'ok'], warn: ['Needs a look', 'warn'], fail: ['Not working', 'crit'], off: ['Not connected', 'na'], manual: ['Check by hand', 'na'], untested: ['Not tested yet', 'warn'] };

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso), mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'Tested just now';
    if (mins < 60) return 'Tested ' + mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    if (mins < 1440) return 'Tested ' + Math.round(mins / 60) + (Math.round(mins / 60) === 1 ? ' hour ago' : ' hours ago');
    return 'Tested on ' + d.toLocaleDateString();
  }

  function panel(opts) {
    opts = opts || {};
    var checks = [], busy = {};
    var verdict = el('div', { className: 'ai-banner', attrs: { role: 'status' } });
    var list = el('div', { className: 'ws-board' });
    var all = el('button', { type: 'button', className: 'ai-btn', textContent: 'Test every connection' });

    function drawVerdict(d) {
      var c = d.counts || {};
      verdict.className = 'ai-banner' + (c.fail ? ' ai-banner--warn' : '');
      if (c.fail) verdict.textContent = c.fail + (c.fail === 1 ? ' connection is' : ' connections are') + ' not working. Each one says what to do underneath it.';
      else if (c.untested) verdict.textContent = 'Press “Test every connection” to check that everything you have connected really works.';
      else if (c.warn) verdict.textContent = 'Nothing is broken, but ' + c.warn + (c.warn === 1 ? ' connection needs' : ' connections need') + ' a look before you launch.';
      else if (d.all_working) verdict.textContent = 'Everything you have connected is working.' + (c.manual ? ' ' + c.manual + (c.manual === 1 ? ' thing' : ' things') + ' can only be checked by hand, as described below.' : '');
      else verdict.textContent = 'Nothing is connected yet. Connect your tools in the questions before this one, then test them here.';
    }
    function draw() {
      list.replaceChildren();
      checks.forEach(function (c) {
        var chip = busy[c.id] ? ['Testing…', 'na'] : (CHIP[c.status] || CHIP.untested);
        var again = el('button', { type: 'button', className: 'ws-skip', textContent: c.status === 'untested' ? 'Test this one' : 'Test again', disabled: Boolean(busy[c.id]) });
        again.onclick = function () { run(c.id); };
        list.append(el('div', { className: 'ws-item ws-health is-' + c.status },
          el('div', { className: 'ws-item__name', textContent: c.label }),
          el('span', { className: 'ai-chip ai-chip--' + chip[1], textContent: chip[0] }),
          el('div', { className: 'ws-item__meta' }, c.message, c.tested_at ? el('span', { className: 'ws-health__when', textContent: ' ' + when(c.tested_at) + '.' }) : null),
          c.status === 'off' ? null : el('div', { className: 'ws-health__act' }, again)));
      });
    }
    function merge(fresh) {
      fresh.forEach(function (f) { var i = checks.map(function (c) { return c.id; }).indexOf(f.id); if (i >= 0) checks[i] = f; else checks.push(f); });
    }
    function reload() {
      return api('action=connections').then(function (r) { if (r.code === 200) { checks = r.data.checks; drawVerdict(r.data); draw(); } });
    }
    function run(id) {
      var ids = id ? [id] : checks.map(function (c) { return c.id; });
      ids.forEach(function (i) { busy[i] = true; });
      all.disabled = true; if (!id) all.textContent = 'Testing…';
      draw();
      api('source=connections_test', id ? { id: id } : {}).then(function (r) {
        ids.forEach(function (i) { delete busy[i]; });
        all.disabled = false; all.textContent = 'Test every connection';
        if (r.code !== 200) { verdict.className = 'ai-banner ai-banner--warn'; verdict.textContent = r.data.message || 'The test could not run. Try again in a minute.'; draw(); return; }
        merge(r.data.checks);
        // the verdict is always about the whole list, not the one line just tested
        reload();
      });
    }
    all.onclick = function () { run(); };

    // one sign-up, down the real path
    var first = el('input', { className: 'ai-input', type: 'text', placeholder: 'Your first name', attrs: { 'aria-label': 'Your first name' } });
    var email = el('input', { className: 'ai-input', type: 'email', placeholder: 'Your own email address', autocomplete: 'email', attrs: { 'aria-label': 'Your own email address' } });
    var send = el('button', { type: 'button', className: 'ai-btn ai-btn--secondary', textContent: 'Send a test sign-up' });
    var out = el('div', { className: 'ws-board' }), said = el('div', { className: 'ws-check__out', attrs: { role: 'status' } });
    send.onclick = function () {
      send.disabled = true; said.className = 'ws-check__out'; said.textContent = 'Sending…'; out.replaceChildren();
      api('source=test_signup', { first_name: first.value.trim(), email: email.value.trim() }).then(function (r) {
        send.disabled = false;
        said.textContent = r.data.message || 'That did not work. Try again.';
        said.className = 'ws-check__out ' + (r.code === 200 && r.data.ok ? 'is-ok' : 'is-bad');
        (r.data.steps || []).forEach(function (s) {
          var chip = CHIP[s.status] || CHIP.fail;
          out.append(el('div', { className: 'ws-item' }, el('div', { className: 'ws-item__name', textContent: s.message }), el('span', { className: 'ai-chip ai-chip--' + chip[1], textContent: s.status === 'ok' ? 'Done' : chip[0] })));
        });
        if (r.data.join_url) out.append(el('div', { className: 'ws-item' }, el('div', { className: 'ws-item__name' }, 'Your link to join the webinar: ', el('a', { className: 'ws-link', href: r.data.join_url, target: '_blank', rel: 'noopener', textContent: 'open it' })), el('span', { className: 'ai-chip ai-chip--ok', textContent: 'Done' })));
        if (r.code === 200) reload();
      });
    };

    reload();
    return el('div', { className: 'ai-stack' },
      verdict, el('div', { className: 'ai-row' }, all, el('span', { className: 'ws-note', textContent: 'Takes about ten seconds. To prove contacts can be saved, we add one test contact and remove it straight away.' })),
      list,
      el('div', { className: 'ws-doc' },
        el('div', { className: 'ws-doc__top' }, el('h3', { textContent: 'Then send one sign-up all the way through' })),
        el('p', { className: 'ws-doc__blurb', textContent: 'This does exactly what your sign-up page does when a real person signs up: it saves them here, adds them to your contacts and signs them up on your webinar platform. Use your own email address so you can see what arrives.' }),
        el('div', { className: 'ai-grid', style: { '--ai-min': '200px' } }, first, email),
        el('div', { className: 'ws-check' }, send, said), out));
  }

  window.Health = { panel: panel };
})();
