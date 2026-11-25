/* The ready-made questionnaires. Each Setup step ends with a "Go deeper" screen listing the
   ones that belong to it. For every questionnaire there are three ways to get it done:
     answer it on the page (saved as you type, with voice typing on every box),
     download it as a document to fill in or send to somebody,
     upload a document you already have.
   The questions themselves come from the server, so the page and the build always agree. */
(function () {
  'use strict';
  var el = App.el, api = App.api;
  var data = { catalogue: [], answers: {}, files: [], limits: { file_mb: 3 } };
  var say = function () {};
  var timers = {};

  function load() { return api('action=answers').then(function (r) { if (r.code === 200) data = r.data; return r; }); }
  function get(id) { return data.catalogue.filter(function (q) { return q.id === id; })[0] || null; }
  function forStep(step) { return data.catalogue.filter(function (q) { return q.step === step; }); }
  function questionsOf(q) { return q.sections.reduce(function (all, s) { return all.concat(s.questions); }, []); }
  function keysOf(q) { if (!q.repeat) return [q.id]; var out = []; for (var n = 1; n <= q.repeat; n++) out.push(q.id + '.' + n); return out; }
  function filled(v) { return Array.isArray(v) ? v.length > 0 : Boolean(String(v === null || v === undefined ? '' : v).trim()); }
  function answered(q, key) { var a = data.answers[key] || {}; return questionsOf(q).filter(function (x) { return filled(a[x.id]); }).length; }
  function linkOf(key) { return (data.answers[key] || {})._link || ''; }
  function filesFor(q, key) { return data.files.filter(function (f) { return key ? f.key === key : f.key.split('.')[0] === q.id; }); }
  function copyName(q, n) { var a = data.answers[q.id + '.' + n] || {}; return (a.client_name || '').split(/[,\n]/)[0].trim() || 'Client ' + n; }
  function sizeOf(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB'; }

  /** Where one questionnaire is up to, in words. → [label, chip colour, detail] */
  function progress(q) {
    var total = questionsOf(q).length, docs = filesFor(q).length, done = 0, started = 0;
    keysOf(q).forEach(function (key) { var n = answered(q, key); done += n; if (n) started++; if (linkOf(key)) docs++; });
    var detail = [];
    if (q.repeat) detail.push(started ? started + ' of ' + q.repeat + ' started' : 'Room for ' + q.repeat + ' clients');
    else detail.push(done + ' of ' + total + ' answered');
    if (docs) detail.push(docs + (docs === 1 ? ' document added' : ' documents added'));
    var label = !done && !docs ? ['Not started', 'na'] : (!q.repeat && done >= total) ? ['Done', 'ok'] : (!done && docs) ? ['Document added', 'ok'] : ['In progress', 'warn'];
    return [label[0], label[1], detail.join(' · ')];
  }

  // ── uploading ─────────────────────────────────────────────────────────────
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('unreadable')); };
      r.readAsDataURL(file);
    });
  }
  /** A space to drop documents on, or click to choose them. Uploads one after another. */
  function dropzone(key, done) {
    var note = el('span', { className: 'ws-note', attrs: { role: 'status' } });
    var input = el('input', { type: 'file', multiple: true, className: 'ws-hide', attrs: { 'aria-hidden': 'true', tabindex: '-1' } });
    var title = el('b', { textContent: 'Drag a document here, or click to choose one' });
    var zone = el('div', { className: 'ws-drop', attrs: { role: 'button', tabindex: '0', 'aria-label': 'Upload a document. Drag it here, or press Enter to choose one.' } },
      el('span', { className: 'ws-drop__icon', innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"/></svg>' }),
      title, el('span', { className: 'ws-note', textContent: 'Documents, slides, spreadsheets and pictures, up to ' + data.limits.file_mb + ' MB each. You can add several at once.' }), note, input);
    var busy = false;
    function send(list) {
      var files = Array.prototype.slice.call(list || []), problems = [], added = 0;
      if (!files.length || busy) return;
      var next = function () {
        var file = files.shift();
        if (!file) {
          busy = false; zone.classList.remove('is-busy');
          note.textContent = problems.length ? problems.join(' ') : (added === 1 ? 'Added.' : added + ' added.');
          note.classList.toggle('is-bad', problems.length > 0);
          if (added && !problems.length) done();
          return;
        }
        if (file.size > data.limits.file_mb * 1048576) {
          problems.push(file.name + ' is bigger than ' + data.limits.file_mb + ' MB. Put it in Google Drive or Dropbox and paste the link instead.');
          return next();
        }
        note.classList.remove('is-bad'); note.textContent = 'Adding ' + file.name + '…';
        readFile(file).then(function (dataUrl) { return api('source=upload', { key: key, name: file.name, data: dataUrl }); }).then(function (r) {
          if (r.code === 200) { data.files = r.data.files; added++; } else problems.push(file.name + ': ' + (r.data.message || 'that did not upload. Try again.'));
          next();
        }, function () { problems.push(file.name + ' could not be read. Try again.'); next(); });
      };
      busy = true; zone.classList.add('is-busy'); next();
    }
    zone.onclick = function (e) { if (e.target !== input) input.click(); };
    zone.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    input.onchange = function () { var picked = input.files; send(picked); input.value = ''; };
    ['dragenter', 'dragover'].forEach(function (name) { zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.add('is-over'); }); });
    ['dragleave', 'drop'].forEach(function (name) { zone.addEventListener(name, function (e) { e.preventDefault(); zone.classList.remove('is-over'); }); });
    zone.addEventListener('drop', function (e) { send(e.dataTransfer && e.dataTransfer.files); });
    return zone;
  }
  /** Opens their own copy in Google Docs: Google asks them to make a copy, so the original is never typed in. */
  function googleButton(q, primary) {
    if (!q.google_doc) return '';
    return el('a', { className: 'ai-btn ai-btn--sm' + (primary ? '' : ' ai-btn--secondary'), href: q.google_doc, target: '_blank', rel: 'noopener', textContent: 'Open in Google Docs' });
  }
  /** Where their finished copy lives, so we can read it. */
  function linkBox(key, redraw) {
    var input = el('input', { className: 'ai-input', type: 'url', value: linkOf(key), placeholder: 'https://docs.google.com/document/d/...', attrs: { 'aria-label': 'Link to your finished copy' } });
    var out = el('div', { className: 'ai-hint', textContent: 'In your copy press Share, choose “Anyone with the link”, then copy the link and paste it here.' });
    input.onchange = function () {
      api('source=answers', { key: key, answers: { _link: input.value.trim() } }).then(function (r) {
        if (r.code !== 200) { out.textContent = r.data.message || 'That did not save.'; return; }
        if (Object.keys(r.data.answers).length) data.answers[key] = r.data.answers; else delete data.answers[key];
        out.textContent = input.value.trim() ? 'Saved. We will read your answers from that document.' : 'Removed.';
        if (redraw) redraw();
      });
    };
    return el('div', { className: 'ai-field' }, el('div', { className: 'ai-field__label', textContent: 'Filled in your copy in Google Docs? Paste its link' }), input, out);
  }
  function fileList(q, key, redraw) {
    var mine = filesFor(q, key);
    if (!mine.length) return el('p', { className: 'ws-note', textContent: 'Nothing added yet.' });
    var list = el('div', { className: 'ws-board' });
    mine.forEach(function (f) {
      var remove = el('button', { type: 'button', className: 'ws-skip', textContent: 'Remove' });
      remove.onclick = function () { remove.disabled = true; api('source=file_delete', { id: f.id }).then(function (r) { if (r.code === 200) data.files = r.data.files; redraw(); }); };
      list.append(el('div', { className: 'ws-file' }, el('b', { textContent: f.name }), el('span', { className: 'ws-note', textContent: sizeOf(f.size) }),
        el('a', { className: 'ws-link', href: '/api?action=file&id=' + encodeURIComponent(f.id), textContent: 'Download' }), remove));
    });
    return list;
  }

  // ── the document people download ──────────────────────────────────────────
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function docHtml(q, key, business) {
    var a = data.answers[key] || {}, n = 0;
    var body = '<h1>' + esc(q.title) + '</h1>' + (business ? '<p class="for">' + esc(business) + '</p>' : '') + '<p>' + esc(q.blurb) + '</p>'
      + '<p class="how">Type your answer under each question. Write the way you talk. Detail, names and numbers are what make it useful. Takes about ' + q.minutes + ' minutes.</p>';
    q.sections.forEach(function (s) {
      body += '<h2>' + esc(s.title) + '</h2>';
      s.questions.forEach(function (x) {
        n++;
        body += '<p class="q">' + n + '. ' + esc(x.q) + '</p>' + (x.hint ? '<p class="hint">' + esc(x.hint) + '</p>' : '');
        if (x.type === 'ticks') body += '<p class="hint">Type an X between the brackets for each one that applies.</p>' + x.options.map(function (o) { return '<p class="tick">[' + ((a[x.id] || []).indexOf(o) >= 0 ? ' X ' : '&nbsp;&nbsp;&nbsp;') + '] ' + esc(o) + '</p>'; }).join('');
        else body += '<table><tr><td class="' + (x.type === 'short' ? 'short' : 'long') + '">' + (filled(a[x.id]) ? esc(a[x.id]).replace(/\n/g, '<br>') : '&nbsp;') + '</td></tr></table>';
      });
    });
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(q.title) + '</title><style>'
      + 'body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.45;color:#111;max-width:720px;margin:32px auto;padding:0 24px}'
      + 'h1{font-size:22pt;margin:0 0 4pt}h2{font-size:14pt;margin:22pt 0 6pt;border-bottom:1px solid #999;padding-bottom:3pt}'
      + '.for{color:#555;margin:0 0 10pt}.how{color:#444;font-style:italic}.q{font-weight:bold;margin:14pt 0 2pt}.hint{color:#666;font-style:italic;margin:0 0 4pt}.tick{margin:2pt 0}'
      + 'table{width:100%;border-collapse:collapse;margin:4pt 0 0}td{border:1px solid #999;padding:6pt;vertical-align:top}td.long{height:70pt}td.short{height:22pt}'
      + '@media print{body{margin:0;max-width:none}.q{page-break-after:avoid}table{page-break-inside:avoid}}'
      + '</style></head><body>' + body + '</body></html>';
  }
  function fileName(q, key) { return (q.title + (q.repeat ? ' ' + key.split('.')[1] : '')).replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '-') + '.doc'; }
  function download(q, key, business) {
    var url = URL.createObjectURL(new Blob(['﻿', docHtml(q, key, business)], { type: 'application/msword' }));
    var a = el('a', { href: url, download: fileName(q, key) });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function print(q, key, business) {
    var w = window.open('', '_blank');
    if (!w) { say('Your browser stopped the new window. Allow pop-ups for this site and try again.', true); return; }
    w.document.write(docHtml(q, key, business)); w.document.close();
    w.onload = function () { w.focus(); w.print(); };
  }

  // ── the "Go deeper" screen at the end of a step ───────────────────────────
  function stepScreen(step, opts) {
    var box = el('div', { className: 'ai-stack' });
    function draw() {
      box.replaceChildren();
      forStep(step).forEach(function (q) {
        var p = progress(q), first = keysOf(q)[0];
        var open = el('button', { type: 'button', className: 'ai-btn ai-btn--sm', textContent: p[0] === 'Not started' ? 'Answer it here' : 'Carry on' });
        open.onclick = function () { opts.open(q.id); };
        var get = el('button', { type: 'button', className: 'ws-skip', textContent: 'or download as a Word document' });
        get.onclick = function () { download(q, first, opts.business()); };
        box.append(el('div', { className: 'ws-doc' },
          el('div', { className: 'ws-doc__top' }, el('h3', { textContent: q.title }), el('span', { className: 'ai-chip ai-chip--' + p[1], textContent: p[0] })),
          el('p', { className: 'ws-doc__blurb', textContent: q.blurb }),
          el('p', { className: 'ws-note', textContent: questionsOf(q).length + ' questions · about ' + q.minutes + ' minutes · ' + p[2] }),
          el('div', { className: 'ai-row' }, open, googleButton(q), get),
          dropzone(first, draw)));
      });
    }
    draw();
    var many = forStep(step).length > 1;
    return el('section', { className: 'ws-q' },
      el('h2', { className: 'ws-q__title', textContent: many ? 'Go deeper with a ready-made questionnaire' : 'Go deeper with the ready-made questionnaire' }),
      el('p', { className: 'ws-q__why', textContent: 'The short questions in this step are the essentials. ' + (many ? 'These go' : 'This goes') + ' further, and the more we know the better everything we write for you will read. Answer on this page, open your own copy in Google Docs to fill in or send to someone, or drop in a document you already have. Do as much or as little as you like.' }),
      box);
  }

  // ── one questionnaire, answered on the page ───────────────────────────────
  function view(id, opts) {
    var q = get(id), copy = opts.copy || 1;
    var wrap = el('div', { className: 'ai-stack' });
    function save(key, qid, value) {
      var body = { key: key, answers: {} }; body.answers[qid] = value;
      say('Saving…');
      return api('source=answers', body).then(function (r) {
        if (r.code !== 200) { say(r.data.message || 'That did not save. Check your connection.', true); return; }
        if (Object.keys(r.data.answers).length) data.answers[key] = r.data.answers; else delete data.answers[key];
        say('Saved'); count();
      });
    }
    var tally = el('span', { className: 'ws-note' });
    function count() { var key = q.repeat ? q.id + '.' + copy : q.id; tally.textContent = answered(q, key) + ' of ' + questionsOf(q).length + ' answered. Saved as you go.'; }

    function field(key, x, number) {
      var a = data.answers[key] || {}, input, id = 'dq_' + x.id;
      if (x.type === 'ticks') {
        var chosen = (a[x.id] || []).slice();
        input = el('div', { className: 'ws-ticks', attrs: { role: 'group', 'aria-label': x.q } });
        x.options.forEach(function (o) {
          var box = el('input', { type: 'checkbox', checked: chosen.indexOf(o) >= 0 });
          box.onchange = function () { chosen = chosen.filter(function (c) { return c !== o; }); if (box.checked) chosen.push(o); save(key, x.id, chosen); };
          input.append(el('label', { className: 'ai-check' }, box, o));
        });
      } else {
        input = el(x.type === 'short' ? 'input' : 'textarea', { className: x.type === 'short' ? 'ai-input' : 'ai-textarea', id: id, value: a[x.id] || '' });
        if (x.type === 'short') input.type = 'text'; else input.rows = 4;
        input.dataset.voice = '';
        var go = function () { clearTimeout(timers[key + x.id]); save(key, x.id, input.value.trim()); };
        input.addEventListener('input', function () { say('…'); clearTimeout(timers[key + x.id]); timers[key + x.id] = setTimeout(go, 800); });
        input.addEventListener('change', go);
      }
      return el('div', { className: 'ws-dq' }, el('label', { className: 'ws-dq__q', htmlFor: id }, el('span', { className: 'ws-dq__n', textContent: String(number) }), x.q),
        x.hint ? el('p', { className: 'ws-dq__hint', textContent: x.hint }) : null, el('div', { className: 'ai-field' }, input));
    }

    function draw() {
      var key = q.repeat ? q.id + '.' + copy : q.id, n = 0;
      var again = function () { draw(); Voice.enhance(wrap); };
      var word = el('button', { type: 'button', className: 'ai-btn ai-btn--secondary ai-btn--sm', textContent: 'Download as a Word document' });
      word.onclick = function () { download(q, key, opts.business()); };
      var pdf = el('button', { type: 'button', className: 'ai-btn ai-btn--secondary ai-btn--sm', textContent: 'Print or save as PDF' });
      pdf.onclick = function () { print(q, key, opts.business()); };
      wrap.replaceChildren(el('p', { className: 'ws-q__why', textContent: q.blurb }));
      wrap.append(
        q.who === 'client' ? el('div', { className: 'ai-banner' }, el('span', { textContent: 'This one is for your client. Open it in Google Docs, send them the link to your copy, then paste that link here when they have filled it in. Or go through it together on a call and fill it in here as they talk.' })) : '',
        el('div', { className: 'ws-doc' },
          el('p', { className: 'ws-doc__blurb' }, el('b', { textContent: 'Three ways to do this. ' }), 'Answer below, a little at a time. Or open it in Google Docs, where you get your own copy to fill in or send on. Or drop in something you already have that covers the same ground.'),
          el('div', { className: 'ai-row' }, googleButton(q, true), word, pdf),
          q.google_doc ? linkBox(key) : '',
          dropzone(key, again)));
      if (q.repeat) {
        var tabs = el('div', { className: 'ws-tabs', attrs: { role: 'group', 'aria-label': 'Which client' } });
        for (var c = 1; c <= q.repeat; c++) (function (c) {
          var has = answered(q, q.id + '.' + c) > 0;
          var b = el('button', { type: 'button', className: 'ws-tab', textContent: copyName(q, c) + (has ? ' ✓' : ''), attrs: { 'aria-pressed': c === copy ? 'true' : 'false' } });
          b.onclick = function () { copy = c; opts.moved(copy); draw(); Voice.enhance(wrap); window.scrollTo(0, 0); };
          tabs.append(b);
        })(c);
        wrap.append(tabs);
      }
      wrap.append(tally);
      q.sections.forEach(function (s) {
        var sec = el('section', { className: 'ws-dsec' }, el('h3', { textContent: s.title }));
        s.questions.forEach(function (x) { n++; sec.append(field(key, x, n)); });
        wrap.append(sec);
      });
      wrap.append(el('section', { className: 'ws-dsec' }, el('h3', { textContent: 'Documents for this' }),
        el('p', { className: 'ws-dq__hint', textContent: q.files + ' Each file can be up to ' + data.limits.file_mb + ' MB.' }), fileList(q, key, again)));
      count();
    }
    draw();
    return wrap;
  }

  window.Deep = {
    load: load, get: get, forStep: forStep, stepScreen: stepScreen, view: view, progress: progress,
    init: function (o) { say = o.said; },
  };
})();
