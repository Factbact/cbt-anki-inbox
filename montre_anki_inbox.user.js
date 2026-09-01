// ==UserScript==
// @name         モントレ Anki 追加箱
// @namespace    montre-anki-inbox
// @version      1.4
// @description  モントレCBT用。回答後画面認識・科目自動取得hotfix。QB版同系統UI・全辺リサイズ維持。
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_anki_inbox.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_anki_inbox.user.js
// @match        https://m3e-medical.com/*
// @match        https://*.m3e-medical.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(async () => {
  "use strict";

  const CACHE_KEY = "montre_anki_runtime_source_v14";
  const V13_URL = "https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/ff2e13b7d5d32f56ebb339082e7eaf0040fb10db/montre_anki_inbox.user.js";

  function requestText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error("GitHub取得失敗"))
      });
    });
  }

  async function gunzipBase64(payload) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }

  function replaceOnce(source, oldText, newText, label) {
    if (!source.includes(oldText)) throw new Error(`v1.4 ${label}対象が見つかりません`);
    return source.replace(oldText, newText);
  }

  async function buildRuntimeSource() {
    const wrapper = await requestText(V13_URL);
    const chunks = [...wrapper.matchAll(/const p\d+\s*=\s*"([A-Za-z0-9+/=]+)";/g)].map(m => m[1]);
    if (!chunks.length) throw new Error("v1.3本体を抽出できません");

    let source = await gunzipBase64(chunks.join(""));
    source = replaceOnce(source, "  function looksLikeMontreQuestionPage(doc = document) {\n    const text = getPageText(doc);\n    const progress = parseProgress(text);\n\n    if (!progress) return false;\n\n    return Boolean(\n      /次の問題|スキップして次へ|正答|正解|解説|自己評価/.test(text) ||\n      [...doc.querySelectorAll(\"a,button,[role='button']\")]\n        .some((el) =>\n          /次の問題|スキップして次へ/.test(normalizedLabel(el))\n        )\n    );\n  }\n", "  function looksLikeMontreQuestionPage(doc = document) {\n    const text = getPageText(doc);\n    const currentUrl =\n      doc === document\n        ? location.href\n        : String(doc?.URL || \"\");\n\n    const progress = parseProgress(text);\n    const number =\n      parseProblemNumber(doc, currentUrl || location.href);\n\n    const urlLooksLikeQuestion =\n      /\\/users\\/cbt\\/practice_questions(?:\\/|$)/i.test(\n        currentUrl || location.href\n      );\n\n    const hasQuestionSignals =\n      /問題番号|次の問題|スキップして次へ|正答|正解|解説を見る|自己評価|回答を終了する/.test(\n        text\n      );\n\n    const hasNextControl =\n      [...doc.querySelectorAll(\"a,button,[role='button']\")]\n        .some((el) =>\n          /次の問題|スキップして次へ|回答を終了する/.test(\n            normalizedLabel(el)\n          )\n        );\n\n    return Boolean(\n      (number && hasQuestionSignals) ||\n      (urlLooksLikeQuestion && (hasQuestionSignals || hasNextControl)) ||\n      (progress && (hasQuestionSignals || hasNextControl))\n    );\n  }\n", "patch1");
    source = replaceOnce(source, "  function detectSubjectFromPage(doc = document) {\n    const lines = getPageLines(doc);\n    const candidates = [];\n", "  function detectSubjectFromPage(doc = document) {\n    const lines = getPageLines(doc);\n    const candidates = [];\n    const fullText = getPageText(doc);\n\n    for (const division of [\"基礎医学\", \"臨床医学\"]) {\n      const divisionIndex = fullText.lastIndexOf(division);\n      if (divisionIndex < 0) continue;\n\n      const tail = fullText.slice(divisionIndex, divisionIndex + 220);\n\n      for (const [canonical, aliases] of SUBJECT_ALIASES) {\n        for (const alias of aliases) {\n          const aliasIndex = tail.indexOf(alias);\n          if (aliasIndex > 0 && aliasIndex <= 120) {\n            const detected = {\n              subject: canonical,\n              division,\n              source: \"montre-division-subject-text\",\n              evidence: `${division} → ${alias}`\n            };\n            lastSubjectDetection = detected;\n            return detected;\n          }\n        }\n      }\n    }\n", "patch2");
    source = replaceOnce(source, "    const sameTotal =\n      !session.totalQuestions ||\n      session.totalQuestions === parseProgress(getPageText())?.total;\n\n    if (!wasUnset && session.subject === detected.subject) return;\n    if (!sameTotal) return;\n", "    const currentTotal =\n      parseProgress(getPageText())?.total || null;\n\n    const sameTotal =\n      wasUnset ||\n      !session.totalQuestions ||\n      !currentTotal ||\n      session.totalQuestions === currentTotal;\n\n    if (!wasUnset && session.subject === detected.subject) return;\n    if (!sameTotal) return;\n", "patch3");
    source = replaceOnce(source, "    if (\n      looksLikeMontreQuestionPage()\n    ) {\n      maybeAutoUpdateSubject();\n      ensureActiveSession();\n    }\n\n    updateUI();\n", "    maybeAutoUpdateSubject();\n\n    if (\n      looksLikeMontreQuestionPage()\n    ) {\n      ensureActiveSession();\n    }\n\n    updateUI();\n", "patch4");
    source = replaceOnce(source, "        : \"問題画面ではありません。演習中の候補・履歴はそのまま保持されています。\";\n", "        : (\n            info.problemNumber\n              ? `問題番号 ${info.problemNumber} は取得済み ／ 回答後画面を確認中`\n              : \"問題画面ではありません。演習中の候補・履歴はそのまま保持されています。\"\n          );\n", "patch5");
    source = source.replace("// @version      1.2", "// @version      1.4");
    source = source.replace('\"1.2-qb-style-ui\"', '\"1.4-answer-screen-hotfix\"');
    return source;
  }

  let source = GM_getValue(CACHE_KEY, "");
  if (!source || !source.includes("montre-division-subject-text")) {
    source = await buildRuntimeSource();
    GM_setValue(CACHE_KEY, source);
  }

  const run = new Function(
    "GM_getValue",
    "GM_setValue",
    "GM_xmlhttpRequest",
    "GM_info",
    source
  );

  run(GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_info);
})().catch((error) => {
  console.error("モントレ Anki v1.4 起動エラー", error);
  alert("モントレ Anki v1.4 起動失敗: " + (error?.message || String(error)));
});
