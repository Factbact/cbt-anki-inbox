import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const exporter=JSON.parse(source.match(/const QB_EXPORTER_CODE = (".*");/)[1]);
function harness(options={}) {
  const sim={managedCalls:[],closed:0,downloads:0,filenames:[],messages:[],writes:[],aborts:0,timers:new Map(),seq:0,pickerCalls:0,docReads:0,manual:[],...options};
  const nodes=new Map();
  function node(id) {
    if(!nodes.has(id))nodes.set(id,{checked:id==='autoClose',hidden:false,disabled:false,textContent:'',listeners:{},
      addEventListener(event,fn){this.listeners[event]=fn},click(){return this.onclick?.()??this.listeners.click?.()},remove(){}});
    return nodes.get(id);
  }
  const doc={body:{appendChild(){}},getElementById:node,createElement(){return {click(){if(sim.downloadError)throw Error('blocked');sim.downloads++;sim.filenames.push(this.download)},remove(){}}}};
  const qb={closed:false,document:{body:{}},postMessage(m){sim.messages.push(m)}};
  const w={opener:qb,location:{href:'about:blank'},__QB_EXPORTER_OWNED_DOCUMENT__:doc,
    close(){sim.closed++},__CBT_ANKI_EXERCISE_SESSION__:{id:'s'}};
  w.top=w;
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
await test('full run closes only after managed completion without extra click or filename change',async()=>{
  let release;const pendingSave=new Promise(r=>release=r);const h=harness({managed:true,pendingSave});
  const p=h.T.run();await new Promise(r=>setTimeout(r,0));
  assert.equal(h.sim.closed,0);assert.equal(h.sim.managedCalls.length,1);assert.equal(h.node('start').disabled,true);assert.equal(h.sim.messages.length,0);
  release();await p;assert.equal(h.sim.closed,1);assert.equal(h.qb.closed,false);assert.equal(h.sim.pickerCalls,0);assert.equal(h.sim.downloads,0);
  assert.equal(h.sim.managedCalls[0].name,'qb_1questions_with_answers_manual_0.json');assert.equal(h.sim.messages.length,1);
  assert.equal(h.sim.timers.size,0);assert.ok(!exporter.includes('id="confirmSaved"'));
});
for(const key of ['saveError','badReceipt'])await test(`${key} keeps popup and retry, no fallback duplicate or saved notification`,async()=>{
  const h=harness({managed:true,[key]:true});await h.T.run();assert.equal(h.sim.closed,0);assert.equal(h.sim.downloads,0);assert.equal(h.sim.messages.length,0);assert.equal(h.node('download').disabled,false);
  h.sim[key]=false;await h.node('download').click();assert.equal(h.sim.closed,1);
});
await test('unsupported or copied exporter keeps ordinary download, never timer-closes',async()=>{
  const h=harness();await h.T.run();h.flush();assert.equal(h.sim.downloads,1);assert.equal(h.sim.closed,0);assert.equal(h.sim.pickerCalls,0);
});
for(const kind of ['partial','stopped','imageFailure'])await test(`${kind} saves but does not close or complete the session`,async()=>{
  const h=harness({managed:true});if(kind==='stopped')h.T.setStop(true);if(kind==='imageFailure')h.sim.manual=[{images:[{embedError:'failed'}]}];
  await h.T.prepareDownload(rows,kind==='partial'?2:1,kind==='partial'?'failed':null);
  assert.equal(h.sim.managedCalls.length,1);assert.equal(h.sim.closed,0);assert.equal(h.sim.messages.length,0);
});
await test('stop during download prevents close after later success',async()=>{
  let release;const h=harness({managed:true,pendingSave:new Promise(r=>release=r)});const p=h.T.run();await new Promise(r=>setTimeout(r,0));h.T.setStop(true);release();await p;assert.equal(h.sim.closed,0);
});
await test('navigation or replaced document prevents close',async()=>{
  for(const change of [h=>h.w.location.href='https://example.invalid',h=>h.context.document={},h=>h.w.opener=null]){
    let release;const h=harness({managed:true,pendingSave:new Promise(r=>release=r)});const p=h.T.run();await new Promise(r=>setTimeout(r,0));change(h);release();await p;assert.equal(h.sim.closed,0);
  }
});
await test('failed restart cannot close from a previous successful batch',async()=>{
  const h=harness({managed:true});await h.T.run();const n=h.sim.closed;h.sim.missingDoc=true;await h.T.run();assert.equal(h.sim.closed,n);
});
console.log(`${count} controller tests passed`);
