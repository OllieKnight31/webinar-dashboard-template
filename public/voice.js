/* Voice typing. One small script that adds a microphone button to every field marked for it.
 *
 *   <textarea data-voice></textarea>      or call   Voice.enhance(root)   after drawing fields
 *
 * Which fields get one is decided in ONE place, eligible(): textareas and plain text inputs
 * that are marked data-voice. Never passwords, keys, numbers, dates, times, colours or links,
 * whatever they are marked with.
 *
 * Uses the browser's own speech recognition (Chrome, Edge, Safari). Language = the browser's.
 * Words appear live as they are heard, are inserted where the cursor was, and when dictation
 * ends the field fires `input` and `change`, so autosave runs exactly as if it had been typed.
 * Click the button again, or stop talking, to finish. Works from the keyboard (it is a real
 * button) and announces its state to screen readers.
 *
 * Also loadable in Node (the tests check eligible() and insertAt() without a browser). */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Voice = api;
})(typeof window !== 'undefined' ? window : globalThis, function (win) {
  'use strict';

  var EXCLUDED_TYPES = ['password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'url', 'email', 'tel', 'hidden', 'checkbox', 'radio', 'file', 'range', 'search'];
  var MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

  /** Should this field get a microphone? Pure: reads only tag, type and data attributes. */
  function eligible(field) {
    if (!field || !field.tagName) return false;
    var tag = String(field.tagName).toLowerCase();
    var data = field.dataset || {};
    if (data.voice === undefined || data.voice === 'off') return false;
    if (data.kind === 'key' || data.kind === 'link') return false;        // pasted, never dictated
    if (field.readOnly || field.disabled) return false;
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var type = String(field.type || field.getAttribute && field.getAttribute('type') || 'text').toLowerCase();
    return type === 'text' && EXCLUDED_TYPES.indexOf(type) < 0;
  }

  /** Put `spoken` into `value` at [start, end), with sensible spacing. → { value, caret } */
  function insertAt(value, start, end, spoken) {
    value = String(value || ''); spoken = String(spoken || '').trim();
    if (!spoken) return { value: value, caret: start };
    var before = value.slice(0, start), after = value.slice(end);
    var lead = before && !/\s$/.test(before) ? ' ' : '';
    var tail = after && !/^[\s.,;:!?]/.test(after) ? ' ' : '';
    if (!before.trim() || /[.!?]\s*$/.test(before)) spoken = spoken.charAt(0).toUpperCase() + spoken.slice(1);
    return { value: before + lead + spoken + tail + after, caret: (before + lead + spoken).length };
  }

  var Recognition = win && (win.SpeechRecognition || win.webkitSpeechRecognition);
  var supported = function () { return Boolean(Recognition); };
  var active = null;      // { stop } for the one field being dictated into

  var WHY = {
    'not-allowed': 'The microphone is blocked. Click the padlock in the address bar, set Microphone to Allow, then try again.',
    'service-not-allowed': 'The microphone is blocked. Click the padlock in the address bar, set Microphone to Allow, then try again.',
    'audio-capture': 'No microphone was found. Plug one in or check your sound settings, then try again.',
    'no-speech': 'We did not hear anything. Click the microphone and try again.',
    network: 'Voice typing needs an internet connection. Check yours and try again.',
  };

  function attach(field) {
    if (field.dataset.voiceReady) return;
    field.dataset.voiceReady = '1';
    var doc = field.ownerDocument;
    var wrap = doc.createElement('span'); wrap.className = 'ws-voice';
    field.parentNode.insertBefore(wrap, field); wrap.appendChild(field);
    var btn = doc.createElement('button');
    btn.type = 'button'; btn.className = 'ws-mic'; btn.innerHTML = MIC;
    btn.setAttribute('aria-pressed', 'false');
    var name = field.getAttribute('aria-label') || (field.labels && field.labels[0] && field.labels[0].textContent) || 'this box';
    btn.setAttribute('aria-label', 'Speak your answer for ' + String(name).trim());
    btn.title = 'Speak instead of typing';
    var status = doc.createElement('span'); status.className = 'ws-voice__status'; status.setAttribute('aria-live', 'polite');
    wrap.appendChild(btn); wrap.appendChild(status);

    btn.addEventListener('click', function () {
      if (active && active.field === field) { active.stop(); return; }
      if (active) active.stop();
      var rec = new Recognition();
      rec.lang = (win.navigator && win.navigator.language) || 'en-GB';
      rec.interimResults = true; rec.continuous = true;
      var base = field.value, start = field.selectionStart == null ? base.length : field.selectionStart, end = field.selectionEnd == null ? start : field.selectionEnd;
      var finalText = '', failed = '', quiet = null;
      var show = function (interim) {
        var out = insertAt(base, start, end, (finalText + ' ' + (interim || '')).trim());
        field.value = out.value;
        try { field.setSelectionRange(out.caret, out.caret); } catch (e) { /* not focusable right now */ }
      };
      // stop after a pause, so nobody has to remember to click again
      var pause = function () { clearTimeout(quiet); quiet = setTimeout(function () { rec.stop(); }, 4000); };
      rec.onresult = function (ev) {
        var interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText = (finalText + ' ' + ev.results[i][0].transcript).trim(); else interim += ev.results[i][0].transcript;
        }
        show(interim); pause();
      };
      rec.onerror = function (ev) { failed = WHY[ev.error] || (ev.error === 'aborted' ? '' : 'Voice typing stopped. Click the microphone to try again.'); };
      rec.onend = function () {
        clearTimeout(quiet);
        show('');
        btn.classList.remove('is-listening'); btn.setAttribute('aria-pressed', 'false');
        status.textContent = failed;
        if (active && active.field === field) active = null;
        // exactly what typing does, so whatever saves on change saves this too
        if (field.value !== base) { field.dispatchEvent(new win.Event('input', { bubbles: true })); field.dispatchEvent(new win.Event('change', { bubbles: true })); }
      };
      active = { field: field, stop: function () { try { rec.stop(); } catch (e) { /* already stopped */ } } };
      btn.classList.add('is-listening'); btn.setAttribute('aria-pressed', 'true');
      status.textContent = 'Listening, speak now. Click the microphone again when you have finished.';
      try { rec.start(); pause(); } catch (e) { rec.onend(); }
    });
  }

  /** Add a microphone to every eligible field under `rootNode`. Safe to call again after a redraw. */
  function enhance(rootNode) {
    var scope = rootNode || (win && win.document);
    if (!scope || !scope.querySelectorAll) return 0;
    var fields = Array.prototype.filter.call(scope.querySelectorAll('input[data-voice], textarea[data-voice]'), eligible);
    if (!supported()) return 0;
    fields.forEach(attach);
    return fields.length;
  }

  return { eligible: eligible, insertAt: insertAt, enhance: enhance, supported: supported, EXCLUDED_TYPES: EXCLUDED_TYPES, UNSUPPORTED: 'Voice typing works in Google Chrome.' };
});
