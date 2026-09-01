// ==UserScript==
// @name         CBT Anki 追加箱 v6.2
// @namespace    cbt-anki-inbox
// @version      6.2
// @description  CBT Medilink専用。同一chapter_codeの未完了演習を再利用し、統合JSON保存完了でセッションを閉じる。手動優先・○◎指定・貼り付け対応。
// @match        https://cbt.medilink-study.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const ITEMS_KEY = "cbt_anki_manual_candidates_v43";
  const SETTINGS_KEY = "cbt_anki_settings_v43";
  const MANUAL_COUNTER_KEY = "cbt_anki_manual_counters_v1";
  const PANEL_GEOMETRY_KEY = "cbt_anki_panel_geometry_v2";
  const AUTO_SUBJECT_CONTEXT_KEY = "cbt_anki_auto_subject_context_v1";
  const SUBJECT_CODE_MAP_KEY = "cbt_anki_subject_code_map_v1";
  const EXERCISE_STATE_KEY = "cbt_anki_exercise_state_v1";
  const ROOT_ID = "cbt-anki-root-v62";
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  // 「QB取得コードをコピー」ボタンでコピーするコード
  const QB_EXPORTER_CODE = "(() => {\n  \"use strict\";\n\n  // Anki追加箱から渡される手動候補。\n  // 単体実行時は空配列。\n  const INBOX_MANUAL_CANDIDATES = [];\n  const INBOX_AUTOMATIC_OVERRIDES = [];\n  const INBOX_EXERCISE_SESSION = null;\n\n  // ============================================================\n  // QB -> Anki JSON Exporter (DOM/SVG answer history + structured fallback / safe)\n  //\n  // 使い方:\n  // 1. QBの演習1問目を開く。\n  // 2. このファイル全体をブラウザの開発者ツール Console に貼り付ける。\n  // 3. 開いた操作画面で「取得開始」を押す。\n  //\n  // 既定では、未回答問題の選択肢を勝手に選ばない。\n  // 解答ボタンが無効なら、QB画面で選択肢を選ぶまで待機する。\n  // 「未回答なら先頭の選択肢を自動選択」をオンにすると全自動になるが、\n  // QBの回答履歴には自動選択した回答が記録される。\n  // ============================================================\n\n  const controller = window.open(\n    \"about:blank\",\n    \"QB_EXPORT_CONTROLLER\",\n    \"width=590,height=560\"\n  );\n\n  if (!controller) {\n    alert(\n      \"操作画面を開けませんでした。\\n\" +\n      \"このサイトのポップアップを許可してから、もう一度実行してください。\"\n    );\n    return;\n  }\n\n  controller.document.open();\n  controller.document.write(`\n<!doctype html>\n<html lang=\"ja\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <title>QB Exporter</title>\n  <style>\n    :root { color-scheme: light dark; }\n    body {\n      margin: 0;\n      padding: 20px;\n      font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\n      line-height: 1.55;\n      background: Canvas;\n      color: CanvasText;\n    }\n    h1 { margin: 0 0 14px; font-size: 21px; }\n    #status {\n      min-height: 150px;\n      padding: 14px;\n      white-space: pre-wrap;\n      overflow-wrap: anywhere;\n      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);\n      border-radius: 9px;\n      background: color-mix(in srgb, CanvasText 5%, Canvas);\n    }\n    .option { display: block; margin: 14px 0; font-size: 14px; }\n    .warning { margin-top: 5px; color: #b45309; font-size: 12px; }\n    .buttons { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; }\n    button {\n      padding: 9px 14px;\n      border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);\n      border-radius: 8px;\n      font: inherit;\n      cursor: pointer;\n    }\n    button:disabled { cursor: default; opacity: .55; }\n    #start { background: #2563eb; border-color: #2563eb; color: white; }\n    #stop { background: #dc2626; border-color: #dc2626; color: white; }\n  </style>\n</head>\n<body>\n  <h1>QB Exporter</h1>\n  <div id=\"status\">準備完了。QBの演習1問目を表示して「取得開始」を押してください。</div>\n\n  <label class=\"option\">\n    <input id=\"autoSelect\" type=\"checkbox\">\n    未回答なら先頭の選択肢を自動選択\n    <div class=\"warning\">オンにするとQBの回答履歴に影響します。</div>\n  </label>\n\n  <div class=\"buttons\">\n    <button id=\"start\" type=\"button\">取得開始</button>\n    <button id=\"stop\" type=\"button\" disabled>停止</button>\n    <button id=\"download\" type=\"button\" hidden>JSONを保存</button>\n  </div>\n</body>\n</html>`);\n  controller.document.close();\n\n  // controllerMainは別windowで実行されるため、windowプロパティ経由で渡す。\n  try {\n    controller.__CBT_ANKI_MANUAL_CANDIDATES__ =\n      JSON.parse(JSON.stringify(INBOX_MANUAL_CANDIDATES || []));\n  } catch (_) {\n    controller.__CBT_ANKI_MANUAL_CANDIDATES__ = [];\n  }\n\n  try {\n    controller.__CBT_ANKI_AUTOMATIC_OVERRIDES__ =\n      JSON.parse(JSON.stringify(INBOX_AUTOMATIC_OVERRIDES || []));\n  } catch (_) {\n    controller.__CBT_ANKI_AUTOMATIC_OVERRIDES__ = [];\n  }\n\n  try {\n    controller.__CBT_ANKI_EXERCISE_SESSION__ =\n      INBOX_EXERCISE_SESSION\n        ? JSON.parse(JSON.stringify(INBOX_EXERCISE_SESSION))\n        : null;\n  } catch (_) {\n    controller.__CBT_ANKI_EXERCISE_SESSION__ = null;\n  }\n\n  function controllerMain() {\n    \"use strict\";\n\n    const qb = window.opener;\n    const statusEl = document.getElementById(\"status\");\n    const startButton = document.getElementById(\"start\");\n    const stopButton = document.getElementById(\"stop\");\n    const downloadButton = document.getElementById(\"download\");\n    const autoSelectCheckbox = document.getElementById(\"autoSelect\");\n\n    const CONFIG = Object.freeze({\n      answerTimeoutMs: 12000,\n      navigationTimeoutMs: 15000,\n      manualSelectionTimeoutMs: 10 * 60 * 1000,\n      fallbackPollMs: 120,\n      domQuietMs: 180,\n      domSettleLimitMs: 1200\n    });\n\n    let stopRequested = false;\n    let running = false;\n    let lastObjectUrl = null;\n\n    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n\n    function setStatus(text) {\n      statusEl.textContent = text;\n      console.log(text);\n    }\n\n    function getDoc() {\n      try {\n        if (!qb || qb.closed) return null;\n        return qb.document;\n      } catch (_error) {\n        return null;\n      }\n    }\n\n    function getUrl() {\n      try {\n        return qb.location.href;\n      } catch (_error) {\n        return \"\";\n      }\n    }\n\n    function normalizeText(text) {\n      return String(text || \"\")\n        .replace(/\\r/g, \"\")\n        .replace(/[ \\t\\u00a0]+/g, \" \")\n        .replace(/\\n[ \\t]+/g, \"\\n\")\n        .replace(/\\n{3,}/g, \"\\n\\n\")\n        .trim();\n    }\n\n    // 検出処理ではレイアウト計算を伴わないtextContentを優先する。\n    function getDetectionText(doc) {\n      if (!doc || !doc.body) return \"\";\n      return normalizeText(doc.body.textContent || \"\");\n    }\n\n    // JSON保存時は画面上で見えている文章を優先する。\n    function getVisibleText(doc) {\n      if (!doc || !doc.body) return \"\";\n      return normalizeText(doc.body.innerText || doc.body.textContent || \"\");\n    }\n\n    function parseProgress(text) {\n      const match = String(text || \"\").match(\n        /演習\\s*(\\d+)\\s*[\\/／]\\s*(\\d+)\\s*問目/\n      );\n      if (!match) return null;\n      return { current: Number(match[1]), total: Number(match[2]) };\n    }\n\n    function parseQBId(text) {\n      const match = String(text || \"\").match(/\\bID\\s*[:：]\\s*(\\d+)/);\n      return match ? match[1] : null;\n    }\n\n    function getQuestionUuid() {\n      try {\n        const url = new URL(getUrl());\n        return url.searchParams.get(\"question_id\") || null;\n      } catch (_error) {\n        return null;\n      }\n    }\n\n    function getPageIdentity(doc) {\n      const text = getDetectionText(doc);\n      const progress = parseProgress(text);\n      return {\n        current: progress ? progress.current : null,\n        total: progress ? progress.total : null,\n        qbId: parseQBId(text),\n        uuid: getQuestionUuid()\n      };\n    }\n\n    function identityKey(identity) {\n      return [\n        identity.current ?? \"\",\n        identity.total ?? \"\",\n        identity.qbId ?? \"\",\n        identity.uuid ?? \"\"\n      ].join(\"|\");\n    }\n\n    function questionChanged(previous, current) {\n      if (!current) return false;\n      if (\n        previous.current !== null &&\n        current.current !== null &&\n        previous.current !== current.current\n      ) {\n        return true;\n      }\n      if (previous.qbId && current.qbId && previous.qbId !== current.qbId) {\n        return true;\n      }\n      if (previous.uuid && current.uuid && previous.uuid !== current.uuid) {\n        return true;\n      }\n      return false;\n    }\n\n    function getImages(doc, baseUrl) {\n      const seen = new Set();\n      return [...doc.querySelectorAll(\"img\")]\n        .map((img) => {\n          const raw = img.currentSrc || img.src || img.getAttribute(\"src\");\n          if (!raw) return null;\n          try {\n            const src = new URL(raw, baseUrl).href;\n            if (seen.has(src)) return null;\n            seen.add(src);\n            return {\n              src,\n              alt: img.alt || \"\",\n              width: img.naturalWidth || null,\n              height: img.naturalHeight || null\n            };\n          } catch (_error) {\n            return null;\n          }\n        })\n        .filter(Boolean);\n    }\n\n    function normalizedLabel(element) {\n      return String(\n        element.innerText ||\n        element.textContent ||\n        element.value ||\n        element.getAttribute(\"aria-label\") ||\n        \"\"\n      )\n        .replace(/[\\s\\u200b-\\u200d\\ufeff]+/g, \"\")\n        .trim();\n    }\n\n    function isProbablyVisible(element) {\n      if (!element || element.hidden) return false;\n      if (element.getAttribute(\"aria-hidden\") === \"true\") return false;\n      try {\n        return element.getClientRects().length > 0;\n      } catch (_error) {\n        return true;\n      }\n    }\n\n    function findControlByText(doc, words) {\n      const elements = [...doc.querySelectorAll([\n        \"button\",\n        \"a\",\n        \"[role='button']\",\n        \"input[type='button']\",\n        \"input[type='submit']\"\n      ].join(\",\"))].filter(isProbablyVisible);\n\n      for (const word of words) {\n        const exact = elements.find((element) => normalizedLabel(element) === word);\n        if (exact) return exact;\n      }\n      for (const word of words) {\n        const partial = elements.find((element) => normalizedLabel(element).includes(word));\n        if (partial) return partial;\n      }\n      return null;\n    }\n\n    function findAnswerButton(doc) {\n      return findControlByText(doc, [\"解答する\", \"回答する\"]);\n    }\n\n    function findNextButton(doc) {\n      return findControlByText(doc, [\n        \"次の問題\",\n        \"次の問題へ\",\n        \"スキップして次へ\"\n      ]);\n    }\n\n    function isDisabled(element) {\n      return Boolean(\n        !element ||\n        element.disabled ||\n        element.hasAttribute(\"disabled\") ||\n        element.getAttribute(\"aria-disabled\") === \"true\"\n      );\n    }\n\n    function stripPermanentExplanationHint(text) {\n      return String(text || \"\").replace(\n        /全文検索では、?問題文[～〜~\\-]選択肢解説に含まれる単語を検索します。?/g,\n        \"\"\n      );\n    }\n\n    function hasExplanationMarker(text) {\n      return /正解|正答|選択肢解説|あなたの解答|あなたの回答|解答解説|ポイント/.test(\n        stripPermanentExplanationHint(text)\n      );\n    }\n\n    function answerAppearsRevealed(doc, beforeText) {\n      const afterText = getDetectionText(doc);\n      const button = findAnswerButton(doc);\n      const changed = afterText !== beforeText;\n      const expanded = afterText.length > beforeText.length + 40;\n      const marker = hasExplanationMarker(afterText);\n\n      return changed && (\n        (marker && (!button || isDisabled(button) || expanded)) ||\n        (!button && expanded)\n      );\n    }\n\n    // MutationObserverで即座に反応し、120msポーリングは画面遷移時の保険にする。\n    function waitUntil(test, timeoutMs) {\n      return new Promise((resolve) => {\n        let finished = false;\n        let observedBody = null;\n        let observer = null;\n\n        const finish = (value) => {\n          if (finished) return;\n          finished = true;\n          clearInterval(intervalId);\n          clearTimeout(timeoutId);\n          if (observer) observer.disconnect();\n          resolve(value);\n        };\n\n        const attachObserver = () => {\n          const doc = getDoc();\n          const body = doc && doc.body;\n          if (!body || body === observedBody) return;\n          if (observer) observer.disconnect();\n          observedBody = body;\n          try {\n            observer = new MutationObserver(check);\n            observer.observe(body, {\n              subtree: true,\n              childList: true,\n              characterData: true,\n              attributes: true\n            });\n          } catch (_error) {\n            observer = null;\n          }\n        };\n\n        const check = () => {\n          if (stopRequested) {\n            finish(false);\n            return;\n          }\n          attachObserver();\n          try {\n            if (test()) finish(true);\n          } catch (_error) {\n            // 画面遷移の一瞬だけdocumentへ触れない場合は次の監視周期で再試行する。\n          }\n        };\n\n        const intervalId = setInterval(check, CONFIG.fallbackPollMs);\n        const timeoutId = setTimeout(() => finish(false), timeoutMs);\n        check();\n      });\n    }\n\n    async function waitForDomToSettle() {\n      const started = Date.now();\n      let lastSnapshot = \"\";\n      let unchangedSince = Date.now();\n\n      while (!stopRequested && Date.now() - started < CONFIG.domSettleLimitMs) {\n        const doc = getDoc();\n        if (!doc || !doc.body) {\n          await sleep(CONFIG.fallbackPollMs);\n          continue;\n        }\n        const snapshot = [\n          doc.body.textContent ? doc.body.textContent.length : 0,\n          doc.images ? doc.images.length : 0,\n          getUrl()\n        ].join(\"|\");\n\n        if (snapshot !== lastSnapshot) {\n          lastSnapshot = snapshot;\n          unchangedSince = Date.now();\n        } else if (Date.now() - unchangedSince >= CONFIG.domQuietMs) {\n          return;\n        }\n        await sleep(60);\n      }\n    }\n\n    async function clickElement(element) {\n      if (!element || isDisabled(element)) return false;\n      try {\n        element.scrollIntoView({ block: \"center\", inline: \"nearest\" });\n      } catch (_error) {\n        // スクロール不能でもクリックは試す。\n      }\n      try {\n        element.click();\n        return true;\n      } catch (_error) {\n        // click()を拒否する独自部品ではMouseEventを試す。\n      }\n      try {\n        const EventClass = (qb && qb.MouseEvent) || MouseEvent;\n        element.dispatchEvent(new EventClass(\"click\", {\n          bubbles: true,\n          cancelable: true,\n          view: qb\n        }));\n        return true;\n      } catch (_error) {\n        return false;\n      }\n    }\n\n    function findFirstChoice(doc) {\n      const root = doc.querySelector(\"main\") || doc;\n      const candidates = [...root.querySelectorAll([\n        \"input[type='radio']\",\n        \"input[type='checkbox']\",\n        \"[role='radio']\",\n        \"[role='checkbox']\"\n      ].join(\",\"))];\n\n      return candidates.find((element) => {\n        const checked = element.checked || element.getAttribute(\"aria-checked\") === \"true\";\n        const nativeInput = element.matches(\"input[type='radio'], input[type='checkbox']\");\n        return !checked && !isDisabled(element) && (nativeInput || isProbablyVisible(element));\n      }) || null;\n    }\n\n    async function enableAnswerButton(doc, progress) {\n      let button = findAnswerButton(doc);\n      if (!button || !isDisabled(button)) return button;\n\n      if (autoSelectCheckbox.checked) {\n        const choice = findFirstChoice(doc);\n        if (!choice) return null;\n        setStatus(\n          `問題 ${progress.current} / ${progress.total}\\n\\n` +\n          \"解答に必要なため、先頭の選択肢を自動選択しています...\"\n        );\n        await clickElement(choice);\n        await waitUntil(() => {\n          const currentDoc = getDoc();\n          const currentButton = currentDoc && findAnswerButton(currentDoc);\n          return Boolean(currentButton && !isDisabled(currentButton));\n        }, 3000);\n      } else {\n        setStatus(\n          `問題 ${progress.current} / ${progress.total}\\n\\n` +\n          \"解答ボタンが無効です。\\n\" +\n          \"QB画面で選択肢を選んでください。選択後は自動で再開します。\\n\\n\" +\n          \"中止する場合は「停止」を押してください。\"\n        );\n        await waitUntil(() => {\n          const currentDoc = getDoc();\n          const currentButton = currentDoc && findAnswerButton(currentDoc);\n          return Boolean(currentButton && !isDisabled(currentButton));\n        }, CONFIG.manualSelectionTimeoutMs);\n      }\n\n      const currentDoc = getDoc();\n      button = currentDoc && findAnswerButton(currentDoc);\n      return button && !isDisabled(button) ? button : null;\n    }\n\n    async function revealAnswer(doc, progress) {\n      let button = findAnswerButton(doc);\n\n      // 解答ボタンがないページは、すでに解説表示済みとして扱う。\n      if (!button) {\n        return { success: true, alreadyRevealed: true };\n      }\n\n      button = await enableAnswerButton(doc, progress);\n      if (stopRequested) {\n        return { success: false, reason: \"ユーザー操作で停止しました。\" };\n      }\n      if (!button) {\n        return {\n          success: false,\n          reason: \"解答ボタンを有効にできませんでした。選択肢の形式を認識できない可能性があります。\"\n        };\n      }\n\n      const beforeText = getDetectionText(getDoc());\n      setStatus(\n        `問題 ${progress.current} / ${progress.total}\\n\\n` +\n        \"正答・解説を表示しています...\"\n      );\n\n      const clicked = await clickElement(button);\n      if (!clicked) {\n        return { success: false, reason: \"解答ボタンをクリックできませんでした。\" };\n      }\n\n      let revealed = await waitUntil(() => {\n        const currentDoc = getDoc();\n        return Boolean(currentDoc && answerAppearsRevealed(currentDoc, beforeText));\n      }, CONFIG.answerTimeoutMs);\n\n      if (!revealed && !stopRequested) {\n        // 一部の独自UIでは通常clickが無視されるため、1回だけ再試行する。\n        const retryDoc = getDoc();\n        const retryButton = retryDoc && findAnswerButton(retryDoc);\n        if (retryButton && !isDisabled(retryButton)) {\n          await clickElement(retryButton);\n          revealed = await waitUntil(() => {\n            const currentDoc = getDoc();\n            return Boolean(currentDoc && answerAppearsRevealed(currentDoc, beforeText));\n          }, 4000);\n        }\n      }\n\n      if (!revealed) {\n        return {\n          success: false,\n          reason: stopRequested\n            ? \"ユーザー操作で停止しました。\"\n            : \"解答ボタンを押しましたが、正答・解説の表示を確認できませんでした。\"\n        };\n      }\n\n      await waitForDomToSettle();\n      return { success: true, alreadyRevealed: false };\n    }\n\n    // ============================================================\n    // 最新解答履歴・自己評価の構造化取得\n    // ============================================================\n\n    // QB内部の user_status は自己評価の3段階コード。\n    // 生コードも必ずJSONへ残し、表示文字だけに依存しない。\n    const USER_STATUS_MAP = Object.freeze({\n      1: \"△\",\n      2: \"○\",\n      3: \"◎\"\n    });\n\n    let runtimeUserStatusMap = null;\n    let runtimeUserStatusMapSource = \"default_qb_mapping\";\n\n    function detectUserStatusMapFromControls(doc) {\n      if (!doc) return null;\n\n      const found = {};\n      const symbols = [\"△\", \"○\", \"◎\"];\n      const controls = [...doc.querySelectorAll(\n        \"input, button, [role='radio'], [role='button'], label\"\n      )];\n\n      for (const element of controls) {\n        const labelText = String(\n          element.getAttribute?.(\"aria-label\") ||\n          element.textContent ||\n          element.closest?.(\"label\")?.textContent ||\n          \"\"\n        ).replace(/\\s+/g, \"\");\n\n        const symbol = symbols.find((candidate) => labelText.includes(candidate));\n        if (!symbol) continue;\n\n        const rawCandidates = [\n          element.value,\n          element.getAttribute?.(\"value\"),\n          element.getAttribute?.(\"data-value\"),\n          element.getAttribute?.(\"data-status\"),\n          element.getAttribute?.(\"data-user-status\")\n        ];\n\n        for (const raw of rawCandidates) {\n          const code = Number(raw);\n          if (Number.isInteger(code) && code >= 1 && code <= 3) {\n            found[code] = symbol;\n            break;\n          }\n        }\n      }\n\n      return Object.keys(found).length >= 2 ? found : null;\n    }\n\n    function ensureUserStatusMap(doc) {\n      const detected = detectUserStatusMapFromControls(doc);\n      if (detected) {\n        runtimeUserStatusMap = { ...USER_STATUS_MAP, ...detected };\n        runtimeUserStatusMapSource = \"detected_from_page_controls\";\n      } else if (!runtimeUserStatusMap) {\n        runtimeUserStatusMap = { ...USER_STATUS_MAP };\n        runtimeUserStatusMapSource = \"default_qb_mapping\";\n      }\n    }\n\n    function decodeUserStatus(value) {\n      const number = Number(value);\n      const map = runtimeUserStatusMap || USER_STATUS_MAP;\n      return Object.prototype.hasOwnProperty.call(map, number)\n        ? map[number]\n        : null;\n    }\n\n    function cloneTimestamp(value) {\n      if (!value || typeof value !== \"object\") return null;\n\n      const seconds = Number(value.seconds);\n      const nanoseconds = Number(value.nanoseconds || 0);\n\n      if (!Number.isFinite(seconds)) return null;\n\n      return {\n        seconds,\n        nanoseconds: Number.isFinite(nanoseconds) ? nanoseconds : 0,\n        iso: new Date(seconds * 1000 + Math.floor(nanoseconds / 1e6)).toISOString()\n      };\n    }\n\n    function snapshotAttempt(value) {\n      if (!value || typeof value !== \"object\") return null;\n\n      return {\n        usersAnswer: value.users_answer ?? null,\n        answerStatusCode: value.answer_status ?? null,\n        userStatusCode: value.user_status ?? null,\n        selfRating: decodeUserStatus(value.user_status),\n        answeredDate: cloneTimestamp(value.answered_date),\n        updatedDate: cloneTimestamp(value.updated_date)\n      };\n    }\n\n    function snapshotHistoryState(value) {\n      if (!value || typeof value !== \"object\") return null;\n\n      const current = snapshotAttempt(value);\n      const previousAttempts = Array.isArray(value.answer_histories)\n        ? value.answer_histories.map(snapshotAttempt).filter(Boolean)\n        : [];\n\n      return {\n        questionDataId: value.question_data_id ?? null,\n        legacyQuestionId: value.question_id ?? null,\n        documentId: value.documentId ?? value.document_id ?? null,\n        current,\n        previousAttempts,\n        rawUserStatusCode: value.user_status ?? null,\n        rawAnswerStatusCode: value.answer_status ?? null\n      };\n    }\n\n    function isDomLikeObject(value) {\n      if (!value || typeof value !== \"object\") return false;\n      try {\n        return Boolean(\n          typeof value.nodeType === \"number\" &&\n          (value.ownerDocument || value.documentElement)\n        );\n      } catch (_error) {\n        return false;\n      }\n    }\n\n    function findHistoryCandidateInObject(root, questionUuid, sourceName) {\n      if (!root || typeof root !== \"object\" || !questionUuid) return null;\n\n      const queue = [{ value: root, path: sourceName || \"root\", depth: 0 }];\n      let queueIndex = 0;\n      const seen = new WeakSet();\n      let visited = 0;\n      const MAX_VISITED = 45000;\n      const MAX_DEPTH = 16;\n      let best = null;\n      let bestScore = -1;\n\n      while (queueIndex < queue.length && visited < MAX_VISITED) {\n        const item = queue[queueIndex++];\n        const value = item.value;\n\n        if (!value || typeof value !== \"object\") continue;\n        if (seen.has(value)) continue;\n        seen.add(value);\n        visited++;\n\n        let score = 0;\n        let exactQuestion = false;\n\n        try {\n          if (value.question_data_id === questionUuid) {\n            exactQuestion = true;\n            score += 100;\n          } else if (value.question_id === questionUuid) {\n            exactQuestion = true;\n            score += 100;\n          }\n\n          if (exactQuestion) {\n            const hasAttemptData =\n              Object.prototype.hasOwnProperty.call(value, \"answered_date\") ||\n              Object.prototype.hasOwnProperty.call(value, \"user_status\") ||\n              Object.prototype.hasOwnProperty.call(value, \"answer_status\") ||\n              Object.prototype.hasOwnProperty.call(value, \"users_answer\") ||\n              Array.isArray(value.answer_histories);\n\n            // /api/questions/<UUID> の「問題本文オブジェクト」は question_id を持つが、\n            // 解答履歴ではない。解答関連フィールドが1つも無いものは候補にしない。\n            if (hasAttemptData) {\n              if (Object.prototype.hasOwnProperty.call(value, \"answered_date\")) score += 15;\n              if (Object.prototype.hasOwnProperty.call(value, \"user_status\")) score += 20;\n              if (Object.prototype.hasOwnProperty.call(value, \"answer_status\")) score += 10;\n              if (Object.prototype.hasOwnProperty.call(value, \"users_answer\")) score += 10;\n              if (Array.isArray(value.answer_histories)) score += 8;\n\n              if (score > bestScore) {\n                bestScore = score;\n                best = {\n                  source: sourceName,\n                  path: item.path,\n                  state: snapshotHistoryState(value)\n                };\n              }\n            }\n          }\n        } catch (_error) {}\n\n        if (item.depth >= MAX_DEPTH) continue;\n\n        let entries;\n        try {\n          entries = Object.entries(value);\n        } catch (_error) {\n          continue;\n        }\n\n        for (const [key, child] of entries) {\n          if (!child || typeof child !== \"object\") continue;\n          if (isDomLikeObject(child)) continue;\n\n          // React FiberからDOM本体へ戻る枝は巨大なので除外する。\n          if (key === \"stateNode\") continue;\n\n          queue.push({\n            value: child,\n            path: `${item.path}.${key}`,\n            depth: item.depth + 1\n          });\n        }\n      }\n\n      return best;\n    }\n\n    function findHistoryFromReact(doc, questionUuid) {\n      if (!doc || !questionUuid) return null;\n\n      const roots = [];\n      const elements = [doc.documentElement, doc.body, ...doc.querySelectorAll(\"main, form, section, div\")];\n      const seenRoots = new Set();\n\n      for (const element of elements) {\n        if (!element) continue;\n\n        let keys = [];\n        try {\n          keys = Object.keys(element);\n        } catch (_error) {}\n\n        for (const key of keys) {\n          if (\n            !key.startsWith(\"__reactFiber$\") &&\n            !key.startsWith(\"__reactProps$\") &&\n            !key.startsWith(\"__reactContainer$\")\n          ) {\n            continue;\n          }\n\n          let root;\n          try {\n            root = element[key];\n          } catch (_error) {\n            root = null;\n          }\n\n          if (!root || typeof root !== \"object\" || seenRoots.has(root)) continue;\n          seenRoots.add(root);\n          roots.push({ root, key });\n\n          // 数個の異なるReactルートがあれば十分。\n          if (roots.length >= 8) break;\n        }\n\n        if (roots.length >= 8) break;\n      }\n\n      let best = null;\n      let bestScore = -1;\n\n      for (const { root, key } of roots) {\n        const found = findHistoryCandidateInObject(\n          root,\n          questionUuid,\n          `DOM:${key.split(\"$\")[0]}`\n        );\n\n        if (!found || !found.state) continue;\n\n        let score = 0;\n        if (found.state.questionDataId === questionUuid) score += 100;\n        if (found.state.current?.answeredDate) score += 20;\n        if (found.state.current?.userStatusCode !== null && found.state.current?.userStatusCode !== undefined) score += 20;\n        if (found.state.current?.usersAnswer !== null && found.state.current?.usersAnswer !== undefined) score += 10;\n\n        if (score > bestScore) {\n          bestScore = score;\n          best = found;\n        }\n      }\n\n      return best;\n    }\n\n    // ============================================================\n    // 画面上の「解答履歴」をDOMとして直接読む\n    // ============================================================\n\n    const TRIANGLE_PATH_SIGNATURE = \"m127.77l18.3918h5.61l127.77m124l220h20l124z\";\n\n    function normalizeSvgPath(value) {\n      return String(value || \"\")\n        .toLowerCase()\n        .replace(/[\\s,.-]/g, \"\");\n    }\n\n    function isTriangleRatingSvg(svg) {\n      if (!svg) return false;\n\n      const classText = String(svg.getAttribute(\"class\") || \"\");\n      const paths = [...svg.querySelectorAll(\"path\")];\n\n      for (const path of paths) {\n        const rawD = path.getAttribute(\"d\") || \"\";\n        const normalized = normalizeSvgPath(rawD);\n\n        // ユーザーが提示したQBの△アイコン。\n        // class=\"text-qb-orange ...\" かつ、この三角形pathを優先して判定する。\n        const exactQBTriangle =\n          classText.includes(\"text-qb-orange\") &&\n          rawD.includes(\"M12 7.77L18.39 18H5.61L12 7.77\") &&\n          rawD.includes(\"M12 4L2 20h20L12 4z\");\n\n        if (exactQBTriangle) return true;\n\n        // class名が変わった場合に備え、三角形path自体でも判定する。\n        if (normalized === TRIANGLE_PATH_SIGNATURE) return true;\n\n        // 最小限の形状フォールバック。\n        if (\n          rawD.includes(\"M12 4\") &&\n          rawD.includes(\"L2 20\") &&\n          rawD.includes(\"h20\") &&\n          rawD.includes(\"L12 4\")\n        ) {\n          return true;\n        }\n      }\n\n      return false;\n    }\n\n    function detectRatingFromHistoryRow(row) {\n      if (!row) {\n        return {\n          selfRating: null,\n          source: null,\n          evidence: null\n        };\n      }\n\n      const text = normalizeText(row.innerText || row.textContent || \"\");\n\n      // テキストで見える評価があれば、それを最優先。\n      if (text.includes(\"△\")) {\n        return {\n          selfRating: \"△\",\n          source: \"DOM:answer_history_text\",\n          evidence: \"triangle_text\"\n        };\n      }\n\n      if (text.includes(\"◎\")) {\n        return {\n          selfRating: \"◎\",\n          source: \"DOM:answer_history_text\",\n          evidence: \"double_circle_text\"\n        };\n      }\n\n      // 単独の○だけを拾う。正解などに含まれる文字とは別物なので、\n      // 実際のUnicode丸印が存在する場合だけ判定する。\n      if (text.includes(\"○\")) {\n        return {\n          selfRating: \"○\",\n          source: \"DOM:answer_history_text\",\n          evidence: \"circle_text\"\n        };\n      }\n\n      // △はQB上では文字ではなくSVGアイコンになっている場合がある。\n      const svgs = [...row.querySelectorAll(\"svg\")];\n      const triangle = svgs.find(isTriangleRatingSvg);\n\n      if (triangle) {\n        const pathD =\n          triangle.querySelector(\"path[d]\")?.getAttribute(\"d\") || null;\n\n        return {\n          selfRating: \"△\",\n          source: \"DOM:answer_history_svg\",\n          evidence: {\n            className: triangle.getAttribute(\"class\") || null,\n            pathD\n          }\n        };\n      }\n\n      return {\n        selfRating: null,\n        source: null,\n        evidence: null\n      };\n    }\n\n    function parseAttemptFromHistoryRow(row) {\n      if (!row) return null;\n\n      const text = normalizeText(row.innerText || row.textContent || \"\");\n      const dateMatch = text.match(/\\b(20\\d{2}\\/\\d{1,2}\\/\\d{1,2})\\b/);\n      const statusMatch = text.match(/(不正解|正解)/);\n\n      if (!dateMatch || !statusMatch) return null;\n\n      const dateText = dateMatch[1];\n      const correctness =\n        statusMatch[1] === \"不正解\" ? \"incorrect\" : \"correct\";\n\n      // 日付と正誤の間にある選択肢文字を拾う。\n      // 例: \"2026/08/27 a 正解\"\n      const escapedDate = dateText.replace(/\\//g, \"\\\\/\");\n      const answerRe = new RegExp(\n        escapedDate +\n          \"\\\\\\\\s+([a-z](?:\\\\\\\\s*[,、・/ ]\\\\\\\\s*[a-z])*)\\\\\\\\s+(?:不正解|正解)\",\n        \"i\"\n      );\n\n      const answerMatch = text.match(answerRe);\n      const usersAnswer = answerMatch\n        ? answerMatch[1].replace(/[\\s,、・/]+/g, \"\").toLowerCase()\n        : null;\n\n      const rating = detectRatingFromHistoryRow(row);\n\n      return {\n        usersAnswer,\n        answerStatusCode: null,\n        userStatusCode: null,\n        selfRating: rating.selfRating,\n        answeredDate: null,\n        answeredDateText: dateText,\n        updatedDate: null,\n        correctness,\n        selfRatingSource: rating.source,\n        selfRatingEvidence: rating.evidence\n      };\n    }\n\n    function findHistoryRowCandidates(doc) {\n      if (!doc || !doc.body) return [];\n\n      const candidates = [];\n      const elements = [\n        ...doc.querySelectorAll(\n          \"tr, [role='row'], li, div, section\"\n        )\n      ];\n\n      for (let domIndex = 0; domIndex < elements.length; domIndex++) {\n        const element = elements[domIndex];\n\n        if (!isProbablyVisible(element)) continue;\n\n        const text = normalizeText(\n          element.innerText || element.textContent || \"\"\n        );\n\n        const dates = text.match(/\\b20\\d{2}\\/\\d{1,2}\\/\\d{1,2}\\b/g) || [];\n\n        // 1行分だけを表す最小コンテナを優先する。\n        if (dates.length !== 1) continue;\n        if (!/(?:不正解|正解)/.test(text)) continue;\n\n        // 解説本文など巨大なコンテナを除外。\n        if (text.length > 220) continue;\n\n        const attempt = parseAttemptFromHistoryRow(element);\n        if (!attempt) continue;\n\n        candidates.push({\n          element,\n          attempt,\n          textLength: text.length,\n          domIndex\n        });\n      }\n\n      // 同一履歴行が div の入れ子で複数検出された場合は、\n      // 最も文字数が少ない（=最小コンテナ）ものだけを残す。\n      const dedup = new Map();\n\n      for (const item of candidates) {\n        const key = [\n          item.attempt.answeredDateText || \"\",\n          item.attempt.usersAnswer || \"\",\n          item.attempt.correctness || \"\",\n          item.attempt.selfRating || \"\"\n        ].join(\"|\");\n\n        const existing = dedup.get(key);\n\n        if (\n          !existing ||\n          item.textLength < existing.textLength ||\n          (\n            item.textLength === existing.textLength &&\n            item.domIndex < existing.domIndex\n          )\n        ) {\n          dedup.set(key, item);\n        }\n      }\n\n      return [...dedup.values()];\n    }\n\n    function dateTextToSortValue(value) {\n      const match = String(value || \"\").match(\n        /^(20\\d{2})\\/(\\d{1,2})\\/(\\d{1,2})$/\n      );\n\n      if (!match) return 0;\n\n      return (\n        Number(match[1]) * 10000 +\n        Number(match[2]) * 100 +\n        Number(match[3])\n      );\n    }\n\n    function findHistoryFromDom(doc) {\n      const rows = findHistoryRowCandidates(doc);\n\n      if (!rows.length) return null;\n\n      rows.sort((a, b) => {\n        const byDate =\n          dateTextToSortValue(b.attempt.answeredDateText) -\n          dateTextToSortValue(a.attempt.answeredDateText);\n\n        if (byDate !== 0) return byDate;\n\n        // 同じ日なら、画面上で先に出てくる行を最新として扱う。\n        return a.domIndex - b.domIndex;\n      });\n\n      const current = rows[0].attempt;\n      const previousAttempts = rows.slice(1).map((row) => row.attempt);\n\n      return {\n        source: \"DOM:answer_history\",\n        path: \"visible_answer_history\",\n        state: {\n          questionDataId: null,\n          legacyQuestionId: null,\n          documentId: null,\n          current,\n          previousAttempts,\n          rawUserStatusCode: null,\n          rawAnswerStatusCode: null\n        }\n      };\n    }\n\n    async function fetchQuestionApi(questionUuid) {\n      if (!questionUuid) return { data: null, error: \"question_uuid_missing\" };\n\n      const url = `https://cbt.medilink-study.com/api/questions/${encodeURIComponent(questionUuid)}`;\n\n      try {\n        const response = await qb.fetch(url, {\n          method: \"GET\",\n          credentials: \"include\",\n          headers: { Accept: \"application/json\" }\n        });\n\n        if (!response.ok) {\n          return { data: null, error: `http_${response.status}` };\n        }\n\n        const data = await response.json();\n        return { data, error: null };\n      } catch (error) {\n        return {\n          data: null,\n          error: error && error.message ? error.message : String(error)\n        };\n      }\n    }\n\n    function flattenAnswer(value) {\n      if (value === null || value === undefined) return [];\n\n      if (Array.isArray(value)) {\n        return value.flatMap(flattenAnswer);\n      }\n\n      const text = String(value).trim().toLowerCase();\n      if (!text) return [];\n\n      const letters = text.match(/[a-z]/g);\n      return letters ? [...new Set(letters)] : [text];\n    }\n\n    function sameAnswerSet(left, right) {\n      const a = [...new Set(flattenAnswer(left))].sort();\n      const b = [...new Set(flattenAnswer(right))].sort();\n      return a.length > 0 && a.length === b.length && a.every((value, index) => value === b[index]);\n    }\n\n    function determineCorrectness(usersAnswer, correctAnswers, visibleText) {\n      if (usersAnswer !== null && usersAnswer !== undefined && Array.isArray(correctAnswers)) {\n        for (const pattern of correctAnswers) {\n          if (sameAnswerSet(usersAnswer, pattern)) return \"correct\";\n        }\n        return \"incorrect\";\n      }\n\n      const text = String(visibleText || \"\");\n      if (/結果\\s*[：:]?\\s*不正解/.test(text)) return \"incorrect\";\n      if (/結果\\s*[：:]?\\s*正解/.test(text)) return \"correct\";\n      return null;\n    }\n\n    async function capture(doc) {\n      const url = getUrl();\n      const text = getVisibleText(doc);\n      const progress = parseProgress(text) || parseProgress(getDetectionText(doc));\n      const questionUuid = getQuestionUuid();\n\n      // DOM上の自己評価コントロールに数値コードが露出していれば、\n      // その場でコード→記号対応も検証する。\n      ensureUserStatusMap(doc);\n\n      // 1) 画面上の「解答履歴」をDOMとして直接読む。\n      //    △はinnerTextに出ずSVGの場合があるため、pathも検査する。\n      const domHistory = findHistoryFromDom(doc);\n\n      // 2) React内部状態も取得する。取得できれば生のuser_statusを保持する。\n      const reactHistory = findHistoryFromReact(doc, questionUuid);\n\n      // 3) 問題本文・正答パターンの構造化データを取得する。\n      const apiResult = await fetchQuestionApi(questionUuid);\n\n      // APIレスポンス自体に本当に解答履歴が含まれる場合だけ候補にする。\n      const apiHistory = apiResult.data\n        ? findHistoryCandidateInObject(\n            apiResult.data,\n            questionUuid,\n            \"API:/api/questions\"\n          )\n        : null;\n\n      const structuredHistory = reactHistory || apiHistory || null;\n      const domAttempt = domHistory?.state?.current || null;\n      const structuredAttempt = structuredHistory?.state?.current || null;\n      const correctAnswers = apiResult.data?.correct_answers ?? null;\n\n      const usersAnswer =\n        domAttempt?.usersAnswer ??\n        structuredAttempt?.usersAnswer ??\n        null;\n\n      const correctness =\n        domAttempt?.correctness ??\n        determineCorrectness(\n          usersAnswer,\n          correctAnswers,\n          text\n        );\n\n      // 自己評価は「最新履歴行の表示」を最優先。\n      // とくに△SVGを見つけた場合は、それを確定値として使う。\n      const selfRating =\n        domAttempt?.selfRating ??\n        structuredAttempt?.selfRating ??\n        null;\n\n      const latestAttempt = {\n        usersAnswer,\n        answerStatusCode:\n          structuredAttempt?.answerStatusCode ?? null,\n        userStatusCode:\n          structuredAttempt?.userStatusCode ?? null,\n        selfRating,\n        answeredDate:\n          structuredAttempt?.answeredDate ?? null,\n        answeredDateText:\n          domAttempt?.answeredDateText ?? null,\n        updatedDate:\n          structuredAttempt?.updatedDate ?? null,\n        correctness,\n        selfRatingSource:\n          domAttempt?.selfRating\n            ? domAttempt.selfRatingSource\n            : (\n                structuredAttempt?.selfRating\n                  ? \"internal_user_status\"\n                  : null\n              ),\n        selfRatingEvidence:\n          domAttempt?.selfRatingEvidence ?? null,\n        selfRatingMapSource:\n          structuredAttempt?.selfRating\n            ? runtimeUserStatusMapSource\n            : null\n      };\n\n      const chosenHistory =\n        domHistory || structuredHistory || null;\n\n      const previousAttempts =\n        domHistory?.state?.previousAttempts?.length\n          ? domHistory.state.previousAttempts\n          : (\n              structuredHistory?.state?.previousAttempts || []\n            );\n\n      return {\n        index: progress ? progress.current : null,\n        qbId: parseQBId(text) || parseQBId(getDetectionText(doc)),\n        questionUuid,\n        url,\n        text,\n        images: getImages(doc, url),\n\n        // ページ上部の「自己評価：◎」は判定に使わない。\n        // 最新の「解答履歴」行を読み、△SVGも直接判定する。\n        latestAttempt,\n\n        answerHistory: {\n          captureStatus: chosenHistory ? \"captured\" : \"unavailable\",\n          source: [\n            domHistory?.source || null,\n            structuredHistory?.source || null\n          ].filter(Boolean),\n          sourcePath: [\n            domHistory?.path || null,\n            structuredHistory?.path || null\n          ].filter(Boolean),\n          previousAttempts,\n          note: domHistory\n            ? \"最新回は画面上の解答履歴行から取得。△はSVG pathも検査。React内部user_statusは取得できた場合のみ補助情報として使用。\"\n            : (\n                structuredHistory\n                  ? \"DOM解答履歴を取得できなかったため、QB内部user_statusから取得。\"\n                  : \"最新自己評価を確定できなかったため、推測していない。\"\n              )\n        },\n\n        questionApi: {\n          captured: Boolean(apiResult.data),\n          error: apiResult.error,\n          data: apiResult.data\n        }\n      };\n    }\n\n    function getInboxManualCandidates() {\n      try {\n        const value = window.__CBT_ANKI_MANUAL_CANDIDATES__;\n        return Array.isArray(value)\n          ? JSON.parse(JSON.stringify(value))\n          : [];\n      } catch (_) {\n        return [];\n      }\n    }\n\n    function getInboxAutomaticOverrides() {\n      try {\n        const value =\n          window.__CBT_ANKI_AUTOMATIC_OVERRIDES__;\n\n        return Array.isArray(value)\n          ? JSON.parse(JSON.stringify(value))\n          : [];\n      } catch (_error) {\n        return [];\n      }\n    }\n\n    function filterAutomaticOverridesForResults(results) {\n      const qbIds = new Set(\n        (results || [])\n          .map((question) => String(question?.qbId || \"\").trim())\n          .filter(Boolean)\n      );\n\n      return getInboxAutomaticOverrides().filter((entry) => {\n        const qbId = String(entry?.qbId || \"\").trim();\n        return qbId && qbIds.has(qbId);\n      });\n    }\n\n    function filterManualCandidatesForResults(results) {\n      const qbIds = new Set(\n        (results || [])\n          .map((question) => String(question?.qbId || \"\").trim())\n          .filter(Boolean)\n      );\n\n      return getInboxManualCandidates().filter((candidate) => {\n        const qbId = String(candidate?.sourceProblem?.qbId || \"\").trim();\n        return qbId && qbIds.has(qbId);\n      });\n    }\n\n    function manualBlobToDataURL(blob) {\n      return new Promise((resolve, reject) => {\n        const reader = new FileReader();\n        reader.onload = () => resolve(reader.result);\n        reader.onerror = reject;\n        reader.readAsDataURL(blob);\n      });\n    }\n\n    async function embedManualImage(image) {\n      if (!image) return image;\n\n      if (image.dataUrl?.startsWith(\"data:\")) {\n        return {\n          ...image,\n          embedded: true,\n          embedError: null\n        };\n      }\n\n      if (image.src?.startsWith(\"data:\")) {\n        return {\n          ...image,\n          dataUrl: image.src,\n          embedded: true,\n          embedError: null\n        };\n      }\n\n      if (!image.src) {\n        return {\n          ...image,\n          embedded: false,\n          embedError: \"no_image_source\"\n        };\n      }\n\n      try {\n        const url = new URL(image.src, qb.location.href);\n\n        if (url.origin !== qb.location.origin) {\n          return {\n            ...image,\n            embedded: false,\n            embedError: \"external_image_not_embedded\"\n          };\n        }\n\n        const response = await qb.fetch(url.href, {\n          credentials: \"include\"\n        });\n\n        if (!response.ok) {\n          throw new Error(`HTTP ${response.status}`);\n        }\n\n        const blob = await response.blob();\n\n        if (blob.size > 8 * 1024 * 1024) {\n          return {\n            ...image,\n            embedded: false,\n            embedError: \"image_too_large\"\n          };\n        }\n\n        return {\n          ...image,\n          dataUrl: await manualBlobToDataURL(blob),\n          embedded: true,\n          embedError: null\n        };\n      } catch (error) {\n        return {\n          ...image,\n          embedded: false,\n          embedError:\n            error && error.message\n              ? error.message\n              : \"download_failed\"\n        };\n      }\n    }\n\n    async function prepareManualCandidates(results) {\n      const candidates = filterManualCandidatesForResults(results);\n      const output = [];\n\n      for (let i = 0; i < candidates.length; i++) {\n        const candidate = candidates[i];\n        const images = [];\n\n        setStatus(\n          `全問取得は完了しました。\\n\\n` +\n          `対応する手動候補を統合しています ${i + 1}/${candidates.length}`\n        );\n\n        for (const image of candidate.images || []) {\n          images.push(await embedManualImage(image));\n        }\n\n        output.push({\n          ...candidate,\n          images\n        });\n      }\n\n      return output;\n    }\n\n    function buildOutput(results, total, error) {\n      const capturedHistoryCount = results.filter(\n        (question) => question.answerHistory?.captureStatus === \"captured\"\n      ).length;\n\n      const domHistoryCapturedCount = results.filter(\n        (question) =>\n          Array.isArray(question.answerHistory?.source) &&\n          question.answerHistory.source.includes(\"DOM:answer_history\")\n      ).length;\n\n      const svgTriangleCount = results.filter(\n        (question) =>\n          question.latestAttempt?.selfRating === \"△\" &&\n          question.latestAttempt?.selfRatingSource === \"DOM:answer_history_svg\"\n      ).length;\n\n      const triangleCount = results.filter(\n        (question) => question.latestAttempt?.selfRating === \"△\"\n      ).length;\n\n      const incorrectCount = results.filter(\n        (question) => question.latestAttempt?.correctness === \"incorrect\"\n      ).length;\n\n      return {\n        source: \"QB\",\n        exporterVersion: \"3.6-reusable-session-lifecycle\",\n        expectedQuestions: total,\n        retrievedQuestions: results.length,\n        answerExplanationCaptured: true,\n        latestAttemptStructured: true,\n        selfRatingPolicy: {\n          source: \"latest answer-history DOM row; SVG triangle detection; internal user_status fallback\",\n          triangleSvgDetection: true,\n          triangleSvgClassHint: \"text-qb-orange\",\n          triangleSvgPathHint: \"M12 7.77L18.39 18H5.61L12 7.77M12 4L2 20h20L12 4z\",\n          userStatusMap: runtimeUserStatusMap || { \"1\": \"△\", \"2\": \"○\", \"3\": \"◎\" },\n          userStatusMapSource: runtimeUserStatusMapSource,\n          visibleTopSelfRatingUsedForFiltering: false\n        },\n        summary: {\n          latestAttemptCaptured: capturedHistoryCount,\n          latestAttemptUnavailable: results.length - capturedHistoryCount,\n          domAnswerHistoryCaptured: domHistoryCapturedCount,\n          svgTriangleDetected: svgTriangleCount,\n          latestTriangle: triangleCount,\n          latestIncorrect: incorrectCount\n        },\n        complete: error === null && results.length === total,\n        exportedAt: new Date().toISOString(),\n        error,\n        questions: results\n      };\n    }\n\n    async function prepareDownload(\n      results,\n      total,\n      error = null,\n      autoClick = true\n    ) {\n      const output = buildOutput(results, total, error);\n      const manualCandidates = await prepareManualCandidates(results);\n\n      output.manualCandidates = {\n        included: manualCandidates.length,\n        matchingPolicy:\n          \"sourceProblem.qbId が今回取得した questions[].qbId に含まれる候補だけを統合\",\n        idPolicy: {\n          automaticQB: \"qb:<qbId>\",\n          manualQB: \"qb:<qbId>:manual:<2-digit-sequence>\",\n          sequencePersistent: true\n        },\n        automaticCardPolicy: {\n          mode: \"manual_opt_in\",\n          defaultWhenManualCandidateExists: \"suppress_automatic\",\n          optInField: \"alsoCreateAutomatic\",\n          rule:\n            \"同じqbIdに手動候補が1件以上ある場合、alsoCreateAutomatic=trueの候補が1件以上ある時だけ自動カードも作成する\"\n        },\n        candidates: manualCandidates\n      };\n\n      const automaticOverrides =\n        filterAutomaticOverridesForResults(results);\n\n      output.automaticCardOverrides = {\n        included: automaticOverrides.length,\n        mode: \"explicit_force_automatic\",\n        qbIds: automaticOverrides\n          .map((entry) => String(entry?.qbId || \"\").trim())\n          .filter(Boolean),\n        precedence:\n          \"この指定は通常の×/△抽出条件およびmanual_only抑制より優先する\",\n        rule:\n          \"一覧に含まれるqbIdは、最新自己評価が○または◎でも自動カードを1枚作成する。×/△の場合も重複させず自動カードは1枚だけ。\",\n        entries: automaticOverrides\n      };\n\n      output.exerciseSession =\n        window.__CBT_ANKI_EXERCISE_SESSION__ || null;\n\n      const blob = new Blob([JSON.stringify(output, null, 2)], {\n        type: \"application/json;charset=utf-8\"\n      });\n\n      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);\n      lastObjectUrl = URL.createObjectURL(blob);\n\n      const filename =\n        `qb_${results.length}questions_with_answers_manual_` +\n        `${manualCandidates.length}.json`;\n\n      downloadButton.hidden = false;\n      downloadButton.textContent = `${filename} を保存`;\n      downloadButton.onclick = () => {\n        const link = document.createElement(\"a\");\n        link.href = lastObjectUrl;\n        link.download = filename;\n        document.body.appendChild(link);\n        link.click();\n        link.remove();\n\n        // Anki追加箱へ「実際に保存ボタンが押された」ことを通知。\n        try {\n          qb.postMessage(\n            {\n              type: \"CBT_ANKI_MANUAL_EXPORT_COMPLETE\",\n              captureIds: manualCandidates\n                .map((candidate) => candidate && candidate.captureId)\n                .filter(Boolean),\n              method: \"merged_qb_json\",\n              exportedAt: new Date().toISOString(),\n              filename,\n              sessionId:\n                window.__CBT_ANKI_EXERCISE_SESSION__?.id || null\n            },\n            \"*\"\n          );\n        } catch (_error) {}\n      };\n\n      if (autoClick) downloadButton.click();\n\n      return {\n        filename,\n        manualCount: manualCandidates.length\n      };\n    }\n\n    async function stopWithPartial(results, total, message) {\n      const prepared = await prepareDownload(\n        results,\n        total,\n        message\n      );\n\n      setStatus(\n        `${message}\\n\\n` +\n        `保存済み: ${results.length} / ${total}問\\n` +\n        `手動候補: ${prepared.manualCount}件を統合\\n` +\n        prepared.filename\n      );\n    }\n\n    async function run() {\n      if (running) return;\n      running = true;\n      stopRequested = false;\n      startButton.disabled = true;\n      stopButton.disabled = false;\n      autoSelectCheckbox.disabled = true;\n\n      const results = [];\n      const seen = new Set();\n      let total = 0;\n\n      try {\n        setStatus(\"QBの問題画面を確認しています...\");\n\n        const initialDocReady = await waitUntil(() => {\n          const doc = getDoc();\n          if (!doc || !doc.body) return false;\n          const text = getDetectionText(doc);\n          return Boolean(\n            parseProgress(text) &&\n            (findAnswerButton(doc) || hasExplanationMarker(text))\n          );\n        }, 5000);\n\n        if (!initialDocReady) {\n          throw new Error(\"「演習 1/20問目」のような問題番号を取得できませんでした。\");\n        }\n\n        let doc = getDoc();\n        const initialProgress = parseProgress(getDetectionText(doc));\n        total = initialProgress.total;\n\n        if (initialProgress.current !== 1) {\n          throw new Error(\n            `現在は${initialProgress.current}問目です。全問取得するには1問目を開いてから実行してください。`\n          );\n        }\n\n        while (!stopRequested && results.length < total) {\n          doc = getDoc();\n          if (!doc || !doc.body) {\n            await stopWithPartial(results, total, \"QB画面を取得できなくなったため停止しました。\");\n            return;\n          }\n\n          const pageText = getDetectionText(doc);\n          const progress = parseProgress(pageText);\n          if (!progress) {\n            await stopWithPartial(results, total, \"問題番号を取得できないため停止しました。\");\n            return;\n          }\n\n          const identity = getPageIdentity(doc);\n          const key = identityKey(identity);\n          if (seen.has(key)) {\n            await stopWithPartial(results, total, \"同じ問題を再度検出したため停止しました。\");\n            return;\n          }\n          seen.add(key);\n\n          const reveal = await revealAnswer(doc, progress);\n          if (!reveal.success) {\n            await stopWithPartial(\n              results,\n              total,\n              `問題 ${progress.current} で停止しました。\\n${reveal.reason}`\n            );\n            return;\n          }\n\n          doc = getDoc();\n          if (!doc || !doc.body) {\n            await stopWithPartial(results, total, \"解説表示後の画面を取得できないため停止しました。\");\n            return;\n          }\n\n          results.push(await capture(doc));\n          setStatus(\n            `問題 ${progress.current} / ${total}\\n\\n` +\n            `正答・解説・最新履歴（SVG評価含む）を取得しました。\\n\\n保存済み: ${results.length}問`\n          );\n\n          if (progress.current >= total) break;\n\n          const nextButton = findNextButton(doc);\n          if (!nextButton) {\n            await stopWithPartial(results, total, \"次の問題ボタンが見つからないため停止しました。\");\n            return;\n          }\n\n          const nextHref = nextButton.tagName === \"A\" ? nextButton.href : \"\";\n          const beforeNavigation = getPageIdentity(doc);\n          setStatus(\n            `問題 ${progress.current} / ${total}\\n\\n` +\n            \"取得完了。次の問題へ移動しています...\"\n          );\n\n          await clickElement(nextButton);\n          let changed = await waitUntil(() => {\n            const currentDoc = getDoc();\n            return Boolean(\n              currentDoc && questionChanged(beforeNavigation, getPageIdentity(currentDoc))\n            );\n          }, CONFIG.navigationTimeoutMs);\n\n          if (!changed && !stopRequested && nextHref) {\n            try {\n              qb.location.href = nextHref;\n              changed = await waitUntil(() => {\n                const currentDoc = getDoc();\n                return Boolean(\n                  currentDoc && questionChanged(beforeNavigation, getPageIdentity(currentDoc))\n                );\n              }, 10000);\n            } catch (_error) {\n              changed = false;\n            }\n          }\n\n          if (!changed) {\n            await stopWithPartial(\n              results,\n              total,\n              stopRequested\n                ? \"ユーザー操作で停止しました。\"\n                : \"次の問題へ移動できないため停止しました。\"\n            );\n            return;\n          }\n\n          const nextQuestionReady = await waitUntil(() => {\n            const currentDoc = getDoc();\n            if (!currentDoc || !currentDoc.body) return false;\n            const text = getDetectionText(currentDoc);\n            const currentProgress = parseProgress(text);\n            return Boolean(\n              currentProgress &&\n              currentProgress.current !== beforeNavigation.current &&\n              (findAnswerButton(currentDoc) || hasExplanationMarker(text))\n            );\n          }, 10000);\n\n          if (!nextQuestionReady) {\n            await stopWithPartial(\n              results,\n              total,\n              \"次の問題の読み込みを確認できないため停止しました。\"\n            );\n            return;\n          }\n\n          await waitForDomToSettle();\n        }\n\n        if (stopRequested) {\n          await stopWithPartial(results, total, \"ユーザー操作で停止しました。\");\n          return;\n        }\n\n        const prepared = await prepareDownload(\n          results,\n          total,\n          null\n        );\n\n        setStatus(\n          `完了\\n\\n${results.length} / ${total}問\\n\\n` +\n          \"QB全問データと、この範囲に対応する手動候補を1つのJSONにまとめました。\\n\" +\n          `手動候補: ${prepared.manualCount}件\\n` +\n          `○・◎でも自動カード指定: ${filterAutomaticOverridesForResults(results).length}問\\n\\n` +\n          prepared.filename\n        );\n      } catch (error) {\n        const message = error && error.message ? error.message : String(error);\n        if (results.length > 0) {\n          await stopWithPartial(results, total || results.length, message);\n        } else {\n          setStatus(`開始できませんでした。\\n\\n${message}`);\n        }\n      } finally {\n        running = false;\n        stopButton.disabled = true;\n        startButton.disabled = false;\n        autoSelectCheckbox.disabled = false;\n      }\n    }\n\n    startButton.addEventListener(\"click\", run);\n    stopButton.addEventListener(\"click\", () => {\n      stopRequested = true;\n      stopButton.disabled = true;\n      setStatus(\"停止処理中です。取得済みデータをJSONにまとめています...\");\n    });\n  }\n\n  try {\n    controller.eval(`(${controllerMain.toString()})();`);\n    controller.focus();\n  } catch (error) {\n    controller.close();\n    alert(\n      \"操作画面の初期化に失敗しました。\\n\" +\n      (error && error.message ? error.message : String(error))\n    );\n  }\n})();";

  let host = null;
  let shadow = null;
  let stagedImages = [];
  let lastSelectedText = "";
  let hoveredImage = null;
  let toastTimer = null;
  let lastUrl = location.href;

  let subjectDetectionState = {
    status: "checking",
    subject: null,
    division: null,
    source: null,
    evidence: null
  };

  let lastAutoSubjectToastKey = "";

  // =========================================================
  // 保存
  // =========================================================

  function getItems() {
    const value = GM_getValue(ITEMS_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  function saveItems(items) {
    GM_setValue(ITEMS_KEY, items);
    updateUI();
  }

  function getSettings() {
    const value = GM_getValue(SETTINGS_KEY, {});
    return {
      source: value.source || "QB",
      division: value.division || "臨床医学",
      subject: value.subject || "",
      autoSubject: value.autoSubject !== false
    };
  }

  function saveSettings(settings) {
    const current = GM_getValue(SETTINGS_KEY, {});
    const merged = {
      ...(current && typeof current === "object" ? current : {}),
      ...settings
    };

    GM_setValue(SETTINGS_KEY, merged);
    updateUI();
  }

  function getAutoSubjectContext() {
    const value = GM_getValue(AUTO_SUBJECT_CONTEXT_KEY, null);
    return value && typeof value === "object" ? value : null;
  }

  function saveAutoSubjectContext(context) {
    GM_setValue(AUTO_SUBJECT_CONTEXT_KEY, context);
  }

  function getManualCounters() {
    const value = GM_getValue(MANUAL_COUNTER_KEY, {});
    return value && typeof value === "object" ? value : {};
  }

  function saveManualCounters(counters) {
    GM_setValue(MANUAL_COUNTER_KEY, counters);
  }

  function peekNextManualAnkiId(qbId) {
    if (!qbId) return null;
    const counters = getManualCounters();
    const next = Number(counters[qbId] || 0) + 1;
    return `qb:${qbId}:manual:${String(next).padStart(2, "0")}`;
  }

  function getNextManualAnkiId(qbId) {
    if (!qbId) return null;
    const counters = getManualCounters();
    const next = Number(counters[qbId] || 0) + 1;
    counters[qbId] = next;
    saveManualCounters(counters);
    return `qb:${qbId}:manual:${String(next).padStart(2, "0")}`;
  }

  // =========================================================
  // 演習セッション管理
  //
  // 「科目」ではなく「今回の演習開始～終了」を1セッションとして扱う。
  // /search → /quiz に入った時点で新しいセッションを開始するため、
  // 同じ科目を数日後にもう一度解いても候補数が混ざらない。
  // =========================================================

  function getExerciseState() {
    const value = GM_getValue(EXERCISE_STATE_KEY, {});

    const sessions =
      value?.sessions && typeof value.sessions === "object"
        ? value.sessions
        : {};

    return {
      activeSessionId: value?.activeSessionId || null,
      previousSessionId: value?.previousSessionId || null,
      warningSessionId: value?.warningSessionId || null,
      sessions
    };
  }

  function saveExerciseState(state) {
    GM_setValue(EXERCISE_STATE_KEY, state);
  }

  function makeExerciseSessionId() {
    const random =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);

    return `exercise:${Date.now()}:${random}`;
  }

  function isQuizUrl(url) {
    try {
      return new URL(url, location.href).pathname.includes("/quiz");
    } catch (_) {
      return false;
    }
  }

  function getCurrentExerciseContext() {
    const settings = getSettings();
    const recent = getAutoSubjectContext();

    const chapterCode =
      getCurrentChapterCode?.() ||
      subjectDetectionState?.code ||
      recent?.chapterCode ||
      null;

    return {
      source: settings.source,
      division: settings.division,
      subject: settings.subject || "科目未設定",
      chapterCode,
      pageUrl: location.href
    };
  }

  function getActiveExerciseSession() {
    const state = getExerciseState();

    if (!state.activeSessionId) return null;

    return state.sessions[state.activeSessionId] || null;
  }

  function isSessionCompleted(session) {
    return Boolean(session?.completedAt);
  }

  function getSessionChapterCode(session) {
    return normalizeChapterCode(
      session?.chapterCode || ""
    ) || null;
  }

  function getCurrentContextChapterCode() {
    const context = getCurrentExerciseContext();
    return normalizeChapterCode(
      context?.chapterCode || ""
    ) || null;
  }

  function findReusableExerciseSession(chapterCode) {
    const code = normalizeChapterCode(chapterCode || "");
    if (!code) return null;

    const state = getExerciseState();

    const candidates = Object.values(state.sessions || {})
      .filter((session) => {
        if (!session || isSessionCompleted(session)) {
          return false;
        }

        return getSessionChapterCode(session) === code;
      })
      .sort((a, b) =>
        String(b.startedAt || "").localeCompare(
          String(a.startedAt || "")
        )
      );

    return candidates[0] || null;
  }

  function activateExerciseSession(sessionId) {
    if (!sessionId) return null;

    const state = getExerciseState();
    const session = state.sessions?.[sessionId];

    if (!session) return null;

    const previousId = state.activeSessionId;

    if (
      previousId &&
      previousId !== sessionId &&
      state.sessions?.[previousId]
    ) {
      const previous = state.sessions[previousId];

      previous.lastLeftAt =
        previous.lastLeftAt || new Date().toISOString();

      const previousItems =
        getItemsForSession(previousId);

      if (
        !isSessionCompleted(previous) &&
        countUnexported(previousItems) > 0
      ) {
        state.warningSessionId = previousId;
      }
    }

    state.previousSessionId =
      previousId && previousId !== sessionId
        ? previousId
        : state.previousSessionId || null;

    state.activeSessionId = sessionId;

    session.lastActivatedAt = new Date().toISOString();

    if (state.warningSessionId === sessionId) {
      state.warningSessionId = null;
    }

    saveExerciseState(state);
    return session;
  }

  function completeExerciseSession(
    sessionId,
    reason = "merged_qb_json"
  ) {
    if (!sessionId) return false;

    const state = getExerciseState();
    const session = state.sessions?.[sessionId];

    if (!session) return false;

    const now = new Date().toISOString();

    session.completedAt = session.completedAt || now;
    session.endedAt = session.endedAt || now;
    session.endReason = reason;

    if (state.warningSessionId === sessionId) {
      state.warningSessionId = null;
    }

    saveExerciseState(state);
    updateUI();

    return true;
  }

  function getItemsForSession(sessionId) {
    if (!sessionId) return [];

    return getItems().filter(
      (item) => item?.exerciseSessionId === sessionId
    );
  }

  function countUnexported(items) {
    return (items || []).filter((item) => !item?.exportedAt).length;
  }

  function createExerciseSession(reason = "enter_quiz") {
    const state = getExerciseState();
    const context = getCurrentExerciseContext();

    const previousId = state.activeSessionId;
    const previous = previousId
      ? state.sessions[previousId]
      : null;

    if (previousId && previous) {
      previous.lastLeftAt =
        previous.lastLeftAt || new Date().toISOString();

      const previousItems =
        getItemsForSession(previousId);

      if (
        !isSessionCompleted(previous) &&
        countUnexported(previousItems) > 0
      ) {
        state.warningSessionId = previousId;
      } else if (state.warningSessionId === previousId) {
        state.warningSessionId = null;
      }
    }

    const id = makeExerciseSessionId();
    const now = new Date().toISOString();

    state.sessions[id] = {
      id,
      source: context.source,
      division: context.division,
      subject: context.subject,
      chapterCode: context.chapterCode,
      startedAt: now,
      endedAt: null,
      completedAt: null,
      startReason: reason,
      entryUrl: location.href,
      automaticOverrides: {}
    };

    state.previousSessionId =
      previousId || state.previousSessionId || null;
    state.activeSessionId = id;

    saveExerciseState(state);
    return state.sessions[id];
  }

  function ensureActiveExerciseSession() {
    if (!isQBQuizPage?.()) return null;

    const state = getExerciseState();
    const active = state.activeSessionId
      ? state.sessions[state.activeSessionId]
      : null;

    const context = getCurrentExerciseContext();
    const currentCode = normalizeChapterCode(
      context.chapterCode || ""
    ) || null;

    // 1) 同じchapter_codeの未完了セッションが現在activeなら継続。
    if (
      active &&
      !isSessionCompleted(active) &&
      currentCode &&
      getSessionChapterCode(active) === currentCode
    ) {
      return active;
    }

    // 2) 「全問再復習」→取得用にquizへ入り直した場合など、
    //    同じchapter_codeの未完了セッションがあれば再利用。
    if (currentCode) {
      const reusable =
        findReusableExerciseSession(currentCode);

      if (reusable) {
        return activateExerciseSession(reusable.id);
      }
    }

    // 3) activeが未完了でchapter_codeを取れない場合は、
    //    同じ科目なら現在のセッションを維持。
    if (
      active &&
      !isSessionCompleted(active) &&
      !currentCode &&
      context.subject &&
      active.subject &&
      context.subject === active.subject
    ) {
      return active;
    }

    // 4) 前回が完了済み、または別科目なら新しい演習として開始。
    return createExerciseSession(
      active && isSessionCompleted(active)
        ? "new_after_completed"
        : "quiz_without_reusable_session"
    );
  }

  function getLegacyGroupKey(item) {
    return [
      "legacy",
      item?.source || "不明",
      item?.division || "不明",
      item?.subject || "科目不明"
    ].join("::");
  }

  function getItemScopeKey(item) {
    if (item?.exerciseSessionId) {
      return `session:${item.exerciseSessionId}`;
    }

    return getLegacyGroupKey(item);
  }

  function getCurrentScopeKey() {
    const session = getActiveExerciseSession();
    return session ? `session:${session.id}` : null;
  }

  function getItemsForScope(scopeKey) {
    if (!scopeKey) return [];

    if (scopeKey.startsWith("session:")) {
      const id = scopeKey.slice("session:".length);
      return getItemsForSession(id);
    }

    return getItems().filter(
      (item) =>
        !item?.exerciseSessionId &&
        getLegacyGroupKey(item) === scopeKey
    );
  }

  function getCurrentSessionItems() {
    const scopeKey = getCurrentScopeKey();
    return scopeKey ? getItemsForScope(scopeKey) : [];
  }

  // =========================================================
  // 評価に関係なく自動カード化する明示指定
  // =========================================================

  function getAutomaticOverridesForSession(sessionId) {
    if (!sessionId) return [];

    const state = getExerciseState();
    const session = state.sessions?.[sessionId];
    const map =
      session?.automaticOverrides &&
      typeof session.automaticOverrides === "object"
        ? session.automaticOverrides
        : {};

    return Object.values(map)
      .filter((entry) => entry?.qbId)
      .sort((a, b) =>
        String(a.addedAt || "").localeCompare(String(b.addedAt || ""))
      );
  }

  function getCurrentAutomaticOverrides() {
    const session = getActiveExerciseSession();
    return session
      ? getAutomaticOverridesForSession(session.id)
      : [];
  }

  function getAutomaticOverridesForScope(scopeKey) {
    if (!scopeKey?.startsWith("session:")) return [];

    return getAutomaticOverridesForSession(
      scopeKey.slice("session:".length)
    );
  }

  function isAutomaticOverrideEnabledForQbId(qbId) {
    if (!qbId) return false;

    return getCurrentAutomaticOverrides().some(
      (entry) => String(entry.qbId) === String(qbId)
    );
  }

  function setAutomaticOverrideForCurrentQuestion(enabled) {
    if (!isQBQuizPage()) {
      toast("QBの問題画面で設定してください");
      return false;
    }

    const question = getCurrentQuestionInfo();

    if (!question.qbId) {
      toast("QB IDを取得できないため設定できません");
      return false;
    }

    const active = ensureActiveExerciseSession();

    if (!active?.id) {
      toast("現在の演習セッションを取得できません");
      return false;
    }

    const state = getExerciseState();
    const session = state.sessions?.[active.id];

    if (!session) {
      toast("演習情報を取得できません");
      return false;
    }

    if (
      !session.automaticOverrides ||
      typeof session.automaticOverrides !== "object"
    ) {
      session.automaticOverrides = {};
    }

    const qbId = String(question.qbId);

    if (enabled) {
      session.automaticOverrides[qbId] = {
        qbId,
        displayQuestionNumber:
          question.displayQuestionNumber || null,
        urlQuestionId:
          question.urlQuestionId || null,
        pageUrl:
          question.pageUrl || location.href,
        subject:
          session.subject || getSettings().subject || null,
        division:
          session.division || getSettings().division || null,
        chapterCode:
          session.chapterCode || null,
        addedAt: new Date().toISOString(),
        forceAutomaticRegardlessOfLatestRating: true,
        reason: "user_explicit_opt_in"
      };
    } else {
      delete session.automaticOverrides[qbId];
    }

    saveExerciseState(state);
    updateUI();

    toast(
      enabled
        ? "この問題は○・◎でも自動カードを作ります"
        : "○・◎での自動カード指定を解除しました"
    );

    return true;
  }

  function toggleAutomaticOverrideForCurrentQuestion() {
    const question = getCurrentQuestionInfo();

    if (!question.qbId) {
      toast("QB IDを取得できません");
      return;
    }

    setAutomaticOverrideForCurrentQuestion(
      !isAutomaticOverrideEnabledForQbId(question.qbId)
    );
  }

  function removeAutomaticOverride(sessionId, qbId) {
    if (!sessionId || !qbId) return;

    const state = getExerciseState();
    const session = state.sessions?.[sessionId];

    if (!session?.automaticOverrides) return;

    delete session.automaticOverrides[String(qbId)];
    saveExerciseState(state);
    updateUI();
    toast("自動カード指定を解除しました");
  }

  function getScopeMeta(scopeKey) {
    if (!scopeKey) return null;

    if (scopeKey.startsWith("session:")) {
      const id = scopeKey.slice("session:".length);
      const state = getExerciseState();
      const session = state.sessions[id];

      if (!session) return null;

      return {
        scopeKey,
        sessionId: id,
        subject: session.subject || "科目不明",
        division: session.division || "",
        source: session.source || "",
        chapterCode: session.chapterCode || null,
        startedAt: session.startedAt || null,
        legacy: false
      };
    }

    const items = getItemsForScope(scopeKey);
    const first = items[0];

    if (!first) return null;

    const dates = items
      .map((item) => item?.savedAt)
      .filter(Boolean)
      .sort();

    return {
      scopeKey,
      sessionId: null,
      subject: first.subject || "科目不明",
      division: first.division || "",
      source: first.source || "",
      chapterCode: null,
      startedAt: dates[0] || null,
      legacy: true
    };
  }

  function getCandidateGroups() {
    const items = getItems();
    const state = getExerciseState();
    const groups = new Map();

    for (const item of items) {
      const scopeKey = getItemScopeKey(item);

      if (!groups.has(scopeKey)) {
        groups.set(scopeKey, {
          scopeKey,
          meta: getScopeMeta(scopeKey),
          items: []
        });
      }

      groups.get(scopeKey).items.push(item);
    }

    for (const [sessionId] of Object.entries(
      state.sessions || {}
    )) {
      if (
        getAutomaticOverridesForSession(sessionId).length === 0
      ) {
        continue;
      }

      const scopeKey = `session:${sessionId}`;

      if (!groups.has(scopeKey)) {
        groups.set(scopeKey, {
          scopeKey,
          meta: getScopeMeta(scopeKey),
          items: []
        });
      }
    }

    const result = [...groups.values()];

    result.sort((a, b) => {
      const aTime =
        a.meta?.startedAt ||
        a.items?.[0]?.savedAt ||
        "";
      const bTime =
        b.meta?.startedAt ||
        b.items?.[0]?.savedAt ||
        "";

      return String(bTime).localeCompare(String(aTime));
    });

    return result;
  }

  function formatLocalDateTime(value) {
    if (!value) return "日時不明";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "日時不明";

    return new Intl.DateTimeFormat("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function sanitizeFilenamePart(value) {
    return String(value || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 40) || "section";
  }

  function markItemsExported(
    captureIds,
    method = "manual_json",
    extra = {}
  ) {
    const ids = new Set(
      (captureIds || []).filter(Boolean).map(String)
    );

    if (ids.size === 0) return 0;

    const items = getItems();
    const exportedAt =
      extra.exportedAt || new Date().toISOString();

    let changed = 0;

    for (const item of items) {
      if (!ids.has(String(item?.captureId || ""))) continue;

      item.exportedAt = exportedAt;
      item.exportMethod = method;
      item.exportBatchId =
        extra.batchId ||
        `export:${Date.now()}`;
      item.exportFilename =
        extra.filename ||
        item.exportFilename ||
        null;
      changed++;
    }

    if (changed > 0) {
      saveItems(items);

      const state = getExerciseState();

      if (
        state.warningSessionId &&
        countUnexported(
          getItemsForSession(state.warningSessionId)
        ) === 0
      ) {
        state.warningSessionId = null;
        saveExerciseState(state);
      }
    }

    return changed;
  }

  // =========================================================
  // パネルの全辺ドラッグ式リサイズ
  // =========================================================

  const PANEL_DEFAULT_WIDTH = 355;
  const PANEL_DEFAULT_HEIGHT = 0; // 0 = 自動高さ
  const PANEL_MIN_WIDTH = 300;
  const PANEL_MIN_HEIGHT = 320;
  const PANEL_MARGIN = 12;

  let resizeState = null;

  function getSavedPanelGeometry() {
    const value = GM_getValue(PANEL_GEOMETRY_KEY, {});
    return {
      width: Number(value.width) || null,
      height: Number(value.height) || null
    };
  }

  function savePanelGeometry(width, height) {
    GM_setValue(PANEL_GEOMETRY_KEY, {
      width: Math.round(width),
      height: Math.round(height)
    });
  }

  function clampPanelSize(width, height) {
    const maxWidth = Math.max(
      PANEL_MIN_WIDTH,
      window.innerWidth - PANEL_MARGIN * 2
    );

    const maxHeight = Math.max(
      PANEL_MIN_HEIGHT,
      window.innerHeight - 90
    );

    return {
      width: Math.max(
        PANEL_MIN_WIDTH,
        Math.min(width, maxWidth)
      ),
      height: Math.max(
        PANEL_MIN_HEIGHT,
        Math.min(height, maxHeight)
      )
    };
  }

  function applySavedPanelGeometry() {
    if (!shadow) return;

    const panel = shadow.getElementById("panel");
    if (!panel) return;

    const saved = getSavedPanelGeometry();

    const initialWidth = saved.width || PANEL_DEFAULT_WIDTH;

    if (saved.height) {
      const size = clampPanelSize(
        initialWidth,
        saved.height
      );
      panel.style.width = `${size.width}px`;
      panel.style.height = `${size.height}px`;
    } else {
      const maxWidth = Math.max(
        PANEL_MIN_WIDTH,
        window.innerWidth - PANEL_MARGIN * 2
      );
      panel.style.width =
        `${Math.max(PANEL_MIN_WIDTH, Math.min(initialWidth, maxWidth))}px`;
      panel.style.height = "";
    }

    // 旧版のCSS zoomが残っていた場合も必ず解除する。
    panel.style.zoom = "";
    panel.style.transform = "";
  }

  function getResizeDirections(handle) {
    return {
      left: handle.dataset.resize.includes("w"),
      right: handle.dataset.resize.includes("e"),
      top: handle.dataset.resize.includes("n"),
      bottom: handle.dataset.resize.includes("s")
    };
  }

  function startPanelResize(event) {
    if (!shadow) return;

    // 左クリック / 主ポインタだけを使用。
    if (event.button !== undefined && event.button !== 0) return;

    const handle = event.currentTarget;
    const panel = shadow.getElementById("panel");

    if (!handle || !panel) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = panel.getBoundingClientRect();
    const directions = getResizeDirections(handle);

    resizeState = {
      pointerId: event.pointerId,
      handle,
      panel,
      directions,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height
    };

    try {
      handle.setPointerCapture(event.pointerId);
    } catch (_) {}

    document.body.style.userSelect = "none";
    document.body.style.cursor = getComputedStyle(handle).cursor;

    /*
     * handleだけでなくwindowで追跡する。
     * ドラッグ中にポインタがハンドルから外れても
     * リサイズが途切れないようにする。
     */
    window.addEventListener("pointermove", resizePanelFromPointer, true);
    window.addEventListener("pointerup", finishPanelResize, true);
    window.addEventListener("pointercancel", finishPanelResize, true);
  }

  function resizePanelFromPointer(event) {
    if (!resizeState) return;
    if (event.pointerId !== resizeState.pointerId) return;

    event.preventDefault();

    const dx = event.clientX - resizeState.startX;
    const dy = event.clientY - resizeState.startY;

    let width = resizeState.startWidth;
    let height = resizeState.startHeight;

    /*
     * パネル自体は左下に固定したまま、
     * どの辺をドラッグしても「その方向へ大きく/小さく」
     * 感じるように寸法だけを変える。
     *
     * 左辺を左へ → 横幅を増やす
     * 左辺を右へ → 横幅を減らす
     * 右辺を右へ → 横幅を増やす
     * 右辺を左へ → 横幅を減らす
     *
     * 上辺を上へ → 高さを増やす
     * 上辺を下へ → 高さを減らす
     * 下辺を下へ → 高さを増やす
     * 下辺を上へ → 高さを減らす
     *
     * 位置を同時に動かさないことで、旧版のような
     * 「掴んだ場所が飛ぶ」「パネルがずれる」挙動を防ぐ。
     */

    if (resizeState.directions.right) {
      width += dx;
    }

    if (resizeState.directions.left) {
      width -= dx;
    }

    if (resizeState.directions.bottom) {
      height += dy;
    }

    if (resizeState.directions.top) {
      height -= dy;
    }

    const size = clampPanelSize(width, height);

    resizeState.panel.style.width = `${size.width}px`;
    resizeState.panel.style.height = `${size.height}px`;
  }

  function finishPanelResize(event) {
    if (!resizeState) return;
    if (
      event.pointerId !== undefined &&
      event.pointerId !== resizeState.pointerId
    ) {
      return;
    }

    const { handle, panel, pointerId } = resizeState;

    try {
      handle.releasePointerCapture(pointerId);
    } catch (_) {}

    window.removeEventListener("pointermove", resizePanelFromPointer, true);
    window.removeEventListener("pointerup", finishPanelResize, true);
    window.removeEventListener("pointercancel", finishPanelResize, true);

    const rect = panel.getBoundingClientRect();
    savePanelGeometry(rect.width, rect.height);

    resizeState = null;

    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  function bindResizeHandles() {
    if (!shadow) return;

    const handles = shadow.querySelectorAll("[data-resize]");

    handles.forEach((handle) => {
      handle.addEventListener("pointerdown", startPanelResize);
    });
  }

  // =========================================================
  // QB問題情報
  // =========================================================

  function getCurrentQuestionInfo() {
    const bodyText = document.body?.innerText || "";

    // 画面下部の正式ID：2410160 など
    const idMatch = bodyText.match(/\bID\s*[：:]\s*(\d{5,12})\b/);
    const qbId = idMatch ? idMatch[1] : null;

    // 2027 2-573 など
    let displayQuestionNumber = null;
    const topMatch = bodyText.match(/\b(20\d{2}\s+\d+\s*-\s*\d+)\b/);

    if (topMatch) {
      displayQuestionNumber = topMatch[1]
        .replace(/\s*-\s*/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (!displayQuestionNumber) {
      const footerMatch = bodyText.match(/CBT(20\d{2})\s+(\d+)\s*-\s*p?(\d+)/i);
      if (footerMatch) {
        displayQuestionNumber =
          `${footerMatch[1]} ${footerMatch[2]}-${footerMatch[3]}`;
      }
    }

    const params = new URLSearchParams(location.search);

    return {
      qbId,
      displayQuestionNumber,
      urlQuestionId: params.get("question_id") || null,
      pageUrl: location.href,
      pageTitle: document.title
    };
  }

  // =========================================================
  // 選択文字・画像
  // =========================================================

  document.addEventListener("selectionchange", () => {
    try {
      const text = window.getSelection()?.toString().trim();
      if (text) lastSelectedText = text;
    } catch (_) {}
  });

  function getSelectedText() {
    try {
      const text = window.getSelection()?.toString().trim();
      if (text) return text;
    } catch (_) {}
    return lastSelectedText || "";
  }

  document.addEventListener(
    "pointerover",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const img = target.closest("img");
      if (img) {
        hoveredImage = img;
      }
    },
    true
  );

  // 画像からマウスが離れたら必ず解除する。
  // 旧版では hoveredImage が残り続けたため、
  // 後から ⌥A を押しただけで以前の画像が勝手に入ることがあった。
  document.addEventListener(
    "pointerout",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const img = target.closest("img");
      if (!img || img !== hoveredImage) return;

      const related = event.relatedTarget;

      // 同じ画像の内部へ移動しただけなら維持。
      if (related instanceof Node && img.contains(related)) return;

      hoveredImage = null;
    },
    true
  );

  function getCurrentlyHoveredImage() {
    if (!hoveredImage) return null;

    try {
      if (!document.contains(hoveredImage)) {
        hoveredImage = null;
        return null;
      }

      // 過去にhoverした画像ではなく「今この瞬間にマウスが乗っている画像」だけ許可。
      if (!hoveredImage.matches(":hover")) {
        hoveredImage = null;
        return null;
      }

      return hoveredImage;
    } catch (_) {
      hoveredImage = null;
      return null;
    }
  }

  function imageElementToInfo(img) {
    if (!img) return null;

    const src = img.currentSrc || img.src || img.getAttribute("src");
    if (!src) return null;

    let absoluteSrc;
    try {
      absoluteSrc = new URL(src, location.href).href;
    } catch (_) {
      absoluteSrc = src;
    }

    return {
      src: absoluteSrc,
      alt: img.alt || "",
      width: img.naturalWidth || img.width || null,
      height: img.naturalHeight || img.height || null,
      dataUrl: null
    };
  }

  function stageImage(imageInfo) {
    if (!imageInfo) return;

    const duplicate = stagedImages.some((image) => {
      if (imageInfo.src && image.src === imageInfo.src) return true;
      if (imageInfo.dataUrl && image.dataUrl === imageInfo.dataUrl) return true;
      return false;
    });

    if (duplicate) {
      toast("この画像はすでに追加されています");
      return;
    }

    stagedImages.push(imageInfo);
    renderImagePreviews();
    toast(`画像を追加しました（${stagedImages.length}枚）`);
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function extractImagesFromHTML(html) {
    if (!html) return [];

    const doc = new DOMParser().parseFromString(html, "text/html");

    return [...doc.querySelectorAll("img")]
      .map((img) => {
        const src = img.getAttribute("src");
        if (!src) return null;

        let absoluteSrc;
        try {
          absoluteSrc = new URL(src, location.href).href;
        } catch (_) {
          absoluteSrc = src;
        }

        return {
          src: absoluteSrc,
          alt: img.getAttribute("alt") || "",
          width: null,
          height: null,
          dataUrl: null
        };
      })
      .filter(Boolean);
  }

  async function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();

    const zone = shadow.getElementById("drop-zone");
    zone.classList.remove("dragging");

    const dt = event.dataTransfer;
    if (!dt) return;

    const imageFiles = [...dt.files].filter((file) =>
      file.type?.startsWith("image/")
    );

    if (imageFiles.length) {
      for (const file of imageFiles) {
        try {
          stageImage({
            src: null,
            alt: file.name || "",
            width: null,
            height: null,
            dataUrl: await fileToDataURL(file)
          });
        } catch (error) {
          console.error(error);
        }
      }
      return;
    }

    const htmlImages = extractImagesFromHTML(dt.getData("text/html"));
    if (htmlImages.length) {
      for (const image of htmlImages) stageImage(image);
      return;
    }

    const uri = dt.getData("text/uri-list")?.trim();
    if (
      uri &&
      /\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i.test(uri)
    ) {
      stageImage({
        src: uri,
        alt: "",
        width: null,
        height: null,
        dataUrl: null
      });
      return;
    }

    const text = dt.getData("text/plain")?.trim();
    if (text) {
      appendTextToMemo(text);
      toast("「覚えたいこと」に追加しました");
    }
  }

  async function handlePaste(event) {
    const clipboard = event.clipboardData;
    if (!clipboard) return false;

    const files = [...(clipboard.files || [])].filter((file) =>
      file.type?.startsWith("image/")
    );

    if (files.length > 0) {
      event.preventDefault();
      event.stopPropagation();

      for (const file of files) {
        try {
          stageImage({
            src: null,
            alt: file.name || "clipboard-image",
            width: null,
            height: null,
            dataUrl: await fileToDataURL(file)
          });
        } catch (error) {
          console.error(error);
          toast("貼り付け画像の読み込みに失敗しました");
        }
      }

      openPanel();
      return true;
    }

    const html = clipboard.getData("text/html");
    const htmlImages = extractImagesFromHTML(html);

    if (htmlImages.length > 0) {
      event.preventDefault();
      event.stopPropagation();

      for (const image of htmlImages) {
        stageImage(image);
      }

      openPanel();
      return true;
    }

    const text = clipboard.getData("text/plain")?.trim();

    if (text) {
      event.preventDefault();
      event.stopPropagation();

      appendTextToMemo(text);
      toast("貼り付けた文字を「覚えたいこと」に追加しました");
      openPanel();
      return true;
    }

    return false;
  }

  function appendTextToMemo(text) {
    if (!shadow) return;

    const textarea = shadow.getElementById("memory-text");
    const cleaned = String(text || "").trim();
    if (!textarea || !cleaned) return;

    textarea.value = textarea.value.trim()
      ? `${textarea.value.trimEnd()}\n${cleaned}`
      : cleaned;

    textarea.focus();
  }

  function captureCurrentToDraft() {
    const text = getSelectedText();

    /*
     * ⌥A の優先順位:
     * 1. 文字を選択している → 文字だけ取り込む
     * 2. 文字選択なし + 現在画像にマウスが乗っている → 画像だけ取り込む
     *
     * これにより、文字を取り込みたいだけなのに
     * 近くの画像まで勝手に入ることを防ぐ。
     */
    if (text) {
      appendTextToMemo(text);
      openPanel();
      lastSelectedText = "";

      try {
        window.getSelection()?.removeAllRanges();
      } catch (_) {}

      return;
    }

    const currentImage = getCurrentlyHoveredImage();
    const imageInfo = imageElementToInfo(currentImage);

    if (imageInfo) {
      stageImage(imageInfo);
      openPanel();
      return;
    }

    toast("文字を選択するか、画像の上にマウスを置いて⌥Aを押してください");
  }

  // =========================================================
  // 候補保存
  // =========================================================

  function hasUnsavedDraft() {
    if (!shadow) return stagedImages.length > 0;

    const textarea = shadow.getElementById("memory-text");
    const raw = textarea ? textarea.value.trim() : "";

    return Boolean(raw || stagedImages.length > 0);
  }

  function saveDraftAsCandidates(options = {}) {
    const {
      silentWhenEmpty = false,
      autoSave = false
    } = options;

    maybeAutoUpdateSubject({ silent: true });
    syncSettingsControls(getSettings());

    const source = shadow.getElementById("source").value;
    const division = shadow.getElementById("division").value;
    const subject = shadow.getElementById("subject").value.trim();
    const alsoCreateAutomatic =
      shadow.getElementById("also-automatic")?.checked === true;

    if (!subject) {
      toast("先に科目を設定してください");
      openSettings();
      return {
        ok: false,
        savedCount: 0,
        reason: "subject_missing"
      };
    }

    saveSettings({ source, division, subject, autoSubject: getSettings().autoSubject });

    const textarea = shadow.getElementById("memory-text");
    const raw = textarea.value.trim();

    if (!raw && stagedImages.length === 0) {
      if (!silentWhenEmpty) {
        toast("覚えたい内容または画像を追加してください");
      }

      return {
        ok: true,
        savedCount: 0,
        reason: "empty"
      };
    }

    let lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0 && stagedImages.length > 0) {
      lines = [""];
    }

    const question = getCurrentQuestionInfo();

    if (source === "QB" && !question.qbId) {
      toast("QB IDを取得できないため保存できません");
      return {
        ok: false,
        savedCount: 0,
        reason: "qb_id_missing"
      };
    }

    const items = getItems();

    const activeSession =
      source === "QB" && isQBQuizPage()
        ? ensureActiveExerciseSession()
        : getActiveExerciseSession();

    for (const line of lines) {
      const captureId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const ankiId =
        source === "QB" && question.qbId
          ? getNextManualAnkiId(question.qbId)
          : null;

      items.push({
        captureId,
        ankiId,
        rawText: line,
        images: JSON.parse(JSON.stringify(stagedImages)),

        // オプトイン方式：
        // 手動候補がある問題は原則「手動のみ」。
        // この値をtrueにした時だけ、△/×の自動カードも併用する。
        alsoCreateAutomatic,
        automaticCardPolicy:
          alsoCreateAutomatic
            ? "manual_plus_automatic"
            : "manual_only",

        source,
        division,
        subject,

        exerciseSessionId: activeSession?.id || null,
        exerciseSession: activeSession
          ? {
              id: activeSession.id,
              chapterCode: activeSession.chapterCode || null,
              startedAt: activeSession.startedAt || null,
              subject: activeSession.subject || subject,
              division: activeSession.division || division
            }
          : null,

        sourceProblem: {
          qbId: question.qbId,
          displayQuestionNumber: question.displayQuestionNumber,
          urlQuestionId: question.urlQuestionId,
          pageUrl: question.pageUrl,
          pageTitle: question.pageTitle
        },
        savedAt: new Date().toISOString()
      });
    }

    saveItems(items);

    textarea.value = "";

    const alsoAutomaticCheckbox =
      shadow.getElementById("also-automatic");
    if (alsoAutomaticCheckbox) {
      alsoAutomaticCheckbox.checked = false;
    }

    stagedImages = [];
    renderImagePreviews();
    updateQuestionDisplay();

    const policyLabel =
      alsoCreateAutomatic
        ? "手動＋自動"
        : "手動のみ";

    toast(
      autoSave
        ? `${lines.length}件を自動保存（${policyLabel}）して次へ進みます`
        : `${lines.length}件を候補に追加（${policyLabel}）しました`
    );

    return {
      ok: true,
      savedCount: lines.length,
      reason: "saved"
    };
  }

  function deleteLastCandidate() {
    const scopeKey = getCurrentScopeKey();

    if (!scopeKey) {
      toast("現在の演習がありません");
      return;
    }

    const currentItems = getItemsForScope(scopeKey);

    if (!currentItems.length) {
      toast("この演習の候補はありません");
      return;
    }

    const target = currentItems[currentItems.length - 1];
    const items = getItems().filter(
      (item) => item?.captureId !== target?.captureId
    );

    saveItems(items);

    // manual連番は巻き戻さない
    toast(
      `削除：${String(
        target.rawText || target.ankiId || "画像候補"
      ).slice(0, 30)}`
    );
  }

  function deleteCandidateByCaptureId(captureId) {
    if (!captureId) return;

    const items = getItems();
    const target = items.find(
      (item) => item?.captureId === captureId
    );

    if (!target) {
      toast("候補が見つかりません");
      return;
    }

    const ok = confirm(
      "この候補を削除しますか？\n\n" +
      String(target.rawText || target.ankiId || "画像のみ候補").slice(0, 120) +
      "\n\n※ manual IDの通算連番は戻りません。"
    );

    if (!ok) return;

    saveItems(
      items.filter((item) => item?.captureId !== captureId)
    );
    toast("候補を削除しました");
  }

  function clearAllCandidates() {
    const items = getItems();

    if (!items.length) {
      toast("候補はありません");
      return;
    }

    const ok = confirm(
      `全履歴の候補 ${items.length}件をすべて削除しますか？\n\n` +
        "過去の演習候補もすべて消えます。必要なら先にバックアップしてください。\n\n" +
        "※ ID重複を防ぐため、削除しても通算連番は戻りません。"
    );

    if (!ok) return;

    saveItems([]);
    toast("すべて削除しました");
  }

  // =========================================================
  // QB全問＋手動候補JSONの書き出し完了通知
  // =========================================================

  window.addEventListener("message", (event) => {
    const data = event?.data;

    if (
      !data ||
      data.type !== "CBT_ANKI_MANUAL_EXPORT_COMPLETE"
    ) {
      return;
    }

    const changed = markItemsExported(
      data.captureIds || [],
      data.method || "merged_qb_json",
      {
        exportedAt: data.exportedAt,
        filename: data.filename
      }
    );

    if (changed > 0) {
      toast(`${changed}件を書き出し済みに更新しました`);
    }

    if (
      data.method === "merged_qb_json" &&
      data.sessionId
    ) {
      completeExerciseSession(
        data.sessionId,
        "merged_qb_json_saved"
      );

      toast("この演習を完了扱いにしました");
    }
  });

  // =========================================================
  // QB取得コードをこのページで直接実行
  // =========================================================

  function getQBExporterCodeWithManualCandidates() {
    // 過去演習の候補が今回のJSONへ混ざらないよう、
    // 現在の演習セッションだけを渡す。
    const items = getCurrentSessionItems();
    const overrides = getCurrentAutomaticOverrides();
    const session = getActiveExerciseSession();

    const serializedItems = JSON.stringify(items);
    const serializedOverrides = JSON.stringify(overrides);
    const serializedSession = JSON.stringify(
      session
        ? {
            id: session.id,
            subject: session.subject || null,
            division: session.division || null,
            chapterCode: session.chapterCode || null,
            startedAt: session.startedAt || null
          }
        : null
    );

    return QB_EXPORTER_CODE
      .replace(
        "const INBOX_MANUAL_CANDIDATES = [];",
        `const INBOX_MANUAL_CANDIDATES = ${serializedItems};`
      )
      .replace(
        "const INBOX_AUTOMATIC_OVERRIDES = [];",
        `const INBOX_AUTOMATIC_OVERRIDES = ${serializedOverrides};`
      )
      .replace(
        "const INBOX_EXERCISE_SESSION = null;",
        `const INBOX_EXERCISE_SESSION = ${serializedSession};`
      );
  }

  function runQBExporterCode() {
    const bodyText = document.body?.innerText || "";

    // QB演習画面でない場合は誤操作を防ぐ。
    if (!/演習\s*\d+\s*[\/／]\s*\d+\s*問目/.test(bodyText)) {
      toast("QBの演習問題画面で実行してください");
      return;
    }

    try {
      /*
       * ボタンクリックのユーザー操作中に同期実行する。
       * これにより、Exporter内の window.open() が
       * ポップアップブロックされにくくなる。
       *
       * Functionを使い、コピー用に保持している
       * QB_EXPORTER_CODE全文をそのまま実行する。
       */
      const runner = new Function(getQBExporterCodeWithManualCandidates());
      runner();

      toast("QB取得ツールを起動しました");
    } catch (error) {
      console.error("QB Exporter 起動エラー:", error);
      toast(
        "QB取得ツールの起動に失敗しました。コピー実行を使ってください"
      );
    }
  }

  // =========================================================
  // QB取得コードをクリップボードへコピー
  // =========================================================

  async function copyQBExporterCode() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(getQBExporterCodeWithManualCandidates());
      } else {
        throw new Error("Clipboard API unavailable");
      }

      toast("QB取得コードをコピーしました");
      return;
    } catch (_) {
      // フォールバック
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = getQBExporterCodeWithManualCandidates();
      textarea.setAttribute("readonly", "");
      Object.assign(textarea.style, {
        position: "fixed",
        left: "-9999px",
        top: "0",
        opacity: "0"
      });

      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);

      const ok = document.execCommand("copy");
      textarea.remove();

      if (!ok) throw new Error("copy failed");

      toast("QB取得コードをコピーしました");
    } catch (error) {
      console.error(error);
      toast("コピーに失敗しました");
    }
  }

  // =========================================================
  // 画像埋め込み
  // =========================================================

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function imageToEmbeddedData(image) {
    if (!image) return image;

    if (image.dataUrl?.startsWith("data:")) {
      return { ...image, embedded: true, embedError: null };
    }

    if (!image.src) {
      return {
        ...image,
        embedded: false,
        embedError: "no_image_source"
      };
    }

    if (image.src.startsWith("data:")) {
      return {
        ...image,
        dataUrl: image.src,
        embedded: true,
        embedError: null
      };
    }

    try {
      const parsed = new URL(image.src, location.href);

      if (parsed.origin === location.origin) {
        const response = await fetch(parsed.href, {
          credentials: "include"
        });

        if (response.ok) {
          const blob = await response.blob();

          if (blob.size > MAX_IMAGE_BYTES) {
            return {
              ...image,
              embedded: false,
              embedError: "image_too_large"
            };
          }

          return {
            ...image,
            dataUrl: await blobToDataURL(blob),
            embedded: true,
            embedError: null
          };
        }
      }
    } catch (_) {}

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: image.src,
        responseType: "blob",

        onload: async (response) => {
          try {
            const blob = response.response;

            if (!blob) {
              resolve({
                ...image,
                embedded: false,
                embedError: "no_blob"
              });
              return;
            }

            if (blob.size > MAX_IMAGE_BYTES) {
              resolve({
                ...image,
                embedded: false,
                embedError: "image_too_large"
              });
              return;
            }

            resolve({
              ...image,
              dataUrl: await blobToDataURL(blob),
              embedded: true,
              embedError: null
            });
          } catch (error) {
            resolve({
              ...image,
              embedded: false,
              embedError: String(error)
            });
          }
        },

        onerror: () => {
          resolve({
            ...image,
            embedded: false,
            embedError: "download_failed"
          });
        }
      });
    });
  }

  // =========================================================
  // JSON書き出し
  // =========================================================

  async function exportCandidateScope(
    scopeKey,
    method = "manual_json"
  ) {
    const items = getItemsForScope(scopeKey);
    const meta = getScopeMeta(scopeKey);

    if (!items.length) {
      toast("この演習の候補はありません");
      return;
    }

    toast("JSONを作成しています…");

    const outputItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = JSON.parse(JSON.stringify(items[i]));
      const embeddedImages = [];

      for (let j = 0; j < (item.images || []).length; j++) {
        toast(`画像取得中 ${i + 1}/${items.length}`);
        embeddedImages.push(
          await imageToEmbeddedData(item.images[j])
        );
      }

      item.images = embeddedImages;
      outputItems.push(item);
    }

    const exportedAt = new Date().toISOString();
    const batchId = `export:${Date.now()}`;

    const output = {
      format: "CBT_Anki_ManualCandidates_v6.0",
      exportedAt,
      count: outputItems.length,

      exerciseSession: meta
        ? {
            sessionId: meta.sessionId,
            subject: meta.subject,
            division: meta.division,
            source: meta.source,
            chapterCode: meta.chapterCode,
            startedAt: meta.startedAt,
            legacy: meta.legacy
          }
        : null,

      idPolicy: {
        automaticQB: "qb:<qbId>",
        manualQB: "qb:<qbId>:manual:<2-digit-sequence>",
        sequencePersistent: true
      },

      automaticCardPolicy: {
        mode: "manual_opt_in",
        defaultWhenManualCandidateExists: "suppress_automatic",
        optInField: "alsoCreateAutomatic",
        rule:
          "同じqbIdに手動候補が1件以上ある場合、alsoCreateAutomatic=trueの候補が1件以上ある時だけ自動カードも作成する"
      },

      automaticCardOverrides: {
        included:
          meta?.sessionId
            ? getAutomaticOverridesForSession(meta.sessionId).length
            : 0,
        mode: "explicit_force_automatic",
        precedence:
          "この指定は通常の×/△抽出条件およびmanual_only抑制より優先する",
        rule:
          "指定qbIdは最新自己評価が○または◎でも自動カードを作成する",
        entries:
          meta?.sessionId
            ? getAutomaticOverridesForSession(meta.sessionId)
            : []
      },

      candidates: outputItems
    };

    const blob = new Blob(
      [JSON.stringify(output, null, 2)],
      { type: "application/json;charset=utf-8" }
    );

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");

    const date = new Date(exportedAt);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");

    const subject = sanitizeFilenamePart(
      meta?.subject || "候補"
    );

    const filename =
      `Anki追加候補_${subject}_${yyyy}-${mm}-${dd}_` +
      `${outputItems.length}件.json`;

    a.href = objectUrl;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);

    markItemsExported(
      items.map((item) => item.captureId),
      method,
      {
        exportedAt,
        batchId,
        filename
      }
    );

    toast(
      `${meta?.subject || "この演習"}：` +
      `${outputItems.length}件を書き出しました`
    );
  }

  async function exportJSON() {
    const scopeKey = getCurrentScopeKey();

    if (!scopeKey) {
      toast("QBの演習画面で実行してください");
      return;
    }

    return exportCandidateScope(
      scopeKey,
      "manual_section_json"
    );
  }

  async function exportAllCandidatesBackup() {
    const items = getItems();

    if (!items.length) {
      toast("候補はまだありません");
      return;
    }

    toast("全候補バックアップを作成しています…");

    const output = {
      format: "CBT_Anki_ManualCandidates_Backup_v6.0",
      exportedAt: new Date().toISOString(),
      count: items.length,
      exerciseState: getExerciseState(),
      candidates: items
    };

    const blob = new Blob(
      [JSON.stringify(output, null, 2)],
      { type: "application/json;charset=utf-8" }
    );

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const now = new Date();

    const date =
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0");

    a.href = objectUrl;
    a.download = `Anki追加箱_全候補バックアップ_${date}_${items.length}件.json`;

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    toast(`全${items.length}件をバックアップしました`);
  }

  // =========================================================
  // UI
  // =========================================================

  function createUI() {
    if (document.getElementById(ROOT_ID)) return;

    host = document.createElement("div");
    host.id = ROOT_ID;

    Object.assign(host.style, {
      position: "fixed",
      left: "14px",
      bottom: "14px",
      zIndex: "2147483647"
    });

    shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
<style>
  * {
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  button, input, select, textarea { font: inherit; }

  #main-button {
    border: 0;
    border-radius: 12px;
    padding: 11px 15px;
    background: #111827;
    color: #fff;
    font-size: 14px;
    font-weight: 750;
    cursor: pointer;
    box-shadow: 0 4px 18px rgba(0,0,0,.30);
  }

  #panel {
    position: absolute;
    left: 0;
    bottom: 52px;

    /* 基本サイズは従来どおり */
    width: 355px;
    max-height: calc(100vh - 90px);

    /*
     * 重要：
     * 外側panelではスクロールさせない。
     * ここをoverflow:autoにすると、right:-7px等の
     * リサイズハンドルがクリップされて掴めなくなるため。
     */
    resize: none;
    overflow: visible;

    padding: 0;
    border-radius: 15px;
    background: #fff;
    color: #111827;
    box-shadow: 0 8px 35px rgba(0,0,0,.28);
    display: none;
  }

  #panel.open { display: block; }

  #panel-content {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    max-height: inherit;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px;
    border-radius: inherit;
    background: inherit;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .title {
    font-size: 17px;
    font-weight: 800;
  }


  /*
   * リサイズ用の透明ハンドル。
   * 全辺 + 4隅で掴める。
   * 見た目は変えず、端の8px程度をドラッグ領域にする。
   */
  .resize-handle {
    position: absolute;
    z-index: 50;
    touch-action: none;
    pointer-events: auto;
    border-radius: 5px;
  }

  @media (hover: hover) and (pointer: fine) {
    .resize-handle:hover {
      background: rgba(59, 130, 246, 0.10);
    }
  }

  .resize-n {
    top: -7px;
    left: 14px;
    right: 14px;
    height: 14px;
    cursor: ns-resize;
  }

  .resize-s {
    bottom: -7px;
    left: 14px;
    right: 14px;
    height: 14px;
    cursor: ns-resize;
  }

  .resize-e {
    top: 14px;
    right: -7px;
    bottom: 14px;
    width: 14px;
    cursor: ew-resize;
  }

  .resize-w {
    top: 14px;
    left: -7px;
    bottom: 14px;
    width: 14px;
    cursor: ew-resize;
  }

  .resize-ne {
    top: -8px;
    right: -8px;
    width: 20px;
    height: 20px;
    cursor: nesw-resize;
  }

  .resize-nw {
    top: -8px;
    left: -8px;
    width: 20px;
    height: 20px;
    cursor: nwse-resize;
  }

  .resize-se {
    right: -8px;
    bottom: -8px;
    width: 20px;
    height: 20px;
    cursor: nwse-resize;
  }

  .resize-sw {
    left: -8px;
    bottom: -8px;
    width: 20px;
    height: 20px;
    cursor: nesw-resize;
  }

  #close-panel {
    border: 0;
    background: transparent;
    font-size: 22px;
    cursor: pointer;
  }

  .count-row { margin-bottom: 10px; font-size: 15px; }
  #candidate-count { font-weight: 800; }

  .exercise-box {
    margin: 8px 0 10px;
    padding: 11px;
    border: 1px solid #bfdbfe;
    border-radius: 11px;
    background: #eff6ff;
  }

  .exercise-label {
    font-size: 10px;
    font-weight: 750;
    color: #64748b;
  }

  #exercise-title {
    margin-top: 2px;
    font-size: 15px;
    font-weight: 850;
    color: #0f172a;
  }

  #exercise-meta,
  #exercise-stats {
    margin-top: 4px;
    font-size: 10.5px;
    line-height: 1.45;
    color: #475569;
  }

  #previous-export-warning {
    display: none;
    margin: 8px 0 10px;
    padding: 10px 11px;
    border: 1px solid #f59e0b;
    border-radius: 10px;
    background: #fffbeb;
    color: #92400e;
    font-size: 11px;
    line-height: 1.45;
  }

  #previous-export-warning.show {
    display: block;
  }

  .candidate-section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 12px 0 7px;
    font-size: 12px;
    font-weight: 800;
  }

  .candidate-section-count {
    font-size: 10px;
    font-weight: 650;
    color: #64748b;
  }

  .candidate-empty {
    padding: 10px;
    border: 1px dashed #d1d5db;
    border-radius: 9px;
    color: #9ca3af;
    font-size: 11px;
    text-align: center;
  }

  .candidate-card {
    margin-bottom: 7px;
    padding: 9px 10px;
    border: 1px solid #e5e7eb;
    border-radius: 9px;
    background: #fff;
  }

  .candidate-top {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .candidate-main {
    min-width: 0;
    flex: 1 1 auto;
  }

  .candidate-text {
    font-size: 11.5px;
    line-height: 1.45;
    font-weight: 700;
    color: #111827;
    overflow-wrap: anywhere;
  }

  .candidate-meta {
    margin-top: 4px;
    font-size: 9.5px;
    line-height: 1.45;
    color: #6b7280;
    overflow-wrap: anywhere;
  }

  .candidate-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 5px;
  }

  .candidate-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 750;
    background: #f3f4f6;
    color: #4b5563;
  }

  .candidate-badge.pending {
    background: #fef3c7;
    color: #92400e;
  }

  .candidate-badge.exported {
    background: #dcfce7;
    color: #166534;
  }

  .candidate-delete {
    flex: 0 0 auto;
    width: auto;
    margin: 0;
    padding: 4px 7px;
    border: 1px solid #fecaca;
    border-radius: 7px;
    background: #fff;
    color: #b91c1c;
    font-size: 9px;
    cursor: pointer;
  }

  .history-group {
    margin-bottom: 7px;
    border: 1px solid #e5e7eb;
    border-radius: 9px;
    background: #fafafa;
    overflow: hidden;
  }

  .history-group > summary {
    padding: 9px 10px;
    cursor: pointer;
    font-size: 10.5px;
    line-height: 1.45;
    font-weight: 750;
    color: #374151;
  }

  .history-body {
    padding: 0 8px 8px;
  }

  .history-export {
    margin: 0 0 8px;
    padding: 7px 9px;
    font-size: 10px;
  }

  .backup-all {
    margin-top: 6px;
    padding: 7px 9px;
    font-size: 10px;
    opacity: .82;
  }

  #save-destination {
    margin: 8px 0 10px;
    padding: 10px 11px;
    border: 1px solid #d1d5db;
    border-radius: 10px;
    background: #f9fafb;
  }
  #save-destination.destination-ok { border-color: #a7f3d0; background: #ecfdf5; }
  #save-destination.destination-warning { border-color: #fcd34d; background: #fffbeb; }
  #save-destination.destination-manual { border-color: #d1d5db; background: #f9fafb; }
  .destination-label { font-size: 10px; font-weight: 700; color: #6b7280; }
  #save-destination-value { margin-top: 2px; font-size: 14px; line-height: 1.35; font-weight: 800; color: #111827; overflow-wrap: anywhere; }
  #auto-subject-status { margin-top: 4px; font-size: 9.5px; line-height: 1.4; color: #6b7280; }
  .checkbox-row { display: flex; align-items: flex-start; gap: 7px; margin-top: 10px; font-size: 12px; font-weight: 650; color: #374151; cursor: pointer; }
  .checkbox-row input { width: auto; flex: 0 0 auto; margin: 2px 0 0; padding: 0; }
  .auto-subject-help { margin: 4px 0 2px 23px; font-size: 9.5px; line-height: 1.4; color: #9ca3af; }

  #settings-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid #e5e7eb;
    border-radius: 9px;
    padding: 9px 10px;
    background: #f9fafb;
    color: #111827;
    cursor: pointer;
    text-align: left;
  }

  #settings-arrow {
    flex: 0 0 auto;
    font-size: 12px;
    color: #6b7280;
  }

  #settings-summary {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  #settings-body {
    display: none;
    margin-top: 7px;
    padding: 10px;
    border-radius: 9px;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
  }

  #settings-body.open { display: block; }

  label {
    display: block;
    margin-top: 9px;
    margin-bottom: 4px;
    font-size: 12px;
    font-weight: 700;
    color: #4b5563;
  }

  select, input, textarea {
    width: 100%;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 9px 10px;
    background: #fff;
    color: #111827;
    font-size: 14px;
  }

  textarea {
    min-height: 96px;
    resize: vertical;
    line-height: 1.45;
  }

  #question-box {
    margin-top: 10px;
    padding: 9px 10px;
    border-radius: 9px;
    background: #f3f4f6;
    font-size: 12px;
    line-height: 1.65;
  }

  .info-row { display: flex; gap: 6px; }
  .info-label { flex: 0 0 78px; color: #6b7280; }
  .info-value {
    flex: 1;
    font-weight: 700;
    word-break: break-all;
  }

  .id-found { color: #047857; }
  .id-missing { color: #b91c1c; }
  #next-anki-id { font-size: 11px; color: #374151; }

  .memory-note {
    margin-top: -6px;
    margin-bottom: 10px;
    font-size: 9.5px;
    line-height: 1.4;
    color: #9ca3af;
  }

  .id-note {
    margin-top: 3px;
    font-size: 9px;
    line-height: 1.35;
    color: #9ca3af;
    overflow-wrap: anywhere;
  }

  .manual-auto-option {
    margin-top: -2px;
    margin-bottom: 0;
  }

  .force-auto-button {
    margin-top: 8px;
    border: 1px solid #c4b5fd;
    background: #f5f3ff;
    color: #5b21b6;
    font-weight: 800;
  }

  .force-auto-button.active {
    border-color: #7c3aed;
    background: #ede9fe;
    color: #4c1d95;
  }

  .force-auto-help {
    margin: 4px 0 11px;
    font-size: 9.5px;
    line-height: 1.45;
    color: #7c3aed;
  }

  .manual-auto-help {
    margin: 3px 0 11px 23px;
    font-size: 9.5px;
    line-height: 1.4;
    color: #9ca3af;
  }

  #drop-zone:focus {
    outline: 2px solid #60a5fa;
    outline-offset: 2px;
  }

  #drop-zone {
    margin-top: 6px;
    min-height: 100px;
    border: 2px dashed #9ca3af;
    border-radius: 11px;
    padding: 12px;
    background: #f9fafb;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    color: #6b7280;
    font-size: 13px;
    line-height: 1.5;
    transition: border-color .15s, background .15s;
  }

  #drop-zone.dragging {
    border-color: #2563eb;
    background: #eff6ff;
    color: #1d4ed8;
  }

  #image-preview-area {
    margin-top: 8px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .preview {
    position: relative;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
    background: #f3f4f6;
  }

  .preview img {
    display: block;
    width: 100%;
    height: 120px;
    object-fit: contain;
    background: #fff;
  }

  .remove-image {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 50%;
    background: rgba(17,24,39,.88);
    color: #fff;
    cursor: pointer;
    font-weight: 700;
  }

  .primary {
    width: 100%;
    margin-top: 11px;
    border: 0;
    border-radius: 9px;
    padding: 10px;
    background: #111827;
    color: #fff;
    font-weight: 750;
    cursor: pointer;
  }

  .secondary {
    width: 100%;
    margin-top: 7px;
    border: 1px solid #d1d5db;
    border-radius: 9px;
    padding: 9px;
    background: #f9fafb;
    color: #111827;
    cursor: pointer;
  }

  .run-qb {
    width: 100%;
    margin-top: 11px;
    border: 1px solid #bfdbfe;
    border-radius: 9px;
    padding: 10px;
    background: #dbeafe;
    color: #1e3a8a;
    font-weight: 750;
    cursor: pointer;
  }

  .run-qb:hover {
    background: #bfdbfe;
  }

  .copy-tool {
    width: auto;
    display: inline-block;
    margin-top: 6px;
    padding: 5px 8px;
    border-radius: 7px;
    font-size: 10px;
    line-height: 1.25;
    font-weight: 650;
    color: #6b7280;
    background: #f9fafb;
  }

  .copy-tool:hover {
    background: #f3f4f6;
  }

  .backup-tool {
    margin-top: 11px;
    padding-top: 9px;
    border-top: 1px dashed #e5e7eb;
  }

  .backup-label {
    font-size: 10px;
    font-weight: 700;
    color: #9ca3af;
  }

  .backup-help {
    margin-top: 5px;
    font-size: 9.5px;
    line-height: 1.45;
    color: #9ca3af;
  }

  .danger { color: #b91c1c; }

  .divider {
    height: 1px;
    margin: 12px 0;
    background: #e5e7eb;
  }

  .tool-label {
    margin-top: 4px;
    font-size: 11px;
    font-weight: 700;
    color: #6b7280;
  }

  .help {
    margin-top: 10px;
    font-size: 11px;
    line-height: 1.6;
    color: #6b7280;
  }

  #toast {
    position: absolute;
    left: 0;
    bottom: 54px;
    min-width: 210px;
    max-width: 330px;
    padding: 9px 13px;
    border-radius: 9px;
    background: rgba(17,24,39,.95);
    color: #fff;
    font-size: 13px;
    opacity: 0;
    transform: translateY(5px);
    pointer-events: none;
    transition: opacity .15s, transform .15s;
  }

  #toast.show {
    opacity: 1;
    transform: translateY(0);
  }
</style>

<button id="main-button">＋ Anki 0</button>

<div id="panel">
  <!-- 全辺・四隅からリサイズ可能。スクロール領域の外に置く。 -->
  <div class="resize-handle resize-n" data-resize="n"></div>
  <div class="resize-handle resize-s" data-resize="s"></div>
  <div class="resize-handle resize-e" data-resize="e"></div>
  <div class="resize-handle resize-w" data-resize="w"></div>
  <div class="resize-handle resize-ne" data-resize="ne"></div>
  <div class="resize-handle resize-nw" data-resize="nw"></div>
  <div class="resize-handle resize-se" data-resize="se"></div>
  <div class="resize-handle resize-sw" data-resize="sw"></div>

  <div id="panel-content">
  <div class="header">
    <div class="title">Anki追加箱</div>
    <button id="close-panel">×</button>
  </div>

  <div class="count-row">
    この演習：<span id="candidate-count">0</span>件
    ／ 未書き出し <span id="unexported-count">0</span>件
    <span id="all-candidate-count"></span>
  </div>

  <div id="exercise-box" class="exercise-box">
    <div class="exercise-label">現在の演習</div>
    <div id="exercise-title">確認中</div>
    <div id="exercise-meta"></div>
    <div id="exercise-stats"></div>
  </div>

  <div id="previous-export-warning"></div>

  <div id="save-destination" class="destination-warning">
    <div class="destination-label">現在の保存先</div>
    <div id="save-destination-value">確認中</div>
    <div id="auto-subject-status">科目を確認しています…</div>
  </div>

  <button id="settings-toggle">
    <span id="settings-arrow">▶</span>
    <span id="settings-summary">設定</span>
  </button>

  <div id="settings-body">
    <label>出典</label>
    <select id="source">
      <option value="QB">QB</option>
      <option value="モントレ">モントレ</option>
      <option value="授業">授業</option>
      <option value="その他">その他</option>
    </select>

    <label>医学区分</label>
    <select id="division">
      <option value="基礎医学">基礎医学</option>
      <option value="臨床医学">臨床医学</option>
    </select>

    <label>科目</label>
    <input id="subject" placeholder="例：呼吸器">

    <label class="checkbox-row">
      <input id="auto-subject" type="checkbox" checked>
      <span>QBページから科目を自動判定する</span>
    </label>
    <div class="auto-subject-help">
      URLの selection / chapter_code と科目名を対応づけて追跡します。問題文の単語からは判定しません。
    </div>

    <button id="save-settings" class="primary">
      この設定を保存
    </button>
  </div>

  <div id="question-box">
    <div class="info-row">
      <div class="info-label">QB ID</div>
      <div id="qb-id" class="info-value">取得中</div>
    </div>

    <div class="info-row">
      <div class="info-label">問題番号</div>
      <div id="question-number" class="info-value">取得中</div>
    </div>

    <div class="info-row">
      <div class="info-label">次のID（通算）</div>
      <div>
        <div id="next-anki-id" class="info-value">取得中</div>
        <div id="manual-id-status" class="id-note"></div>
      </div>
    </div>
  </div>

  <label>覚えたいこと</label>
  <textarea
    id="memory-text"
    placeholder="例：アスベスト小体を画像で見分ける"
  ></textarea>
  <div class="memory-note">
    ※ 1行＝1候補。改行すると別のカード候補として保存されます。<br>
    ※ 未保存の内容がある状態で「次の問題」を押すと、自動保存してから進みます。
  </div>

  <label class="checkbox-row manual-auto-option">
    <input id="also-automatic" type="checkbox">
    <span>この問題は自動カードも作る</span>
  </label>
  <div class="manual-auto-help">
    通常はOFF。手動候補を1件でも作った問題は、△/×でも自動カードを作りません。必要なときだけON。
  </div>

  <button id="force-auto-current" class="secondary force-auto-button" type="button">
    ○・◎でもこの問題を自動カード化
  </button>
  <div class="force-auto-help">
    手動候補なしでも使えます。押した問題は評価に関係なく自動カードを1枚作成。もう一度押すと解除。
  </div>

  <label>画像・文字</label>

  <div id="drop-zone" tabindex="0" title="クリックしてから ⌘V / Ctrl+V でも貼り付けできます">
    画像や文字を<br>
    ドラッグ＆ドロップ<br><br>
    または<br>
    クリックして ⌘V / Ctrl+V で貼り付け<br>
    選択文字／画像上で ⌥A
  </div>

  <div id="image-preview-area"></div>

  <button id="save-candidate" class="primary">
    ＋ 候補に追加
  </button>

  <button id="capture-current" class="secondary">
    選択中の文字・画像を取り込む
  </button>

  <div class="candidate-section-title">
    <span>この演習の候補</span>
    <span id="current-list-count" class="candidate-section-count"></span>
  </div>
  <div id="current-candidate-list"></div>

  <div class="candidate-section-title">
    <span>○・◎でも自動カード指定</span>
    <span id="current-auto-count" class="candidate-section-count"></span>
  </div>
  <div id="current-auto-override-list"></div>

  <div class="candidate-section-title">
    <span>過去の演習</span>
    <span class="candidate-section-count">クリックで中身を確認</span>
  </div>
  <div id="exercise-history"></div>

  <div class="divider"></div>

  <div class="tool-label">ツール</div>

  <button id="run-qb-exporter" class="run-qb">
    QB全問＋手動候補を取得
  </button>

  <button id="export-json" class="secondary">
    この演習の候補JSONを書き出す
  </button>

  <button id="backup-all-json" class="secondary backup-all">
    全候補をバックアップ
  </button>

  <button id="delete-last" class="secondary">
    最後の1件を削除
  </button>

  <button id="clear-all" class="secondary danger">
    全履歴の候補をすべて削除
  </button>

  <div class="backup-tool">
    <div class="backup-label">予備：全問取得が動かないときだけ</div>
    <button id="copy-qb-exporter" class="secondary copy-tool">
      QB取得コードをコピー
    </button>
    <div class="backup-help">
      ① コピー → ② Chromeの開発者ツールでConsoleを開く → ③ 貼り付けてEnter → ④「取得開始」
    </div>
  </div>

  <div class="help">
    パネルの上下左右の辺・4隅をドラッグしてサイズ変更できる。右辺も含め、端にカーソルを合わせると掴める。<br>
    科目自動判定ONでは、selection / chapter_code を使って科目ページ→検索結果→問題画面まで追跡。判定不能時は黄色で警告。<br>
    同じchapter_codeの未完了演習は、quizへ入り直しても同じセッションを再利用します。「全問再復習」→全問取得でも候補は過去扱いになりません。<br>
    「QB全問＋手動候補を取得」で統合JSONを実際に保存すると、その演習を完了扱いにします。次回同じ科目を始めた時は新しいセッションになります。<br>
    手動候補がある問題は原則「手動のみ」。必要な問題だけ「この問題は自動カードも作る」をON。<br>
    ○・◎でも自動カードが欲しい問題は「○・◎でもこの問題を自動カード化」を押す。手動候補なしでも有効。<br>
    画像・文字はドラッグ＆ドロップのほか、ドロップ枠をクリックして ⌘V / Ctrl+V でも貼り付け可能。<br>
    「QB全問＋手動候補を取得」は、QB全問データとその範囲に対応する手動候補を1つのJSONに保存。<br>
    手動カードID：<b>qb:QBID:manual:連番</b><br>
    manual IDは重複防止のため通算。候補を削除しても番号は戻らない。
  </div>
  </div><!-- /#panel-content -->
</div>

<div id="toast"></div>
`;

    document.body.appendChild(host);

    bindUI();
    loadSettingsIntoUI();
    closeSettings();
    maybeAutoUpdateSubject({ silent: true });
    updateSettingsSummary();
    updateQuestionDisplay();
    renderSaveDestination();
    updateUI();

    // 保存済みのパネルサイズを復元し、全辺リサイズを有効化する。
    applySavedPanelGeometry();
    bindResizeHandles();
  }

  // =========================================================
  // UIイベント
  // =========================================================

  function bindUI() {
    shadow.getElementById("main-button").addEventListener("click", () => {
      shadow.getElementById("panel").classList.toggle("open");
      updateQuestionDisplay();
      updateSettingsSummary();
      updateUI();
    });

    shadow.getElementById("close-panel").addEventListener("click", closePanel);

    shadow.getElementById("settings-toggle").addEventListener("click", toggleSettings);
    shadow.getElementById("save-settings").addEventListener("click", saveSettingsFromUI);
    shadow.getElementById("save-candidate").addEventListener("click", saveDraftAsCandidates);

    shadow
      .getElementById("force-auto-current")
      .addEventListener(
        "click",
        toggleAutomaticOverrideForCurrentQuestion
      );

    shadow.getElementById("capture-current").addEventListener("click", captureCurrentToDraft);

    // QB Exporterを直接実行
    shadow
      .getElementById("run-qb-exporter")
      .addEventListener("click", runQBExporterCode);

    // 予備：従来どおりコードをコピー
    shadow
      .getElementById("copy-qb-exporter")
      .addEventListener("click", copyQBExporterCode);

    shadow.getElementById("export-json").addEventListener("click", exportJSON);
    shadow
      .getElementById("backup-all-json")
      .addEventListener("click", exportAllCandidatesBackup);
    shadow.getElementById("delete-last").addEventListener("click", deleteLastCandidate);
    shadow.getElementById("clear-all").addEventListener("click", clearAllCandidates);

    const dropZone = shadow.getElementById("drop-zone");

    dropZone.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });

    dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();

      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }

      dropZone.classList.add("dragging");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragging");
    });

    dropZone.addEventListener("drop", handleDrop);

    // 画像・文字のペースト対応。
    // ドロップゾーンをクリックして ⌘V / Ctrl+V。
    dropZone.addEventListener("paste", (event) => {
      handlePaste(event);
    });

    // パネル内で画像を貼り付けた場合も取り込む。
    // textarea/inputへの通常の文字貼り付けは邪魔しない。
    shadow.addEventListener("paste", (event) => {
      if (event.target === dropZone) return;

      const target = event.target;
      const isTextEditor =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        target?.isContentEditable;

      if (isTextEditor) return;

      const clipboard = event.clipboardData;
      const hasImageFile = [...(clipboard?.files || [])].some((file) =>
        file.type?.startsWith("image/")
      );

      const hasHtmlImage =
        Boolean(
          clipboard?.getData("text/html") &&
          extractImagesFromHTML(
            clipboard.getData("text/html")
          ).length
        );

      if (hasImageFile || hasHtmlImage) {
        handlePaste(event);
      }
    });
  }

  // =========================================================
  // QB 科目の自動判定
  // =========================================================

  const SUBJECT_DEFINITIONS = Object.freeze([
    { canonical: "細胞生物", aliases: ["細胞生物", "細胞生物学"] },
    { canonical: "組織・解剖", aliases: ["組織・解剖", "組織解剖", "組織学・解剖学"] },
    { canonical: "生理学", aliases: ["生理学", "生理"] },
    { canonical: "生化学", aliases: ["生化学"] },
    { canonical: "分子遺伝学", aliases: ["分子遺伝学", "分子生物学", "遺伝学", "分子・遺伝"] },
    { canonical: "発生学", aliases: ["発生学", "発生"] },
    { canonical: "免疫学", aliases: ["免疫学", "免疫"] },
    { canonical: "薬理学", aliases: ["薬理学", "薬理"] },
    { canonical: "微生物学", aliases: ["微生物学", "微生物"] },
    { canonical: "病理学", aliases: ["病理学", "病理"] },
    { canonical: "循環器", aliases: ["循環器", "循環器内科"] },
    { canonical: "呼吸器", aliases: ["呼吸器", "呼吸器内科"] },
    { canonical: "消化器", aliases: ["消化器", "消化器内科"] },
    { canonical: "腎・泌尿器", aliases: ["腎・泌尿器", "腎泌尿器", "腎臓・泌尿器", "腎臓", "泌尿器"] },
    { canonical: "血液", aliases: ["血液", "血液内科", "血液・造血器"] },
    { canonical: "内分泌・代謝", aliases: ["内分泌・代謝", "内分泌代謝", "内分泌", "代謝"] },
    { canonical: "神経", aliases: ["神経", "神経内科", "脳神経"] },
    { canonical: "精神", aliases: ["精神", "精神科"] },
    { canonical: "小児科", aliases: ["小児科", "小児"] },
    { canonical: "産婦人科", aliases: ["産婦人科", "産科・婦人科", "産科", "婦人科"] },
    { canonical: "整形外科", aliases: ["整形外科", "整形"] },
    { canonical: "皮膚科", aliases: ["皮膚科", "皮膚"] },
    { canonical: "眼科", aliases: ["眼科"] },
    { canonical: "耳鼻咽喉科", aliases: ["耳鼻咽喉科", "耳鼻科", "耳鼻咽喉"] },
    { canonical: "放射線科", aliases: ["放射線科", "放射線"] },
    { canonical: "救急", aliases: ["救急", "救急医学"] },
    { canonical: "麻酔科", aliases: ["麻酔科", "麻酔"] },
    { canonical: "感染症", aliases: ["感染症", "感染"] },
    { canonical: "リウマチ・膠原病", aliases: ["リウマチ・膠原病", "膠原病", "リウマチ"] }
  ]);

  function normalizeSubjectText(value) {
    return String(value || "")
      .replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, "")
      .replace(/[｜|]/g, "・")
      .trim();
  }

  function getSubjectMatches(text) {
    const normalized = normalizeSubjectText(text);
    if (!normalized) return [];
    const found = [];

    for (const definition of SUBJECT_DEFINITIONS) {
      for (const alias of definition.aliases) {
        const normalizedAlias = normalizeSubjectText(alias);
        const exact = normalized === normalizedAlias;
        const safeContains = normalizedAlias.length >= 3 && normalized.length <= 48 && normalized.includes(normalizedAlias);
        if (exact || safeContains) {
          found.push({ subject: definition.canonical, alias, exact });
          break;
        }
      }
    }
    return found;
  }

  function detectDivisionFromText(text) {
    const normalized = normalizeSubjectText(text);
    if (normalized.includes("基礎医学")) return "基礎医学";
    if (normalized.includes("臨床医学")) return "臨床医学";
    return null;
  }

  function getStructuralSubjectCandidates() {
    const candidates = [];
    const addElements = (selector, score, source) => {
      let elements = [];
      try { elements = [...document.querySelectorAll(selector)]; } catch (_) { return; }
      for (const element of elements) {
        const raw = String(element.innerText || element.textContent || element.getAttribute?.("aria-label") || "").trim();
        if (!raw || raw.length > 160) continue;
        for (const match of getSubjectMatches(raw)) {
          candidates.push({ ...match, division: detectDivisionFromText(raw), score: score + (match.exact ? 20 : 0), source, evidence: raw.slice(0,160) });
        }
      }
    };

    addElements("h1", 120, "h1");
    addElements("h2", 110, "h2");
    addElements("h3", 100, "h3");
    addElements("[aria-current='page']", 115, "aria-current");
    addElements("[class*='breadcrumb']", 105, "breadcrumb");
    addElements("[class*='Breadcrumb']", 105, "breadcrumb");
    addElements("main [data-testid*='subject']", 100, "data-testid");
    addElements("main [class*='subject']", 85, "subject-class");

    try {
      const bodyText = String(document.body?.innerText || "");
      for (const match of bodyText.matchAll(/(?:科目|診療科|分野|領域)\s*[：:]\s*([^\n]{1,40})/g)) {
        const raw = String(match[1] || "").trim();
        for (const subjectMatch of getSubjectMatches(raw)) {
          candidates.push({
            ...subjectMatch,
            division: detectDivisionFromText(match[0] + "\n" + bodyText.slice(Math.max(0, match.index - 120), Math.min(bodyText.length, match.index + 160))),
            score: 130 + (subjectMatch.exact ? 20 : 0),
            source: "labelled-text",
            evidence: match[0].slice(0,160)
          });
        }
      }
    } catch (_) {}
    return candidates;
  }

  function chooseBestSubjectCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const sorted = [...candidates].sort((a,b) => b.score - a.score);
    const bestScore = sorted[0].score;
    const top = sorted.filter(c => c.score === bestScore);
    const subjects = [...new Set(top.map(c => c.subject))];
    if (subjects.length !== 1) return null;
    return top.find(c => c.subject === subjects[0]) || null;
  }

  function isQBSubjectPage() {
    try {
      return location.pathname.includes("/view/subject");
    } catch (_) {
      return false;
    }
  }

  function isQBSearchPage() {
    try {
      return location.pathname.includes("/search");
    } catch (_) {
      return false;
    }
  }

  function isQBQuizPage() {
    try {
      return location.pathname.includes("/quiz");
    } catch (_) {
      return false;
    }
  }

  function normalizeChapterCode(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
  }

  function getUrlParam(name) {
    try {
      return new URL(location.href).searchParams.get(name) || null;
    } catch (_) {
      return null;
    }
  }

  function getCurrentChapterCode() {
    return (
      normalizeChapterCode(
        getUrlParam("selection") ||
        getUrlParam("chapter_code") ||
        ""
      ) || null
    );
  }

  function getSubjectCodeMap() {
    const value = GM_getValue(SUBJECT_CODE_MAP_KEY, {});
    return value && typeof value === "object" ? value : {};
  }

  function saveSubjectCodeMap(map) {
    GM_setValue(
      SUBJECT_CODE_MAP_KEY,
      map && typeof map === "object" ? map : {}
    );
  }

  function canonicalizeSubjectLabel(label) {
    const cleaned = String(label || "")
      .replace(/\(\s*\d+\s*\)\s*$/, "")
      .replace(/全体達成度.*$/i, "")
      .trim();

    if (!cleaned) return null;

    const matches = getSubjectMatches(cleaned);
    if (matches.length > 0) {
      return matches[0].subject;
    }

    return cleaned.length <= 40 ? cleaned : null;
  }

  function extractLabelForCode(code, rawText) {
    const normalizedCode = normalizeChapterCode(code);
    if (!normalizedCode) return null;

    const escaped = normalizedCode.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    const lineRe = new RegExp(
      "^" +
      escaped +
      "\\s+(.+?)(?:\\s*\\(\\s*\\d+\\s*\\))?$",
      "i"
    );

    const lines = String(rawText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const match = line.match(lineRe);
      if (!match) continue;

      const subject = canonicalizeSubjectLabel(match[1]);

      if (subject) {
        return {
          subject,
          evidence: line
        };
      }
    }

    return null;
  }

  function detectPageDivision() {
    const bodyText = String(document.body?.innerText || "");

    if (/vol\.\s*1[^\n]{0,40}基礎医学/i.test(bodyText)) {
      return "基礎医学";
    }

    if (/vol\.\s*[2-9][^\n]{0,40}臨床医学/i.test(bodyText)) {
      return "臨床医学";
    }

    /*
     * 詳細ページではvol表記が上部に残っていない場合がある。
     * その場合のみ先頭付近の明示ラベルを使う。
     */
    const head = bodyText.slice(0, 2500);

    if (head.includes("基礎医学")) return "基礎医学";
    if (head.includes("臨床医学")) return "臨床医学";

    return null;
  }

  function learnSubjectCodeMapFromPage() {
    if (!isQBSubjectPage()) return;

    const map = getSubjectCodeMap();
    const division = detectPageDivision();
    let changed = false;

    /*
     * 実際の一覧画面では各行が
     * /view/subject?selection=1H
     * のようなリンクになっている。
     */
    const links = [
      ...document.querySelectorAll(
        'a[href*="selection="], [href*="selection="]'
      )
    ];

    for (const link of links) {
      let url;

      try {
        url = new URL(
          link.getAttribute("href") || "",
          location.href
        );
      } catch (_) {
        continue;
      }

      const code = normalizeChapterCode(
        url.searchParams.get("selection") || ""
      );

      if (!code) continue;

      const possibleTexts = [
        link.innerText,
        link.textContent,
        link.parentElement?.innerText,
        link.closest?.("div")?.innerText
      ];

      let found = null;

      for (const candidateText of possibleTexts) {
        found = extractLabelForCode(code, candidateText);
        if (found) break;
      }

      if (!found?.subject) continue;

      const next = {
        subject: found.subject,
        division: division || map[code]?.division || null,
        evidence: found.evidence,
        learnedFrom: "subject-list",
        learnedAt: Date.now()
      };

      const previous = map[code];

      if (
        !previous ||
        previous.subject !== next.subject ||
        previous.division !== next.division
      ) {
        map[code] = next;
        changed = true;
      }
    }

    /*
     * /view/subject?selection=1H のような詳細画面。
     * 画面内の「1H 免疫」から直接対応を覚える。
     */
    const currentCode = getCurrentChapterCode();

    if (currentCode) {
      const direct = extractLabelForCode(
        currentCode,
        String(document.body?.innerText || "")
      );

      if (direct?.subject) {
        const next = {
          subject: direct.subject,
          division: division || map[currentCode]?.division || null,
          evidence: direct.evidence,
          learnedFrom: "selected-subject-page",
          learnedAt: Date.now()
        };

        const previous = map[currentCode];

        if (
          !previous ||
          previous.subject !== next.subject ||
          previous.division !== next.division
        ) {
          map[currentCode] = next;
          changed = true;
        }
      }
    }

    if (changed) {
      saveSubjectCodeMap(map);
    }
  }

  function getMappedSubjectByCode(code) {
    const normalizedCode = normalizeChapterCode(code);
    if (!normalizedCode) return null;

    const map = getSubjectCodeMap();
    const found = map[normalizedCode];

    if (!found?.subject) return null;

    return {
      status: "coded",
      code: normalizedCode,
      subject: found.subject,
      division: found.division || null,
      source: found.learnedFrom || "subject-code-map",
      evidence: found.evidence || null
    };
  }

  function rememberDetectedSubject(
    detected,
    source = "subject-code"
  ) {
    if (!detected?.subject) return;

    saveAutoSubjectContext({
      subject: detected.subject,
      division: detected.division || null,
      evidence: detected.evidence || null,
      source,
      sourceUrl: location.href,
      chapterCode:
        detected.code ||
        getCurrentChapterCode() ||
        null,
      detectedAt: Date.now()
    });
  }

  function getRecentSubjectContext() {
    const saved = getAutoSubjectContext();

    if (!saved?.subject) return null;

    const ageMs =
      saved.detectedAt
        ? Date.now() - Number(saved.detectedAt)
        : Number.POSITIVE_INFINITY;

    if (ageMs < 0 || ageMs > 18 * 60 * 60 * 1000) {
      return null;
    }

    return saved;
  }

  function detectCurrentCodeDirectlyFromVisiblePage(code) {
    if (!code) return null;

    const direct = extractLabelForCode(
      code,
      String(document.body?.innerText || "")
    );

    if (!direct?.subject) return null;

    return {
      status: "coded",
      code,
      subject: direct.subject,
      division: detectPageDivision(),
      source: "visible-code-label",
      evidence: direct.evidence
    };
  }

  function detectSubjectContextFromPage() {
    /*
     * 実画面の遷移:
     * /view/subject?selection=1H
     *   ↓
     * /search?chapter_code=1H&...
     *   ↓
     * /quiz?question_id=...
     */

    if (isQBSubjectPage()) {
      learnSubjectCodeMapFromPage();
    }

    const code = getCurrentChapterCode();

    if (code) {
      let detected = getMappedSubjectByCode(code);

      if (!detected && isQBSubjectPage()) {
        detected =
          detectCurrentCodeDirectlyFromVisiblePage(code);

        if (detected?.subject) {
          const map = getSubjectCodeMap();

          map[code] = {
            subject: detected.subject,
            division: detected.division || null,
            evidence: detected.evidence || null,
            learnedFrom: "visible-code-label",
            learnedAt: Date.now()
          };

          saveSubjectCodeMap(map);
        }
      }

      if (detected?.subject) {
        rememberDetectedSubject(
          detected,
          isQBSearchPage()
            ? "search-chapter-code"
            : "subject-selection-code"
        );

        return detected;
      }

      return {
        status: "unresolved",
        code,
        subject: null,
        division: null,
        source: "unknown-chapter-code",
        evidence: null
      };
    }

    if (isQBQuizPage()) {
      const saved = getRecentSubjectContext();

      if (saved) {
        return {
          status: "inherited",
          code: saved.chapterCode || null,
          subject: saved.subject,
          division: saved.division || null,
          source: "quiz-inherited-context",
          evidence: saved.evidence || null
        };
      }

      return {
        status: "unresolved",
        code: null,
        subject: null,
        division: null,
        source: "quiz-no-context",
        evidence: null
      };
    }

    /*
     * selectionなしの科目一覧では辞書だけ学習する。
     * ここで保存先は勝手に変えない。
     */
    return {
      status: "unresolved",
      code: null,
      subject: null,
      division: null,
      source: "no-active-subject-code",
      evidence: null
    };
  }

  function syncSettingsControls(settings = getSettings()) {
    if (!shadow) return;
    const source = shadow.getElementById("source");
    const division = shadow.getElementById("division");
    const subject = shadow.getElementById("subject");
    const autoSubject = shadow.getElementById("auto-subject");

    if (source && [...source.options].some(o => o.value === settings.source)) source.value = settings.source;
    if (division && [...division.options].some(o => o.value === settings.division)) division.value = settings.division;
    if (subject) subject.value = settings.subject || "";
    if (autoSubject) autoSubject.checked = settings.autoSubject !== false;
  }

  function renderSaveDestination() {
    if (!shadow) return;
    const settings = getSettings();
    const box = shadow.getElementById("save-destination");
    const value = shadow.getElementById("save-destination-value");
    const status = shadow.getElementById("auto-subject-status");
    if (!box || !value || !status) return;

    value.textContent = `${settings.division} ＞ ${settings.subject || "科目未設定"}`;
    box.classList.remove("destination-ok", "destination-warning", "destination-manual");

    if (settings.autoSubject === false) {
      box.classList.add("destination-manual");
      status.textContent = "科目自動判定：OFF（手動設定を使用）";
    } else if (
      subjectDetectionState.status === "coded" ||
      subjectDetectionState.status === "inherited"
    ) {
      box.classList.add("destination-ok");

      if (subjectDetectionState.status === "coded") {
        status.textContent =
          subjectDetectionState.code
            ? `URLコード ${subjectDetectionState.code} → ${subjectDetectionState.subject}`
            : `自動判定：${subjectDetectionState.subject}`;
      } else {
        status.textContent =
          subjectDetectionState.code
            ? `問題画面へ引継ぎ：${subjectDetectionState.code} → ${subjectDetectionState.subject}`
            : `問題画面へ引継ぎ：${subjectDetectionState.subject}`;
      }
    } else {
      box.classList.add("destination-warning");
      status.textContent = "科目を自動判定できません。現在の設定が正しいか確認してください。";
    }
  }

  function maybeAutoUpdateSubject(options = {}) {
    const { silent = false } = options;
    const settings = getSettings();

    if (settings.autoSubject === false) {
      subjectDetectionState = { status: "manual", subject: settings.subject || null, division: settings.division || null, source: "manual", evidence: null };
      renderSaveDestination();
      return subjectDetectionState;
    }

    const detected = detectSubjectContextFromPage();
    subjectDetectionState = detected;

    if (detected.subject) {
      const update = {};
      if (detected.subject !== settings.subject) update.subject = detected.subject;
      if (detected.division && detected.division !== settings.division) update.division = detected.division;

      if (Object.keys(update).length > 0) {
        const beforeSubject = settings.subject || "未設定";
        saveSettings(update);
        syncSettingsControls(getSettings());
        const toastKey = `${beforeSubject}->${detected.subject}|${detected.division || ""}`;
        if (!silent && toastKey !== lastAutoSubjectToastKey) {
          lastAutoSubjectToastKey = toastKey;
          toast(beforeSubject === "未設定" ? `科目を自動設定：${detected.subject}` : `科目を自動変更：${beforeSubject} → ${detected.subject}`);
        }
      }
    }

    renderSaveDestination();
    return subjectDetectionState;
  }

  // =========================================================
  // 設定
  // =========================================================

  function toggleSettings() {
    const body = shadow.getElementById("settings-body");
    body.classList.contains("open") ? closeSettings() : openSettings();
  }

  function openSettings() {
    if (!shadow) return;

    shadow.getElementById("settings-body").classList.add("open");
    shadow.getElementById("settings-arrow").textContent = "▼";
    loadSettingsIntoUI();
  }

  function closeSettings() {
    if (!shadow) return;

    shadow.getElementById("settings-body").classList.remove("open");
    shadow.getElementById("settings-arrow").textContent = "▶";
  }

  function updateSettingsSummary() {
    if (!shadow) return;

    const settings = getSettings();
    const summary = shadow.getElementById("settings-summary");
    if (!summary) return;

    summary.textContent = settings.subject
      ? `設定　${settings.source}・${settings.division}・${settings.subject}` +
        (settings.autoSubject ? "・自動" : "・手動")
      : "設定　科目未設定";
  }

  function saveSettingsFromUI() {
    const source = shadow.getElementById("source").value;
    const division = shadow.getElementById("division").value;
    const subject = shadow.getElementById("subject").value.trim();
    const autoSubject = shadow.getElementById("auto-subject")?.checked !== false;

    if (!subject) {
      toast("科目を入力してください");
      return;
    }

    saveSettings({ source, division, subject, autoSubject });
    closeSettings();
    if (autoSubject) {
      /*
       * 自動判定ONでも、ユーザーが手動で保存した科目は
       * quiz画面へ入るための安全な初期値として覚えておく。
       */
      saveAutoSubjectContext({
        subject,
        division,
        evidence: "manual-settings",
        source: "manual-settings",
        sourceUrl: location.href,
        chapterCode: getCurrentChapterCode(),
        detectedAt: Date.now()
      });

      maybeAutoUpdateSubject({ silent: true });
    } else {
      subjectDetectionState = { status: "manual", subject, division, source: "manual", evidence: null };
      renderSaveDestination();
    }
    toast(autoSubject ? `${source} / ${subject} に設定（自動判定ON）` : `${source} / ${subject} に設定（自動判定OFF）`);
  }

  function loadSettingsIntoUI() {
    if (!shadow) return;
    syncSettingsControls(getSettings());
  }

  // =========================================================
  // ID表示
  // =========================================================

  function getManualIdStats(qbId) {
    if (!qbId) {
      return {
        activeCount: 0,
        issuedCount: 0
      };
    }

    const activeCount = getItems().filter(
      (item) =>
        String(item?.sourceProblem?.qbId || "") === String(qbId)
    ).length;

    const counters = getManualCounters();
    const issuedCount = Number(counters[qbId] || 0);

    return {
      activeCount,
      issuedCount
    };
  }

  function updateQuestionDisplay() {
    if (!shadow) return;

    const info = getCurrentQuestionInfo();

    const idElement = shadow.getElementById("qb-id");
    const numberElement = shadow.getElementById("question-number");
    const nextIdElement = shadow.getElementById("next-anki-id");
    const manualIdStatusElement =
      shadow.getElementById("manual-id-status");

    if (!idElement) return;

    if (info.qbId) {
      idElement.textContent = info.qbId;
      idElement.className = "info-value id-found";
    } else {
      idElement.textContent = "未取得";
      idElement.className = "info-value id-missing";
    }

    if (numberElement) {
      numberElement.textContent =
        info.displayQuestionNumber || "未取得";
    }

    if (nextIdElement) {
      const settings = getSettings();

      nextIdElement.textContent =
        settings.source === "QB" && info.qbId
          ? peekNextManualAnkiId(info.qbId)
          : "—";

      if (manualIdStatusElement) {
        if (settings.source === "QB" && info.qbId) {
          const stats = getManualIdStats(info.qbId);
          manualIdStatusElement.textContent =
            `現在候補 ${stats.activeCount}件 ／ ` +
            `これまでに発行 ${stats.issuedCount}件`;
        } else {
          manualIdStatusElement.textContent = "";
        }
      }
    }
  }

  // =========================================================
  // 画像プレビュー
  // =========================================================

  function renderImagePreviews() {
    if (!shadow) return;

    const area = shadow.getElementById("image-preview-area");
    area.innerHTML = "";

    stagedImages.forEach((image, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "preview";

      const img = document.createElement("img");
      img.src = image.dataUrl || image.src || "";

      const removeButton = document.createElement("button");
      removeButton.className = "remove-image";
      removeButton.textContent = "×";

      removeButton.addEventListener("click", () => {
        stagedImages.splice(index, 1);
        renderImagePreviews();
      });

      wrapper.appendChild(img);
      wrapper.appendChild(removeButton);
      area.appendChild(wrapper);
    });
  }

  // =========================================================
  // 演習・候補一覧表示
  // =========================================================

  function buildCandidateCard(item) {
    const card = document.createElement("div");
    card.className = "candidate-card";

    const top = document.createElement("div");
    top.className = "candidate-top";

    const main = document.createElement("div");
    main.className = "candidate-main";

    const textEl = document.createElement("div");
    textEl.className = "candidate-text";
    textEl.textContent =
      String(item?.rawText || "").trim() ||
      (item?.images?.length ? "画像のみの候補" : "内容なし");

    const meta = document.createElement("div");
    meta.className = "candidate-meta";

    const problem =
      item?.sourceProblem?.displayQuestionNumber ||
      (item?.sourceProblem?.qbId
        ? `QB ID ${item.sourceProblem.qbId}`
        : "問題番号不明");

    meta.textContent =
      `${problem}` +
      (item?.ankiId ? ` ／ ${item.ankiId}` : "");

    const badges = document.createElement("div");
    badges.className = "candidate-badges";

    const policy = document.createElement("span");
    policy.className = "candidate-badge";
    policy.textContent =
      item?.alsoCreateAutomatic
        ? "手動＋自動"
        : "手動のみ";
    badges.appendChild(policy);

    if ((item?.images || []).length > 0) {
      const imageBadge = document.createElement("span");
      imageBadge.className = "candidate-badge";
      imageBadge.textContent =
        `画像 ${(item.images || []).length}枚`;
      badges.appendChild(imageBadge);
    }

    const exportBadge = document.createElement("span");
    exportBadge.className =
      "candidate-badge " +
      (item?.exportedAt ? "exported" : "pending");

    exportBadge.textContent = item?.exportedAt
      ? `書き出し済 ${formatLocalDateTime(item.exportedAt)}`
      : "未書き出し";

    badges.appendChild(exportBadge);

    main.appendChild(textEl);
    main.appendChild(meta);
    main.appendChild(badges);

    const deleteButton = document.createElement("button");
    deleteButton.className = "candidate-delete";
    deleteButton.type = "button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteCandidateByCaptureId(item?.captureId);
    });

    top.appendChild(main);
    top.appendChild(deleteButton);
    card.appendChild(top);

    return card;
  }

  function buildAutomaticOverrideCard(entry, sessionId) {
    const card = document.createElement("div");
    card.className = "candidate-card";

    const top = document.createElement("div");
    top.className = "candidate-top";

    const main = document.createElement("div");
    main.className = "candidate-main";

    const title = document.createElement("div");
    title.className = "candidate-text";
    title.textContent =
      entry?.displayQuestionNumber
        ? `自動カード化：${entry.displayQuestionNumber}`
        : `自動カード化：QB ID ${entry?.qbId || "不明"}`;

    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    meta.textContent =
      `QB ID ${entry?.qbId || "不明"}` +
      (entry?.addedAt
        ? ` ／ 指定 ${formatLocalDateTime(entry.addedAt)}`
        : "");

    const badges = document.createElement("div");
    badges.className = "candidate-badges";

    const badge = document.createElement("span");
    badge.className = "candidate-badge exported";
    badge.textContent = "○・◎でも自動";
    badges.appendChild(badge);

    main.appendChild(title);
    main.appendChild(meta);
    main.appendChild(badges);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "candidate-delete";
    remove.textContent = "解除";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeAutomaticOverride(sessionId, entry?.qbId);
    });

    top.appendChild(main);
    top.appendChild(remove);
    card.appendChild(top);

    return card;
  }

  function renderAutomaticOverrideButton() {
    if (!shadow) return;

    const button =
      shadow.getElementById("force-auto-current");
    if (!button) return;

    const question = getCurrentQuestionInfo();

    const active =
      Boolean(question.qbId) &&
      isAutomaticOverrideEnabledForQbId(question.qbId);

    button.classList.toggle("active", active);
    button.textContent = active
      ? "✓ ○・◎でも自動カード化する"
      : "○・◎でもこの問題を自動カード化";

    button.disabled = !question.qbId || !isQBQuizPage();
  }

  function renderCurrentAutomaticOverrideList() {
    if (!shadow) return;

    const list =
      shadow.getElementById("current-auto-override-list");
    const count =
      shadow.getElementById("current-auto-count");

    if (!list) return;

    const session = getActiveExerciseSession();
    const entries = session
      ? getAutomaticOverridesForSession(session.id)
      : [];

    list.innerHTML = "";

    if (count) {
      count.textContent = `${entries.length}問`;
    }

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "candidate-empty";
      empty.textContent =
        "○・◎でも自動カード化する問題はまだ指定していません。";
      list.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      list.appendChild(
        buildAutomaticOverrideCard(entry, session?.id)
      );
    }
  }

  function renderCurrentCandidateList() {
    if (!shadow) return;

    const list = shadow.getElementById(
      "current-candidate-list"
    );
    const count = shadow.getElementById(
      "current-list-count"
    );

    if (!list) return;

    const items = getCurrentSessionItems();

    list.innerHTML = "";

    if (count) {
      count.textContent =
        `${items.length}件 ／ 未書き出し ${countUnexported(items)}件`;
    }

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "candidate-empty";
      empty.textContent =
        "この演習では、まだ手動候補を追加していません。";
      list.appendChild(empty);
      return;
    }

    for (const item of items) {
      list.appendChild(buildCandidateCard(item));
    }
  }

  function renderExerciseHistory() {
    if (!shadow) return;

    const container = shadow.getElementById(
      "exercise-history"
    );

    if (!container) return;

    const currentScope = getCurrentScopeKey();
    const groups = getCandidateGroups().filter(
      (group) => group.scopeKey !== currentScope
    );

    container.innerHTML = "";

    if (groups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "candidate-empty";
      empty.textContent = "過去の候補はありません。";
      container.appendChild(empty);
      return;
    }

    for (const group of groups) {
      const details = document.createElement("details");
      details.className = "history-group";

      const summary = document.createElement("summary");

      const meta = group.meta || {};
      const unexported = countUnexported(group.items);
      const code = meta.chapterCode
        ? ` ${meta.chapterCode}`
        : "";
      const legacy = meta.legacy ? "・旧候補" : "";

      const sessionState =
        group.meta?.sessionId
          ? getExerciseState().sessions?.[group.meta.sessionId]
          : null;

      summary.textContent =
        `${meta.subject || "科目不明"}${code}` +
        `｜${formatLocalDateTime(meta.startedAt)}` +
        `｜${group.items.length}件` +
        (unexported > 0
          ? `｜⚠ 未書き出し${unexported}`
          : "｜✓ 書き出し済み") +
        (sessionState
          ? (
              isSessionCompleted(sessionState)
                ? "｜完了"
                : "｜未完了"
            )
          : "") +
        legacy;

      const body = document.createElement("div");
      body.className = "history-body";

      const exportButton = document.createElement("button");
      exportButton.className =
        "secondary history-export";
      exportButton.type = "button";
      exportButton.textContent =
        "この演習の候補JSONを書き出す";

      exportButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        exportCandidateScope(
          group.scopeKey,
          "manual_history_json"
        );
      });

      body.appendChild(exportButton);

      const historicalOverrides =
        getAutomaticOverridesForScope(group.scopeKey);

      for (const entry of historicalOverrides) {
        body.appendChild(
          buildAutomaticOverrideCard(
            entry,
            group.meta?.sessionId
          )
        );
      }

      for (const item of group.items) {
        body.appendChild(buildCandidateCard(item));
      }

      details.appendChild(summary);
      details.appendChild(body);
      container.appendChild(details);
    }
  }

  function renderExerciseSummary() {
    if (!shadow) return;

    const session = getActiveExerciseSession();
    const items = getCurrentSessionItems();

    const title = shadow.getElementById("exercise-title");
    const meta = shadow.getElementById("exercise-meta");
    const stats = shadow.getElementById("exercise-stats");
    const warning = shadow.getElementById(
      "previous-export-warning"
    );

    if (title) {
      title.textContent = session
        ? `${session.division || ""} ＞ ${session.subject || "科目不明"}`
        : "演習セッション未開始";
    }

    if (meta) {
      meta.textContent = session
        ? [
            session.chapterCode
              ? `コード ${session.chapterCode}`
              : null,
            `開始 ${formatLocalDateTime(session.startedAt)}`,
            isSessionCompleted(session)
              ? `完了 ${formatLocalDateTime(session.completedAt)}`
              : "未完了"
          ]
            .filter(Boolean)
            .join(" ／ ")
        : "QBの問題演習に入ると自動的に新しいセッションを開始します。";
    }

    if (stats) {
      stats.textContent = session
        ? `手動候補 ${items.length}件 ／ 未書き出し ${countUnexported(items)}件` +
          ` ／ ○・◎自動指定 ${getAutomaticOverridesForSession(session.id).length}問`
        : "";
    }

    if (warning) {
      const state = getExerciseState();
      const warningId = state.warningSessionId;
      const warningSession = warningId
        ? state.sessions[warningId]
        : null;
      const warningItems = warningId
        ? getItemsForSession(warningId)
        : [];
      const pending = countUnexported(warningItems);

      if (warningSession && pending > 0) {
        warning.classList.add("show");
        warning.textContent =
          `⚠ 前の演習「${warningSession.subject || "科目不明"}」に ` +
          `未書き出し候補が${pending}件あります。` +
          ` 下の「過去の演習」から内容を確認・書き出しできます。`;
      } else {
        warning.classList.remove("show");
        warning.textContent = "";
      }
    }
  }

  // =========================================================
  // パネル・表示
  // =========================================================

  function openPanel() {
    if (!shadow) return;

    shadow.getElementById("panel").classList.add("open");
    maybeAutoUpdateSubject({ silent: true });
    updateQuestionDisplay();
    updateSettingsSummary();
    renderSaveDestination();
    renderExerciseSummary();
    renderCurrentCandidateList();
    renderAutomaticOverrideButton();
    renderCurrentAutomaticOverrideList();
    renderExerciseHistory();
    applySavedPanelGeometry();
  }

  function closePanel() {
    if (!shadow) return;
    shadow.getElementById("panel").classList.remove("open");
  }

  function updateUI() {
    if (!shadow) return;

    const allItems = getItems();
    const currentItems = getCurrentSessionItems();
    const settings = getSettings();
    const session = getActiveExerciseSession();

    const count = shadow.getElementById("candidate-count");
    const unexportedCount =
      shadow.getElementById("unexported-count");
    const allCount =
      shadow.getElementById("all-candidate-count");
    const mainButton = shadow.getElementById("main-button");

    if (count) {
      count.textContent = String(currentItems.length);
    }

    if (unexportedCount) {
      unexportedCount.textContent =
        String(countUnexported(currentItems));
    }

    if (allCount) {
      allCount.textContent =
        allItems.length > currentItems.length
          ? ` ／ 全履歴 ${allItems.length}件`
          : "";
    }

    if (mainButton) {
      const subject =
        session?.subject ||
        settings.subject ||
        "";

      const pending = countUnexported(currentItems);

      mainButton.textContent =
        `＋ Anki ${subject ? subject + " " : ""}` +
        `${currentItems.length}` +
        (pending > 0 ? `｜未出${pending}` : "");
    }

    updateSettingsSummary();
    updateQuestionDisplay();
    renderSaveDestination();
    renderExerciseSummary();
    renderCurrentCandidateList();
    renderAutomaticOverrideButton();
    renderCurrentAutomaticOverrideList();
    renderExerciseHistory();
  }

  function toast(message) {
    if (!shadow) return;

    const element = shadow.getElementById("toast");
    if (!element) return;

    element.textContent = message;
    element.classList.add("show");

    if (toastTimer) clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      element.classList.remove("show");
    }, 1800);
  }

  // =========================================================
  // 科目コードを画面遷移の直前にも記憶
  // =========================================================

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (isQBSubjectPage()) {
        learnSubjectCodeMapFromPage();
      }

      const link = target.closest('a[href*="selection="]');

      if (link) {
        try {
          const url = new URL(
            link.getAttribute("href") || "",
            location.href
          );

          const code = normalizeChapterCode(
            url.searchParams.get("selection") || ""
          );

          const detected = getMappedSubjectByCode(code);

          if (detected?.subject) {
            rememberDetectedSubject(
              detected,
              "subject-link-click"
            );
          }
        } catch (_) {}
      }

      if (isQBSearchPage()) {
        const code = getCurrentChapterCode();
        const detected = getMappedSubjectByCode(code);

        if (detected?.subject) {
          rememberDetectedSubject(
            detected,
            "search-start-click"
          );
        }
      }
    },
    true
  );

  // =========================================================
  // QB「次の問題」へ進む前の自動保存
  // =========================================================

  const nextNavigationBypass = new WeakSet();

  function normalizePageControlLabel(element) {
    return String(
      element?.innerText ||
      element?.textContent ||
      element?.value ||
      element?.getAttribute?.("aria-label") ||
      ""
    )
      .replace(/[\s\u200b-\u200d\ufeff]+/g, "")
      .trim();
  }

  function getNextQuestionControlFromEvent(event) {
    const target = event.target;

    if (!(target instanceof Element)) return null;

    const control = target.closest(
      "button, a, [role='button'], input[type='button'], input[type='submit']"
    );

    if (!control) return null;

    const label = normalizePageControlLabel(control);

    const isNextQuestion =
      label === "次の問題" ||
      label === "次の問題へ" ||
      label === "スキップして次へ" ||
      label.includes("次の問題");

    return isNextQuestion ? control : null;
  }

  function continueOriginalNextNavigation(control) {
    if (!control || !document.contains(control)) {
      toast("保存は完了しましたが、次の問題ボタンを再取得できませんでした");
      return;
    }

    nextNavigationBypass.add(control);

    try {
      control.click();
    } finally {
      queueMicrotask(() => {
        nextNavigationBypass.delete(control);
      });
    }
  }

  document.addEventListener(
    "click",
    (event) => {
      const control = getNextQuestionControlFromEvent(event);
      if (!control) return;

      // 自動保存後にこちらから再実行したクリックはそのまま通す。
      if (nextNavigationBypass.has(control)) {
        nextNavigationBypass.delete(control);
        return;
      }

      // 何も未保存でなければ通常どおり進む。
      if (!hasUnsavedDraft()) return;

      // 問題が切り替わる前に、現在のQB IDで保存する。
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const result = saveDraftAsCandidates({
        silentWhenEmpty: true,
        autoSave: true
      });

      // 保存に失敗した場合は次へ進ませない。
      if (!result.ok) {
        toast("保存できなかったため、次の問題へは進みません");
        return;
      }

      continueOriginalNextNavigation(control);
    },
    true
  );

  // =========================================================
  // Option + A
  // =========================================================

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === "KeyA"
      ) {
        const target = event.target;

        const typing =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target?.isContentEditable;

        if (typing) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        captureCurrentToDraft();
      }
    },
    true
  );

  // =========================================================
  // SPA対策
  // =========================================================

  function monitorPage() {
    if (location.href !== lastUrl) {
      const previousUrl = lastUrl;
      lastUrl = location.href;

      stagedImages = [];
      lastSelectedText = "";
      hoveredImage = null;

      if (shadow) {
        const textarea = shadow.getElementById("memory-text");
        if (textarea) textarea.value = "";

        const alsoAutomaticCheckbox =
          shadow.getElementById("also-automatic");
        if (alsoAutomaticCheckbox) {
          alsoAutomaticCheckbox.checked = false;
        }
      }

      renderImagePreviews();

      if (isQBSubjectPage()) {
        learnSubjectCodeMapFromPage();
      }
      setTimeout(() => {
        maybeAutoUpdateSubject({ silent: false });

        // /search や科目画面から /quiz に戻っても、
        // 同じchapter_codeの未完了セッションがあれば再利用する。
        // 「全問再復習」→全問取得のための入り直しも同じ演習扱い。
        if (isQBQuizPage()) {
          ensureActiveExerciseSession();
        }

        updateQuestionDisplay();
        renderSaveDestination();
        updateUI();
      }, 350);
      setTimeout(() => {
        maybeAutoUpdateSubject({ silent: false });
        renderSaveDestination();
      }, 1200);
    }

    if (!document.getElementById(ROOT_ID)) {
      createUI();
    }

    /*
     * 科目ページではDOMの遅延描画に備えて再判定。
     * quizでは保存済みコンテキストを読むだけなので安全。
     */
    if (
      isQBSubjectPage() ||
      isQBSearchPage() ||
      isQBQuizPage()
    ) {
      maybeAutoUpdateSubject({ silent: true });
    }

    if (isQBQuizPage()) {
      ensureActiveExerciseSession();
    }

    updateQuestionDisplay();
    renderSaveDestination();
    renderExerciseSummary();
  }

  // =========================================================
  // 起動
  // =========================================================

  function start() {
    createUI();
    closeSettings();

    if (isQBQuizPage()) {
      setTimeout(() => {
        maybeAutoUpdateSubject({ silent: true });
        ensureActiveExerciseSession();
        updateUI();
      }, 500);
    }

    setInterval(monitorPage, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
