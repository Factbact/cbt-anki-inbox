import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const exporter=JSON.parse(source.match(/const QB_EXPORTER_CODE = (".*");/)[1]);
function harness(options={}) {
  const sim={parentBlobs:[],managedCalls:[],closed:0,downloads:0,filenames:[],messages:[],writes:[],aborts:0,timers:new Map(),seq:0,pickerCalls:0,docReads:0,manual:[],...options};
  const nodes=new Map();
  function node(id) {
    if(!nodes.has(id))nodes.set(id,{checked:id==='autoClose',hidden:false,disabled:false,textContent:'',listeners:{},
      addEventListener(event,fn){this.listeners[event]=fn},click(){return this.onclick?.()??this.listeners.click?.()},remove(){}});
    return nodes.get(id);
  }
  const doc={documentElement:{},body:{appendChild(){}},getElementById:node,createElement(){return {click(){if(sim.downloadError)throw Error('blocked');sim.downloads++;sim.filenames.push(this.download)},remove(){}}}};
  const qb={closed:false,document:{body:{}},postMessage(m){sim.messages.push(m)}};
  const w={opener:qb,location:{href:'about:blank'},__QB_EXPORTER_OWNED_DOCUMENT__:doc,
    listeners:{},addEventListener(event,fn){this.listeners[event]=fn},close(){sim.closed++},__CBT_ANKI_EXERCISE_SESSION__:{id:'s'}};
  w.top=w;
  w.__QB_EXPORTER_CREATE_URL__=blob=>{sim.parentBlobs.push(blob);return 'blob:parent'};
  if(options.managed) w.__QB_INBOX_MANAGED_DOWNLOAD__=async(json,name)=>{
    sim.managedCalls.push({json,name});await sim.pendingSave;
    if(sim.saveError)throw Error('save failed');
    return sim.badReceipt?{completed:false}:{completed:true,filename:name};
  };
  const handle={name:'chosen.json',async createWritable(){
    if(sim.createError)throw Error('denied');
    return {async write(blob){sim.writes.push(blob);if(sim.writeError)throw Error('full');await sim.writeWait},
      async close(){if(sim.closeError)throw Error('flush failed');await sim.closeWait},async abort(){sim.aborts++}};
  }};
  if(!sim.unsupported)w.showSaveFilePicker=async()=>{sim.pickerCalls++;if(sim.pickerError)throw Error('denied');return handle};
  const context=vm.createContext({window:w,document:doc,console:{log(){}},Blob,URL:{createObjectURL(){return 'blob:test'},revokeObjectURL(){throw Error('unexpected revoke')}},
    setTimeout(fn,ms){assert.equal(ms,5000);const id=++sim.seq;sim.timers.set(id,fn);return id},clearTimeout(id){sim.timers.delete(id)},
    __sim:sim,Date,Map,Set,JSON,Promise});
  let code=exporter.slice(exporter.indexOf('  function controllerMain() {'),exporter.lastIndexOf('\n  try {\n    controller.eval'));
  function stub(signature,body){assert.ok(code.includes(signature),signature);code=code.replace(signature,signature+body)}
  stub('    async function prepareManualCandidates(results) {','return __sim.manual;');
  stub('    function getDoc() {','__sim.docReads++;return __sim.missingDoc?null:{body:{}};');
  stub('    function getDetectionText(doc) {','return "test";');
  stub('    function parseProgress(text) {','return {current:1,total:1};');
  stub('    function findAnswerButton(doc) {','return {};');
  stub('    function getPageIdentity(doc) {','return {current:1,total:1};');
  stub('    function identityKey(identity) {','return "1";');
  stub('    async function revealAnswer(doc, progress) {','return {success:!__sim.revealError,reason:"test"};');
  stub('    async function capture(doc) {','return {qbId:"1"};');
  // No browser/QB access: replace polling implementation with immediate model result.
  stub('    function waitUntil(test, timeoutMs) {','return Promise.resolve(!__sim.missingDoc);');
  code=code.replace('    startButton.addEventListener(',`    globalThis.T={prepareDownload,run,savePrepared,isOwnedExporter,
    get prepared(){return preparedSave},setRunning(v){running=v},setStop(v){stopRequested=v}};\n    startButton.addEventListener(`);
  vm.runInContext(code+'\ncontrollerMain();',context);
  return {sim,node,w,doc,qb,context,T:context.T,handle,flush(){for(const [id,fn] of [...sim.timers]){sim.timers.delete(id);fn()}}};
}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS',name)}
const rows=[{qbId:'1'}];
await test('ordinary download runs without GM manager or parent Blob callbacks',async()=>{
  const h=harness({managed:true});h.w.__QB_EXPORTER_CREATE_URL__=()=>{throw Error('wrapped window mismatch')};
  await h.T.run();assert.equal(h.sim.downloads,1);assert.equal(h.sim.managedCalls.length,0);assert.equal(h.sim.parentBlobs.length,0);
  assert.equal(h.T.prepared.url,'blob:test');assert.equal(h.sim.closed,0);assert.equal(h.sim.timers.size,1);h.flush();assert.equal(h.sim.closed,1);
  assert.equal(h.sim.messages.length,0);assert.equal(h.sim.pickerCalls,0);
});
await test('former GM download rejection/hang cannot block ordinary download',async()=>{
  for(const managedDownload of [()=>Promise.reject(Error('not_permitted')),()=>new Promise(()=>{})]){
    const h=harness();h.w.__QB_INBOX_MANAGED_DOWNLOAD__=managedDownload;await h.T.run();assert.equal(h.sim.downloads,1);assert.equal(h.sim.timers.size,1);
  }
});
await test('22 question/four manual output uses original filename and exact payload counts',async()=>{
  const h=harness({manual:Array.from({length:4},(_,i)=>({captureId:'TEST'+i,images:[]}))});await h.T.prepareDownload(Array.from({length:22},(_,i)=>({qbId:String(i)})),22);
  assert.deepEqual(h.sim.filenames,['qb_22questions_with_answers_manual_4.json']);const payload=JSON.parse(await h.T.prepared.blob.text());assert.equal(payload.retrievedQuestions,22);assert.equal(payload.questions.length,22);assert.equal(payload.manualCandidates.candidates.length,4);assert.equal(payload.complete,true);
});
await test('anchor error keeps concrete error, retry enabled, no timer',async()=>{
  const h=harness({downloadError:true});await h.T.run();assert.equal(h.sim.closed,0);assert.equal(h.sim.timers.size,0);assert.match(h.node('saveStatus').textContent,/blocked/);assert.equal(h.node('download').disabled,false);
  h.sim.downloadError=false;await h.node('download').click();assert.equal(h.sim.downloads,1);h.flush();assert.equal(h.sim.closed,1);
});
await test('cancel invalidates queued callback and does not claim saved',async()=>{
  const h=harness();await h.T.run();const callback=[...h.sim.timers.values()][0];assert.match(h.node('saveStatus').textContent,/保存完了は未確認/);h.node('cancelFallbackClose').click();callback();h.flush();assert.equal(h.sim.closed,0);assert.equal(h.sim.messages.length,0);
});
for(const kind of ['partial','stopped','imageFailure'])await test(`${kind} downloads but cannot close`,async()=>{
  const h=harness();if(kind==='stopped')h.T.setStop(true);if(kind==='imageFailure')h.sim.manual=[{images:[{embedError:'failed'}]}];
  await h.T.prepareDownload(rows,kind==='partial'?2:1,kind==='partial'?'failed':null);assert.equal(h.sim.downloads,1);assert.equal(h.sim.timers.size,0);h.flush();assert.equal(h.sim.closed,0);
});
await test('restart, stop and navigation cancel timers',async()=>{
  for(const action of ['restart','stop','navigate']){const h=harness();await h.T.run();if(action==='restart'){h.sim.missingDoc=true;await h.T.run()}else if(action==='stop')h.node('stop').click();else h.w.listeners.pagehide();h.flush();assert.equal(h.sim.closed,0);}
});
await test('different URL/document/root/opener/frame never closes',async()=>{
  for(const change of [h=>h.w.location.href='https://example.invalid',h=>h.context.document={},h=>h.doc.documentElement={},h=>h.w.opener=null,h=>h.w.top={}]){
    const h=harness();await h.T.run();change(h);h.flush();assert.equal(h.sim.closed,0);
  }
});
await test('resave replaces timer, multiple exporters act only on themselves',async()=>{
  const a=harness(),b=harness();await a.T.run();await b.T.run();const old=[...a.sim.timers.values()][0];await a.node('download').click();old();assert.equal(a.sim.closed,0);a.flush();assert.equal(a.sim.closed,1);assert.equal(b.sim.closed,0);b.node('cancelFallbackClose').click();b.flush();assert.equal(b.sim.closed,0);
});
await test('no new permission, manager/parent callback or foreign document marker remains',()=>{
  for(const x of ['GM_download','attachQBManagedDownload','__QB_EXPORTER_CREATE_URL__','__QB_EXPORTER_OWNED_DOCUMENT__'])assert.ok(!source.includes(x),x);
  assert.match(exporter,/lastObjectUrl = URL.createObjectURL\(blob\)/);
  assert.match(exporter,/document.documentElement === ownedRoot/);
});
console.log(`${count} controller tests passed`);
