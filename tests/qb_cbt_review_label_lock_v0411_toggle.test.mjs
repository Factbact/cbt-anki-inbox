import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../qb_cbt_review_label_lock.user.js',import.meta.url),'utf8');

assert.match(source,/^\/\/ @version\s+0\.4\.11$/m);
assert.match(source,/id="assistToggle"[^>]*aria-pressed="false"/);
assert.match(source,/assistToggle\.setAttribute\('aria-pressed',String\(active\)\)/);
assert.match(source,/setMode\(config\.mode==='off' \? config\.lastActiveMode : 'off','quick-toggle'\)/);

function setup(saved={mode:'smart',collapsed:true,learned:{triangle:null,wrong:null}}) {
  const data=new Map([['qbCbtReviewLock.v1',JSON.stringify(saved)]]);
  const timers=new Map([[77,()=>{}]]),sim={cleared:[],saved:0,refreshes:0,lookups:0,messages:[]};
  let code=source;
  const stub=(signature,body)=>{
    assert.ok(code.includes(signature),`missing ${signature}`);
    code=code.replace(signature,signature+body);
  };
  stub('  function refreshUI() {','__sim.refreshes++;return;');
  stub("  function setInfo(message, type='neutral', state=null) {",'__sim.messages.push(message);return;');
  const resultSignature='  const hasResultUI = () => !findAnswerButton() && Boolean(ratingSurface() || qbVisibleHistoryRows().length);';
  assert.ok(code.includes(resultSignature));
  code=code.replace(resultSignature,'  const hasResultUI = () => false;');
  stub('  function startPreviousLookup(q,force=false) {','__sim.lookups++;return;');
  code=code.replace("  if (document.readyState === 'loading')",`  globalThis.T={setMode,get mode(){return config.mode},get last(){return config.lastActiveMode},
    get pending(){return pending},get scanTimer(){return scanTimer},get nonce(){return operationNonce},
    arm(){pending={q:'q1',mode:config.mode};scanTimer=77;}};
  if (document.readyState === 'loading')`);
  const window={clearTimeout(id){sim.cleared.push(id);timers.delete(id);},setTimeout(){return 88;}};
  const document={readyState:'loading',addEventListener(){},querySelectorAll(){return [];}};
  const location={hostname:'cbt.medilink-study.com',pathname:'/quiz',href:'https://cbt.medilink-study.com/quiz?question_id=q1'};
  const localStorage={getItem:k=>data.get(k)||null,setItem(k,v){sim.saved++;data.set(k,String(v));}};
  const context=vm.createContext({window,document,location,localStorage,URL,Intl,Date,structuredClone,console,__sim:sim});
  vm.runInContext(code,context,{timeout:2000});
  return {T:context.T,sim,data};
}

{
  const h=setup({mode:'wrong',collapsed:true,learned:{wrong:{path:'x'}}});
  assert.equal(h.T.last,'wrong','既存の有効モードを復帰先として扱う');
  h.T.arm();
  assert.equal(h.T.setMode('off','quick-toggle'),true);
  assert.equal(h.T.mode,'off');
  assert.equal(h.T.last,'wrong','OFFにしても固定モードを保持する');
  assert.equal(h.T.pending,null,'OFF切替で待機操作を破棄する');
  assert.equal(h.T.scanTimer,null,'OFF切替でスキャンタイマーを破棄する');
  assert.deepEqual(h.sim.cleared,[77]);
  const nonce=h.T.nonce;
  assert.equal(h.T.setMode('off','quick-toggle'),false,'連打で同じ状態を再起動しない');
  assert.equal(h.T.nonce,nonce);
  assert.equal(h.T.setMode(h.T.last,'quick-toggle'),true);
  assert.equal(h.T.mode,'wrong','1操作で直前モードへ復帰する');
  assert.equal(h.sim.lookups,0,'固定モード復帰でスマート履歴読取を起動しない');
  const persisted=JSON.parse(h.data.get('qbCbtReviewLock.v1'));
  assert.equal(persisted.mode,'wrong');
  assert.equal(persisted.lastActiveMode,'wrong');
}

{
  const h=setup({mode:'off',collapsed:false,learned:{}});
  assert.equal(h.T.last,'smart','旧設定のOFFは安全な既定のスマートモードで再開する');
  h.T.setMode(h.T.last,'quick-toggle');
  assert.equal(h.T.mode,'smart');
  assert.equal(h.sim.lookups,1,'スマート再開時だけ前回評価の読取を開始する');
  h.T.setMode('off','quick-toggle');
  assert.equal(h.T.last,'smart');
}

console.log('PASS: visible one-click toggle / prior-mode restore / OFF cancellation / rapid-click idempotence / persisted reload state');
