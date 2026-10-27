import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(process.argv[2] || new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
function fn(name){const a=source.search(new RegExp(`^  (?:async )?function ${name}\\(`,'m')),b=source.slice(a+1).search(/\n  (?:async )?function /);assert.ok(a>=0&&b>=0,name);return source.slice(a,a+1+b);}
class Node {
 constructor(){this.style={};this.children=[];this.listeners=new Map();this.dataset={};this.classes=new Set();this.classList={add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),contains:k=>this.classes.has(k)};}
 append(...nodes){this.children.push(...nodes);}appendChild(n){this.append(n);}insertBefore(n){this.children.unshift(n);}
 set innerHTML(_){this.children=[];}set textContent(v){this.text=String(v);this.children=[];}get textContent(){return this.text||'';}
 addEventListener(k,f){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(f);}removeEventListener(k,f){this.listeners.get(k)?.delete(f);}
 emit(k,e={}){for(const f of [...(this.listeners.get(k)||[])])f({button:0,isPrimary:true,pointerId:1,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},target:this,...e});}
 setAttribute(){}contains(n){return n===this||this.children.includes(n);}closest(s){return s==='[data-resize]'&&this.dataset.resize?this:null;}
 setPointerCapture(){}releasePointerCapture(){}getBoundingClientRect(){return {left:parseFloat(this.style.left)||0,top:parseFloat(this.style.top)||0,width:parseFloat(this.style.width)||0,height:parseFloat(this.style.height)||0};}
}
function layout({width=320,old={width:600,height:700},viewport=1000}={}){
 const saved=new Map([['legacy',clone(old)],['float',{left:20,top:120,width,height:500}]]),nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const panel=node('panel'),header=node('header'),window=new Node();window.innerWidth=viewport;window.innerHeight=900;
 const c=vm.createContext({window,document:{createElement:()=>new Node()},shadow:{getElementById:node},stagedImages:[],
  PANEL_GEOMETRY_KEY:'legacy',FLOAT_KEY:'float',disposeFloatingPanel:null,PANEL_DEFAULT_WIDTH:355,PANEL_MIN_WIDTH:300,PANEL_MIN_HEIGHT:320,PANEL_MARGIN:12,
  GM_getValue:(k,d)=>clone(saved.has(k)?saved.get(k):d),GM_setValue:(k,v)=>saved.set(k,clone(v)),
  fileToDataURL:async file=>file.dataUrl,extractImagesFromHTML:html=>html==='wide'?[{src:'data:image/png;base64,d2lkZQ==',width:12000,height:300}]:[],
  toast(){},maybeAutoUpdateSubject(){},updateQuestionDisplay(){},updateSettingsSummary(){},renderSaveDestination(){},renderExerciseSummary(){},renderQuestionCandidates(){},renderCurrentCandidateList(){},renderAutomaticOverrideButton(){},renderCurrentAutomaticOverrideList(){},renderExerciseHistory(){},appendTextToMemo(){},console});
 vm.runInContext(['getSavedPanelGeometry','clampPanelSize','applySavedPanelGeometry','fitFloatingRect','resizeFloatingRect','installFloatingPanel','stageImage','renderImagePreviews','openPanel','closePanel','handlePaste','handleDrop'].map(fn).join('\n'),c);
 c.applySavedPanelGeometry();c.installFloatingPanel(c.shadow,panel,header);
 const paste=files=>c.handlePaste({clipboardData:{files,getData:()=>''},preventDefault(){},stopPropagation(){}});
 return {c,panel,window,saved,node,paste};
}
const sessions={a:{id:'a',subject:'生化学',startedAt:'2026-10-25T00:00:00Z'},b:{id:'b',subject:'分子遺伝学'},c:{id:'c',subject:'生化学',startedAt:'2026-10-26T00:00:00Z'}};
const item=(id,s)=>({captureId:id,exerciseSessionId:s,rawText:'メモ',savedAt:'2026-10-25T01:00:00Z'});
function warnings(previous){
 let state=clone(previous?.state||{activeSessionId:'b',warningSessionId:'a',sessions}),items=clone(previous?.items||[item('a1','a'),item('c1','c')]);const sim={messages:[],writes:0,fail:false};
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const c=vm.createContext({EXERCISE_STATE_KEY:'state',GM_getValue:()=>clone(state),GM_setValue:(_,v)=>{if(sim.fail)throw Error('storage');state=clone(v);sim.writes++;},
  shadow:{getElementById:node},document:{createElement:()=>new Node()},getItems:()=>clone(items),getCurrentSessionItems:()=>clone(items.filter(i=>i.exerciseSessionId===state.activeSessionId)),
  getCurrentScopeKey:()=>`session:${state.activeSessionId}`,getAutomaticOverridesForSession:()=>[],getAutomaticOverridesForScope:()=>[],
  getCandidateGroups:()=>Object.values(state.sessions).map(s=>({scopeKey:`session:${s.id}`,meta:{sessionId:s.id,subject:s.subject,startedAt:s.startedAt},items:items.filter(i=>i.exerciseSessionId===s.id)})).filter(g=>g.items.length),
  buildCandidateCard:i=>({candidate:clone(i)}),formatLocalDateTime:x=>x,toast:m=>sim.messages.push(m),exportCandidateScope(){},Date});
 vm.runInContext(['getExerciseState','saveExerciseState','getItemsForSession','getActiveExerciseSession','isSessionCompleted','needsCandidateExport','countUnexported','sessionWarningSignature','isSessionWarningAcknowledged','setSessionWarningAcknowledged','renderExerciseSummary','renderExerciseHistory'].map(fn).join('\n'),c);
 c.updateUI=()=>{c.renderExerciseSummary();c.renderExerciseHistory();};c.updateUI();
 return {c,node,sim,state:()=>clone(state),items:()=>clone(items),snapshot:()=>({state:clone(state),items:clone(items)}),edit:f=>{items=f(items);},setWarning:id=>{state.warningSessionId=id;},ack(id){return c.setSessionWarningAcknowledged(id,true,c.sessionWarningSignature(c.getItemsForSession(id)));}};
}
let count=0;async function test(name,f){if(process.argv[3]&&!name.includes(process.argv[3]))return;await f();count++;console.log('PASS',name);}
await test('画像貼り付け直後も調整済み320pxを維持（旧版は600pxに拡大）',async()=>{
 const t=layout(),before=clone(t.panel.style),saved=clone([...t.saved]);await t.paste([{type:'image/png',dataUrl:'data:image/png;base64,d2lkZQ=='}]);
 assert.equal(t.panel.style.width,'320px');assert.deepEqual(t.panel.style,before);assert.deepEqual([...t.saved],saved);assert.equal(t.c.stagedImages.length,1);
});
await test('旧保存サイズがない場合も355pxへ戻らず、幅広/通常/複数画像で不変',async()=>{
 for(const width of [300,355,600]){const t=layout({width,old:{}}),before=clone(t.panel.style);for(const dataUrl of ['data:image/png;base64,d2lkZQ==','data:image/png;base64,bm9ybWFs'])await t.paste([{type:'image/png',dataUrl}]);assert.deepEqual(t.panel.style,before);assert.equal(t.c.stagedImages.length,2);}
});
await test('HTML画像貼付・ドロップ・開閉で現在の幅と原画像を保持',async()=>{
 const t=layout(),before=clone(t.panel.style);await t.c.handlePaste({clipboardData:{files:[],getData:type=>type==='text/html'?'wide':''},preventDefault(){},stopPropagation(){}});
 const original=clone(t.c.stagedImages);await t.c.handleDrop({dataTransfer:{files:[{type:'image/png',dataUrl:'data:image/png;base64,ZHJvcA=='}]},preventDefault(){},stopPropagation(){}});
 t.c.closePanel();t.c.openPanel();assert.deepEqual(t.panel.style,before);assert.deepEqual(clone(t.c.stagedImages[0]),original[0]);assert.equal(t.c.stagedImages.length,2);
});
await test('実際のリサイズ処理→貼付→再読込で新保存幅を保持',async()=>{
 const t=layout(),handle=new Node();handle.dataset.resize='e';t.panel.emit('pointerdown',{target:handle,clientX:340,clientY:150});t.window.emit('pointermove',{clientX:420,clientY:150});t.window.emit('pointerup');
 assert.equal(t.panel.style.width,'400px');assert.equal(t.saved.get('float').width,400);await t.paste([{type:'image/png',dataUrl:'data:image/png;base64,d2lkZQ=='}]);assert.equal(t.panel.style.width,'400px');
 const reloaded=layout({width:t.saved.get('float').width});assert.equal(reloaded.panel.style.width,'400px');
});
await test('狭い画面へのサイズ制限と既存リセット操作を維持',async()=>{
 const t=layout({width:600,viewport:320});assert.equal(t.panel.style.width,'296px');await t.paste([{type:'image/png',dataUrl:'data:image/png;base64,d2lkZQ=='}]);assert.equal(t.panel.style.width,'296px');
 t.window.innerWidth=1000;t.window.emit('resize');const reset=t.node('header').children.find(n=>n.id==='inbox-reset-position');reset.emit('click');assert.equal(t.panel.style.width,'380px');assert.equal(t.saved.get('float').width,380);
});
await test('生化学の警告ボタンで対象演習だけ対応済みにし候補・出力状態を維持',()=>{
 const t=warnings(),items=t.items(),other=t.state().sessions.c;const warning=t.node('previous-export-warning');assert.ok(warning.classes.has('show'));const button=warning.children[0];
 t.c.renderExerciseSummary();assert.equal(warning.children[0],button,'周期描画中にボタンを作り直さない');button.emit('click');assert.equal(warning.classes.has('show'),false);
 assert.deepEqual(t.items(),items);assert.deepEqual(t.state().sessions.c,other);assert.equal(t.state().sessions.a.completedAt,undefined);assert.equal(t.state().warningSessionId,'a');assert.ok(t.state().sessions.a.warningAcknowledgement);
 assert.equal(t.c.countUnexported(t.items()),2);
});
await test('Windows側で保存される状態を再読込しても警告を抑制し履歴から復元',()=>{
 const t=warnings();t.ack('a');const r=warnings(t.snapshot());assert.equal(r.node('previous-export-warning').classes.has('show'),false);
 const group=r.node('exercise-history').children.find(g=>g.children[0].textContent.includes('2026-10-25'));assert.match(group.children[0].textContent,/警告対応済み/);
 const undo=group.children[1].children.find(n=>n.textContent==='対応済みを取り消して警告を戻す');undo.emit('click');assert.equal(r.node('previous-export-warning').classes.has('show'),true);assert.equal(r.state().sessions.a.warningAcknowledgement,undefined);assert.deepEqual(r.items(),t.items());
});
await test('同じ科目名の別演習警告を隠さず、別警告が表示中の履歴操作も独立',()=>{
 const t=warnings();t.ack('a');t.setWarning('c');t.c.updateUI();assert.ok(t.node('previous-export-warning').classes.has('show'));t.c.setSessionWarningAcknowledged('a',false);assert.equal(t.state().warningSessionId,'c');assert.ok(t.node('previous-export-warning').classes.has('show'));
});
await test('新しい候補・編集・画像再取得失敗が増えるとその演習の警告を再表示',()=>{
 for(const kind of ['add','edit','image']){const t=warnings();t.ack('a');t.edit(items=>kind==='add'?[...items,item('a2','a')]:items.map(i=>i.captureId==='a1'?{...i,updatedAt:kind==='edit'?'2026-10-27T00:00:00Z':undefined,exportRequest:kind==='image'?{requestedAt:'2026-10-27T00:00:00Z',imageErrors:1}:undefined}:i));t.c.updateUI();assert.ok(t.node('previous-export-warning').classes.has('show'),kind);}
});
await test('古い警告ボタンでは新しい候補をまとめて対応済みにしない',()=>{
 const t=warnings(),old=t.node('previous-export-warning').children[0];t.edit(items=>[...items,item('new','a')]);old.emit('click');assert.equal(t.state().sessions.a.warningAcknowledgement,undefined);assert.match(t.sim.messages.at(-1),/候補が変わった/);assert.ok(t.node('previous-export-warning').classes.has('show'));
});
await test('保存失敗・存在しない演習は警告を閉じず、候補データも変更しない',()=>{
 const t=warnings(),before=t.snapshot();t.sim.fail=true;assert.equal(t.ack('a'),false);assert.equal(t.c.setSessionWarningAcknowledged('missing',true,'[]'),false);assert.deepEqual(t.snapshot(),before);assert.ok(t.node('previous-export-warning').classes.has('show'));
});
console.log(`${count} tests passed (actual paste/open/resize functions with synthetic DOM and storage; no Windows storage access)`);
