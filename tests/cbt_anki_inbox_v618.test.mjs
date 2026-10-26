import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../cbt_anki_inbox.user.js',import.meta.url),'utf8');
function fn(name){const a=source.indexOf(`  function ${name}(`),b=source.indexOf('\n  function ',a+1);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const c=vm.createContext({});
vm.runInContext(fn('fitFloatingRect')+'\n'+fn('resizeFloatingRect'),c);
let total=0;
function test(name,run){run();total++;console.log('PASS',name);}
test('スマホ・通常画面で保存済み幅を画面内に収める',()=>{
  for(const viewport of [280,320,390,768,1440])for(const width of [300,355,600,12000]){
    const rect=c.fitFloatingRect({left:16,top:140,width,height:500},viewport,800);
    assert.equal(rect.width,Math.min(viewport-24,Math.max(Math.min(300,viewport-24),width)));
    assert.ok(rect.left>=12 && rect.left+rect.width<=viewport-12);
  }
});
test('既存の8方向リサイズが幅・高さ制限と反対側の端を維持',()=>{
  const start={left:100,top:100,width:400,height:400};
  for(const edge of ['n','ne','e','se','s','sw','w','nw']){
    const rect=c.resizeFloatingRect(start,edge,40,30,1440,900);
    assert.equal(rect.width,edge.includes('e')?440:edge.includes('w')?360:400);
    assert.equal(rect.height,edge.includes('s')?430:edge.includes('n')?370:400);
    if(edge.includes('w'))assert.equal(rect.left+rect.width,500);
    if(edge.includes('n'))assert.equal(rect.top+rect.height,500);
  }
});
test('横長・通常・縦長画像のプレビューで原データと順序を維持',()=>{
  class Node {constructor(){this.children=[];this.listeners={};}set innerHTML(_){this.children=[];}appendChild(n){this.children.push(n);}addEventListener(k,f){this.listeners[k]=f;}}
  const images=[{width:12000,height:300,dataUrl:'data:image/png;base64,d2lkZQ=='},{width:640,height:480,src:'data:image/png;base64,bm9ybWFs'},{width:300,height:4000,dataUrl:'data:image/png;base64,dGFsbA=='}];
  const original=JSON.stringify(images),area=new Node();
  const context=vm.createContext({shadow:{getElementById:()=>area},document:{createElement:()=>new Node()},stagedImages:images});
  vm.runInContext(fn('renderImagePreviews'),context);context.renderImagePreviews();
  assert.deepEqual(area.children.map(w=>w.children[0].src),images.map(i=>i.dataUrl||i.src));
  assert.equal(JSON.stringify(images),original);
  area.children[1].children[1].listeners.click();
  assert.equal(images.length,2);assert.equal(images[0].width,12000);assert.equal(images[1].height,4000);
  assert.equal(area.children.length,2);
});
console.log(`${total} tests passed (VM only; no browser layout measurement)`);
