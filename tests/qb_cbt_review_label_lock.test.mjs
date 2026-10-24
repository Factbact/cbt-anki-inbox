import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../qb_cbt_review_label_lock.user.js', import.meta.url),'utf8');
assert.match(source, /@version\s+0\.4\.5/);
assert.match(source, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/Factbact\/cbt-anki-inbox\/main\/qb_cbt_review_label_lock\.user\.js/);
assert.match(source, /id="unsure"/);
assert.match(source, /id="undo"/);

function browser(initialHistory={},mode='smart'){
 const data = new Map([
  ['qbCbtReviewLock.v1',JSON.stringify({mode,collapsed:false,learned:{triangle:null,wrong:null}})],
  ['qbCbtReviewLock.smartHistory.v1',JSON.stringify(initialHistory)]
 ]);
 const localStorage = {
   getItem(k){return data.has(k)?data.get(k):null;},
   setItem(k,v){data.set(k,String(v));},
   removeItem(k){data.delete(k);},
 };
 const pendingTimeouts = [];
 const simulation={selected:'○'};
 let text=source.replace('  function selectedEvaluation() {','  function selectedEvaluation() { return globalThis.__sim.selected;');
 text=text.replace('  function resolveCurrentCorrectness(q) {',"  function resolveCurrentCorrectness(q) { return {correct:true,source:'QBの結果表示'};");
 text=text.replace('  const findByLabel = (mode) => {','  const findByLabel = (mode) => { return {click(){globalThis.__sim.selected=mode;}, isConnected:true};');
 text=text.replace('  const selectedState = (el) => {','  const selectedState = (el) => { return false;');
 text=text.replace("  if (document.readyState === 'loading')", `  globalThis.__T={decideSmart,normalizeRecord,studyDay,getRecord,storeRecord,readSmartHistory,
    previousForQuestion, undoAutomatic, markUnsure,applySmart,refreshSmartInfo,
    get state(){return {history,operationNonce,lastAutomatic,answerContext}},
    setOperation(n){operationNonce=n;},setAnswerContext(o){answerContext=o;},setUndo(o){lastAutomatic=o;}};
  if (document.readyState === 'loading')`);
 const win={setTimeout(fn){pendingTimeouts.push(fn);return pendingTimeouts.length;},confirm(){return true}};
 const doc={readyState:'loading',addEventListener(){},querySelectorAll(){return []}};
 const loc={hostname:'cbt.medilink-study.com',pathname:'/quiz',href:'https://cbt.medilink-study.com/quiz?question_id=q123'};
 const context=vm.createContext({window:win,document:doc,localStorage,location:loc,Intl,Date,URL,console,structuredClone,__sim:simulation});
 vm.runInContext(text,context,{timeout:2000});
 return {T:context.__T,simulation,data,runTimeouts:()=>{while(pendingTimeouts.length)pendingTimeouts.shift()();},localStorage,location:loc};
}
const c=browser();
const {decideSmart:decide,studyDay,normalizeRecord} = c.T;
const record=(label,streak=0,lastCreditDay='')=>({label,streak,lastCreditDay});
const outputs={
 '◎':['◎','×'], '○':['○','×'], '△':['△','×'], '×':['△','×'], '未演習':['○','×']
};
for(const [label,[yes,no]] of Object.entries(outputs)){
 assert.equal(decide(record(label),true,'2026-10-24')?.label,yes,`${label}→正解`);
 assert.equal(decide(record(label),false,'2026-10-24')?.label,no,`${label}→不正解`);
}
let d=decide(record('×'),true,'2026-10-24');
assert.equal(d.label,'△');assert.equal(d.streak,1);assert.equal(d.lastCreditDay,'2026-10-24');
d=decide(d,true,'2026-10-24');assert.equal(d.streak,1,'same day must not gain additional credit');
d=decide(d,true,'2026-10-25');assert.equal(d.streak,2);
d=decide(d,true,'2026-10-26');assert.equal(d.label,'○');assert.equal(d.streak,0,'promoted after three distinct dates');
let z=decide(record('△',1,'2026-10-24'),false,'2026-10-24');
assert.equal(z.label,'×');assert.equal(z.streak,0);assert.equal(z.lastCreditDay,'2026-10-24');
z=decide(z,true,'2026-10-24');assert.equal(z.streak,0,'wrong then correct on same day cannot gain credit again');assert.equal(z.label,'△');
z=decide(z,true,'2026-10-25');assert.equal(z.streak,1);
assert.equal(studyDay(new Date('2026-10-24T14:59:59Z')),'2026-10-24');
assert.equal(studyDay(new Date('2026-10-24T15:00:01Z')),'2026-10-25');
assert.equal(decide({label:null},true,'2026-10-24'),null);
assert.equal(decide(record('○'),null,'2026-10-24'),null);
assert.equal(normalizeRecord({label:'△',streak:2,source:'自動判定'}).streak,0);
assert.equal(normalizeRecord({label:'△',streak:2}).legacyStreak,2);
assert.equal(normalizeRecord({schema:2,label:'△',streak:2,lastCreditDay:'2026-10-24'}).streak,2);
// Old history is still present with its old label, but the unverified streak is never added to new days.
const old=browser({q123:{label:'△',streak:2,source:'自動判定',updatedAt:123}});
assert.equal(old.T.getRecord('q123').label,'△');
assert.equal(old.T.getRecord('q123').streak,0);
assert.equal(old.T.getRecord('q123').legacyStreak,2);
assert.ok(old.data.has('qbCbtReviewLock.smartHistory.pre040.backup'));
// History undo restores exactly the previous record and QB on-screen selection, not the answer history.
const a=browser();
a.simulation.selected='○';
let task={q:'q123',mode:'smart',before:record('×'),until:Date.now()+3000,done:false,token:0};
assert.equal(a.T.applySmart(task),true);
assert.equal(a.simulation.selected,'△');
a.runTimeouts();
assert.equal(a.T.getRecord('q123').label,'△');
assert.equal(a.T.getRecord('q123').streak,1);
assert.ok(a.T.state.lastAutomatic);
a.T.undoAutomatic();a.runTimeouts();
assert.equal(a.simulation.selected,'○');
assert.equal(a.T.getRecord('q123'),null,'previous local record must be deleted');
assert.equal(a.T.state.lastAutomatic,null);
// User's low confidence: correct result must become triangle and its credit count reset.
const b=browser({q123:{schema:2,label:'△',streak:2,lastCreditDay:'2026-10-24',source:'自動判定',updatedAt:33}});
b.simulation.selected='○';b.T.setAnswerContext({q:'q123',correct:true});
b.T.markUnsure();b.runTimeouts();
assert.equal(b.simulation.selected,'△');
assert.equal(b.T.getRecord('q123').streak,0);
assert.equal(b.T.getRecord('q123').lastCreditDay,'2026-10-24');
assert.equal(b.T.state.answerContext,null);
// If outcome is wrong or unknown, confidence button cannot rewrite it.
const wrong=browser({q123:{schema:2,label:'×',streak:0,lastCreditDay:'',updatedAt:1}});
wrong.simulation.selected='×';wrong.T.setAnswerContext({q:'q123',correct:false});wrong.T.markUnsure();
assert.equal(wrong.simulation.selected,'×');
assert.equal(wrong.T.getRecord('q123').label,'×');
// Storage failures must not silently update the local history.
const fail=browser();
const oldSet=fail.localStorage.setItem;
fail.localStorage.setItem=()=>{throw Error('quota')};
assert.equal(fail.T.storeRecord('q123','△',1,'自動判定'),false);
assert.equal(fail.T.getRecord('q123'),null);
fail.localStorage.setItem=oldSet;

console.log('PASS: 10-pattern transition / 3 distinct study days / same-day cap / mistake reset / JST boundary / unknown safe-stop / legacy migration & backup / UI undo / low-confidence override / bad outcome safe-stop / localStorage error rollback');