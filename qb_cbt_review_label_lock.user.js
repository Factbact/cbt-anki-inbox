// ==UserScript==
// @name         QB CBT 復習ラベル固定（△・×）
// @namespace    https://local.tools/qb-cbt-review-label-lock
// @version      0.4.1
// @description  すっきりした操作パネルで、QB CBTの評価を自動判定。異なる学習日で3回の連続正解・自信なし・取り消し対応。
// @author       ChatGPT
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/qb_cbt_review_label_lock.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/qb_cbt_review_label_lock.user.js
// @match        https://cbt.medilink-study.com/quiz*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * QB CBT 復習ラベル管理 0.4.1
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
  const DEFAULTS = {mode: 'off', collapsed: false, position: null, learned: {triangle: null, wrong: null}};
  const LABELS = {triangle: '△', wrong: '×', smart: '自動', off: 'OFF'};
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
        position: loaded.position && Number.isFinite(loaded.position.left) && Number.isFinite(loaded.position.top)
          ? {left: loaded.position.left, top: loaded.position.top} : null,
        learned: {
          triangle: loaded.learned?.triangle || null,
          wrong: loaded.learned?.wrong || null,
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
  let lastUrl = location.href;
  let scanTimer = null;
  let ui = null;
  let operationNonce = 0;
  let lastAutomatic = null; // 同じ問題で行った直前の自動評価のみ復元できる。
  let answerContext = null; // 今回の解答が正解かどうかの確定情報。
  let lastDecision = null;

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
  const hasResultUI = () => !findAnswerButton();

  const scoreSymbolOf = (el) => {
    const values = [
      normalize(el.textContent),
      normalize(el.getAttribute('aria-label')),
      normalize(el.getAttribute('title')),
      normalize(el.getAttribute('data-tooltip')),
      normalize(el.querySelector('img')?.getAttribute('alt')),
      normalize(el.querySelector('svg')?.getAttribute('aria-label')),
      normalize(el.querySelector('svg title')?.textContent),
    ];
    for (const text of values) {
      if (['◎', '○', '〇', '△', '×', '✕'].includes(text)) return text === '〇' ? '○' : text === '✕' ? '×' : text;
      if (/^([◎○〇△×✕])\s*(?:自信なし|自己評価|評価|正解|不正解|間違い|カンペキ(?:、もう見ない)?|完璧(?:、もう見ない)?|カンペキ、もう見ない)$/.test(text)) return text[0] === '〇' ? '○' : text[0] === '✕' ? '×' : text[0];
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

  const findLearned = (mode) => {
    const rule = config.learned[mode];
    if (!rule?.path) return null;
    let match;
    try { match = document.querySelector(rule.path); } catch (_) { return null; }
    if (!validTarget(match)) return null;
    if (rule.shape && shapeOf(match) !== rule.shape) return null;
    if (rule.tag && match.tagName.toLowerCase() !== rule.tag) return null;
    return match;
  };

  const looksLikeEvaluationGroup = (button) => {
    // 検索条件の「△」と解答後の自己評価ボタンを取り違えないため、
    // ◎○△×のうち少なくとも3種類が近傍に表示されている場合だけ自動判定する。
    let ancestor = button.parentElement;
    for (let depth=0; ancestor && depth < 5; depth++, ancestor=ancestor.parentElement) {
      const siblings = [...ancestor.querySelectorAll('button, [role="button"], label')]
        .filter(validTarget)
        .map(scoreSymbolOf)
        .filter(Boolean);
      if (new Set(siblings).size >= 3 && siblings.includes('△') && siblings.includes('×')) {
        return true;
      }
      if (ancestor.matches('main, #root, #__next, body')) break;
    }
    return false;
  };
  const findByLabel = (mode) => {
    const expected = LABELS[mode] || mode;
    const matches = [...document.querySelectorAll('button, [role="button"], label')]
      .filter(b => validTarget(b) && labelOf(b) === expected && looksLikeEvaluationGroup(b));
    // 曖昧な場合は誤タップ防止のため中断する（その場合はボタン位置を登録）。
    return matches.length === 1 ? matches[0] : null;
  };

  const selectedState = (el) => {
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true') return true;
    if (el.getAttribute('aria-pressed') === 'false' || el.getAttribute('aria-checked') === 'false') return false;
    if (el.getAttribute('data-selected') === 'true' || el.getAttribute('data-active') === 'true') return true;
    if (el.getAttribute('data-state') === 'checked') return true;
    if (el.getAttribute('data-selected') === 'false' || el.getAttribute('data-active') === 'false') return false;
    if (el.getAttribute('data-state') === 'unchecked') return false;
    if (el.matches('input[type="radio"], input[type="checkbox"]')) return el.checked;
    if (el.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked')) return true;
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
  function selectedEvaluation() {
    const groups=evaluationGroups();
    if(groups.length!==1)return null;
    const chosen=groups[0].buttons.filter(b=>selectedState(b)===true);
    if(chosen.length!==1)return null;
    return scoreSymbolOf(chosen[0]);
  }
  // 画面上の信頼できる表示とローカル記録が食い違えば、正解回数を推測しない。
  function previousForQuestion(q) {
    const record=getRecord(q);
    const explicit=readPreviousExplicitText();
    // 解答前に評価グループが存在する場合に限り、選択中の値をQBの実表示とみなす。
    const preSelected=!hasResultUI()?selectedEvaluation():null;
    if(explicit && preSelected && explicit!==preSelected)
      return {label:null,streak:0,source:'QB表示が矛盾',problem:'異なる評価が同時に表示されている'};
    const qbLabel=explicit||preSelected;
    if(qbLabel) {
      return {
        label:qbLabel,
        streak:record?.label===qbLabel?record.streak:0,
        lastCreditDay:record?.lastCreditDay||'',
        legacyStreak:record?.label===qbLabel?record.legacyStreak:0,
        source:explicit?'QBの前回評価表示':'QBの選択済み評価',
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
    if(record)return {...record,source:record.source==='手動変更'?'手動評価の記録':'このブラウザの保存履歴'};
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
    const shownLabel=before.label||record?.label||'—';
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
    const current=selectedEvaluation();
    if(!['○','×'].includes(current))return false;
    const correct=current==='○';
    answerContext={q:task.q,correct,token:task.token};
    const result=decideSmart(task.before,correct);
    task.done=true;
    // 前回評価を取得できない場合は、推測でQB側や履歴を上書きしない。
    if(!result) {
      setReason(task.before?.problem||'前回評価の根拠が不足。自動処理は停止。');
      setInfo('前回評価を確認できないためQBの評価を変更せず停止。必要なら前回評価を登録。','warn');
      refreshSmartInfo();
      return true;
    }
    if(!storageReady()) {
      setInfo('履歴保存が使えないため、QB評価の自動変更を中止した。','error');
      return true;
    }
    // 後からユーザーが行った明示的な操作より自動処理を優先させない。
    const oldRecord=snapshotRecord(task.q);
    const finish=()=>{
      if(task.token!==operationNonce||questionId()!==task.q||config.mode!=='smart')return;
      if(selectedEvaluation()!==result.label) {
        setInfo(`${result.label}への変更をQB画面で確認できず、履歴を更新しなかった。`,'warn');
        return;
      }
      rememberAuto(task,result,current,oldRecord);
    };
    if(result.label===current) {
      window.setTimeout(finish,320);
      return true;
    }
    const button=findByLabel(result.label);
    if(!button || selectedState(button)===true) {
      setInfo(`計算結果${result.label}の評価ボタンを特定できず停止。`,'warn');
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
        #panel {width:304px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);background:#fff;color:#172033;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 8px 26px rgba(15,23,42,.16);overflow:hidden}
        #top {display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;cursor:grab;touch-action:none;user-select:none}
        #top:active {cursor:grabbing}
        #title {flex:1;font-weight:750;font-size:13px;letter-spacing:.01em;color:#0f172a}
        #modeName {padding:3px 7px;border-radius:6px;background:#e2e8f0;color:#334155;font-weight:700;font-size:11px;white-space:nowrap}
        #modeName[data-mode="smart"] {background:#dbeafe;color:#1e40af}
        #modeName[data-mode="triangle"],#modeName[data-mode="wrong"] {background:#eef2ff;color:#3730a3}
        button,select {font:inherit}
        button {border:1px solid #cbd5e1;background:#fff;color:#1e293b;border-radius:8px;cursor:pointer;padding:7px 10px;font-weight:600;transition:background .12s,border-color .12s}
        button:hover:not(:disabled) {background:#f1f5f9;border-color:#94a3b8}
        button:focus-visible,select:focus-visible,summary:focus-visible {outline:2px solid #2563eb;outline-offset:2px}
        button:disabled {opacity:.45;cursor:not-allowed}
        #toggle {font-size:11px;padding:3px 7px;font-weight:600}
        #main {padding:12px;max-height:calc(100vh - 82px);overflow:auto}
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
      </style>
      <section id="panel" aria-label="QB CBT 復習ラベル管理">
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
          <details id="otherSettings"><summary>その他の設定</summary><div class="detailsContent"><button id="resetPosition" type="button">表示位置を右上に戻す</button><div id="foot">初回は評価を変更した後にQBを再読み込みし、保存を確認する。表示上の反映とサーバーへの保存は別である。</div></div></details>
        </div>
      </section>`;
    document.body.append(host);
    ui = {host, shadow: sh};
    positionPanel(config.position);

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
    sh.getElementById('resetPosition').addEventListener('click', () => {
      config.position = null;
      positionPanel(null);
      save();
      setInfo('パネルを右上に戻した。', 'ok');
    });

    sh.getElementById('mode').addEventListener('change', e => {
      config.mode = e.target.value;
      learning = false;
      pending = null;
      ++operationNonce;answerContext=null;lastAutomatic=null;lastDecision=null;
      save(); refreshUI();
      setInfo(config.mode === 'off'
        ? 'OFF。QB標準の自動評価に戻った。'
        : config.mode==='smart'?'自動判定を有効化。前回評価と正誤を確実に読める問題だけ変更。'
        : `${LABELS[config.mode]}固定を有効化。${LABELS[config.mode]}のみの演習で使うこと。`, (config.mode === 'off' || config.mode === 'smart') ? 'neutral' : 'warn');
    });
    sh.getElementById('toggle').addEventListener('click', () => {
      config.collapsed = !config.collapsed;
      save(); refreshUI();
      // 展開後に画面外へ出てしまう場合は表示位置を補正する。
      if (config.position) positionPanel(config.position);
    });
    sh.getElementById('train').addEventListener('click', () => {
      if (config.mode === 'off') return;
      learning = !learning;
      if (learning) {
        pending = null; // 学習中に自動クリックしない。
        setInfo(`登録待機中。解答後にQBの「${LABELS[config.mode]}」を1回手動でクリック。登録を止める場合は再度ここを押す。`, 'warn');
      } else {setInfo('ボタンの登録をキャンセルした。');}
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
    const el = config.learned[task.mode] ? findLearned(task.mode) : findByLabel(task.mode);
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
      const mode=pending.mode, sym = LABELS[mode];
      pending = null;
      setInfo(mode==='smart'
        ? '前回評価・今回の正誤を確実に読めなかったため、QBの評価を変更していない。'
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
      const mode = config.mode;
      if (mode === 'off') return;
      const accessibleSymbol = scoreSymbolOf(target);
      if (accessibleSymbol && accessibleSymbol !== LABELS[mode]) {
        setInfo(`${LABELS[mode]}ではないボタンは登録しない。`, 'warn');
        return;
      }
      config.learned[mode] = {
        path: domPath(target),
        shape: shapeOf(target),
        tag: target.tagName.toLowerCase(),
      };
      learning = false;
      pending = null;
      save(); refreshUI();
      setInfo(`${LABELS[mode]}ボタンを登録した。今回は手動操作し、次の問題から自動適用する。`, 'ok');
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
      const before=config.mode==='smart'?previousForQuestion(questionId()):null;
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
    document.addEventListener('click', onUserClick, true);
    const observer = new MutationObserver(() => queueScan());
    observer.observe(document.body, {subtree:true, childList:true, attributes:false});
    window.addEventListener('storage',e=>{
      if(e.key!==SMART_HISTORY_KEY)return;
      history=readSmartHistory();
      ++operationNonce;pending=null;lastAutomatic=null;answerContext=null;lastDecision=null;
      refreshSmartInfo();
      setInfo('別のタブで履歴が更新されたため、待機中の自動操作を停止した。','warn');
    });
    window.addEventListener('resize', () => {
      if (config.position) positionPanel(config.position);
    });
    window.setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        pending = null;
        learning = false;
        ++operationNonce;answerContext=null;lastAutomatic=null;lastDecision=null;
        setInfo(config.mode === 'off'
          ? 'OFF。通常のQB動作。'
          : config.mode==='smart'? '自動判定モード。判定不能な場合はQBの評価を変更しない。'
          : `${LABELS[config.mode]}固定で待機中。評価対象の問題を絞り込むこと。`);
        refreshSmartInfo();
      }
      // ネットワーク反映などでDOM変化がなくてもタイムアウトを処理する。
      if (pending) queueScan();
    }, 450);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();