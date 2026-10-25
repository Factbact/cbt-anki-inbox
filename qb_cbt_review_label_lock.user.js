// ==UserScript==
// @name         QB CBT 復習ラベル固定（△・×）
// @namespace    https://local.tools/qb-cbt-review-label-lock
// @version      0.4.7
// @description  前回評価の遅延取得・再演習時の取り直し・解答履歴のSVG読取を修正。評価ルールとサイズ変更を維持。
// @author       ChatGPT
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/qb_cbt_review_label_lock.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/qb_cbt_review_label_lock.user.js
// @match        https://cbt.medilink-study.com/quiz*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * QB CBT 復習ラベル管理 0.4.7
 *
 * ■ スマートモード（手動で有効化、初期値OFF）
 *   前回 ◎/○/△/× と今回の正解/不正解で評価を更新。
 *   ◎+正解=◎、○+正解=○、△/×+正解=△（異なる学習日で3連続正解なら○）。
 *   不正解なら元の評価にかかわらず×に戻し、連続回数を0にする。
 *   元評価・正誤・ボタンを信頼できる方法で検出できない場合は変更しない。
 *   同日の正解は最大1回加算。自信なし・取り消し・判定根拠表示に対応。
 *   旧履歴の評価を保持。日付情報のない旧連続回数は参考表示として保留。
 *   スマート用履歴はQBサイト内のブラウザローカルストレージへ保存。
 *   Mac/Windowsでコードは自動更新されるが、学習履歴は自動同期されない。
 *
 * ■ 従来の固定モード
 *   「△だけ」で問題を抽出した時は【△固定】、
 *   「×だけ」で抽出した時は【×固定】を選ぶ。
 *   変更するのは現在の解答後の「自己評価」であり、解答履歴は書き換えない。
 *
 * ■ 安全性
 *   - 初期設定は OFF（意図しないラベル変更を防ぐ）。
 *   - 混在した△・×の元ラベルは判別できないため、固定モードで混在演習しないこと。
 *   - QB公式のUIにあるボタンだけをクリックする。非公開APIに直接送信しない。
 *   - ボタンの位置・識別に自信がないときは何もしない。
 *   - 1回の解答につき高々1回クリックする。自動リトライや連打はしない。
 *   - ユーザーがその後○・◎に手動変更しても上書きしない。
 *
 * ■ 初回ボタン登録（推奨）
 *   1. △固定／×固定を選ぶ。
 *   2. 1問解いて解答・解説を表示する。
 *   3. パネルの「ボタン位置を登録」を押し、QB標準の△または×を1度クリックする。
 *   4. 次の問題から同じボタンを自動でクリックする。
 *
 * 画面構造が変わると登録を再実行する必要がある。
 */

(() => {
  'use strict';

  if (window.__QB_CBT_REVIEW_LABEL_LOCK__) return;
  Object.defineProperty(window, '__QB_CBT_REVIEW_LABEL_LOCK__', {value: true, configurable: false});

  const KEY = 'qbCbtReviewLock.v1';
  const DEFAULTS = {mode: 'off', collapsed: false, position: null, geometry: null, learned: {triangle: null, wrong: null, correct: null, perfect: null}};
  const LABELS = {triangle: '△', wrong: '×', correct:'○', perfect:'◎', smart: '自動', off: 'OFF'};
  const SMART_HISTORY_KEY = 'qbCbtReviewLock.smartHistory.v1';
  const LEGACY_BACKUP_KEY = 'qbCbtReviewLock.smartHistory.pre040.backup';
  const LABEL_SET = ['◎','○','△','×','未演習'];
  const HISTORY_SCHEMA = 2;
  const MAX_WAIT = 12000;

  const readSettings = () => {
    try {
      const loaded = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        mode: ['off','triangle','wrong','smart'].includes(loaded.mode) ? loaded.mode : 'off',
        collapsed: Boolean(loaded.collapsed),
        geometry: loaded.geometry && Number.isFinite(loaded.geometry.width) && Number.isFinite(loaded.geometry.height)
          ? {width:loaded.geometry.width,height:loaded.geometry.height} : null,
        position: loaded.position && Number.isFinite(loaded.position.left) && Number.isFinite(loaded.position.top)
          ? {left: loaded.position.left, top: loaded.position.top} : null,
        learned: {
          triangle: loaded.learned?.triangle || null,
          wrong: loaded.learned?.wrong || null,
          correct: loaded.learned?.correct || null,
          perfect: loaded.learned?.perfect || null,
        },
      };
    } catch (_) {return structuredClone(DEFAULTS);}
  };
  const config = readSettings();
  const save = () => {
    try {localStorage.setItem(KEY, JSON.stringify(config));}
    catch (_) {setInfo('設定の保存に失敗した。ブラウザの保存許可を確認。', 'warn');}
  };

  let pending = null;
  let learning = false;
  let learningTarget = null;
  let lastUrl = location.href;
  let scanTimer = null;
  let ui = null;
  let operationNonce = 0;
  let lastAutomatic = null; // 同じ問題で行った直前の自動評価のみ復元できる。
  let answerContext = null; // 今回の解答が正解かどうかの確定情報。
  let lastDecision = null;
  // QBがアイコン(SVG)だけで評価を表示している場合にも、既存の解答履歴を照会する。
  // GETは同一オリジンの読み取り専用。QBの成績を変更するAPIは呼ばない。
  const previousSnapshots = new Map();
  const answerSnapshots = new Map();
  const answerKeys = new Map();
  const postAnswerDom = new Map();
  const MAX_SNAPSHOT_CACHE = 60;

  const normalize = (value) => String(value || '')
    .replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const isQuizPage = () => location.hostname === 'cbt.medilink-study.com' && /^\/quiz(?:\/|$)/.test(location.pathname);
  const questionId = () => {
    try {
      const u = new URL(location.href);
      // QB CBT の問題画面で使用されるID。ない場合はURL全体をキーにする。
      return u.searchParams.get('question_id') || `${u.pathname}${u.search}`;
    } catch (_) {return location.href;}
  };

  const actionNode = (target) => {
    if (!(target instanceof Element)) return null;
    return target.closest('button, [role="button"], label, input[type="radio"], input[type="checkbox"]');
  };
  const isVisible = (el) => {
    if (!el || !el.isConnected || !(el instanceof Element)) return false;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isEnabled = (el) => !el.matches(':disabled, [aria-disabled="true"]');

  const exactText = (el) => normalize(el.textContent);
  const findAnswerButton = () => [...document.querySelectorAll('button, [role="button"]')]
    .find(b => isVisible(b) && exactText(b) === '解答する');
  const hasResultUI = () => !findAnswerButton() && Boolean(ratingSurface() || qbVisibleHistoryRows().length);

  const scoreSymbolOf = (el) => {
    const values = [
      normalize(el.textContent),
      normalize(el.getAttribute('aria-label')),
      normalize(el.getAttribute('title')),
      normalize(el.getAttribute('data-tooltip')),
      normalize(el.querySelector('img')?.getAttribute('alt')),
      normalize(el.querySelector('svg')?.getAttribute('aria-label')),
      normalize(el.querySelector('svg title')?.textContent),
      normalize(el.getAttribute('data-rating')),
      normalize(el.getAttribute('data-label')),
    ];
    for (const text of values) {
      if (['◎', '○', '〇', '△', '×', '✕'].includes(text)) return text === '〇' ? '○' : text === '✕' ? '×' : text;
      if (/^([◎○〇△×✕])\s*(?:自信なし|自己評価|評価|正解|不正解|間違い|カンペキ(?:、もう見ない)?|完璧(?:、もう見ない)?|カンペキ、もう見ない)$/.test(text)) return text[0] === '〇' ? '○' : text[0] === '✕' ? '×' : text[0];
    }
    const compactPath=d=>String(d||'').replace(/[\s,]+/g,'').toLowerCase();
    const knownPaths={
      '○':[
        'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
        'M12 20c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-18C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2z',
        'M12 4c4.41 0 8 3.59 8 8s-3.59 8-8 8-8-3.59-8-8 3.59-8 8-8m0-2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z'
      ],
      '×':[
        'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
        'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
      ]
    };
    // UIで文字を持たないアイコンの判定。既知のSVG形状だけを認め、推測しない。
    for (const svg of el.querySelectorAll('svg')) {
      const paths=[...svg.querySelectorAll('path[d]')].map(p=>(p.getAttribute('d')||'').replace(/\s+/g,''));
      for(const [symbol,variants] of Object.entries(knownPaths)) {
        if(paths.some(d=>variants.some(v=>compactPath(d)===compactPath(v))))return symbol;
      }
      if(paths.some(d=>d.includes('M127.77L18.3918H5.61L127.77') && d.includes('M124L220h20L124z')))return '△';
      const lines=[...svg.querySelectorAll('line[x1][x2][y1][y2]')];
      if(lines.length===2) {
        const isCross=line=>Number(line.getAttribute('x1'))+Number(line.getAttribute('x2'))===24 &&
          Number(line.getAttribute('y1'))+Number(line.getAttribute('y2'))===24;
        if(lines.every(isCross)&&lines[0].getAttribute('x1')!==lines[1].getAttribute('x1'))return '×';
      }
      if(paths.some(d=>/M18[ ,]?6L?6[ ,]?18/i.test(d)) && paths.some(d=>/M6[ ,]?6l?12[ ,]?12/i.test(d)))return '×';
      // 内外2つの円が明示されていれば二重丸、円1つなら丸（他のSVG図形を含まないときだけ）。
      const circles=[...svg.querySelectorAll('circle[cx][cy][r]')];
      const shapes=svg.querySelectorAll('path,rect,polygon,polyline,line');
      if(shapes.length===0 && circles.length===2 &&
        circles.every(c=>c.getAttribute('cx')===circles[0].getAttribute('cx') && c.getAttribute('cy')===circles[0].getAttribute('cy')) &&
        circles[0].getAttribute('r')!==circles[1].getAttribute('r'))return '◎';
      if(shapes.length===0 && circles.length===1)return '○';
    }
    return null;
  };

  const labelOf = (el) => {
    const val = scoreSymbolOf(el);
    return ['◎','○','△','×'].includes(val) ? val : null;
  };

  // 位置登録したボタンの色や選択状態が変わっても照合できるアイコンの形状。
  const shapeOf = (el) => {
    const svg = el.querySelector('svg');
    if (svg) {
      const parts = [...svg.querySelectorAll('path, polygon, polyline, circle, line, rect')]
        .slice(0, 6).map(n => [
          n.tagName.toLowerCase(), n.getAttribute('d') || '', n.getAttribute('points') || '',
          n.getAttribute('cx') || '', n.getAttribute('cy') || '', n.getAttribute('r') || '',
          n.getAttribute('x1') || '', n.getAttribute('y1') || '', n.getAttribute('x2') || '',
          n.getAttribute('y2') || '',
        ].join(':'));
      if (parts.length) return `svg:${parts.join('|')}`;
    }
    const img = el.querySelector('img');
    if (img) return `img:${img.getAttribute('src') || img.getAttribute('alt') || ''}`;
    const t = labelOf(el);
    return t ? `text:${t}` : null;
  };

  // React画面の構造が変わった場合には安全側に倒して自動操作しない。
  const domPath = (el) => {
    const parts = [];
    let current = el;
    while (current && current !== document.documentElement && current !== document.body) {
      if (current.id && !/^[0-9]/.test(current.id)) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        return parts.join(' > ');
      }
      const tag = current.tagName.toLowerCase();
      const similar = [...current.parentElement.children].filter(c => c.tagName === current.tagName);
      parts.unshift(`${tag}:nth-of-type(${similar.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return `body > ${parts.join(' > ')}`;
  };

  const validTarget = (el) => {
    if (!el || !isVisible(el) || !isEnabled(el)) return false;
    if (!el.matches('button, [role="button"], label, input[type="radio"], input[type="checkbox"]')) return false;
    const t = exactText(el);
    if (/^(解答する|次の問題|前の問題|検索|リトライ|もう一度解く|戻る)$/.test(t)) return false;
    if (el.closest('[role="dialog"], [role="menu"]')) return false;
    return true;
  };

  // QBの自己評価欄は説明文の「自己評価：」の直後にアイコンボタンで表示される。
  // 検索パネル側の「結果」フィルタや「解答履歴」とは区別して取得する。
  // 曖昧な場合は「自動でクリックしない」を優先する。
  function ratingSurface() {
    const anchors=[...document.querySelectorAll('span,div,p,strong,b,label,h3,h4,h5,h6')]
      .filter(el => isVisible(el) && !ui?.host.contains(el) &&
        [...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).some(n=>/^自己評価\s*[:：]?$/.test(normalize(n.textContent))));
    const surfaces=[];
    for(const anchor of anchors) {
      let root=anchor;
      for(let depth=0; root && depth<6; root=root.parentElement,depth++) {
        if(root===document.body || root.matches('main, #root, #__next'))break;
        if(root.closest('[role="dialog"], [role="menu"]'))break;
        const buttons=[...root.querySelectorAll('button,[role="button"]')].filter(validTarget);
        // QBの自己評価欄にはアイコン式の4〜5個程度の操作が横並びにある。
        if(buttons.length<4 || buttons.length>6)continue;
        if(buttons.some(b=>/^(解答する|前の問題|次の問題|検索|登録)$/.test(exactText(b))))continue;
        if(!surfaces.some(x=>x.root===root))surfaces.push({root,buttons});
        break;
      }
    }
    if(surfaces.length!==1)return null;
    return surfaces[0];
  }

  // 新しい問題でも「自己評価欄内の位置＋同じSVG構造」で登録を再利用する。
  // 古いDOMパス方式も互換用に残すが、該当の自己評価欄以外には適用しない。
  const findLearned = (mode) => {
    const rule=config.learned[mode];
    if(!rule)return null;
    const surface=ratingSurface();
    if(surface && Number.isInteger(rule.index) && rule.index>=0 && rule.index<surface.buttons.length &&
       (!rule.groupSize || rule.groupSize===surface.buttons.length)) {
      const match=surface.buttons[rule.index];
      if(validTarget(match) && (!rule.tag || rule.tag===match.tagName.toLowerCase()) &&
          (!rule.shape || rule.shape===shapeOf(match)))return match;
    }
    if(!rule.path)return null;
    let match;
    try{match=document.querySelector(rule.path);}catch(_){return null;}
    if(!validTarget(match))return null;
    if(surface && !surface.buttons.includes(match))return null;
    if(rule.shape && shapeOf(match)!==rule.shape)return null;
    if(rule.tag && match.tagName.toLowerCase()!==rule.tag)return null;
    return match;
  };

  const looksLikeEvaluationGroup = (button) => {
    const surface=ratingSurface();
    if(surface)return surface.buttons.includes(button);
    // 表示に自己評価ラベルがない構成では、識別できる評価アイコンが
    // 少なくとも3種あるグループだけを認める（従来の模擬UIもここで対応）。
    let ancestor=button.parentElement;
    for(let depth=0;ancestor && depth<5;depth++,ancestor=ancestor.parentElement) {
      const siblings=[...ancestor.querySelectorAll('button,[role="button"],label')]
        .filter(validTarget).map(scoreSymbolOf).filter(Boolean);
      if(new Set(siblings).size>=3 && siblings.includes('△') && siblings.includes('×'))return true;
      if(ancestor.matches('main,#root,#__next,body'))break;
    }
    return false;
  };

  const findByLabel = (mode) => {
    const expected=LABELS[mode]||mode;
    const key=({'△':'triangle','×':'wrong','○':'correct','◎':'perfect'})[expected];
    // 文字・SVGなどで識別できればユーザーのボタン登録なしで使う。
    const surface=ratingSurface();
    const candidates=surface?surface.buttons:[...document.querySelectorAll('button,[role="button"],label')]
      .filter(b=>validTarget(b) && looksLikeEvaluationGroup(b));
    const matches=candidates.filter(b=>labelOf(b)===expected);
    if(matches.length===1)return matches[0];
    if(matches.length>1)return null;
    // 未知のSVGは一度登録すれば、次の問題以降も自己評価欄の位置で照合する。
    if(key && config.learned[key]) {
      const trained=findLearned(key);
      if(trained && (!scoreSymbolOf(trained)||scoreSymbolOf(trained)===expected))return trained;
    }
    return null;
  };

  function rememberButton(mode, target) {
    const surface=ratingSurface();
    const index=surface?.buttons.indexOf(target) ?? -1;
    config.learned[mode]={
      path:domPath(target),shape:shapeOf(target),tag:target.tagName.toLowerCase(),
      index:index>=0?index:null,groupSize:index>=0?surface.buttons.length:null,
    };
  }

  const selectedState = (el) => {
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true') return true;
    if (el.getAttribute('aria-pressed') === 'false' || el.getAttribute('aria-checked') === 'false') return false;
    if (el.getAttribute('data-selected') === 'true' || el.getAttribute('data-active') === 'true') return true;
    if (el.getAttribute('data-state') === 'checked') return true;
    if (el.getAttribute('data-selected') === 'false' || el.getAttribute('data-active') === 'false') return false;
    if (el.getAttribute('data-state') === 'unchecked') return false;
    if (el.matches('input[type="radio"], input[type="checkbox"]')) return el.checked;
    if (el.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked')) return true;
    // QBの評価ボタンが選択をclassで表す場合の検出。hover/focus色は判定に使わない。
    if(el.classList?.contains('selected') || el.classList?.contains('is-selected') ||
       el.classList?.contains('is-active')) return true;
    if(el.getAttribute('data-state')==='active')return true;
    return null; // 判断不可：アイコン色などから推測しない。
  };

  // ========== 問題別スマート評価 ========== 
  // 極力QB公式の画面UIだけを読む。判定不可能なら既存評価を書き換えない。
  // 学習日は必ずJST基準。海外旅行中やOSの時刻表示設定に依存させない。
  function studyDay(at=new Date()) {
    const parts=new Intl.DateTimeFormat('en-US',{
      timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
    }).formatToParts(at);
    const get=k=>parts.find(p=>p.type===k)?.value||'';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  const validDay=d=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const clampCount=v=>Number.isFinite(Number(v)) ? Math.max(0,Math.min(2,Math.floor(Number(v)))) : 0;
  const cloneData=v=>v==null?null:JSON.parse(JSON.stringify(v));
  function normalizeRecord(r) {
    if(!r || !LABEL_SET.includes(r.label)) return null;
    const modern=r.schema===HISTORY_SCHEMA;
    return {
      schema:HISTORY_SCHEMA, label:r.label,
      // 旧版には正解日のデータがないため、旧streakを新たな3日判定へ混ぜない。
      streak:modern ? clampCount(r.streak) : 0,
      legacyStreak:modern ? clampCount(r.legacyStreak) : clampCount(r.streak),
      lastCreditDay:modern && validDay(r.lastCreditDay) ? r.lastCreditDay : '',
      updatedAt:Number.isFinite(Number(r.updatedAt)) ? Number(r.updatedAt) : 0,
      source:typeof r.source==='string' ? r.source.slice(0,80) : '旧記録',
    };
  }
  function readSmartHistory() {
    try {
      const raw=localStorage.getItem(SMART_HISTORY_KEY)||'{}';
      const parsed=JSON.parse(raw);
      if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))return Object.create(null);
      // 旧版の値を更新前のまま退避する。既存のバックアップは絶対に上書きしない。
      if(Object.values(parsed).some(r=>r?.schema!==HISTORY_SCHEMA)) {
        try {if(!localStorage.getItem(LEGACY_BACKUP_KEY))localStorage.setItem(LEGACY_BACKUP_KEY,raw);}catch(_){/* 保存に失敗したら変更操作側で停止 */}
      }
      const safe=Object.create(null);
      for(const [q,r] of Object.entries(parsed)) {
        if(q.length>350 || /^(?:__proto__|constructor|prototype)$/.test(q))continue;
        const record=normalizeRecord(r);
        if(record)safe[q]=record;
      }
      return safe;
    } catch (_) {return Object.create(null);}
  }
  let history=readSmartHistory();
  function saveSmartHistory() {
    try {
      const data=JSON.stringify(history);
      localStorage.setItem(SMART_HISTORY_KEY,data);
      if(localStorage.getItem(SMART_HISTORY_KEY)!==data)throw Error('readback mismatch');
      return true;
    } catch (_) {
      setInfo('履歴を保存できないため自動カウントを停止。ストレージ容量・設定を確認。','error');
      return false;
    }
  }
  function storageReady() {
    try {
      const key='qbCbtReviewLock.writeTest';
      localStorage.setItem(key,'ok');
      const ok=localStorage.getItem(key)==='ok';
      localStorage.removeItem(key);
      return ok;
    } catch (_) {return false;}
  }
  function getRecord(q) {return normalizeRecord(history[q]);}
  function snapshotRecord(q) {
    return Object.prototype.hasOwnProperty.call(history,q)?cloneData(history[q]):null;
  }
  // 次の状態を保存できないときは、直前のローカル状態に復旧する。
  function replaceRecord(q,r) {
    if(!q || q.length>350 || /^(?:__proto__|constructor|prototype)$/.test(q))return false;
    const before=snapshotRecord(q);
    if(r===null)delete history[q];
    else {
      const value=normalizeRecord(r);
      if(!value)return false;
      history[q]=value;
    }
    if(!saveSmartHistory()) {
      if(before===null)delete history[q];else history[q]=before;
      return false;
    }
    refreshSmartInfo();
    return true;
  }
  function storeRecord(q,label,streak,source,options={}) {
    if(!LABEL_SET.includes(label))return false;
    const previous=getRecord(q);
    return replaceRecord(q,{
      ...(previous||{}), ...options,
      schema:HISTORY_SCHEMA, label, streak:clampCount(streak),
      updatedAt:Date.now(), source
    });
  }

  function findSearchFilter() {
    // QB検索の「戻る」URLに1個の結果フィルタがある時のみ前回評価の根拠にする。
    const anchors = [...document.querySelectorAll('a[href]')].filter(a=>
      /戻る/.test(normalize(a.textContent)) && !ui?.host.contains(a));
    const candidates = new Set();
    const values = {perfect:'◎',excellent:'◎',double:'◎',correct:'○',doubt:'△',wrong:'×',unpracticed:'未演習'};
    for (const a of anchors) {
      try {
        const u = new URL(a.href,location.href);
        if (u.hostname !== location.hostname || !/\/search/.test(u.pathname))continue;
        const f = u.searchParams.getAll('filterByResult');
        if(f.length!==1)continue;
        if (values[f[0]]) candidates.add(values[f[0]]);
      }catch(_){/* 不明なリンクは使わない */}
    }
    return candidates.size === 1 ? [...candidates][0] : null;
  }
  function readPreviousExplicitText() {
    // 「前回の評価：◎」等、意味が明示された要素だけを認める（通常の問題文は対象外）。
    const found = new Set();
    for(const el of document.querySelectorAll('span,small,label,p')) {
      if (!isVisible(el) || ui?.host.contains(el)) continue;
      const t=normalize(el.textContent);
      const m=t.match(/^(?:前回の評価|前回の結果|前回評価)\s*[:：]?\s*([◎○〇△×✕])$/);
      if(m) found.add(m[1]==='〇'?'○':m[1]==='✕'?'×':m[1]);
    }
    return found.size===1?[...found][0]:null;
  }
  function evaluationGroups() {
    const all = [...document.querySelectorAll('button,[role="button"],label')]
      .filter(b => !ui?.host.contains(b) && validTarget(b) && scoreSymbolOf(b));
    const groups=[];
    for(const b of all) {
      let anc=b.parentElement;
      for(let d=0;anc && d<4;d++,anc=anc.parentElement) {
        // 意味のある評価グループだけを集める。検索モーダルが同時表示なら曖昧として停止。
        const buttons=[...anc.querySelectorAll('button,[role="button"],label')]
          .filter(x=>validTarget(x) && scoreSymbolOf(x));
        const syms=new Set(buttons.map(scoreSymbolOf));
        if(syms.size>=3 && syms.has('○') && syms.has('△') && syms.has('×')) {
          if(!groups.some(g=>g.node===anc))groups.push({node:anc,buttons});
          break;
        }
      }
    }
    // 大きな祖先で重複した「見かけだけのグループ」を除去。
    return groups.filter(g => !groups.some(h=>h!==g && g.node.contains(h.node)));
  }
  function selectedFromGroup() {
    const surface=ratingSurface();
    if(surface) {
      const chosen=surface.buttons.filter(b=>selectedState(b)===true);
      if(chosen.length===1) {
        const explicit=scoreSymbolOf(chosen[0]);
        if(explicit)return explicit;
        // 未知アイコンでも、本人が以前登録した相対位置なら復元可能。
        const index=surface.buttons.indexOf(chosen[0]);
        const keyBySymbol={'△':'triangle','×':'wrong','○':'correct','◎':'perfect'};
        const mapped=Object.keys(keyBySymbol).filter(symbol=>{
          const rule=config.learned[keyBySymbol[symbol]];
          return rule && rule.index===index && rule.groupSize===surface.buttons.length &&
            (!rule.shape || rule.shape===shapeOf(chosen[0]));
        });
        if(mapped.length===1)return mapped[0];
      }
      return null;
    }
    const groups=evaluationGroups();
    if(groups.length!==1)return null;
    const chosen=groups[0].buttons.filter(b=>selectedState(b)===true);
    if(chosen.length!==1)return null;
    return scoreSymbolOf(chosen[0]);
  }
  function selectedEvaluation() {
    const explicit=selectedFromGroup();
    if(explicit)return explicit;
    const q=questionId();
    if(!validQuestionUuid(q)||!hasResultUI())return null;
    const rows=freshDOMHistory(q);
    if(rows?.[0]?.label)return rows[0].label;
    const live=reactHistorySnapshot(q);
    const entry=previousSnapshots.get(q);
    if(entry?.submissionStarted && attemptFingerprint(live)===entry.baseline)return null;
    return ratingFromSnapshot(live,q)?.label||null;
  }
  // ===== v0.4.2: QB解答履歴の読み取り =====
  const statusMap=Object.freeze({1:'△',2:'○',3:'◎'});
  const validQuestionUuid=q=>typeof q==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
  const isAttemptData=v=>v&&typeof v==='object'&&['user_status','answer_status','users_answer','answered_date','answer_histories'].some(k=>Object.prototype.hasOwnProperty.call(v,k));
  function userAnswers(raw) {
    if(raw===undefined||raw===null)return [];
    if(Array.isArray(raw))return raw.flatMap(userAnswers);
    if(typeof raw==='object')return [];
    const t=String(raw).toLowerCase();
    // 問題の正答は選択肢記号 a～z（単問・多選択肢に対応）。
    const m=t.match(/\b[a-z]\b/g);
    if(m)return [...new Set(m)].sort();
    if(/^[a-z]+$/.test(t))return [...new Set(t.split(''))].sort();
    return [];
  }
  function answerCorrectness(attempt,correctAnswers) {
    if(!attempt||!Array.isArray(correctAnswers)||!correctAnswers.length)return null;
    const users=userAnswers(attempt.users_answer);
    if(!users.length)return null;
    const choices=correctAnswers.map(userAnswers).filter(a=>a.length);
    if(!choices.length)return null;
    return choices.some(a=>a.length===users.length && a.every((letter,i)=>letter===users[i]));
  }
  function ratingFromAttempt(attempt,correctAnswers) {
    if(!attempt||typeof attempt!=='object')return null;
    const n=Number(attempt.user_status);
    if(attempt.user_status!==null && attempt.user_status!==undefined && statusMap[n])return statusMap[n];
    if(answerCorrectness(attempt,correctAnswers)===false)return '×';
    return null;
  }
  function ratingFromSnapshot(item,q) {
    if(!item)return null;
    const a=item.attempt||item.data;
    const label=ratingFromAttempt(a,item.correctAnswers||answerKeys.get(q));
    if(label)return {label,source:item.source};
    // 無回答はQBの明示的な回答履歴（空配列）と無回答情報の両方が揃ったときのみ。
    if(a&&Array.isArray(a.answer_histories)&&a.answer_histories.length===0 &&
       (a.users_answer===null||a.users_answer===undefined) &&
       (a.user_status===null||a.user_status===undefined) &&
       (a.answered_date===null||a.answered_date===undefined))
      return {label:'未演習',source:item.source};
    return null;
  }
  function copyAttempt(raw,depth=0) {
    // React objects can mutate in place: snapshot must be a COPY from before answering.
    if(!raw||typeof raw!=='object')return null;
    return {
      question_data_id:raw.question_data_id??null,question_id:raw.question_id??null,
      users_answer:cloneData(raw.users_answer??null),
      user_status:raw.user_status??null,answer_status:raw.answer_status??null,
      answered_date:cloneData(raw.answered_date??null),
      updated_date:cloneData(raw.updated_date??null),
      answer_histories:depth===0 && Array.isArray(raw.answer_histories)
        ? raw.answer_histories.slice(0,30).map(a=>copyAttempt(a,1)).filter(Boolean):null
    };
  }
  function safeHistoryItem(raw,q,source,correctAnswers) {
    if(!raw||typeof raw!=='object')return null;
    const candidate=raw.question_data_id===q||raw.question_id===q;
    if(!candidate||!isAttemptData(raw))return null;
    return {attempt:copyAttempt(raw),correctAnswers,source};
  }

  function historyTimestamp(a) {
    const raw=a?.answered_date;
    if(raw && typeof raw==='object') {
      const seconds=Number(raw.seconds ?? raw._seconds);
      const nanos=Number(raw.nanoseconds ?? raw._nanoseconds ?? 0);
      return Number.isFinite(seconds)?seconds*1000+nanos/1e6:0;
    }
    if(typeof raw==='number')return raw>1e12?raw:raw*1000;
    if(typeof raw==='string')return Number.isFinite(Date.parse(raw))?Date.parse(raw):0;
    return 0;
  }
  function findMatchingHistory(root,q,source,correctAnswers) {
    if(!root||typeof root!=='object'||!validQuestionUuid(q))return null;
    const queue=[{value:root,depth:0,scope:false}],seen=new WeakSet(),candidates=[];
    let offset=0;
    while(offset<queue.length && offset<9000) {
      const {value:v,depth,scope}=queue[offset++];
      if(!v||typeof v!=='object'||seen.has(v)||v.nodeType||v.ownerDocument)continue;
      seen.add(v);
      const ids=[v.question_data_id,v.question_id].filter(x=>typeof x==='string'&&validQuestionUuid(x));
      const exact=ids.includes(q);
      const foreign=ids.length>0&&!exact;
      if(foreign)continue;
      if((exact||scope)&&isAttemptData(v)) {
        const item={attempt:copyAttempt(v),correctAnswers,source};
        const score=(v.users_answer!=null?8:0)+(v.user_status!=null?4:0)+
          (v.answered_date!=null?4:0)+(Array.isArray(v.answer_histories)?2:0);
        candidates.push({item,score,time:historyTimestamp(item.attempt)});
      }
      if(depth>=16)continue;
      let entries=[];
      try{entries=Object.entries(v);}catch(_){continue;}
      for(const [name,child] of entries) {
        // alternate is the previous React render, not authoritative current state.
        if(/^(stateNode|ownerDocument|document|window|alternate|return|_debugOwner|ref)$/.test(name))continue;
        if(!child||typeof child!=='object'||child.nodeType||child.ownerDocument)continue;
        // A UUID-keyed dictionary is explicit identity. Scope only crosses known
        // data wrappers; it never leaks into a different question or an old attempt.
        const nextScope=name===q || ((exact||scope)&&/^(data|history|answerHistory|userHistory|userQuestion|current)$/.test(name));
        queue.push({value:child,depth:depth+1,scope:nextScope});
        if(queue.length>=11000)break;
      }
    }
    if(!candidates.length)return null;
    candidates.sort((a,b)=>b.time-a.time||b.score-a.score);
    const best=candidates[0];
    const peers=candidates.filter(x=>x.time===best.time&&x.score===best.score);
    const fingerprints=new Set(peers.map(x=>attemptFingerprint(x.item)));
    return fingerprints.size===1?best.item:null;
  }
  let reactReadCache={q:null,at:0,item:null};
  function reactHistorySnapshot(q,force=false) {
    if(!validQuestionUuid(q))return null;
    if(!force && reactReadCache.q===q && Date.now()-reactReadCache.at<250)return reactReadCache.item;
    const answer=findAnswerButton(), surface=ratingSurface();
    const elements=[answer,surface?.root,...document.querySelectorAll('table,main,#__next,#root,form,section')];
    const roots=[],seenRoots=new Set();
    const addRoot=value=>{
      if(value&&typeof value==='object'&&!seenRoots.has(value)) {seenRoots.add(value);roots.push(value);}
    };
    for(const el of elements) {
      if(!el || ui?.host.contains(el))continue;
      for(const key of Object.keys(el)) {
        if(/^__reactProps\$/.test(key))addRoot(el[key]);
        if(/^__react(?:Fiber|Container)\$/.test(key)) {
          let fiber=el[key];
          // Walk the current component's parent chain, not every header sibling.
          for(let i=0;fiber&&i<24;i++,fiber=fiber.return) {
            addRoot(fiber.memoizedProps);addRoot(fiber.memoizedState);
            if(fiber.current)addRoot(fiber.current);
          }
        }
      }
    }
    if(!roots.length) {
      for(const el of document.querySelectorAll('div')) {
        for(const key of Object.keys(el))if(/^__react(?:Props|Container)\$/.test(key))addRoot(el[key]);
        if(roots.length>=6)break;
      }
    }
    let item=null;
    for(const root of roots.slice(0,24)) {
      item=findMatchingHistory(root,q,'QBの問題別React解答履歴',answerKeys.get(q));
      if(item)break;
    }
    reactReadCache={q,at:Date.now(),item};
    return item;
  }
  async function getQuestionSnapshot(q) {
    if(!validQuestionUuid(q))return null;
    const controller=new AbortController();
    const timer=window.setTimeout(()=>controller.abort(),5000);
    try{
      const response=await window.fetch(`/api/questions/${encodeURIComponent(q)}`,{
        method:'GET',credentials:'same-origin',cache:'no-store',
        headers:{Accept:'application/json'},signal:controller.signal
      });
      if(!response.ok)return null;
      const data=await response.json();
      const correctAnswers=Array.isArray(data?.correct_answers)?data.correct_answers:null;
      if(correctAnswers)answerKeys.set(q,correctAnswers);
      return findMatchingHistory(data,q,'QBの同一サイト解答履歴',correctAnswers);
    }catch(_){return null;}
    finally{window.clearTimeout(timer);}
  }
  function attemptFingerprint(item) {
    const a=item?.attempt;
    if(!a)return '';
    // Stability in React through submit: identical answer choice can still be a NEW attempt.
    const date=a.answered_date||a.updated_date;
    const stamp=date&&typeof date==='object'?`${date.seconds||''}.${date.nanoseconds||''}`:String(date||'');
    const values=[stamp,JSON.stringify(a.users_answer??null),
      String(a.user_status??''),String(a.answer_status??''),
      String(Array.isArray(a.answer_histories)?a.answer_histories.length:'')];
    return values.join('|');
  }

  // One entry per answer attempt, rather than a permanent once-per-question cache.
  let visitSequence=0, previousPollAt=0, pageWasAnswerable=false;
  function startPreviousLookup(q,force=false) {
    if(!validQuestionUuid(q)||!findAnswerButton())return;
    let entry=previousSnapshots.get(q);
    if(!entry || (entry.submissionStarted && !pending)) {
      if(previousSnapshots.size>=MAX_SNAPSHOT_CACHE)previousSnapshots.delete(previousSnapshots.keys().next().value);
      entry={visit:++visitSequence,snapshot:null,api:null,observed:null,baseline:'',domRows:[],domBaseline:'',
        done:false,submissionStarted:false,submittedAt:0,polledAt:0};
      previousSnapshots.set(q,entry);answerSnapshots.delete(q);postAnswerDom.delete(q);
      entry.promise=getQuestionSnapshot(q).then(item=>{
        if(previousSnapshots.get(q)!==entry)return;
        // A GET finishing after submission must NEVER become the previous rating.
        if(!entry.submissionStarted && questionId()===q && findAnswerButton())entry.api=item;
        entry.done=true;
        if(q===questionId()&&config.mode==='smart') {refreshSmartInfo();queueScan();}
      });
    }
    if(entry.submissionStarted)return;
    if(!force && Date.now()-entry.polledAt<300)return;
    entry.polledAt=Date.now();
    const react=reactHistorySnapshot(q,force);
    if(react){entry.snapshot=react;entry.baseline=attemptFingerprint(react);}
    // History may appear while the question is being read, after the first poll.
    const dom=qbVisibleHistoryRows(true);
    if(dom.length){entry.domRows=dom.map(x=>({...x}));entry.domBaseline=dom.map(x=>x.key).join('||');}
    const explicit=readPreviousExplicitText();
    const selected=selectedFromGroup();
    const label=explicit||selected||dom[0]?.label;
    if(label)entry.observed={label,source:explicit?'QBの解答前評価表示':selected?'QBの解答前選択評価':'QBの解答前履歴表'};
  }
  function previouslyObservedLabel(q) {
    const entry=previousSnapshots.get(q);
    return entry?.observed || ratingFromSnapshot(entry?.snapshot,q) || ratingFromSnapshot(entry?.api,q);
  }
  function pollBeforeAnswer(force=false) {
    if(!isQuizPage() || config.mode!=='smart' || pending || learning)return;
    if(!force && Date.now()-previousPollAt<350)return;
    previousPollAt=Date.now();
    const answerable=Boolean(findAnswerButton());
    if(answerable) {
      if(!pageWasAnswerable) {
        previousSnapshots.delete(questionId());answerSnapshots.delete(questionId());
        reactReadCache={q:null,at:0,item:null};
      }
      startPreviousLookup(questionId(),force);
      refreshSmartInfo();
    }
    pageWasAnswerable=answerable;
  }

  function resultFromQBText() {
    if(!hasResultUI())return null;
    const found=new Set();
    for(const el of document.querySelectorAll('span,strong,p,div,h3,h4')) {
      if(!isVisible(el)||ui?.host.contains(el)||el.closest('table,[role="dialog"],[role="menu"]'))continue;
      const t=normalize(el.textContent);
      // "正解：b" tells us the answer key, even after a WRONG answer. Not a verdict.
      const m=t.match(/^(?:今回の)?結果\s*[:：]\s*(不正解|正解)(?:です|でした)?[。！!]?$/);
      if(m)found.add(m[1]==='正解');
    }
    return found.size===1?[...found][0]:null;
  }
  // QB実画面の「解答履歴」表を読み取り、最新行と以前の行を厳密に区別する。

  function qbVisibleHistoryRows(includeHidden=false) {
    const matches=[];
    for(const table of document.querySelectorAll('table')) {
      if((!includeHidden&&!isVisible(table))||ui?.host.contains(table))continue;
      const th=[...table.querySelectorAll('th')].map(x=>normalize(x.textContent));
      if(!th.some(x=>x.includes('解答履歴'))||!th.some(x=>x.includes('選択した解答')))continue;
      const entries=[];
      for(const tr of table.querySelectorAll('tr')) {
        const cells=[...tr.querySelectorAll('td')];
        if(cells.length<3)continue;
        const text=cells.map(x=>normalize(x.textContent));
        const date=text[0].match(/^(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/);
        if(!date)continue;
        const correct=text.find(x=>x==='正解'||x==='不正解');
        if(!correct)continue;
        const ratingCell=cells[cells.length-1];
        let symbol=scoreSymbolOf(ratingCell);
        if(!symbol) {
          const shape=shapeOf(ratingCell);
          const registered=Object.entries(config.learned).filter(([,rule])=>shape&&rule?.shape===shape);
          if(registered.length===1)symbol=LABELS[registered[0][0]];
        }
        const day=`${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`;
        const label=symbol||(correct==='不正解'?'×':null);
        // Include icons AND multiplicity. Repeating the same answer on the same day
        // produces identical text, but is still a new row.
        entries.push({day,clock:date[4]||'',answer:text[1],correct:correct==='正解',label,
          text:text.join('|'),key:[day,date[4]||'',text[1],correct,label||'?'].join('|')});
      }
      if(entries.length)matches.push(entries);
    }
    return matches.length===1?matches[0]:[];
  }
  function freshDOMHistory(q) {
    const entry=previousSnapshots.get(q);
    if(!entry?.submissionStarted || q!==questionId() || !hasResultUI())return null;
    const now=qbVisibleHistoryRows();
    if(!now.length || ![studyDay(new Date(entry.submittedAt)),studyDay()].includes(now[0].day))return null;
    // QB displays newest first. Reject inconsistent ordering instead of picking a row.
    if(now.some((r,i)=>i>0&&r.day>now[i-1].day))return null;
    const old=entry.domRows||[];
    if(old.length) {
      const overlap=Math.min(old.length,now.length-1);
      if(overlap<1 || !old.slice(0,overlap).every((r,i)=>r.key===now[i+1].key))return null;
      if(now.length===old.length && now.every((r,i)=>r.key===old[i].key))return null;
    } else {
      // In QB the history table can be absent before submission. Its appearance
      // AFTER the same question's answer click is the required freshness evidence.
      if(!entry.sawAnswerButton || !entry.submittedAt)return null;
    }
    return now;
  }
  function resultFromHistory(item,q) {
    if(!item)return null;
    const verdict=answerCorrectness(item.attempt,item.correctAnswers||answerKeys.get(q));
    return typeof verdict==='boolean'?verdict:null;
  }
  function latestDOMFingerprint() {
    const qb=qbVisibleHistoryRows();
    if(qb.length)return qb.map(x=>x.key).join('||');
    const rows=[];
    for(const el of document.querySelectorAll('tr,[role="row"],li')) {
      if(!isVisible(el)||ui?.host.contains(el))continue;
      const t=normalize(el.textContent);
      if(t.length<=260 && /20\d{2}\/\d{1,2}\/\d{1,2}/.test(t) && /(?:不正解|正解)/.test(t))rows.push(t);
    }
    return rows.slice(0,6).join('||');
  }
  function resultFromLatestDOM() {
    if(!hasResultUI())return null;
    const historyRows=qbVisibleHistoryRows();
    if(historyRows.length)return historyRows[0].correct;
    // QBの解答履歴にある「YYYY/MM/DD ... 正解/不正解」だけを対象にする。
    // 学習内容・問題文・検索パネル中の「正解」という語は判定に使わない。
    const rows=[];
    for(const el of document.querySelectorAll('tr,[role="row"],li')) {
      if(!isVisible(el)||ui?.host.contains(el))continue;
      const t=normalize(el.textContent);
      if(t.length>260||!/(?:^|\s)20\d{2}\/\d{1,2}\/\d{1,2}/.test(t))continue;
      const n=/(?:^|\s)不正解(?:\s|$)/.test(t);
      const y=/(?:^|\s)正解(?:\s|$)/.test(t);
      if(n===y)continue;
      rows.push({day:(t.match(/20\d{2}\/\d{1,2}\/\d{1,2}/)||[])[0],result:!n});
    }
    if(!rows.length)return null;
    rows.sort((a,b)=>b.day.localeCompare(a.day));
    return rows[0].result;
  }
  // 解答後の評価○/×がSVGだけで読めなくても「結果：正解/不正解」を優先する。

  function resolveCurrentCorrectness(q) {
    const rows=freshDOMHistory(q);
    const fromText=resultFromQBText();
    if(rows && fromText!==null && rows[0].correct!==fromText)return null;
    if(rows)return {correct:rows[0].correct,source:'QBの今回の解答履歴（新規行を照合）'};
    if(fromText!==null)return {correct:fromText,source:'QBの結果表示'};
    const before=previousSnapshots.get(q)?.baseline;
    const live=reactHistorySnapshot(q);
    const changed=Boolean(before && attemptFingerprint(live) && attemptFingerprint(live)!==before);
    const fromReact=changed?resultFromHistory(live,q):null;
    if(fromReact!==null)return {correct:fromReact,source:'QBの新しいReact解答履歴＋公式正答'};
    const after=answerSnapshots.get(q)?.api;
    const apiChanged=Boolean(before && attemptFingerprint(after) && attemptFingerprint(after)!==before);
    const fromApi=apiChanged?resultFromHistory(after,q):null;
    if(fromApi!==null)return {correct:fromApi,source:'QBの新しい回答履歴＋公式正答'};
    const current=selectedFromGroup();
    return ['○','×'].includes(current)?{correct:current==='○',source:'QBの選択中の評価'}:null;
  }
  function startAnswerLookup(q) {
    if(!validQuestionUuid(q)||answerSnapshots.has(q))return;
    const entry={api:null,done:false};
    answerSnapshots.set(q,entry);
    entry.promise=getQuestionSnapshot(q).then(item=>{
      entry.api=item;entry.done=true;
      if(pending?.q===q)queueScan();
    });
  }

  function previousFromOldHistory(q) {
    // Use the second row only after proving that the first row is THIS submission.
    const dom=freshDOMHistory(q);
    if(dom?.length>=2 && dom[1].label)return {label:dom[1].label,source:'QBの前回解答履歴（今回の行を除外）'};
    const entry=previousSnapshots.get(q);
    if(!entry?.submissionStarted || q!==questionId())return null;
    const item=reactHistorySnapshot(q)||answerSnapshots.get(q)?.api;
    if(!item)return null;
    const currentTime=historyTimestamp(item.attempt);
    if(!currentTime || currentTime<entry.submittedAt-1000)return null;
    const attempts=item.attempt?.answer_histories;
    if(!Array.isArray(attempts))return null;
    // Array order is not assumed. Some variants include the current attempt.
    const previous=attempts.filter(a=>historyTimestamp(a)>0&&historyTimestamp(a)<currentTime)
      .sort((a,b)=>historyTimestamp(b)-historyTimestamp(a));
    if(!previous.length)return null;
    const time=historyTimestamp(previous[0]);
    const labels=new Set(previous.filter(a=>historyTimestamp(a)===time)
      .map(a=>ratingFromAttempt(a,item.correctAnswers||answerKeys.get(q))).filter(Boolean));
    return labels.size===1?{label:[...labels][0],source:'QBの前回解答履歴（日時を照合）'}:null;
  }
  // ===== /v0.4.2 =====

  // 画面上の信頼できる表示とローカル記録が食い違えば、正解回数を推測しない。
  function previousForQuestion(q) {
    const record=getRecord(q);
    const explicit=readPreviousExplicitText();
    // 解答前に評価グループが存在する場合に限り、選択中の値をQBの実表示とみなす。
    const preSelected=!hasResultUI()?selectedEvaluation():null;
    if(explicit && preSelected && explicit!==preSelected)
      return {label:null,streak:0,source:'QB表示が矛盾',problem:'異なる評価が同時に表示されている'};
    const observed=previouslyObservedLabel(q);
    const qbLabel=explicit||preSelected||observed?.label;
    if(qbLabel) {
      return {
        label:qbLabel,
        streak:record?.label===qbLabel?record.streak:0,
        lastCreditDay:record?.lastCreditDay||'',
        legacyStreak:record?.label===qbLabel?record.legacyStreak:0,
        source:explicit?'QBの前回評価表示':preSelected?'QBの選択済み評価':observed?.source||'QBの解答履歴',
        problem:record && record.label!==qbLabel?'端末内の旧評価とQB表示が不一致。QB表示を優先しカウントを0にした。':''
      };
    }
    const filter=findSearchFilter();
    if(filter && record && filter!==record.label) {
      // 検索条件は検索開始時のものであり、回答中の手動評価より古い場合がある。
      if(['手動変更','手動登録'].includes(record.source)) {
        return {...record,source:'本人が手動設定した評価（ローカル）',
          problem:`以前の検索条件${filter}と異なるが、後から手動設定した${record.label}を尊重`};
      }
      return {label:null,streak:0,source:'検索条件と端末記録が矛盾',
        problem:`QB検索条件${filter}と端末記録${record.label}が一致せず、評価を確定できない`};
    }
    if(filter) return {
      label:filter,streak:record?.streak||0,
      lastCreditDay:record?.lastCreditDay||'',legacyStreak:record?.legacyStreak||0,
      source:'QB検索条件（単一の評価のみ）'
    };
    if(record)return {...record,source:record.source==='手動登録'?'本人が登録した前回評価':record.source==='手動変更'?'手動評価の記録':'このブラウザの保存履歴'};
    return {label:null,streak:0,lastCreditDay:'',source:'不明',problem:'前回評価が取得できない'};
  }
  // 正答の最大加算回数は「問題ごと、JSTの日付ごと」に1回。
  // ×へ戻っても当日加算済みの日付は保持し、同日に解き直して数を増やせないようにする。
  function decideSmart(before,correct,day=studyDay()) {
    if(!before || !LABEL_SET.includes(before.label) || typeof correct!=='boolean' || !validDay(day))return null;
    const prior=before.label, old=clampCount(before.streak);
    const creditDay=validDay(before.lastCreditDay)?before.lastCreditDay:'';
    if(!correct)return {label:'×',streak:0,lastCreditDay:creditDay,
      explanation:'不正解のため×に変更。連続正解回数を0にした。'};
    if(prior==='◎')return {label:'◎',streak:0,lastCreditDay:creditDay,
      explanation:'以前手動で付けた◎を保持（正解）。'};
    if(prior==='○'||prior==='未演習')return {label:'○',streak:0,lastCreditDay:creditDay,
      explanation:prior==='○'?'前回○・今回も正解なので○を維持。':'初回正解なので○に設定。'};
    const duplicate=creditDay===day;
    const count=duplicate?old:Math.min(3,(prior==='×'?0:old)+1);
    // 当日すでに正解加算されていたのに直前が×なら、0回の△として開始。
    const label=count>=3?'○':'△';
    return {
      label,streak:label==='○'?0:count,
      lastCreditDay:duplicate?creditDay:day,
      explanation:duplicate
        ? `本日(${day})は加算済みのため連続回数を増やさず${label}にする。`
        : label==='○'?`異なる学習日で3回連続正解。${day}に○へ昇格。`
        : `${day}の正解を1回加算。現在${count}/3回。`
    };
  }
  function setReason(text) {
    lastDecision={q:questionId(),text};
    refreshSmartInfo();
  }
  function refreshSmartInfo() {
    if(!ui)return;
    const sh=ui.shadow;
    const el=sh.getElementById('smartNow');
    if(!el)return;
    const q=questionId(), before=previousForQuestion(q), record=getRecord(q);
    const counter=record?.label==='△'||before.label==='△';
    const count=record?.label===before.label?(record?.streak||0):(before.streak||0);
    const legacy=record?.legacyStreak||0;
    // 通常表示は必要な数字だけ。細かい説明は「判定の詳細」に格納する。
    const currentLabel=!pending&&hasResultUI()?selectedEvaluation():null;
    const shownLabel=currentLabel||before.label||record?.label||'—';
    sh.getElementById('smartLabel').textContent=shownLabel;
    sh.getElementById('smartLabel').dataset.label=shownLabel;
    sh.getElementById('smartStreak').textContent=shownLabel==='△'?`${count} / 3`:'—';
    sh.getElementById('progressFill').style.width=shownLabel==='△'?`${Math.min(100,count/3*100)}%`:'0%';
    el.textContent=`記録：${before.label||'不明'}${counter?` ／ 正解加算 ${count}/3日`:''}`+
      `${record?.lastCreditDay?` ／ 最終加算日 ${record.lastCreditDay}`:''}`+
      `${legacy?` ／ 旧版${legacy}回（日付不明・昇格に使わない）`:''}`+
      ` ／ 根拠：${before.source}`;
    sh.getElementById('smartReason').textContent=lastDecision?.q===q?lastDecision.text:(before.problem||'問題ごとの評価を確認中。');
    sh.getElementById('unsure').disabled=!(config.mode==='smart' && answerContext?.q===q && answerContext.correct && !pending && hasResultUI());
    sh.getElementById('undo').disabled=!(config.mode==='smart' && lastAutomatic?.q===q && !pending);
  }
  function rememberAuto(task,result,beforeQB,oldRecord) {
    if(!storeRecord(task.q,result.label,result.streak,'自動判定',{
      lastCreditDay:result.lastCreditDay,legacyStreak:0
    }))return false;
    lastAutomatic={q:task.q,beforeQB,afterQB:result.label,oldRecord,
      newRecord:snapshotRecord(task.q),token:task.token};
    setReason(result.explanation+'（QB画面上の選択状態まで確認。サーバーへの永続保存は未検証。）');
    setInfo(`${task.before.label} + ${answerContext?.correct?'正解':'不正解'} → ${result.label} ／ ${result.streak}/3日。`, 'ok');
    return true;
  }
  function applySmart(task) {
    if(task.q!==questionId()||config.mode!=='smart'||learning||task.done||task.token!==operationNonce)return false;
    if(!hasResultUI())return false;
    const outcome=resolveCurrentCorrectness(task.q);
    if(!outcome) {
      startAnswerLookup(task.q);
      return false;
    }
    const correct=outcome.correct;
    // QB自身の解答直後の評価は、正解=○/不正解=×。画面UIが明示するときはそちらを優先。
    const current=selectedEvaluation()|| (correct?'○':'×');
    // ユーザーが解答直後に評価を手動変更した場合、正誤を評価アイコンから推測せず
    // 結果表示/APIを優先し、それでも矛盾するときは操作しない。
    if(outcome.source==='QBの選択中の評価' &&
       current!==(correct?'○':'×'))return false;
    const prior=task.before?.source==='QB表示が矛盾'?null:(previouslyObservedLabel(task.q)||previousFromOldHistory(task.q));
    if(prior) {
      task.before={...prior,streak:getRecord(task.q)?.label===prior.label?(getRecord(task.q)?.streak||0):0,
        lastCreditDay:getRecord(task.q)?.lastCreditDay||''};
    } else if(task.before?.label && /保存履歴|手動評価の記録|検索条件/.test(task.before.source||'')) {
      task.before={label:null,streak:0,source:'QBの前回履歴を待機',
        problem:'ブラウザ内の旧評価だけでは確定せず、QBの前回履歴を再取得している'};
    }
    answerContext={q:task.q,correct,token:task.token};
    const result=decideSmart(task.before,correct);
    // DOM history and React state can arrive after the result banner. A finished
    // metadata GET does not mean that the user's history has finished loading.
    if(!result && Date.now()<task.until) {
      startAnswerLookup(task.q);
      setInfo('前回評価を読み込み中。解答履歴の表示を待っている。');
      return false;
    }
    task.done=true;
    // 前回評価を取得できない場合は、推測でQB側や履歴を上書きしない。
    if(!result) {
      const rows=qbVisibleHistoryRows();
      const entry=previousSnapshots.get(task.q);
      setReason(`前回評価の読取が未確定。解答前の記録:${previouslyObservedLabel(task.q)?.label||'なし'} / 解答履歴:${rows.length}行 / 前回行の評価:${rows.length>1?(rows[1].label||'アイコン未認識'):'前回行なし'}。今回の評価を前回として代用せず停止した。`);
      setInfo('前回評価の根拠を取得できず、この問題の自動変更を停止。判定の詳細を確認。','warn');
      refreshSmartInfo();
      return true;
    }
    if(!storageReady()) {
      setInfo('履歴保存が使えないため、QB評価の自動変更を中止した。','error');
      return true;
    }
    // 後からユーザーが行った明示的な操作より自動処理を優先させない。
    const oldRecord=snapshotRecord(task.q);
    const finish=(attempt=0)=>{
      if(task.token!==operationNonce||questionId()!==task.q||config.mode!=='smart')return;
      const onPage=selectedEvaluation();
      if(onPage!==result.label) {
        // QBの画面は保存反映に時間がかかる場合がある。再クリックせず表示だけ3回確認。
        if(attempt<3)return window.setTimeout(()=>finish(attempt+1),500);
        setReason(`今回の判定：前回${task.before.label}・${correct?'正解':'不正解'}→${result.label}。評価ボタンの押下後、QB側の選択状態が検証できなかったため、連続正解記録は変更しなかった。`);
        setInfo(`${result.label}のボタンを押したが、QBの選択状態を確認できない。評価を画面で確認。`,'warn');
        return;
      }
      rememberAuto(task,result,current,oldRecord);
    };
    if(result.label===current) {
      window.setTimeout(finish,320);
      return true;
    }
    const button=findByLabel(result.label);
    if(!button) {
      setReason(`前回${task.before.label}・今回${correct?'正解':'不正解'}を取得。${result.label}のボタンをQB画面で特定できない。未登録のアイコン形式の場合のみ一度登録すると、同じ画面形式の別問題にも引き継ぐ。`);
      setInfo(`判定成功・クリック不可：${result.label}のボタンが未認識。設定からボタンを登録。`,'warn');
      return true;
    }
    if(selectedState(button)===true) {
      window.setTimeout(finish,320);
      return true;
    }
    try {
      button.click();
      window.setTimeout(finish,650);
    } catch(e) {setInfo(`QB評価ボタンを操作できず停止：${String(e.message||e)}`,'error');}
    return true;
  }
  function undoAutomatic() {
    const undo=lastAutomatic,q=questionId();
    if(config.mode!=='smart'||!undo||undo.q!==q||pending)
      return setInfo('この問題に取り消せる直前の自動評価はない。','warn');
    if(selectedEvaluation()!==undo.afterQB)
      return setInfo('QBの現在評価が変更されているため、安全上取り消せない。','warn');
    // 別タブによる更新や手動修正を巻き戻さない。
    if(JSON.stringify(snapshotRecord(q))!==JSON.stringify(undo.newRecord))
      return setInfo('履歴が別の操作で変わったため、自動取り消しを中止。','warn');
    if(!storageReady())return setInfo('ローカル履歴に書き込めないため、取り消しを中止。','error');
    ++operationNonce;
    answerContext=null;
    const finish=()=>{
      if(questionId()!==q || selectedEvaluation()!==undo.beforeQB)
        return setInfo('元の評価への画面反映を確認できず、履歴は戻していない。','warn');
      if(!replaceRecord(q,undo.oldRecord))return;
      lastAutomatic=null;
      setReason(`自動評価を取り消し、QB評価を${undo.beforeQB}に、ローカル履歴を操作前に復元した。QBの解答履歴は変更していない。`);
      setInfo('直前の自動評価を取り消した（画面上で確認）。','ok');
      refreshSmartInfo();
    };
    if(undo.beforeQB===undo.afterQB)return finish();
    const button=findByLabel(undo.beforeQB);
    if(!button)return setInfo(`元の評価${undo.beforeQB}のボタンを特定できず停止。`,'warn');
    try{button.click();window.setTimeout(finish,650);}
    catch(e){setInfo(`取り消し操作に失敗：${String(e.message||e)}`,'error');}
  }
  function markUnsure() {
    const q=questionId();
    if(config.mode!=='smart'||answerContext?.q!==q||!answerContext.correct||!hasResultUI())
      return setInfo('今回の正解を確定できないため、「自信なし」は利用できない。','warn');
    const current=selectedEvaluation();
    if(!['◎','○','△','×'].includes(current))
      return setInfo('QBの評価を読み取れないため、自信なしの変更を中止。','warn');
    if(!storageReady())return setInfo('履歴を保存できないため、自信なしを中止。','error');
    ++operationNonce;pending=null;lastAutomatic=null;
    // 同日の正解加算を手動リセットで再利用できないよう、加算済みの日付は維持。
    const lastCreditDay=getRecord(q)?.lastCreditDay||'';
    answerContext=null;
    const finish=()=>{
      if(questionId()!==q)return;
      if(selectedEvaluation()!=='△')return setInfo('△への画面反映を確認できなかったため、履歴を変更していない。','warn');
      if(storeRecord(q,'△',0,'自信なし',{lastCreditDay,legacyStreak:0})) {
        setReason('正解したが自信なしと判断。△にし、連続正解回数を0にした。当日の既加算は再利用しない。');
        setInfo('自信なし：△・連続正解0回に変更した。','ok');
      }
    };
    if(current==='△')return finish();
    const button=findByLabel('△');
    if(!button)return setInfo('△の評価ボタンを特定できないため停止。','warn');
    try{button.click();window.setTimeout(finish,650);}
    catch(e){setInfo(`自信なし操作に失敗：${String(e.message||e)}`,'error');}
  }

  function exportSmartHistory() {
    const json=JSON.stringify({format:'QB-CBT-smart-labels-v2',exportedAt:new Date().toISOString(),entries:history},null,2);
    const blob=new Blob([json],{type:'application/json'});
    const link=document.createElement('a');
    const u=URL.createObjectURL(blob);
    link.href=u;
    link.download=`qb_review_history_${new Date().toISOString().slice(0,10)}.json`;
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(u),1000);
    setInfo('このブラウザの学習履歴をJSONに書き出した。','ok');
  }
  async function importSmartHistory(file) {
    if(!file)return;
    try {
      const obj=JSON.parse(await file.text());
      if(!['QB-CBT-smart-labels-v1','QB-CBT-smart-labels-v2'].includes(obj.format)||
         !obj.entries || typeof obj.entries!=='object' || Array.isArray(obj.entries))throw Error('形式が一致しない');
      if(!window.confirm('この履歴を読み込むか？ 同じ問題は更新日時が新しい方を優先する。'))return;
      let changed=0;
      const oldHistory=cloneData(history);
      for(const [q,r] of Object.entries(obj.entries)) {
        if(!q || q.length>350 || /^(?:__proto__|prototype|constructor)$/.test(q))continue;
        const normalized=normalizeRecord(r);
        if(!normalized || normalized.updatedAt>Date.now()+86400000)continue;
        const old=getRecord(q);
        if(!old || normalized.updatedAt>old.updatedAt) {
          history[q]={...normalized,source:'手動インポート'};
          changed++;
        }
      }
      if(!saveSmartHistory()) {
        history=oldHistory||Object.create(null);
        return;
      }
      ++operationNonce;pending=null;lastAutomatic=null;answerContext=null;
      refreshSmartInfo();
      setInfo(`履歴${changed}件を読み込んだ（旧版の回数は昇格に使わない）。`,'ok');
    } catch(e) {setInfo(`読み込みに失敗：${String(e.message||e)}`,'error');}
  }

  function setInfo(message, type='neutral') {
    if (!ui) return;
    const info = ui.shadow.getElementById('status');
    if (!info) return;
    info.textContent = message;
    info.dataset.type = type;
    info.title = message; // 省略表示された通常メッセージはホバーで全文を確認できる。
  }
  function refreshUI() {
    if (!ui) return;
    const sh = ui.shadow;
    sh.getElementById('mode').value = config.mode;
    sh.getElementById('main').hidden = config.collapsed;
    sh.getElementById('toggle').textContent = config.collapsed ? '開く' : '閉じる';
    sh.getElementById('toggle').setAttribute('aria-expanded', String(!config.collapsed));
    const smart=config.mode==='smart';
    sh.getElementById('fixedSettings').hidden=smart || config.mode==='off';
    sh.getElementById('smartSettings').hidden=!smart;
    sh.getElementById('hint').hidden = smart || config.mode==='off';
    sh.getElementById('hint').textContent=smart
      ? '△は異なる学習日の正解3回で○。同日1回のみ加算、◎は維持。判定できない場合は何もしない。'
      : config.mode==='off'?'OFF：QB標準の評価動作。':'△・×が混在する演習では固定モードを使用しない。';
    refreshSmartInfo();
    const learned = Boolean(config.learned[config.mode]);
    sh.getElementById('learned').textContent = config.mode === 'off'
      ? '自動変更：停止中'
      : smart ? '自動判定：ON（判定できない場合は変更しない）'
      : `${LABELS[config.mode]}ボタン：${learned ? '登録済み' : '未登録（自動検出も試みる）'}`;
    sh.getElementById('train').disabled = config.mode === 'off';
    sh.getElementById('forget').disabled = config.mode === 'off' || !learned;
    sh.getElementById('apply').disabled = config.mode === 'off';
    sh.getElementById('modeName').textContent = config.mode === 'off' ? 'OFF' : smart ? '自動ON' : `${LABELS[config.mode]}固定`;
    sh.getElementById('modeName').dataset.mode = config.mode;
  }

  const MIN_PANEL_WIDTH=250, MIN_PANEL_HEIGHT=155, PANEL_MARGIN=8;
  function clampPanelGeometry(width,height) {
    return {
      width:Math.max(Math.min(MIN_PANEL_WIDTH,window.innerWidth-16),Math.min(Math.round(width),window.innerWidth-16)),
      height:Math.max(Math.min(MIN_PANEL_HEIGHT,window.innerHeight-16),Math.min(Math.round(height),window.innerHeight-16))
    };
  }
  function applyPanelGeometry() {
    if(!ui)return;
    const panel=ui.shadow.getElementById('panel');
    if(!panel)return;
    if(config.geometry) {
      const size=clampPanelGeometry(config.geometry.width,config.geometry.height);
      panel.style.width=`${size.width}px`;
      panel.style.height=config.collapsed?'':`${size.height}px`;
    } else {
      panel.style.width='';panel.style.height='';
    }
  }
  function installResize() {
    const panel=ui.shadow.getElementById('panel');
    let sizing=null;
    for(const handle of ui.shadow.querySelectorAll('[data-resize]')) {
      handle.addEventListener('pointerdown',event=>{
        if(event.button!==0 || config.collapsed)return;
        event.preventDefault();event.stopPropagation();
        const rect=panel.getBoundingClientRect();
        sizing={id:event.pointerId,dir:handle.dataset.resize,handle,
          sx:event.clientX,sy:event.clientY,x:rect.left,y:rect.top,w:rect.width,h:rect.height};
        try{handle.setPointerCapture(event.pointerId);}catch(_){}
        window.addEventListener('pointermove',onResize,true);
        window.addEventListener('pointerup',stopResize,true);
        window.addEventListener('pointercancel',stopResize,true);
      });
    }
    function onResize(event) {
      if(!sizing || event.pointerId!==sizing.id)return;
      event.preventDefault();
      const {dir,sx,sy,x,y,w,h}=sizing,dx=event.clientX-sx,dy=event.clientY-sy;
      const size=clampPanelGeometry(w+(dir.includes('e')?dx:dir.includes('w')?-dx:0),
                                   h+(dir.includes('s')?dy:dir.includes('n')?-dy:0));
      const left=x+(dir.includes('w')?(w-size.width):0);
      const top=y+(dir.includes('n')?(h-size.height):0);
      panel.style.width=`${size.width}px`;
      panel.style.height=`${size.height}px`;
      // 右上固定の初期位置でも左右上下から拡大できるようにする。
      positionPanel({left,top});
    }
    function stopResize(event) {
      if(!sizing || event.pointerId!==sizing.id)return;
      try{sizing.handle.releasePointerCapture(sizing.id);}catch(_){}
      window.removeEventListener('pointermove',onResize,true);
      window.removeEventListener('pointerup',stopResize,true);
      window.removeEventListener('pointercancel',stopResize,true);
      const rect=panel.getBoundingClientRect();
      config.geometry={width:Math.round(rect.width),height:Math.round(rect.height)};
      const hostRect=ui.host.getBoundingClientRect();
      config.position={left:Math.round(hostRect.left),top:Math.round(hostRect.top)};
      save();sizing=null;
    }
  }

  // 右上を初期位置にし、移動した位置は画面内へ補正して復元する。
  function positionPanel(position) {
    if (!ui) return;
    const host = ui.host;
    host.style.left = 'auto';
    host.style.right = '12px';
    host.style.top = '12px';
    host.style.bottom = 'auto';
    if (!position) return;
    const rect = host.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    const left = Math.max(8, Math.min(position.left, maxX));
    const top = Math.max(8, Math.min(position.top, maxY));
    host.style.right = 'auto';
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function installUI() {
    if (!document.body) return false;
    const host = document.createElement('div');
    host.id = 'qb-cbt-review-label-lock-host';
    host.style.cssText = 'position:fixed;right:12px;top:12px;z-index:2147483630;pointer-events:auto;';
    const sh = host.attachShadow({mode:'open'});
    sh.innerHTML = `
      <style>
        :host {all:initial;color-scheme:light;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",Meiryo,sans-serif}
        * {box-sizing:border-box}
        [hidden] {display:none!important}
        #panel {position:relative;display:flex;flex-direction:column;width:304px;min-width:250px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);background:#fff;color:#172033;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 8px 26px rgba(15,23,42,.16);overflow:visible}
        #top {display:flex;align-items:center;gap:8px;padding:10px 12px;background:#111827;border-bottom:1px solid #1e40af;border-radius:11px 11px 0 0;color:#fff;cursor:grab;touch-action:none;user-select:none}
        #top:active {cursor:grabbing}
        #title {flex:1;font-weight:750;font-size:13px;letter-spacing:.01em;color:#fff}
        #modeName {padding:3px 7px;border-radius:6px;background:#334155;color:#fff;font-weight:700;font-size:11px;white-space:nowrap}
        #modeName[data-mode="smart"] {background:#bfdbfe;color:#1e3a8a}
        #modeName[data-mode="triangle"],#modeName[data-mode="wrong"] {background:#eef2ff;color:#3730a3}
        button,select {font:inherit}
        button {border:1px solid #cbd5e1;background:#fff;color:#1e293b;border-radius:8px;cursor:pointer;padding:7px 10px;font-weight:600;transition:background .12s,border-color .12s}
        button:hover:not(:disabled) {background:#f1f5f9;border-color:#94a3b8}
        button:focus-visible,select:focus-visible,summary:focus-visible {outline:2px solid #2563eb;outline-offset:2px}
        button:disabled {opacity:.45;cursor:not-allowed}
        #toggle {font-size:11px;padding:3px 7px;font-weight:600;background:#334155;color:#fff;border-color:#64748b}
        #main {flex:1;min-height:0;padding:12px;max-height:calc(100vh - 82px);overflow:auto;border-radius:0 0 12px 12px}
        label {display:block;font-size:12px;font-weight:700;color:#334155;margin:0 0 5px}
        select {width:100%;height:36px;padding:5px 9px;border:1px solid #94a3b8;border-radius:8px;color:#0f172a;background:#fff}
        #hint {font-size:11px;color:#854d0e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:7px 9px;margin-top:10px}
        #smartSettings {margin-top:12px}
        #smartCard {display:flex;gap:12px;align-items:center;padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc}
        .scoreBlock {min-width:75px}
        .caption {font-size:11px;font-weight:600;color:#475569}
        #smartLabel {font-weight:760;font-size:28px;line-height:1.2;color:#1d4ed8;display:block;margin:3px 0 0}
        #smartLabel[data-label="×"] {color:#b91c1c}
        #smartLabel[data-label="△"] {color:#92400e}
        #smartLabel[data-label="◎"] {color:#1e40af}
        #smartLabel[data-label="—"] {color:#64748b}
        .scoreRight {min-width:0;flex:1;border-left:1px solid #d6dee8;padding-left:12px}
        #smartStreak {font-weight:750;font-size:17px;color:#0f172a;display:block;margin-top:3px;font-variant-numeric:tabular-nums}
        .track {height:5px;border-radius:20px;background:#e2e8f0;margin-top:7px;overflow:hidden}
        #progressFill {display:block;height:100%;width:0;background:#2563eb;border-radius:20px;transition:width .2s}
        #smartActions {display:flex;gap:8px;margin-top:10px}
        #smartActions button {flex:1;min-width:0;padding:9px 6px;font-size:12px}
        #unsure:not(:disabled) {border-color:#d97706;color:#92400e;background:#fffbeb}
        #unsure:hover:not(:disabled) {background:#fef3c7}
        #status {margin-top:11px;padding:8px 10px;border-radius:8px;background:#f1f5f9;color:#334155;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
        #status[data-type="ok"] {background:#f0fdf4;color:#166534}
        #status[data-type="warn"] {background:#fffbeb;color:#92400e;border:1px solid #fcd34d}
        #status[data-type="error"] {background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
        #status:not([data-type="warn"]):not([data-type="error"]) {display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
        details {margin-top:10px}
        summary {color:#475569;font-size:12px;font-weight:650;cursor:pointer;padding:4px 0;user-select:none}
        summary:hover {color:#1d4ed8}
        .detailsContent {margin-top:5px;padding:9px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}
        #smartNow,#smartReason {font-size:11px;color:#334155;line-height:1.6;overflow-wrap:anywhere}
        #smartReason {margin-top:6px}
        .small {font-size:11px;line-height:1.55;color:#475569}
        .compact {display:flex;gap:6px;margin-top:8px}
        .compact select {width:auto;flex:1;min-width:0}
        .compact button {font-size:11px;padding:6px 7px}
        #learned {font-size:11px;color:#475569;margin-top:8px}
        #buttons {display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
        #buttons button {font-size:11px;flex:1}
        #resetPosition {width:100%;font-size:11px;margin-top:8px}
        #foot {font-size:11px;color:#475569;line-height:1.5;margin-top:8px}
        .resize-handle {position:absolute;z-index:5;touch-action:none;pointer-events:auto;background:transparent}
        .resize-handle:hover {background:rgba(37,99,235,.13)}
        .resize-n {top:-6px;left:15px;right:15px;height:12px;cursor:ns-resize}
        .resize-s {bottom:-6px;left:15px;right:15px;height:12px;cursor:ns-resize}
        .resize-e {right:-6px;top:15px;bottom:15px;width:12px;cursor:ew-resize}
        .resize-w {left:-6px;top:15px;bottom:15px;width:12px;cursor:ew-resize}
        .resize-ne {top:-7px;right:-7px;width:17px;height:17px;cursor:nesw-resize}
        .resize-nw {top:-7px;left:-7px;width:17px;height:17px;cursor:nwse-resize}
        .resize-se {bottom:-7px;right:-7px;width:17px;height:17px;cursor:nwse-resize;background:rgba(37,99,235,.12);border-radius:0 0 6px 0}
        .resize-sw {bottom:-7px;left:-7px;width:17px;height:17px;cursor:nesw-resize}
      </style>
      <section id="panel" aria-label="QB CBT 復習ラベル管理">
        <span class="resize-handle resize-n" data-resize="n" aria-hidden="true"></span>
        <span class="resize-handle resize-s" data-resize="s" aria-hidden="true"></span>
        <span class="resize-handle resize-e" data-resize="e" aria-hidden="true"></span>
        <span class="resize-handle resize-w" data-resize="w" aria-hidden="true"></span>
        <span class="resize-handle resize-ne" data-resize="ne" aria-hidden="true"></span>
        <span class="resize-handle resize-nw" data-resize="nw" aria-hidden="true"></span>
        <span class="resize-handle resize-se" data-resize="se" aria-hidden="true"></span>
        <span class="resize-handle resize-sw" data-resize="sw" aria-hidden="true"></span>
        <div id="top" title="ドラッグして移動"><span id="title">QB 復習アシスト</span><span id="modeName">OFF</span><button id="toggle" type="button" aria-expanded="true">閉じる</button></div>
        <div id="main">
          <label for="mode">動作モード</label>
          <select id="mode"><option value="off">OFF（QBの通常動作）</option><option value="smart">自動判定（おすすめ）</option><option value="triangle">△を固定</option><option value="wrong">×を固定</option></select>
          <div id="hint" hidden></div>
          <div id="smartSettings" hidden>
            <div id="smartCard" aria-label="現在の評価と連続正解回数">
              <div class="scoreBlock"><span class="caption">現在の評価</span><strong id="smartLabel">—</strong></div>
              <div class="scoreRight"><span class="caption">連続正解</span><strong id="smartStreak">—</strong><div class="track" aria-hidden="true"><span id="progressFill"></span></div></div>
            </div>
            <div id="smartActions"><button id="unsure" type="button" disabled>自信なし</button><button id="undo" type="button" disabled>取り消す</button></div>
            <details id="reasonDetails"><summary>判定の詳細</summary><div class="detailsContent"><div id="smartNow"></div><div id="smartReason" role="status"></div></div></details>
            <details id="historyDetails"><summary>履歴と前回評価の修正</summary><div class="detailsContent">
              <div class="small">前回の評価が確実にわかる場合だけ手動登録する。</div>
              <div class="compact"><select id="setPrevious" aria-label="前回評価"><option value="">前回評価を選択</option><option value="◎">◎</option><option value="○">○</option><option value="△">△</option><option value="×">×</option><option value="未演習">未演習</option></select><button id="savePrevious" type="button">登録</button></div>
              <div class="compact"><button id="exportHistory" type="button">履歴を保存</button><button id="importHistory" type="button">履歴を読込</button><input id="historyFile" type="file" accept=".json,application/json" hidden /></div>
              <p class="small">QBの評価はQB側で同期される。連続正解回数・正解日はブラウザごとに保存される。</p>
            </div></details>
          </div>
          <div id="fixedSettings" hidden>
            <div id="learned"></div>
            <details id="fixedTools"><summary>固定モードの設定</summary><div class="detailsContent"><div id="buttons"><button id="train" type="button">ボタン位置を登録</button><button id="apply" type="button">今回の評価に適用</button><button id="forget" type="button">登録解除</button></div></div></details>
          </div>
          <div id="status" role="status" aria-live="polite">待機中</div>
          <details id="otherSettings"><summary>その他の設定</summary><div class="detailsContent"><div class="small">通常は自動認識する。未知のアイコンだけ、最初の1回登録すれば他の問題にも適用する。</div>
            <div class="compact"><select id="calibrateLabel" aria-label="登録する評価"><option value="△">△ボタン</option><option value="×">×ボタン</option><option value="○">○ボタン</option><option value="◎">◎ボタン</option></select><button id="calibrate" type="button">評価ボタンを登録</button></div>
            <button id="resetPosition" type="button">表示位置を右上に戻す</button><p class="small">パネルの四隅や辺をドラッグすると、大きさを変更して保存できる。</p><div id="foot">初回は評価を変更した後にQBを再読み込みし、保存を確認する。表示上の反映とサーバーへの保存は別である。</div></div></details>
        </div>
      </section>`;
    document.body.append(host);
    ui = {host, shadow: sh};
    applyPanelGeometry();
    positionPanel(config.position);
    installResize();

    // ヘッダーのみドラッグ可。畳むボタンはクリック操作を優先する。
    const bar = sh.getElementById('top');
    let drag = null;
    bar.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button, input, select, a')) return;
      const rect = host.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        startX: event.clientX, startY: event.clientY,
        left: rect.left, top: rect.top, moved: false,
      };
      try {bar.setPointerCapture(event.pointerId);} catch (_) { /* 一部環境では未対応 */ }
      event.preventDefault();
    });
    bar.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      positionPanel({left: drag.left + dx, top: drag.top + dy});
      event.preventDefault();
    });
    const stopDrag = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (drag.moved) {
        const rect = host.getBoundingClientRect();
        config.position = {left: Math.round(rect.left), top: Math.round(rect.top)};
        save();
      }
      drag = null;
    };
    bar.addEventListener('pointerup', stopDrag);
    bar.addEventListener('pointercancel', stopDrag);
    sh.getElementById('calibrate').addEventListener('click',()=>{
      if(!hasResultUI())return setInfo('解答後に「評価ボタンを登録」を押すこと。','warn');
      const requested=sh.getElementById('calibrateLabel').value;
      if(!['◎','○','△','×'].includes(requested))return;
      learning=!learning || learningTarget!==requested;
      learningTarget=learning?requested:null;
      if(learning){pending=null;setInfo(`${requested}の登録待ち。QB画面の${requested}ボタンを1回押す。`, 'warn');}
      else setInfo('ボタン登録をキャンセルした。');
    });
    sh.getElementById('resetPosition').addEventListener('click', () => {
      config.position = null;
      positionPanel(null);
      save();
      setInfo('パネルを右上に戻した。', 'ok');
    });

    sh.getElementById('mode').addEventListener('change', e => {
      config.mode = e.target.value;
      learning = false;learningTarget=null;
      pending = null;
      ++operationNonce;answerContext=null;lastAutomatic=null;lastDecision=null;
      save(); refreshUI();
      if(config.mode==='smart' && !hasResultUI())startPreviousLookup(questionId());
      setInfo(config.mode === 'off'
        ? 'OFF。QB標準の自動評価に戻った。'
        : config.mode==='smart'?'自動判定を有効化。前回評価と正誤を確実に読める問題だけ変更。'
        : `${LABELS[config.mode]}固定を有効化。${LABELS[config.mode]}のみの演習で使うこと。`, (config.mode === 'off' || config.mode === 'smart') ? 'neutral' : 'warn');
    });
    sh.getElementById('toggle').addEventListener('click', () => {
      config.collapsed = !config.collapsed;
      save(); refreshUI();applyPanelGeometry();
      // 展開後に画面外へ出てしまう場合は表示位置を補正する。
      if (config.position) positionPanel(config.position);
    });
    sh.getElementById('train').addEventListener('click', () => {
      if (config.mode === 'off') return;
      learning = !learning;
      if (learning) {
        learningTarget=LABELS[config.mode];
        pending = null; // 学習中に自動クリックしない。
        setInfo(`登録待機中。解答後にQBの「${LABELS[config.mode]}」を1回手動でクリック。登録を止める場合は再度ここを押す。`, 'warn');
      } else {learningTarget=null;setInfo('ボタンの登録をキャンセルした。');}
    });
    sh.getElementById('forget').addEventListener('click', () => {
      if (config.mode === 'off') return;
      config.learned[config.mode] = null;
      save(); refreshUI();
      setInfo(`${LABELS[config.mode]}のボタン位置を削除した。`);
    });
    sh.getElementById('apply').addEventListener('click', () => {
      if (config.mode === 'off') return;
      if (learning) {setInfo('登録待機中。先にQB標準の評価ボタンを押すこと。','warn'); return;}
      if (!hasResultUI()) {setInfo('解答前のため適用しなかった。解答後に試すこと。','warn'); return;}
      const next = {q:questionId(), mode:config.mode, until:Date.now()+2000, done:false, manual:true};
      apply(next);
    });
    sh.getElementById('savePrevious').addEventListener('click',()=>{
      if(config.mode!=='smart')return;
      const value=sh.getElementById('setPrevious').value;
      if(!value)return setInfo('前回評価を選んでから登録すること。','warn');
      ++operationNonce;pending=null;answerContext=null;lastAutomatic=null;
      if(storeRecord(questionId(),value,0,'手動登録',{legacyStreak:0}))setInfo(`この問題の前回評価を${value}に登録（連続回数0）。`,'ok');
    });
    sh.getElementById('exportHistory').addEventListener('click',exportSmartHistory);
    sh.getElementById('importHistory').addEventListener('click',()=>sh.getElementById('historyFile').click());
    sh.getElementById('historyFile').addEventListener('change',async event=>{
      await importSmartHistory(event.target.files?.[0]);
      event.target.value='';
    });
    sh.getElementById('undo').addEventListener('click',undoAutomatic);
    sh.getElementById('unsure').addEventListener('click',markUnsure);
    refreshUI();
    return true;
  }

  function apply(task) {
    if (learning || config.mode !== task.mode || task.q !== questionId() || task.done) return false;
    if (!hasResultUI()) return false;
    const el = findByLabel(task.mode);
    if (!el) return false;
    task.done = true; // 処理前にセットし、連打やobserverの再入を防ぐ。
    if (selectedState(el) === true) {
      setInfo(`${LABELS[task.mode]}が既に選択されている。追加操作は不要。`, 'ok');
      return true;
    }
    try {
      el.click(); // サイト本来のクリックイベントを使用。直接API呼び出しは行わない。
      setInfo(`${LABELS[task.mode]}ボタンをクリックした。保存状態はQB画面で確認。`, 'ok');
    } catch (e) {
      setInfo(`クリックに失敗：${String(e.message || e).slice(0,100)}`, 'error');
    }
    return true;
  }

  function scan() {
    scanTimer = null;
    if (!pending || pending.done) return;
    if (questionId() !== pending.q || config.mode !== pending.mode) {pending = null; return;}
    if (pending.mode==='smart') {
      if(applySmart(pending)){pending=null;refreshSmartInfo();return;}
    } else if (apply(pending)) {pending = null; return;}
    if (Date.now() >= pending.until) {
      const taskBeforeIsUnknown=!pending.before?.label;
      const mode=pending.mode, sym = LABELS[mode];
      const q=pending.q;
      const details=mode==='smart' ?
        `前回評価:${taskBeforeIsUnknown?'不明':pending.before.label} ／ 今回正誤:${resolveCurrentCorrectness(q)?'検出済み':'不明'}`:'';
      pending = null;
      setInfo(mode==='smart'
        ? `自動処理を停止（${details}）。QBの評価は変更していない。`
        : `${sym}を自動検出できなかった。解答後に「ボタン位置を登録」を使う。QBの評価はそのまま。`, 'warn');
    }
  }

  const queueScan = () => {
    if (!pending || scanTimer != null) return;
    scanTimer = window.setTimeout(scan, 120);
  };

  function onUserClick(e) {
    if (!isQuizPage()) return;
    const target = actionNode(e.target);
    if (!target || ui?.host.contains(target)) return;

    if (learning) {
      // 「解答する」「次の問題」等へのクリックは登録しない。
      if (!hasResultUI() || !validTarget(target)) return;
      const targetSymbol=learningTarget || LABELS[config.mode];
      const key=({'△':'triangle','×':'wrong','○':'correct','◎':'perfect'})[targetSymbol];
      if(!key || !validTarget(target))return;
      const accessibleSymbol=scoreSymbolOf(target);
      if(accessibleSymbol && accessibleSymbol!==targetSymbol) {
        setInfo(`${targetSymbol}以外のボタンを検出。登録は続行する。`, 'warn');
        return;
      }
      rememberButton(key,target);
      learning=false;learningTarget=null;
      pending=null;
      save();refreshUI();
      setInfo(`${targetSymbol}ボタンを登録した。QB側では今回の手動操作が有効。次回以降は自動クリック。`,'ok');
      return; // 本来のユーザークリックは妨げない。
    }

    // 信頼できる人間の評価操作を最優先。サイトが反映したことを確認してから記録する。
    if(config.mode==='smart' && e.isTrusted && hasResultUI() && looksLikeEvaluationGroup(target)) {
      const manual=scoreSymbolOf(target);
      if(['◎','○','△','×'].includes(manual)) {
        const q=questionId(), lastCreditDay=getRecord(q)?.lastCreditDay||'';
        ++operationNonce;pending=null;answerContext=null;lastAutomatic=null;
        setInfo(`${manual}への手動変更を画面で確認中。`);
        window.setTimeout(()=>{
          if(q!==questionId())return;
          if(selectedEvaluation()!==manual)
            return setInfo('手動評価の反映を確認できなかったため履歴は更新していない。','warn');
          if(storeRecord(q,manual,0,'手動変更',{lastCreditDay,legacyStreak:0})) {
            setReason(`手動で${manual}を選んだため自動判定より優先した。連続回数は0にした。`);
            setInfo(`手動評価${manual}を記録。連続回数0。`,'ok');
          }
        },650);
        return;
      }
    }
    if(config.mode==='off')return;
    if(exactText(target)==='解答する' && isVisible(target) && isEnabled(target)) {
      const q=questionId();
      if(lastUrl!==location.href) {
        previousSnapshots.delete(q);answerSnapshots.delete(q);
        reactReadCache={q:null,at:0,item:null};
      }
      lastUrl=location.href;
      if(config.mode==='smart') {
        startPreviousLookup(q,true);
      }
      const before=config.mode==='smart'?previousForQuestion(q):null;
      if(config.mode==='smart') {
        const entry=previousSnapshots.get(q);
        if(entry) {
          entry.domRows=qbVisibleHistoryRows(true).map(x=>({...x}));
          entry.domBaseline=entry.domRows.map(x=>x.key).join('||');
          entry.sawAnswerButton=true;entry.submittedAt=Date.now();entry.submissionStarted=true;
        }
        answerSnapshots.delete(q);postAnswerDom.delete(q);pageWasAnswerable=false;
      }
      ++operationNonce;answerContext=null;lastAutomatic=null;lastDecision=null;
      pending={q:questionId(),mode:config.mode,before,
        until:Date.now()+MAX_WAIT,done:false,manual:false,token:operationNonce};
      setInfo(config.mode==='smart'
        ? `前回${before.label||'不明'}。今回の正誤確定を待っている。`
        : `${LABELS[config.mode]}固定：解答結果の表示を検知待ち。`);
      queueScan();
    }
  }

  function start() {
    if (!isQuizPage()) return;
    if (!installUI()) return;
    pollBeforeAnswer(true);
    document.addEventListener('click', onUserClick, true);
    const observer = new MutationObserver(records => {
      if(records.every(r=>ui?.host===r.target||ui?.host.contains(r.target)))return;
      queueScan();
      if(!pending)pollBeforeAnswer();
    });
    observer.observe(document.body, {subtree:true,childList:true,characterData:true,
      attributes:true,attributeFilter:['class','aria-pressed','aria-checked','data-state','hidden']});
    window.addEventListener('storage',e=>{
      if(e.key!==SMART_HISTORY_KEY)return;
      history=readSmartHistory();
      ++operationNonce;pending=null;lastAutomatic=null;answerContext=null;lastDecision=null;
      refreshSmartInfo();
      setInfo('別のタブで履歴が更新されたため、待機中の自動操作を停止した。','warn');
    });
    window.addEventListener('resize', () => {
      applyPanelGeometry();
      if (config.position) positionPanel(config.position);
    });
    window.setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        pageWasAnswerable=false;
        previousSnapshots.delete(questionId());answerSnapshots.delete(questionId());
        reactReadCache={q:null,at:0,item:null};
        pending = null;
        learning = false;learningTarget=null;
        ++operationNonce;answerContext=null;lastAutomatic=null;lastDecision=null;
        setInfo(config.mode === 'off'
          ? 'OFF。通常のQB動作。'
          : config.mode==='smart'? '自動判定モード。判定不能な場合はQBの評価を変更しない。'
          : `${LABELS[config.mode]}固定で待機中。評価対象の問題を絞り込むこと。`);
        pollBeforeAnswer(true);
        refreshSmartInfo();
      }
      // DOM mutation is not guaranteed when React data finishes loading.
      if(pending)queueScan();else pollBeforeAnswer();
    }, 450);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();