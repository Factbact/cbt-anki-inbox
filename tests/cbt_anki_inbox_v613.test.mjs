import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const exporter=JSON.parse(source.match(/const QB_EXPORTER_CODE = (".*");/)[1]);
function harness(options={}) {
  const sim={closed:0,downloads:0,messages:[],writes:[],aborts:0,timers:new Map(),seq:0,pickerCalls:0,docReads:0,manual:[],...options};
  const nodes=new Map();
  function node(id) {
    if(!nodes.has(id))nodes.set(id,{checked:id==='autoClose',hidden:false,disabled:false,textContent:'',listeners:{},
      addEventListener(event,fn){this.listeners[event]=fn},click(){return this.onclick?.()??this.listeners.click?.()},remove(){}});
    return nodes.get(id);
  }
  const doc={body:{appendChild(){}},getElementById:node,createElement(){return {click(){if(sim.downloadError)throw Error('blocked');sim.downloads++},remove(){}}}};
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
  code=code.replace('    startButton.addEventListener(',`    globalThis.T={prepareDownload,run,savePrepared,scheduleAutoClose,cancelAutoClose,isOwnedExporter,
    get prepared(){return preparedSave},setHandle(h){saveHandle=h},setRunning(v){running=v},setStop(v){stopRequested=v}};\n    startButton.addEventListener(`);
  vm.runInContext(code+'\ncontrollerMain();',context);
  return {sim,node,w,doc,qb,context,T:context.T,handle,flush(){for(const [id,fn] of [...sim.timers]){sim.timers.delete(id);fn()}}};
}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS',name)}
const rows=[{qbId:'1'}];
await test('creates a fresh window and guards initialization cleanup',()=>{
  assert.match(exporter,/window.open\(\s*"about:blank",\s*"_blank"/);
  assert.ok(!exporter.includes('qb.close('));
  assert.match(exporter,/controller.document === ownedDocument/);
});
await test('normal completion writes selected file before scheduling close, leaves QB open',async()=>{
  const h=harness();await h.T.run();assert.equal(h.sim.pickerCalls,1);assert.equal(h.sim.writes.length,1);
  assert.equal(h.sim.downloads,0);assert.equal(h.sim.closed,0);assert.equal(h.sim.messages[0].filename,'chosen.json');
  assert.equal(h.sim.timers.size,1);h.flush();assert.equal(h.sim.closed,1);assert.equal(h.qb.closed,false);
});
await test('does not close or notify while write/flush is pending',async()=>{
  let release;const wait=new Promise(r=>release=r);const h=harness({closeWait:wait});h.T.setHandle(h.handle);
  const task=h.T.prepareDownload(rows,1);await new Promise(r=>setTimeout(r,0));
  assert.equal(h.sim.timers.size,0);assert.equal(h.sim.messages.length,0);assert.equal(h.node('start').disabled,true);
  await h.T.run();assert.equal(h.sim.pickerCalls,0);release();await task;assert.equal(h.sim.timers.size,1);
});
for(const failure of ['createError','writeError','closeError'])await test(`${failure}: leaves retryable data, does not notify or close`,async()=>{
  const h=harness({[failure]:true});h.T.setHandle(h.handle);await h.T.prepareDownload(rows,1);
  assert.equal(h.sim.messages.length,0);assert.equal(h.sim.timers.size,0);assert.equal(h.sim.closed,0);
  assert.equal(h.node('download').disabled,false);assert.equal(h.node('confirmSaved').hidden,true);
  if(failure!=='createError')assert.equal(h.sim.aborts,1);
  h.sim[failure]=false;await h.node('download').click();assert.equal(h.sim.downloads,1);assert.equal(h.sim.timers.size,0);assert.equal(h.node('confirmSaved').hidden,false);
});
await test('picker rejection/cancel does not begin QB acquisition or auto-close',async()=>{
  const h=harness({pickerError:true});await h.T.run();assert.equal(h.sim.docReads,0);assert.equal(h.sim.closed,0);assert.equal(h.sim.downloads,0);assert.equal(h.node('start').disabled,false);
});
await test('unsupported browser download request is not save completion',async()=>{
  const h=harness({unsupported:true});await h.T.prepareDownload(rows,1);h.flush();
  assert.equal(h.node('autoClose').disabled,true);assert.equal(h.sim.closed,0);assert.equal(h.sim.messages.length,0);assert.equal(h.sim.downloads,1);
  await h.node('download').click();assert.equal(h.sim.downloads,2);
  h.node('confirmSaved').click();assert.equal(h.sim.closed,1);assert.equal(h.sim.messages.length,1);
});
await test('blocked download retains retry and cannot confirm save',async()=>{
  const h=harness({unsupported:true,downloadError:true});await h.T.prepareDownload(rows,1);
  h.node('confirmSaved').click();assert.equal(h.sim.closed,0);assert.equal(h.node('confirmSaved').hidden,true);assert.equal(h.node('download').disabled,false);
});
for(const kind of ['partial','stopped','imageFailure'])await test(`${kind} never auto-closes even with a save handle`,async()=>{
  const h=harness();h.T.setHandle(h.handle);
  if(kind==='stopped')h.T.setStop(true);
  if(kind==='imageFailure')h.sim.manual=[{images:[{embedded:false,embedError:'failed'}]}];
  await h.T.prepareDownload(rows,kind==='partial'?2:1,kind==='partial'?'failed':null);h.flush();
  assert.equal(h.sim.closed,0);assert.equal(h.sim.writes.length,0);assert.equal(h.node('confirmSaved').hidden,true);
});
await test('cancel countdown or disable option prevents closing',async()=>{
  for(const useCheckbox of [false,true]){const h=harness();h.T.setHandle(h.handle);await h.T.prepareDownload(rows,1);
    if(useCheckbox){h.node('autoClose').checked=false;h.node('autoClose').listeners.change()}else h.node('cancelClose').click();
    h.flush();assert.equal(h.sim.closed,0);assert.equal(h.sim.timers.size,0);}
});
await test('restart cancels old timer even when next picker is cancelled',async()=>{
  const h=harness();await h.T.run();h.sim.pickerError=true;await h.T.run();h.flush();assert.equal(h.sim.closed,0);
});
await test('navigation, replacement document, missing owner or frame cannot be closed',async()=>{
  for(const change of [h=>h.w.location.href='https://example.invalid/',h=>h.context.document={},h=>h.w.opener=null,h=>h.w.top={}]){
    const h=harness();await h.T.run();change(h);h.flush();assert.equal(h.sim.closed,0);
  }
});
await test('capture failure and initial page failure remain open',async()=>{
  for(const opt of [{revealError:true},{missingDoc:true}]){const h=harness(opt);await h.T.run();h.flush();assert.equal(h.sim.closed,0);assert.equal(h.sim.writes.length,0);}
});
await test('stale prepared object cannot save or close a newer batch',async()=>{
  const h=harness();h.T.setHandle(h.handle);await h.T.prepareDownload(rows,1);const old=h.T.prepared;
  await h.T.prepareDownload(rows,2,'partial');await h.T.savePrepared(old,true);h.T.scheduleAutoClose(old);h.flush();assert.equal(h.sim.closed,0);
});
console.log(`${count} tests passed`);
