// ==UserScript==
// @name         モントレ Anki 追加箱
// @namespace    montre-anki-inbox
// @version      2.1.0
// @description  モントレCBT専用。QB版に合わせた手動候補・科目自動判定・○でも自動指定・全問JSON取得。
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_anki_inbox.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_anki_inbox.user.js
// @match        https://m3e-medical.com/*
// @match        https://*.m3e-medical.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  /*
    v2.0:
    - 旧v1.xの圧縮/外部読込/eval方式を完全廃止
    - Tampermonkey本体として直接実行
    - 実際のモントレ本文
      「1問目/ 64問中」「問題番号 : 18102440」
      「解説を見る → 基礎医学 → 発生学」
      を基準に検出
  */

  const SOURCE = "モントレ";
  const ITEMS_KEY = "montre_anki_manual_candidates_v1";
  const SETTINGS_KEY = "montre_anki_settings_v1";
  const COUNTER_KEY = "montre_anki_manual_counters_v1";
  const SESSION_KEY = "montre_anki_exercise_state_v1";
  const GEOMETRY_KEY = "montre_anki_panel_geometry_v1";
  const PANEL_STATE_KEY = "montre_anki_panel_state_v1";
  const LAST_SUBJECT_KEY = "montre_anki_last_subject_v1";
  const ROOT_ID = "montre-anki-inbox-v20";
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  const SUBJECTS = [
    ["細胞生物学", ["細胞生物学", "細胞生物"]],
    ["組織・解剖", ["組織・解剖", "組織解剖", "組織学", "解剖学"]],
    ["生化学", ["生化学"]],
    ["分子遺伝学", ["分子遺伝学", "分子生物学", "遺伝学"]],
    ["発生学", ["発生学"]],
    ["生理学", ["生理学", "神経生理学"]],
    ["免疫", ["免疫学", "免疫"]],
    ["病理学", ["病理学", "病理"]],
    ["薬理学", ["薬理学", "薬理"]],
    ["微生物学", ["微生物学", "微生物"]],
    ["循環器", ["循環器", "循環"]],
    ["呼吸器", ["呼吸器", "呼吸"]],
    ["消化器", ["消化器", "消化"]],
    ["腎・泌尿器", ["腎・泌尿器", "腎泌尿器", "腎臓", "泌尿器"]],
    ["内分泌・代謝", ["内分泌・代謝", "内分泌代謝", "内分泌", "代謝"]],
    ["神経", ["神経"]],
    ["血液", ["血液"]],
    ["感染症", ["感染症", "感染"]],
    ["膠原病", ["膠原病", "リウマチ"]],
    ["小児科", ["小児科", "小児"]],
    ["産婦人科", ["産婦人科", "産科", "婦人科"]],
    ["整形外科", ["整形外科", "整形"]],
    ["皮膚科", ["皮膚科", "皮膚"]],
    ["眼科", ["眼科"]],
    ["耳鼻咽喉科", ["耳鼻咽喉科", "耳鼻科", "耳鼻"]],
    ["精神科", ["精神科", "精神"]],
    ["救急", ["救急"]],
    ["麻酔科", ["麻酔科", "麻酔"]],
    ["放射線科", ["放射線科", "放射線"]]
  ];

  const BASIC = new Set([
    "細胞生物学", "組織・解剖", "生化学", "分子遺伝学",
    "発生学", "生理学", "免疫", "病理学", "薬理学", "微生物学"
  ]);

  let host = null;
  let shadow = null;
  let panel = null;
  let stagedImages = [];
  let lastSelection = "";
  let hoveredImage = null;
  let lastUrl = location.href;
  let toastTimer = null;
  let resizeState = null;
  let exportRunning = false;
  let monitorQueued = false;
  const nextBypass = new WeakSet();

  const $ = (id) => shadow?.getElementById(id);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getValue(key, fallback) {
    try {
      const value = GM_getValue(key, fallback);
      return value == null ? fallback : value;
    } catch (error) {
      console.error("[Montre Anki] GM_getValue", error);
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      GM_setValue(key, value);
    } catch (error) {
      console.error("[Montre Anki] GM_setValue", error);
    }
  }

  function normalize(value) {
    return String(value || "")
      .replace(/\r/g, "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function bodyText(doc = document) {
    return normalize(doc?.body?.innerText || doc?.body?.textContent || "");
  }

  function lines(doc = document) {
    return String(doc?.body?.innerText || doc?.body?.textContent || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/\u00a0/g, " ").trim())
      .filter(Boolean);
  }

  function controlLabel(el) {
    return String(
      el?.innerText || el?.textContent || el?.value ||
      el?.getAttribute?.("aria-label") || ""
    ).replace(/\s+/g, "").trim();
  }

  function now() {
    return new Date().toISOString();
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("ja-JP", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(date);
  }

  function toast(message) {
    const el = $("toast");
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.add("show");
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function parseProgress(text = bodyText()) {
    const match = String(text).match(/(\d+)\s*問目\s*[\/／]\s*(\d+)\s*問\s*中/);
    return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
  }

  function parseProblemNumber(doc = document) {
    const match = bodyText(doc).match(/問題番号\s*[:：]\s*(\d{5,14})/);
    return match ? match[1] : null;
  }

  function isQuestionPage(doc = document) {
    const number = parseProblemNumber(doc);
    if (number) return true;
    if (doc === document) {
      return /\/users\/cbt\/practice_questions\/\d+/i.test(location.pathname);
    }
    return false;
  }

  function normalizeSubjectLabel(raw) {
    return String(raw || "")
      .normalize("NFKC")
      .replace(/[（(]\s*\d+\s*[）)]\s*$/, "")
      .replace(/(?:科目|領域|分野)\s*$/g, "")
      .replace(/[\s　・･\/／>＞→:：|｜,，.。\-_–—]+/g, "")
      .trim();
  }

  function canonicalSubject(raw) {
    const clean = normalizeSubjectLabel(raw);
    for (const [canonical, aliases] of SUBJECTS) {
      if (aliases.some((alias) => clean === normalizeSubjectLabel(alias))) return canonical;
    }
    return null;
  }

  function findSubjectInText(raw) {
    const clean = normalizeSubjectLabel(raw);
    const aliases = SUBJECTS.flatMap(([canonical, values]) =>
      values.map((alias) => ({ canonical, alias, clean: normalizeSubjectLabel(alias) }))
    ).sort((a, b) => b.clean.length - a.clean.length);
    return aliases.find((entry) => entry.clean && clean.includes(entry.clean)) || null;
  }

  function makeSubjectResult(division, match, source) {
    if (!match?.canonical) return null;
    const resolvedDivision =
      division || (BASIC.has(match.canonical) ? "基礎医学" : "臨床医学");
    return {
      division: resolvedDivision,
      subject: match.canonical,
      source,
      evidence: `${resolvedDivision} → ${match.alias}`
    };
  }

  function detectSubjectDirect(doc = document) {
    const allLines = lines(doc);
    const explanationIndexes = [];
    allLines.forEach((line, index) => {
      if (line.includes("解説を見る")) explanationIndexes.push(index);
    });

    for (let e = explanationIndexes.length - 1; e >= 0; e--) {
      const start = explanationIndexes[e];
      for (let i = start + 1; i < Math.min(allLines.length, start + 120); i++) {
        const division = allLines[i].includes("基礎医学")
          ? "基礎医学"
          : allLines[i].includes("臨床医学") ? "臨床医学" : null;
        if (!division) continue;
        const nearby = allLines.slice(i, Math.min(allLines.length, i + 9)).join(" ");
        const result = makeSubjectResult(
          division,
          findSubjectInText(nearby.replace(division, "")),
          "解説後の分類"
        );
        if (result) return result;
      }
    }

    const fullText = bodyText(doc).normalize("NFKC");
    for (const division of ["基礎医学", "臨床医学"]) {
      let index = fullText.lastIndexOf(division);
      while (index >= 0) {
        const tail = fullText.slice(index + division.length, index + division.length + 240);
        const result = makeSubjectResult(
          division,
          findSubjectInText(tail),
          "医学区分付近の分類"
        );
        if (result) return result;
        index = fullText.lastIndexOf(division, index - 1);
      }
    }

    const semanticSelectors = [
      "nav",
      "[aria-label*='パンくず']",
      "[aria-label*='breadcrumb' i]",
      "[class*='breadcrumb' i]",
      "[class*='category' i]",
      "[class*='subject' i]"
    ];
    for (const element of doc.querySelectorAll(semanticSelectors.join(","))) {
      const text = normalize(element.innerText || element.textContent || "");
      if (!text || text.length > 500) continue;
      const division = text.includes("基礎医学")
        ? "基礎医学"
        : text.includes("臨床医学") ? "臨床医学" : null;
      const result = makeSubjectResult(
        division,
        findSubjectInText(text.replace(/基礎医学|臨床医学/g, "")),
        "パンくず・分類表示"
      );
      if (result) return result;
    }

    const explicit = fullText.match(
      /(?:科目|分野|領域|カテゴリ(?:ー)?)\s*[:：]\s*([^\n]{1,40})/
    );
    if (explicit) {
      const result = makeSubjectResult(
        null,
        findSubjectInText(explicit[1]),
        "科目ラベル"
      );
      if (result) return result;
    }

    for (const script of doc.querySelectorAll("script")) {
      const source = script.textContent || "";
      if (!source || source.length > 2_000_000) continue;
      const match = source.match(
        /["'](?:subject|subject_name|subjectName|category_name|categoryName|field_name)["']\s*[:=]\s*["']([^"']{1,50})["']/i
      );
      if (!match) continue;
      const result = makeSubjectResult(
        null,
        findSubjectInText(match[1]),
        "ページ内データ"
      );
      if (result) return result;
    }

    for (let i = allLines.length - 1; i >= 0; i--) {
      const division = allLines[i].includes("基礎医学")
        ? "基礎医学"
        : allLines[i].includes("臨床医学") ? "臨床医学" : null;
      if (!division) continue;
      const nearby = allLines.slice(i, Math.min(allLines.length, i + 9)).join(" ");
      const result = makeSubjectResult(
        division,
        findSubjectInText(nearby.replace(division, "")),
        "本文末尾の分類"
      );
      if (result) return result;
    }
    return null;
  }

  function getLastSubjectContext() {
    const value = getValue(LAST_SUBJECT_KEY, null);
    return value && typeof value === "object" ? value : null;
  }

  function saveLastSubjectContext(detected, doc = document) {
    if (!detected?.subject) return;
    setValue(LAST_SUBJECT_KEY, {
      division: detected.division,
      subject: detected.subject,
      evidence: detected.evidence,
      totalQuestions: parseProgress(bodyText(doc))?.total || null,
      pageUrl: doc === document ? location.href : String(doc?.URL || ""),
      detectedAt: now()
    });
  }

  function detectSubject(doc = document, { allowCached = true } = {}) {
    const direct = detectSubjectDirect(doc);
    if (direct) return direct;
    if (!allowCached || !isQuestionPage(doc)) return null;

    const cached = getLastSubjectContext();
    if (!cached?.subject) return null;
    const total = parseProgress(bodyText(doc))?.total || null;
    if (cached.totalQuestions && total && cached.totalQuestions !== total) return null;
    return {
      division: cached.division,
      subject: cached.subject,
      source: "直前ページの自動取得",
      evidence: `${cached.division} → ${cached.subject}（前ページから継続）`
    };
  }

  function getSettings() {
    const value = getValue(SETTINGS_KEY, {});
    return {
      division: value?.division === "臨床医学" ? "臨床医学" : "基礎医学",
      subject: String(value?.subject || "").trim()
    };
  }

  function saveSettings(value) {
    setValue(SETTINGS_KEY, value);
  }

  function syncSubjectFromPage() {
    const detected = detectSubject();
    if (!detected) return null;
    if (detected.source !== "直前ページの自動取得") {
      saveLastSubjectContext(detected);
    }
    const current = getSettings();
    if (current.division !== detected.division || current.subject !== detected.subject) {
      saveSettings({ division: detected.division, subject: detected.subject });
    }
    repairUnknownSession(detected);
    return detected;
  }

  function getItems() {
    const value = getValue(ITEMS_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  function saveItems(value) {
    setValue(ITEMS_KEY, value);
    render();
  }

  function getCounters() {
    const value = getValue(COUNTER_KEY, {});
    return value && typeof value === "object" ? value : {};
  }

  function peekManualId(problemNumber) {
    if (!problemNumber) return null;
    const counters = getCounters();
    const next = Number(counters[problemNumber] || 0) + 1;
    return `montre:${problemNumber}:manual:${String(next).padStart(2, "0")}`;
  }

  function consumeManualId(problemNumber) {
    if (!problemNumber) return null;
    const counters = getCounters();
    const next = Number(counters[problemNumber] || 0) + 1;
    counters[problemNumber] = next;
    setValue(COUNTER_KEY, counters);
    return `montre:${problemNumber}:manual:${String(next).padStart(2, "0")}`;
  }

  function getState() {
    const value = getValue(SESSION_KEY, {});
    return {
      activeSessionId: value?.activeSessionId || value?.active || null,
      warningSessionId: value?.warningSessionId || value?.warning || null,
      sessions: value?.sessions && typeof value.sessions === "object" ? value.sessions : {}
    };
  }

  function saveState(value) {
    value.active = value.activeSessionId || null;
    value.warning = value.warningSessionId || null;
    setValue(SESSION_KEY, value);
  }

  function currentSession() {
    const state = getState();
    return state.activeSessionId ? state.sessions[state.activeSessionId] || null : null;
  }

  function sessionItems(sessionId) {
    return getItems().filter((item) => item.exerciseSessionId === sessionId);
  }

  function pendingCount(list) {
    return list.filter((item) => !item.exportedAt).length;
  }

  function exerciseKey(settings = getSettings(), p = parseProgress()) {
    return [settings.division, settings.subject || "科目未設定", p?.total || "?"].join("|");
  }

  function repairUnknownSession(detected) {
    if (!detected?.subject) return;
    const state = getState();
    const id = state.activeSessionId;
    const session = id ? state.sessions[id] : null;
    if (!session || session.completedAt) return;
    if (!session.subject || session.subject === "科目未設定") {
      session.subject = detected.subject;
      session.division = detected.division;
      session.exerciseKey = [
        detected.division,
        detected.subject,
        session.totalQuestions || session.total || parseProgress()?.total || "?"
      ].join("|");
      session.key = session.exerciseKey;
      saveState(state);
    }
  }

  function ensureSession() {
    if (!isQuestionPage()) return null;
    syncSubjectFromPage();
    const settings = getSettings();
    if (!settings.subject) return currentSession();

    const p = parseProgress();
    const key = exerciseKey(settings, p);
    const state = getState();
    const active = currentSession();

    if (active && !active.completedAt && (active.exerciseKey === key || active.key === key)) {
      return active;
    }

    const reusable = Object.values(state.sessions)
      .filter((session) => {
        if (!session || session.completedAt) return false;
        return session.exerciseKey === key || session.key === key;
      })
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0];

    if (reusable) {
      state.activeSessionId = reusable.id;
      if (state.warningSessionId === reusable.id) state.warningSessionId = null;
      saveState(state);
      return reusable;
    }

    if (active && !active.completedAt && pendingCount(sessionItems(active.id)) > 0) {
      state.warningSessionId = active.id;
    }

    const id = `montre-session:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const session = {
      id,
      exerciseKey: key,
      key,
      source: SOURCE,
      division: settings.division,
      subject: settings.subject,
      totalQuestions: p?.total || null,
      total: p?.total || null,
      startedAt: now(),
      completedAt: null,
      automaticOverrides: {},
      overrides: {}
    };

    state.sessions[id] = session;
    state.activeSessionId = id;
    saveState(state);
    return session;
  }

  function completeSession(sessionId) {
    const state = getState();
    const session = state.sessions[sessionId];
    if (!session) return;
    session.completedAt = session.completedAt || now();
    if (state.warningSessionId === sessionId) state.warningSessionId = null;
    saveState(state);
  }

  function overrideMap(session) {
    if (!session) return {};
    return session.automaticOverrides || session.overrides || {};
  }

  function getOverrides(sessionId) {
    const state = getState();
    const session = state.sessions[sessionId];
    if (!session) return [];
    return Object.values(overrideMap(session));
  }

  function toggleOverride() {
    const problemNumber = parseProblemNumber();
    const session = ensureSession();
    if (!problemNumber) return toast("問題番号を取得できません");
    if (!session) return toast("科目を取得できないため設定できません");

    const state = getState();
    const target = state.sessions[session.id];
    if (!target.automaticOverrides) target.automaticOverrides = clone(target.overrides || {});
    if (!target.overrides) target.overrides = {};

    if (target.automaticOverrides[problemNumber]) {
      delete target.automaticOverrides[problemNumber];
      delete target.overrides[problemNumber];
      toast("自動カード指定を解除しました");
    } else {
      const entry = {
        problemNumber,
        addedAt: now(),
        forceAutomaticRegardlessOfRating: true
      };
      target.automaticOverrides[problemNumber] = entry;
      target.overrides[problemNumber] = entry;
      toast("この問題は○でも自動カード化します");
    }
    saveState(state);
    render();
  }

  function removeOverride(sessionId, problemNumber) {
    const state = getState();
    const session = state.sessions[sessionId];
    if (!session) return;
    if (session.automaticOverrides) delete session.automaticOverrides[problemNumber];
    if (session.overrides) delete session.overrides[problemNumber];
    saveState(state);
    render();
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("画像読込失敗"));
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    for (const file of files || []) {
      if (!file?.type?.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        toast("8MBを超える画像は追加できません");
        continue;
      }
      stagedImages.push({
        src: await fileToDataUrl(file),
        fileName: file.name || null,
        capturedAt: now()
      });
    }
    renderImages();
  }

  function appendMemo(text) {
    const memo = $("memo");
    if (!memo || !String(text || "").trim()) return;
    memo.value = memo.value.trim()
      ? `${memo.value.trim()}\n${String(text).trim()}`
      : String(text).trim();
  }

  async function handlePaste(event) {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = [...clipboard.files].filter((file) => file.type?.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      await addFiles(files);
      toast(`${files.length}枚貼り付けました`);
      return;
    }
    const text = clipboard.getData("text/plain");
    if (text) {
      event.preventDefault();
      appendMemo(text);
      toast("文字を貼り付けました");
    }
  }

  function renderImages() {
    const container = $("image-list");
    if (!container) return;
    container.innerHTML = "";
    stagedImages.forEach((image, index) => {
      const box = document.createElement("div");
      box.className = "image-thumb";
      const img = document.createElement("img");
      img.src = image.src;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.onclick = () => {
        stagedImages.splice(index, 1);
        renderImages();
      };
      box.append(img, remove);
      container.appendChild(box);
    });
  }

  function captureSelection() {
    let changed = false;
    if (lastSelection) {
      appendMemo(lastSelection);
      changed = true;
    }
    if (hoveredImage?.src) {
      stagedImages.push({
        src: hoveredImage.src,
        alt: hoveredImage.alt || "",
        capturedAt: now()
      });
      renderImages();
      changed = true;
    }
    toast(changed ? "取り込みました" : "選択中の文字・画像がありません");
  }

  function hasDraft() {
    return Boolean($("memo")?.value.trim() || stagedImages.length);
  }

  function saveDraft({ silent = false } = {}) {
    const raw = $("memo")?.value || "";
    const draftLines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (!draftLines.length && !stagedImages.length) {
      if (!silent) toast("追加する内容がありません");
      return false;
    }

    syncSubjectFromPage();
    const settings = getSettings();
    const problemNumber = parseProblemNumber();

    if (!isQuestionPage() || !problemNumber) {
      toast("問題番号を取得できないため保存しません");
      return false;
    }
    if (!settings.subject) {
      toast("科目を取得できません。設定から科目を指定してください");
      return false;
    }

    const session = ensureSession();
    if (!session) {
      toast("演習セッションを開始できません");
      return false;
    }

    const alsoAutomatic = Boolean($("also-auto")?.checked);
    const targets = draftLines.length ? draftLines : [""];
    const all = getItems();

    for (const text of targets) {
      all.push({
        captureId: crypto.randomUUID?.() || `capture:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        ankiId: consumeManualId(problemNumber),
        rawText: text,
        images: clone(stagedImages),
        alsoCreateAutomatic: alsoAutomatic,
        automaticCardPolicy: alsoAutomatic ? "manual_plus_automatic" : "manual_only",
        source: SOURCE,
        division: settings.division,
        subject: settings.subject,
        exerciseSessionId: session.id,
        sourceProblem: {
          problemNumber,
          progress: parseProgress(),
          pageUrl: location.href,
          pageTitle: document.title || ""
        },
        savedAt: now(),
        exportedAt: null
      });
    }

    setValue(ITEMS_KEY, all);
    $("memo").value = "";
    $("also-auto").checked = false;
    stagedImages = [];
    renderImages();
    render();
    toast(`${targets.length}件追加しました`);
    return true;
  }

  function deleteCandidate(captureId) {
    const all = getItems();
    const target = all.find((item) => item.captureId === captureId);
    if (!target) return;
    if (!confirm(`この候補を削除しますか？\n\n${target.rawText || target.ankiId || "画像のみ"}\n\n※manual IDの連番は戻りません。`)) return;
    saveItems(all.filter((item) => item.captureId !== captureId));
  }

  function findNextHref(doc, baseUrl) {
    const isNext = (element) => {
      const value = controlLabel(element);
      return value === "次の問題" ||
        value === "次の問題へ" ||
        value === "次へ" ||
        value.includes("スキップして次へ");
    };
    const toUrl = (raw) => {
      if (!raw || /^\s*(?:#|javascript:)/i.test(raw)) return null;
      try {
        return new URL(raw, baseUrl).href.split("#")[0];
      } catch {
        return null;
      }
    };

    const relNext = doc.querySelector("a[rel~='next'][href], link[rel~='next'][href]");
    if (relNext) {
      const url = toUrl(relNext.getAttribute("href"));
      if (url) return url;
    }

    const controls = [...doc.querySelectorAll(
      "a[href], button, [role='button'], input[type='button'], input[type='submit']"
    )].filter(isNext);

    for (const control of controls) {
      for (const attribute of ["href", "data-href", "data-url", "formaction"]) {
        const url = toUrl(control.getAttribute(attribute));
        if (url) return url;
      }

      const parentLink = control.closest?.("a[href]");
      const parentUrl = toUrl(parentLink?.getAttribute("href"));
      if (parentUrl) return parentUrl;

      const form = control.form || control.closest?.("form");
      if (form && String(form.method || "get").toLowerCase() === "get") {
        const action = toUrl(form.getAttribute("action") || baseUrl);
        if (action) {
          try {
            const nextUrl = new URL(action);
            for (const field of form.querySelectorAll("input[name], select[name]")) {
              if (field.disabled || !field.name) continue;
              if ((field.type === "checkbox" || field.type === "radio") && !field.checked) continue;
              nextUrl.searchParams.set(field.name, field.value || "");
            }
            return nextUrl.href.split("#")[0];
          } catch {}
        }
      }

      const inline = control.getAttribute("onclick") || "";
      const inlineMatch = inline.match(
        /(?:location(?:\.href)?\s*=|window\.open\s*\()\s*["']([^"']+)["']/i
      );
      const inlineUrl = toUrl(inlineMatch?.[1]);
      if (inlineUrl) return inlineUrl;
    }
    return null;
  }

  function detectSelfRating(doc) {
    const text = bodyText(doc);
    const explicit = text.match(/自己評価\s*[:：]?\s*(◎|○|△|×)/);
    if (explicit) return { selfRating: explicit[1], source: "explicit_text" };

    const counts = { circle: 0, triangle: 0, dial: 0, exclamation: 0 };
    for (const image of doc.querySelectorAll("img")) {
      const value = [
        image.getAttribute("src") || "",
        image.getAttribute("alt") || "",
        image.className || ""
      ].join(" ").toLowerCase();
      for (const key of Object.keys(counts)) {
        if (value.includes(key)) counts[key]++;
      }
    }

    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (ranked[0]?.[1] > 0 && ranked[0][1] > (ranked[1]?.[1] || 0)) {
      return {
        selfRating: { circle: "○", triangle: "△", dial: "×", exclamation: null }[ranked[0][0]],
        source: "asset_count",
        counts
      };
    }
    return { selfRating: null, source: "unavailable", counts };
  }

  function extractImages(doc, url) {
    const seen = new Set();
    return [...doc.querySelectorAll("img")]
      .map((image) => {
        const raw = image.currentSrc || image.src || image.getAttribute("src");
        if (!raw) return null;
        try {
          const src = new URL(raw, url).href;
          if (seen.has(src)) return null;
          seen.add(src);
          return {
            src,
            alt: image.alt || "",
            width: image.naturalWidth || null,
            height: image.naturalHeight || null
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function snapshotQuestion(doc, url) {
    const rating = detectSelfRating(doc);
    return {
      source: SOURCE,
      url,
      problemNumber: parseProblemNumber(doc),
      progress: parseProgress(bodyText(doc)),
      subjectContext: detectSubject(doc),
      text: bodyText(doc),
      images: extractImages(doc, url),
      latestAttempt: {
        selfRating: rating.selfRating,
        selfRatingSource: rating.source,
        selfRatingEvidence: rating.counts || null
      }
    };
  }

  function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  }

  async function exportAllQuestions() {
    if (exportRunning) return toast("全問取得は実行中です");
    syncSubjectFromPage();
    let settings = getSettings();
    const p = parseProgress();
    if (!isQuestionPage()) return toast("モントレの問題画面で実行してください");
    if (!p?.total) return toast("全問題数を取得できません。1問目で実行してください");

    if (p.current !== 1) {
      const proceed = confirm(`現在${p.current}問目です。\n全問取得は1問目で実行するのが安全です。\n\nこの位置から続けますか？`);
      if (!proceed) return;
    }

    exportRunning = true;
    const exportButton = $("export-all");
    if (exportButton) {
      exportButton.disabled = true;
      exportButton.textContent = "全問取得中…";
    }

    try {
    let session = ensureSession();
    const questions = [];
    const visitedUrls = new Set();
    const visitedProblemNumbers = new Set();
    let url = location.href.split("#")[0];
    let error = null;

    toast("全問取得を開始しました");

    for (let i = 0; i < p.total && url && !visitedUrls.has(url); i++) {
      visitedUrls.add(url);
      try {
        const response = await fetch(url, { credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const question = snapshotQuestion(doc, url);
        if (
          question.subjectContext?.subject &&
          question.subjectContext.source !== "直前ページの自動取得"
        ) {
          saveLastSubjectContext(question.subjectContext, doc);
          saveSettings({
            division: question.subjectContext.division,
            subject: question.subjectContext.subject
          });
          settings = getSettings();
          if (!session) session = ensureSession();
        }

        if (question.problemNumber && visitedProblemNumbers.has(question.problemNumber)) {
          error = `問題番号 ${question.problemNumber} を再検出したため停止`;
          break;
        }
        if (question.problemNumber) visitedProblemNumbers.add(question.problemNumber);
        questions.push(question);
        toast(`取得中 ${questions.length}/${p.total}`);
        if (questions.length >= p.total) break;

        const next = findNextHref(doc, url);
        if (!next) {
          error = "次の問題URLを取得できません";
          break;
        }
        url = next;
      } catch (e) {
        error = e?.message || String(e);
        break;
      }
    }

    const manual = session ? sessionItems(session.id) : [];
    const overrides = session ? getOverrides(session.id) : [];
    const problemNumbers = new Set(
      questions.map((question) => String(question.problemNumber || "")).filter(Boolean)
    );
    const includedManual = manual.filter((item) =>
      problemNumbers.has(String(item?.sourceProblem?.problemNumber || ""))
    );
    const includedOverrides = overrides.filter((entry) =>
      problemNumbers.has(String(entry?.problemNumber || ""))
    );

    const output = {
      source: SOURCE,
      exporterVersion: "2.1.0",
      expectedQuestions: p.total,
      retrievedQuestions: questions.length,
      complete: questions.length === p.total && !error,
      error,
      exportedAt: now(),
      subjectContext: settings,
      exerciseSession: session ? {
        id: session.id,
        startedAt: session.startedAt,
        subject: session.subject,
        division: session.division
      } : null,
      idPolicy: {
        automatic: "montre:<問題番号>",
        manual: "montre:<問題番号>:manual:<2-digit-sequence>",
        manualSequencePersistent: true
      },
      automaticCardPolicy: {
        manualRule: "同じ問題番号に手動候補がある場合は原則manual_only。alsoCreateAutomatic=trueなら自動カードも作る",
        overrideRule: "automaticCardOverrides指定問題は自己評価が○でも自動カードを1枚作る",
        precedence: "explicit override > manual_only suppression > normal automatic eligibility"
      },
      manualCandidates: { included: includedManual.length, candidates: includedManual },
      automaticCardOverrides: { included: includedOverrides.length, entries: includedOverrides },
      questions
    };

    const safeSubject = (settings.subject || "科目未設定").replace(/[\\/:*?"<>|]/g, "_");
    const filename = `montre_${safeSubject}_${questions.length}questions_with_answers.json`;
    downloadJson(output, filename);

    const all = getItems();
    const exportedIds = new Set(includedManual.map((item) => item.captureId));
    for (const item of all) {
      if (exportedIds.has(item.captureId)) {
        item.exportedAt = now();
        item.exportFilename = filename;
      }
    }
    setValue(ITEMS_KEY, all);
    if (output.complete && session) completeSession(session.id);
    render();
    toast(output.complete
      ? `${questions.length}問＋手動${includedManual.length}件を書き出しました`
      : `${questions.length}/${p.total}問で停止：${error || "不明"}`
    );
    } finally {
      exportRunning = false;
      const button = $("export-all");
      if (button) {
        button.disabled = false;
        button.textContent = "モントレ全問＋手動候補を取得";
      }
    }
  }

  function exportManualOnly() {
    const session = currentSession();
    if (!session) return toast("現在の演習がありません");
    const manual = sessionItems(session.id);
    const overrides = getOverrides(session.id);
    if (!manual.length && !overrides.length) return toast("書き出す候補がありません");

    const output = {
      format: "Montre_Anki_ManualCandidates_v2.0",
      source: SOURCE,
      exportedAt: now(),
      exerciseSession: session,
      manualCandidates: manual,
      automaticCardOverrides: overrides
    };

    downloadJson(output, `montre_Anki追加候補_${session.subject}_${manual.length}件.json`);
    const all = getItems();
    const ids = new Set(manual.map((item) => item.captureId));
    for (const item of all) {
      if (ids.has(item.captureId)) item.exportedAt = now();
    }
    setValue(ITEMS_KEY, all);
    render();
    toast("手動候補を書き出しました");
  }

  function candidateCard(item) {
    const card = document.createElement("div");
    card.className = "candidate";
    const body = document.createElement("div");
    body.className = "candidate-body";
    const title = document.createElement("div");
    title.className = "candidate-title";
    title.textContent = item.rawText?.trim() || (item.images?.length ? "画像のみ" : "内容なし");
    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    meta.textContent =
      `問題 ${item?.sourceProblem?.problemNumber || "?"}` +
      ` ／ ${item.ankiId || ""}` +
      ` ／ ${item.alsoCreateAutomatic ? "手動＋自動" : "手動のみ"}` +
      ` ／ ${item.exportedAt ? "書出済" : "未書出"}`;
    body.append(title, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini danger";
    remove.textContent = "削除";
    remove.onclick = () => deleteCandidate(item.captureId);
    card.append(body, remove);
    return card;
  }

  function overrideCard(entry, sessionId) {
    const card = document.createElement("div");
    card.className = "candidate";
    const body = document.createElement("div");
    body.className = "candidate-body";
    const title = document.createElement("div");
    title.className = "candidate-title";
    title.textContent = `問題 ${entry.problemNumber}`;
    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    meta.textContent = `○でも自動 ／ ${formatTime(entry.addedAt)}`;
    body.append(title, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini";
    remove.textContent = "解除";
    remove.onclick = () => removeOverride(sessionId, entry.problemNumber);
    card.append(body, remove);
    return card;
  }

  function render() {
    if (!shadow) return;
    const detected = detectSubject();
    const settings = getSettings();
    const session = currentSession();
    const p = parseProgress();
    const problemNumber = parseProblemNumber();

    $("division").value = settings.division;
    $("subject").value = settings.subject;
    $("destination").textContent = `${settings.division} ＞ ${settings.subject || "科目未設定"}`;
    $("detect-status").textContent = detected ? `自動取得：${detected.evidence}` : "科目を自動取得できていません";
    $("detect-status").className = detected ? "status ok" : "status warn";
    $("question-info").textContent = problemNumber
      ? [
          p ? `${p.current}/${p.total}問目` : "進捗未取得",
          `問題番号 ${problemNumber}`,
          `次ID ${peekManualId(problemNumber)}`
        ].join(" ／ ")
      : "問題番号を取得できていません";

    const currentItems = session ? sessionItems(session.id) : [];
    const currentOverrides = session ? getOverrides(session.id) : [];
    $("count").textContent = `${currentItems.length}件 ／ 未出 ${pendingCount(currentItems)}件`;
    $("session-title").textContent = session
      ? `${session.division} ＞ ${session.subject}`
      : `${settings.division} ＞ ${settings.subject || "科目未設定"}`;
    $("session-meta").textContent = session
      ? `開始 ${formatTime(session.startedAt)} ／ ${session.totalQuestions || session.total || p?.total || "?"}問 ／ ${session.completedAt ? "完了" : "未完了"}`
      : "科目取得後、問題画面で演習セッションを開始します";

    const candidateList = $("candidate-list");
    candidateList.innerHTML = "";
    if (!currentItems.length) {
      candidateList.innerHTML = `<div class="empty">手動候補なし</div>`;
    } else {
      currentItems.forEach((item) => candidateList.appendChild(candidateCard(item)));
    }

    const overrideList = $("override-list");
    overrideList.innerHTML = "";
    if (!currentOverrides.length) {
      overrideList.innerHTML = `<div class="empty">○でも自動指定なし</div>`;
    } else {
      currentOverrides.forEach((entry) =>
        overrideList.appendChild(overrideCard(entry, session.id))
      );
    }

    const isOverride = Boolean(
      problemNumber && currentOverrides.some(
        (entry) => String(entry.problemNumber) === String(problemNumber)
      )
    );
    $("force-auto").textContent = isOverride
      ? "✓ ○でも自動カード化する"
      : "○でもこの問題を自動カード化";
    $("force-auto").classList.toggle("active", isOverride);
    $("force-auto").disabled = !problemNumber || !settings.subject;

    const state = getState();
    const history = $("history");
    history.innerHTML = "";
    const oldSessions = Object.values(state.sessions)
      .filter((item) => item.id !== state.activeSessionId)
      .filter((item) => sessionItems(item.id).length || getOverrides(item.id).length)
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));

    if (!oldSessions.length) {
      history.innerHTML = `<div class="empty">過去の演習なし</div>`;
    } else {
      for (const old of oldSessions) {
        const details = document.createElement("details");
        details.className = "history-item";
        const summary = document.createElement("summary");
        summary.textContent =
          `${old.division || ""} ＞ ${old.subject || "科目未設定"}` +
          `｜${formatTime(old.startedAt)}` +
          `｜手動${sessionItems(old.id).length}` +
          `｜${old.completedAt ? "完了" : "未完了"}`;
        const body = document.createElement("div");
        body.className = "history-body";
        sessionItems(old.id).forEach((item) => body.appendChild(candidateCard(item)));
        getOverrides(old.id).forEach((entry) => body.appendChild(overrideCard(entry, old.id)));
        details.append(summary, body);
        history.appendChild(details);
      }
    }

    const launcher = $("launcher");
    launcher.textContent = `＋ Anki ${currentItems.length}` +
      (settings.subject ? `｜${settings.subject}` : "｜モントレ");
  }

  function getGeometry() {
    const value = getValue(GEOMETRY_KEY, {});
    return { width: Number(value?.width) || 370, height: Number(value?.height) || 620 };
  }

  function getPanelState() {
    const value = getValue(PANEL_STATE_KEY, {});
    return { open: Boolean(value?.open) };
  }

  function setPanelOpen(open) {
    setValue(PANEL_STATE_KEY, { open: Boolean(open) });
    if (!panel || !$("launcher")) return;
    panel.classList.toggle("open", Boolean(open));
    $("launcher").style.display = open ? "none" : "";
  }

  function openPanel() {
    setPanelOpen(true);
    syncSubjectFromPage();
    ensureSession();
    render();
  }

  function closePanel() {
    setPanelOpen(false);
    saveGeometry();
  }

  function applyGeometry() {
    const geometry = getGeometry();
    const width = Math.min(Math.max(320, geometry.width), Math.max(320, innerWidth - 24));
    const height = Math.min(Math.max(360, geometry.height), Math.max(360, innerHeight - 80));
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  }

  function saveGeometry() {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    setValue(GEOMETRY_KEY, { width: Math.round(rect.width), height: Math.round(rect.height) });
  }

  function beginResize(event) {
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveResize(event) {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const width = Math.min(
      Math.max(320, resizeState.width + (event.clientX - resizeState.startX)),
      innerWidth - 24
    );
    const height = Math.min(
      Math.max(360, resizeState.height - (event.clientY - resizeState.startY)),
      innerHeight - 80
    );
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
  }

  function endResize(event) {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    resizeState = null;
    saveGeometry();
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #launcher { position: fixed; left: 14px; bottom: 14px; z-index: 2147483647; border: 0; border-radius: 999px; padding: 10px 14px; background: #111827; color: white; font-size: 12px; font-weight: 800; cursor: pointer; box-shadow: 0 5px 20px rgba(0,0,0,.25); }
    #panel { display: none; position: fixed; left: 14px; bottom: 14px; z-index: 2147483647; width: 370px; height: 620px; min-width: 320px; min-height: 360px; max-width: calc(100vw - 24px); max-height: calc(100vh - 80px); border: 1px solid #cbd5e1; border-radius: 14px; background: white; color: #111827; box-shadow: 0 12px 42px rgba(0,0,0,.30); }
    #panel.open { display: block; }
    #scroll { height: 100%; overflow: auto; padding: 13px; border-radius: inherit; }
    #resize-grip { position: absolute; top: -7px; right: -7px; width: 22px; height: 22px; border: 2px solid #64748b; border-left: 0; border-bottom: 0; border-radius: 0 8px 0 0; cursor: nesw-resize; touch-action: none; background: rgba(255,255,255,.75); }
    .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .title { font-size: 15px; font-weight: 850; }
    .version { font-size: 9.5px; color: #94a3b8; margin-top: 2px; }
    #close { border: 0; background: transparent; font-size: 22px; line-height: 1; cursor: pointer; color: #475569; }
    .box { margin-top: 9px; padding: 9px 10px; border: 1px solid #dbeafe; border-radius: 9px; background: #eff6ff; }
    .box-label { font-size: 9.5px; font-weight: 750; color: #64748b; }
    #session-title, #destination { margin-top: 2px; font-size: 13px; font-weight: 800; color: #111827; }
    #session-meta, #question-info { margin-top: 4px; font-size: 9.5px; line-height: 1.45; color: #64748b; }
    .status { margin-top: 4px; font-size: 9.5px; line-height: 1.45; }
    .status.ok { color: #047857; }
    .status.warn { color: #b45309; }
    details.settings { margin-top: 8px; border: 1px solid #e2e8f0; border-radius: 9px; overflow: hidden; }
    details.settings > summary, details.history-item > summary { padding: 8px 9px; cursor: pointer; font-size: 10.5px; font-weight: 750; background: #f8fafc; color: #334155; }
    .settings-body, .history-body { padding: 8px; }
    label { display: block; margin-top: 8px; margin-bottom: 3px; font-size: 10.5px; font-weight: 750; color: #475569; }
    input[type="text"], select, textarea { width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 9px; background: white; color: #111827; font-size: 12px; }
    textarea { min-height: 70px; resize: vertical; line-height: 1.45; }
    .check { display: flex; align-items: flex-start; gap: 7px; margin-top: 8px; font-size: 10.5px; color: #334155; }
    .check input { margin-top: 2px; }
    .help { margin-top: 3px; font-size: 9px; line-height: 1.45; color: #94a3b8; }
    button.action { width: 100%; margin-top: 7px; padding: 8px 9px; border-radius: 8px; cursor: pointer; font-size: 10.5px; font-weight: 750; }
    .primary { border: 1px solid #2563eb; background: #2563eb; color: white; }
    .secondary { border: 1px solid #cbd5e1; background: #f8fafc; color: #334155; }
    .force { border: 1px solid #c4b5fd; background: #f5f3ff; color: #5b21b6; }
    .force.active { border-color: #7c3aed; background: #ede9fe; color: #4c1d95; }
    .drop { margin-top: 6px; min-height: 68px; border: 1px dashed #60a5fa; border-radius: 9px; display: flex; align-items: center; justify-content: center; padding: 9px; text-align: center; font-size: 9.5px; line-height: 1.45; color: #64748b; background: #f8fafc; }
    .image-list { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 5px; margin-top: 6px; }
    .image-thumb { position: relative; border: 1px solid #e2e8f0; border-radius: 7px; overflow: hidden; }
    .image-thumb img { display: block; width: 100%; height: 68px; object-fit: contain; background: white; }
    .image-thumb button { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; border: 0; border-radius: 999px; background: #111827; color: white; cursor: pointer; }
    .section { margin-top: 11px; margin-bottom: 5px; font-size: 11px; font-weight: 850; color: #1e293b; }
    .candidate { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 5px; padding: 7px 8px; border: 1px solid #e2e8f0; border-radius: 8px; background: white; }
    .candidate-body { min-width: 0; flex: 1 1 auto; }
    .candidate-title { font-size: 10.5px; font-weight: 750; line-height: 1.4; overflow-wrap: anywhere; }
    .candidate-meta { margin-top: 3px; font-size: 8.5px; line-height: 1.35; color: #64748b; overflow-wrap: anywhere; }
    .mini { flex: 0 0 auto; padding: 3px 6px; border: 1px solid #cbd5e1; border-radius: 6px; background: #f8fafc; color: #334155; font-size: 8.5px; cursor: pointer; }
    .mini.danger { border-color: #fecaca; color: #b91c1c; background: white; }
    .empty { padding: 8px; border: 1px dashed #cbd5e1; border-radius: 8px; color: #94a3b8; text-align: center; font-size: 9.5px; }
    .history-item { margin-bottom: 5px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    #toast { position: fixed; left: 50%; bottom: 24px; z-index: 2147483647; transform: translate(-50%, 5px); max-width: 80vw; padding: 8px 11px; border-radius: 8px; background: rgba(17,24,39,.94); color: white; font-size: 10.5px; opacity: 0; pointer-events: none; transition: .15s ease; }
    #toast.show { opacity: 1; transform: translate(-50%, 0); }
  `;

  const HTML = `
    <button id="launcher" type="button">＋ Anki｜モントレ</button>
    <div id="panel">
      <div id="resize-grip" title="ドラッグでサイズ変更"></div>
      <div id="scroll">
        <div class="header">
          <div>
            <div class="title">Anki追加箱</div>
            <div class="version">モントレ v${GM_info?.script?.version || "2.0"} ／ 右上角でサイズ変更</div>
          </div>
          <button id="close" type="button">×</button>
        </div>
        <div class="box">
          <div class="box-label">現在の演習</div>
          <div id="session-title"></div>
          <div id="session-meta"></div>
          <div id="count"></div>
        </div>
        <div class="box">
          <div class="box-label">現在の保存先</div>
          <div id="destination"></div>
          <div id="detect-status"></div>
          <div id="question-info"></div>
        </div>
        <details class="settings">
          <summary>設定</summary>
          <div class="settings-body">
            <label>医学区分</label>
            <select id="division"><option value="基礎医学">基礎医学</option><option value="臨床医学">臨床医学</option></select>
            <label>科目</label>
            <input id="subject" type="text" placeholder="例：発生学">
            <button id="redetect" class="action secondary" type="button">ページから科目を再取得</button>
            <button id="save-settings" class="action primary" type="button">設定を保存</button>
          </div>
        </details>
        <label>覚えたいこと</label>
        <textarea id="memo" placeholder="1行＝1候補"></textarea>
        <div class="help">未保存のまま「次の問題」を押すと先に自動保存します。</div>
        <label class="check"><input id="also-auto" type="checkbox"><span>この問題は自動カードも作る</span></label>
        <div class="help">通常OFF。手動候補がある問題は原則「手動のみ」。</div>
        <button id="force-auto" class="action force" type="button">○でもこの問題を自動カード化</button>
        <label>画像・文字</label>
        <div id="drop" class="drop" tabindex="0">画像をドロップ / ⌘V・Ctrl+V<br>選択文字・画像上で ⌥A・Alt+A</div>
        <div id="image-list" class="image-list"></div>
        <button id="save" class="action primary" type="button">＋ 候補に追加</button>
        <button id="capture" class="action secondary" type="button">選択中の文字・画像を取り込む</button>
        <div class="section">この演習の手動候補</div>
        <div id="candidate-list"></div>
        <div class="section">○でも自動カード指定</div>
        <div id="override-list"></div>
        <div class="section">過去の演習</div>
        <div id="history"></div>
        <div class="section">ツール</div>
        <button id="export-all" class="action primary" type="button">モントレ全問＋手動候補を取得</button>
        <button id="export-manual" class="action secondary" type="button">手動候補だけ書き出す</button>
      </div>
    </div>
    <div id="toast"></div>
  `;

  function createUi(draft = null) {
    document.getElementById(ROOT_ID)?.remove();
    host = document.createElement("div");
    host.id = ROOT_ID;
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = HTML;
    shadow.append(style, wrapper);
    panel = $("panel");
    applyGeometry();

    $("launcher").onclick = openPanel;
    $("close").onclick = closePanel;
    $("redetect").onclick = () => {
      const detected = syncSubjectFromPage();
      if (detected) {
        ensureSession();
        render();
        toast(`科目：${detected.subject}`);
      } else {
        render();
        toast("科目を自動取得できませんでした");
      }
    };
    $("save-settings").onclick = () => {
      const division = $("division").value;
      const subject = $("subject").value.trim();
      if (!subject) return toast("科目を入力してください");
      saveSettings({ division, subject });
      repairUnknownSession({ division, subject });
      ensureSession();
      render();
      toast("設定を保存しました");
    };
    $("save").onclick = () => saveDraft();
    $("capture").onclick = captureSelection;
    $("force-auto").onclick = toggleOverride;
    $("export-all").onclick = exportAllQuestions;
    $("export-manual").onclick = exportManualOnly;

    const drop = $("drop");
    drop.ondragover = (event) => event.preventDefault();
    drop.ondrop = async (event) => {
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      if (files.length) await addFiles(files);
      else appendMemo(event.dataTransfer.getData("text/plain"));
    };
    drop.onpaste = handlePaste;

    const grip = $("resize-grip");
    grip.addEventListener("pointerdown", beginResize);
    grip.addEventListener("pointermove", moveResize);
    grip.addEventListener("pointerup", endResize);
    grip.addEventListener("pointercancel", endResize);
    if (draft) {
      $("memo").value = draft.memo || "";
      $("also-auto").checked = Boolean(draft.alsoAutomatic);
    }
    setPanelOpen(getPanelState().open);
    renderImages();
    render();
  }

  document.addEventListener("selectionchange", () => {
    const value = window.getSelection?.()?.toString?.().trim();
    if (value) lastSelection = value;
  }, true);

  document.addEventListener("mouseover", (event) => {
    if (event.target instanceof HTMLImageElement) {
      hoveredImage = { src: event.target.currentSrc || event.target.src, alt: event.target.alt || "" };
    }
  }, true);

  document.addEventListener("mouseout", (event) => {
    if (event.target instanceof HTMLImageElement) hoveredImage = null;
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyA") return;
    const target = event.target;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
    event.preventDefault();
    setPanelOpen(true);
    captureSelection();
  }, true);

  document.addEventListener("click", (event) => {
    const control = event.target?.closest?.("a,button,[role='button'],input[type='button'],input[type='submit']");
    if (!control) return;
    if (nextBypass.has(control)) {
      nextBypass.delete(control);
      return;
    }
    const value = controlLabel(control);
    if (value !== "次の問題" && value !== "次の問題へ" && !value.includes("スキップして次へ")) return;
    if (!hasDraft()) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!saveDraft({ silent: true })) {
      toast("未保存候補を保存できないため移動を止めました");
      return;
    }
    nextBypass.add(control);
    setTimeout(() => control.click(), 0);
  }, true);

  function readUiDraft() {
    return {
      memo: $("memo")?.value || "",
      alsoAutomatic: Boolean($("also-auto")?.checked)
    };
  }

  function ensureUiMounted() {
    if (
      host?.isConnected &&
      document.getElementById(ROOT_ID) === host &&
      shadow &&
      panel
    ) {
      return;
    }
    const draft = readUiDraft();
    createUi(draft);
  }

  function monitor() {
    ensureUiMounted();
    const urlChanged = location.href !== lastUrl;
    if (urlChanged) {
      lastUrl = location.href;
      stagedImages = [];
      if ($("memo")) $("memo").value = "";
      if ($("also-auto")) $("also-auto").checked = false;
      renderImages();
    }
    if (isQuestionPage()) {
      syncSubjectFromPage();
      ensureSession();
    }
    render();
  }

  function scheduleMonitor() {
    if (monitorQueued) return;
    monitorQueued = true;
    setTimeout(() => {
      monitorQueued = false;
      monitor();
    }, 80);
  }

  try {
    createUi();
    if (isQuestionPage()) {
      syncSubjectFromPage();
      ensureSession();
    }
    render();
    const observer = new MutationObserver(scheduleMonitor);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleMonitor);
    window.addEventListener("hashchange", scheduleMonitor);
    setInterval(monitor, 1000);
    console.info("[Montre Anki] v2.1.0 started", {
      problemNumber: parseProblemNumber(),
      progress: parseProgress(),
      subject: detectSubject()
    });
  } catch (error) {
    console.error("[Montre Anki] v2.1.0 startup error", error);
    alert("モントレ Anki v2.1.0 起動エラー\n" + (error?.message || String(error)));
  }
})();
