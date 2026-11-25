/* Results: the webinar funnel for the chosen dates, the biggest leak in one sentence, a tile
   per number (what it means, and what to fix first when it is under target), and the
   breakdowns. Everything comes from GET /api?action=results; ?demo=1 shows sample data. */
(function () {
  'use strict';
  var el = App.el, $ = App.$, api = App.api;
  var qs = new URLSearchParams(location.search);
  var state = { demo: qs.get('demo') === '1', days: Number(qs.get('days')) || 30, from: '', to: '', cur: '$' };
  var view = $('#view'), notice = $('#notice');
  var WORD = { ok: 'On target', warn: 'A little under', crit: 'Well under', na: '' };

  var pct = function (r) { var p = r * 100; return (Math.abs(p) >= 10 || p === 0 ? Math.round(p) : Math.round(p * 10) / 10) + '%'; };
  function money(n) { var a = Math.abs(n); return (n < 0 ? '-' : '') + state.cur + (a < 100 && a % 1 ? a.toFixed(2) : Math.round(a).toLocaleString('en-GB')); }
  function show(v, unit) {
    if (typeof v !== 'number') return null;
    if (unit === 'pct') return pct(v);
    if (unit === 'money') return money(v);
    if (unit === 'times') return (Math.round(v * 10) / 10) + '×';
    return v.toLocaleString('en-GB');
  }
  function day(iso) { var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + (/T\d\d:\d\d/.test(iso) ? ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''); }
  var ymd = function (d) { return d.toISOString().slice(0, 10); };

  function strip(d) {
    var box = el('div', { className: 'ws-strip', attrs: { role: 'list' } });
    d.steps.forEach(function (s, i) {
      var n = show(s.count, 'count');
      box.append(el('div', { className: 'ws-stage' + (s.status && s.status !== 'na' ? ' is-' + s.status : ''), attrs: { role: 'listitem' } },
        el('div', { className: 'ws-stage__label', textContent: s.label }),
        el('div', { className: 'ws-stage__n' + (n == null ? ' is-na' : ''), textContent: n == null ? 'Not known yet' : n }),
        i > 0 && typeof s.rate === 'number' ? el('div', { className: 'ws-stage__rate', textContent: pct(s.rate) + (s.key === 'attended' ? ' of those whose webinar has happened' : s.key === 'booked' ? ' of the people who came live' : s.key === 'registrations' ? ' of visitors' : ' of the step before') }) : null,
        s.note ? el('div', { className: 'ws-note', textContent: s.note }) : null));
    });
    return el('section', {}, el('h2', { className: 'ai-h3', textContent: 'Step by step', style: { marginBottom: '12px' } }), box,
      d.side && d.side.count != null ? el('p', { className: 'ws-note', style: { marginTop: '10px' }, textContent: d.side.count + ' also watched the replay' + (typeof d.side.rate === 'number' ? ' (' + pct(d.side.rate) + ' of the people whose webinar has happened).' : '.') }) : null);
  }
  function leak(d) {
    if (!d.leak) return el('section', { className: 'ws-leak' }, el('div', { className: 'ai-label', textContent: 'Your biggest leak' }),
      el('div', { className: 'ws-leak__s', textContent: d.has_data ? 'There are not enough people in these dates to say yet.' : 'Nothing to measure yet.' }),
      el('div', { className: 'ws-leak__fix', textContent: d.has_data ? 'Try a longer set of dates, or check back after your next webinar.' : 'Once people start signing up, this tells you the one thing to fix first.' }));
    return el('section', { className: 'ws-leak is-' + d.leak.status }, el('div', { className: 'ai-label', textContent: d.leak.status === 'ok' ? 'How it is going' : 'Your biggest leak' }),
      el('div', { className: 'ws-leak__s', textContent: d.leak.sentence }),
      d.leak.fix ? el('div', { className: 'ws-leak__fix' }, el('b', { textContent: 'What to fix first: ' }), d.leak.fix) : null);
  }
  function tiles(d) {
    var grid = el('div', { className: 'ws-kpis' });
    d.tiles.forEach(function (t) {
      var v = show(t.value, t.unit);
      grid.append(el('div', { className: 'ai-kpi' + (t.status !== 'na' ? ' is-' + t.status : '') },
        el('div', { className: 'ai-kpi__label', textContent: t.label }),
        el('div', { className: 'ai-kpi__val', textContent: v == null ? 'Not known yet' : v, style: v == null ? { fontSize: '17px', color: 'var(--ai-muted)' } : {} }),
        typeof t.target === 'number' && v != null ? el('div', { className: 'ws-kpi__target' }, 'Target ' + pct(t.target), WORD[t.status] ? el('span', { className: 'ai-chip ai-chip--' + t.status, textContent: WORD[t.status], style: { marginLeft: '8px' } }) : null) : null,
        t.note ? el('div', { className: 'ws-kpi__means', textContent: t.note, style: { color: 'var(--ai-text-2)' } }) : null,
        el('div', { className: 'ws-kpi__means' }, el('b', { textContent: 'What this means: ' }), t.means),
        t.fix ? el('div', { className: 'ws-kpi__fix' }, el('b', { textContent: 'What to fix first' }), t.fix) : null));
    });
    return el('section', {}, el('h2', { className: 'ai-h3', textContent: 'Your numbers', style: { marginBottom: '12px' } }), grid);
  }
  var MONEY = /spend|cost/i, RATE = /rate/i;
  function table(t) {
    var head = el('tr'); t.columns.forEach(function (c, i) { head.append(el('th', { textContent: c, className: i ? 'ai-num' : '' })); });
    var body = el('tbody');
    t.rows.forEach(function (r) {
      var tr = el('tr');
      r.forEach(function (v, i) {
        var col = t.columns[i], text;
        if (v == null || v === '') text = 'Not known';
        else if (typeof v === 'number') text = MONEY.test(col) ? money(v) : RATE.test(col) ? pct(v) : v.toLocaleString('en-GB');
        else text = /^\d{4}-\d{2}-\d{2}T/.test(v) ? day(v) : v;
        tr.append(el('td', { textContent: text, className: i && typeof v !== 'string' ? 'ai-num' : '', style: v == null ? { color: 'var(--ai-muted)' } : {} }));
      });
      body.append(tr);
    });
    return el('section', {}, el('h2', { className: 'ai-h3', textContent: t.title, style: { marginBottom: '6px' } }),
      t.note ? el('p', { className: 'ws-note', textContent: t.note, style: { marginBottom: '10px' } }) : null,
      t.rows.length ? el('div', { className: 'ai-table-wrap' }, el('table', { className: 'ai-table' }, el('thead', {}, head), body)) : el('p', { className: 'ws-note', textContent: 'Nothing here for these dates yet.' }));
  }

  function draw(d) {
    state.cur = (d.brand && d.brand.currency_symbol) || '$';
    notice.replaceChildren();
    if (d.demo) notice.append(el('div', { className: 'ai-banner', style: { marginBottom: '20px' } }, el('span', {}, el('b', { textContent: 'This is sample data. ' }), 'These numbers are made up, to show you what this page looks like once your webinar is running.'), el('a', { className: 'ws-link', href: '/results', textContent: 'Back to your own numbers' })));
    else if (!d.has_data) notice.append(el('div', { className: 'ai-banner', style: { marginBottom: '20px' } }, el('span', {}, el('b', { textContent: 'No sign-ups yet. ' }), 'Your numbers appear here once your tools are connected and people start signing up.'),
      el('a', { className: 'ai-btn ai-btn--sm', href: '/#step-4', textContent: 'Connect your tools' }), el('a', { className: 'ai-btn ai-btn--secondary ai-btn--sm', href: '/results?demo=1', textContent: 'See it with sample data' })));
    var failed = ((d.sync || {}).parts || []).filter(function (p) { return p.status === 'error'; });
    if (failed.length && !d.demo) notice.append(el('div', { className: 'ai-banner ai-banner--warn', style: { marginBottom: '20px' } }, el('span', {}, el('b', { textContent: 'One of your tools did not update. ' }), failed[0].message || 'We will try again within the hour.'), el('a', { className: 'ws-link', href: '/settings', textContent: 'Check it in Settings' })));
    view.replaceChildren(leak(d), strip(d), tiles(d));
    d.tables.forEach(function (t) { view.append(table(t)); });
    if (d.notes && d.notes.length) view.append(el('section', {}, el('h2', { className: 'ai-h3', textContent: 'How we count', style: { marginBottom: '8px' } }), el('ul', { className: 'ws-note', style: { paddingLeft: '18px', display: 'grid', gap: '4px' } }, d.notes.map(function (n) { return el('li', { textContent: n }); }).reduce(function (f, n) { f.append(n); return f; }, document.createDocumentFragment()))));
    var s = d.sync || {};
    $('#fresh').textContent = d.demo ? '' : s.last_run ? 'Last updated ' + (s.minutes_ago < 60 ? s.minutes_ago + ' minutes ago' : day(s.last_run)) + '. It updates itself every hour.' : 'Not updated yet. It updates itself every hour once a tool is connected.';
  }

  function load() {
    var p = 'action=results&from=' + state.from + '&to=' + state.to + (state.demo ? '&demo=1' : '');
    return api(p).then(function (r) {
      if (r.code !== 200 || r.data.status !== 'ok') { view.replaceChildren(el('div', { className: 'ai-banner ai-banner--warn', textContent: r.data.message || 'We could not load your numbers. Try again in a minute.' })); return; }
      draw(r.data);
    });
  }
  function setDays(n) {
    state.days = n; var to = new Date(), from = new Date(Date.now() - (n - 1) * 86400000);
    state.from = ymd(from); state.to = ymd(to); $('#from').value = state.from; $('#to').value = state.to;
    App.$$('#period button').forEach(function (b) { b.setAttribute('aria-pressed', Number(b.dataset.days) === n ? 'true' : 'false'); });
  }
  $('#period').addEventListener('click', function (e) { var b = e.target.closest('button[data-days]'); if (b) { setDays(Number(b.dataset.days)); load(); } });
  ['from', 'to'].forEach(function (id) { $('#' + id).addEventListener('change', function () { if ($('#from').value && $('#to').value) { state.from = $('#from').value; state.to = $('#to').value; App.$$('#period button').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); }); load(); } }); });
  $('#refresh').onclick = function () {
    var b = $('#refresh'); b.disabled = true; b.textContent = 'Refreshing…';
    (state.demo ? Promise.resolve() : api('source=sync_now', {})).then(load).then(function () { b.disabled = false; b.textContent = 'Refresh now'; });
  };

  App.start('/results', function () { setDays(state.days); load(); });
})();
