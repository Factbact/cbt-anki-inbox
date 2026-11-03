// ==UserScript==
// @name         QB AI解説ブリッジ（プレビュー版）
// @namespace    https://local.tools/qb-ai-chatgpt-bridge
// @version      0.3.2
// @description  確認した1問をChatGPTへ入力・任意の自動送信。送信試行は1回だけ。本文をURLに含めない。
// @match        https://cbt.medilink-study.com/*
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @noframes
// @sandbox      DOM
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_openInTab
// ==/UserScript==

(() => {
  'use strict';
  const PREFIX='qb-ai-bridge.v2.';
  const TTL=5*60*1000, LIMIT=60000;
  const CHAT='https://chatgpt.com';
  const NONCE=/^[a-f0-9]{32}$/;
  const now=()=>Date.now();
  function validRecord(r,nonce) {
    return r&&r.schema===2&&r.nonce===nonce&&NONCE.test(nonce)&&['input','send'].includes(r.action)&&
      Number.isFinite(r.createdAt)&&Number.isFinite(r.expiresAt)&&
      r.createdAt<=now()+5000&&r.expiresAt>now()&&r.expiresAt-r.createdAt===TTL&&
      typeof r.prompt==='string'&&r.prompt.length>0&&r.prompt.length<=LIMIT;
  }
  function purge() {
    for(const key of GM_listValues().filter(k=>k.startsWith('qb-ai-bridge.v1.')||k.startsWith(PREFIX))) {
      const nonce=key.slice(PREFIX.length), r=GM_getValue(key,null);
      if(!validRecord(r,nonce))GM_deleteValue(key);
    }
  }
  function randomNonce() {return [...crypto.getRandomValues(new Uint8Array(16))].map(x=>x.toString(16).padStart(2,'0')).join('');}
  function visible(el) {
    if(!el?.isConnected || el.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    for(let n=el;n;n=n.parentElement) {const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||s.contentVisibility==='hidden'||Number(s.opacity)===0)return false;}
    return [...el.getClientRects()].some(r=>r.width>0&&r.height>0);
  }
  function qbBranch() {
    let busy=false;const recentlyStarted=new Map();
    function attach(){
      const panel=document.getElementById('qb-cbt-review-label-lock-host')?.shadowRoot;
      const button=panel?.getElementById('qb-ai-explain'),transfer=panel?.getElementById('qb-ai-oneclick-transfer'),statusNode=panel?.getElementById('qb-ai-oneclick-status');
      if(!button||!transfer||button.dataset.qbAiBridge==='oneclick-v1')return;
      button.dataset.qbAiBridge='oneclick-v1';
      const status=text=>{if(statusNode)statusNode.textContent=text;};
      button.addEventListener('click',async e=>{
        if(!e.isTrusted||busy)return;
        const id=transfer.dataset.requestId;
        if(!NONCE.test(id||'')||transfer.dataset.state!=='reading')return;
        busy=true;let key;
        const finish=()=>{if(transfer.dataset.requestId===id){transfer.textContent='';transfer.dataset.state='consumed';transfer.dispatchEvent(new Event('qb-ai-transfer-finished'));}busy=false;};
        try{
          const deadline=now()+10000;
          while(now()<deadline&&transfer.isConnected&&transfer.dataset.requestId===id&&transfer.dataset.state==='reading')await new Promise(resolve=>setTimeout(resolve,100));
          if(!/^\/quiz(?:\/|$)/.test(location.pathname)||!transfer.isConnected||transfer.dataset.requestId!==id||transfer.dataset.state!=='ready')return;
          if(transfer.dataset.action!=='send')throw new Error('送信の指定を確認できません。');
          const before=transfer.textContent;transfer.dataset.validatedRequest='';
          const check=new Event('qb-ai-before-transfer',{cancelable:true});if(!transfer.dispatchEvent(check))return;
          if(transfer.dataset.validatedRequest!==id||transfer.dataset.requestId!==id||transfer.dataset.state!=='ready'||transfer.textContent!==before)throw new Error('現在問の再確認応答が一致しません。');
          const prompt=transfer.textContent;
          if(typeof prompt!=='string'||!prompt.trim()||prompt.length>LIMIT)throw new Error('依頼文が空か長すぎます。');
          for(const [text,until] of recentlyStarted)if(until<=now())recentlyStarted.delete(text);
          if(recentlyStarted.has(prompt)){status('同じ依頼は既に開始しています。二重送信防止のため5分間は再開始しません。開いたChatGPTタブを確認してください。');return;}
          purge();const nonce=randomNonce(),createdAt=now();key=PREFIX+nonce;
          GM_setValue(key,{schema:2,nonce,action:'send',createdAt,expiresAt:createdAt+TTL,prompt});
          recentlyStarted.set(prompt,createdAt+TTL);
          GM_openInTab(CHAT+'/#qb-ai='+nonce,{active:true,insert:true,setParent:false});
          setTimeout(()=>GM_deleteValue(key),TTL);
          status('ChatGPTタブを開くよう依頼しました。入力・送信を1回だけ進め、不明な結果は自動再送しません。');
        }catch(err){if(key)try{GM_deleteValue(key);}catch(_){}status('受け渡しを停止しました。'+err.message+' 開いたタブがないか確認してください。');}
        finally{finish();}
      });
    }
    setInterval(attach,500);attach();
  }
  const rootRoute=()=>location.origin===CHAT&&location.pathname==='/'&&location.search==='';
  const textOf=el=>el instanceof HTMLTextAreaElement?el.value:el.innerText;
  const normalize=value=>String(value||'').replace(/\r\n/g,'\n');
  function composer() {
    const found=[...document.querySelectorAll('textarea#prompt-textarea,div#prompt-textarea[contenteditable="true"]')].filter(visible);
    if(found.length!==1)return null;const el=found[0];
    if(el.disabled||el.readOnly||el.getAttribute('aria-disabled')==='true'||el.closest('fieldset[disabled]'))return null;
    return el;
  }
  function sendTarget(el,prompt) {
    if(!rootRoute()||location.hash!==''||!el.isConnected||composer()!==el||normalize(textOf(el))!==normalize(prompt))throw new Error('画面または入力内容が変わったため送信を止めました。');
    if([...document.querySelectorAll('[data-message-author-role],article[data-testid^="conversation-turn"],button[data-testid="stop-button"]')].some(visible))throw new Error('既存の会話または生成中の表示があるため送信しません。');
    const form=el.closest('form');if(!form)throw new Error('入力欄に対応する送信フォームを確認できません。');
    const attachments='img,canvas,video,audio,[data-testid*="file-thumbnail"],[data-testid*="attachment-preview"],[data-testid*="uploaded-file"],[data-testid*="upload-preview"],[data-state="uploading"],button[aria-label*="Remove file"],button[aria-label*="ファイルを削除"]';
    if([...form.querySelectorAll(attachments)].some(visible)||[...form.querySelectorAll('input[type="file"]')].some(n=>n.files?.length))throw new Error('既存の添付・アップロードを検出したため送信しません。');
    const buttons=[...form.querySelectorAll('button[data-testid="send-button"]')].filter(visible);
    if(buttons.length>1)throw new Error('送信ボタンが複数あるため送信しません。');
    if(buttons.length===0)return null;
    const button=buttons[0];if(button.disabled||button.getAttribute('aria-disabled')==='true'||button.closest('fieldset[disabled]'))return null;
    return {form,button};
  }
  function acknowledgedPrompt(prompt) {
    return [...document.querySelectorAll('[data-message-author-role="user"]')].filter(visible)
      .some(el=>normalize(el.innerText)===normalize(prompt));
  }
  async function chatBranch(nonce) {
    const claim=()=>{const key=PREFIX+nonce,r=GM_getValue(key,null);if(!validRecord(r,nonce)){GM_deleteValue(key);return null;}GM_deleteValue(key);return r;};
    const autoAllowed=Boolean(navigator.locks?.request);
    const record=autoAllowed?await navigator.locks.request(PREFIX+nonce,claim):claim();
    if(!rootRoute()||location.hash!=='#qb-ai='+nonce)return;
    history.replaceState(history.state,'',location.pathname+location.search);
    let prompt=record?.prompt||'',expiresAt=record?.expiresAt||now(),busy=false,inserted=false,cancelled=false,attempted=false,sendAttempted=false,autoSendStopped=false;
    const action=record?.action||'input';
    const host=document.createElement('div');host.id='qb-ai-bridge-receiver';host.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483640;width:min(460px,94vw)';
    const sh=host.attachShadow({mode:'open'});
    sh.innerHTML=`<style>:host{font:13px/1.5 system-ui,sans-serif;color:#172033}section{padding:16px;background:#fff;border:1px solid #94a3b8;border-radius:12px;box-shadow:0 8px 32px #0003}h3{margin:0 0 8px}button{font:inherit;border:1px solid #94a3b8;border-radius:6px;background:#fff;padding:7px 10px;cursor:pointer}button:disabled{opacity:.5}textarea{box-sizing:border-box;width:100%;height:130px;margin:8px 0}p{margin:8px 0}[hidden]{display:none!important}</style>
      <section><h3>QBのAI解説</h3><p id="status" role="status" aria-live="polite"></p><textarea id="payload" aria-label="QBから受け取った依頼文" readonly></textarea>
      <button id="retry" type="button">空欄への入力を試す</button> <button id="copy" type="button">コピー</button> <button id="stop" type="button">自動操作を停止</button> <button id="close" type="button">閉じる</button></section>`;
    sh.getElementById('payload').value=prompt;document.body.append(host);const status=text=>{sh.getElementById('status').textContent=text;};
    if(action==='send')sh.getElementById('retry').textContent='空欄へ入力して送信を試す';
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    function clear(){cancelled=true;prompt='';sh.getElementById('payload').value='';sh.getElementById('retry').disabled=true;sh.getElementById('copy').disabled=true;}
    function stillValid(){return !cancelled&&prompt&&now()<expiresAt&&rootRoute()&&location.hash==='';}
    function stop(message){autoSendStopped=true;status(message);}
    async function autoSend(el) {
      if(action!=='send'||sendAttempted||autoSendStopped||cancelled)return;
      if(!autoAllowed)return stop('競合制御を利用できないため自動送信しません。入力内容を確認し、ChatGPTの送信ボタンを自分で押してください。');
      const deadline=Math.min(now()+10000,expiresAt);let target;
      try {
        while(now()<deadline&&!cancelled&&!autoSendStopped&&!sendAttempted) {
          target=sendTarget(el,prompt);
          if(target)break;
          await pause(250);
        }
        if(cancelled||autoSendStopped||sendAttempted)return;
        if(!target)return stop('送信ボタンが有効か確認できません。自動送信を停止しました。入力欄を確認してください。');
        await pause(300);
        if(!stillValid()||autoSendStopped||sendAttempted)return;
        const latest=sendTarget(el,prompt);
        if(!latest||latest.form!==target.form||latest.button!==target.button)return stop('送信欄が変わったため送信を止めました。');
        // The attempt flag is set BEFORE clicking. Uncertain outcome never triggers an automatic retry.
        sendAttempted=true;sh.getElementById('retry').disabled=true;
        status('送信ボタンを1回押します。反映を確認中です。');
        target.button.click();
        const confirmationDeadline=now()+15000;
        while(now()<confirmationDeadline&&!cancelled) {
          if(acknowledgedPrompt(prompt)){status('送信ボタンを1回操作し、同じ依頼文を会話画面で確認しました。回答やエラー表示をご確認ください。');return;}
          await pause(300);
        }
        if(!cancelled)status('送信操作を1回行いましたが、反映を確認できません。二重送信を避けるため自動再送しません。会話を確認してください。');
      } catch(err){stop((sendAttempted?'送信結果は不明です。自動再送しません。':'自動送信を停止しました。')+' '+err.message);}
    }
    async function insert() {
      if(busy||inserted||!stillValid())return;busy=true;
      try {
        const el=composer();if(!el){status('ChatGPTの入力欄を確認できません。ログインまたは表示完了後に再試行するか、コピーしてください。');return;}
        if(normalize(textOf(el))){attempted=true;stop('入力欄に既存の文章があります。上書き・自動送信しません。必要な場所へ手動で貼り付けてください。');return;}
        if(!stillValid())return;attempted=true;el.focus();
        if(!stillValid()||normalize(textOf(el))||composer()!==el||document.activeElement!==el)return;
        if(el instanceof HTMLTextAreaElement){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,prompt);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));}
        else if(!document.execCommand('insertText',false,prompt))throw new Error('このブラウザでは入力処理を利用できません。');
        await pause(250);
        if(rootRoute()&&el.isConnected&&composer()===el&&normalize(textOf(el))===normalize(prompt)){
          inserted=true;sh.getElementById('retry').disabled=true;
          if(action==='send'){status('入力を確認しました。送信ボタンを確認しています。');await autoSend(el);}
          else status('入力しました。まだ送信していません。内容と画像を確認して送信してください。');
        }else stop('入力の反映を確認できません。入力欄を確認してください。自動入力・送信を再試行しません。');
      }catch(err){stop(err.message+' 自動送信はせず、コピーを使用できます。');}
      finally{busy=false;}
    }
    sh.getElementById('retry').onclick=e=>{if(e.isTrusted)insert();};
    sh.getElementById('copy').onclick=async e=>{if(!e.isTrusted||!prompt||now()>=expiresAt)return;try{await navigator.clipboard.writeText(prompt);status('コピーしました。既に送信操作を行った場合は会話を確認してから使用してください。');}catch(_){status('上の依頼文を選択し、Ctrl+C / ⌘C でコピーしてください。');}};
    sh.getElementById('stop').onclick=()=>{autoSendStopped=true;cancelled=true;sh.getElementById('retry').disabled=true;status(sendAttempted?'送信操作は既に1回行っています。追加操作を止めました。会話をご確認ください。':'自動操作を停止しました。送信は行っていません。');};
    sh.getElementById('close').onclick=()=>{clear();host.remove();};window.addEventListener('pagehide',clear,{once:true});
    if(!record){status('受け渡しは期限切れ・使用済み、または見つかりません。QBからもう一度操作してください。');clear();return;}
    status(autoAllowed?(action==='send'?'空欄への入力後、送信ボタンを確認できた場合だけ1回送信します。':'ChatGPTの空の入力欄を待っています。送信はしません。'):'競合制御を利用できないため自動入力・自動送信を止めました。手動で入力・送信してください。');
    const deadline=now()+15000;
    const timer=setInterval(()=>{
      if(attempted||inserted||sendAttempted||autoSendStopped){clearInterval(timer);return;}
      if(!stillValid()){clearInterval(timer);status('受け渡し期限切れ、または画面が切り替わりました。QBからやり直してください。');clear();return;}
      if(now()>deadline){clearInterval(timer);status('入力欄を確認できません。ログイン後に再試行するか、コピーしてください。');return;}
      if(autoAllowed&&composer())insert();
    },400);
    setTimeout(()=>{clearInterval(timer);if(!inserted&&!sendAttempted)status('受け渡しの5分間の有効期限が切れました。QBからやり直してください。');clear();},Math.max(0,expiresAt-now()));
  }
  try {
    purge();
    if(location.hostname==='cbt.medilink-study.com')qbBranch();
    else if(rootRoute()){const match=/^#qb-ai=([a-f0-9]{32})$/.exec(location.hash);if(match)chatBranch(match[1]).catch(()=>{});}
  }catch(_){ /* Denied GM permission must not break the underlying site. */ }
})();
