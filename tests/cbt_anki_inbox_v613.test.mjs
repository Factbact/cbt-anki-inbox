import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const exporter=JSON.parse(source.match(/const QB_EXPORTER_CODE = (".*");/)[1]);
function harness(options={}) {
  const sim={closed:0,downloads:0,filenames:[],messages:[],writes:[],aborts:0,timers:new Map(),seq:0,pickerCalls:0,docReads:0,manual:[],...options};
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
// Regression for the v6.13 exporter correction in v6.14.
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS',name)}
const rows=[{qbId:'1'}];
await test('save picker, file handle writes and automatic close are absent',()=>{
  for(const name of ['showSaveFilePicker','createWritable','saveHandle','scheduleAutoClose','qb_export.json','id="autoClose"'])assert.ok(!exporter.includes(name),name);
  assert.match(exporter,/window.open\(\s*"about:blank",\s*"_blank"/);
  assert.ok(!exporter.includes('qb.close('));
});
await test('normal run downloads immediately using original filename even when picker API exists',async()=>{
  const h=harness();await h.T.run();assert.equal(h.sim.pickerCalls,0);assert.equal(h.sim.writes.length,0);
  assert.equal(h.sim.downloads,1);assert.deepEqual(h.sim.filenames,['qb_1questions_with_answers_manual_0.json']);
  h.flush();assert.equal(h.sim.closed,0);assert.equal(h.sim.timers.size,0);assert.equal(h.sim.messages.length,0);
});
await test('22 questions and four candidates reproduce screenshot/v6.12 filename',async()=>{
  const h=harness({manual:Array.from({length:4},(_,i)=>({captureId:`m${i}`,images:[]}))});
  await h.T.prepareDownload(Array.from({length:22},(_,i)=>({qbId:String(i)})),22);
  assert.deepEqual(h.sim.filenames,['qb_22questions_with_answers_manual_4.json']);
  const payload=JSON.parse(await h.T.prepared.blob.text());
  assert.equal(payload.questions.length,22);assert.equal(payload.manualCandidates.included,4);assert.equal(payload.complete,true);
});
await test('unsupported browser follows same download without auto-close',async()=>{
  const h=harness({unsupported:true});await h.T.prepareDownload(rows,1);h.flush();
  assert.equal(h.sim.closed,0);assert.equal(h.sim.messages.length,0);assert.equal(h.sim.downloads,1);
  await h.node('download').click();assert.equal(h.sim.downloads,2);assert.equal(h.sim.timers.size,0);
});
await test('manual saved confirmation closes only owned popup and sends generated filename',async()=>{
  const h=harness();await h.T.prepareDownload(rows,1);h.node('confirmSaved').click();
  assert.equal(h.sim.closed,1);assert.equal(h.qb.closed,false);assert.equal(h.sim.messages[0].filename,'qb_1questions_with_answers_manual_0.json');
});
await test('blocked download is retryable, not acknowledged and not closed',async()=>{
  const h=harness({downloadError:true});await h.T.prepareDownload(rows,1);
  h.node('confirmSaved').click();assert.equal(h.sim.closed,0);assert.equal(h.node('confirmSaved').hidden,true);
  assert.equal(h.node('download').disabled,false);assert.equal(h.sim.messages.length,0);
  h.sim.downloadError=false;await h.node('download').click();assert.equal(h.sim.downloads,1);assert.equal(h.sim.closed,0);
});
for(const kind of ['partial','stopped','imageFailure'])await test(`${kind} keeps the window and save data available`,async()=>{
  const h=harness();if(kind==='stopped')h.T.setStop(true);
  if(kind==='imageFailure')h.sim.manual=[{images:[{embedded:false,embedError:'failed'}]}];
  await h.T.prepareDownload(rows,kind==='partial'?2:1,kind==='partial'?'failed':null);h.flush();
  assert.equal(h.sim.closed,0);assert.equal(h.sim.writes.length,0);assert.equal(h.node('confirmSaved').hidden,true);
  assert.equal(h.sim.downloads,1);assert.equal(h.node('download').disabled,false);
});
await test('navigation, replacement document, missing owner or frame cannot be closed',async()=>{
  for(const change of [h=>h.w.location.href='https://example.invalid/',h=>h.context.document={},h=>h.w.opener=null,h=>h.w.top={}]){
    const h=harness();await h.T.run();change(h);h.node('confirmSaved').click();assert.equal(h.sim.closed,0);
  }
});
await test('capture failure and initial page failure remain open',async()=>{
  for(const opt of [{revealError:true},{missingDoc:true}]){const h=harness(opt);await h.T.run();h.flush();assert.equal(h.sim.closed,0);assert.equal(h.sim.writes.length,0);}
});
await test('stale prepared object cannot save a newer batch',async()=>{
  const h=harness();await h.T.prepareDownload(rows,1);const old=h.T.prepared;
  await h.T.prepareDownload(rows,2,'partial');const n=h.sim.downloads;await h.T.savePrepared(old);h.flush();assert.equal(h.sim.downloads,n);assert.equal(h.sim.closed,0);
});
console.log(`${count} tests passed`);
