import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Buffer} from 'node:buffer';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const exporter=JSON.parse(source.match(/const QB_EXPORTER_CODE = (".*");/)[1]);
const clone=x=>JSON.parse(JSON.stringify(x));
function fn(name){const a=source.search(new RegExp(`^  (?:async )?function ${name}\\(`,'m')),b=source.slice(a+1).search(/\n  (?:async )?function /);assert.ok(a>=0&&b>=0,name);return source.slice(a,a+1+b);}
const candidate=(id='c1',session='s')=>({captureId:id,ankiId:'qb:0910328:manual:01',exerciseSessionId:session,rawText:'追加理由：勘で正解',captureReason:'勘で正解',sourceProblem:{qbId:'0910328'},images:[],automaticCardPolicy:'manual_only',savedAt:'2026-10-26T23:48:16Z'});
function inbox(initial=[candidate()]){
 let items=clone(initial);const sim={writes:0,messages:[]};
 class Node {constructor(){this.children=[];this.listeners={};}append(...n){this.children.push(...n);}appendChild(n){this.append(n);}set innerHTML(_){this.children=[];}addEventListener(k,f){this.listeners[k]=f;}}
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const c=vm.createContext({exportReceiptJobs:new Map(),crypto:{randomUUID:()=>`test-${++sim.seq}`},window:{},location:{origin:'https://cbt.medilink-study.com'},
  getItems:()=>clone(items),saveItems:value=>{items=clone(value);sim.writes++;},toast:m=>sim.messages.push(m),
  shadow:{getElementById:node},document:{createElement:()=>new Node()},getCurrentSessionItems:()=>clone(items.filter(i=>i.exerciseSessionId==='s')),formatLocalDateTime:x=>x,
  getActiveExerciseSession:()=>({id:'s'}),deleteCandidateByCaptureId(){},Date,console});sim.seq=0;
 vm.runInContext(['needsCandidateExport','countUnexported','candidateExportSignature','createExportReceipt','markItemsExportRequested','receiveExportRequest','buildCandidateCard','getEmptyCurrentCandidatesMessage','renderCurrentCandidateList'].map(fn).join('\n'),c);
 return {c,sim,node,items:()=>clone(items),edit:f=>{items=f(items)},receipt(){return c.createExportReceipt(c.getCurrentSessionItems(),{id:'s'});}};
}
function controller(manual=[],receipt=null,onMessage=()=>{}){
 const sim={fetches:[],responses:new Map(),downloads:[],messages:[],timers:new Map(),seq:0,closed:0,clickError:false};
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,textContent:'',addEventListener(){}});return nodes.get(id);};
 const doc={documentElement:{},body:{appendChild(){}},getElementById:node,createElement(){return {click(){if(sim.clickError)throw Error('download blocked');sim.downloads.push(this.download);},remove(){}};}};
 const qb={location:{href:'https://cbt.medilink-study.com/quiz',origin:'https://cbt.medilink-study.com'},closed:false,
  async fetch(url){sim.fetches.push(url);const r=sim.responses.get(url);if(r instanceof Error)throw r;return r || {ok:false,status:403};},
  postMessage(data,origin){sim.messages.push(data);onMessage({data,origin,source:w});}};
 const w={top:null,opener:qb,location:{href:'about:blank'},addEventListener(){},close(){sim.closed++;},__CBT_ANKI_MANUAL_CANDIDATES__:clone(manual),__CBT_ANKI_EXERCISE_SESSION__:{id:'s'},__CBT_ANKI_EXPORT_RECEIPT__:receipt};w.top=w;
 class Reader {readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result=`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;this.onload();},error=>{this.error=error;this.onerror();});}}
 const URLMock=class extends URL {static createObjectURL(){return 'blob:test';}};
 const c=vm.createContext({window:w,document:doc,console:{log(){}},Blob,URL:URLMock,FileReader:Reader,AbortController,
  setTimeout(f,ms){const id=++sim.seq;sim.timers.set(id,{f,ms});return id;},clearTimeout:id=>sim.timers.delete(id)});
 let code=exporter.slice(exporter.indexOf('  function controllerMain() {'),exporter.lastIndexOf('\n  try {\n    controller.eval'));
 code=code.replace('    startButton.addEventListener(',`    globalThis.T={captureQuestionImages,embedManualImage,prepareDownload,savePrepared,get prepared(){return preparedSave}};\n    startButton.addEventListener(`);
 vm.runInContext(code+'\ncontrollerMain();',c);
 return {sim,w,node,T:c.T,deliver:(data,source=w,origin=receipt?.origin)=>onMessage({data,source,origin})};
}
const rows=(images=[])=>[{qbId:'0910328',images}];
let count=0;async function test(name,f){await f();count++;console.log('PASS',name);}
await test('全問JSONの手動候補IDと要求通知が一致し保存完了にはしない',async()=>{
 const i=inbox(),h=controller(i.items(),i.receipt(),e=>i.c.receiveExportRequest(e));await h.T.prepareDownload(rows(),1);
 const payload=JSON.parse(await h.T.prepared.blob.text());assert.equal(payload.manualCandidates.included,1);assert.equal(payload.manualCandidates.candidates[0].ankiId,'qb:0910328:manual:01');
 assert.deepEqual(h.sim.downloads,['qb_1questions_with_answers_manual_1.json']);assert.equal(h.sim.messages.length,1);assert.equal(i.c.countUnexported(i.items()),0);
 assert.equal(i.items()[0].exportRequest.saveConfirmed,false);assert.equal(i.items()[0].exportedAt,undefined);assert.equal(payload.saveConfirmation,'unconfirmed');
 assert.equal(h.sim.messages[0].type,'CBT_ANKI_MANUAL_EXPORT_REQUESTED');assert.equal(i.items().length,1);
});
await test('要求済み候補は保持して折りたたみ履歴へ移し、未書き出しと分離',async()=>{
 const i=inbox([candidate(),candidate('c2')]),h=controller([i.items()[0]],i.receipt(),e=>i.c.receiveExportRequest(e));await h.T.prepareDownload(rows(),1);i.c.renderCurrentCandidateList();
 assert.equal(i.c.countUnexported(i.items()),1);assert.equal(i.items().length,2);assert.match(i.node('current-list-count').textContent,/保存未確認 1件/);
 const details=i.node('current-candidate-list').children.at(-1);assert.match(details.children[0].textContent,/候補は保持/);
 assert.match(details.children[1].children[0].children[0].children[2].children.at(-1).textContent,/保存未確認/);
});
await test('検知できるダウンロード例外時は通知せず候補を未書き出しのまま保持',async()=>{
 const i=inbox(),h=controller(i.items(),i.receipt(),e=>i.c.receiveExportRequest(e));h.sim.clickError=true;await h.T.prepareDownload(rows(),1);
 assert.equal(i.sim.writes,0);assert.equal(h.sim.messages.length,0);assert.equal(i.c.countUnexported(i.items()),1);assert.equal(h.T.prepared.requested,false);
 h.sim.clickError=false;await h.T.savePrepared(h.T.prepared);assert.equal(h.sim.messages.length,1);assert.equal(i.c.countUnexported(i.items()),0);
});
await test('未保存の準備段階・単体Exporterは追加箱状態を更新しない',async()=>{
 const i=inbox(),h=controller(i.items(),i.receipt(),e=>i.c.receiveExportRequest(e));await h.T.prepareDownload(rows(),1,null,false);assert.equal(i.sim.writes,0);
 const standalone=controller(i.items());await standalone.T.prepareDownload(rows(),1);assert.equal(standalone.sim.messages.length,0);
});
await test('出力後の編集・別演習・対象外ID・不正通知で候補を消費しない',async()=>{
 const i=inbox([candidate(),candidate('other','other-session')]);const receipt=i.receipt(),h=controller([candidate()],receipt);
 await h.T.prepareDownload(rows(),1);const data=h.sim.messages[0];
 for(const event of [{data,origin:'https://evil.invalid',source:h.w},{data:{...data,token:'bad'},origin:receipt.origin,source:h.w},{data:{...data,sessionId:'other-session'},origin:receipt.origin,source:h.w}])i.c.receiveExportRequest(event);
 assert.equal(i.sim.writes,0);i.edit(items=>items.map(x=>x.captureId==='c1'?{...x,rawText:'編集後'}:x));
 i.c.receiveExportRequest({data:{...data,candidates:[...data.candidates,{captureId:'other',imageErrors:0}]},origin:receipt.origin,source:h.w});assert.equal(i.sim.writes,0);assert.equal(i.items().length,2);
});
await test('通知元を固定し重複通知でも件数・IDを増やさず旧完了通知を無視',async()=>{
 const i=inbox(),receipt=i.receipt(),h=controller(i.items(),receipt,e=>i.c.receiveExportRequest(e));await h.T.prepareDownload(rows(),1);const data=h.sim.messages[0],before=i.items();
 i.c.receiveExportRequest({data:{...data,candidates:[{captureId:'c1',imageErrors:4}]},origin:receipt.origin,source:{}});assert.deepEqual(i.items(),before);
 i.c.receiveExportRequest({data:{type:'CBT_ANKI_MANUAL_EXPORT_COMPLETE',captureIds:['c1']},origin:receipt.origin,source:h.w});assert.deepEqual(i.items(),before);
 await h.T.savePrepared(h.T.prepared);assert.equal(i.items().length,1);assert.equal(i.items()[0].ankiId,before[0].ankiId);
});
await test('同一オリジン問題画像を原バイトで埋め込み、data画像も保持',async()=>{
 const h=controller(),url='https://cbt.medilink-study.com/CBT10523_Q001.jpg',bytes=new Uint8Array([255,216,7,8,255,217]);
 h.sim.responses.set(url,{ok:true,blob:async()=>new Blob([bytes],{type:'image/jpeg'})});
 const images=await h.T.captureQuestionImages({querySelectorAll:()=>[{currentSrc:url,alt:'問題図',naturalWidth:1200,naturalHeight:300},{currentSrc:url},{currentSrc:'data:image/png;base64,YWJj'}]},'https://cbt.medilink-study.com/quiz');
 assert.equal(images.length,2);assert.equal(h.sim.fetches.length,1);assert.equal(images[0].width,1200);assert.equal(images[0].src,url);assert.equal(images[0].embedded,true);
 assert.deepEqual([...Buffer.from(images[0].dataUrl.split(',')[1],'base64')],[...bytes]);assert.equal(images[1].dataUrl,'data:image/png;base64,YWJj');
 await h.T.prepareDownload(rows(images),1);const output=JSON.parse(await h.T.prepared.blob.text());assert.equal(output.questions[0].images[0].dataUrl,images[0].dataUrl);assert.equal(output.imageCapture.missing,0);
});
await test('403・外部URL・HTML応答を成功扱いせず拒否の再試行経路を使わない',async()=>{
 const h=controller(),url='https://cbt.medilink-study.com/denied.jpg';const denied=await h.T.embedManualImage({src:url});assert.equal(denied.embedded,false);assert.match(denied.embedError,/403/);assert.deepEqual(h.sim.fetches,[url]);
 const external=await h.T.embedManualImage({src:'https://images.invalid/CBT10523_Q001.jpg'});assert.equal(external.embedError,'external_image_not_embedded');assert.equal(h.sim.fetches.length,1);
 h.sim.responses.set(url,{ok:true,blob:async()=>new Blob(['login'],{type:'text/html'})});const html=await h.T.embedManualImage({src:url});assert.equal(html.embedError,'response_is_not_an_image');
});
await test('DOMにある画像のURLが未判明でも不足画像として残す',async()=>{
 const h=controller();const images=await h.T.captureQuestionImages({querySelectorAll:()=>[{getAttribute:()=>null,alt:'未読込の図'}]},'https://cbt.medilink-study.com/quiz');
 assert.equal(images.length,1);assert.equal(images[0].embedded,false);await h.T.prepareDownload(rows(images),1);const output=JSON.parse(await h.T.prepared.blob.text());assert.equal(output.imageCapture.missing,1);
});
await test('画像不足はJSONと候補に明示し、成功した再取得後も同じID・元データを保持',async()=>{
 const i=inbox(),h=controller(i.items(),i.receipt(),e=>i.c.receiveExportRequest(e)),url='https://cbt.medilink-study.com/image.jpg';
 const image=await h.T.embedManualImage({src:url});await h.T.prepareDownload(rows([image]),1);let payload=JSON.parse(await h.T.prepared.blob.text());assert.equal(payload.imageCapture.missing,1);assert.equal(payload.imageCapture.failures[0].src,url);
 assert.equal(i.c.countUnexported(i.items()),1);assert.equal(i.items()[0].exportRequest.imageErrors,1);assert.match(h.node('saveStatus').textContent,/画像1件が未取得/);
 h.sim.responses.set(url,{ok:true,blob:async()=>new Blob(['bytes'],{type:'image/png'})});const fixed=await h.T.embedManualImage({src:url});await h.T.prepareDownload(rows([fixed]),1);
 payload=JSON.parse(await h.T.prepared.blob.text());assert.equal(payload.imageCapture.missing,0);assert.equal(i.c.countUnexported(i.items()),0);assert.equal(i.items().length,1);assert.equal(i.items()[0].savedAt,candidate().savedAt);assert.equal(i.items()[0].exportedAt,undefined);
});
await test('部分取得は実際に収録した候補だけ通知し全演習を完了扱いにしない',async()=>{
 const missing={...candidate('c2'),sourceProblem:{qbId:'other'}};const i=inbox([candidate(),missing]),h=controller(i.items(),i.receipt(),e=>i.c.receiveExportRequest(e));await h.T.prepareDownload(rows(),21,'stopped');
 assert.equal(h.T.prepared.complete,false);assert.equal(h.sim.messages[0].candidates.length,1);assert.equal(i.c.countUnexported(i.items()),1);assert.equal(i.items()[1].exportRequest,undefined);
});
await test('古い遅延通知は新しい画像成功の記録を上書きしない',()=>{
 const i=inbox(),snapshot=i.items();i.c.markItemsExportRequested(snapshot,[{captureId:'c1',imageErrors:0}],{requestedAt:'2026-10-27T01:00:00Z',filename:'new.json',method:'merged_qb_json'});
 i.c.markItemsExportRequested(snapshot,[{captureId:'c1',imageErrors:2}],{requestedAt:'2026-10-27T00:00:00Z',filename:'old.json',method:'merged_qb_json'});assert.equal(i.items()[0].exportRequest.filename,'new.json');
});
await test('追加箱の記録失敗を通知し、候補を成功扱いしない',async()=>{
 const i=inbox(),h=controller(i.items(),i.receipt(),e=>i.c.receiveExportRequest(e));i.c.saveItems=()=>{throw Error('storage full');};
 await h.T.prepareDownload(rows(),1);assert.equal(i.c.countUnexported(i.items()),1);assert.match(i.sim.messages.at(-1),/記録・表示を確認できません/);
});
await test('手動JSONの同一オリジン403をGM経由で再試行せず、外部応答のHTMLも拒否',async()=>{
 let gmCalls=0;const c=vm.createContext({location:{href:'https://cbt.medilink-study.com/quiz',origin:'https://cbt.medilink-study.com'},URL,MAX_IMAGE_BYTES:8*1024*1024,
  fetch:async()=>({ok:false,status:403}),GM_xmlhttpRequest:opts=>{gmCalls++;opts.onload({status:200,response:new Blob(['login'],{type:'text/html'})});}});
 vm.runInContext(fn('imageToEmbeddedData'),c);
 const denied=await c.imageToEmbeddedData({src:'https://cbt.medilink-study.com/denied.jpg'});assert.match(denied.embedError,/403/);assert.equal(gmCalls,0);
 const html=await c.imageToEmbeddedData({src:'https://images.invalid/test.jpg'});assert.equal(html.embedded,false);assert.match(html.embedError,/response_is_not_an_image/);assert.equal(gmCalls,1);
});
await test('問題画像の収録経路をcaptureから呼び、閉じるタイマーと元の命名を維持',()=>{
 const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/qb_exporter_v619_contract.json',import.meta.url),'utf8'));
 assert.match(exporter,/images: await captureQuestionImages\(doc, url\)/);
 for(const name of ['cancelFallbackClose','isOwnedExporter','closeOwnedExporter','scheduleFallbackClose']){
  const extract=text=>{const a=text.indexOf(`    function ${name}(`),b=text.slice(a+1).search(/\n    (?:async )?function /);return text.slice(a,a+1+b);};
  assert.equal(extract(exporter),baseline.functions[name],name);
 }
 assert.match(exporter,/`qb_\$\{results.length\}questions_with_answers_manual_`/);
 assert.deepEqual(source.match(/^\/\/ @grant.*$/gm),baseline.grants);
});
console.log(`${count} tests passed (synthetic storage, DOM, image bytes and download events only)`);
