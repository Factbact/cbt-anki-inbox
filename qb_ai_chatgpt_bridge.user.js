// ==UserScript==
// @name         QB AI解説ブリッジ（プレビュー版）
// @namespace    https://local.tools/qb-ai-chatgpt-bridge
// @version      0.4.2-preview.12
// @description  復習アシスト内で表示中のページ全文をコピー。ChatGPTは自分で開き、貼り付けます。外部送信なし。
// @match        https://cbt.medilink-study.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/* === QB page copy: isolated local clipboard module === */
(() => {
  'use strict';
  if (location.hostname !== 'cbt.medilink-study.com' || window.__QB_INLINE_PAGE_COPY_V12__) return;
  window.__QB_INLINE_PAGE_COPY_V12__ = true;

  const HOST_ID = 'qb-ai-inline-page-copy-tools';
  // These selectors identify UI to omit. No attribute values or form values are
  // read into the payload. innerText supplies the browser's rendered-text rules.
  const OMIT = 'script,style,template,noscript,input,textarea,select,' +
    '[contenteditable]:not([contenteditable="false"]),[hidden],' +
    '#qb-cbt-review-label-lock-host,#qb-page-copy-tools,[id^="qb-ai-"]';
  let host, statusNode, manualBox, manualText, clickNumber = 0;

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

  function collectPageText() {
    if (!document.body || !document.body.getClientRects().length) {
      throw new Error('ページの本文がまだ表示されていません。');
    }
    if (document.body.isContentEditable) {
      throw new Error('ページの本文が編集可能なためコピーできません。');
    }
    for (let ancestor = document.body; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.opacity === '0' || style.contentVisibility === 'hidden' ||
          ancestor.matches('[hidden]')) {
        throw new Error('ページの本文が非表示です。');
      }
    }
    const saved = captureViewState();
    const hidden = [];
    try {
      // Temporarily omit controls and our UI, including inline !important styles.
      // This synchronous operation is restored before painting or writing clipboard.
      const excluded = new Set(document.body.querySelectorAll(OMIT));
      // innerText already handles display/visibility and closed details. Opacity
      // and content-visibility need explicit omission to avoid invisible text.
      for (const node of document.body.querySelectorAll('*')) {
        const style = window.getComputedStyle(node);
        if (style.opacity === '0' || style.contentVisibility === 'hidden') excluded.add(node);
      }
      for (const node of excluded) {
        hidden.push([node, node.style.getPropertyValue('display'), node.style.getPropertyPriority('display')]);
        node.style.setProperty('display', 'none', 'important');
      }
      const text = document.body.innerText;
      if (typeof text !== 'string') throw new Error('このブラウザでは表示中の本文を読み取れません。');
      if (!text.trim()) throw new Error('コピーできる表示中の文字がありません。');
      return text; // No length limit, trimming, rewriting, API lookup, or hidden-data fallback.
    } finally {
      for (let i = hidden.length - 1; i >= 0; i--) {
        const [node, value, priority] = hidden[i];
        if (value) node.style.setProperty('display', value, priority);
        else node.style.removeProperty('display');
      }
      restoreViewState(saved);
    }
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
    say('自動コピーはできませんでした。下の本文を選択してコピーしてください（Mac: ⌘A → ⌘C／Windows: Ctrl+A → Ctrl+C）。');
  }

  function fallback(text, number) {
    // A late failure from an earlier click must not overwrite a newer copy.
    if (number !== clickNumber) return;
    if (legacyCopy(text)) say('ページ全文をコピーしました。貼り付け前に内容を確認してください。');
    else showManualCopy(text);
  }

  function onCopyClick(event) {
    if (!event.isTrusted) return;
    const number = ++clickNumber;
    manualText.value = '';
    manualBox.hidden = true;
    let text;
    try { text = collectPageText(); }
    catch (error) { say(error.message || '表示中の本文を読み取れませんでした。'); return; }
    say('コピーしています…');
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        fallback(text, number);
        return;
      }
      // Invoked directly in the genuine click, before any await loses activation.
      const result = navigator.clipboard.writeText(text);
      Promise.resolve(result).then(() => {
        if (number === clickNumber) say('ページ全文をコピーしました。貼り付け前に内容を確認してください。');
      }, () => fallback(text, number));
    } catch (_) { fallback(text, number); }
  }

  let observedShadow;
  const shadowObserver = new MutationObserver(mount);

  function mount() {
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
      host.setAttribute('aria-label', 'ページ全文をコピー');
      host.style.cssText = 'margin:0 0 10px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#172033;';
      const button = document.createElement('button');
      button.id = 'qb-copy-page-text-inline';
      button.type = 'button';
      button.textContent = 'ページ全文をコピー';
      button.style.cssText = 'width:100%;padding:9px 12px;border:1px solid #1d4ed8;border-radius:7px;background:#2563eb;color:#fff;font:inherit;font-weight:700;cursor:pointer;';
      button.addEventListener('click', onCopyClick);
      const note = document.createElement('p');
      note.style.cssText = 'margin:6px 0 0;font-size:11px;line-height:1.5;';
      note.textContent = '表示中の全文には名前や学習履歴も含まれます。内容を確認し、自分で開いたChatGPTに⌘V／Ctrl+Vで貼り付けてください。外部への送信はしません。';
      statusNode = document.createElement('p');
      statusNode.style.cssText = 'margin:6px 0 0;font-size:11px;line-height:1.5;overflow-wrap:anywhere;';
      statusNode.setAttribute('role', 'status');
      statusNode.setAttribute('aria-live', 'polite');
      manualBox = document.createElement('div');
      manualBox.hidden = true;
      manualText = document.createElement('textarea');
      manualText.readOnly = true;
      manualText.style.cssText = 'box-sizing:border-box;width:100%;height:160px;max-height:35vh;margin-top:7px;resize:vertical;font:12px/1.5 sans-serif;';
      manualText.setAttribute('aria-label', '手動コピー用のページ全文');
      manualBox.append(manualText);
      host.append(button, note, statusNode, manualBox);
    }
    if (host.parentElement !== main) main.prepend(host);
  }

  // Observe only to mount beside the existing review controls, never to copy.
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, {childList: true, subtree: true});
  window.addEventListener('pageshow', mount);
  mount();
})();
