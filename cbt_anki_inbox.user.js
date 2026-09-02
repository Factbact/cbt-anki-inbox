// ==UserScript==
// @name         CBT Anki 追加箱
// @namespace    cbt-anki-inbox
// @version      6.5
// @description  CBT Medilink専用。QB全問取得時に、回答前の最新履歴を保存して△/×判定の上書きを防ぐ。
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
    return {
      source: source.replace(needle, replacement),
      ok: true
    };
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

    // 1) 最小コンテナに△SVGが入っていない時は、同じ履歴行の親要素まで探索する。
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

          // 別の履歴行まで含む親には上がらない。
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

    // 2) 同じ回答履歴を、selfRatingの有無だけで別行として重複扱いしない。
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

    // 3) 同一履歴の候補では、最小要素より「自己評価を実際に持つ要素」を優先する。
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

    // 4) revealAnswer() が新しい回答履歴を作る前に、元の最新履歴を退避する。
    result = replaceOnce(
      patched,
      `          const reveal = await revealAnswer(doc, progress);`,
      `          // ${HOTFIX_MARKER}
          // 重要: revealAnswer() はQBへ新しい回答履歴を作ることがある。
          // その前に、今回の演習開始時点の最新履歴・自己評価を保存する。
          const preRevealSnapshot = await capture(doc);

          const reveal = await revealAnswer(doc, progress);`,
      "回答前スナップショット"
    );
    if (!result.ok) return source;
    patched = result.source;

    // 5) 解説は回答後の画面から取得するが、判定用latestAttemptは回答前の値を戻す。
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

    // 6) 出力メタデータを更新。
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

  // 「QB取得コードをコピー」でも同じ修正済みExporterを取得できるようにする。
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
