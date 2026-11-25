/* Webinar System: what every page shares. The sign-in gate, the one nav, the footer, a small
   API helper and a few DOM helpers. No build step, no framework. */
(function () {
  'use strict';
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  /** el('div', {className: 'x', onclick: fn, dataset: {k: v}}, child, 'text', …) */
  function el(tag, props) {
    var n = document.createElement(tag), p = props || {};
    Object.keys(p).forEach(function (key) {
      if (key === 'dataset') Object.keys(p.dataset).forEach(function (d) { n.dataset[d] = p.dataset[d]; });
      else if (key === 'attrs') Object.keys(p.attrs).forEach(function (a) { n.setAttribute(a, p.attrs[a]); });
      else if (key === 'style' && typeof p.style === 'object') Object.keys(p.style).forEach(function (s) { n.style[s] = p.style[s]; });
      else n[key] = p[key];
    });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null && c !== '' && c !== false) n.append(c); }
    return n;
  }

  /** GET (no body) or POST. → { code, data }. A 401 sends the visitor to the sign-in screen. */
  function api(path, body) {
    return fetch('/api?' + path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }).then(function (resp) {
      return resp.json().catch(function () { return { message: 'We got an answer we could not read. Try again.' }; }).then(function (data) {
        if (resp.status === 401 && !/^\/login/.test(location.pathname)) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)); }
        return { code: resp.status, data: data };
      });
    }, function () { return { code: 0, data: { message: 'We could not reach the site. Check your internet connection and try again.' } }; });
  }

  function copyButton(text, label) {
    var b = el('button', { type: 'button', className: 'ai-btn ai-btn--secondary ai-btn--sm', textContent: label || 'Copy' });
    b.onclick = function () {
      var done = function () { var was = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = was; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else { var t = el('textarea', { value: text }); document.body.append(t); t.select(); try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ } t.remove(); done(); }
    };
    return b;
  }
  /** An address (or any text) in a box with a Copy button. */
  function copyRow(text) { return el('div', { className: 'ws-copy' }, el('code', { textContent: text }), copyButton(text)); }

  var NAV = [['/', 'Setup'], ['/results', 'Results'], ['/settings', 'Settings']];
  var ICON = { sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M3 13l1.1-1.1M11.9 4.1 13 3"/></svg>' };
  function theme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  var LOGIN = true;   // set from the session: false when the site has no password
  function shell(active) {
    var here = function (href) { return href === active; };
    var links = el('nav', { className: 'ai-top__links', attrs: { 'aria-label': 'Main' } });
    NAV.forEach(function (n) { var a = el('a', { href: n[0], textContent: n[1] }); if (here(n[0])) a.setAttribute('aria-current', 'page'); links.append(a); });
    var themeBtn = el('button', { type: 'button', className: 'ai-iconbtn', innerHTML: ICON.sun, title: 'Switch between light and dark', attrs: { 'aria-label': 'Switch between light and dark' } });
    themeBtn.onclick = function () { var next = theme() === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); try { localStorage.setItem('ws-theme', next); } catch (e) { /* private mode */ } };
    var out = el('button', { type: 'button', className: 'ai-btn ai-btn--ghost ai-btn--sm ws-topout', textContent: 'Sign out' });
    out.onclick = function () { api('source=logout', {}).then(function () { location.replace('/login'); }); };
    var top = el('header', { className: 'ai-top' }, el('div', { className: 'ai-wrap ai-top__in' },
      el('a', { className: 'ai-top__brand', href: '/', style: { textDecoration: 'none', color: 'inherit' } }, el('span', { className: 'ai-top__name', id: 'wsBrand' }), el('span', { className: 'ai-top__title', textContent: 'Webinar System' })),
      links, el('div', { className: 'ai-top__tools' }, themeBtn, active && LOGIN ? out : null)));
    document.body.prepend(top);
    var foot = el('footer', { className: 'ai-wrap' }, el('div', { className: 'ai-foot' }, el('span', { className: 'ws-quiet', textContent: 'Webinar System' }),
      active && LOGIN ? el('a', { href: '#', className: 'ws-note', textContent: 'Sign out', onclick: function (e) { e.preventDefault(); out.onclick(); } }) : null));
    document.body.append(foot);
    fetch('/api?action=config').then(function (r) { return r.json(); }).then(function (c) { if (c && c.brand && c.brand.name && c.brand.name !== 'Your business') $('#wsBrand').textContent = c.brand.name; }).catch(function () {});
  }

  /** Every page but the sign-in screen starts here: check the session, draw the shell, then run. */
  function start(active, run) {
    fetch('/api?action=session', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
      LOGIN = s.login_required !== false;
      if (!s.signed_in) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash)); return; }
      shell(active);
      document.body.classList.remove('ws-loading');
      run(s);
    }).catch(function () { document.body.textContent = 'We could not reach the site. Check your internet connection and reload.'; });
  }

  // ?capture=1 folds the page furniture away, for photographing a screen (the walkthrough video builder uses it)
  if (/[?&]capture=1\b/.test(location.search)) document.documentElement.classList.add('ws-capture');
  try { var saved = localStorage.getItem('ws-theme'); var q = /[?&]theme=(light|dark)\b/.exec(location.search); if (q || saved) document.documentElement.setAttribute('data-theme', q ? q[1] : saved); } catch (e) { /* storage blocked: follow the system */ }
  /* A password box with a Show / Hide button, so people can check what they typed. */
  function reveal(input) {
    var btn = el('button', { type: 'button', className: 'ws-pw__show', textContent: 'Show', attrs: { 'aria-pressed': 'false', 'aria-label': 'Show password' } });
    btn.onclick = function () {
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(hidden)); btn.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      input.focus();
    };
    return el('div', { className: 'ws-pw' }, input, btn);
  }


  window.App = { $: $, $$: $$, el: el, api: api, start: start, shell: shell, copyButton: copyButton, copyRow: copyRow, reveal: reveal };
})();
