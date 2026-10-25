import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
function functionSource(name){
 const start=source.indexOf(`  function ${name}(`);assert.ok(start>=0,name);
 const end=source.indexOf('\n  function ',start+1);assert.ok(end>start,name);
 return source.slice(start,end);
}
function setup(){
 let state={sessions:{s:{id:'s',subject:'テスト科目',automaticOverrides:{}}}};
 const sim={qbId:'1001',quiz:true,writes:0,messages:[]};
 const button={classList:{toggle(){}},textContent:'',disabled:false,title:''};
 const context=vm.createContext({
  shadow:{getElementById:()=>button},
  isQBQuizPage:()=>sim.quiz,
  getCurrentQuestionInfo:()=>({qbId:sim.qbId}),
  isAutomaticOverrideEnabledForQbId:qbId=>Boolean(state.sessions.s.automaticOverrides[qbId]),
  ensureActiveExerciseSession:()=>({id:'s'}),
  getExerciseState:()=>structuredClone(state),
  saveExerciseState:value=>{state=structuredClone(value);sim.writes++},
  getDraftReason:()=>'',consumeReasonAfterOverride(){},
  getSettings:()=>({}),location:{href:'https://example.invalid/quiz'},
  updateUI(){},toast:message=>sim.messages.push(message),Date
 });
 vm.runInContext(['setAutomaticOverrideForCurrentQuestion','addAutomaticOverrideForCurrentQuestion','removeAutomaticOverride','renderAutomaticOverrideButton'].map(functionSource).join('\n'),context);
 return {context,sim,button,state:()=>structuredClone(state)};
}
let count=0;
function test(name,fn){fn();count++;console.log('PASS',name)}
test('正解でも追加ボタンは折りたたみの外・固定フッターに配置',()=>{
 const button=source.indexOf('<button id="force-auto-current"');
 assert.ok(button>source.indexOf('<button id="capture-current"'));
 assert.ok(button<source.indexOf('<details id="inbox-card-options"'));
 assert.match(source,/bottom\.append\(save, forceAuto, forceAutoHelp\)/);
 assert.equal((source.match(/id="force-auto-current"/g)||[]).length,1);
 assert.match(source,/aria-describedby="force-auto-help"/);
});
test('1回のクリックで現在の問題だけを追加対象にする',()=>{
 const c=setup();c.context.addAutomaticOverrideForCurrentQuestion();
 assert.equal(c.sim.writes,1);
 assert.equal(c.state().sessions.s.automaticOverrides['1001'].forceAutomaticRegardlessOfLatestRating,true);
 assert.deepEqual(Object.keys(c.state().sessions.s.automaticOverrides),['1001']);
 c.context.renderAutomaticOverrideButton();assert.equal(c.button.disabled,true);assert.match(c.button.textContent,/指定済み/);
});
test('連続クリックでも指定解除・重複保存をしない',()=>{
 const c=setup();c.context.addAutomaticOverrideForCurrentQuestion();const original=c.state();
 c.context.addAutomaticOverrideForCurrentQuestion();assert.deepEqual(c.state(),original);assert.equal(c.sim.writes,1);
});
test('一覧の解除後にもう一度追加できる',()=>{
 const c=setup();c.context.addAutomaticOverrideForCurrentQuestion();c.context.removeAutomaticOverride('s','1001');
 c.context.renderAutomaticOverrideButton();assert.equal(c.button.disabled,false);assert.match(c.button.textContent,/＋/);
 c.context.addAutomaticOverrideForCurrentQuestion();assert.equal(c.sim.writes,3);
 assert.equal(c.state().sessions.s.automaticOverrides['1001'].forceAutomaticRegardlessOfLatestRating,true);
});
test('次の問題では未指定のボタンに戻る',()=>{
 const c=setup();c.context.addAutomaticOverrideForCurrentQuestion();c.sim.qbId='1002';c.context.renderAutomaticOverrideButton();
 assert.equal(c.button.disabled,false);c.context.addAutomaticOverrideForCurrentQuestion();assert.deepEqual(Object.keys(c.state().sessions.s.automaticOverrides),['1001','1002']);
});
test('QB ID不明では指定しない',()=>{
 const c=setup();c.sim.qbId=null;c.context.addAutomaticOverrideForCurrentQuestion();c.context.renderAutomaticOverrideButton();
 assert.equal(c.sim.writes,0);assert.equal(c.button.disabled,true);
});
test('QB問題画面以外では指定しない',()=>{
 const c=setup();c.sim.quiz=false;c.context.addAutomaticOverrideForCurrentQuestion();c.context.renderAutomaticOverrideButton();
 assert.equal(c.sim.writes,0);assert.equal(c.button.disabled,true);
});
console.log(`${count} tests passed`);
