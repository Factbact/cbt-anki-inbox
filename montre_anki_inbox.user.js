// ==UserScript==
// @name         モントレ用 Anki追加箱
// @namespace    https://github.com/Factbact/cbt-anki-inbox
// @version      2.8.0
// @description  モントレCBTの手動候補・自動指定・演習セッション・全問JSONを管理します
// @author       Factbact
// @match        https://m3e-medical.com/users/cbt*
// @match        https://www.m3e-medical.com/users/cbt*
// @match        https://m3e-medical.com/users/montore*
// @match        https://www.m3e-medical.com/users/montore*
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_anki_inbox.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_anki_inbox.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      s3-ap-northeast-1.amazonaws.com
// @connect      prd.question-images-tecopla.com
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  var APP_NAME = "モントレ用 Anki追加箱";
  var VERSION = "2.8.0";
  var REVIEW_BRIDGE_KEY = "montreReview.bridge.v1";
  var reviewPublished = {};
  var reviewReplayActive = false;
  var STATE_KEY = "montre_anki_inbox_state_v1";
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  var DEFAULT_PANEL = { left: 16, top: 140, width: 380, height: 560 };
  var state = loadState();
  var ui = {};
  var currentQuestion = null;
  var currentContext = null;
  var currentSession = null;
  var lastHoveredImage = null;
  var renderTimer = null;
  var captureTimer = null;
  var saveTimer = null;
  var exportRunning = false;

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    return prefix + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  function safeJsonParse(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  }

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    } catch (_error) {
      // localStorage fallback below
    }
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : safeJsonParse(raw, fallback);
    } catch (_error2) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return;
      }
    } catch (_error) {
      // localStorage fallback below
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      showFatal("データを保存できません", error);
    }
  }

  function blankState() {
    return {
      schemaVersion: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      settings: {
        panel: Object.assign({}, DEFAULT_PANEL),
        panelOpen: true,
        manualDivision: "",
        manualSubject: ""
      },
      categoryMap: {},
      largeCategoryMap: {},
      pendingContext: null,
      pendingSessionId: null,
      sessions: [],
      manualSequences: {},
      candidates: [],
      automaticOverrides: [],
      drafts: {},
      questionCache: {}
    };
  }

  function normalizeState(input) {
    var base = blankState();
    var value = input && typeof input === "object" ? input : {};
    base.createdAt = value.createdAt || base.createdAt;
    base.updatedAt = value.updatedAt || base.updatedAt;
    base.settings = Object.assign(base.settings, value.settings || {});
    base.settings.panel = Object.assign({}, DEFAULT_PANEL, (value.settings || {}).panel || {});
    base.categoryMap = value.categoryMap && typeof value.categoryMap === "object" ? value.categoryMap : {};
    base.largeCategoryMap = value.largeCategoryMap && typeof value.largeCategoryMap === "object" ? value.largeCategoryMap : {};
    base.pendingContext = value.pendingContext || null;
    base.pendingSessionId = value.pendingSessionId || null;
    base.sessions = Array.isArray(value.sessions) ? value.sessions : [];
    base.manualSequences = value.manualSequences && typeof value.manualSequences === "object" ? value.manualSequences : {};
    base.candidates = Array.isArray(value.candidates) ? value.candidates : [];
    base.automaticOverrides = Array.isArray(value.automaticOverrides) ? value.automaticOverrides : [];
    base.drafts = value.drafts && typeof value.drafts === "object" ? value.drafts : {};
    base.questionCache = value.questionCache && typeof value.questionCache === "object" ? value.questionCache : {};
    return base;
  }

  function loadState() {
    return normalizeState(gmGet(STATE_KEY, null));
  }

  function saveState(immediate) {
    state.updatedAt = nowIso();
    if (immediate) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      gmSet(STATE_KEY, state);
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      gmSet(STATE_KEY, state);
    }, 180);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function oneLine(value) {
    return normalizeText(value).replace(/\s+/g, " ");
  }

  function elementText(element) {
    if (!element) return "";
    return normalizeText(element.innerText || element.textContent || "");
  }

  function isEditable(target) {
    if (!target || !target.closest) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
  }

  function absoluteUrl(value, baseUrl) {
    if (!value) return "";
    try {
      return new URL(value, baseUrl || location.href).href;
    } catch (_error) {
      return String(value);
    }
  }

  function stripCount(value) {
    return oneLine(value)
      .replace(/全?\s*\d+\s*問.*$/u, "")
      .replace(/消化数.*$/u, "")
      .trim();
  }

  function formatShortDate(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return (date.getMonth() + 1) + "/" + date.getDate() + " " +
      String(date.getHours()).padStart(2, "0") + ":" +
      String(date.getMinutes()).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function readLargeCategoryMaps(doc) {
    var changed = false;
    Array.prototype.forEach.call(doc.querySelectorAll("input[type='checkbox'][name='large_category_ids[]']"), function (input) {
      var value = String(input.value || "").trim();
      if (!value) return;
      var label = input.nextElementSibling;
      if (!label || label.tagName.toLowerCase() !== "label") {
        var parent = input.parentElement;
        label = parent ? parent.querySelector("label") : null;
      }
      var name = stripCount(elementText(label));
      if (isValidLargeCategory(name) && state.largeCategoryMap[value] !== name) {
        state.largeCategoryMap[value] = name;
        changed = true;
      }
    });

    Array.prototype.forEach.call(doc.querySelectorAll("button[data-target^='#qb_top_large_category']"), function (button) {
      var division = stripCount(elementText(button.querySelector("h3") || button));
      var target = button.getAttribute("data-target");
      var container = target ? doc.querySelector(target) : null;
      if (!division || !container) return;
      Array.prototype.forEach.call(container.querySelectorAll("a[href*='category_id=']"), function (anchor) {
        var href = absoluteUrl(anchor.getAttribute("href"), location.href);
        var match = href.match(/[?&]category_id=(\d+)/);
        var subject = stripCount(elementText(anchor.querySelector("h3") || anchor));
        if (!match || !subject || !isValidLargeCategory(division) || isInvalidSessionLabel(subject)) return;
        var key = match[1];
        var next = { division: division, subject: subject, categoryId: key, source: "top-category-dom" };
        if (JSON.stringify(state.categoryMap[key]) !== JSON.stringify(next)) {
          state.categoryMap[key] = next;
          changed = true;
        }
      });
    });

    if (changed) saveState(false);
  }

  function findExplicitQuestionContext(doc) {
    var anchors = Array.prototype.slice.call(
      doc.querySelectorAll("a[href*='/questions/search?category_id=']")
    );
    var groups = {};
    anchors.forEach(function (anchor) {
      var text = stripCount(elementText(anchor));
      var href = absoluteUrl(anchor.getAttribute("href"), location.href);
      if (!text || !href) return;
      if (!groups[href]) groups[href] = [];
      if (groups[href].indexOf(text) < 0) groups[href].push(text);
    });
    var hrefs = Object.keys(groups);
    for (var index = 0; index < hrefs.length; index += 1) {
      var values = groups[hrefs[index]];
      if (values.length >= 2) {
        var categoryMatch = hrefs[index].match(/[?&]category_id=(\d+)/);
        var found = {
          division: values[0],
          subject: values[1],
          categoryId: categoryMatch ? categoryMatch[1] : null,
          source: "montore-explicit-category-links",
          confidence: "explicit"
        };
        if (isValidClassificationContext(found)) return found;
      }
    }
    return null;
  }

  function findSearchContext(doc, urlValue) {
    var url;
    try {
      url = new URL(urlValue || location.href);
    } catch (_error) {
      return null;
    }
    var categoryId = url.searchParams.get("category_id");
    if (categoryId && isValidClassificationContext(state.categoryMap[categoryId])) {
      return Object.assign({}, state.categoryMap[categoryId], {
        source: "top-category-map",
        confidence: "explicit"
      });
    }

    var largeIds = url.searchParams.getAll("large_category_ids[]");
    if (!largeIds.length) {
      Array.prototype.forEach.call(doc.querySelectorAll("input[type='hidden'][name='large_category_ids[]']"), function (input) {
        if (input.value && largeIds.indexOf(String(input.value)) < 0) largeIds.push(String(input.value));
      });
    }

    var heading = "";
    Array.prototype.some.call(doc.querySelectorAll("h1,h2,h3"), function (element) {
      var text = oneLine(elementText(element));
      var match = text.match(/^(.+?)\s+(\d+)\s*問$/u);
      if (!match) return false;
      heading = match[1].trim();
      return true;
    });

    if (largeIds.length === 1) {
      var largeName = state.largeCategoryMap[largeIds[0]] || heading;
      if (isValidLargeCategory(largeName)) {
        return {
          division: largeName,
          subject: "全範囲",
          largeCategoryId: largeIds[0],
          source: "selected-large-category",
          confidence: "explicit"
        };
      }
    }

    if (isValidClassificationContext(state.pendingContext)) {
      return Object.assign({}, state.pendingContext, {
        source: state.pendingContext.source || "clicked-category",
        confidence: "explicit"
      });
    }

    // 「未演習 120問」等のステータス見出しから科目を推測しない。
    // 既知の大分類と一致する場合だけ見出しを採用する。
    if (isValidLargeCategory(heading) &&
      (DOMAIN_BY_LARGE_CATEGORY[heading] ||
        Object.values(state.largeCategoryMap).indexOf(heading) >= 0)) {
      return {
        division: heading,
        subject: "全範囲",
        source: "page-heading",
        confidence: "heading-only"
      };
    }
    return null;
  }

  function detectContext(doc, urlValue) {
    readLargeCategoryMaps(doc);
    var explicit = findExplicitQuestionContext(doc);
    if (isValidClassificationContext(explicit)) {
      if (explicit.categoryId) {
        state.categoryMap[explicit.categoryId] = {
          division: explicit.division,
          subject: explicit.subject,
          categoryId: explicit.categoryId,
          source: explicit.source
        };
        saveState(false);
      }
      return explicit;
    }
    var search = findSearchContext(doc, urlValue);
    if (isValidClassificationContext(search)) return search;
    if (isValidClassificationContext({
      division: state.settings.manualDivision,
      subject: state.settings.manualSubject
    })) {
      return {
        division: state.settings.manualDivision,
        subject: state.settings.manualSubject,
        source: "manual-setting",
        confidence: "manual"
      };
    }
    return null;
  }

  function getDocumentText(doc) {
    var body = doc && doc.body;
    if (!body) return "";
    // DOMParserで取得したHTMLでもブロック境界を保ち、正答・問題文の行を検出する。
    var clone = body.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("script,style,noscript,#montre-anki-panel,#montre-anki-toggle"), function (el) { el.remove(); });
    Array.prototype.forEach.call(clone.querySelectorAll("br,p,div,li,h1,h2,h3,h4,tr,section,button"), function (el) {
      el.appendChild(doc.createTextNode("\n"));
      if (el.parentNode) el.parentNode.insertBefore(doc.createTextNode("\n"), el);
    });
    return normalizeText(clone.textContent || "");
  }

  function parseQuestionPosition(doc) {
    var result = { current: null, total: null };
    Array.prototype.some.call(doc.querySelectorAll("h1,h2,h3"), function (heading) {
      var match = oneLine(elementText(heading)).match(/(\d+)\s*問目\s*\/\s*(\d+)\s*問中/u);
      if (!match) return false;
      result.current = Number(match[1]);
      result.total = Number(match[2]);
      return true;
    });
    if (!result.total) {
      var bodyMatch = getDocumentText(doc).match(/(\d+)\s*問目\s*\/\s*(\d+)\s*問中/u);
      if (bodyMatch) {
        result.current = Number(bodyMatch[1]);
        result.total = Number(bodyMatch[2]);
      }
    }
    return result;
  }

  function parseProblemId(doc) {
    var match = getDocumentText(doc).match(/問題番号\s*[:：]\s*(\d{6,12})/u);
    return match ? match[1] : null;
  }

  function parseQuestionPrompt(doc) {
    var text = getDocumentText(doc);
    var lines = text.split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
    var idIndex = -1;
    var choiceIndex = -1;
    for (var index = 0; index < lines.length; index += 1) {
      if (idIndex < 0 && /問題番号\s*[:：]\s*\d{6,12}/u.test(lines[index])) idIndex = index;
      if (idIndex >= 0 && /^[A-ZＡ-Ｚ]\s*[.．。)]\s*/u.test(lines[index])) {
        choiceIndex = index;
        break;
      }
    }
    if (idIndex >= 0 && choiceIndex > idIndex + 1) {
      return normalizeText(lines.slice(idIndex + 1, choiceIndex).join("\n"));
    }
    return "";
  }

  function parseChoices(doc) {
    var choices = [];
    Array.prototype.forEach.call(doc.querySelectorAll("button[data-id]"), function (element) {
      var text = oneLine(elementText(element));
      var match = text.match(/^([A-ZＡ-Ｚ])\s*[.．。)]\s*(.+)$/u);
      if (!match) return;
      var label = match[1].normalize("NFKC").toUpperCase();
      if (!/^[A-Z]$/.test(label)) return;
      if (choices.some(function (item) { return item.label === label; })) return;
      var dataId = element.getAttribute("data-id") || "";
      var input = dataId ? doc.querySelector("input[value='" + cssEscape(dataId) + "'][name='answer[values][]']") : null;
      choices.push({
        label: label,
        text: normalizeText(match[2]),
        value: dataId || (input ? input.value : ""),
        selected: Boolean(
          element.classList.contains("active") ||
          element.getAttribute("aria-pressed") === "true" ||
          (input && input.checked)
        )
      });
    });
    choices.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return choices;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (character) {
      return "\\" + character;
    });
  }

  function parseAnswerLetters(value) {
    var letters = String(value || "").normalize("NFKC").toUpperCase().match(/[A-Z]/g) || [];
    return Array.from(new Set(letters)).sort();
  }

  function correctAnswerFromText(value) {
    var text = String(value || "").normalize("NFKC");
    // 解説の「正解 Cポイント」のように行が連結された表記にも対応。
    var matches = Array.from(text.matchAll(/正解\s*[:：]?\s*([A-Z](?:\s*[,、・，]\s*[A-Z])*)(?![A-Za-z])/gu));
    var answers = matches.map(function (match) { return parseAnswerLetters(match[1]); });
    var unique = Array.from(new Set(answers.map(function (answer) { return answer.join(","); })));
    return unique.length === 1 ? answers[0] : [];
  }

  function parseQuestionGroup(doc) {
    var match = getDocumentText(doc).match(/連問\s*(\d+)\s*\/\s*(\d+)\s*問目/u);
    if (!match) return null;
    var index = Number(match[1]), count = Number(match[2]);
    return index >= 1 && count >= index && count > 1 ? { index: index, count: count } : null;
  }

  function explanationForChoices(explanation, choices, group) {
    var text = String(explanation || "");
    var sections = text.split(/(?=[［\[]\d+[］\]]\s*Assessment\s*[:：])/u)
      .filter(function (part) { return /^[［\[]\d+[］\]]/u.test(part); });
    if (sections.length < 2) return text;
    if (group) {
      var numbers = sections.map(function (section) { return Number(section.match(/^[［\[]([0-9]+)[］\]]/u)[1]); });
      if (sections.length !== group.count || !numbers.every(function (n, i) { return n === i + 1; })) return "";
      return sections[group.index - 1];
    }
    // 連問の先頭の正答を流用しない。全選択肢の文言が一致する節だけを採用する。
    var compact = function (value) { return String(value || "").normalize("NFKC").replace(/\s+/gu, ""); };
    var usable = (choices || []).filter(function (choice) { return compact(choice.text).length >= 2; });
    if (usable.length < 2) return "";
    var matching = sections.filter(function (section) {
      var body = compact(section);
      return usable.every(function (choice) { return body.indexOf(compact(choice.text)) >= 0; });
    });
    return matching.length === 1 ? matching[0] : "";
  }

  function parseCorrectAnswer(doc) {
    var full = parseExplanation(doc);
    var scoped = explanationForChoices(full, parseChoices(doc), parseQuestionGroup(doc));
    if (full && !scoped) return [];
    var fromExplanation = correctAnswerFromText(scoped);
    return fromExplanation.length ? fromExplanation : correctAnswerFromText(getDocumentText(doc));
  }

  function parseLatestAnswer(doc) {
    var text = getDocumentText(doc).normalize("NFKC");
    var historyIndex = text.indexOf("解答履歴");
    var historyText = historyIndex >= 0 ? text.slice(historyIndex) : text;
    var matches = Array.from(historyText.matchAll(/解答\s*[:：]\s*([A-Z](?:\s*[,、・]\s*[A-Z])*)/gu));
    if (matches.length) return parseAnswerLetters(matches[0][1]);
    var selected = parseChoices(doc).filter(function (choice) { return choice.selected; }).map(function (choice) { return choice.label; });
    return selected.sort();
  }

  function sameLetters(first, second) {
    if (!first || !second || first.length !== second.length) return false;
    return first.every(function (value, index) { return value === second[index]; });
  }

  function parseEvaluation(doc, correctAnswer, selectedAnswer) {
    var changeButton = doc.querySelector("#change-answer-button");
    var changeText = oneLine(elementText(changeButton));
    var explicitMatches = Array.from(getDocumentText(doc).matchAll(/自己評価\s*[:：]\s*([△○◎×])/gu));
    var explicitValues = Array.from(new Set(explicitMatches.map(function (match) { return match[1]; })));
    var hint = doc.querySelector("#hint-used");
    var hintUsed = Boolean(hint && (
      hint.value === "true" ||
      hint.getAttribute("data-hint-used") === "true"
    ));

    if (explicitValues.length === 1) {
      return { value: explicitValues[0], raw: "explicit", hintUsed: hintUsed, source: "explicit-self-evaluation-label", changeButtonText: changeText };
    }
    if (changeButton && !/△に変更/u.test(changeText) &&
      /○に変更|×に変更|元に戻|△を解除/u.test(changeText)) {
      return { value: "△", raw: "mistake", hintUsed: hintUsed, source: "change-answer-button", changeButtonText: changeText };
    }
    if (correctAnswer.length && selectedAnswer.length) {
      if (!sameLetters(correctAnswer, selectedAnswer)) {
        return { value: "×", raw: "incorrect", hintUsed: hintUsed, source: "answer-comparison", changeButtonText: changeText };
      }
      if (hintUsed) {
        return { value: "◎", raw: "hinted_correct", hintUsed: true, source: "answer-comparison-and-hint", changeButtonText: changeText };
      }
      return { value: "○", raw: "correct", hintUsed: false, source: "answer-comparison", changeButtonText: changeText };
    }
    return { value: null, raw: null, hintUsed: hintUsed, source: "unavailable", changeButtonText: changeText };
  }

  function parseExplanation(doc) {
    var target = doc.querySelector("#practice_question_accordion_expound");
    if (!target) {
      var button = Array.prototype.find.call(doc.querySelectorAll("button[data-target]"), function (element) {
        return /解説を見る/u.test(elementText(element));
      });
      var selector = button ? button.getAttribute("data-target") : "";
      if (selector && selector.charAt(0) === "#") target = doc.querySelector(selector);
    }
    if (!target) return "";
    var clone = target.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll("script,style,noscript,button"), function (element) {
      element.remove();
    });
    return normalizeText(clone.textContent || "");
  }

  function collectQuestionImages(doc, baseUrl) {
    var result = [];
    var seen = {};
    function add(urlValue, kind, alt) {
      var url = absoluteUrl(urlValue, baseUrl);
      if (!url || seen[url]) return;
      var useful = /question-images-tecopla\.com/i.test(url) ||
        /\.(?:png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(url);
      var commonAsset = /\/assets\/c\/(?:common|education\/mypage)\//i.test(url);
      if (!useful || commonAsset) return;
      seen[url] = true;
      result.push({ url: url, kind: kind || "image", alt: alt || "" });
    }
    Array.prototype.forEach.call(doc.querySelectorAll("img[src]"), function (image) {
      add(image.getAttribute("src"), "img", image.getAttribute("alt"));
    });
    Array.prototype.forEach.call(doc.querySelectorAll("a[href]"), function (anchor) {
      add(anchor.getAttribute("href"), "linked-image", elementText(anchor));
    });
    return result;
  }

  function findNextQuestionUrl(doc, baseUrl) {
    var anchors = Array.prototype.slice.call(doc.querySelectorAll("a[href*='/practice_questions/']"));
    for (var index = 0; index < anchors.length; index += 1) {
      if (/次の問題/u.test(oneLine(elementText(anchors[index])))) {
        return absoluteUrl(anchors[index].getAttribute("href"), baseUrl);
      }
    }
    return null;
  }

  function findPreviousQuestionUrl(doc, baseUrl) {
    var anchors = Array.prototype.slice.call(doc.querySelectorAll("a[href*='/practice_questions/']"));
    for (var index = 0; index < anchors.length; index += 1) {
      if (/前の問題/u.test(oneLine(elementText(anchors[index])))) {
        return absoluteUrl(anchors[index].getAttribute("href"), baseUrl);
      }
    }
    return null;
  }

  function extractQuestion(doc, urlValue) {
    var problemId = parseProblemId(doc);
    if (!problemId) return null;
    var position = parseQuestionPosition(doc);
    var context = detectContext(doc, urlValue);
    var correctAnswer = parseCorrectAnswer(doc);
    var selectedAnswer = parseLatestAnswer(doc);
    var evaluation = parseEvaluation(doc, correctAnswer, selectedAnswer);
    var internalMatch = String(urlValue || "").match(/\/practice_questions\/(\d+)/);
    var classification = context ? buildClassification(context.division, context.subject) : null;
    return {
      source: "モントレ",
      automaticCardId: "montre:" + problemId,
      problemNumber: problemId,
      practiceQuestionId: internalMatch ? internalMatch[1] : null,
      url: String(urlValue || ""),
      position: position.current,
      total: position.total,
      questionGroup: parseQuestionGroup(doc),
      subjectContext: context ? {
        largeCategory: context.division,
        category: context.subject,
        division: context.division,
        subject: context.subject,
        sitePath: classification.sitePath,
        categoryId: context.categoryId || null,
        acquisitionSource: context.source,
        confidence: context.confidence || "explicit"
      } : null,
      classification: classification,
      ankiTags: classification ? classification.ankiTags : [],
      questionText: parseQuestionPrompt(doc),
      choices: parseChoices(doc),
      selectedAnswer: selectedAnswer,
      correctAnswer: correctAnswer,
      explanation: explanationForChoices(parseExplanation(doc), parseChoices(doc), parseQuestionGroup(doc)),
      images: collectQuestionImages(doc, urlValue),
      answerCorrectness: correctAnswer.length && selectedAnswer.length ?
        (sameLetters(correctAnswer, selectedAnswer) ? "correct" : "incorrect") : "unknown",
      observedSelfEvaluation: evaluation.source === "explicit-self-evaluation-label" || evaluation.source === "change-answer-button" ? evaluation.value : null,
      selfEvaluationConfirmed: evaluation.source === "explicit-self-evaluation-label" || evaluation.source === "change-answer-button",
      selfEvaluation: evaluation.value,
      selfEvaluationRaw: evaluation.raw,
      hintUsed: evaluation.hintUsed,
      evaluationSource: evaluation.source,
      evaluationControlText: evaluation.changeButtonText,
      nextQuestionUrl: findNextQuestionUrl(doc, urlValue),
      previousQuestionUrl: findPreviousQuestionUrl(doc, urlValue),
      capturedAt: nowIso()
    };
  }

  function extractQuestionsFromPage(doc, urlValue) {
    var markers = Array.from(doc.querySelectorAll("body *")).filter(function (element) {
      if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(element.tagName) || element.closest("#montre-anki-panel")) return false;
      var text = element.textContent || "";
      if (!/問題番号\s*[:：]\s*\d{6,12}/u.test(text)) return false;
      return !Array.from(element.children).some(function (child) {
        return /問題番号\s*[:：]\s*\d{6,12}/u.test(child.textContent || "");
      });
    });
    var ids = Array.from(new Set(markers.map(function (element) {
      return (element.textContent.match(/問題番号\s*[:：]\s*(\d{6,12})/u) || [])[1];
    }).filter(Boolean)));
    if (ids.length < 2) {
      var single = extractQuestion(doc, urlValue);
      return single ? [single] : [];
    }
    var pagePosition = parseQuestionPosition(doc);
    var sharedExplanation = parseExplanation(doc);
    var group = [];
    ids.forEach(function (id, index) {
      var marker = markers.find(function (element) {
        return new RegExp("問題番号\\s*[:：]\\s*" + id + "(?!\\d)").test(element.textContent);
      });
      var scope = marker;
      while (scope && scope.parentElement && scope.parentElement !== doc.body) {
        var parent = scope.parentElement;
        var parentIds = Array.from(new Set(Array.from((parent.textContent || "").matchAll(/問題番号\s*[:：]\s*(\d{6,12})/gu)).map(function (m) { return m[1]; })));
        if (parentIds.length !== 1 || parentIds[0] !== id) break;
        scope = parent;
      }
      if (!scope || !scope.querySelector("button[data-id]")) return;
      var scopedDoc = doc.implementation.createHTMLDocument("");
      scopedDoc.body.appendChild(scope.cloneNode(true));
      var localExplanation = parseExplanation(scopedDoc);
      if (!localExplanation && sharedExplanation) {
        var explanationNode = scopedDoc.createElement("div");
        explanationNode.id = "practice_question_accordion_expound";
        explanationNode.textContent = sharedExplanation;
        scopedDoc.body.appendChild(explanationNode);
      }
      var question = extractQuestion(scopedDoc, urlValue);
      if (!question || question.problemNumber !== id) return;
      // 問題本文のDOM順とページ内の連問数に対応する解説節がそろう場合のみ位置を補う。
      if (!question.position && pagePosition.current) {
        var sectionNumbers = Array.from(sharedExplanation.matchAll(/[［\[]([0-9]+)[］\]]\s*Assessment\s*[:：]/gu)).map(function (m) { return Number(m[1]); });
        if (sectionNumbers.length === ids.length && sectionNumbers.every(function (n, i) { return n === i + 1; })) {
          question.position = pagePosition.current + index;
          question.positionSource = "page-start-and-ordered-group";
        }
      }
      question.total = question.total || pagePosition.total;
      var context = extractQuestion(doc, urlValue);
      if (!question.subjectContext && context) {
        question.subjectContext = context.subjectContext;
        question.classification = context.classification;
        question.ankiTags = context.ankiTags;
      }
      question.pageGroup = { sourceUrl: urlValue, index: index + 1, count: ids.length };
      // 同じページ内の小問に架空のpracticeQuestionIdを付けない。
      question.practiceQuestionId = index === 0 ? question.practiceQuestionId : null;
      question.nextQuestionUrl = findNextQuestionUrl(doc, urlValue);
      question.previousQuestionUrl = findPreviousQuestionUrl(doc, urlValue);
      group.push(question);
    });
    return group;
  }

  function sessionSubjectKey(context, total) {
    if (!context) return "unknown|" + String(total || "");
    return [context.division || "", context.subject || "", String(total || "")].join("|");
  }

  // モントレが表示する2階層を、Anki用の領域を含む分類へ変換する固定表。
  // 問題文から医学的な意味を推測せず、登録済みの大分類名だけを変換する。
  var DOMAIN_BY_LARGE_CATEGORY = {
    "基礎医学": "基礎医学",
    "公衆衛生": "公衆衛生",
    "社会医学": "社会医学",
    "臨床医学総論": "臨床医学",
    "循環器": "臨床医学",
    "呼吸器": "臨床医学",
    "消化器": "臨床医学",
    "肝・胆・膵": "臨床医学",
    "腎・泌尿器": "臨床医学",
    "腎・泌尿器科": "臨床医学",
    "内分泌・代謝": "臨床医学",
    "代謝・内分泌": "臨床医学",
    "血液": "臨床医学",
    "感染症": "臨床医学",
    "免疫・膠原病": "臨床医学",
    "神経": "臨床医学",
    "脳神経": "臨床医学",
    "精神": "臨床医学",
    "精神科": "臨床医学",
    "小児": "臨床医学",
    "小児科": "臨床医学",
    "産婦人科": "臨床医学",
    "産科": "臨床医学",
    "婦人科": "臨床医学",
    "皮膚科": "臨床医学",
    "眼科": "臨床医学",
    "耳鼻咽喉科": "臨床医学",
    "整形外科": "臨床医学",
    "救急": "臨床医学",
    "麻酔": "臨床医学",
    "麻酔科": "臨床医学",
    "放射線": "臨床医学",
    "放射線科": "臨床医学"
  };

  // 横断タグはこの表だけから作る。「・」を無条件には分割しない。
  var CROSS_CLASSIFICATION_TAGS = {
    "解剖・生理": ["解剖", "生理"],
    "症候・病態": ["症候", "病態"],
    "診察・身体所見": ["診察", "身体所見"],
    "検査": ["検査"],
    "治療": ["治療"]
  };

  function isInvalidSessionLabel(value) {
    return !value || [
      "未演習",
      "演習済み",
      "全問題",
      "オススメのフィルタ",
      "コアカリキュラム項目",
      "科目未設定"
    ].indexOf(String(value).trim()) >= 0;
  }

  // 未演習・全範囲などの表示項目を、医学の大分類と誤認しない。
  function isValidLargeCategory(value) {
    var name = stripCount(value);
    return Boolean(name && name !== "全範囲" &&
      !isInvalidSessionLabel(name) &&
      !/^(?:未演習|演習済み|すべて|全て|正答|誤答|間違えた問題|全範囲)\s*(?:の問題)?$/u.test(name));
  }

  function isValidClassificationContext(context) {
    return Boolean(context && isValidLargeCategory(context.division) &&
      context.subject && !isInvalidSessionLabel(context.subject));
  }

  function safeTagSegment(value) {
    return oneLine(value).replace(/::/g, "：").replace(/\s+/g, "_");
  }

  function uniqueStrings(values) {
    return values.filter(function (value, index, array) {
      return value && array.indexOf(value) === index;
    });
  }

  function buildClassification(largeCategoryValue, categoryValue) {
    var largeCategory = stripCount(largeCategoryValue);
    var category = stripCount(categoryValue);
    var domain = DOMAIN_BY_LARGE_CATEGORY[largeCategory] || null;
    var wholeRange = category === "全範囲";
    var subject = largeCategory;
    var topic = wholeRange ? null : (category || null);
    var path = [];

    if (domain) path.push(domain);
    if (!domain || domain !== largeCategory) path.push(largeCategory);
    if (domain === largeCategory) {
      subject = topic || largeCategory;
      topic = null;
      if (subject !== domain) path.push(subject);
    } else if (topic) {
      path.push(topic);
    }
    path = uniqueStrings(path);

    var displayPath = path.slice();
    if (wholeRange) displayPath.push("全範囲");
    var sitePath = uniqueStrings([largeCategory, category]);
    var crossKey = topic || (domain === largeCategory ? subject : null);
    var crossValues = CROSS_CLASSIFICATION_TAGS[crossKey] || [];
    var ankiTags = [];
    if (path.length) {
      ankiTags.push("モントレ分類::" + path.map(safeTagSegment).join("::"));
    }
    crossValues.forEach(function (value) {
      ankiTags.push("横断分類::" + safeTagSegment(value));
    });

    return {
      domain: domain,
      subject: subject || null,
      topic: topic,
      path: path,
      displayPath: displayPath,
      sitePath: sitePath,
      scope: wholeRange ? "large_category" : "category",
      mappingStatus: domain ? "mapped" : "unmapped",
      mappingSource: domain ? "fixed-large-category-map" : "site-only",
      ankiTags: uniqueStrings(ankiTags)
    };
  }

  function formatClassification(largeCategory, category) {
    if (!isValidClassificationContext({ division: largeCategory, subject: category })) {
      return "⚠ 分類未取得";
    }
    var classification = buildClassification(largeCategory, category);
    var label = classification.displayPath.join(" ＞ ");
    return classification.mappingStatus === "mapped" ? label : "⚠ 領域未確認｜" + label;
  }

  function contextFromSessionSearchUrl(session) {
    if (!session || !session.searchUrl) return null;
    var url;
    try {
      url = new URL(session.searchUrl, location.origin);
    } catch (_error) {
      return null;
    }
    var categoryId = url.searchParams.get("category_id");
    if (categoryId && isValidClassificationContext(state.categoryMap[categoryId])) {
      return Object.assign({}, state.categoryMap[categoryId], {
        source: "session-search-category",
        confidence: "explicit"
      });
    }
    var largeIds = url.searchParams.getAll("large_category_ids[]");
    if (largeIds.length === 1 && isValidLargeCategory(state.largeCategoryMap[largeIds[0]])) {
      return {
        division: state.largeCategoryMap[largeIds[0]],
        subject: "全範囲",
        largeCategoryId: largeIds[0],
        source: "session-search-large-category",
        confidence: "explicit"
      };
    }
    return null;
  }

  function ensureSession(question, context, options) {
    options = options || {};
    var practiceId = question && question.practiceQuestionId;
    var pending = state.pendingSessionId ?
      state.sessions.find(function (session) { return session.id === state.pendingSessionId; }) : null;
    if (pending && pending.status !== "completed") {
      var existingFirstRefs = (pending.questionRefs || []).filter(function (ref) {
        return ref.position === 1;
      });
      var sameFirstQuestion = question && question.position === 1 && existingFirstRefs.some(function (ref) {
        if (question.practiceQuestionId && ref.practiceQuestionId) {
          return ref.practiceQuestionId === question.practiceQuestionId;
        }
        return !question.practiceQuestionId &&
          question.problemNumber && ref.problemNumber === question.problemNumber;
      });

      // 「全問再復習」など、検索画面の開始ボタンを通らず新しい演習へ入る場合の保険。
      // 既存セッションに別の1問目があるのに新しい1問目が表示されたら、
      // 前回セッションを残したまま新規セッションとして扱う。
      if (question && question.position === 1 && existingFirstRefs.length && !sameFirstQuestion) {
        state.pendingSessionId = null;
        currentSession = null;
      } else {
        currentSession = pending;
      }
    }

    if (!currentSession && practiceId) {
      currentSession = state.sessions.find(function (session) {
        return Array.isArray(session.practiceQuestionIds) && session.practiceQuestionIds.indexOf(practiceId) >= 0;
      }) || null;
    }

    var subjectKey = sessionSubjectKey(context, question ? question.total : options.total);

    // 別の演習を「科目名＋問題数」だけで再利用しない。
    // 同じ科目・同じ問題数でも、別日に開始した演習は別セッションとして扱う。
    // 復帰時は pendingSessionId または既知の practiceQuestionId だけを根拠に再接続する。
    if (!currentSession && options.allowCreate !== false) {
      currentSession = {
        id: makeId("montre-session"),
        source: "モントレ",
        startedAt: options.startedAt || nowIso(),
        updatedAt: nowIso(),
        completedAt: null,
        status: "active",
        division: context ? context.division : "",
        subject: context ? context.subject : "",
        subjectSource: context ? context.source : "unavailable",
        subjectKey: subjectKey,
        expectedTotal: question ? question.total : (options.total || null),
        searchUrl: options.searchUrl || location.href,
        practiceQuestionIds: [],
        questionRefs: [],
        exportedAt: null,
        exportedFileName: null
      };
      state.sessions.push(currentSession);
      state.pendingSessionId = currentSession.id;
    }

    if (currentSession) {
      currentSession.updatedAt = nowIso();
      var sessionSearchContext = contextFromSessionSearchUrl(currentSession);
      if (isValidClassificationContext(sessionSearchContext)) {
        currentSession.division = sessionSearchContext.division;
        currentSession.subject = sessionSearchContext.subject;
        currentSession.subjectSource = sessionSearchContext.source;
        currentSession.subjectKey = sessionSubjectKey(
          sessionSearchContext,
          question ? question.total : currentSession.expectedTotal
        );
      } else if (isValidClassificationContext(context) && !isValidClassificationContext({
        division: currentSession.division,
        subject: currentSession.subject
      })) {
        // 旧版で「未演習／全範囲」が保存されたセッションを、実測の科目情報で修復。
        // 分野の確証がない場合は上書きしない。
        currentSession.division = context.division;
        currentSession.subject = context.subject;
        currentSession.subjectSource = "repaired-from-explicit-question-classification";
        currentSession.subjectKey = sessionSubjectKey({
          division: currentSession.division,
          subject: currentSession.subject
        }, question ? question.total : currentSession.expectedTotal);
      } else if (isValidClassificationContext(context) &&
        (!currentSession.division || !currentSession.subject ||
        currentSession.subjectSource === "unavailable" ||
        currentSession.subjectSource === "page-heading")) {
        currentSession.division = context.division || currentSession.division;
        currentSession.subject = context.subject || currentSession.subject;
        currentSession.subjectSource = context.source || currentSession.subjectSource;
        currentSession.subjectKey = sessionSubjectKey(context, question ? question.total : currentSession.expectedTotal);
      }
      if (question) {
        if (question.total) currentSession.expectedTotal = question.total;
        if (practiceId && currentSession.practiceQuestionIds.indexOf(practiceId) < 0) {
          currentSession.practiceQuestionIds.push(practiceId);
        }
        var ref = currentSession.questionRefs.find(function (item) {
          return item.practiceQuestionId === question.practiceQuestionId ||
            item.problemNumber === question.problemNumber;
        });
        var refValue = {
          practiceQuestionId: question.practiceQuestionId,
          problemNumber: question.problemNumber,
          position: question.position,
          url: question.url,
          updatedAt: nowIso()
        };
        if (ref) Object.assign(ref, refValue);
        else currentSession.questionRefs.push(refValue);
        currentSession.questionRefs.sort(function (a, b) {
          return (a.position || 99999) - (b.position || 99999);
        });
      }
      state.pendingSessionId = currentSession.id;
      saveState(false);
    }
    return currentSession;
  }

  function currentProblemKey() {
    return currentQuestion && currentQuestion.problemNumber ? currentQuestion.problemNumber : null;
  }

  function getDraft(problemId) {
    if (!problemId) return { text: "", images: [], alsoCreateAutomatic: false };
    if (!state.drafts[problemId]) {
      state.drafts[problemId] = { text: "", images: [], alsoCreateAutomatic: false, updatedAt: nowIso() };
    }
    return state.drafts[problemId];
  }

  function syncDraftFromUi() {
    var problemId = currentProblemKey();
    if (!problemId || !ui.textarea) return;
    var draft = getDraft(problemId);
    draft.text = ui.textarea.value;
    draft.alsoCreateAutomatic = Boolean(ui.alsoAuto && ui.alsoAuto.checked);
    draft.updatedAt = nowIso();
    saveState(false);
  }

  function nextManualId(problemId) {
    var next = Number(state.manualSequences[problemId] || 0) + 1;
    state.manualSequences[problemId] = next;
    return "montre:" + problemId + ":manual:" + String(next).padStart(2, "0");
  }

  function validateCandidateContext() {
    if (!currentQuestion || !currentQuestion.problemNumber) {
      throw new Error("問題番号を取得できないため保存できません");
    }
    var context = currentQuestion.subjectContext || (
      currentContext ? {
        division: currentContext.division,
        subject: currentContext.subject,
        acquisitionSource: currentContext.source
      } : null
    );
    if (!context || !context.division || !context.subject) {
      throw new Error("モントレの大分類・問題分類を取得できないため保存できません");
    }
    if (!currentSession) {
      throw new Error("現在の演習セッションを確定できません");
    }
    return context;
  }

  function saveDraftCandidates() {
    var problemId = currentProblemKey();
    if (!problemId) throw new Error("問題番号を取得できないため保存できません");
    syncDraftFromUi();
    var draft = getDraft(problemId);
    var lines = String(draft.text || "").split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
    var images = Array.isArray(draft.images) ? draft.images.slice() : [];
    if (!lines.length && !images.length) return 0;
    var context = validateCandidateContext();
    var classification = buildClassification(context.division, context.subject);
    if (!lines.length) lines.push("");
    var created = 0;
    lines.forEach(function (line, index) {
      var candidateImages = index === 0 ? images : [];
      var id = nextManualId(problemId);
      state.candidates.push({
        id: id,
        source: "モントレ",
        sessionId: currentSession.id,
        problemNumber: problemId,
        url: currentQuestion.url,
        largeCategory: context.division,
        category: context.subject,
        division: context.division,
        subject: context.subject,
        classification: classification,
        ankiTags: classification.ankiTags,
        subjectSource: context.acquisitionSource || context.source || "explicit",
        text: line,
        images: candidateImages,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
        exportedAt: null,
        alsoCreateAutomatic: Boolean(draft.alsoCreateAutomatic),
        automaticCardPolicy: draft.alsoCreateAutomatic ? "manual_plus_automatic" : "manual_only"
      });
      created += 1;
    });
    state.drafts[problemId] = {
      text: "",
      images: [],
      alsoCreateAutomatic: false,
      updatedAt: nowIso()
    };
    saveState(true);
    if (ui.textarea) ui.textarea.value = "";
    if (ui.alsoAuto) ui.alsoAuto.checked = false;
    render();
    setStatus(created + "件の手動候補を保存しました", "success");
    return created;
  }

  function activeCandidatesForSession(sessionId) {
    return state.candidates.filter(function (candidate) {
      return candidate.sessionId === sessionId && !candidate.deletedAt;
    });
  }

  function pendingCandidatesForSession(sessionId) {
    return activeCandidatesForSession(sessionId).filter(function (candidate) {
      return !candidate.exportedAt;
    });
  }

  function candidateCountForProblem(problemId) {
    if (!currentSession) return 0;
    return activeCandidatesForSession(currentSession.id).filter(function (candidate) {
      return candidate.problemNumber === problemId;
    }).length;
  }

  function deleteCandidate(id) {
    var candidate = state.candidates.find(function (item) { return item.id === id; });
    if (!candidate) return;
    candidate.deletedAt = nowIso();
    candidate.updatedAt = nowIso();
    saveState(true);
    render();
    setStatus("候補を削除しました。IDは再利用しません", "info");
  }

  function getOverride(problemId, sessionId) {
    return state.automaticOverrides.find(function (entry) {
      return entry.problemNumber === problemId &&
        entry.sessionId === sessionId &&
        !entry.deletedAt;
    }) || null;
  }

  function toggleAutomaticOverride() {
    if (!currentQuestion || !currentSession) {
      setStatus("問題と演習セッションを取得できません", "error");
      return;
    }
    var existing = getOverride(currentQuestion.problemNumber, currentSession.id);
    if (existing) {
      existing.deletedAt = nowIso();
      existing.updatedAt = nowIso();
      setStatus("強制自動カード指定を解除しました", "info");
    } else {
      state.automaticOverrides.push({
        id: makeId("montre-auto"),
        source: "モントレ",
        sessionId: currentSession.id,
        problemNumber: currentQuestion.problemNumber,
        url: currentQuestion.url,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
        forceAutomatic: true,
        reason: "user_override"
      });
      setStatus("自己評価に関係なく自動カードを作る指定を保存しました", "success");
    }
    saveState(true);
    render();
  }

  function questionDecision(question, sessionId) {
    var manual = activeCandidatesForSession(sessionId).filter(function (candidate) {
      return candidate.problemNumber === question.problemNumber;
    });
    var override = getOverride(question.problemNumber, sessionId);
    if (override) {
      return { createAutomatic: true, createManual: manual.length > 0, policy: "forced_automatic" };
    }
    if (manual.length) {
      var plusAutomatic = manual.some(function (candidate) { return candidate.alsoCreateAutomatic; });
      return {
        createAutomatic: plusAutomatic,
        createManual: true,
        policy: plusAutomatic ? "manual_plus_automatic" : "manual_only"
      };
    }
    var automatic = question.selfEvaluation === "△" || question.selfEvaluation === "×";
    return {
      createAutomatic: automatic,
      createManual: false,
      policy: automatic ? "evaluation_automatic" : "evaluation_excluded"
    };
  }

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//i.test(file.type || "")) {
        reject(new Error("画像ファイルではありません"));
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        reject(new Error("画像は8MB以下にしてください"));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        resolve({
          name: file.name || "clipboard-image",
          type: file.type || "image/png",
          size: file.size || null,
          dataUrl: String(reader.result || ""),
          sourceUrl: null,
          addedAt: nowIso()
        });
      };
      reader.onerror = function () {
        reject(new Error("画像を読み込めませんでした"));
      };
      reader.readAsDataURL(file);
    });
  }

  function remoteImageToDataUrl(url) {
    return new Promise(function (resolve, reject) {
      if (!url) {
        reject(new Error("画像URLがありません"));
        return;
      }
      if (typeof GM_xmlhttpRequest !== "function") {
        resolve({
          name: url.split("/").pop() || "page-image",
          type: "",
          size: null,
          dataUrl: null,
          sourceUrl: url,
          addedAt: nowIso()
        });
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "blob",
        onload: function (response) {
          var blob = response.response;
          if (!blob || blob.size > MAX_IMAGE_BYTES) {
            resolve({
              name: url.split("/").pop() || "page-image",
              type: blob ? blob.type : "",
              size: blob ? blob.size : null,
              dataUrl: null,
              sourceUrl: url,
              addedAt: nowIso()
            });
            return;
          }
          fileToDataUrl(new File([blob], url.split("/").pop() || "page-image", { type: blob.type || "image/png" }))
            .then(function (value) {
              value.sourceUrl = url;
              resolve(value);
            })
            .catch(reject);
        },
        onerror: function () {
          resolve({
            name: url.split("/").pop() || "page-image",
            type: "",
            size: null,
            dataUrl: null,
            sourceUrl: url,
            addedAt: nowIso()
          });
        }
      });
    });
  }

  async function addImageFiles(files) {
    var problemId = currentProblemKey();
    if (!problemId) {
      setStatus("問題番号を取得できないため画像を追加できません", "error");
      return;
    }
    var list = Array.prototype.slice.call(files || []).filter(function (file) {
      return /^image\//i.test(file.type || "");
    });
    if (!list.length) return;
    try {
      var images = await Promise.all(list.map(fileToDataUrl));
      var draft = getDraft(problemId);
      draft.images = (draft.images || []).concat(images);
      draft.updatedAt = nowIso();
      saveState(true);
      renderDraftImages();
      setStatus(images.length + "枚の画像を追加しました", "success");
    } catch (error) {
      setStatus(error.message || String(error), "error");
    }
  }

  async function addHoveredImage() {
    if (!lastHoveredImage) {
      setStatus("先にページ上の画像へマウスを重ねてください", "error");
      return;
    }
    var problemId = currentProblemKey();
    if (!problemId) {
      setStatus("問題番号を取得できません", "error");
      return;
    }
    setStatus("ページ画像を取り込んでいます…", "info");
    try {
      var image = await remoteImageToDataUrl(lastHoveredImage);
      var draft = getDraft(problemId);
      draft.images = (draft.images || []).concat([image]);
      draft.updatedAt = nowIso();
      saveState(true);
      renderDraftImages();
      setStatus("ページ画像を追加しました", "success");
    } catch (error) {
      setStatus(error.message || String(error), "error");
    }
  }

  function removeDraftImage(index) {
    var problemId = currentProblemKey();
    if (!problemId) return;
    var draft = getDraft(problemId);
    if (!Array.isArray(draft.images)) draft.images = [];
    draft.images.splice(index, 1);
    draft.updatedAt = nowIso();
    saveState(true);
    renderDraftImages();
  }

  function hasUnsavedDraft() {
    var problemId = currentProblemKey();
    if (!problemId) return false;
    var draft = getDraft(problemId);
    var text = ui.textarea ? ui.textarea.value : draft.text;
    return Boolean(String(text || "").trim() || (draft.images && draft.images.length));
  }


  // モントレ誤答復習へ、確定した演習結果のみをローカルで受け渡す。
  // GitHubや外部サーバーに問題文を送信しない。
  function reviewEvidence(question) {
    if (!question || !Array.isArray(question.correctAnswer) || !question.correctAnswer.length ||
        !Array.isArray(question.choices) || !question.choices.length ||
        !String(question.questionText || "").trim()) return null;
    if (question.selfEvaluationConfirmed === true &&
        ["○", "×", "△"].indexOf(question.selfEvaluation) !== -1) {
      return { mark: question.selfEvaluation, method: "explicit" };
    }
    // 解答と正答・判定が一致する場合だけ正誤を再利用する。
    if (question.evaluationSource !== "answer-comparison" ||
        !Array.isArray(question.selectedAnswer) || !question.selectedAnswer.length) return null;
    var expected = sameLetters(question.correctAnswer, question.selectedAnswer) ? "○" : "×";
    if (question.selfEvaluation !== expected ||
        question.answerCorrectness !== (expected === "○" ? "correct" : "incorrect")) return null;
    return { mark: expected, method: "answer-comparison" };
  }

  function makeReviewPacket(question) {
    var evidence = reviewEvidence(question);
    if (!evidence) return null;
    return {
      kind: "montre-review-question-v1",
      question: {
        problemNumber: String(question.problemNumber || ""),
        questionText: String(question.questionText || "").slice(0, 30000),
        choices: question.choices.slice(0, 25).map(function (c) {
          return { label: String(c.label || ""), text: String(c.text || "").slice(0, 30000) };
        }),
        correctAnswer: question.correctAnswer.slice(0, 25),
        selectedAnswer: Array.isArray(question.selectedAnswer) ? question.selectedAnswer.slice(0, 25) : [],
        selfEvaluation: evidence.mark,
        selfEvaluationConfirmed: question.selfEvaluationConfirmed === true,
        reviewMarkVerified: true,
        reviewEvaluationSource: evidence.method,
        selfEvaluationRaw: question.selfEvaluationRaw,
        evaluationSource: question.evaluationSource,
        answerCorrectness: question.answerCorrectness,
        explanation: String(question.explanation || "").slice(0, 30000),
        images: Array.isArray(question.images) ? question.images.slice(0, 12).map(function (img) {
          return { url: typeof img === "string" ? img : img && img.url || "" };
        }).filter(function (img) { return /^https:\/\//.test(img.url); }) : [],
        subjectContext: question.subjectContext || null,
        url: question.url,
        position: question.position
      }
    };
  }

  function publishReviewQuestion(question, force) {
    try {
      var packet = makeReviewPacket(question);
      if (!packet) return;
      var fingerprint = JSON.stringify(packet.question);
      var id = packet.question.problemNumber;
      if (!force && reviewPublished[id] === fingerprint) return;
      reviewPublished[id] = fingerprint;
      var payload = JSON.stringify(packet);
      if (payload.length > 240000) return;
      // ロード順が異なるときのために最後の1問のみ一時保管する。
      try { localStorage.setItem(REVIEW_BRIDGE_KEY, payload); } catch (_err) {}
      if (typeof window.__montreReviewIntegratedIngest === "function") {
        window.__montreReviewIntegratedIngest(payload);
        return;
      }
      window.dispatchEvent(new CustomEvent("montre-review:question", { detail: payload }));
      window.postMessage(payload, location.origin);
    } catch (_error) {
      // 復習連携が失敗してもAnki用問題取得を止めない。
    }
  }

  function announceReviewStatus(phase) {
    try {
      var cached = Object.values(state.questionCache || {});
      var eligible = cached.filter(function (question) {
        return Boolean(makeReviewPacket(question));
      }).length;
      var payload = JSON.stringify({
        kind: "montre-review-status-v2",
        version: VERSION, phase: phase || "ready",
        cacheTotal: cached.length, eligible: eligible,
        explicit: cached.filter(function (q) { var p = makeReviewPacket(q); return p && p.question.reviewEvaluationSource === "explicit"; }).length,
        inferred: cached.filter(function (q) { var p = makeReviewPacket(q); return p && p.question.reviewEvaluationSource === "answer-comparison"; }).length,
        active: true
      });
      if (typeof window.__montreReviewIntegratedStatus === "function") {
        window.__montreReviewIntegratedStatus(payload);
        return;
      }
      window.postMessage(payload, location.origin);
      window.dispatchEvent(new CustomEvent("montre-review:status", {detail: payload}));
    } catch (_error) {
      // 診断情報でAnki本体を停止させない。
    }
  }

  function replayReviewCache() {
    announceReviewStatus("sync-started");
    if (reviewReplayActive) return;
    reviewReplayActive = true;
    var saved = Object.values(state.questionCache || {});
    var index = 0;
    function batch() {
      var end = Math.min(index + 12, saved.length);
      for (; index < end; index += 1) publishReviewQuestion(saved[index], true);
      if (index < saved.length) setTimeout(batch, 80);
      else {
        reviewReplayActive = false;
        announceReviewStatus("sync-finished");
      }
    }
    batch();
  }

  function installReviewBridge() {
    window.__montreReviewIntegratedRequest = replayReviewCache;
    window.addEventListener("montre-review:sync-request", replayReviewCache);
    window.addEventListener("message", function (event) {
      if (event.source !== window || event.origin !== location.origin ||
          typeof event.data !== "string" || event.data.length > 2000) return;
      try {
        if (JSON.parse(event.data).kind === "montre-review-sync-request-v1") replayReviewCache();
      } catch (_error) {}
    });
    announceReviewStatus("ready");
    try {
      window.dispatchEvent(new CustomEvent("montre-review:anki-ready"));
      window.postMessage(JSON.stringify({ kind: "montre-review-ready-v1" }), location.origin);
    } catch (_error) {}
  }

  function captureCurrentQuestion() {
    if (exportRunning) return;
    currentContext = detectContext(document, location.href);
    currentQuestion = extractQuestion(document, location.href);
    if (!currentQuestion) {
      currentSession = state.pendingSessionId ?
        state.sessions.find(function (session) {
          return session.id === state.pendingSessionId && session.status !== "completed";
        }) || null : null;
      if (!currentSession) {
        currentSession = state.sessions.slice().reverse().find(function (session) {
          return session.status !== "completed";
        }) || null;
      }
      if (currentSession) {
        var recoveredContext = contextFromSessionSearchUrl(currentSession);
        if (recoveredContext) {
          currentSession.division = recoveredContext.division;
          currentSession.subject = recoveredContext.subject;
          currentSession.subjectSource = recoveredContext.source;
          currentSession.subjectKey = sessionSubjectKey(
            recoveredContext,
            currentSession.expectedTotal
          );
          currentContext = recoveredContext;
          saveState(false);
        } else if (!currentContext && currentSession.division && currentSession.subject) {
          currentContext = {
            division: currentSession.division,
            subject: currentSession.subject,
            source: currentSession.subjectSource || "active-session"
          };
        }
      }
      scheduleRender();
      return;
    }
    if (currentQuestion.subjectContext) {
      currentContext = {
        division: currentQuestion.subjectContext.division,
        subject: currentQuestion.subjectContext.subject,
        source: currentQuestion.subjectContext.acquisitionSource,
        confidence: currentQuestion.subjectContext.confidence,
        categoryId: currentQuestion.subjectContext.categoryId
      };
    }
    currentSession = null;
    ensureSession(currentQuestion, currentContext, { allowCreate: true });
    state.questionCache[currentQuestion.problemNumber] = currentQuestion;
    saveState(false);
    publishReviewQuestion(currentQuestion, false);
    scheduleRender();
  }

  function findSessionStartUrl(session) {
    var refs = (session.questionRefs || []).slice();

    // 旧版で別演習が同じセッションへ混入した場合、position=1 が複数残ることがある。
    // その場合は updatedAt が最も新しい1問目を現在の演習の起点として採用する。
    var firstRefs = refs.filter(function (ref) {
      return ref.position === 1 && ref.url;
    }).sort(function (a, b) {
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    if (firstRefs.length) return firstRefs[0].url;

    refs.sort(function (a, b) {
      var positionDiff = (a.position || 99999) - (b.position || 99999);
      if (positionDiff) return positionDiff;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    return refs[0] ? refs[0].url : null;
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }

  async function fetchQuestionPage(url) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 20000);
    try {
    var response = await fetch(url, {
      signal: controller.signal,
      method: "GET",
      credentials: "include",
      headers: { "Accept": "text/html,application/xhtml+xml" }
    });
    if (!response.ok) throw new Error("問題ページ取得失敗: HTTP " + response.status);
    var html = await response.text();
    return parseHtml(html);
    } finally { clearTimeout(timeout); }
  }

  function validateExportQuestions(questions, session) {
    var errors = [];
    if (!session.expectedTotal) errors.push("予定問題数を取得できません");
    if (session.expectedTotal && questions.length !== session.expectedTotal) {
      errors.push("予定" + session.expectedTotal + "問に対して" + questions.length + "問しか取得できませんでした");
    }
    var ids = new Set();
    var positions = new Set();
    questions.forEach(function (question) {
      if (!question.problemNumber) errors.push("問題番号なし");
      if (question.problemNumber && ids.has(question.problemNumber)) {
        errors.push("問題番号" + question.problemNumber + "が重複");
      }
      ids.add(question.problemNumber);
      if (!Number.isInteger(question.position) || question.position < 1) errors.push("問題" + question.problemNumber + "の問目が不明");
      else if (positions.has(question.position)) errors.push(question.position + "問目が重複");
      positions.add(question.position);
      if (!question.subjectContext || !question.subjectContext.division || !question.subjectContext.subject) {
        errors.push("問題" + (question.problemNumber || "?") + "の科目なし");
      }
      if (!question.questionText) errors.push("問題" + (question.problemNumber || "?") + "の問題文なし");
      if (!question.choices || !question.choices.length) errors.push("問題" + (question.problemNumber || "?") + "の選択肢なし");
      if (!question.correctAnswer || !question.correctAnswer.length) {
        errors.push("問題" + (question.problemNumber || "?") + "の正答なし");
      }
      if (!question.explanation) errors.push("問題" + (question.problemNumber || "?") + "の解説なし");
      if (!question.selfEvaluation) errors.push("問題" + (question.problemNumber || "?") + "の自己評価なし");
    });
    return Array.from(new Set(errors));
  }

  function groupRecoveryCandidates(question) {
    var group = question.questionGroup;
    if (!group || !Number.isInteger(question.position) || !question.nextQuestionUrl) return [];
    var current = new URL(question.url), next = new URL(question.nextQuestionUrl, question.url);
    // Only use numeric IDs from the two surrounding page URLs, never infer problem numbers.
    var firstId = current.pathname.match(/\/practice_questions\/(\d+)$/);
    var nextId = next.pathname.match(/\/practice_questions\/(\d+)$/);
    var remaining = group.count - group.index;
    if (!firstId || !nextId || current.origin !== next.origin || remaining < 1 ||
        Number(nextId[1]) - Number(firstId[1]) !== remaining + 1) return [];
    var candidates = [];
    for (var offset = 1; offset <= remaining; offset += 1) {
      var candidate = new URL(current.href);
      candidate.pathname = current.pathname.replace(/\d+$/, String(Number(firstId[1]) + offset));
      candidate.hash = "";
      candidates.push({ url: candidate.href, position: question.position + offset,
        total: question.total, groupIndex: group.index + offset, groupCount: group.count });
    }
    return candidates;
  }

  async function crawlSessionQuestions(session, range) {
    var startUrl = findSessionStartUrl(session);
    if (!startUrl) throw new Error("問題ページを一度開いてから実行してください");
    var results = [];
    function showProgress() {
      var total = range ? range.count : session.expectedTotal;
      var scope = range ? "（" + range.start + "〜" + range.end + "問目）" : "";
      setStatus("問題取得中 " + results.length + " / " + (total || "?") + "問" + scope, "info");
    }
    var seenUrls = new Set();
    var seenIds = new Set();
    var queue = [];
    var failures = [];
    var recoveries = new Map();
    var attempts = new Map();
    var limit = Math.max(Number(session.expectedTotal || 0) * 2 + 10, 500);
    function enqueue(value) {
      if (!value) return;
      var parsed;
      try { parsed = new URL(value, location.href); } catch (_error) { return; }
      if (parsed.origin !== location.origin || !/\/practice_questions\/\d+/.test(parsed.pathname)) return;
      parsed.hash = "";
      if (!seenUrls.has(parsed.href) && queue.indexOf(parsed.href) < 0) queue.push(parsed.href);
    }
    enqueue(startUrl);
    (session.questionRefs || []).forEach(function (ref) {
      if (!range || !Number.isInteger(ref.position) || (ref.position >= range.start && ref.position <= range.end)) enqueue(ref.url);
    });
    while (queue.length && seenUrls.size < limit) {
      var url = queue.shift();
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      showProgress();
      try {
        var liveUrl = new URL(location.href);
        liveUrl.hash = "";
        var doc = url === liveUrl.href ? document : await fetchQuestionPage(url);
        var pageQuestions = extractQuestionsFromPage(doc, url);
        if (!pageQuestions.length) throw new Error("問題を抽出できません（ログイン状態・連問のページ形式を確認）");
        var expectedRecovery = recoveries.get(url);
        if (expectedRecovery && !pageQuestions.some(function (q) {
          return q.position === expectedRecovery.position && q.total === expectedRecovery.total &&
            q.questionGroup && q.questionGroup.index === expectedRecovery.groupIndex &&
            q.questionGroup.count === expectedRecovery.groupCount;
        })) {
          throw new Error("連問" + expectedRecovery.position + "問目への読取が別の問題に戻されました。欠落のまま明示します");
        }
        pageQuestions.forEach(function (question) {
          groupRecoveryCandidates(question).forEach(function (candidate) {
            if (range && (candidate.position < range.start || candidate.position > range.end)) return;
            if (!results.some(function (q) { return q.position === candidate.position; })) {
              recoveries.set(candidate.url, candidate);
              enqueue(candidate.url);
            }
          });
          var inRange = !range || (Number.isInteger(question.position) &&
            question.position >= range.start && question.position <= range.end);
          if (inRange && !seenIds.has(question.problemNumber)) {
            seenIds.add(question.problemNumber);
            question.acquisition = {
              answerAvailable: Boolean(question.correctAnswer && question.correctAnswer.length),
              explanationAvailable: Boolean(question.explanation),
              evaluationAvailable: Boolean(question.selfEvaluation),
              needsReview: !question.correctAnswer.length || !question.explanation || !question.selfEvaluation
            };
            results.push(question);
            showProgress();
            state.questionCache[question.problemNumber] = question;
          }
          if (!range || !Number.isInteger(question.position) || question.position > range.start) enqueue(question.previousQuestionUrl);
          if (!range || !Number.isInteger(question.position) || question.position < range.end) enqueue(question.nextQuestionUrl);
        });
        // 連問や問題一覧への実在リンクも拾う。URLの数値を推測して生成しない。
        Array.from(doc.querySelectorAll("a[href*='/practice_questions/']")).forEach(function (anchor) {
          var label = oneLine(elementText(anchor));
          var positionMatch = label.match(/^(?:第)?(\d+)\s*問目?$/u);
          if (!range || (positionMatch && Number(positionMatch[1]) >= range.start && Number(positionMatch[1]) <= range.end)) {
            enqueue(absoluteUrl(anchor.getAttribute("href"), url));
          }
        });
        if (range && results.length === range.count) break;
      } catch (error) {
        var tried = (attempts.get(url) || 0) + 1;
        attempts.set(url, tried);
        if (tried < 2 && !recoveries.has(url)) {
          seenUrls.delete(url);
          queue.push(url);
        } else {
          failures.push({ url: url, position: recoveries.has(url) ? recoveries.get(url).position : null,
            message: error.message || String(error) });
        }
      }
      if (queue.length) await sleep(140);
    }
    if (queue.length && seenUrls.size >= limit) failures.push({ message: "取得上限に到達したため巡回を停止しました" });
    results.sort(function (a, b) { return (a.position || 99999) - (b.position || 99999); });
    results.acquisitionFailures = failures;
    saveState(true);
    return results;
  }

  function buildExportPayload(session, questions, range) {
    var includedIds = new Set(questions.map(function (question) { return question.problemNumber; }));
    var sessionClassification = buildClassification(session.division, session.subject);
    var manualCandidates = activeCandidatesForSession(session.id).filter(function (candidate) {
      return !range || includedIds.has(candidate.problemNumber);
    }).map(function (candidate) {
      var copy = Object.assign({}, candidate);
      var candidateClassification = candidate.classification || buildClassification(
        candidate.largeCategory || candidate.division,
        candidate.category || candidate.subject
      );
      copy.largeCategory = copy.largeCategory || copy.division;
      copy.category = copy.category || copy.subject;
      copy.classification = candidateClassification;
      copy.ankiTags = candidateClassification.ankiTags;
      return copy;
    });
    var overrides = state.automaticOverrides.filter(function (entry) {
      return entry.sessionId === session.id && !entry.deletedAt && (!range || includedIds.has(entry.problemNumber));
    }).map(function (entry) {
      return Object.assign({}, entry);
    });
    var decisions = questions.map(function (question) {
      return {
        problemNumber: question.problemNumber,
        automaticCardId: question.automaticCardId,
        selfEvaluation: question.selfEvaluation,
        decision: questionDecision(question, session.id)
      };
    });
    return {
      schemaVersion: "Montore_Anki_Inbox_v1",
      source: "モントレ",
      generatedAt: nowIso(),
      generator: {
        name: APP_NAME,
        version: VERSION
      },
      subjectContext: {
        largeCategory: session.division,
        category: session.subject,
        division: session.division,
        subject: session.subject,
        sitePath: sessionClassification.sitePath,
        acquisitionSource: session.subjectSource
      },
      classification: sessionClassification,
      ankiTags: sessionClassification.ankiTags,
      exerciseSession: {
        id: session.id,
        startedAt: session.startedAt,
        completedAt: nowIso(),
        expectedTotal: session.expectedTotal,
        acquiredTotal: questions.length,
        studyCheckpoint: session.studyCheckpoint || null,
        searchUrl: session.searchUrl,
        selectionClassification: sessionClassification,
        status: "completed"
      },
      questions: questions,
      manualCandidates: {
        candidates: manualCandidates
      },
      automaticCardOverrides: {
        entries: overrides
      },
      cardDecisions: decisions
    };
  }

  function downloadJson(payload, fileName) {
    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function exportManualBackup() {
    if (hasUnsavedDraft()) {
      try {
        saveDraftCandidates();
      } catch (error) {
        setStatus(error.message || String(error), "error");
        return;
      }
    }
    var payload = {
      schemaVersion: "Montore_Anki_Backup_v2",
      exportType: "backup",
      note: "保管用。questionsは閲覧時のキャッシュのみ。Anki作成には「問題データのダウンロード」を使用。",
      questions: Object.keys(state.questionCache).map(function (id) { return state.questionCache[id]; }),
      source: "モントレ",
      generatedAt: nowIso(),
      generator: { name: APP_NAME, version: VERSION },
      sessions: state.sessions,
      manualSequences: state.manualSequences,
      manualCandidates: {
        candidates: state.candidates.filter(function (candidate) { return !candidate.deletedAt; }).map(function (candidate) {
          var copy = Object.assign({}, candidate);
          var classification = candidate.classification || buildClassification(
            candidate.largeCategory || candidate.division,
            candidate.category || candidate.subject
          );
          copy.largeCategory = copy.largeCategory || copy.division;
          copy.category = copy.category || copy.subject;
          copy.classification = classification;
          copy.ankiTags = classification.ankiTags;
          return copy;
        })
      },
      automaticCardOverrides: {
        entries: state.automaticOverrides.filter(function (entry) { return !entry.deletedAt; })
      }
    };
    downloadJson(payload, "montre_BACKUP_" + nowIso().replace(/[:.]/g, "-") + ".json");
    setStatus("保管用バックアップを保存しました。Anki作成には上の「問題データのダウンロード」を押してください", "info");
  }

  function checkpointSummary(session) {
    var point = session && session.studyCheckpoint;
    if (!point) return "区切りは未記録";
    var next = session.expectedTotal && point.position >= session.expectedTotal ?
      "最終問まで記録" : "次回開始目安：" + (point.position + 1) + "問目";
    return "区切り：" + point.position + "問目 ／ " + next +
      " ／ データ確認済み：" + (session.verifiedExportThrough || 0) + "問目まで";
  }

  async function recordCheckpointAndExport() {
    if (exportRunning) return;
    captureCurrentQuestion();
    var session = currentSession, question = currentQuestion;
    if (!session || !question || !Number.isInteger(question.position) || question.position < 1) {
      setStatus("問題ページを開いてから押してください", "error");
      return;
    }
    var through = Number(session.verifiedExportThrough || 0);
    var end = question.position;
    var start = through < end ? through + 1 : 1;
    session.studyCheckpoint = {
      position: Math.max(end, Number(session.studyCheckpoint && session.studyCheckpoint.position || 0)),
      clickedPosition: end, problemNumber: question.problemNumber,
      url: question.url, recordedAt: nowIso(), source: "user_checkpoint_button"
    };
    saveState(true);
    ui.rangeStart.value = start;
    ui.rangeEnd.value = end;
    render();
    await exportAllQuestions();
  }

  function parseExportRange(startValue, endValue, total) {
    var first = String(startValue || "").trim();
    var last = String(endValue || "").trim();
    if (!first && !last) return null;
    if (!/^\d+$/.test(first) || !/^\d+$/.test(last)) {
      throw new Error("開始・終了の両方に1以上の整数を入力してください");
    }
    var start = Number(first), end = Number(last);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error("1 ≦ 開始 ≦ 終了となる範囲を入力してください");
    }
    if (total && end > total) throw new Error("終了は全" + total + "問以内で指定してください");
    return { start: start, end: end, count: end - start + 1 };
  }

  async function exportAllQuestions() {
    if (exportRunning) return;
    if (!currentSession) {
      setStatus("現在の演習セッションがありません", "error");
      return;
    }
    if (hasUnsavedDraft()) {
      try {
        saveDraftCandidates();
      } catch (error) {
        setStatus(error.message || String(error), "error");
        return;
      }
    }
    if (!currentSession.division || !currentSession.subject) {
      setStatus("⚠ 分類を自動取得できません。手動設定してください", "error");
      return;
    }
    var range;
    try {
      range = parseExportRange(ui.rangeStart.value, ui.rangeEnd.value, currentSession.expectedTotal);
    } catch (error) {
      setStatus(error.message, "error");
      return;
    }
    exportRunning = true;
    render();
    try {
      var session = currentSession;
      var questions = await crawlSessionQuestions(session, range);
      var errors = validateExportQuestions(questions,
        range ? Object.assign({}, session, { expectedTotal: range.count }) : session);
      var missingPositions = [];
      if (range || session.expectedTotal) {
        var positions = new Set(questions.map(function (q) { return q.position; }));
        for (var position = range ? range.start : 1; position <= (range ? range.end : session.expectedTotal); position += 1) {
          if (!positions.has(position)) missingPositions.push(position);
        }
        if (missingPositions.length) errors.push("未取得の問目: " + missingPositions.join(", "));
      }
      var failures = questions.acquisitionFailures || [];
      var payload = buildExportPayload(session, questions, range);
      payload.exportScope = range ? {
        mode: "range", start: range.start, end: range.end,
        expectedTotal: range.count, acquiredTotal: questions.length,
        missingPositions: missingPositions
      } : { mode: "all", expectedTotal: session.expectedTotal, acquiredTotal: questions.length, missingPositions: missingPositions };
      payload.exportType = "anki_questions";
      var contentCount = questions.filter(function (q) { return q.questionText && q.choices && q.choices.length; }).length;
      payload.exportValidation = {
        missingPositions: missingPositions,
        questionsWithTextAndChoices: contentCount,
        selfEvaluationUnconfirmed: questions.filter(function (q) { return !q.selfEvaluationConfirmed; }).map(function (q) { return q.position; }),
        complete: errors.length === 0 && failures.length === 0,
        warnings: errors,
        acquisitionFailures: failures,
        note: "未演習・取得不足も保存。空欄の正答・解説・自己評価は推測して補完しない。"
      };
      payload.exerciseSession.status = !range && payload.exportValidation.complete ? "completed" : "partial";
      payload.exerciseSession.completedAt = !range && payload.exportValidation.complete ? nowIso() : null;
      var safeSubject = (currentSession.division + "_" + currentSession.subject)
        .replace(/[\\/:*?"<>|\s]+/g, "_");
      var fileName = "montre_anki_" + safeSubject + (range ? "_" + range.start + "-" + range.end + "問" : "") + "_" +
        nowIso().replace(/[:.]/g, "-") + ".json";
      downloadJson(payload, fileName);
      var exportedAt = nowIso();
      var exportedCandidateIds = new Set(payload.manualCandidates.candidates.map(function (candidate) { return candidate.id; }));
      activeCandidatesForSession(currentSession.id).forEach(function (candidate) {
        if (exportedCandidateIds.has(candidate.id) && !candidate.exportedAt) candidate.exportedAt = exportedAt;
      });
      currentSession.status = payload.exerciseSession.status;
      currentSession.completedAt = payload.exerciseSession.completedAt;
      currentSession.exportedAt = exportedAt;
      currentSession.exportedFileName = fileName;
      var exportStart = range ? range.start : 1;
      var exportEnd = range ? range.end : Number(session.expectedTotal || 0);
      if (!Array.isArray(session.exportHistory)) session.exportHistory = [];
      var dataComplete = failures.length === 0 && questions.length === (range ? range.count : session.expectedTotal) &&
        questions.every(function (q) { return q.questionText && q.choices.length && q.correctAnswer.length && q.explanation; }) &&
        (!range || missingPositions.length === 0);
      session.exportHistory.push({
        start: exportStart, end: exportEnd, acquiredTotal: questions.length,
        complete: payload.exportValidation.complete, dataComplete: dataComplete, fileName: fileName, exportedAt: exportedAt
      });
      // 不足ありの出力を飛ばして次の範囲へ進めない。
      var through = Number(session.verifiedExportThrough || 0);
      var advanced = true;
      while (advanced) {
        advanced = false;
        session.exportHistory.forEach(function (entry) {
          if ((entry.dataComplete || entry.complete) && entry.start <= through + 1 && entry.end > through) {
            through = entry.end; advanced = true;
          }
        });
      }
      session.verifiedExportThrough = through;
      state.pendingSessionId = !range && payload.exportValidation.complete ? null : currentSession.id;
      saveState(true);
      setStatus(questions.length + "問を出力／問題文・選択肢あり " + contentCount + "問" +
        (missingPositions.length ? "（未取得：" + missingPositions.join("・") + "問目）" :
          payload.exportValidation.complete ? "" : "（正答・解答記録などに不足あり）"),
        payload.exportValidation.complete ? "success" : "info");
    } catch (error) {
      setStatus("JSON取得を完了できません: " + (error.message || String(error)), "error");
    } finally {
      exportRunning = false;
      render();
    }
  }

  function setManualContext() {
    var division = ui.manualDivision ? ui.manualDivision.value.trim() : "";
    var subject = ui.manualSubject ? ui.manualSubject.value.trim() : "";
    if (!division || !subject) {
      setStatus("モントレの大分類と問題分類の両方を入力してください", "error");
      return;
    }
    state.settings.manualDivision = division;
    state.settings.manualSubject = subject;
    state.pendingContext = {
      division: division,
      subject: subject,
      source: "manual-setting",
      capturedAt: nowIso()
    };
    if (currentQuestion) {
      currentQuestion.subjectContext = {
        division: division,
        subject: subject,
        acquisitionSource: "manual-setting",
        confidence: "manual"
      };
      currentContext = state.pendingContext;
      currentSession = null;
      ensureSession(currentQuestion, currentContext, { allowCreate: true });
    }
    saveState(true);
    render();
    setStatus("科目を手動設定しました", "success");
  }

  function retryContext() {
    state.settings.manualDivision = "";
    state.settings.manualSubject = "";
    currentContext = detectContext(document, location.href);
    if (currentQuestion) {
      var fresh = extractQuestion(document, location.href);
      if (fresh) {
        currentQuestion = fresh;
        state.questionCache[fresh.problemNumber] = fresh;
        currentSession = null;
        ensureSession(fresh, currentContext, { allowCreate: true });
      }
    }
    saveState(true);
    render();
    if (currentContext) setStatus("ページから科目を再取得しました", "success");
    else setStatus("⚠ 分類を自動取得できません", "error");
  }

  function startPendingSessionFromSearch() {
    var context = detectContext(document, location.href);
    var headingText = getDocumentText(document);
    var totalMatch = headingText.match(/(?:^|\n)(?:.+?)\s+(\d+)\s*問(?:\n|$)/u);
    var total = totalMatch ? Number(totalMatch[1]) : null;
    if (!context) {
      setStatus("⚠ 分類を自動取得できません。先に手動設定してください", "error");
      return false;
    }

    // 「演習を始める」を押した時点で必ず新しいセッションを作る。
    // 以前の未完了セッションや手動候補は履歴として残し、混ぜない。
    currentSession = null;
    var previousPendingSessionId = state.pendingSessionId;
    state.pendingSessionId = null;
    ensureSession(null, context, {
      allowCreate: true,
      total: total,
      startedAt: nowIso(),
      searchUrl: location.href
    });
    if (!currentSession) {
      state.pendingSessionId = previousPendingSessionId;
      setStatus("新しい演習セッションを作成できません", "error");
      return false;
    }

    state.pendingContext = Object.assign({}, context, { capturedAt: nowIso() });
    state.pendingSessionId = currentSession.id;
    saveState(true);
    return true;
  }

  function handleNavigationClick(event) {
    var target = event.target && event.target.closest ?
      event.target.closest("a,button,input[type='submit']") : null;
    if (!target) return;
    var text = oneLine(elementText(target) || target.value);
    if (/演習を始める|シャッフルして始める/u.test(text)) {
      if (!startPendingSessionFromSearch()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (!/次の問題/u.test(text)) return;
    try {
      if (hasUnsavedDraft()) saveDraftCandidates();
      if (currentQuestion) {
        state.questionCache[currentQuestion.problemNumber] = extractQuestion(document, location.href) || currentQuestion;
        saveState(true);
      }
    } catch (error) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setStatus("⚠ " + (error.message || String(error)), "error");
    }
  }

  function handleCategoryClick(event) {
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    var href = absoluteUrl(anchor.getAttribute("href"), location.href);
    var categoryMatch = href.match(/[?&]category_id=(\d+)/);
    if (categoryMatch && state.categoryMap[categoryMatch[1]]) {
      state.pendingContext = Object.assign({}, state.categoryMap[categoryMatch[1]], {
        capturedAt: nowIso()
      });
      saveState(true);
      return;
    }
    var largeMatch = href.match(/[?&]large_category_ids(?:%5B%5D|\[\])=(\d+)/i);
    if (largeMatch && state.largeCategoryMap[largeMatch[1]]) {
      state.pendingContext = {
        division: state.largeCategoryMap[largeMatch[1]],
        subject: "全範囲",
        largeCategoryId: largeMatch[1],
        source: "clicked-large-category",
        capturedAt: nowIso()
      };
      saveState(true);
    }
  }

  function handleShortcut(event) {
    if (!(event.altKey && event.code === "KeyA")) return;
    if (isEditable(event.target)) return;
    event.preventDefault();
    var selection = normalizeText(String(window.getSelection ? window.getSelection() : ""));
    if (selection && ui.textarea) {
      ui.textarea.value = [ui.textarea.value.trim(), selection].filter(Boolean).join("\n");
      syncDraftFromUi();
      setStatus("選択文字を追加箱へ取り込みました", "success");
    }
    if (lastHoveredImage) addHoveredImage();
    if (!selection && !lastHoveredImage) {
      setStatus("文字を選択するか、画像へマウスを重ねてください", "info");
    }
  }

  function createStyles() {
    var style = document.createElement("style");
    style.id = "montre-anki-inbox-style";
    style.textContent = [
      "#montre-anki-toggle{position:fixed;left:14px;bottom:14px;z-index:2147483645;border:0;border-radius:22px;padding:10px 15px;background:linear-gradient(135deg,#0756d8,#09a8c8);color:#fff;font-weight:700;box-shadow:0 5px 18px rgba(0,0,0,.25);cursor:pointer;font-size:13px}",
      "#montre-anki-panel{position:fixed;z-index:2147483646;background:#f7fbff;color:#17324d;border:1px solid #8bc8e8;border-radius:12px;box-shadow:0 12px 35px rgba(18,54,86,.28);font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans JP',sans-serif;overflow:hidden;min-width:310px;min-height:320px;max-width:calc(100vw - 12px);max-height:calc(100vh - 12px)}",
      "#montre-anki-panel *{box-sizing:border-box}",
      ".mai-head{height:42px;padding:8px 10px;background:linear-gradient(135deg,#0756d8,#08a9c8);color:#fff;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none}",
      ".mai-head strong{font-size:14px}.mai-version{font-size:11px;opacity:.9}.mai-close{border:0;background:transparent;color:#fff;font-size:20px;cursor:pointer}",
      ".mai-body{height:calc(100% - 42px);overflow:auto;padding:10px}",
      ".mai-card{background:#fff;border:1px solid #d7e9f4;border-radius:9px;padding:9px;margin-bottom:8px}",
      ".mai-title{font-weight:800;color:#006eae;margin-bottom:5px}",
      ".mai-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:12px}",
      ".mai-muted{color:#6b7f90}.mai-warning{color:#b54708;font-weight:700}",
      ".mai-input,.mai-textarea{width:100%;border:1px solid #a9cfe3;border-radius:6px;padding:7px;background:#fff;color:#17324d}",
      ".mai-textarea{min-height:74px;resize:vertical}",
      ".mai-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
      ".mai-btn{border:0;border-radius:7px;padding:7px 9px;background:#e1f3fb;color:#075b8b;font-weight:700;cursor:pointer;font-size:12px}",
      ".mai-btn.primary{background:linear-gradient(135deg,#0756d8,#08a9c8);color:#fff}",
      ".mai-btn.danger{background:#fff0f0;color:#b42318}.mai-btn.active{background:#ffedf6;color:#c21868}",
      ".mai-btn:disabled{opacity:.5;cursor:wait}",
      ".mai-status{display:none;padding:7px;border-radius:6px;margin-bottom:8px;font-size:12px}.mai-status.info{display:block;background:#eaf5ff;color:#075b8b}.mai-status.success{display:block;background:#e9f9ef;color:#18753b}.mai-status.error{display:block;background:#fff0f0;color:#b42318}",
      ".mai-candidate{border-top:1px solid #e2edf4;padding:7px 0}.mai-candidate:first-child{border-top:0}",
      ".mai-candidate-id{font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#698091;word-break:break-all}",
      ".mai-image-list{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.mai-image{position:relative;width:62px;height:62px;border:1px solid #bad5e5;border-radius:6px;overflow:hidden;background:#eef6fa}.mai-image img{width:100%;height:100%;object-fit:cover}.mai-image button{position:absolute;right:1px;top:1px;border:0;border-radius:50%;width:20px;height:20px;background:#b42318;color:#fff;cursor:pointer}",
      ".mai-drop{border:1px dashed #69add0;border-radius:7px;padding:7px;text-align:center;color:#55798e;margin:6px 0}",
      ".mai-past summary{cursor:pointer;font-weight:700}.mai-past details{padding:5px 0;border-top:1px solid #e2edf4}",
      ".mai-resize{position:absolute;z-index:4}.mai-resize.n{top:-3px;left:9px;right:9px;height:7px;cursor:n-resize}.mai-resize.s{bottom:-3px;left:9px;right:9px;height:7px;cursor:s-resize}.mai-resize.e{right:-3px;top:9px;bottom:9px;width:7px;cursor:e-resize}.mai-resize.w{left:-3px;top:9px;bottom:9px;width:7px;cursor:w-resize}.mai-resize.nw{left:-3px;top:-3px;width:12px;height:12px;cursor:nw-resize}.mai-resize.ne{right:-3px;top:-3px;width:12px;height:12px;cursor:ne-resize}.mai-resize.sw{left:-3px;bottom:-3px;width:12px;height:12px;cursor:sw-resize}.mai-resize.se{right:-3px;bottom:-3px;width:12px;height:12px;cursor:se-resize}",
      "@media(max-width:600px){#montre-anki-panel{min-width:280px}.mai-body{padding:7px}}"
    ].join("\n");
    document.head.appendChild(style);
  }

  function createUi() {
    if (document.getElementById("montre-anki-panel")) return;
    createStyles();
    var toggle = document.createElement("button");
    toggle.id = "montre-anki-toggle";
    toggle.type = "button";
    toggle.addEventListener("click", function () {
      state.settings.panelOpen = true;
      saveState(true);
      render();
    });
    document.body.appendChild(toggle);
    ui.toggle = toggle;

    var panel = document.createElement("section");
    panel.id = "montre-anki-panel";
    panel.innerHTML =
      "<div class='mai-head' id='mai-drag'>" +
        "<div><strong>Anki追加箱</strong> <span class='mai-version'>モントレ v" + VERSION + "</span></div>" +
        "<button class='mai-close' type='button' aria-label='閉じる'>×</button>" +
      "</div>" +
      "<div class='mai-body'>" +
        "<div class='mai-status' id='mai-status'></div>" +
        "<div id='mai-current'></div>" +
        "<div class='mai-card' id='mai-manual-card'>" +
          "<div class='mai-title'>手動候補</div>" +
          "<textarea class='mai-textarea' id='mai-textarea' placeholder='覚えたいこと（1行＝1候補）'></textarea>" +
          "<div class='mai-drop' id='mai-drop'>画像をドロップ／⌘V・Ctrl+V／画像上でOption・Alt+A</div>" +
          "<div class='mai-image-list' id='mai-draft-images'></div>" +
          "<label><input type='checkbox' id='mai-also-auto'> この問題は自動カードも作る</label>" +
          "<div class='mai-row' style='margin-top:7px'>" +
            "<button class='mai-btn primary' id='mai-save' type='button'>候補を保存</button>" +
            "<button class='mai-btn' id='mai-page-image' type='button'>ページ画像を追加</button>" +
            "<button class='mai-btn' id='mai-force-auto' type='button'>○・◎でも自動カード化</button>" +
          "</div>" +
        "</div>" +
        "<div id='mai-subject-fallback'></div>" +
        "<div class='mai-card'>" +
          "<div class='mai-title'>この演習の候補</div>" +
          "<div id='mai-candidates'></div>" +
        "</div>" +
        "<div class='mai-card'>" +
          "<div class='mai-title'>途中の区切りを記録</div>" +
          "<div id='mai-checkpoint-info' class='mai-muted' style='margin-bottom:6px'></div>" +
          "<button class='mai-btn primary' id='mai-checkpoint-export' type='button' style='width:100%;margin-bottom:6px'>表示中の問題まで保存して、中断位置を記録</button>" +
          "<div class='mai-muted' style='margin-bottom:10px'>表示中の問題までを取得。初回は1問目から、次回はデータ確認済みの続きから。未回答でも押した位置を区切りとして記録します。</div>" +
          "<div class='mai-title'>問題データのダウンロード</div>" +
          "<div class='mai-row' style='margin-bottom:6px'>" +
          "<label style='flex:1'>開始（問目）<input class='mai-input' id='mai-range-start' type='number' min='1' step='1' placeholder='例：20'></label>" +
          "<label style='flex:1'>終了（問目）<input class='mai-input' id='mai-range-end' type='number' min='1' step='1' placeholder='例：40'></label></div>" +
          "<div class='mai-muted' style='margin-bottom:6px'>開始1・終了50なら、1〜50問だけを保存。問題文・選択肢・正答・解説・解答記録・手動候補をJSON形式で保存します。両方空欄なら全問。</div>" +
          "<button class='mai-btn primary' id='mai-export' type='button' style='width:100%'>指定した範囲をダウンロード</button>" +
          "<details style='margin-top:10px'><summary>保管用バックアップ（通常のAnki作成には使わない）</summary>" +
          "<button class='mai-btn' id='mai-manual-export' type='button' style='width:100%;margin-top:6px'>保存済みデータをバックアップ</button></details>" +
          "<div class='mai-muted' style='margin-top:5px'>演習内の問題ページから取得できます。未演習・取得不足もJSONに保存します。</div>" +
        "</div>" +
        "<div class='mai-card mai-past'><div class='mai-title'>過去の演習</div><div id='mai-history'></div></div>" +
      "</div>" +
      "<i class='mai-resize n' data-edge='n'></i><i class='mai-resize s' data-edge='s'></i>" +
      "<i class='mai-resize e' data-edge='e'></i><i class='mai-resize w' data-edge='w'></i>" +
      "<i class='mai-resize nw' data-edge='nw'></i><i class='mai-resize ne' data-edge='ne'></i>" +
      "<i class='mai-resize sw' data-edge='sw'></i><i class='mai-resize se' data-edge='se'></i>";
    document.body.appendChild(panel);
    ui.panel = panel;
    ui.status = panel.querySelector("#mai-status");
    ui.current = panel.querySelector("#mai-current");
    ui.textarea = panel.querySelector("#mai-textarea");
    ui.drop = panel.querySelector("#mai-drop");
    ui.draftImages = panel.querySelector("#mai-draft-images");
    ui.alsoAuto = panel.querySelector("#mai-also-auto");
    ui.save = panel.querySelector("#mai-save");
    ui.pageImage = panel.querySelector("#mai-page-image");
    ui.forceAuto = panel.querySelector("#mai-force-auto");
    ui.subjectFallback = panel.querySelector("#mai-subject-fallback");
    ui.candidates = panel.querySelector("#mai-candidates");
    ui.checkpointInfo = panel.querySelector("#mai-checkpoint-info");
    ui.checkpointExport = panel.querySelector("#mai-checkpoint-export");
    ui.checkpointExport.addEventListener("click", recordCheckpointAndExport);
    ui.rangeStart = panel.querySelector("#mai-range-start");
    ui.rangeEnd = panel.querySelector("#mai-range-end");
    ui.exportButton = panel.querySelector("#mai-export");
    ui.manualExportButton = panel.querySelector("#mai-manual-export");
    ui.history = panel.querySelector("#mai-history");

    panel.querySelector(".mai-close").addEventListener("click", function () {
      state.settings.panelOpen = false;
      saveState(true);
      render();
    });
    ui.textarea.addEventListener("input", syncDraftFromUi);
    ui.alsoAuto.addEventListener("change", syncDraftFromUi);
    ui.save.addEventListener("click", function () {
      try {
        saveDraftCandidates();
      } catch (error) {
        setStatus("⚠ " + (error.message || String(error)), "error");
      }
    });
    ui.pageImage.addEventListener("click", addHoveredImage);
    ui.forceAuto.addEventListener("click", toggleAutomaticOverride);
    ui.rangeStart.addEventListener("input", render);
    ui.rangeEnd.addEventListener("input", render);
    ui.exportButton.addEventListener("click", exportAllQuestions);
    ui.manualExportButton.addEventListener("click", exportManualBackup);
    ui.drop.addEventListener("dragover", function (event) {
      event.preventDefault();
      ui.drop.style.background = "#e2f5ff";
    });
    ui.drop.addEventListener("dragleave", function () {
      ui.drop.style.background = "";
    });
    ui.drop.addEventListener("drop", function (event) {
      event.preventDefault();
      ui.drop.style.background = "";
      addImageFiles(event.dataTransfer ? event.dataTransfer.files : []);
    });
    ui.textarea.addEventListener("paste", function (event) {
      var items = event.clipboardData ? Array.prototype.slice.call(event.clipboardData.items || []) : [];
      var files = items.filter(function (item) { return item.kind === "file" && /^image\//i.test(item.type); })
        .map(function (item) { return item.getAsFile(); }).filter(Boolean);
      if (files.length) addImageFiles(files);
    });
    panel.addEventListener("click", function (event) {
      var deleteButton = event.target.closest("[data-delete-candidate]");
      if (deleteButton) deleteCandidate(deleteButton.getAttribute("data-delete-candidate"));
      var removeImage = event.target.closest("[data-remove-draft-image]");
      if (removeImage) removeDraftImage(Number(removeImage.getAttribute("data-remove-draft-image")));
      var setSubject = event.target.closest("#mai-set-subject");
      if (setSubject) setManualContext();
      var retry = event.target.closest("#mai-retry-subject");
      if (retry) retryContext();
    });
    installDrag(panel.querySelector("#mai-drag"));
    Array.prototype.forEach.call(panel.querySelectorAll(".mai-resize"), installResize);
    applyPanelRect();
    render();
  }

  function clampPanel(rect) {
    var width = Math.max(310, Math.min(rect.width, window.innerWidth - 12));
    var height = Math.max(320, Math.min(rect.height, window.innerHeight - 12));
    var left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    var top = Math.max(6, Math.min(rect.top, window.innerHeight - height - 6));
    return { left: left, top: top, width: width, height: height };
  }

  function applyPanelRect() {
    if (!ui.panel) return;
    var rect = clampPanel(state.settings.panel || DEFAULT_PANEL);
    Object.assign(state.settings.panel, rect);
    ui.panel.style.left = rect.left + "px";
    ui.panel.style.top = rect.top + "px";
    ui.panel.style.width = rect.width + "px";
    ui.panel.style.height = rect.height + "px";
  }

  function installDrag(handle) {
    handle.addEventListener("pointerdown", function (event) {
      if (event.target.closest("button")) return;
      event.preventDefault();
      var start = {
        x: event.clientX,
        y: event.clientY,
        left: state.settings.panel.left,
        top: state.settings.panel.top
      };
      function move(moveEvent) {
        state.settings.panel.left = start.left + moveEvent.clientX - start.x;
        state.settings.panel.top = start.top + moveEvent.clientY - start.y;
        applyPanelRect();
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        saveState(true);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function installResize(handle) {
    handle.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var edge = handle.getAttribute("data-edge");
      var start = Object.assign({ x: event.clientX, y: event.clientY }, state.settings.panel);
      function move(moveEvent) {
        var dx = moveEvent.clientX - start.x;
        var dy = moveEvent.clientY - start.y;
        var next = { left: start.left, top: start.top, width: start.width, height: start.height };
        if (edge.indexOf("e") >= 0) next.width = start.width + dx;
        if (edge.indexOf("s") >= 0) next.height = start.height + dy;
        if (edge.indexOf("w") >= 0) {
          next.left = start.left + dx;
          next.width = start.width - dx;
        }
        if (edge.indexOf("n") >= 0) {
          next.top = start.top + dy;
          next.height = start.height - dy;
        }
        state.settings.panel = clampPanel(next);
        applyPanelRect();
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        saveState(true);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function setStatus(message, type) {
    if (!ui.status) return;
    ui.status.textContent = message || "";
    ui.status.className = "mai-status " + (type || "info");
    if (type === "success") {
      setTimeout(function () {
        if (ui.status && ui.status.textContent === message) {
          ui.status.className = "mai-status";
          ui.status.textContent = "";
        }
      }, 4500);
    }
  }

  function renderCurrent() {
    if (!ui.current) return;
    var session = currentSession;
    var question = currentQuestion;
    var questionContext = question && question.subjectContext;
    var sessionContext = session ? {division:session.division, subject:session.subject} : null;
    // 誤った旧セッションの科目名より、問題ページで明示された分類を優先。
    var context = isValidClassificationContext(questionContext) ? questionContext :
      isValidClassificationContext(sessionContext) ? sessionContext :
      isValidClassificationContext(currentContext) ? currentContext : null;
    var candidateCount = session ? activeCandidatesForSession(session.id).length : 0;
    var pendingCount = session ? pendingCandidatesForSession(session.id).length : 0;
    var overrideCount = session ? state.automaticOverrides.filter(function (entry) {
      return entry.sessionId === session.id && !entry.deletedAt;
    }).length : 0;
    var contextText = context && context.division && context.subject ?
      escapeHtml(formatClassification(context.division, context.subject)) :
      "<span class='mai-warning'>⚠ 分類を自動取得できません</span>";
    var status = session ? (session.status === "completed" ? "完了" : "未完了") : "—";
    var currentText = question ?
      escapeHtml(String(question.position || "?") + " / " + String(question.total || "?") + "問") : "—";
    var nextId = question ?
      "montre:" + question.problemNumber + ":manual:" +
      String(Number(state.manualSequences[question.problemNumber] || 0) + 1).padStart(2, "0") : "—";
    ui.current.innerHTML =
      "<div class='mai-card'><div class='mai-title'>現在の演習</div>" +
      "<div style='font-weight:800;margin-bottom:5px'>" + contextText + "</div>" +
      "<div class='mai-grid'>" +
        "<span class='mai-muted'>開始</span><span>" + escapeHtml(session ? formatShortDate(session.startedAt) : "—") + "</span>" +
        "<span class='mai-muted'>問題数</span><span>" + escapeHtml(session && session.expectedTotal ? session.expectedTotal + "問" : "—") + "</span>" +
        "<span class='mai-muted'>状態</span><span>" + status + "</span>" +
        "<span class='mai-muted'>手動候補</span><span>" + candidateCount + "件</span>" +
        "<span class='mai-muted'>未書き出し</span><span>" + pendingCount + "件</span>" +
        "<span class='mai-muted'>自動指定</span><span>" + overrideCount + "問</span>" +
      "</div></div>" +
      "<div class='mai-card'><div class='mai-title'>現在の問題</div>" +
      "<div class='mai-grid'>" +
        "<span class='mai-muted'>位置</span><span>" + currentText + "</span>" +
        "<span class='mai-muted'>問題番号</span><span>" + escapeHtml(question ? question.problemNumber : "—") + "</span>" +
        "<span class='mai-muted'>問題分類</span><span>" + escapeHtml(
          question && question.subjectContext ?
            formatClassification(question.subjectContext.division, question.subjectContext.subject) : "—"
        ) + "</span>" +
        "<span class='mai-muted'>次の手動ID</span><span class='mai-candidate-id'>" + escapeHtml(nextId) + "</span>" +
      "</div></div>";
  }

  function renderSubjectFallback() {
    if (!ui.subjectFallback) return;
    var valid = isValidClassificationContext(currentContext) ||
      (currentQuestion && isValidClassificationContext(currentQuestion.subjectContext));
    var isExerciseTop = location.pathname.replace(/\/+$/, "") === "/users/cbt" && !location.search;
    if (valid) {
      ui.subjectFallback.innerHTML = "";
      return;
    }
    if (isExerciseTop && !currentQuestion) {
      ui.subjectFallback.innerHTML =
        "<div class='mai-card mai-muted'>演習範囲を選択すると、モントレの大分類と問題分類を自動取得します。</div>";
      return;
    }
    ui.subjectFallback.innerHTML =
      "<div class='mai-card'><div class='mai-warning'>⚠ 分類を自動取得できません</div>" +
      "<div class='mai-muted' style='margin:5px 0'>問題文から推測せず、手動設定後に保存します。</div>" +
      "<input class='mai-input' id='mai-manual-division' placeholder='大分類（例：循環器）' value='" +
        escapeHtml(state.settings.manualDivision || "") + "'>" +
      "<input class='mai-input' id='mai-manual-subject' style='margin-top:5px' placeholder='問題分類（例：解剖・生理）' value='" +
        escapeHtml(state.settings.manualSubject || "") + "'>" +
      "<div class='mai-row' style='margin-top:6px'>" +
        "<button class='mai-btn primary' id='mai-set-subject' type='button'>手動設定</button>" +
        "<button class='mai-btn' id='mai-retry-subject' type='button'>ページから科目を再取得</button>" +
      "</div></div>";
    ui.manualDivision = ui.subjectFallback.querySelector("#mai-manual-division");
    ui.manualSubject = ui.subjectFallback.querySelector("#mai-manual-subject");
  }

  function renderDraft() {
    if (!ui.textarea || !ui.alsoAuto) return;
    var problemId = currentProblemKey();
    var draft = problemId ? getDraft(problemId) : { text: "", images: [], alsoCreateAutomatic: false };
    if (document.activeElement !== ui.textarea) ui.textarea.value = draft.text || "";
    ui.alsoAuto.checked = Boolean(draft.alsoCreateAutomatic);
    ui.textarea.disabled = !problemId;
    ui.save.disabled = !problemId;
    ui.pageImage.disabled = !problemId;
    ui.forceAuto.disabled = !problemId;
    if (problemId && currentSession) {
      ui.forceAuto.classList.toggle("active", Boolean(getOverride(problemId, currentSession.id)));
    } else {
      ui.forceAuto.classList.remove("active");
    }
    renderDraftImages();
  }

  function renderDraftImages() {
    if (!ui.draftImages) return;
    var problemId = currentProblemKey();
    var images = problemId ? (getDraft(problemId).images || []) : [];
    ui.draftImages.innerHTML = images.map(function (image, index) {
      var src = image.dataUrl || image.sourceUrl || "";
      return "<div class='mai-image'>" +
        (src ? "<img src='" + escapeHtml(src) + "' alt='候補画像'>" : "<span>画像</span>") +
        "<button type='button' data-remove-draft-image='" + index + "' aria-label='削除'>×</button></div>";
    }).join("");
  }

  function renderCandidates() {
    if (!ui.candidates) return;
    if (!currentSession) {
      ui.candidates.innerHTML = "<div class='mai-muted'>現在の演習はありません。</div>";
      return;
    }
    var candidates = activeCandidatesForSession(currentSession.id);
    if (!candidates.length) {
      ui.candidates.innerHTML = "<div class='mai-muted'>まだ候補はありません。</div>";
      return;
    }
    ui.candidates.innerHTML = candidates.map(function (candidate, index) {
      var summary = candidate.text || (candidate.images.length + "枚の画像");
      return "<div class='mai-candidate'>" +
        "<div><strong>" + (index + 1) + ". " + escapeHtml(summary) + "</strong></div>" +
        "<div class='mai-muted'>問題 " + escapeHtml(candidate.problemNumber) +
          "｜" + (candidate.exportedAt ? "書き出し済み" : "未書き出し") +
          "｜" + escapeHtml(candidate.automaticCardPolicy) + "</div>" +
        "<div class='mai-candidate-id'>" + escapeHtml(candidate.id) + "</div>" +
        (candidate.images && candidate.images.length ? "<div class='mai-muted'>画像" + candidate.images.length + "枚</div>" : "") +
        "<button class='mai-btn danger' type='button' data-delete-candidate='" +
          escapeHtml(candidate.id) + "'>削除</button>" +
      "</div>";
    }).join("");
  }

  function renderHistory() {
    if (!ui.history) return;
    var sessions = state.sessions.slice().sort(function (a, b) {
      return String(b.startedAt).localeCompare(String(a.startedAt));
    });
    if (!sessions.length) {
      ui.history.innerHTML = "<div class='mai-muted'>履歴はありません。</div>";
      return;
    }
    ui.history.innerHTML = sessions.map(function (session) {
      var candidates = activeCandidatesForSession(session.id);
      var pending = pendingCandidatesForSession(session.id).length;
      var label = (session.division || "科目未設定") +
        (session.subject ? " ＞ " + session.subject : "") +
        "｜" + formatShortDate(session.startedAt) +
        "｜" + candidates.length + "件｜" +
        (session.status === "completed" ? "完了" : (pending ? "未書き出し" + pending : "未完了"));
      var checkpointDetails = "<div class='mai-muted'>" + escapeHtml(checkpointSummary(session)) + "</div>" +
        (session.exportHistory || []).map(function (entry) {
          return "<div class='mai-muted'>" + escapeHtml(formatShortDate(entry.exportedAt)) + "｜" +
            entry.start + "〜" + entry.end + "問目｜" + entry.acquiredTotal + "問出力｜" +
            ((entry.dataComplete || entry.complete) ? "問題・正答・解説取得済み" : "不足あり・再取得対象") + "</div>";
        }).join("");
      var details = candidates.map(function (candidate) {
        return "<div class='mai-candidate'>" +
          escapeHtml(candidate.text || ("画像" + candidate.images.length + "枚")) +
          "<div class='mai-candidate-id'>" + escapeHtml(candidate.id) + "</div>" +
          "<button class='mai-btn danger' type='button' data-delete-candidate='" +
            escapeHtml(candidate.id) + "'>削除</button></div>";
      }).join("") || "<div class='mai-muted'>候補なし</div>";
      return "<details><summary>" + escapeHtml(label) +
        (session.studyCheckpoint ? "｜区切り" + session.studyCheckpoint.position + "問目" : "") +
        "</summary>" + checkpointDetails + details + "</details>";
    }).join("");
  }

  function renderWarnings() {
    if (!ui.status || ui.status.textContent) return;
    var unfinished = state.sessions.find(function (session) {
      return session !== currentSession &&
        session.status !== "completed" &&
        pendingCandidatesForSession(session.id).length > 0;
    });
    if (unfinished) {
      setStatus("⚠ " + (unfinished.subject || unfinished.division || "前回演習") +
        "に未書き出し候補が" + pendingCandidatesForSession(unfinished.id).length + "件あります", "info");
    }
  }

  function render() {
    if (!ui.panel || !ui.toggle) return;
    var panelOpen = Boolean(state.settings.panelOpen);
    ui.panel.style.display = panelOpen ? "block" : "none";
    ui.toggle.style.display = panelOpen ? "none" : "block";
    var count = currentSession ? activeCandidatesForSession(currentSession.id).length : 0;
    var subject = currentContext && currentContext.subject ? currentContext.subject :
      (currentContext && currentContext.division ? currentContext.division : "科目未取得");
    ui.toggle.textContent = "＋ Anki " + count + "｜" + subject;
    if (!panelOpen) return;
    applyPanelRect();
    renderCurrent();
    renderDraft();
    renderSubjectFallback();
    renderCandidates();
    renderHistory();
    ui.checkpointInfo.textContent = checkpointSummary(currentSession);
    ui.checkpointExport.disabled = exportRunning || !currentQuestion || !currentSession;
    ui.rangeStart.disabled = exportRunning;
    ui.rangeEnd.disabled = exportRunning;
    ui.exportButton.disabled = exportRunning || !currentSession;
    ui.exportButton.textContent = exportRunning ?
      "問題データを取得中…" :
      (!ui.rangeStart.value && !ui.rangeEnd.value ? "全問をダウンロード" :
        ui.rangeStart.value && ui.rangeEnd.value ? ui.rangeStart.value + "〜" + ui.rangeEnd.value + "問をダウンロード" : "開始・終了を入力してください");
    renderWarnings();
  }

  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      renderTimer = null;
      render();
    }, 80);
  }

  function installObservers() {
    document.addEventListener("click", handleCategoryClick, true);
    document.addEventListener("click", handleNavigationClick, true);
    document.addEventListener("keydown", handleShortcut, true);
    document.addEventListener("mouseover", function (event) {
      var image = event.target && event.target.closest ? event.target.closest("img") : null;
      if (image && !image.closest("#montre-anki-panel")) {
        lastHoveredImage = absoluteUrl(image.currentSrc || image.src, location.href);
      }
    }, true);
    window.addEventListener("resize", function () {
      applyPanelRect();
      saveState(false);
    });
    var observer = new MutationObserver(function (mutations) {
      var hasPageMutation = mutations.some(function (mutation) {
        var target = mutation.target && mutation.target.nodeType === 1 ?
          mutation.target : mutation.target && mutation.target.parentElement;
        return !target || !target.closest ||
          (!target.closest("#montre-anki-panel") &&
            !target.closest("#montre-anki-toggle") &&
            !target.closest("#montre-anki-fatal"));
      });
      if (!hasPageMutation) return;
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = setTimeout(function () {
        captureTimer = null;
        captureCurrentQuestion();
      }, 450);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setInterval(captureCurrentQuestion, 5000);
  }

  function showFatal(message, error) {
    var existing = document.getElementById("montre-anki-fatal");
    if (existing) return;
    var box = document.createElement("div");
    box.id = "montre-anki-fatal";
    box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:440px;background:#fff0f0;color:#8a1c1c;border:2px solid #d92d20;border-radius:10px;padding:12px;font:13px/1.5 sans-serif;white-space:pre-wrap";
    box.textContent = "モントレ Anki 起動失敗\nエラー: " + message +
      (error ? "\n詳細: " + (error.message || String(error)) : "") +
      "\nバージョン: v" + VERSION;
    document.body.appendChild(box);
  }

  function start() {
    try {
      if (!document.body || !document.head) {
        setTimeout(start, 80);
        return;
      }
      // 分類取得が失敗しても同期の接続確認は生きるように先に初期化する。
      installReviewBridge();
      readLargeCategoryMaps(document);
      currentContext = detectContext(document, location.href);
      createUi();
      installObservers();
      captureCurrentQuestion();
    } catch (error) {
      showFatal("初期化できません", error);
    }
  }

  start();
})();

// === BEGIN INTEGRATED MONTRE REVIEW v1.6.0 ===
try {
(() => {
  'use strict';
  if (window.__montreReviewIntegratedLoaded) return;
  window.__montreReviewIntegratedLoaded = true;

  const STORE_KEY = 'montreReview.v1';
  const SESSION_KEY = 'montreReview.session.v1';
  const FILTER_KEY = 'montreReview.filterSettings.v2';
  const BRIDGE_KEY = 'montreReview.bridge.v1';
  const SEED = [];
  const BAD = new Set(['×','△']);
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  let store;
  let session;
  let selected = new Set();
  let checkedResult = null;
  let filterSubject = '';
  let filterTopic = '';
  let filterSearch = '';
  let showAllTopics = false;
  let screen = 'home';
  let notice = '';
  let syncReady = false;
  let syncedCount = 0;
  let lastSyncAt = '';
  let syncTimer = null;
  let sourceVersion = '';
  let sourceCacheTotal = null;
  let sourceEligible = null;
  let sourcePhase = '';
  let lastStatusAt = 0;
  let syncRequestedAt = 0;
  let retryCount = 0;
  const jsonParse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const cleanText = x => typeof x === 'string' ? x.slice(0,30000) : '';
  const safeId = x => typeof x === 'string' || typeof x === 'number' ? String(x).trim().slice(0,80) : '';
  const safeUrl = x => { try {const u=new URL(String(x));return u.protocol==='https:' && u.hostname==='m3e-medical.com' && /^\/users\/cbt\/practice_questions\/\d+/.test(u.pathname) ? u.href : ''; } catch{return '';} };
  const safeImage = x => {try {const u = new URL(String(x));return u.protocol === 'https:' && /(^|\.)amazonaws\.com$/.test(u.hostname) && u.pathname.includes('question-images-tecopla.com/') && !u.pathname.includes('basic_info_images') && !/K\d*\.(jpg|jpeg|png|webp)$/i.test(u.pathname) ? u.href : ''; } catch {return '';}};

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = safeId(raw.problemNumber ?? raw.number ?? raw.id);
    const choices = Array.isArray(raw.choices) ? raw.choices.filter(c=>c && c.label!=null).slice(0,25).map(c=>({label:safeId(c.label),text:cleanText(c.text)})) : [];
    const ans = raw.correctAnswer ?? raw.answer;
    const answer = Array.isArray(ans) ? ans.map(safeId) : (ans ? [safeId(ans)] : []);
    if (!id || !choices.length || !answer.length || !answer.every(a => choices.some(c=>c.label===a))) return null;
    const assessment = raw.selfEvaluationRaw || raw.answerCorrectness;
    let initial = raw.initial || raw.selfEvaluation;
    if (!['○','×','△'].includes(initial)) initial = ({incorrect:'×',correct:'○',mistake:'△'})[assessment] || '';
    if (!initial && Array.isArray(raw.selectedAnswer)) initial = arraysEqual(raw.selectedAnswer.map(safeId), answer) ? '○' : '×';
    let title = cleanText(raw.questionText ?? raw.title).replace(/^\s*｜\s*前回演習日\s*\d{2}\/\d{2}\/\d{2}\s*/, '').trim();
    if (!title) return null;
    const context = raw.subjectContext || {};
    const imgs = (raw.images || []).map(i=>safeImage(typeof i === 'string'?i:i?.url)).filter(Boolean).slice(0,12);
    return { id,number:id,title,choices,answer,initial,
      topic:cleanText(raw.topic ?? context.category),subject:cleanText(raw.subject ?? context.largeCategory),
      url:safeUrl(raw.url), images:[...new Set(imgs)], explanation:cleanText(raw.explanation),
      position: Number.isFinite(+raw.position) ? +raw.position : null };
  }
  function arraysEqual(a,b) { return a.length===b.length && [...a].sort().join('\u001f') === [...b].sort().join('\u001f'); }
  function rankMark(mark) { return ({'':0,'○':1,'△':2,'×':3})[mark] || 0; }
  function mergeQuestion(q) {
    const old = store.questions[q.id];
    if (old) {
      // 一度でも初回に誤答した設問を、後のJSONインポートで消さない。
      q.initial = rankMark(old.initial)>rankMark(q.initial) ? old.initial : q.initial;
      store.questions[q.id] = { ...old, ...q };
      return false;
    }
    store.questions[q.id] = q;
    return true;
  }
  function queueSyncSave(){
 if(syncTimer)return;
 syncTimer=setTimeout(()=>{
   syncTimer=null;
   if(persist()&&(screen==='home'||screen==='closed'))render();
 },400);
}

  function receiveAutoQuestion(e){
 let payload=e&&e.detail;
 if(typeof payload!=='string'){try{payload=localStorage.getItem(BRIDGE_KEY);}catch(_e){}}
 if(typeof payload!=='string'||payload.length>250000)return;
 const packet=jsonParse(payload,null);
 if(!packet||packet.kind!=='montre-review-question-v1'||!packet.question)return;
 const raw=packet.question;
 if(!['○','×','△'].includes(raw.selfEvaluation))return;
 const explicit = raw.selfEvaluationConfirmed === true;
 const derived = raw.reviewMarkVerified === true &&
   raw.reviewEvaluationSource === 'answer-comparison' &&
   raw.evaluationSource === 'answer-comparison' &&
   Array.isArray(raw.selectedAnswer) && raw.selectedAnswer.length > 0 &&
   Array.isArray(raw.correctAnswer) && raw.correctAnswer.length > 0 &&
   raw.selfEvaluation === (arraysEqual(raw.correctAnswer,raw.selectedAnswer)?'○':'×') &&
   raw.answerCorrectness === (raw.selfEvaluation === '○' ? 'correct' : 'incorrect');
 if (!explicit && !derived) return;
 const q=normalize(raw);
 if(!q)return;
 syncReady=true;
 const previous=store.questions[q.id], old=previous?JSON.stringify(previous):'';
 mergeQuestion(q);
 if(!previous||old!==JSON.stringify(store.questions[q.id])){
   syncedCount++;lastSyncAt=new Date().toISOString();queueSyncSave();
 }
 try{if(localStorage.getItem(BRIDGE_KEY)===payload)localStorage.removeItem(BRIDGE_KEY);}catch(_e){}
}

  function requestAutoSync(){
 syncRequestedAt=Date.now();
 if (typeof window.__montreReviewIntegratedRequest === 'function') {
   window.__montreReviewIntegratedRequest();
   return;
 }
 try{window.dispatchEvent(new CustomEvent('montre-review:sync-request'));}catch(_e){}
 try{window.postMessage(JSON.stringify({kind:'montre-review-sync-request-v1'}),location.origin);}catch(_e){}
}

  function acceptSourceStatus(payload){
    const data=typeof payload==='string'?jsonParse(payload,null):payload;
    if(!data||data.kind!=='montre-review-status-v2')return;
    syncReady=true;sourceVersion=String(data.version||'不明');
    sourceCacheTotal=Number.isSafeInteger(data.cacheTotal)?data.cacheTotal:null;
    sourceEligible=Number.isSafeInteger(data.eligible)?data.eligible:null;
    sourcePhase=String(data.phase||'ready');
    lastStatusAt=Date.now();
    if(screen==='home')render();
  }
  function syncDiagnosticHtml(){
    const base='https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_anki_inbox.user.js';
    if(!sourceVersion){
      return `<div class="sync-diagnostic attention"><strong>自動同期：Anki追加箱の応答を確認できていない</strong>
        <p>Anki追加箱 v2.8.0以上を有効にし、モントレの問題画面を再読み込みしてください。</p>
        <a href="${base}" target="_blank" rel="noopener noreferrer">Anki追加箱を更新する ↗</a>
        <button data-action="sync" type="button">接続を再確認</button></div>`;
    }
    const cache=sourceCacheTotal==null?'不明':sourceCacheTotal+'問';
    const eligible=sourceEligible==null?'不明':sourceEligible+'問';
    let reason='';
    if(sourceEligible===0)reason='同期可能な問題が0問。実際の解答・正答・選択肢が保存されているか確認してください。';
    else if(sourcePhase==='sync-finished'&&sourceEligible>0&&syncedCount===0&&all().length===0)reason='送信対象はあるが登録0問です。JSONからの手動読み込みも試してください。';
    else if(sourceCacheTotal===0)reason='Anki追加箱の問題キャッシュが空です。モントレで問題を解き、自己評価を確定してください。';
    return `<div class="sync-diagnostic"><strong>自動同期：Anki追加箱 v${esc(sourceVersion)} と接続済み</strong>
      <p>取得済み ${esc(cache)} ／ 同期条件を満たす ${esc(eligible)} ／ 今回の新規・更新 ${syncedCount}問 ／ 復習登録 ${all().length}問</p>
      ${reason?`<p>${esc(reason)}</p>`:''}
      <button type="button" data-action="sync">Ankiから再同期</button></div>`;
  }
  function installAutoSync(){
 window.__montreReviewIntegratedIngest = payload => receiveAutoQuestion({detail:payload});
 window.__montreReviewIntegratedStatus = acceptSourceStatus;
 window.addEventListener('montre-review:question',receiveAutoQuestion);
 window.addEventListener('montre-review:status',e=>acceptSourceStatus(e.detail));
 window.addEventListener('montre-review:anki-ready',()=>{
   syncReady=true;requestAutoSync();if(screen==='home')render();
 });
 window.addEventListener('message',e=>{
   if(e.source!==window||e.origin!==location.origin||typeof e.data!=='string'||e.data.length>250000)return;
   const packet=jsonParse(e.data,null);
   if(packet?.kind==='montre-review-question-v1')receiveAutoQuestion({detail:e.data});
   if(packet?.kind==='montre-review-status-v2')acceptSourceStatus(packet);
   if(packet?.kind==='montre-review-ready-v1'&&!syncReady){
     syncReady=true;requestAutoSync();if(screen==='home')render();
   }
 });
 receiveAutoQuestion(null);
 requestAutoSync();
 setTimeout(()=>{if(!sourceVersion)requestAutoSync();},1800);
 setTimeout(()=>{if(!sourceVersion)requestAutoSync();},4800);
}

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
    catch (e) {notice='保存に失敗した。ブラウザの保存容量を確認し、バックアップを出力してください。';return false;}
  }
  function persistSession() {
    try {localStorage.setItem(SESSION_KEY, JSON.stringify(session));} catch {}
  }
  function init() {
    store = jsonParse(localStorage.getItem(STORE_KEY), null);
    if (!store || typeof store !== 'object' || store.v!==1 || !store.questions || !store.attempts) store = {v:1, questions:{},attempts:{}};
    for (const raw of SEED) { const q=normalize(raw); if(q) mergeQuestion(q); }
    persist();
    const savedFilters = jsonParse(localStorage.getItem(FILTER_KEY),null);
    if(savedFilters && typeof savedFilters==='object'){
      filterSubject=typeof savedFilters.subject==='string'?savedFilters.subject:'';
      filterTopic=typeof savedFilters.topic==='string'?savedFilters.topic:'';
      filterSearch=typeof savedFilters.search==='string'?savedFilters.search:'';
    }
    session = jsonParse(localStorage.getItem(SESSION_KEY), null);
    if (!session || !Array.isArray(session.ids) || !Number.isInteger(session.index)) session=null;
  }
  const all = () => Object.values(store.questions).filter(q=>q&&q.id&&q.answer);
  const history = id => Array.isArray(store.attempts[id]) ? store.attempts[id] : [];
  const latest = q => {const h=history(q.id);return h.length ? h[h.length-1].mark : q.initial;};
  const isBad = q => BAD.has(q.initial);
  const needsReview = q => isBad(q) && latest(q)!=='○';
  const categoryLabel = q => [q.subject,q.topic].filter(Boolean).join(' / ') || '未分類';
  const subjectName = q => String(q.subject||'未分類').trim()||'未分類';
  const topicName = q => String(q.topic||'その他').trim()||'その他';
  function saveFilters(){
    try{localStorage.setItem(FILTER_KEY,JSON.stringify({subject:filterSubject,topic:filterTopic,search:filterSearch}));}
    catch(_e){}
  }
  const searchMatch = q => !filterSearch.trim() ||
    (subjectName(q)+' '+topicName(q)).toLocaleLowerCase('ja').includes(filterSearch.trim().toLocaleLowerCase('ja'));
  const filtered = items => items.filter(q =>
    (!filterSubject||subjectName(q)===filterSubject) &&
    (!filterTopic||topicName(q)===filterTopic) && searchMatch(q)
  );
  function subjectOptions(){
    const categories = new Map();
    for(const q of all()){
      const name=subjectName(q);
      if(!categories.has(name))categories.set(name,{name,total:0,pending:0,found:false});
      const item=categories.get(name);
      item.total++;
      if(needsReview(q))item.pending++;
      if(searchMatch(q))item.found=true;
    }
    return [...categories.values()].filter(x=>x.found||x.name===filterSubject).sort((a,b)=>b.pending-a.pending||a.name.localeCompare(b.name,'ja'));
  }
  function topicOptions(){
    if(!filterSubject)return[];
    const topics=new Map();
    for(const q of all()){
      if(subjectName(q)!==filterSubject||!searchMatch(q))continue;
      const name=topicName(q);
      if(!topics.has(name))topics.set(name,{name,total:0,pending:0});
      const item=topics.get(name);item.total++;
      if(needsReview(q))item.pending++;
    }
    return [...topics.values()].sort((a,b)=>b.pending-a.pending||a.name.localeCompare(b.name,'ja'));
  }
  function filterHtml(){
    const subjects=subjectOptions();
    const subjectsHtml=subjects.map(c=>`<button type="button" class="cat-pill ${filterSubject===c.name?'chosen':''}" data-action="subject-filter" data-subject="${esc(c.name)}" aria-pressed="${filterSubject===c.name}">
      <span>${esc(c.name)}</span><small>${c.pending} / ${c.total}問</small></button>`).join('');
    const topics=topicOptions();
    const visibleTopics=showAllTopics?topics:topics.slice(0,8);
    const topicsHtml=visibleTopics.map(c=>`<button type="button" class="cat-pill sub-pill ${filterTopic===c.name?'chosen':''}" data-action="topic-filter" data-topic="${esc(c.name)}" aria-pressed="${filterTopic===c.name}">
      <span>${esc(c.name)}</span><small>${c.pending} / ${c.total}問</small></button>`).join('');
    const current=[filterSubject||'全科目',filterTopic].filter(Boolean).join(' › ');
    const selectedCount=getQueue('pending').length;
    return `<section class="filter-panel" aria-label="復習する分野">
      <div class="filter-head"><strong>復習する分野</strong><button type="button" data-action="reset-filter" class="filter-clear">絞り込みを解除</button></div>
      <label class="filter-search-label" for="topic-search">分野名を検索</label>
      <input id="topic-search" type="search" placeholder="呼吸器、肺炎、循環器など" value="${esc(filterSearch)}" autocomplete="off" spellcheck="false">
      <div class="filter-subtitle">① 大分類を選ぶ <span class="filter-hint">未克服数 / 登録数</span></div>
      <div class="cat-pills"><button type="button" class="cat-pill ${!filterSubject?'chosen':''}" data-action="subject-filter" data-subject="" aria-pressed="${!filterSubject}"><span>全科目</span><small>${all().filter(needsReview).length} / ${all().length}問</small></button>${subjectsHtml}</div>
      ${filterSubject?`<div class="filter-subtitle">② ${esc(filterSubject)}の小分野を選ぶ</div>
        <div class="cat-pills"><button type="button" class="cat-pill sub-pill ${!filterTopic?'chosen':''}" data-action="topic-filter" data-topic="" aria-pressed="${!filterTopic}"><span>全小分野</span></button>${topicsHtml}</div>
        ${topics.length>8?`<button type="button" class="filter-more" data-action="more-topics">${showAllTopics?'小分野を折りたたむ':'残り'+(topics.length-8)+'分野を表示'}</button>`:''}
        ${!topics.length?'<p class="sub">該当する小分野はない。</p>':''}`:
        '<p class="sub filter-help">大分類を選ぶと小分野が表示される。検索欄で直接絞ることもできる。</p>'}
      <div class="filter-summary">選択中：<strong>${esc(current)}</strong>${filterSearch?'（検索：'+esc(filterSearch)+'）':''}<span>未克服 <strong>${selectedCount}問</strong></span></div>
    </section>`;
  }
  const sorter = (a,b) => (a.subject||'').localeCompare(b.subject||'','ja') || (a.position??9999)-(b.position??9999) || a.id.localeCompare(b.id);
  const sorted = items => [...items].sort(sorter);
  const getQueue = kind => {
    const items=filtered(all());
    if(kind==='all-bad')return sorted(items.filter(isBad));
    if(kind==='first-wrong')return sorted(items.filter(q=>q.initial==='×'));
    if(kind==='all')return sorted(items);
    if(kind==='repeat-bad')return sorted(items.filter(q=>history(q.id).length && BAD.has(latest(q))));
    return sorted(items.filter(needsReview));
  };
  function record(q,mark,selectedLabels) {
    const items = history(q.id);
    items.push({mark,selected:[...selectedLabels],at:new Date().toISOString()});
    store.attempts[q.id]=items.slice(-60);
    persist();
  }
  function updateLast(q,mark) {
    const h=history(q.id);
    if (!h.length) return;
    h[h.length-1].mark=mark;
    persist();
    if(checkedResult) checkedResult.mark=mark;
  }
  function startQueue(kind) {
    const qs = getQueue(kind);
    if(!qs.length){notice='この条件の復習対象は0問である。';render();return;}
    session={ids:qs.map(q=>q.id),index:0,kind,startedAt:new Date().toISOString()};
    selected.clear(); checkedResult=null;
    screen='quiz';persistSession();render();
  }
  function currentQ() {return session && store.questions[session.ids[session.index]];}
  function jump(step) {
    if (!session) return;
    const next = session.index+step;
    if(next<0 || next>=session.ids.length) {screen='end';render();return;}
    session.index=next;
    selected.clear();checkedResult=null;
    persistSession();render();
  }
  function check() {
    const q=currentQ();if(!q || !selected.size || checkedResult)return;
    const ok=arraysEqual([...selected],q.answer);
    const mark=ok?'○':'×';
    record(q,mark,selected);
    checkedResult={mark,ok};render();
  }
  function importJson(data) {
    if(!data || typeof data!=='object')throw Error('JSON形式が不正');
    if(data.format==='montre-review-backup-v1') {
      const arr=Array.isArray(data.questions)?data.questions:[];
      if(!arr.length)throw Error('バックアップに問題がない');
      let added=0, valid=0;
      for(const raw of arr){const q=normalize(raw);if(!q)continue;valid++;if(mergeQuestion(q))added++;}
      if(!valid)throw Error('有効な問題データなし');
      for(const [id,attempts] of Object.entries(data.attempts||{})) {
        if(!store.questions[id] || !Array.isArray(attempts))continue;
        const incoming=attempts.filter(a=>['○','×','△'].includes(a?.mark) && typeof a?.at==='string').map(a=>({mark:a.mark,selected:Array.isArray(a.selected)?a.selected.map(safeId):[],at:a.at}));
        const existing=history(id);
        const combined=[...existing,...incoming];
        const unique=new Map(combined.map(a=>[a.at+'|'+a.mark+'|'+a.selected.join(','),a]));
        store.attempts[id]=[...unique.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-60);
      }
      if(!persist())throw Error('保存容量を超えた');
      return {valid,added};
    }
    const list=Array.isArray(data.questions)?data.questions:(Array.isArray(data)?data:null);
    if(!list)throw Error('問題配列 questions が見つからない');
    let added=0,valid=0;
    for(const raw of list){const q=normalize(raw);if(!q)continue;valid++;if(mergeQuestion(q))added++;}
    if(!valid)throw Error('正答・選択肢・問題番号を含む問題がない');
    if(!persist())throw Error('保存容量を超えた');
    return {valid,added};
  }
  function downloadBackup() {
    const data={format:'montre-review-backup-v1',exportedAt:new Date().toISOString(),questions:all(),attempts:store.attempts};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='montre_review_backup_'+new Date().toISOString().slice(0,10)+'.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  const styles = `
  :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif;color:#1d2939}
  *{box-sizing:border-box}
  #launcher{position:fixed;bottom:20px;right:18px;z-index:2147483646;border:0;border-radius:50px;background:#194c7d;color:white;box-shadow:0 5px 24px #0004;padding:13px 18px;font:700 14px sans-serif;cursor:pointer}
  #backdrop{position:fixed;inset:0;background:#0c1726aa;z-index:2147483647;display:flex;justify-content:center;align-items:center;padding:16px}
  #modal{width:min(860px,100%);height:min(91vh,940px);display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 50px #0006;font:14px/1.65 -apple-system,BlinkMacSystemFont,'Yu Gothic',Meiryo,sans-serif;color:#1b2838}
  .top{flex-shrink:0;display:flex;align-items:center;gap:10px;background:#173f67;color:#fff;padding:14px 19px}
  .top h2{margin:0;font-size:17px;flex:1;color:#fff}
  .top small{color:#dce7f4;font-size:12px}
  .top button{color:#fff;background:#ffffff20;border:1px solid #ffffff44}
  main{overflow:auto;padding:20px 23px 28px;flex:1}
  h3{font-size:19px;line-height:1.5;margin:0 0 10px;color:#182b41}
  p{margin:7px 0 14px}
  .sub{color:#65768b;font-size:12px}.tiny{font-size:12px}
  .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-bottom:16px}
  .stat{padding:12px 8px;background:#edf3f9;border-radius:10px;text-align:center}
  .stat b{display:block;font-size:23px;color:#143f65}.stat span{font-size:11px}
  .card{border:1px solid #d9e1eb;border-radius:12px;padding:16px;margin-bottom:15px;background:#fff}
  label.select{display:flex;gap:12px;align-items:center;margin:12px 0 18px}
  label.select span{white-space:nowrap;font-weight:700}
  select{padding:9px 11px;max-width:100%;min-width:0;border:1px solid #bbc7d6;border-radius:8px;flex:1;font:inherit}
  button,.button{background:#e6edf5;border:1px solid #ccd6e2;border-radius:9px;color:#243d56;font:600 13px/1.5 inherit;padding:10px 13px;cursor:pointer}
  button:hover,.button:hover{filter:brightness(.95)}button.primary{background:#194c7d;color:white;border-color:#194c7d}
  button.warn{background:#fff1e7;color:#953c15;border-color:#f1c6a8}
  .actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
  .actions button{flex:1 1 145px;min-height:42px}
  .notice{background:#fff9e8;padding:10px 12px;border:1px solid #f1dc9f;border-radius:8px;margin-bottom:12px;font-size:13px}
  .question{font-size:16px;line-height:1.85;white-space:pre-wrap;padding:12px 0 18px;border-top:1px solid #edf1f6}
  .choices{display:grid;gap:7px;margin:15px 0}
  .choice{display:flex;align-items:flex-start;gap:10px;padding:10px 13px;border:1px solid #d6dfeb;border-radius:9px;cursor:pointer;white-space:pre-wrap;line-height:1.7}
  .choice:has(input:checked){background:#eaf3fc;border-color:#246fa5}
  .choice input{margin-top:5px;flex-shrink:0;width:16px;height:16px}
  .choice .letter{font-weight:800;min-width:20px}
  .choice.correct{background:#edf8f0;border-color:#6ca679}
  .choice.wrong{background:#fdf0ef;border-color:#d99893}
  .result{border-radius:10px;padding:14px;margin:14px 0;background:#eef5fa;border:1px solid #adc8e2}
  .result.miss{background:#fff1eb;border-color:#efba9e}
  .explanation{white-space:pre-wrap;line-height:1.8;max-height:460px;overflow:auto;border-top:1px solid #c5d3e1;padding-top:12px;margin-top:10px}

  .exp-group{display:grid;gap:9px;margin:13px 0}
  .exp-item{border:1px solid #dce4ed;border-radius:11px;overflow:hidden;background:#fff}
  .exp-item summary{display:flex;align-items:center;gap:11px;cursor:pointer;padding:11px 13px;font-weight:650;list-style:none}
  .exp-item summary::-webkit-details-marker{display:none}
  .exp-item summary:after{content:'詳細';margin-left:auto;color:#526579;font-size:12px;font-weight:400}
  .exp-item[open] summary:after{content:'閉じる'}
  .exp-item .exp-text{padding:0 13px 13px 45px;white-space:pre-wrap;line-height:1.9;font-size:14px;overflow-wrap:anywhere}
  .exp-item .letter{display:inline-flex;min-width:27px;height:27px;border-radius:50%;background:#edf2f8;align-items:center;justify-content:center}
  .exp-item.exp-correct{border-color:#a6d8bd;background:#f8fdf9}
  .exp-item.exp-correct .letter{background:#e0f7ea;color:#176344}
  .exp-common{border-left:3px solid #b4c6d9;background:#f7f9fc;border-radius:7px;margin:10px 0;padding:10px 13px;white-space:pre-wrap;line-height:1.85}
  .exp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:15px}
  .sync-status{font-size:12px;color:#375773;margin:7px 0 12px}
  .filter-panel{background:#f8fafc;border:1px solid #d6e0ea;border-radius:12px;padding:15px;margin:14px 0 18px}
  .filter-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:9px}
  .filter-head strong{font-size:15px}.filter-clear{padding:5px 8px;border:0;background:transparent;color:#246fa5;text-decoration:underline;font-size:12px}
  .filter-search-label{display:block;font-size:12px;font-weight:600;color:#38546e;margin-bottom:4px}
  #topic-search{width:100%;padding:10px 12px;background:white;border:1px solid #b4c7d9;border-radius:9px;font:inherit;font-size:14px;color:#182b41}
  #topic-search:focus{outline:2px solid #276eaf;outline-offset:1px}
  .filter-subtitle{font-size:13px;font-weight:700;margin:14px 0 7px;color:#223e55}
  .filter-hint{font-size:11px;font-weight:400;color:#667889;margin-left:7px}
  .cat-pills{display:flex;flex-wrap:wrap;gap:7px;max-height:200px;overflow:auto;padding:2px 0}
  .cat-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid #d0dce7;border-radius:9px;background:#fff;color:#26445c;font-size:13px;font-weight:650;max-width:100%;text-align:left}
  .cat-pill small{font-size:11px;font-weight:500;color:#68798a;white-space:nowrap}
  .cat-pill.chosen{background:#194c7d;border-color:#194c7d;color:#fff}
  .cat-pill.chosen small{color:#dceafa}
  .sub-pill{font-weight:500}
  .filter-summary{display:flex;gap:7px;flex-wrap:wrap;align-items:center;border-top:1px solid #dce4ef;padding-top:10px;margin-top:11px;font-size:13px}
  .filter-summary span{margin-left:auto}
  .filter-help{margin:9px 0}
  .filter-more{margin-top:8px;color:#194c7d}
  .sync-diagnostic{padding:10px 12px;border:1px solid #d3deea;border-radius:9px;background:#f4f7fb;margin-bottom:12px;font-size:13px}
  .sync-diagnostic.attention{border-color:#ead29b;background:#fff8e8}
  .sync-diagnostic a{color:#1d5e90;text-decoration:underline}
  @media(max-width:600px){.cat-pills{max-height:190px}.cat-pill{font-size:12px;padding:7px 9px}.filter-panel{padding:11px}}


  .images{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}.images img{max-width:min(100%,460px);max-height:370px;object-fit:contain;border:1px solid #e1e7ef;border-radius:6px;background:white}
  .progress{height:7px;background:#e3eaf2;border-radius:5px;overflow:hidden;margin:10px 0 17px}.progress>div{height:100%;background:#3f789f}
  .link{color:#246da7;text-decoration:underline;cursor:pointer}
  .separator{border-top:1px solid #e6ebf1;margin:16px 0}
  .filepicker{display:inline-flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;border:1px solid #bbc9d8;cursor:pointer;background:#f6f9fc;font-weight:600}
  .filepicker input{display:none}
  @media(max-width:600px){#backdrop{padding:6px}#modal{height:97vh;border-radius:11px}main{padding:15px}.top{padding:10px 14px}.stats{grid-template-columns:repeat(2,1fr)}.actions button{flex:1 1 110px}}
  `;
  let shadow, app;
  function mount() {
    if (!document.getElementById('montre-review-legacy-hide')) {
      const style=document.createElement('style');
      style.id='montre-review-legacy-hide';
      style.textContent='#montre-review-root{display:none!important}';
      (document.head||document.documentElement).appendChild(style);
    }
    const host=document.createElement('div'); host.id='montre-review-integrated-root';
    (document.body || document.documentElement).append(host);
    shadow=host.attachShadow({mode:'open'});
    const s=document.createElement('style');s.textContent=styles;shadow.appendChild(s);
    app=document.createElement('div');shadow.append(app);
    render();
    shadow.addEventListener('click',handleClick);
    shadow.addEventListener('change',handleChange);
    shadow.addEventListener('input', e => {
      if(e.target.id!=='topic-search'||e.isComposing)return;
      const el=e.target;
      const start=el.selectionStart,end=el.selectionEnd;
      filterSearch=el.value;saveFilters();render();
      const next=shadow.querySelector('#topic-search');
      if(next){next.focus();try{next.setSelectionRange(start,end);}catch(_e){}}
    });
    shadow.addEventListener('compositionend',e=>{
      if(e.target.id!=='topic-search')return;
      filterSearch=e.target.value;saveFilters();render();
      shadow.querySelector('#topic-search')?.focus();
    });
    document.addEventListener('keydown',e=>{if(e.key==='Escape' && screen!=='closed'){screen='closed';render();}});
  }
  function render() {
    if(!app)return;
    if(screen==='closed'){app.innerHTML=`<button id="launcher" data-action="open">誤答復習（Anki一体型）</button>`;return;}
    const scroll=app.querySelector('main')?.scrollTop||0;
    const body=screen==='home'?homeHtml():screen==='quiz'?quizHtml():endHtml();
    app.innerHTML=`<button id="launcher" data-action="toggle" style="display:none">誤答復習</button>
      <div id="backdrop"><section id="modal" role="dialog" aria-modal="true" aria-label="モントレ誤答復習">
      <header class="top"><h2>誤答復習（Anki一体型 v2.8）</h2><small>ブラウザ内で保存</small><button data-action="home" aria-label="ホーム">一覧</button><button data-action="close" aria-label="閉じる">✕</button></header>
      <main>${notice?`<div class="notice">${esc(notice)}</div>`:''}${body}</main></section></div>`;
    const main=app.querySelector('main');if(main)main.scrollTop=scroll;
    notice='';
  }
  function homeHtml() {
    const qs=all();
    const originalWrong=qs.filter(q=>q.initial==='×').length;
    const originalTriangle=qs.filter(q=>q.initial==='△').length;
    const reviewed=qs.filter(q=>history(q.id).length).length;
    const pending=qs.filter(needsReview).length;
    const resumable=session && session.ids?.length>0;
    return `<h3>間違えた問題だけを解き直す</h3>
      ${syncDiagnosticHtml()}
      <div class="stats"><div class="stat"><b>${qs.length}</b><span>登録問題数</span></div><div class="stat"><b>${pending}</b><span>未克服</span></div><div class="stat"><b>${qs.filter(q=>isBad(q)&&latest(q)==='○').length}</b><span>克服済み</span></div><div class="stat"><b>${qs.filter(q=>isBad(q)&&history(q.id).length&&BAD.has(latest(q))).length}</b><span>再誤答</span></div></div>
      <p class="sub">初回 ×：${originalWrong}問 ／ 初回 △：${originalTriangle}問 ／ 復習履歴あり：${reviewed}問</p>
      ${filterHtml()}
      <div class="card"><strong>復習を開始</strong><p class="sub">正解した問題は「未克服」のリストから外れる。△・×は残る。</p>
        <div class="actions"><button class="primary" data-action="start" data-kind="pending">未克服だけ（${getQueue('pending').length}問）</button><button data-action="start" data-kind="all-bad">初回 ×・△ 全件（${getQueue('all-bad').length}問）</button></div>
        <div class="actions"><button data-action="start" data-kind="first-wrong">初回 × のみ（${getQueue('first-wrong').length}問）</button><button data-action="start" data-kind="repeat-bad">復習後も ×・△（${getQueue('repeat-bad').length}問）</button></div>
        ${resumable?`<div class="actions"><button data-action="resume">前回の続き（${Math.min(session.index+1,session.ids.length)} / ${session.ids.length}問）</button></div>`:''}
        <p class="sub">復習した問題数：${reviewed}問。1周目の正誤はインポート時の記録である。</p>
      </div>
      <div class="card"><strong>JSONの読み込み・バックアップ</strong>
        <p class="sub">Anki追加箱と統合済み。解答と正答の比較で誤答が自動登録される。旧JSONも取り込み可能。</p>
        <div class="actions"><label class="filepicker">JSONファイルを追加<input id="import-file" type="file" accept=".json,application/json" multiple></label><button data-action="backup">バックアップを書き出す</button></div>
      </div>
      <p class="sub">※モントレ本体の演習履歴や解答を変更しない。画像は、JSONに含まれる問題用画像のみ表示する。元サイトの一部機能・掲載画像はログイン状態等に依存する。</p>`;
  }
  function parseExplanation(q){
 const source=String(q.explanation||'').trim();
 const labels=q.choices.map(c=>c.label).filter(x=>/^[A-Z]$/.test(x));
 const sections=Object.fromEntries(labels.map(x=>[x,[]]));
 if(!source||!labels.length)return{sections,common:source,structured:false};
 const headIndex=source.search(/選択肢考察\s*[：:]/);
 if(headIndex<0)return{sections,common:source,structured:false};
 const start=headIndex+source.slice(headIndex).match(/^選択肢考察\s*[：:]/)[0].length;
 const tail=source.slice(start);
 const stop=tail.search(/(?:正解\s*[：:]?\s*[A-Z](?=\s|$|[，,。]))|(?:ポイント\s*[：:])|(?:解説\s*[：:])|(?:関連\s*[：:])/);
 const choicePart=stop>=0?tail.slice(0,stop):tail;
 const suffix=stop>=0?tail.slice(stop):'';
 const prefix=source.slice(0,headIndex).trim();
 const allowed=labels.join('');
 const found=[...choicePart.matchAll(new RegExp('([○×])\\s*(['+allowed+'])(?=[\\s　，,。、：:]|$)','g'))];
 if(!found.length)return{sections,common:source,structured:false};
 const common=[prefix].filter(Boolean);
 const colonMarkers=[...choicePart.matchAll(new RegExp('(?:^|[\\s　])(['+allowed+'])[：:]','g'))];
 if(colonMarkers.length<2&&found.length>=3){
   const markerHead=choicePart.slice(0,found[found.length-1].index+found[found.length-1][0].length);
   if(!markerHead.replace(/([○×])\s*[A-Z]/g,'').replace(/[，,、\s　]/g,'')){
     return{sections,common:source,structured:false};
   }
 }
 if(colonMarkers.length>=2){
   const pre=choicePart.slice(0,colonMarkers[0].index).replace(/^[\s　，,○×A-Z]+/,'').trim();
   if(pre)common.push(pre);
   colonMarkers.forEach((m,i)=>{
     const seg=choicePart.slice(m.index+m[0].length,i+1<colonMarkers.length?colonMarkers[i+1].index:choicePart.length).trim();
     if(seg&&sections[m[1]])sections[m[1]].push(seg);
   });
 }else{
   found.forEach((m,i)=>{
     const seg=choicePart.slice(m.index+m[0].length,i+1<found.length?found[i+1].index:choicePart.length).trim().replace(/^[　\s，,：:]+/,'');
     if(seg&&!/^[，,、\s　]*$/.test(seg)){
       if(/^([，,、]|$)/.test(choicePart.slice(m.index+m[0].length,m.index+m[0].length+1)))return;
       sections[m[2]].push(seg);
     }
   });
   const first=choicePart.slice(0,found[0].index).trim();
   if(first)common.push(first);
 }
 if(suffix)common.push(suffix);
 const structured=Object.values(sections).some(v=>v.length);
 return structured?{sections,common:common.filter(Boolean).join('\n\n'),structured:true}:{sections,common:source,structured:false};
}
  function explanationHtml(q){
 if(!q.explanation)return'<p class="sub">この問題には解説が保存されていない。</p>';
 const parsed=parseExplanation(q);
 if(!parsed.structured)return`<div class="explanation">${esc(parsed.common)}</div>`;
 const items=q.choices.map(c=>{
   const desc=(parsed.sections[c.label]||[]).join('\n\n');
   const correct=q.answer.includes(c.label);
   return `<details class="exp-item ${correct?'exp-correct':''}" ${correct?'open':''}>
      <summary><span class="letter">${esc(c.label)}</span><span>${correct?'○':'×'} ${esc(c.text)}</span></summary>
      <div class="exp-text">${desc?esc(desc):'この選択肢固有の解説はない（共通解説を確認）。'}</div></details>`;
 }).join('');
 return `<div class="exp-toolbar"><strong>選択肢ごとの解説</strong><button data-action="expand-explanations">すべて展開</button></div>
    <div class="exp-group">${items}</div>${parsed.common?`<div class="exp-common"><strong>補足・共通解説</strong>\n${esc(parsed.common)}</div>`:''}
    <details><summary>解説の原文を表示</summary><div class="explanation">${esc(q.explanation)}</div></details>`;
}
  function quizHtml() {
    const q=currentQ();
    if(!q){screen='end';return endHtml();}
    const index=session.index+1,n=session.ids.length;
    const imgs=(q.images||[]).map(u=>safeImage(u)).filter(Boolean);
    const ansChecked=checkedResult!==null;
    return `<div class="sub">${esc(categoryLabel(q))}　｜　問題番号 ${esc(q.number)}　｜　初回 ${esc(q.initial||'未判定')}</div>
      <div class="progress"><div style="width:${Math.round(index/n*100)}%"></div></div>
      <h3>復習 ${index} / ${n} 問</h3>
      <div class="question">${esc(q.title)}</div>
      ${imgs.length?`<div class="images">${imgs.map(u=>`<img src="${esc(u)}" alt="問題の添付画像" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>`:''}
      <div class="sub">${q.answer.length>1?'複数選択の問題':'1つ選択する問題'}</div>
      <div class="choices">${q.choices.map(c=>`<label class="choice ${ansChecked && q.answer.includes(c.label)?'correct':''} ${ansChecked && selected.has(c.label) && !q.answer.includes(c.label)?'wrong':''}">
        <input type="${q.answer.length>1?'checkbox':'radio'}" name="ans" value="${esc(c.label)}" ${selected.has(c.label)?'checked':''} ${ansChecked?'disabled':''}>
        <span class="letter">${esc(c.label)}</span><span>${esc(c.text)}</span></label>`).join('')}</div>
      ${ansChecked?`<section class="result ${checkedResult.ok?'':'miss'}"><strong>${checkedResult.ok?'正解':'不正解'}　／　復習判定：${esc(checkedResult.mark)}</strong><div>正答：${esc(q.answer.join('・'))}</div>
        ${explanationHtml(q)}
        <div class="actions"><button data-action="mark" data-mark="△">△として残す</button><button data-action="mark" data-mark="×">×として残す</button><button data-action="mark" data-mark="○">○で定着</button></div></section>`:''}
      <div class="actions">${!ansChecked?'<button class="primary" data-action="check">解答して判定</button>':''}
        <button data-action="prev" ${index===1?'disabled':''}>前の問題</button><button class="primary" data-action="next">${index===n?'復習を終了':'次の問題'}</button></div>
      <div class="actions">${q.url?`<a class="button link" href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">元のモントレ問題を開く ↗</a>`:''}<button data-action="home">一覧に戻る</button></div>
      ${!ansChecked?'<p class="sub">解答前には正答・解説を表示しない。「次の問題」でスキップすると判定は保存されない。</p>':''}`;
  }
  function endHtml() {
    const ids=session?.ids || [];
    const done=ids.filter(id=>history(id).length).length;
    const bad=ids.filter(id=>store.questions[id] && latest(store.questions[id])!=='○').length;
    return `<h3>このセットの最後まで進んだ</h3><p>復習対象 ${ids.length}問／記録のある問題 ${done}問／現在 ×・△など ${bad}問</p>
      <div class="actions"><button class="primary" data-action="home">一覧に戻る</button><button data-action="start" data-kind="pending">残った問題を復習する</button></div>`;
  }
  function handleClick(e) {
    const btn=e.target.closest('[data-action]');if(!btn)return;
    const a=btn.dataset.action;
    if(a==='open' || a==='toggle') {screen='home';render();}
    else if(a==='close'){screen='closed';render();}
    else if(a==='home'){screen='home';render();}
    else if(a==='resume'){screen='quiz';selected.clear();checkedResult=null;render();}
    else if(a==='start'){startQueue(btn.dataset.kind);}
    else if(a==='prev'){jump(-1);}
    else if(a==='next'){jump(1);}
    else if(a==='check'){check();}
    else if(a==='mark'){const q=currentQ();if(q && checkedResult){updateLast(q,btn.dataset.mark);render();}}
    else if(a==='subject-filter'){filterSubject=btn.dataset.subject||'';filterTopic='';showAllTopics=false;saveFilters();render();}
    else if(a==='topic-filter'){filterTopic=btn.dataset.topic||'';saveFilters();render();}
    else if(a==='reset-filter'){filterSubject='';filterTopic='';filterSearch='';showAllTopics=false;saveFilters();render();}
    else if(a==='more-topics'){showAllTopics=!showAllTopics;render();}
    else if(a==='backup'){downloadBackup();}
    else if(a==='sync'){requestAutoSync();notice='Anki追加箱に再同期を要求しました。接続情報を確認してください。';render();}
    else if(a==='expand-explanations'){const details=[...shadow.querySelectorAll('.exp-group details')];const expand=details.some(d=>!d.open);details.forEach(d=>d.open=expand);btn.textContent=expand?'すべて閉じる':'すべて展開';}
  }
  function handleChange(e) {
    const el=e.target;
    if(el.id==='topic-search'){filterSearch=el.value;saveFilters();render();return;}
    if(el.id==='import-file'){
      const files=[...el.files];
      (async()=>{
        let valid=0, added=0, errors=[];
        for(const file of files){
          if(file.size>MAX_IMPORT_BYTES){errors.push(file.name+'（20MB超）');continue;}
          try {const info=importJson(JSON.parse(await file.text()));valid+=info.valid;added+=info.added;}
          catch(err){errors.push(file.name+'：'+err.message);}
        }
        notice=`読み込み：${valid}問を検証／新規登録 ${added}問。`+(errors.length?' エラー：'+errors.join('、'):'');
        render();
      })();return;
    }
    if(el.name==='ans'){
      const q=currentQ();if(!q || checkedResult)return;
      if(q.answer.length===1) selected=new Set(el.checked?[el.value]:[]);
      else if(el.checked)selected.add(el.value);
      else selected.delete(el.value);
      shadow.querySelectorAll('.choice').forEach(x=>x.classList.toggle('active',x.querySelector('input')?.checked));
    }
  }
  init();screen='closed';
  installAutoSync();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
} catch (_montreReviewError) {
  console.error('[誤答復習] 起動失敗', _montreReviewError);
}
// === END INTEGRATED MONTRE REVIEW ===
