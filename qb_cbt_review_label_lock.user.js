// ==UserScript==
// @name         QB CBT 復習ラベル固定（△・×）
// @namespace    https://local.tools/qb-cbt-review-label-lock
// @version      0.3.1
// @description  前回の◎○△×と今回の正誤で評価を自動判定。△は3連続正解で○、◎正解は◎維持。従来の固定モードも使用可能。
// @author       ChatGPT
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/qb_cbt_review_label_lock.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/qb_cbt_review_label_lock.user.js
// @match        https://cbt.medilink-study.com/quiz*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * QB CBT 復習ラベル管理 0.3.1
 *
 * ■ スマートモード（手動で有効化、初期値OFF）
 *   前回 ◎/○/△/× と今回の正解/不正解で評価を更新。
 *   ◎+正解=◎、○+正解=○、△/×+正解=△（3連続で○）。
 *   不正解なら元の評価にかかわらず×に戻し、連続回数を0にする。
 *   元評価・正誤・ボタンを信頼できる方法で検出できない場合は変更しない。
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
  function readSmartHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SMART_HISTORY_KEY) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {/* 読み取り失敗は空履歴にする */}
    return {};
  }
  let history = readSmartHistory();
  function saveSmartHistory() {
    try {localStorage.setItem(SMART_HISTORY_KEY, JSON.stringify(history)); return true;}
    catch (_) {setInfo('学習履歴を保存できないため、自動カウントを停止した。', 'error'); return false;}
  }
  function getRecord(q) {
    const record = history[q];
    if (!record || !['◎','○','△','×','未演習'].includes(record.label)) return null;
    return {label:record.label, streak:Math.max(0,Math.min(2, Number(record.streak)||0)), updatedAt:Number(record.updatedAt)||0};
  }
  function storeRecord(q, label, streak, source) {
    if (!q || !['◎','○','△','×','未演習'].includes(label)) return false;
    const previous = history[q];
    history[q] = {label, streak:Math.max(0,Math.min(2,Math.floor(streak)||0)), updatedAt:Date.now(), source};
    if (!saveSmartHistory()) {if(previous)history[q]=previous;else delete history[q];return false;}
    refreshSmartInfo();
    return true;
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
  function previousForQuestion(q) {
    const visible=readPreviousExplicitText();
    if(visible) return {label:visible,streak:getRecord(q)?.label===visible?(getRecord(q)?.streak||0):0,source:'QB表示'};
    const record=getRecord(q);
    if(record)return {...record,source:'このブラウザの保存履歴'};
    const filter=findSearchFilter();
    if(filter)return {label:filter,streak:0,source:'QB検索条件'};
    return {label:null,streak:0,source:'不明'};
  }
  function decideSmart(before,correct) {
    const p=before.label, n=Number(before.streak)||0;
    if(!['◎','○','△','×','未演習'].includes(p) || typeof correct!=='boolean')return null;
    if(!correct)return {label:'×',streak:0};
    if(p==='◎')return {label:'◎',streak:0};
    if(p==='○' || p==='未演習')return {label:'○',streak:0};
    const count=(p==='×'?0:n)+1;
    return count>=3?{label:'○',streak:0}:{label:'△',streak:count};
  }
  function refreshSmartInfo() {
    if(!ui)return;
    const el=ui.shadow.getElementById('smartNow');
    if(!el)return;
    const q=questionId(), before=previousForQuestion(q);
    el.textContent=`この問題の記録：${before.label||'不明'}${before.label==='△'?`（連続正解 ${before.streak||0}/3）`:''} ／ 出典：${before.source}`;
  }
  function applySmart(task) {
    if(task.q!==questionId() || config.mode!=='smart' || learning || task.done)return false;
    if(!hasResultUI())return false;
    const current=selectedEvaluation();
    if(!['○','×'].includes(current))return false;  // 不明／未確定：絶対に操作しない
    const correct=current==='○';
    const result=decideSmart(task.before,correct);
    task.done=true;  // 同一回答の二重カウントを防止
    if(!result) {
      // 初回で前回評価が不明でもQBが選択した○/×は記録し、次回から判定可能にする。
      storeRecord(task.q,current,0,'初回結果を取得');
      setInfo(`前回評価は不明。QBの${current}をそのままにし、次回以降のため保存した。`, 'warn');
      return true;
    }
    if(result.label===current) {
      if(storeRecord(task.q,result.label,result.streak,'自動判定'))
        setInfo(`${task.before.label} → ${result.label}（${correct?'正解':'不正解'}、連続${result.streak}回）。クリック不要。`,'ok');
      return true;
    }
    const button=findByLabel(result.label);
    if(!button || selectedState(button)===true) {
      setInfo(`計算結果は${result.label}だが、QBの評価ボタンを特定できない。変更せず停止。`,'warn');
      return true;
    }
    try {
      button.click();
      // 成功を確認できるまで回数は保存しない。
      window.setTimeout(()=>{
        if(questionId()!==task.q)return;
        if(selectedEvaluation()===result.label) {
          if(storeRecord(task.q,result.label,result.streak,'自動判定'))
            setInfo(`${task.before.label} + ${correct?'正解':'不正解'} → ${result.label} に更新。連続正解${result.streak}回。`,'ok');
        } else setInfo(`${result.label}への変更を確認できないため、連続回数を更新しなかった。`,'warn');
      },450);
    } catch(e) {setInfo(`QB評価ボタンの操作に失敗：${String(e.message||e)}`,'error');}
    return true;
  }
  function exportSmartHistory() {
    const json=JSON.stringify({format:'QB-CBT-smart-labels-v1',exportedAt:new Date().toISOString(),entries:history},null,2);
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
      if(obj.format!=='QB-CBT-smart-labels-v1' || !obj.entries || typeof obj.entries!=='object' || Array.isArray(obj.entries))throw Error('形式が一致しない');
      if(!window.confirm('この履歴を読み込むか？ 同じ問題は更新日時が新しい方を採用する。'))return;
      let changed=0;
      for(const [q,r] of Object.entries(obj.entries)) {
        if(!q || q.length>350 || /^(?:__proto__|prototype|constructor)$/.test(q) || !r || !['◎','○','△','×','未演習'].includes(r.label))continue;
        const old=history[q];
        const timestamp=Number(r.updatedAt)||0;
        if(timestamp > Date.now()+86400000)continue; // 将来日時は採用しない
        if(!old || timestamp>(Number(old.updatedAt)||0)){
          history[q]={label:r.label,streak:Math.max(0,Math.min(2,Number(r.streak)||0)),updatedAt:timestamp,source:'インポート'};
          changed++;
        }
      }
      if(saveSmartHistory())setInfo(`履歴${changed}件を読み込んだ。`,'ok');
      refreshSmartInfo();
    } catch(e) {setInfo(`読み込みに失敗：${String(e.message||e)}`,'error');}
  }

  function setInfo(message, type='neutral') {
    if (!ui) return;
    const info = ui.shadow.getElementById('status');
    if (!info) return;
    info.textContent = message;
    info.dataset.type = type;
  }
  function refreshUI() {
    if (!ui) return;
    const sh = ui.shadow;
    sh.getElementById('mode').value = config.mode;
    sh.getElementById('main').hidden = config.collapsed;
    sh.getElementById('toggle').textContent = config.collapsed ? '展開' : '畳む';
    const smart=config.mode==='smart';
    sh.getElementById('fixedSettings').hidden=smart || config.mode==='off';
    sh.getElementById('smartSettings').hidden=!smart;
    sh.getElementById('hint').textContent=smart
      ? '前回評価・今回の正誤を確認できた場合だけ自動変更。△は3連続正解で○、◎は正解後も維持。'
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
    sh.getElementById('modeName').textContent = config.mode === 'off' ? 'OFF' : smart ? '自動' : `${LABELS[config.mode]}固定`;
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
        #panel {width:286px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);background:#fff;color:#17212e;border:1px solid #a8b7c8;border-radius:12px;box-shadow:0 5px 24px rgba(0,0,0,.18);overflow:hidden}
        #top {display:flex;align-items:center;gap:7px;padding:9px 11px;background:#f1f5f9;border-bottom:1px solid #dae2ea;cursor:grab;touch-action:none;user-select:none}
        #top:active {cursor:grabbing}
        #title {flex:1;font-size:13px;font-weight:700}
        #dragHint {font-size:12px;color:#64748b}
        #modeName {padding:2px 6px;border-radius:6px;background:#dce7f2;color:#134268;font-weight:700;font-size:11px}
        button,select {font:inherit}
        button {border:1px solid #b8c5d2;background:#fff;color:#263a52;border-radius:7px;cursor:pointer;padding:5px 7px}
        button:hover:not(:disabled) {background:#e7edf4}
        button:disabled {opacity:.42;cursor:not-allowed}
        #toggle {font-size:11px;padding:2px 5px}
        #main {padding:10px 11px 11px;max-height:calc(100vh - 88px);overflow:auto}
        label {display:block;font-weight:600;margin-bottom:3px}
        select {width:100%;height:34px;padding:5px 7px;border:1px solid #a7b4c5;border-radius:7px;color:#152334;background:white}
        #hint {font-size:11px;color:#6a4d19;background:#fff5d7;border-radius:6px;padding:6px;margin-top:7px}
        #learned {font-size:11px;color:#475569;margin-top:8px}
        #buttons {display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
        #train {flex:1;font-weight:700}
        #apply {flex:1}
        #forget {font-size:11px}
        #resetPosition {margin-top:6px;font-size:11px;width:100%}
        #status {margin-top:8px;min-height:31px;border-top:1px solid #e3e9f0;padding-top:6px;font-size:11px;color:#34485e;overflow-wrap:anywhere}
        #status[data-type=ok] {color:#0a6941}
        #status[data-type=warn] {color:#9a4b07}
        #status[data-type=error] {color:#9a2828}
        #foot {font-size:10px;color:#64748b;margin-top:5px}
        #smartNow {font-size:11px;color:#334155;margin-top:6px;overflow-wrap:anywhere}
        details {margin-top:8px;border-top:1px solid #dfe7f0;padding-top:6px}
        summary {font-size:11px;font-weight:700;cursor:pointer}
        .small {font-size:11px;line-height:1.45;color:#64748b}
        .compact {display:flex;gap:5px;margin-top:5px}
        .compact select {width:auto;min-width:0;flex:1}
        .compact button {font-size:11px}

      </style>
      <section id="panel" aria-label="QB CBT 復習ラベル固定">
        <div id="top" title="このバーをドラッグして移動"><span id="title">QB CBT 復習ラベル固定</span><span id="dragHint" aria-hidden="true">↕</span><span id="modeName">OFF</span><button id="toggle" type="button">畳む</button></div>
        <div id="main">
          <label for="mode">評価を固定する復習</label>
          <select id="mode"><option value="off">OFF（通常のQB動作）</option><option value="smart">自動評価（◎・○・△・×を判定）</option><option value="triangle">△だけを復習 → △固定</option><option value="wrong">×だけを復習 → ×固定</option></select>
          <div id="hint"></div>
          <div id="learned"></div>
          <div id="smartSettings" hidden>
            <div id="smartNow"></div>
            <details><summary>履歴・前回評価を補正（詳細）</summary>
              <div class="small">前回評価が検出できない問題はQBの評価を変更しない。確実にわかる場合だけ手動登録できる。</div>
              <div class="compact"><select id="setPrevious"><option value="">前回評価を指定</option><option value="◎">◎</option><option value="○">○</option><option value="△">△</option><option value="×">×</option><option value="未演習">未演習</option></select><button id="savePrevious" type="button">登録</button></div>
              <div class="compact"><button id="exportHistory" type="button">履歴を書き出す</button><button id="importHistory" type="button">履歴を読み込む</button><input id="historyFile" type="file" accept=".json,application/json" hidden /></div>
              <div class="small">コードはMac/Windowsで自動更新できるが連続正解回数は自動同期されない。別端末へ履歴を引き継ぐ場合にJSONを使う。</div>
            </details>
          </div>
          <div id="fixedSettings"><div id="buttons"><button id="train" type="button">ボタン位置を登録</button><button id="apply" type="button">今回の評価に適用</button><button id="forget" type="button">登録解除</button></div></div>
          <button id="resetPosition" type="button">表示位置を右上に戻す</button>
          <div id="status" role="status" aria-live="polite">OFF。QBの評価は変更しない。</div>
          <div id="foot">自動モードは初期OFF。評価取得に失敗した場合はQBの標準動作のままにする。固定モードでは初回にボタン登録が必要な場合がある。</div>
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
      save(); refreshUI();
      setInfo(config.mode === 'off'
        ? 'OFF。QB標準の自動評価に戻った。'
        : config.mode==='smart'?'自動判定を有効化。前回評価と正誤を確実に読める問題だけ変更。'
        : `${LABELS[config.mode]}固定を有効化。${LABELS[config.mode]}のみの演習で使うこと。`, config.mode === 'off' ? 'neutral' : 'warn');
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
      if(storeRecord(questionId(),value,0,'手動登録'))setInfo(`この問題の前回評価を${value}に登録（連続回数0）。`,'ok');
    });
    sh.getElementById('exportHistory').addEventListener('click',exportSmartHistory);
    sh.getElementById('importHistory').addEventListener('click',()=>sh.getElementById('historyFile').click());
    sh.getElementById('historyFile').addEventListener('change',async event=>{
      await importSmartHistory(event.target.files?.[0]);
      event.target.value='';
    });
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
      if(applySmart(pending)){pending=null;return;}
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

    // 信頼できる「人間の評価ボタン操作」だけをスマート記録へ反映。
    // 自動click()はisTrusted=false。解答の再カウントにも使わない。
    if (config.mode==='smart' && e.isTrusted && hasResultUI() && looksLikeEvaluationGroup(target)) {
      const manual=scoreSymbolOf(target);
      if(['◎','○','△','×'].includes(manual)) {
        pending=null; // 手動変更を尊重する
        storeRecord(questionId(),manual,0,'手動変更');
        setInfo(`${manual}への手動変更を記録した。連続回数は0にした。`,'ok');
        return;
      }
    }
    if (config.mode === 'off') return;
    if (exactText(target) === '解答する' && isVisible(target) && isEnabled(target)) {
      const before=config.mode==='smart'?previousForQuestion(questionId()):null;
      pending = {
        q: questionId(), mode:config.mode, before,
        until: Date.now() + MAX_WAIT, done: false, manual:false,
      };
      setInfo(config.mode==='smart'
        ? `前回${before.label||'不明'}。正誤の確定を待機している。`
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
    window.addEventListener('resize', () => {
      if (config.position) positionPanel(config.position);
    });
    window.setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        pending = null;
        learning = false;
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