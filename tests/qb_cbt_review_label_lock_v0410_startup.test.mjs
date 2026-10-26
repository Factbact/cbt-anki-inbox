import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.argv[2] || new URL('../qb_cbt_review_label_lock.user.js',import.meta.url),'utf8');
function setup(options={}) {
 const sim={installs:0,polls:0,clicks:0,failInstall:0,failPoll:0,messages:[],writes:0,...options};
 const timers=new Map(),intervals=[],events=new Map(),docEvents=new Map(),observers=[];let seq=0;
 const initialData=[['qbCbtReviewLock.v1',JSON.stringify({mode:'smart',collapsed:true,position:{left:30,top:40}})],['qbCbtReviewLock.smartHistory.v1',JSON.stringify({q1:{schema:2,label:'△',streak:1,lastCreditDay:'2026-10-25',source:'自動'}})]];
 const data=new Map(initialData);
 if(options.legacyHistory)data.set('qbCbtReviewLock.smartHistory.v1',JSON.stringify({q1:{label:'△',streak:1}}));
 const add=(map,k,f)=>{if(!map.has(k))map.set(k,new Set());map.get(k).add(f);};
 const location=new URL(options.url || 'https://cbt.medilink-study.com/quiz?question_id=q1');
 const makeBody=()=>({hosts:new Set(),append(host){host.parent?.hosts.delete(host);host.parent=this;host.isConnected=true;this.hosts.add(host);}});
 const doc={readyState:options.readyState||'complete',body:options.noBody?null:makeBody(),addEventListener:(k,f)=>add(docEvents,k,f),querySelectorAll:()=>[]};
 sim.makeUI=()=>{
  const host={parent:null,isConnected:false,style:{},contains:()=>false,remove(){this.parent?.hosts.delete(this);this.parent=null;this.isConnected=false;}};
  doc.body.append(host);return {host,shadow:{}};
 };
 const win={setTimeout(fn){const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),setInterval:fn=>{intervals.push(fn);return intervals.length;},
  addEventListener:(k,f)=>add(events,k,f),innerWidth:1000,innerHeight:800};
 class Observer {constructor(fn){this.callback=fn;this.target=null;observers.push(this);}observe(target){this.target=target;}disconnect(){this.target=null;}}
 let code=source;
 function stub(signature,body){assert.ok(code.includes(signature),signature);code=code.replace(signature,signature+body);}
 stub('  function installUI() {','__sim.installs++;if(!document.body)return false;ui=__sim.makeUI();if(__sim.failInstall-->0)throw Error("transient install");return true;');
 stub('  function pollBeforeAnswer(force=false) {','__sim.polls++;if(__sim.failPoll-->0)throw Error("transient poll");return;');
 stub('  function refreshSmartInfo() {','return;');
 stub('  function applyPanelGeometry() {','return;');
 stub('  function positionPanel(position) {','return;');
 stub("  function setInfo(message, type='neutral', state=null) {",'__sim.messages.push(message);return;');
 stub('  function onUserClick(e) {','__sim.clicks++;return;');
 code=code.replace("  if (document.readyState === 'loading')",`  globalThis.T={start,getUI(){return ui},getPending(){return pending},nonce(){return operationNonce},
    arm(){pending={q:questionId(),mode:'smart'};scanTimer=window.setTimeout(()=>{},120);}};
  if (document.readyState === 'loading')`);
 const context=vm.createContext({__sim:sim,window:win,document:doc,location,URL,Intl,Date,structuredClone,MutationObserver:Observer,
  console:{warn(){},log(){}},localStorage:{getItem:k=>data.get(k)||null,setItem(k,v){sim.writes++;data.set(k,v);}}});
 const run=()=>vm.runInContext(code,context);
 run();
 return {sim,data,initialData,context,doc,win,intervals,observers,timers,run,T:context.T,
  tick(){for(const f of intervals)f();},event(k){for(const f of events.get(k)||[])f({});},ready(){doc.readyState='complete';for(const f of docEvents.get('DOMContentLoaded')||[])f();},
  navigate(path){const next=new URL(path,location);for(const k of ['href','pathname','search'])location[k]=next[k];},
  addBody(){doc.body=makeBody();},replaceBody(){for(const h of doc.body.hosts)h.isConnected=false;doc.body=makeBody();},
  click(){for(const f of docEvents.get('click')||[])f({});},listenerCount(k){return events.get(k)?.size||0;},
  mutation(){for(const o of observers)if(o.target)o.callback([{target:doc.body}]);}};
}
let count=0;function test(name,run){if(process.argv[3]&&!name.includes(process.argv[3]))return;run();count++;console.log('PASS',name);}
test('同一サイトの検索からSPAでquizに入っても起動するメタデータ',()=>{
 assert.match(source,/^\/\/ @match\s+https:\/\/cbt\.medilink-study\.com\/\*$/m);
 assert.equal((source.match(/^\/\/ @match/gm)||[]).length,1);
});
test('初回quiz読込・DOM準備完了後に一度だけ起動',()=>{
 const h=setup({readyState:'loading'});assert.equal(h.sim.installs,0);h.ready();assert.equal(h.sim.installs,1);h.ready();h.T.start();
 assert.equal(h.intervals.length,1);assert.equal(h.doc.body.hosts.size,1);assert.equal(h.listenerCount('storage'),1);h.click();assert.equal(h.sim.clicks,1);
});
test('bodyが遅れて生成されても再試行して起動',()=>{
 const h=setup({noBody:true});h.addBody();h.tick();assert.equal(h.doc.body.hosts.size,1);assert.ok(h.sim.polls>0);
});
test('初期パネル生成の例外後も部分パネルを残さず再起動',()=>{
 const h=setup({failInstall:1});assert.equal(h.doc.body.hosts.size,0);h.tick();assert.equal(h.doc.body.hosts.size,1);assert.equal(h.sim.installs,2);assert.equal(h.intervals.length,1);
});
test('最初のデータ読取例外でも監視とクリック登録が残る',()=>{
 const h=setup({failPoll:1});h.tick();assert.ok(h.sim.polls>=2);assert.equal(h.doc.body.hosts.size,1);h.click();assert.equal(h.sim.clicks,1);
});
test('非quizはパネル・読取・保存・クリック処理なし、SPA入場で起動',()=>{
 const h=setup({url:'https://cbt.medilink-study.com/search'});h.tick();h.click();assert.equal(h.sim.installs,0);assert.equal(h.sim.polls,0);assert.equal(h.sim.writes,0);assert.equal(h.sim.clicks,0);
 h.navigate('/quiz?question_id=q1');h.tick();assert.equal(h.sim.installs,1);assert.ok(h.sim.polls>0);
});
test('非quizでは旧履歴の退避も実行せず、quiz入場時だけ既存処理で読む',()=>{
 const h=setup({url:'https://cbt.medilink-study.com/search',legacyHistory:true});const original=h.data.get('qbCbtReviewLock.smartHistory.v1');h.tick();assert.equal(h.sim.writes,0);
 h.navigate('/quiz?question_id=q1');h.tick();assert.equal(h.data.get('qbCbtReviewLock.smartHistory.pre040.backup'),original);assert.equal(h.data.get('qbCbtReviewLock.smartHistory.v1'),original);assert.equal(h.sim.writes,1);
});
test('パネル削除とbody置換から同じパネルを復旧し監視を付け直す',()=>{
 const h=setup(),host=h.T.getUI().host;h.T.arm();host.remove();h.mutation();assert.equal(h.T.getUI().host,host);assert.ok(host.isConnected);assert.equal(h.T.getPending(),null);
 h.replaceBody();h.tick();assert.equal(h.T.getUI().host,host);assert.equal(h.observers[0].target,h.doc.body);assert.equal(h.doc.body.hosts.size,1);assert.equal(h.sim.installs,1);
});
test('quiz外へ出ると自動待機を停止・非表示、戻る進むで単一起動',()=>{
 const h=setup();h.T.arm();h.navigate('/search');h.event('popstate');assert.equal(h.T.getPending(),null);assert.equal(h.timers.size,0);assert.equal(h.T.getUI().host.style.display,'none');assert.equal(h.observers[0].target,null);
 const polls=h.sim.polls;h.tick();h.click();assert.equal(h.sim.polls,polls);assert.equal(h.sim.clicks,0);
 h.navigate('/quiz?question_id=q2');h.event('popstate');assert.equal(h.T.getUI().host.style.display,'');assert.equal(h.sim.installs,1);assert.equal(h.intervals.length,1);
});
test('BFCacheのpagehide/pageshowで古い待機を再開しない',()=>{
 const h=setup();h.T.arm();h.event('pagehide');assert.equal(h.T.getPending(),null);assert.equal(h.timers.size,0);assert.equal(h.observers[0].target,null);
 h.event('pageshow');assert.equal(h.observers[0].target,h.doc.body);assert.equal(h.T.getPending(),null);assert.equal(h.sim.installs,1);
});
test('重複スクリプト実行でもタイマー・パネル・クリック処理が増えない',()=>{
 const h=setup();h.run();h.T.start();h.tick();assert.equal(h.sim.installs,1);assert.equal(h.intervals.length,1);assert.equal(h.observers.length,1);h.click();assert.equal(h.sim.clicks,1);
});
test('遷移・DOM復旧・読取例外・再読込でも設定と現行履歴を変更しない',()=>{
 const h=setup();h.sim.failPoll=1;h.tick();assert.equal(h.T.getPending(),null);h.tick();h.navigate('/search');h.tick();h.navigate('/quiz?question_id=q2');h.tick();h.replaceBody();h.tick();
 assert.deepEqual([...h.data],h.initialData);assert.equal(h.sim.writes,0);const reloaded=setup();assert.deepEqual([...reloaded.data],h.initialData);assert.equal(reloaded.doc.body.hosts.size,1);
});
console.log(`${count} startup tests passed (VM lifecycle simulation, no real browser or QB actions)`);
