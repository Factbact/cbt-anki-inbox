// ==UserScript==
// @name         モントレ用 Anki追加箱
// @namespace    https://github.com/Factbact/cbt-anki-inbox
// @version      2.2.0
// @description  モントレCBTの手動候補・自動指定・演習セッション・全問JSONを管理します
// @author       Factbact
// @match        https://m3e-medical.com/users/cbt*
// @match        https://www.m3e-medical.com/users/cbt*
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
  var VERSION = "2.2.0";
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
      if (name && state.largeCategoryMap[value] !== name) {
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
        if (!match || !subject) return;
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
      doc.querySelectorAll("a[href*='/users/montore/questions/search?category_id=']")
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
        return {
          division: values[0],
          subject: values[1],
          categoryId: categoryMatch ? categoryMatch[1] : null,
          source: "montore-explicit-category-links",
          confidence: "explicit"
        };
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
    if (categoryId && state.categoryMap[categoryId]) {
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
      if (largeName) {
        return {
          division: largeName,
          subject: "全範囲",
          largeCategoryId: largeIds[0],
          source: "selected-large-category",
          confidence: "explicit"
        };
      }
    }

    if (state.pendingContext && state.pendingContext.division && state.pendingContext.subject) {
      return Object.assign({}, state.pendingContext, {
        source: state.pendingContext.source || "clicked-category",
        confidence: "explicit"
      });
    }

    if (heading) {
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
    if (explicit) {
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
    if (search) return search;
    if (state.settings.manualDivision && state.settings.manualSubject) {
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
    return normalizeText(body ? (body.innerText || body.textContent || "") : "");
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
    var letters = String(value || "").toUpperCase().match(/[A-E]/g) || [];
    return Array.from(new Set(letters)).sort();
  }

  function parseCorrectAnswer(doc) {
    var text = getDocumentText(doc);
    var match = text.match(/(?:^|\n)正解\s*[:：]?\s*([A-E](?:\s*[,、・]\s*[A-E])*)/u);
    return match ? parseAnswerLetters(match[1]) : [];
  }

  function parseLatestAnswer(doc) {
    var text = getDocumentText(doc);
    var historyIndex = text.indexOf("解答履歴");
    var historyText = historyIndex >= 0 ? text.slice(historyIndex) : text;
    var matches = Array.from(historyText.matchAll(/解答\s*[:：]\s*([A-E](?:\s*[,、・]\s*[A-E])*)/gu));
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
    var hint = doc.querySelector("#hint-used");
    var hintUsed = Boolean(hint && (
      hint.value === "true" ||
      hint.getAttribute("data-hint-used") === "true"
    ));

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
      explanation: parseExplanation(doc),
      images: collectQuestionImages(doc, urlValue),
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
      "オススメのフィルタ",
      "コアカリキュラム項目",
      "科目未設定"
    ].indexOf(String(value).trim()) >= 0;
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
    if (categoryId && state.categoryMap[categoryId]) {
      return Object.assign({}, state.categoryMap[categoryId], {
        source: "session-search-category",
        confidence: "explicit"
      });
    }
    var largeIds = url.searchParams.getAll("large_category_ids[]");
    if (largeIds.length === 1 && state.largeCategoryMap[largeIds[0]]) {
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
      currentSession = pending;
    }

    if (!currentSession && practiceId) {
      currentSession = state.sessions.find(function (session) {
        return Array.isArray(session.practiceQuestionIds) && session.practiceQuestionIds.indexOf(practiceId) >= 0;
      }) || null;
    }

    var subjectKey = sessionSubjectKey(context, question ? question.total : options.total);
    if (!currentSession) {
      currentSession = state.sessions.find(function (session) {
        return session.status !== "completed" && session.subjectKey === subjectKey;
      }) || null;
    }

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
      if (sessionSearchContext) {
        currentSession.division = sessionSearchContext.division;
        currentSession.subject = sessionSearchContext.subject;
        currentSession.subjectSource = sessionSearchContext.source;
        currentSession.subjectKey = sessionSubjectKey(
          sessionSearchContext,
          question ? question.total : currentSession.expectedTotal
        );
      } else if (context && isInvalidSessionLabel(currentSession.division)) {
        // v1.0系で自己評価の「未演習」を大分類として保存したセッションを補正する。
        // 問題の第2階層を演習範囲とは決めつけず、大分類のみ採用する。
        currentSession.division = context.division;
        currentSession.subject = currentSession.subject &&
          !isInvalidSessionLabel(currentSession.subject) ?
          currentSession.subject : "全範囲";
        currentSession.subjectSource = "repaired-from-explicit-question-classification";
        currentSession.subjectKey = sessionSubjectKey({
          division: currentSession.division,
          subject: currentSession.subject
        }, question ? question.total : currentSession.expectedTotal);
      } else if (context && (!currentSession.division || !currentSession.subject ||
        currentSession.subjectSource === "unavailable")) {
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

  function captureCurrentQuestion() {
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
    scheduleRender();
  }

  function findSessionStartUrl(session) {
    var refs = (session.questionRefs || []).slice().sort(function (a, b) {
      return (a.position || 99999) - (b.position || 99999);
    });
    var first = refs.find(function (ref) { return ref.position === 1; });
    return first ? first.url : (refs[0] ? refs[0].url : null);
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function sleep(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }

  async function fetchQuestionPage(url) {
    var response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "text/html,application/xhtml+xml" }
    });
    if (!response.ok) throw new Error("問題ページ取得失敗: HTTP " + response.status);
    var html = await response.text();
    return parseHtml(html);
  }

  function validateExportQuestions(questions, session) {
    var errors = [];
    if (!session.expectedTotal) errors.push("予定問題数を取得できません");
    if (session.expectedTotal && questions.length !== session.expectedTotal) {
      errors.push("予定" + session.expectedTotal + "問に対して" + questions.length + "問しか取得できませんでした");
    }
    var ids = new Set();
    questions.forEach(function (question) {
      if (!question.problemNumber) errors.push("問題番号なし");
      if (question.problemNumber && ids.has(question.problemNumber)) {
        errors.push("問題番号" + question.problemNumber + "が重複");
      }
      ids.add(question.problemNumber);
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

  async function crawlSessionQuestions(session) {
    var startUrl = findSessionStartUrl(session);
    if (!startUrl) throw new Error("1問目のURLがありません。1問目を一度開いてください");
    var expected = Number(session.expectedTotal || 0);
    var results = [];
    var seenUrls = new Set();
    var url = startUrl;
    var safetyLimit = expected ? expected + 5 : 500;

    while (url && results.length < safetyLimit) {
      if (seenUrls.has(url)) break;
      seenUrls.add(url);
      setStatus("全問取得中 " + (results.length + 1) + " / " + (expected || "?") + "問", "info");
      var doc = await fetchQuestionPage(url);
      var question = extractQuestion(doc, url);
      if (!question) throw new Error((results.length + 1) + "問目の問題番号を取得できません");
      results.push(question);
      state.questionCache[question.problemNumber] = question;
      ensureSession(question, {
        division: question.subjectContext ? question.subjectContext.division : session.division,
        subject: question.subjectContext ? question.subjectContext.subject : session.subject,
        source: question.subjectContext ? question.subjectContext.acquisitionSource : session.subjectSource
      }, { allowCreate: false });
      if (expected && results.length >= expected) break;
      var nextUrl = question.nextQuestionUrl;
      if (!nextUrl || seenUrls.has(nextUrl)) break;
      url = nextUrl;
      await sleep(140);
    }
    saveState(true);
    return results;
  }

  function buildExportPayload(session, questions) {
    var sessionClassification = buildClassification(session.division, session.subject);
    var manualCandidates = activeCandidatesForSession(session.id).map(function (candidate) {
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
      return entry.sessionId === session.id && !entry.deletedAt;
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
      schemaVersion: "Montore_Anki_Manual_Backup_v1",
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
    downloadJson(payload, "montre_manual_candidates_" + nowIso().replace(/[:.]/g, "-") + ".json");
    setStatus("手動候補のバックアップJSONを保存しました", "success");
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
    exportRunning = true;
    render();
    try {
      var questions = await crawlSessionQuestions(currentSession);
      var errors = validateExportQuestions(questions, currentSession);
      if (errors.length) {
        var preview = errors.slice(0, 5).join("／");
        throw new Error(preview + (errors.length > 5 ? " ほか" + (errors.length - 5) + "件" : ""));
      }
      var payload = buildExportPayload(currentSession, questions);
      var safeSubject = (currentSession.division + "_" + currentSession.subject)
        .replace(/[\\/:*?"<>|\s]+/g, "_");
      var fileName = "montre_anki_" + safeSubject + "_" +
        nowIso().replace(/[:.]/g, "-") + ".json";
      downloadJson(payload, fileName);
      var exportedAt = nowIso();
      activeCandidatesForSession(currentSession.id).forEach(function (candidate) {
        if (!candidate.exportedAt) candidate.exportedAt = exportedAt;
      });
      currentSession.status = "completed";
      currentSession.completedAt = exportedAt;
      currentSession.exportedAt = exportedAt;
      currentSession.exportedFileName = fileName;
      state.pendingSessionId = null;
      saveState(true);
      setStatus("全" + questions.length + "問と手動候補のJSONを保存しました", "success");
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
    currentSession = null;
    var subjectKey = sessionSubjectKey(context, total);
    var reusable = state.sessions.find(function (session) {
      return session.status !== "completed" && session.subjectKey === subjectKey;
    });
    if (reusable) {
      currentSession = reusable;
    } else {
      ensureSession(null, context, {
        allowCreate: true,
        total: total,
        startedAt: nowIso(),
        searchUrl: location.href
      });
    }
    state.pendingContext = Object.assign({}, context, { capturedAt: nowIso() });
    state.pendingSessionId = currentSession ? currentSession.id : null;
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
          "<button class='mai-btn primary' id='mai-export' type='button' style='width:100%'>モントレ全問＋手動候補を取得</button>" +
          "<button class='mai-btn' id='mai-manual-export' type='button' style='width:100%;margin-top:6px'>手動候補バックアップJSON</button>" +
          "<div class='mai-muted' style='margin-top:5px'>全問再復習で1問目を開いてから実行してください。</div>" +
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
    var context = session && session.division && session.subject ? {
      division: session.division,
      subject: session.subject
    } : (question && question.subjectContext ? {
      division: question.subjectContext.division,
      subject: question.subjectContext.subject
    } : currentContext);
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
    var valid = currentContext && currentContext.division && currentContext.subject;
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
      var details = candidates.map(function (candidate) {
        return "<div class='mai-candidate'>" +
          escapeHtml(candidate.text || ("画像" + candidate.images.length + "枚")) +
          "<div class='mai-candidate-id'>" + escapeHtml(candidate.id) + "</div>" +
          "<button class='mai-btn danger' type='button' data-delete-candidate='" +
            escapeHtml(candidate.id) + "'>削除</button></div>";
      }).join("") || "<div class='mai-muted'>候補なし</div>";
      return "<details><summary>" + escapeHtml(label) + "</summary>" + details + "</details>";
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
    ui.exportButton.disabled = exportRunning || !currentSession;
    ui.exportButton.textContent = exportRunning ?
      "全問取得中…" : "モントレ全問＋手動候補を取得";
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
