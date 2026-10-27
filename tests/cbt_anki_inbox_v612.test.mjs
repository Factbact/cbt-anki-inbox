import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
function fn(name){const a=source.indexOf(`  function ${name}(`);const b=source.indexOf('\n  function ',a+1);assert.ok(a>=0&&b>a,name);return source.slice(a,b);}
const clone=x=>JSON.parse(JSON.stringify(x));
function setup(initial=[]){
 let items=clone(initial),state={sessions:{s:{id:'s',automaticOverrides:{}}}};
 const sim={q:'1001',session:'s',quiz:true,fail:false,writes:0,seq:0,confirm:true,messages:[]};
 class Node{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.value='';this.textContent='';this.dataset={};this.attrs={};this.listeners={};this.classList={toggle(){}};}
  append(...nodes){this.children.push(...nodes)}appendChild(n){this.append(n)}
  set innerHTML(v){this.children=[]}get innerHTML(){return ''}
  setAttribute(k,v){this.attrs[k]=v}addEventListener(k,fn){this.listeners[k]=fn}focus(){}
 }
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)};
 node('subject').value='テスト科目';node('source').value='QB';node('division').value='臨床医学';
 const c=vm.createContext({exportReceiptJobs:new Map(),CAPTURE_REASONS:['勘で正解','知識不足','鑑別で迷った','画像を覚えたい'],stagedReason:'',stagedImages:[],questionEditor:null,questionListSignature:'',ITEMS_KEY:'items',
 shadow:{getElementById:node},document:{createElement:tag=>new Node(tag),createTextNode:text=>({textContent:text})},
 getItems:()=>clone(items),saveItems:value=>{if(sim.fail)throw Error('storage');items=clone(value);sim.writes++;},
 GM_setValue:(key,value)=>{if(sim.fail)throw Error('storage');items=clone(value);sim.writes++},
 getCurrentQuestionInfo:()=>({qbId:sim.q}),getActiveExerciseSession:()=>({id:sim.session}),ensureActiveExerciseSession:()=>({id:sim.session}),isQBQuizPage:()=>sim.quiz,
 getExerciseState:()=>clone(state),saveExerciseState:value=>{if(sim.fail)throw Error('storage');state=clone(value);sim.writes++},
 getAutomaticOverridesForSession:id=>Object.values(state.sessions[id]?.automaticOverrides||{}),
 getSettings:()=>({subject:'テスト科目'}),maybeAutoUpdateSubject(){},syncSettingsControls(){},saveSettings(){},openSettings(){},updateQuestionDisplay(){},renderImagePreviews(){},updateUI(){},formatLocalDateTime:x=>x,
 getNextManualAnkiId:()=>`qb:1001:manual:${++sim.seq}`,crypto:{randomUUID:()=>`capture:${sim.seq+1}`},
 toast:text=>sim.messages.push(text),confirm:()=>sim.confirm,location:{href:'https://example.invalid/quiz'},Date,console
 });
 const names=['needsCandidateExport','candidateExportSignature','createExportReceipt','markItemsExportRequested','getDraftReason','clearDraftReason','consumeReasonAfterOverride','renderReasonButtons','currentQuestionContext','candidateInContext','commitQuestionEdit','openQuestionEditor','renderQuestionCandidates','buildCandidateCard','buildAutomaticOverrideCard','updateOverrideReason','hasUnsavedDraft','saveDraftAsCandidates','deleteCandidateByCaptureId','setAutomaticOverrideForCurrentQuestion','getQBExporterCodeWithManualCandidates'];
 // Export code injection can be checked without executing its browser code.
 const embedded=source.split('\n').find(l=>l.includes('const QB_EXPORTER_CODE = '));
 c.QB_EXPORTER_CODE=JSON.parse(embedded.slice(embedded.indexOf(' = ')+3,-1));
 c.getCurrentSessionItems=()=>clone(items.filter(i=>i.exerciseSessionId===sim.session));
 c.getCurrentAutomaticOverrides=()=>Object.values(state.sessions[sim.session]?.automaticOverrides||{});
 vm.runInContext(names.map(fn).join('\n'),c);
 return {c,sim,node,items:()=>clone(items),setItems:x=>{items=clone(x)},state:()=>clone(state)};
}
const candidate=(id='a',q='1001',s='s')=>({captureId:id,ankiId:'qb:1001:manual:01',exerciseSessionId:s,sourceProblem:{qbId:q},rawText:'元の本文',images:[{dataUrl:'image1'},{dataUrl:'image2'}],savedAt:'original',exportedAt:'exported'});
let total=0;function test(name,run){run();total++;console.log('PASS',name)}
test('理由をワンタップ選択・解除し、選択状態を表示',()=>{
 const t=setup();t.c.renderReasonButtons();const b=t.node('capture-reasons').children[0];b.listeners.click();assert.equal(t.c.getDraftReason(),'勘で正解');assert.equal(b.attrs['aria-pressed'],'true');b.listeners.click();assert.equal(t.c.getDraftReason(),'');
});
test('理由だけでも次の問題への自動保存対象となる',()=>{
 const t=setup();t.c.stagedReason='鑑別で迷った';assert.equal(t.c.hasUnsavedDraft(),true);
 const result=t.c.saveDraftAsCandidates({autoSave:true});assert.equal(result.savedCount,1);assert.equal(t.items()[0].captureReason,'鑑別で迷った');assert.equal(t.items()[0].rawText,'追加理由：鑑別で迷った');assert.equal(t.c.stagedReason,'');
});
test('本文の複数行と画像・理由を同じ候補に保持',()=>{
 const t=setup();t.node('memory-text').value='本文1\n本文2';t.c.stagedReason='知識不足';t.c.stagedImages=[{dataUrl:'image'}];t.c.saveDraftAsCandidates();assert.equal(t.items().length,2);for(const item of t.items()){assert.equal(item.captureReason,'知識不足');assert.equal(item.images.length,1)}
});
test('自動カード指定にも理由を残し、理由だけの下書きを消費',()=>{
 const t=setup();t.c.stagedReason='勘で正解';t.c.setAutomaticOverrideForCurrentQuestion(true);assert.equal(t.state().sessions.s.automaticOverrides['1001'].captureReason,'勘で正解');assert.equal(t.c.stagedReason,'');
});
test('本文がある場合は自動カード指定後も下書きの理由を保持',()=>{
 const t=setup();t.c.stagedReason='知識不足';t.node('memory-text').value='書きかけ';t.c.setAutomaticOverrideForCurrentQuestion(true);assert.equal(t.c.stagedReason,'知識不足');
});
test('同じ演習・同じ問題だけを一覧表示し、他の候補を混ぜない',()=>{
 const t=setup([candidate(),candidate('b','1002'),candidate('c','1001','other')]);t.c.renderQuestionCandidates();assert.match(t.node('question-candidates-summary').textContent,/追加済み1件/);assert.equal(t.node('question-candidates-list').children.length,1);
});
test('本文・理由・画像を編集してもIDと保存日時を維持し、再書き出し対象に戻す',()=>{
 const original=candidate();const t=setup([original]);assert.equal(t.c.commitQuestionEdit(original,'修正した本文','画像を覚えたい',[1]),true);const item=t.items()[0];assert.equal(item.ankiId,original.ankiId);assert.equal(item.captureId,original.captureId);assert.equal(item.savedAt,'original');assert.equal(item.rawText,'修正した本文');assert.equal(item.captureReason,'画像を覚えたい');assert.equal(item.images[0].dataUrl,'image2');assert.equal(item.exportedAt,undefined);assert.equal(t.sim.seq,0);
});
test('内容を変えない保存は書き出し済み状態を維持',()=>{
 const original=candidate();const t=setup([original]);assert.equal(t.c.commitQuestionEdit(original,original.rawText,'',[0,1]),true);assert.equal(t.sim.writes,0);assert.equal(t.items()[0].exportedAt,'exported');
});
test('変更済み・別問題・別演習の候補への上書きを防ぐ',()=>{
 for(const change of ['item','q','session']){const original=candidate();const t=setup([original]);if(change==='item')t.setItems([{...original,rawText:'他の変更'}]);else if(change==='q')t.sim.q='1002';else t.sim.session='other';assert.equal(t.c.commitQuestionEdit(original,'変更','',[0]),false);assert.equal(t.sim.writes,0)}
});
test('保存エラーでも編集中の状態を維持',()=>{
 const original=candidate();const t=setup([original]);t.sim.fail=true;t.c.questionEditor={captureId:'a',context:{qbId:'1001',sessionId:'s'}};assert.equal(t.c.commitQuestionEdit(original,'変更','',[0]),false);assert.equal(t.c.questionEditor.captureId,'a');assert.deepEqual(t.items(),[original]);
});
test('編集中の再描画で入力を消さず、問題が変われば編集を閉じる',()=>{
 const t=setup([candidate()]);t.c.renderQuestionCandidates();const card=t.node('question-candidates-list').children[0];t.c.openQuestionEditor(candidate(),card);const editor=card.children.at(-1);editor.children[0].value='未保存';t.c.renderQuestionCandidates();assert.equal(card.children.at(-1).children[0].value,'未保存');t.sim.q='1002';t.c.renderQuestionCandidates();assert.equal(t.c.questionEditor,null);assert.equal(t.items()[0].rawText,'元の本文');
});
test('取り消し確認を断れば候補を維持、承認すれば対象だけ取り消す',()=>{
 const t=setup([candidate(),candidate('b')]);t.sim.confirm=false;t.c.deleteCandidateByCaptureId('a');assert.equal(t.items().length,2);t.sim.confirm=true;t.c.deleteCandidateByCaptureId('a');assert.deepEqual(t.items().map(i=>i.captureId),['b']);
});
test('自動カードの理由も現在の指定だけ更新可能',()=>{
 const t=setup();t.c.stagedReason='知識不足';t.c.setAutomaticOverrideForCurrentQuestion(true);const old=t.state().sessions.s.automaticOverrides['1001'];assert.equal(t.c.updateOverrideReason(old,'s','勘で正解'),true);assert.equal(t.state().sessions.s.automaticOverrides['1001'].captureReason,'勘で正解');assert.equal(t.c.updateOverrideReason(old,'s','画像を覚えたい'),false);
});
test('QB全問JSONへの受け渡しにも理由を保持',()=>{
 const t=setup([{...candidate(),captureReason:'知識不足'}]);const exported=t.c.getQBExporterCodeWithManualCandidates();const line=exported.split('\n').find(l=>l.includes('const INBOX_MANUAL_CANDIDATES = '));const values=JSON.parse(line.split(' = ')[1].slice(0,-1));assert.equal(values[0].captureReason,'知識不足');
});
test('理由だけの候補は編集後の理由と本文の表示が一致する',()=>{
 const item={...candidate(),rawText:'追加理由：知識不足',captureReason:'知識不足',images:[]};const t=setup([item]);
 assert.equal(t.c.commitQuestionEdit(item,item.rawText,'鑑別で迷った',[]),true);
 assert.equal(t.items()[0].rawText,'追加理由：鑑別で迷った');assert.equal(t.items()[0].captureReason,'鑑別で迷った');
});
test('横長・通常画像を候補保存とQB全問JSONで原データのまま保持',()=>{
 const t=setup();const images=[{width:12000,height:300,dataUrl:'data:image/png;base64,d2lkZQ=='},{width:640,height:480,dataUrl:'data:image/png;base64,bm9ybWFs'}];
 t.node('memory-text').value='画像の確認';t.c.stagedImages=clone(images);t.c.saveDraftAsCandidates();assert.deepEqual(t.items()[0].images,images);
 const exported=t.c.getQBExporterCodeWithManualCandidates();const line=exported.split('\n').find(l=>l.includes('const INBOX_MANUAL_CANDIDATES = '));
 const values=JSON.parse(line.split(' = ')[1].slice(0,-1));assert.deepEqual(values[0].images,images);
});
console.log(`${total} tests passed`);
