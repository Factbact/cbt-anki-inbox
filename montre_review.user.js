// ==UserScript==
// @name         モントレ 誤答復習（2周目・3周目）
// @namespace    https://github.com/Factbact/cbt-anki-inbox/montre-review
// @version      1.4.0
// @description  Anki追加箱から誤答を自動同期。選択肢別の解説・折りたたみ・分野別復習に対応。
// @match        https://m3e-medical.com/users/cbt*
// @match        https://www.m3e-medical.com/users/cbt*
// @updateURL    https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_review.user.js
// @downloadURL  https://raw.githubusercontent.com/Factbact/cbt-anki-inbox/main/montre_review.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.__montreReviewLoaded) return;
  window.__montreReviewLoaded = true;

  const STORE_KEY = 'montreReview.v1';
  const SESSION_KEY = 'montreReview.session.v1';
  const BRIDGE_KEY = 'montreReview.bridge.v1';
  const SEED = [];
  const BAD = new Set(['×','△']);
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  let store;
  let session;
  let selected = new Set();
  let checkedResult = null;
  let filterTopic = '';
  let screen = 'home';
  let notice = '';
  let syncReady = false;
  let syncedCount = 0;
  let lastSyncAt = '';
  let syncTimer = null;
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
 if(raw.selfEvaluationConfirmed!==true||!['○','×','△'].includes(raw.selfEvaluation))return;
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
 try{window.dispatchEvent(new CustomEvent('montre-review:sync-request'));}catch(_e){}
 try{window.postMessage(JSON.stringify({kind:'montre-review-sync-request-v1'}),location.origin);}catch(_e){}
}

  function installAutoSync(){
 window.addEventListener('montre-review:question',receiveAutoQuestion);
 window.addEventListener('montre-review:anki-ready',()=>{
   syncReady=true;requestAutoSync();if(screen==='home')render();
 });
 window.addEventListener('message',e=>{
   if(e.source!==window||e.origin!==location.origin||typeof e.data!=='string'||e.data.length>250000)return;
   const packet=jsonParse(e.data,null);
   if(packet?.kind==='montre-review-question-v1')receiveAutoQuestion({detail:e.data});
   if(packet?.kind==='montre-review-ready-v1'&&!syncReady){
     syncReady=true;requestAutoSync();if(screen==='home')render();
   }
 });
 receiveAutoQuestion(null);
 requestAutoSync();
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
    session = jsonParse(localStorage.getItem(SESSION_KEY), null);
    if (!session || !Array.isArray(session.ids) || !Number.isInteger(session.index)) session=null;
  }
  const all = () => Object.values(store.questions).filter(q=>q&&q.id&&q.answer);
  const history = id => Array.isArray(store.attempts[id]) ? store.attempts[id] : [];
  const latest = q => {const h=history(q.id);return h.length ? h[h.length-1].mark : q.initial;};
  const isBad = q => BAD.has(q.initial);
  const needsReview = q => isBad(q) && latest(q)!=='○';
  const topicOptions = () => [...new Set(all().map(q=>[q.subject,q.topic].filter(Boolean).join(' / ')))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ja'));
  const categoryLabel = q => [q.subject,q.topic].filter(Boolean).join(' / ') || '未分類';
  const filtered = items => filterTopic ? items.filter(q=>categoryLabel(q)===filterTopic) : items;
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
    const host=document.createElement('div'); host.id='montre-review-root';
    (document.body || document.documentElement).append(host);
    shadow=host.attachShadow({mode:'open'});
    const s=document.createElement('style');s.textContent=styles;shadow.appendChild(s);
    app=document.createElement('div');shadow.append(app);
    render();
    shadow.addEventListener('click',handleClick);
    shadow.addEventListener('change',handleChange);
    document.addEventListener('keydown',e=>{if(e.key==='Escape' && screen!=='closed'){screen='closed';render();}});
  }
  function render() {
    if(!app)return;
    if(screen==='closed'){app.innerHTML=`<button id="launcher" data-action="open">誤答復習 v1.4（同期はこちら）</button>`;return;}
    const body=screen==='home'?homeHtml():screen==='quiz'?quizHtml():endHtml();
    app.innerHTML=`<button id="launcher" data-action="toggle" style="display:none">誤答復習</button>
      <div id="backdrop"><section id="modal" role="dialog" aria-modal="true" aria-label="モントレ誤答復習">
      <header class="top"><h2>モントレ 誤答復習 v1.4</h2><small>ブラウザ内で保存</small><button data-action="home" aria-label="ホーム">一覧</button><button data-action="close" aria-label="閉じる">✕</button></header>
      <main>${notice?`<div class="notice">${esc(notice)}</div>`:''}${body}</main></section></div>`;
    notice='';
  }
  function homeHtml() {
    const qs=all();
    const originalWrong=qs.filter(q=>q.initial==='×').length;
    const originalTriangle=qs.filter(q=>q.initial==='△').length;
    const reviewed=qs.filter(q=>history(q.id).length).length;
    const pending=qs.filter(needsReview).length;
    const topics=topicOptions();
    const resumable=session && session.ids?.length>0;
    return `<h3>間違えた問題だけを解き直す</h3>
      <div class="sync-status">自動同期：${syncReady?'Anki追加箱と接続中':'Anki追加箱からの応答待ち'} ／ 今回更新 ${syncedCount}問 ${lastSyncAt?'（最終 '+esc(new Date(lastSyncAt).toLocaleTimeString('ja-JP'))+'）':''} <button data-action="sync">Ankiから同期</button></div>
      <div class="stats"><div class="stat"><b>${qs.length}</b><span>登録問題数</span></div><div class="stat"><b>${pending}</b><span>未克服</span></div><div class="stat"><b>${qs.filter(q=>isBad(q)&&latest(q)==='○').length}</b><span>克服済み</span></div><div class="stat"><b>${qs.filter(q=>isBad(q)&&history(q.id).length&&BAD.has(latest(q))).length}</b><span>再誤答</span></div></div>
      <p class="sub">初回 ×：${originalWrong}問 ／ 初回 △：${originalTriangle}問 ／ 復習履歴あり：${reviewed}問</p>
      <label class="select"><span>分野</span><select id="topic-select"><option value="">全分野</option>${topics.map(t=>`<option value="${esc(t)}" ${t===filterTopic?'selected':''}>${esc(t)}</option>`).join('')}</select></label>
      <div class="card"><strong>復習を開始</strong><p class="sub">正解した問題は「未克服」のリストから外れる。△・×は残る。</p>
        <div class="actions"><button class="primary" data-action="start" data-kind="pending">未克服だけ（${getQueue('pending').length}問）</button><button data-action="start" data-kind="all-bad">初回 ×・△ 全件（${getQueue('all-bad').length}問）</button></div>
        <div class="actions"><button data-action="start" data-kind="first-wrong">初回 × のみ（${getQueue('first-wrong').length}問）</button><button data-action="start" data-kind="repeat-bad">復習後も ×・△（${getQueue('repeat-bad').length}問）</button></div>
        ${resumable?`<div class="actions"><button data-action="resume">前回の続き（${Math.min(session.index+1,session.ids.length)} / ${session.ids.length}問）</button></div>`:''}
        <p class="sub">復習した問題数：${reviewed}問。1周目の正誤はインポート時の記録である。</p>
      </div>
      <div class="card"><strong>JSONの読み込み・バックアップ</strong>
        <p class="sub">Anki追加箱 v2.6.0以上が有効なら、正誤判定済みの問題を自動同期する。既存のJSONも手動で追加できる。</p>
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
    else if(a==='backup'){downloadBackup();}
    else if(a==='sync'){syncReady=false;requestAutoSync();notice='Anki追加箱の取得済み問題を再確認しています。';render();}
    else if(a==='expand-explanations'){const details=[...shadow.querySelectorAll('.exp-group details')];const expand=details.some(d=>!d.open);details.forEach(d=>d.open=expand);btn.textContent=expand?'すべて閉じる':'すべて展開';}
  }
  function handleChange(e) {
    const el=e.target;
    if(el.id==='topic-select'){filterTopic=el.value;render();return;}
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