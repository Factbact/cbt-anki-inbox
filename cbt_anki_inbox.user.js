// ==UserScript==
// @name         CBT Anki 追加箱
// @namespace    cbt-anki-inbox
// @version      6.7
// @description  CBT Medilink専用。回答前履歴の保護を維持。移動・サイズ調整・位置保存できるフローティングパネルと固定操作ボタン。
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/cbt_anki_inbox.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/cbt_anki_inbox.user.js
// @match        https://cbt.medilink-study.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @require      https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/6f74ecff02d6835ccd2b4b516d47985e3b0972fe/cbt_anki_inbox.user.js
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const HOTFIX_MARKER = "__CBT_PRE_REVEAL_HISTORY_FIX_V65__";
  const EXPORTER_SIGNATURE = "QB -> Anki JSON Exporter";
  const NativeFunction = globalThis.Function;

  function replaceOnce(source, needle, replacement, label) {
    if (!source.includes(needle)) {
      console.warn(`[CBT Anki v6.5] ${label} の置換対象を検出できませんでした。`);
      return { source, ok: false };
    }
    return { source: source.replace(needle, replacement), ok: true };
  }

  function patchQBExporterSource(source) {
    if (
      typeof source !== "string" ||
      !source.includes(EXPORTER_SIGNATURE) ||
      !source.includes("INBOX_MANUAL_CANDIDATES") ||
      source.includes(HOTFIX_MARKER)
    ) {
      return source;
    }

    let patched = source;
    let result;

    result = replaceOnce(
      patched,
      `      const rating = detectRatingFromHistoryRow(row);

      return {`,
      `      let rating = detectRatingFromHistoryRow(row);

      if (!rating?.selfRating) {
        let parent = row.parentElement;

        for (let depth = 0; parent && depth < 5; depth += 1) {
          const parentText = normalizeText(
            parent.innerText || parent.textContent || ""
          );
          const parentDates =
            parentText.match(/\\b20\\d{2}\\/\\d{1,2}\\/\\d{1,2}\\b/g) || [];

          if (parentDates.length !== 1 || parentText.length > 320) break;

          const parentRating = detectRatingFromHistoryRow(parent);
          if (parentRating?.selfRating) {
            rating = {
              ...parentRating,
              source: String(parentRating.source || "DOM:answer_history")
                .replace(
                  "DOM:answer_history",
                  "DOM:answer_history_ancestor"
                )
            };
            break;
          }

          parent = parent.parentElement;
        }
      }

      return {`,
      "履歴行の祖先SVG探索"
    );
    if (!result.ok) return source;
    patched = result.source;

    result = replaceOnce(
      patched,
      `        const key = [
          item.attempt.answeredDateText || "",
          item.attempt.usersAnswer || "",
          item.attempt.correctness || "",
          item.attempt.selfRating || ""
        ].join("|");`,
      `        const key = [
          item.attempt.answeredDateText || "",
          item.attempt.usersAnswer || "",
          item.attempt.correctness || ""
        ].join("|");`,
      "履歴行dedupキー"
    );
    if (!result.ok) return source;
    patched = result.source;

    result = replaceOnce(
      patched,
      `        if (
          !existing ||
          item.textLength < existing.textLength ||
          (
            item.textLength === existing.textLength &&
            item.domIndex < existing.domIndex
          )
        ) {
          dedup.set(key, item);
        }`,
      `        const itemHasRating = Boolean(item.attempt.selfRating);
        const existingHasRating = Boolean(existing?.attempt?.selfRating);

        if (
          !existing ||
          (itemHasRating && !existingHasRating) ||
          (
            itemHasRating === existingHasRating &&
            (
              item.textLength < existing.textLength ||
              (
                item.textLength === existing.textLength &&
                item.domIndex < existing.domIndex
              )
            )
          )
        ) {
          dedup.set(key, item);
        }`,
      "評価付き履歴行の優先"
    );
    if (!result.ok) return source;
    patched = result.source;

    result = replaceOnce(
      patched,
      `          const reveal = await revealAnswer(doc, progress);`,
      `          // ${HOTFIX_MARKER}
          const preRevealSnapshot = await capture(doc);

          const reveal = await revealAnswer(doc, progress);`,
      "回答前スナップショット"
    );
    if (!result.ok) return source;
    patched = result.source;

    result = replaceOnce(
      patched,
      `          results.push(await capture(doc));`,
      `          const capturedAfterReveal = await capture(doc);

          if (
            preRevealSnapshot?.answerHistory?.captureStatus === "captured" &&
            preRevealSnapshot?.latestAttempt
          ) {
            capturedAfterReveal.latestAttempt =
              preRevealSnapshot.latestAttempt;
            capturedAfterReveal.answerHistory =
              preRevealSnapshot.answerHistory;
            capturedAfterReveal.preRevealLatestAttemptPreserved = true;
          } else {
            capturedAfterReveal.preRevealLatestAttemptPreserved = false;
          }

          results.push(capturedAfterReveal);`,
      "回答前latestAttemptの復元"
    );
    if (!result.ok) return source;
    patched = result.source;

    patched = patched.replace(
      `exporterVersion: "3.6-reusable-session-lifecycle"`,
      `exporterVersion: "3.7-pre-reveal-history-preserved"`
    );
    patched = patched.replace(
      `source: "latest answer-history DOM row; SVG triangle detection; internal user_status fallback"`,
      `source: "pre-reveal latest answer-history DOM row; ancestor SVG triangle detection; internal user_status fallback"`
    );

    return patched;
  }

  function PatchedFunction(...args) {
    const patchedArgs = args.map((arg, index) =>
      index === args.length - 1 && typeof arg === "string"
        ? patchQBExporterSource(arg)
        : arg
    );

    if (new.target) {
      return Reflect.construct(
        NativeFunction,
        patchedArgs,
        new.target === PatchedFunction ? NativeFunction : new.target
      );
    }

    return NativeFunction(...patchedArgs);
  }

  Object.setPrototypeOf(PatchedFunction, NativeFunction);
  PatchedFunction.prototype = NativeFunction.prototype;
  globalThis.Function = PatchedFunction;

  function patchClipboardWriteText() {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return;

    const original = clipboard.writeText.bind(clipboard);

    try {
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        writable: true,
        value(text) {
          return original(patchQBExporterSource(text));
        }
      });
    } catch (error) {
      console.warn(
        "[CBT Anki v6.5] Clipboard hotfixを適用できませんでした。",
        error
      );
    }
  }

  patchClipboardWriteText();

  console.info(
    "[CBT Anki v6.5] 回答前履歴保存 + △SVG祖先探索hotfixを有効化しました。"
  );
})();


// v6.6: Keep frequent actions outside the scrolling content.
// Move existing elements so their event handlers and state remain intact.
(() => {
  "use strict";


  // v6.7: independent floating geometry, separate from the legacy size-only key.
  const FLOAT_KEY = "cbt_anki_floating_panel_v1";
  let disposeFloatingPanel = null;

  function fitFloatingRect(rect, viewportWidth, viewportHeight) {
    const margin = 12;
    const maxWidth = Math.max(1, viewportWidth - margin * 2);
    const maxHeight = Math.max(1, viewportHeight - margin * 2);
    const width = Math.min(maxWidth, Math.max(Math.min(300, maxWidth), rect.width));
    const height = Math.min(maxHeight, Math.max(Math.min(320, maxHeight), rect.height));
    return {
      left: Math.max(margin, Math.min(rect.left, viewportWidth - margin - width)),
      top: Math.max(margin, Math.min(rect.top, viewportHeight - margin - height)),
      width, height
    };
  }

  function resizeFloatingRect(start, edge, dx, dy, vw, vh) {
    const minW = Math.min(300, Math.max(1, vw - 24));
    const minH = Math.min(320, Math.max(1, vh - 24));
    let left = start.left, top = start.top;
    let right = start.left + start.width, bottom = start.top + start.height;
    if (edge.includes("w")) left = Math.max(12, Math.min(left + dx, right - minW));
    if (edge.includes("e")) right = Math.min(vw - 12, Math.max(right + dx, left + minW));
    if (edge.includes("n")) top = Math.max(12, Math.min(top + dy, bottom - minH));
    if (edge.includes("s")) bottom = Math.min(vh - 12, Math.max(bottom + dy, top + minH));
    return fitFloatingRect({left, top, width: right - left, height: bottom - top}, vw, vh);
  }

  function installFloatingPanel(root, panel, header) {
    if (disposeFloatingPanel) disposeFloatingPanel();
    const defaults = {left: 16, top: 140, width: 380, height: 560};
    let saved;
    try { saved = GM_getValue(FLOAT_KEY, null); } catch (_) {}
    let rect = {...defaults};
    if (saved && ["left", "top", "width", "height"].every(k => Number.isFinite(saved[k]))) {
      rect = {...saved};
    }
    let active = null;
    function apply() {
      rect = fitFloatingRect(rect, window.innerWidth, window.innerHeight);
      Object.assign(panel.style, {
        position: "fixed", right: "auto", bottom: "auto",
        left: rect.left + "px", top: rect.top + "px",
        width: rect.width + "px", height: rect.height + "px",
        maxHeight: "calc(100vh - 24px)"
      });
    }
    function persist() {
      try { GM_setValue(FLOAT_KEY, {...rect}); } catch (_) {}
    }
    function move(event) {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - active.x, dy = event.clientY - active.y;
      rect = active.edge
        ? resizeFloatingRect(active.rect, active.edge, dx, dy, window.innerWidth, window.innerHeight)
        : {...active.rect, left: active.rect.left + dx, top: active.rect.top + dy};
      apply();
    }
    function finish(event) {
      if (!active || (event && event.pointerId !== undefined && event.pointerId !== active.pointerId)) return;
      const previous = active;
      active = null;
      try { previous.handle.releasePointerCapture(previous.pointerId); } catch (_) {}
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish);
      panel.style.userSelect = previous.userSelect;
      header.style.cursor = "";
      persist();
    }
    function begin(event) {
      if (event.button !== 0 || event.isPrimary === false || active) return;
      const target = event.target;
      const handle = target.closest?.("[data-resize]");
      const drag = header.contains(target) && !target.closest?.("button");
      if (!handle && !drag) return;
      // Intercept the base script's size-only resize handler.
      event.preventDefault();
      event.stopImmediatePropagation();
      active = {
        rect: {...rect}, x: event.clientX, y: event.clientY,
        edge: handle?.dataset.resize || "", handle: handle || header,
        pointerId: event.pointerId, userSelect: panel.style.userSelect
      };
      panel.style.userSelect = "none";
      if (drag) header.style.cursor = "grabbing";
      try { active.handle.setPointerCapture(event.pointerId); } catch (_) {}
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", finish, true);
      window.addEventListener("blur", finish);
    }
    function viewportChanged() { finish(); apply(); }
    header.title = "ドラッグで移動・パネルの辺や四隅でサイズ変更";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "↺";
    reset.id = "inbox-reset-position";
    reset.title = "位置とサイズを初期状態に戻す";
    reset.setAttribute("aria-label", reset.title);
    reset.addEventListener("click", () => { finish(); rect = {...defaults}; apply(); persist(); });
    header.insertBefore(reset, root.getElementById("close-panel"));
    panel.addEventListener("pointerdown", begin, true);
    window.addEventListener("resize", viewportChanged);
    disposeFloatingPanel = () => {
      finish();
      panel.removeEventListener("pointerdown", begin, true);
      window.removeEventListener("resize", viewportChanged);
    };
    apply();
  }

  function pinInboxActions() {
    const root = document.getElementById("cbt-anki-root-v62")?.shadowRoot;
    if (!root || root.getElementById("inbox-pinned-style")) return;
    const panel = root.getElementById("panel");
    const content = root.getElementById("panel-content");
    const header = root.querySelector(".header");
    const counts = root.querySelector(".count-row");
    const exporter = root.getElementById("run-qb-exporter");
    const save = root.getElementById("save-candidate");
    if (!panel || !content || !header || !counts || !exporter || !save) return;

    const style = document.createElement("style");
    style.id = "inbox-pinned-style";
    style.textContent = `
      #panel { height: min(720px, calc(100vh - 90px)); }
      #panel.open { display: flex; flex-direction: column; }
      #panel-content {
        flex: 1 1 auto;
        min-height: 0;
        height: auto;
        max-height: none;
        padding: 12px 16px;
        border-radius: 0;
        overscroll-behavior: contain;
      }
      #inbox-pinned-header, #inbox-pinned-footer {
        flex: 0 0 auto;
        padding: 12px 16px;
        background: #fff;
      }
      #inbox-pinned-header {
        border-radius: 15px 15px 0 0;
        border-bottom: 1px solid #e5e7eb;
      }
      #inbox-pinned-footer {
        border-radius: 0 0 15px 15px;
        border-top: 1px solid #e5e7eb;
      }
      #inbox-pinned-header .count-row { margin-bottom: 8px; }
      #inbox-pinned-header .run-qb,
      #inbox-pinned-footer .primary { margin-top: 0; }
      #inbox-pinned-header .header {
        cursor: grab; touch-action: none; user-select: none;
        gap: 8px;
      }
      #inbox-pinned-header .title { flex: 1; }
      #inbox-reset-position {
        border: 1px solid #d1d5db; border-radius: 7px;
        background: #f9fafb; color: #374151;
        padding: 3px 8px; cursor: pointer;
      }
      button:focus-visible {
        outline: 3px solid #2563eb;
        outline-offset: 2px;
      }
    `;

    const top = document.createElement("div");
    top.id = "inbox-pinned-header";
    const bottom = document.createElement("div");
    bottom.id = "inbox-pinned-footer";
    top.append(header, counts, exporter);
    bottom.append(save);
    panel.insertBefore(top, content);
    panel.append(bottom);
    root.append(style);
    root.getElementById("close-panel")?.setAttribute("aria-label", "パネルを閉じる");
    installFloatingPanel(root, panel, header);
  }

  pinInboxActions();
  // The base script can create/recreate its shadow host after page navigation.
  // Document observation does not include mutations inside the shadow root.
  const observer = new MutationObserver(pinInboxActions);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
