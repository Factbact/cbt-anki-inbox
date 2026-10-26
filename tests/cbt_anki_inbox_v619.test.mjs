import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.argv[2] || new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
function fn(name){
 const start=source.search(new RegExp(`^  (?:async )?function ${name}\\(`,'m'));
 assert.ok(start>=0,name);
 const rest=source.slice(start+1),next=rest.search(/\n  (?:async )?function /);
 assert.ok(next>=0,name);return source.slice(start,start+1+next);
}
const session=(id,code)=>({id,chapterCode:code,subject:'科目'+code,source:'QB',division:'臨床医学',startedAt:'2026-10-26T00:00:00Z',automaticOverrides:{}});
const candidate=(id,s)=>({captureId:id,ankiId:`qb:123456:manual:${id}`,rawText:id,images:[],exerciseSessionId:s,sourceProblem:{qbId:'123456'},automaticCardPolicy:'manual_only',alsoCreateAutomatic:false});
function setup(saved){
 const storage=new Map(saved ? clone(saved) : [['items',[]],['state',{activeSessionId:'a',sessions:{a:session('a','A'),b:session('b','B')}}]]);
 const sim={code:'A',quiz:true,qbId:'123456',messages:[],blobs:[],downloads:[],seq:0,history:[],updates:0};
 class Node{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.value='';this.textContent='';this.dataset={};this.classList={add(){},remove(){},toggle(){}};}
  append(...nodes){this.children.push(...nodes);}appendChild(n){this.append(n);}set innerHTML(_){this.children=[];}
  addEventListener(k,f){this.listeners[k]=f;}setAttribute(){}remove(){}click(){sim.downloads.push(this.download);}
 }
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 node('source').value='QB';node('division').value='臨床医学';node('subject').value='科目A';
 const location={href:'https://example.invalid/quiz?question_id=1'};
 const c=vm.createContext({
  ITEMS_KEY:'items',EXERCISE_STATE_KEY:'state',ROOT_ID:'root',renderedCandidateScopeKey:null,lastUrl:location.href,
  stagedImages:[],stagedReason:'',CAPTURE_REASONS:[],questionEditor:null,questionListSignature:'',location,
  GM_getValue:(k,d)=>clone(storage.has(k)?storage.get(k):d),GM_setValue:(k,v)=>storage.set(k,clone(v)),
  getCurrentExerciseContext:()=>({source:'QB',division:'臨床医学',subject:'科目'+sim.code,chapterCode:sim.code}),
  getSettings:()=>({source:'QB',subject:'科目'+sim.code,division:'臨床医学'}),saveSettings(){},syncSettingsControls(){},
  isQBQuizPage:()=>sim.quiz,isQBSubjectPage:()=>false,isQBSearchPage:()=>false,maybeAutoUpdateSubject(){},
  getCurrentQuestionInfo:()=>({qbId:sim.qbId,pageUrl:location.href}),getNextManualAnkiId:()=>`qb:123456:manual:${++sim.seq}`,
  crypto:{randomUUID:()=>`id-${++sim.seq}`},shadow:{getElementById:node},
  document:{getElementById:()=>true,createElement:tag=>new Node(tag),body:new Node()},
  toast:m=>sim.messages.push(m),openSettings(){},renderImagePreviews(){},renderReasonButtons(){},
  updateSettingsSummary(){},updateQuestionDisplay(){},renderSaveDestination(){},renderExerciseSummary(){},renderQuestionCandidates(){},
  renderAutomaticOverrideButton(){},renderCurrentAutomaticOverrideList(){},
  renderExerciseHistory:()=>{sim.history=clone(c.getCandidateGroups());sim.updates++;},
  formatLocalDateTime:x=>x,deleteCandidateByCaptureId(){},sanitizeFilenamePart:x=>x,
  imageToEmbeddedData:async image=>image,markItemsExported(){},
  Blob,URL:{createObjectURL:blob=>{sim.blobs.push(blob);return 'blob:test';},revokeObjectURL(){}},
  setTimeout(){},Date,console
 });
 const names=['getItems','saveItems','getExerciseState','saveExerciseState','makeExerciseSessionId','getActiveExerciseSession','isSessionCompleted','getSessionChapterCode','findReusableExerciseSession','activateExerciseSession','getItemsForSession','countUnexported','createExerciseSession','ensureActiveExerciseSession','normalizeChapterCode','getLegacyGroupKey','getItemScopeKey','getCurrentScopeKey','getItemsForScope','getCurrentSessionItems','getAutomaticOverridesForSession','getCurrentAutomaticOverrides','getScopeMeta','getCandidateGroups','getDraftReason','clearDraftReason','saveDraftAsCandidates','buildCandidateCard','renderCurrentCandidateList','updateUI','monitorPage','getQBExporterCodeWithManualCandidates','exportCandidateScope','exportJSON'];
 if(source.includes('  function getEmptyCurrentCandidatesMessage('))names.push('getEmptyCurrentCandidatesMessage');
 vm.runInContext(names.map(fn).join('\n'),c);
 c.QB_EXPORTER_CODE=JSON.parse(source.match(/const QB_EXPORTER_CODE = (".*");/)[1]);
 return {c,sim,node,storage,snapshot:()=>clone([...storage]),items:()=>clone(storage.get('items')),state:()=>clone(storage.get('state'))};
}
let count=0;async function test(name,run){await run();count++;console.log('PASS',name);}
await test('複数手動追加を現演習へ保存し、一覧と手動JSONへ全件収録',async()=>{
 const t=setup();t.node('memory-text').value='候補1\n候補2';assert.equal(t.c.saveDraftAsCandidates().savedCount,2);
 t.node('memory-text').value='候補3';t.c.saveDraftAsCandidates();
 assert.equal(t.items().length,3);assert.ok(t.items().every(i=>i.exerciseSessionId==='a'&&i.automaticCardPolicy==='manual_only'&&!i.alsoCreateAutomatic));
 assert.equal(t.node('current-candidate-list').children.length,3);assert.equal(t.node('candidate-count').textContent,'3');
 await t.c.exportJSON();const output=JSON.parse(await t.sim.blobs[0].text());assert.deepEqual(output.candidates,t.items());assert.equal(output.count,3);
 assert.equal(output.exerciseSession.sessionId,'a');assert.match(t.sim.downloads[0],/^Anki追加候補_科目A_\d{4}-\d{2}-\d{2}_3件.json$/);
});
await test('再読込後も同演習の候補と原画像を維持',()=>{
 const t=setup();t.node('memory-text').value='画像付き';t.c.stagedImages=[{dataUrl:'data:image/png;base64,d2lkZQ==',width:12000,height:300}];t.c.saveDraftAsCandidates();
 const r=setup(t.snapshot());assert.equal(r.c.ensureActiveExerciseSession().id,'a');r.c.updateUI();
 assert.deepEqual(r.items(),t.items());assert.equal(r.node('current-candidate-list').children.length,1);
});
await test('既存データ・別演習・旧候補を混ぜず保存と出力を維持',async()=>{
 const t=setup();const originals=[candidate('a1','a'),candidate('b1','b'),candidate('legacy',null)];t.storage.set('items',clone(originals));
 t.c.activateExerciseSession('b');t.sim.code='B';t.node('subject').value='科目B';t.node('memory-text').value='b2';t.c.saveDraftAsCandidates();
 assert.deepEqual(t.items().slice(0,3),originals);assert.equal(t.node('current-candidate-list').children.length,2);
 await t.c.exportJSON();const output=JSON.parse(await t.sim.blobs[0].text());assert.ok(output.candidates.every(i=>i.exerciseSessionId==='b'));
 assert.equal(t.c.getCandidateGroups().length,3);
});
await test('手動のみの候補をQB全問コードへ渡し、結果のQB ID範囲だけ統合',()=>{
 const t=setup();t.storage.set('items',[candidate('a1','a'),candidate('a2','a'),candidate('b1','b'),{...candidate('a3','a'),sourceProblem:{qbId:'999999'}}]);
 const code=t.c.getQBExporterCodeWithManualCandidates();const injected=JSON.parse(code.match(/const INBOX_MANUAL_CANDIDATES = (.*);/)[1]);assert.equal(injected.length,3);
 const inner=vm.createContext({window:{__CBT_ANKI_MANUAL_CANDIDATES__:injected}});
 for(const name of ['getInboxManualCandidates','filterManualCandidatesForResults']){
  const a=code.indexOf(`    function ${name}(`),b=code.indexOf('\n    function ',a+1);vm.runInContext(code.slice(a,b),inner);
 }
 assert.deepEqual(clone(inner.filterManualCandidatesForResults([{qbId:'123456'}])).map(i=>i.captureId),['a1','a2']);
 assert.deepEqual(t.items().map(i=>i.captureId),['a1','a2','b1','a3']);
});
await test('遅れて演習Bを認識した監視処理で一覧・件数をBへ同期（旧版で再現）',()=>{
 const t=setup();t.storage.set('items',[candidate('b1','b'),candidate('b2','b')]);t.c.updateUI();assert.equal(t.node('candidate-count').textContent,'0');
 t.sim.code='B';t.c.monitorPage();assert.equal(t.c.getActiveExerciseSession().id,'b');
 assert.equal(t.node('candidate-count').textContent,'2');assert.equal(t.node('current-candidate-list').children.length,2);
 const updates=t.sim.updates;t.c.monitorPage();assert.equal(t.sim.updates,updates,'同じ演習で履歴を毎回作り直さない');
});
await test('別タブで切替済みの場合も表示を現演習に同期し、データを書き換えない',()=>{
 const t=setup();t.storage.set('items',[candidate('a1','a'),candidate('b1','b'),candidate('b2','b')]);t.c.updateUI();
 const state=t.state();state.activeSessionId='b';t.storage.set('state',state);t.sim.code='B';const before=t.items();t.c.monitorPage();
 assert.equal(t.node('candidate-count').textContent,'2');assert.deepEqual(t.items(),before);
});
await test('演習未確認を0件と断定せず、保存済み履歴が残ることを案内',async()=>{
 const t=setup();const old=[candidate('a1','a')];t.storage.set('items',clone(old));const state=t.state();state.activeSessionId='missing';t.storage.set('state',state);
 t.c.renderCurrentCandidateList();assert.match(t.node('current-candidate-list').children[0].textContent,/確認できない/);assert.match(t.node('current-candidate-list').children[0].textContent,/残っています/);
 await t.c.exportJSON();assert.equal(t.sim.blobs.length,0);assert.match(t.sim.messages.at(-1),/確認できない/);assert.deepEqual(t.items(),old);
});
await test('現演習が空でも別演習の手動データを回収・混入せず履歴へ案内',async()=>{
 const t=setup();t.storage.set('items',[candidate('b1','b')]);t.c.renderCurrentCandidateList();assert.match(t.node('current-candidate-list').children[0].textContent,/過去の演習/);
 await t.c.exportJSON();assert.equal(t.sim.blobs.length,0);assert.equal(t.items()[0].exerciseSessionId,'b');
});
console.log(`${count} tests passed (synthetic data; no real QB, browser download, or user storage)`);
