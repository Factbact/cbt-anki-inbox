// ==UserScript==
// @name         CBT Anki 追加箱
// @namespace    cbt-anki-inbox
// @version      6.4
// @description  CBT Medilink専用。v6.3を維持しつつ、QB最新自己評価の△/○/◎取得を補強する。
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

  const HOTFIX_MARKER = "__CBT_VISIBLE_TOP_RATING_FIX_V64__";
  const EXPORTER_SIGNATURE = "QB -> Anki JSON Exporter";
  const NativeFunction = globalThis.Function;

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

    const helper = `
    // ${HOTFIX_MARKER}
    // 最新回の自己評価は、履歴DOMより現在画面上部の表示を優先する。
    // QB側の履歴行DOMが入れ子になった場合やSVG構造が変わった場合でも、
    // 「自己評価」ラベル周辺から△/○/◎を回収する。
    function detectVisibleTopSelfRating(doc) {
      const empty = {
        selfRating: null,
        source: null,
        evidence: null
      };

      if (!doc || !doc.body) return empty;

      const candidates = [
        ...doc.querySelectorAll("div, section, article, p, span, dt, dd, li")
      ]
        .filter((element) => {
          const text = normalizeText(
            element.innerText || element.textContent || ""
          );

          return (
            /自己評価\\s*[：:]?/.test(text) &&
            text.length <= 120
          );
        })
        .sort((a, b) => {
          const aText = normalizeText(a.innerText || a.textContent || "");
          const bText = normalizeText(b.innerText || b.textContent || "");
          return aText.length - bText.length;
        });

      for (const label of candidates) {
        let node = label;

        for (let depth = 0; node && depth < 4; depth += 1) {
          const text = normalizeText(
            node.innerText || node.textContent || ""
          );

          // 解答履歴全体など大きすぎる親要素まで遡らない。
          if (depth > 0 && text.length > 260) break;

          const rating = detectRatingFromHistoryRow(node);

          if (rating?.selfRating) {
            return {
              selfRating: rating.selfRating,
              source: String(rating.source || "DOM:visible_top")
                .replace("DOM:answer_history", "DOM:visible_top"),
              evidence: rating.evidence ?? "visible_top_container"
            };
          }

          node = node.parentElement;
        }
      }

      // テキストとして評価記号が描画される場合の最終フォールバック。
      // 「解答履歴」より前だけを見ることで過去履歴の評価を拾わない。
      const visibleText = normalizeText(
        doc.body.innerText || doc.body.textContent || ""
      );
      const beforeHistory = visibleText.split("解答履歴")[0];
      const match = beforeHistory.match(
        /自己評価\\s*[：:]?\\s*([△○◎])/
      );

      if (match) {
        return {
          selfRating: match[1],
          source: "DOM:visible_top_text",
          evidence: "visible_top_text_fallback"
        };
      }

      return empty;
    }
`;

    const capturePattern = /(^|\n)\s*async function capture\(doc\) \{/;

    if (capturePattern.test(patched)) {
      patched = patched.replace(
        capturePattern,
        (match, prefix) =>
          `${prefix}${helper}\n    async function capture(doc) {`
      );
    } else {
      console.warn("[CBT Anki v6.4] capture() を検出できず、自己評価hotfixを挿入できませんでした。");
      return source;
    }

    const selfRatingPattern =
      /const selfRating\s*=\s*domAttempt\?\.selfRating\s*\?\?\s*structuredAttempt\?\.selfRating\s*\?\?\s*null\s*;/;

    if (!selfRatingPattern.test(patched)) {
      console.warn("[CBT Anki v6.4] selfRating判定ブロックを検出できませんでした。");
      return source;
    }

    patched = patched.replace(
      selfRatingPattern,
      `const visibleTopRating = detectVisibleTopSelfRating(doc);\n      const selfRating =\n        visibleTopRating?.selfRating ??\n        domAttempt?.selfRating ??\n        structuredAttempt?.selfRating ??\n        null;`
    );

    // JSON上の根拠も、実際に採用した最新画面表示と一致させる。
    patched = patched.replace(
      /selfRatingSource:\s*domAttempt\?\.selfRating\s*\?\s*domAttempt\.selfRatingSource\s*:\s*\(\s*structuredAttempt\?\.selfRating\s*\?\s*["']internal_user_status["']\s*:\s*null\s*\),/,
      `selfRatingSource:\n          visibleTopRating?.selfRating\n            ? visibleTopRating.source\n            : (\n                domAttempt?.selfRating\n                  ? domAttempt.selfRatingSource\n                  : (\n                      structuredAttempt?.selfRating\n                        ? "internal_user_status"\n                        : null\n                    )\n              ),`
    );

    patched = patched.replace(
      /selfRatingEvidence:\s*domAttempt\?\.selfRatingEvidence\s*\?\?\s*null,/,
      `selfRatingEvidence:\n          visibleTopRating?.selfRating\n            ? visibleTopRating.evidence\n            : (domAttempt?.selfRatingEvidence ?? null),`
    );

    patched = patched.replace(
      "visibleTopSelfRatingUsedForFiltering: false",
      "visibleTopSelfRatingUsedForFiltering: true"
    );

    patched = patched.replace(
      "latest answer-history DOM row; SVG triangle detection; internal user_status fallback",
      "visible top self-rating; latest answer-history DOM row; SVG triangle detection; internal user_status fallback"
    );

    return patched;
  }

  // 「QB全問＋手動候補を取得」は new Function(exporterCode) で起動される。
  // ボタンを押した瞬間だけ Function を差し替え、イベント処理後に必ず戻す。
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

  function patchRunButtonForOneClick() {
    const originalFunction = globalThis.Function;
    globalThis.Function = PatchedFunction;

    setTimeout(() => {
      if (globalThis.Function === PatchedFunction) {
        globalThis.Function = originalFunction;
      }
    }, 0);
  }

  function patchCopyButtonForOneClick() {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return;

    const ownDescriptor = Object.getOwnPropertyDescriptor(clipboard, "writeText");
    const originalWriteText = clipboard.writeText.bind(clipboard);

    try {
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        writable: true,
        value(text) {
          return originalWriteText(patchQBExporterSource(text));
        }
      });
    } catch (error) {
      console.warn(
        "[CBT Anki v6.4] Clipboard hotfixを適用できませんでした。",
        error
      );
      return;
    }

    setTimeout(() => {
      try {
        if (ownDescriptor) {
          Object.defineProperty(clipboard, "writeText", ownDescriptor);
        } else {
          delete clipboard.writeText;
        }
      } catch (_) {}
    }, 0);
  }

  function attachHotfixHooks() {
    const host = document.getElementById("cbt-anki-root-v62");
    const shadow = host?.shadowRoot;

    if (!shadow) return false;

    const runButton = shadow.getElementById("run-qb-exporter");
    const copyButton = shadow.getElementById("copy-qb-exporter");

    if (runButton && !runButton.dataset.qbRatingFixV64) {
      runButton.dataset.qbRatingFixV64 = "1";
      runButton.addEventListener(
        "click",
        patchRunButtonForOneClick,
        true
      );
    }

    if (copyButton && !copyButton.dataset.qbRatingFixV64) {
      copyButton.dataset.qbRatingFixV64 = "1";
      copyButton.addEventListener(
        "click",
        patchCopyButtonForOneClick,
        true
      );
    }

    return Boolean(runButton || copyButton);
  }

  if (!attachHotfixHooks()) {
    const observer = new MutationObserver(() => {
      if (attachHotfixHooks()) observer.disconnect();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    setTimeout(() => observer.disconnect(), 15000);
  }

  console.info(
    "[CBT Anki v6.4] QB最新自己評価hotfixを有効化しました。"
  );
})();
