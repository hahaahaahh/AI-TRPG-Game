// Browser-only QA controls, injected by the opt-in mock server, not bundled into the game.
import {sessionStore} from '/__test/store.js';
const panel=document.createElement('details');
panel.style.cssText='position:fixed;bottom:4px;right:4px;z-index:9999;background:white;color:black;padding:10px;max-width:440px;border:2px solid #666';
panel.innerHTML='<summary>测试工具（仅5188）</summary><label>准备延迟毫秒<input id="qa-prep-delay" type="number" value="0"></label><br><label>叙事延迟毫秒<input id="qa-narration-delay" type="number" value="0"></label><br><label>失败准备次数<input id="qa-failures" type="number" value="0"></label><br><label><input id="qa-distinct" type="checkbox">每次不同错误</label><br>';
const output=document.createElement('p');output.setAttribute('role','status');panel.append(output);
function button(label,fn){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{try{await fn();}catch(e){output.textContent=`测试结果：${e.name}: ${e.message}`;}};panel.append(b);}
let captured=null;
button('确认下一次当前测试会话删除',()=>{
  if(!captured || captured.id!==location.hash.slice(1))throw new Error('请先记录当前测试快照');
  const original=window.confirm;
  window.confirm=message=>{window.confirm=original;return String(message).startsWith('删除会话')&&captured.id===location.hash.slice(1)?true:original(message);};
  output.textContent='仅下一次当前快照会话的删除确认将由QA代答';
});
button('挂起后续模拟模型响应',async()=>{await fetch('/__test/hold',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"hold":true}'});output.textContent='后续模拟模型请求将挂起，直到手动释放';});
button('检查模拟请求',async()=>{output.textContent=JSON.stringify(await(await fetch('/__test/status')).json());});
button('释放挂起模拟响应',async()=>{await fetch('/__test/release',{method:'POST'});output.textContent='已释放模拟响应';});
button('应用模拟响应设置',async()=>{await fetch('/__test/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delayMs:panel.querySelector('#qa-prep-delay').value,narrationDelayMs:panel.querySelector('#qa-narration-delay').value,failures:panel.querySelector('#qa-failures').value,distinct:panel.querySelector('#qa-distinct').checked})});output.textContent='模拟设置已应用（无真实模型）';});
button('记录当前测试会话快照',async()=>{captured=await sessionStore.getSession(location.hash.slice(1));output.textContent=captured?`已记录测试快照：${captured.id}`:'没有当前记录';});
button('模拟迟到保存',async()=>{if(!captured)throw new Error('先记录测试快照');await sessionStore.saveSession(captured);output.textContent='快照保存成功';});
button('检查快照会话存储状态',async()=>{if(!captured)throw new Error('先记录测试快照');output.textContent=JSON.stringify({id:captured.id,exists:!!await sessionStore.getSession(captured.id),deleted:await sessionStore.isDeleted(captured.id)});});
button('使下一次写入事务失败',()=>{
  const original=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(names,mode,...args){
    const tx=original.call(this,names,mode,...args);
    if(mode==='readwrite' && Array.from(typeof names==='string'?[names]:names).includes('deletedSessions')){
      IDBDatabase.prototype.transaction=original;queueMicrotask(()=>tx.abort());
    }
    return tx;
  };
  output.textContent='下一次存档或删除事务将模拟失败';
});
document.body.append(panel);
