import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../qb_cbt_review_label_lock.user.js',import.meta.url),'utf8');
const baseline=fs.readFileSync(new URL('./fixtures/qb_cbt_review_label_lock_v048.user.js',import.meta.url),'utf8');
const day='2026-10-25';
function simulation(initial={}) {
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,open:false,dataset:{},style:{},value:'',setAttribute(){},focus(){this.focused=true;},scrollIntoView(){},querySelector(){return node(id+'Summary')}});return nodes.get(id);};
 const data=new Map([['qbCbtReviewLock.v1',JSON.stringify({mode:'smart'})],['qbCbtReviewLock.smartHistory.v1',JSON.stringify(initial)]]);
 const sim={q:'q123',result:true,resultUI:true,selected:'○',before:{label:'△',streak:1,lastCreditDay:'2026-10-24',source:'QBの解答前履歴表'},evidence:null,buttons:true,clicks:0,lookups:0,failStorage:false,timers:[]};
 const localStorage={getItem:k=>data.get(k)||null,setItem(k,v){if(sim.failStorage)throw Error('full');data.set(k,v)},removeItem:k=>data.delete(k)};
 let code=source;
 function stub(signature,body){assert.ok(code.includes(signature),signature);code=code.replace(signature,signature+body);}
 stub('  function previousForQuestion(q) {','return __sim.before;');
 stub('  function previouslyObservedLabel(q) {','return __sim.before;');
 stub('  function previousFromOldHistory(q) {','return null;');
 stub('  function resolveCurrentCorrectness(q) {',"return __sim.result===null?null:{correct:__sim.result,source:'QBの結果表示'};");
 stub('  function startAnswerLookup(q) {','__sim.lookups++;return;');
 stub('  function selectedEvaluation() {','return __sim.selected;');
 stub('  function historyPromotionEvidence(q,correct) {','return __sim.evidence;');
 stub('  const findByLabel = (mode) => {','return __sim.buttons?{click(){__sim.clicks++;__sim.selected=mode;}}:null;');
 stub('  const selectedState = (el) => {','return false;');
 code=code.replace(/  const hasResultUI = .*?;\n/,'  const hasResultUI = () => __sim.resultUI;\n');
 code=code.replace(/  const questionId = \(\) => \{/, '  const questionId = () => { return __sim.q;');
 code=code.replace("  if (document.readyState === 'loading')",`  globalThis.T={decideSmart,progressSummary,assistStatus,setAssistStatus,setInfo,openAssistTarget,applySmart,markUnsure,undoAutomatic,refreshSmartInfo,scan,
 setUI(value){ui=value;},setPending(value){pending=value;},getRecord,
 setProgress(value){progressNotice=value;},getProgress(){return progressNotice;},
 setMode(value){config.mode=value;},setBefore(value){__sim.before=value;},
 setAnswer(value){answerContext=value;},getAnswer(){return answerContext;},getUndo(){return lastAutomatic;}};
  if (document.readyState === 'loading')`);
 const fixedDate=class extends Date{constructor(...args){super(...(args.length?args:['2026-10-25T03:00:00Z']));}static now(){return new Date('2026-10-25T03:00:00Z').getTime();}};
 const context=vm.createContext({__sim:sim,localStorage,window:{setTimeout(fn){sim.timers.push(fn)},innerWidth:1000,innerHeight:800},document:{readyState:'loading',addEventListener(){},querySelectorAll(){return []}},location:{href:'https://cbt.medilink-study.com/quiz?question_id=q123'},URL,Intl,Date:fixedDate,structuredClone,console});
 vm.runInContext(code,context,{timeout:2000});
 const T=context.T;
 T.setUI({shadow:{getElementById:node},host:{style:{},getBoundingClientRect(){return {left:0,top:0,width:280,height:300}}}});
 return {T,sim,node,data,flush(){let i=0;while(sim.timers.length){assert.ok(i++<20);sim.timers.shift()();}},task(){return {q:sim.q,mode:'smart',before:sim.before,done:false,token:0,until:Date.now()+9999999}}};
}
let passed=0;
function test(name,fn){fn();console.log('PASS',name);passed++;}
test('判定ロジックはv0.4.8から変更していない',()=>{
 const extract=s=>s.slice(s.indexOf('  function decideSmart('),s.indexOf('  function setReason('));
 assert.equal(extract(source),extract(baseline));
});
test('5評価×正誤の10通りと不明時の安全停止',()=>{
 const {T}=simulation();
 for(const [label,correctLabel] of [['◎','◎'],['○','○'],['△','△'],['×','△'],['未演習','○']]){
  assert.equal(T.decideSmart({label,streak:0},true,day).label,correctLabel);
  assert.equal(T.decideSmart({label,streak:2},false,day).label,'×');
 }
 assert.equal(T.decideSmart({label:null},true,day),null);
 assert.equal(T.decideSmart({label:'○'},null,day),null);
});
test('同日の追加加算なし・異なる3日で○への説明',()=>{
 const {T}=simulation();let before={label:'△',streak:1,lastCreditDay:day};
 let result=T.decideSmart(before,true,day);assert.equal(result.streak,1);assert.match(T.progressSummary(before,result,day),/追加加算なし/);
 before={label:'△',streak:2,lastCreditDay:'2026-10-24'};result=T.decideSmart(before,true,day);
 assert.equal(result.label,'○');assert.match(T.progressSummary(before,result,day),/このブラウザ.*3学習日/);
});
test('QBの3日履歴による昇格は出典と日付を表示',()=>{
 const {T}=simulation();const before={label:'△',streak:0},evidence={days:[day,'2026-10-24','2026-10-23']};
 const result=T.decideSmart(before,true,day,evidence);assert.equal(result.label,'○');
 assert.match(T.progressSummary(before,result,day,evidence),/QB履歴.*2026-10-25/);
});
test('読取待機では対処ボタンを出さない',()=>{
 const {T,node}=simulation();T.setAssistStatus('missing-button','△');T.setAssistStatus('reading-previous');
 assert.equal(node('statusTitle').textContent,'前回評価を読み込み中');assert.equal(node('statusAction').hidden,true);
});
test('正誤不明の待機とタイムアウトはクリック・履歴変更なし',()=>{
 const c=simulation();c.sim.result=null;const before=c.data.get('qbCbtReviewLock.smartHistory.v1');
 const task=c.task();assert.equal(c.T.applySmart(task),false);assert.equal(c.node('statusTitle').textContent,'正誤を読み込み中');
 task.until=0;c.T.setPending(task);c.T.scan();c.flush();assert.equal(c.node('statusTitle').textContent,'停止：今回の正誤が不明');
 assert.equal(c.sim.clicks,0);assert.equal(c.data.get('qbCbtReviewLock.smartHistory.v1'),before);
});
test('前回不明の停止ではボタン登録を要求しない',()=>{
 const c=simulation();c.sim.before={label:null};let task=c.task();task.until=0;c.T.applySmart(task);
 assert.equal(c.sim.clicks,0);assert.equal(c.node('statusTitle').textContent,'停止：前回評価が不明');
 assert.equal(c.node('statusAction').dataset.action,'details');
});
test('ボタン未認識は対象の登録設定を案内',()=>{
 const c=simulation();c.sim.buttons=false;c.T.applySmart(c.task());assert.equal(c.sim.clicks,0);
 assert.equal(c.node('statusTitle').textContent,'停止：△ボタンが未認識');
 assert.equal(c.node('statusAction').dataset.label,'△');
});
test('案内ボタンは設定を開くだけで履歴・QB操作をしない',()=>{
 const c=simulation();const before=c.data.get('qbCbtReviewLock.smartHistory.v1');
 c.T.openAssistTarget('calibrate','△');assert.equal(c.node('settingsDetails').open,true);assert.equal(c.node('otherSettings').open,true);assert.equal(c.node('calibrateLabel').value,'△');
 assert.equal(c.sim.clicks,0);assert.equal(c.sim.lookups,0);assert.equal(c.data.get('qbCbtReviewLock.smartHistory.v1'),before);
});
test('保存不能ならQB評価に触らない',()=>{
 const c=simulation();c.sim.failStorage=true;c.T.applySmart(c.task());assert.equal(c.sim.clicks,0);assert.equal(c.node('statusTitle').textContent,'停止：履歴を保存できない');
});
test('成功→自信なし→取り消しで評価・回数・説明を復元',()=>{
 const c=simulation({q123:{schema:2,label:'△',streak:1,lastCreditDay:'2026-10-24',updatedAt:1}});
 c.T.applySmart(c.task());c.flush();assert.equal(c.sim.selected,'△');assert.equal(c.T.getRecord('q123').streak,2);
 const progress=c.T.getProgress().text;c.T.markUnsure();c.flush();assert.equal(c.T.getRecord('q123').streak,0);assert.match(c.node('progressNote').textContent,/自信なし/);
 c.T.undoAutomatic();c.flush();assert.equal(c.T.getRecord('q123').streak,2);assert.equal(c.T.getProgress().text,progress);assert.equal(c.node('progressNote').textContent,progress);
});
test('手動変更後の取り消しを止め、別問題へ説明を持ち越さない',()=>{
 const c=simulation();c.T.applySmart(c.task());c.flush();c.sim.selected='◎';const clicks=c.sim.clicks;c.T.undoAutomatic();c.flush();assert.equal(c.sim.clicks,clicks);
 c.T.setProgress({q:'q123',text:'古い説明'});c.sim.q='q456';c.T.refreshSmartInfo();assert.notEqual(c.node('progressNote').textContent,'古い説明');
});
test('一般のメッセージに切り替えたら古い対処ボタンを消す',()=>{
 const c=simulation();c.T.setAssistStatus('missing-button','○');c.T.setInfo('登録完了','ok');assert.equal(c.node('statusAction').hidden,true);assert.equal(c.node('statusAction').dataset.action,'');
});
test('正誤・前回評価の読取と履歴からの昇格根拠は基準版を維持',()=>{
 const extract=s=>s.slice(s.indexOf('  const normalize = '),s.indexOf('  function decideSmart('));
 assert.equal(extract(source),extract(baseline));
});
test('画面反映を確認できないときは再クリック・履歴更新をしない',()=>{
 const c=simulation();const old=c.data.get('qbCbtReviewLock.smartHistory.v1');
 c.T.applySmart(c.task());c.sim.selected='◎';c.flush();
 assert.equal(c.sim.clicks,1);assert.equal(c.data.get('qbCbtReviewLock.smartHistory.v1'),old);
 assert.equal(c.node('statusTitle').textContent,'要確認：評価の反映が未確認');
});
console.log(`${passed} tests passed`);
