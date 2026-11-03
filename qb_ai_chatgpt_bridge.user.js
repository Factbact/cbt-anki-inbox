// ==UserScript==
// @name         QB AI解説ブリッジ（プレビュー版）
// @namespace    https://local.tools/qb-ai-chatgpt-bridge
// @version      0.4.4-preview.14
// @description  復習アシスト内で現在の1問の問題と解説をコピー。既存Anki追加箱と同じ問題APIを使用。外部送信なし。
// @match        https://cbt.medilink-study.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/* === QB current-question copy: isolated clipboard module === */
(() => {
  'use strict';
  if (location.hostname !== 'cbt.medilink-study.com' || window.__QB_CURRENT_QUESTION_COPY_V14__) return;
  window.__QB_CURRENT_QUESTION_COPY_V14__ = true;

  const HOST_ID = 'qb-ai-inline-page-copy-tools';
  let host, statusNode, manualBox, manualText, clickNumber = 0, activeJob = null, manualQuestionId = null;

  /* Current-question content only. This helper never reads page text or user history. */
  function qbQuestionText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(qbQuestionText).join('\n');
    if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return qbQuestionText(value.text);
    if (typeof value !== 'string') throw new Error('question_text_unreadable');
    // A template's contents are inert: markup is never attached to the page and
    // images, links, scripts and styles are never loaded or executed.
    const template = document.createElement('template');
    template.innerHTML = value;
    const blocks = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TBODY|THEAD|TFOOT|TR|UL)$/;
    const walk = node => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 && node.nodeType !== 11) return '';
      const tag = String(node.tagName || '').toUpperCase();
      if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag)) return '';
      if (tag === 'BR') return '\n';
      if (tag === 'IMG' || tag === 'IMAGE') {
        const alt = node.getAttribute('alt') || '';
        return '[画像' + (alt ? ': ' + alt : '') + '（画像本体はコピーされません）]';
      }
      const text = Array.from(node.childNodes, walk).join('');
      if (/^(IFRAME|OBJECT|EMBED|VIDEO|AUDIO|CANVAS)$/.test(tag)) {
        return text + '[メディア本体はコピーされません]';
      }
      if (tag === 'SVG') return text + '[図本体はコピーされません]';
      if (tag === 'TD' || tag === 'TH') return text + '\t';
      return blocks.test(tag) ? '\n' + text + '\n' : text;
    };
    // Preserve all text, punctuation, Unicode and internal spacing. Only the
    // surrounding layout whitespace added while converting HTML is removed.
    return walk(template.content).trim();
  }

  function qbProjectQuestion(raw, questionId, text = qbQuestionText) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const array = value => value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
    const optionalText = (value, label) => {
      try { return text(value); } catch (_) { return '［' + label + 'のこの部分は取得できませんでした］'; }
    };
    if (!object(raw) || typeof raw.question_id !== 'string' || raw.question_id !== questionId) {
      throw new Error('question_id_mismatch');
    }
    const body = text(raw.body);
    const preBody = optionalText(raw.pre_body, '前文');
    if (!body && !preBody) throw new Error('question_body_missing');
    const parts = ['問題', preBody, body].filter(Boolean);

    // Options and official answers are optional. No single-answer, contiguous
    // label, choice-count, kind, preamble, image or length restrictions apply.
    if (raw.options !== null && raw.options !== undefined) {
      const options = object(raw.options) || Array.isArray(raw.options) ? Object.entries(raw.options).map(([label, value]) => {
        const content = optionalText(value, '選択肢');
        return content ? label + ' ' + content : label;
      }) : [optionalText(raw.options, '選択肢')];
      if (options.length) parts.push('選択肢', ...options);
    }
    const answer = value => {
      if (value === null || value === undefined) return '';
      if (Array.isArray(value)) return value.map(answer).filter(Boolean).join('・');
      return optionalText(value, '正解');
    };
    const correct = raw.correct_answers ?? raw.correct_answer;
    const answers = (Array.isArray(correct) ? correct.map(answer).filter(Boolean).join(' / ') : answer(correct)) || answer(raw.correct_answer);
    if (answers) parts.push('正解: ' + answers);

    const explanation = [];
    let detailPresent = false;
    const add = value => { const rendered = optionalText(value, '解説'); if (rendered) explanation.push(rendered); return rendered; };
    const missing = () => explanation.push('［解説のこの部分は取得できませんでした］');
    for (const box of array(raw.boxes)) {
      if (!object(box)) { missing(); continue; }
      add(box.box_title);
      for (const section of array(box.box_contents)) {
        if (!object(section)) { missing(); continue; }
        add(section.sub_title);
        for (const detail of array(section.sub_contents)) {
          if (!object(detail)) { missing(); continue; }
          add(detail.detail_title);
          for (const entry of array(detail.detail_contents)) {
            if (!object(entry) || !Object.prototype.hasOwnProperty.call(entry, 'text')) { missing(); continue; }
            if (add(entry.text)) detailPresent = true;
            // Preserve textual references in the official explanation, without
            // copying their URL/icon metadata, unrelated UI or personal records.
            for (const reference of array(entry.reference_links)) {
              if (object(reference)) {
                try { const label = text(reference.text); if (label) explanation.push(label); } catch (_) {}
              }
            }
          }
        }
      }
    }
    if (!detailPresent) explanation.push('［解説は取得できませんでした］');
    parts.push(...explanation);
    return parts.join('\n\n');
  }

  function captureViewState() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const ranges = [];
    const selection = window.getSelection();
    if (selection) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    let control = null;
    try {
      if (active && typeof active.selectionStart === 'number') {
        control = [active.selectionStart, active.selectionEnd, active.selectionDirection];
      }
    } catch (_) { /* Some form controls do not support text selection. */ }
    return {active, ranges, control, x: window.scrollX, y: window.scrollY};
  }

  function restoreViewState(saved) {
    try { if (saved.active?.isConnected) saved.active.focus({preventScroll: true}); } catch (_) {}
    try {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        for (const range of saved.ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range);
      }
      if (saved.control && saved.active?.isConnected) saved.active.setSelectionRange(...saved.control);
    } catch (_) { /* A page may have removed the previously selected node. */ }
    if (window.scrollX !== saved.x || window.scrollY !== saved.y) window.scrollTo(saved.x, saved.y);
  }

  // Same current-question locator and endpoint used by the working Anki
  // exporter. We do not capture its page-wide text or personal history fields.
  function getQuestionUuid() {
    try {
      const values = new URL(location.href).searchParams.getAll('question_id');
      return values.length === 1 && values[0].trim() ? values[0] : null;
    } catch (_) { return null; }
  }

  function assertCurrent(job) {
    if (job.cancelled || job.number !== clickNumber || getQuestionUuid() !== job.id) {
      throw new Error('question_changed');
    }
  }

  async function captureQuestion(job) {
    assertCurrent(job);
    const response = await window.fetch('/api/questions/' + encodeURIComponent(job.id), {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: {Accept: 'application/json'}, redirect: 'error', signal: job.controller.signal
    });
    assertCurrent(job);
    if (!response.ok) throw new Error('question_fetch_failed');
    const data = await response.json();
    assertCurrent(job);
    const text = qbProjectQuestion(data, job.id);
    assertCurrent(job);
    return text;
  }

  function say(message) { if (statusNode) statusNode.textContent = message; }

  function legacyCopy(text) {
    const saved = captureViewState();
    const box = document.createElement('textarea');
    box.readOnly = true;
    box.value = text;
    box.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px;';
    try {
      document.body.append(box);
      box.focus({preventScroll: true});
      box.select();
      return typeof document.execCommand === 'function' && document.execCommand('copy') === true;
    } catch (_) {
      return false;
    } finally {
      box.remove();
      restoreViewState(saved);
    }
  }

  function showManualCopy(text) {
    manualText.value = text;
    manualBox.hidden = false;
    say('コピー失敗');
  }

  function fallback(text, job) {
    assertCurrent(job);
    if (legacyCopy(text)) say('コピーしました');
    else { showManualCopy(text); manualQuestionId = job.id; }
  }

  function cancelJob(job) {
    if (!job || job.cancelled) return;
    job.cancelled = true;
    job.controller.abort();
    job.rejectBlob?.(new Error('question_changed'));
  }

  async function finishCopy(job, nativeResult) {
    try {
      const text = await captureQuestion(job);
      assertCurrent(job);
      // The native write was requested in the original click. Its data becomes
      // available only after complete extraction and current-question checks.
      job.resolveBlob(new Blob([text], {type: 'text/plain'}));
      if (nativeResult) {
        const success = await nativeResult;
        assertCurrent(job);
        if (success) say('コピーしました');
        else fallback(text, job);
      } else {
        // Compatibility path when ClipboardItem promises are unavailable.
        // writeText may lose activation after the API call; retain the working
        // execCommand fallback, then expose the exact text for manual copying.
        let success = false;
        try {
          if (typeof navigator.clipboard?.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            success = true;
          }
        } catch (_) {}
        assertCurrent(job);
        if (success) say('コピーしました');
        else fallback(text, job);
      }
    } catch (_) {
      job.rejectBlob(new Error('question_copy_failed'));
      if (job.number === clickNumber) say('コピー失敗');
    } finally {
      if (activeJob === job) activeJob = null;
    }
  }

  function onCopyClick(event) {
    if (!event.isTrusted) return;
    const number = ++clickNumber;
    cancelJob(activeJob);
    activeJob = null;
    manualText.value = '';
    manualBox.hidden = true;
    manualQuestionId = null;
    say('');
    const id = getQuestionUuid();
    if (!id) { say('コピー失敗'); return; }
    const job = {number, id, cancelled: false, controller: new AbortController()};
    activeJob = job;
    const blob = new Promise((resolve, reject) => { job.resolveBlob = resolve; job.rejectBlob = reject; });
    // Some browsers reject ClipboardItem construction before consuming the
    // supplied promise. Observe it locally as well to avoid unhandled failures.
    blob.catch(() => {});
    let nativeResult = null;
    try {
      if (typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function') {
        // Synchronous with a genuine click: preserve activation across fetch.
        nativeResult = Promise.resolve(navigator.clipboard.write([
          new ClipboardItem({'text/plain': blob})
        ])).then(() => true, () => false);
      }
    } catch (_) { /* Fall through to the compatible clipboard path. */ }
    void finishCopy(job, nativeResult);
  }

  function cancelStaleQuestion() {
    if (manualQuestionId && getQuestionUuid() !== manualQuestionId) {
      manualText.value = '';
      manualBox.hidden = true;
      manualQuestionId = null;
      say('');
    }
    if (activeJob && getQuestionUuid() !== activeJob.id) {
      cancelJob(activeJob);
      say('コピー失敗');
    }
  }

  let observedShadow;
  const shadowObserver = new MutationObserver(mount);

  function mount() {
    cancelStaleQuestion();
    const review = document.getElementById('qb-cbt-review-label-lock-host');
    const shadow = review?.shadowRoot;
    if (shadow && shadow !== observedShadow) {
      shadowObserver.disconnect();
      shadowObserver.observe(shadow, {childList: true, subtree: true});
      observedShadow = shadow;
    }
    const main = shadow?.getElementById('main');
    if (!main) return;
    // Retire only the old bridge row. Attribute changes cannot fight its child-list observer.
    const oldRow = shadow.getElementById('qb-ai-review-row');
    if (oldRow) {
      if (!oldRow.hidden) oldRow.hidden = true;
      if (!oldRow.inert) oldRow.inert = true;
    }
    if (!host) {
      host = document.createElement('section');
      host.id = HOST_ID;
      host.setAttribute('aria-label', '問題と解説をコピー');
      host.style.cssText = 'margin:0 0 10px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#172033;';
      const button = document.createElement('button');
      button.id = 'qb-copy-page-text-inline';
      button.type = 'button';
      button.textContent = '問題と解説をコピー';
      button.style.cssText = 'width:100%;padding:9px 12px;border:1px solid #1d4ed8;border-radius:7px;background:#2563eb;color:#fff;font:inherit;font-weight:700;cursor:pointer;';
      button.addEventListener('click', onCopyClick);
      statusNode = document.createElement('p');
      statusNode.style.cssText = 'margin:6px 0 0;font-size:11px;line-height:1.5;overflow-wrap:anywhere;';
      statusNode.setAttribute('role', 'status');
      statusNode.setAttribute('aria-live', 'polite');
      manualBox = document.createElement('div');
      manualBox.hidden = true;
      manualText = document.createElement('textarea');
      manualText.readOnly = true;
      manualText.style.cssText = 'box-sizing:border-box;width:100%;height:160px;max-height:35vh;margin-top:7px;resize:vertical;font:12px/1.5 sans-serif;';
      manualText.setAttribute('aria-label', '手動コピー用の問題と解説');
      manualBox.append(manualText);
      host.append(button, statusNode, manualBox);
    }
    if (host.parentElement !== main) main.prepend(host);
  }

  // Observe only to mount beside the existing review controls, never to copy.
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, {childList: true, subtree: true});
  window.addEventListener('pageshow', mount);
  window.addEventListener('popstate', cancelStaleQuestion);
  window.addEventListener('hashchange', cancelStaleQuestion);
  window.addEventListener('pagehide', () => cancelJob(activeJob));
  mount();
})();
