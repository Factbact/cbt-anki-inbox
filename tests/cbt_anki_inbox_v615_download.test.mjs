import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const s=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const bridge=s.slice(s.indexOf('  function attachQBManagedDownload('),s.indexOf('  function runQBExporterCode()'));
function setup(options={}){
  const sim={calls:[],...options},parent={},doc={};
  const child={opener:parent,closed:false,document:doc,location:{href:'about:blank'}};child.top=child;
  const context=vm.createContext({window:parent,Blob,Promise,JSON,GM_info:{scriptHandler:'Tampermonkey',version:'5.4.6226',downloadMode:'browser',...options.info},
    GM_download:options.noGrant?undefined:(args)=>{sim.calls.push(args);if(sim.throw)throw Error('permission');return {abort(){}}}});
  vm.runInContext(bridge,context);
  return {sim,parent,child,doc,context,attach:()=>context.attachQBManagedDownload(child,doc)};
}
const data={source:'QB',retrievedQuestions:22,questions:Array.from({length:22},()=>({})),manualCandidates:{included:4,candidates:[{},{},{},{}]}};
const filename='qb_22questions_with_answers_manual_4.json';
let count=0;async function test(name,fn){await fn();count++;console.log('PASS',name)}
await test('keeps original name/default directory and waits strictly for onload',async()=>{
  const h=setup(),fn=h.attach();let finished=false;const promise=fn(JSON.stringify(data),filename).then(x=>(finished=true,x));
  await Promise.resolve();assert.equal(finished,false);const req=h.sim.calls[0];
  assert.ok(req.url instanceof Blob);assert.equal(await req.url.text(),JSON.stringify(data));assert.equal(req.name,filename);assert.equal(req.saveAs,false);assert.equal(req.conflictAction,'uniquify');
  req.onload();assert.equal((await promise).completed,true);req.onerror({error:'not_succeeded'});
});
for(const error of ['not_enabled','not_whitelisted','not_permitted','not_supported','not_succeeded'])await test(`${error} rejects without success and permits explicit retry`,async()=>{
  const h=setup(),fn=h.attach(),p=fn(JSON.stringify(data),filename);h.sim.calls[0].onerror({error});await assert.rejects(p);h.sim.calls[0].onload();
  const p2=fn(JSON.stringify(data),filename);h.sim.calls[1].onload();assert.equal((await p2).completed,true);
});
await test('timeout and thrown start fail without completion',async()=>{
  const h=setup(),p=h.attach()(JSON.stringify(data),filename);h.sim.calls[0].ontimeout();await assert.rejects(p);
  const thrown=setup({throw:true});await assert.rejects(thrown.attach()(JSON.stringify(data),filename));
});
await test('no grant, native/disabled mode, wrong manager and pre-Blob versions cannot activate',()=>{
  for(const options of [{noGrant:true},{info:{downloadMode:'native'}},{info:{downloadMode:'disabled'}},{info:{scriptHandler:'Unknown'}},{info:{version:'5.3.0'}},{info:{version:'5.4.6225'}},{info:{version:''}}])assert.equal(setup(options).attach(),null);
  assert.equal(typeof setup({info:{version:'5.4.0'}}).attach(),'function');
});
await test('wrong window or replaced document cannot initiate a privileged download',async()=>{
  for(const change of [h=>h.child.opener={},h=>h.child.document={},h=>h.child.location.href='https://example.invalid',h=>h.child.closed=true,h=>h.child.top={}]){
    const h=setup(),fn=h.attach();change(h);await assert.rejects(fn(JSON.stringify(data),filename));assert.equal(h.sim.calls.length,0);
  }
});
await test('rejects mismatched filename, arbitrary payload/URL, and concurrent download',async()=>{
  const h=setup(),fn=h.attach();
  for(const [json,name] of [['https://example.invalid/x',filename],[JSON.stringify(data),'../x.json'],[JSON.stringify({...data,source:'other'}),filename],[JSON.stringify({...data,retrievedQuestions:20}),filename]])await assert.rejects(fn(json,name));
  assert.equal(h.sim.calls.length,0);const p=fn(JSON.stringify(data),filename);await assert.rejects(fn(JSON.stringify(data),filename));h.sim.calls[0].onload();await p;
});
console.log(`${count} bridge tests passed`);
