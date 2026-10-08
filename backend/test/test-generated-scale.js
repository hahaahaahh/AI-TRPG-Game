import assert from 'node:assert/strict';
import {fixture} from './fixtures/generated-case.js';
import {INVESTIGATION_LENGTHS,validateGeneratedScenario} from '../src/domain/GeneratedScenario.js';
import {GameSession} from '../src/domain/GameSession.js';
import {verifyScenarioRoutes} from '../src/services/ScenarioRouteValidator.js';
import {exerciseFullCase} from './fixtures/full-case-behaviors.js';
const id=(p,i)=>`${p}_${String(i+1).padStart(3,'0')}`;
for(const [theme,names,method,graph] of [
  ['历史商行',['柜台','货栈','账房','商会','码头','钱庄','报关处','驿站'],'抄录','star'],
  ['空间站',['接驳舱','数据室','配额中心','维修舱','中继站','货运舱','医疗舱','指挥室'],'复制','ring'],
  ['非恐怖奇幻',['行会','作坊','市集','议事厅','印章库','水闸','档案塔','码头'],'拓印','chain'],
]) for(const [length,limits] of Object.entries(INVESTIGATION_LENGTHS)) {
  const d=fixture();d.title=`${theme}路线测试`;d.hiddenTruth=theme==='历史商行'?'掌柜用重复运单骗取货款。':theme==='空间站'?'调度员伪造身份转卖配额。':'管事复制行会印章隐匿水税。';
  d.locations=Array.from({length:limits.locations},(_,i)=>({id:id('loc',i),name:names[i],description:'有可核对的独立材料。',hazardous:false,connections:[]}));
  const link=(a,b)=>{if(!d.locations[a].connections.includes(id('loc',b)))d.locations[a].connections.push(id('loc',b));if(!d.locations[b].connections.includes(id('loc',a)))d.locations[b].connections.push(id('loc',a));};
  for(let i=1;i<limits.locations;i++)link(graph==='star'?0:i-1,i);if(graph==='ring')link(0,limits.locations-1);
  d.npcs=Array.from({length:limits.npcs},(_,i)=>({id:id('npc',i),name:`${theme}见证人${i+1}`,description:'知道自己经手的记录。',motivation:'保护自己的工作与声誉。',locationId:id('loc',i%limits.locations),companionIndex:null}));
  d.equipment=[{id:'item_001',name:theme==='空间站'?'只读数据端':'纸笔与取证材料',description:'用于保存可复核副本。',capabilities:['record_text']}];
  d.clues=Array.from({length:limits.clues},(_,i)=>({id:id('evidence',i),name:`${theme}记录${i+1}`,description:'保留了可以相互核对的编号。',keywords:[`记录${i+1}`],requires:graph==='chain'&&i>0&&i<limits.proofs?[id('evidence',i-1)]:[],components:[{
    id:'component_001',name:`记录${i+1}副本`,locationId:i%2?null:id('loc',i%limits.locations),npcId:i%2?id('npc',i%limits.npcs):null,
    needsCooperation:!!(i%2),capability:'record_text',action:`${method}${theme}记录${i+1}`,alternativeLocationId:i%2?id('loc',i%limits.locations):null,alternativeAction:i%2?`${method}${theme}记录${i+1}独立存根`:'',
  }]}));
  // Remaining clues are optional depth, not a requirement to prove every goal.
  d.proofs=Array.from({length:limits.proofs},(_,i)=>({id:id('fact',i),statement:`第${i+1}项经手记录可确认。`,evidenceIds:[id('evidence',i)]}));
  d.events=Array.from({length:limits.events},(_,i)=>({...structuredClone(d.events[0]),id:id('event',i),title:`发展${i+1}`,kind:i===limits.events-2?'crisis':i===0?'warning':i===limits.events-1?'consolidation':'development',locationId:id('loc',i%limits.locations),participants:[id('npc',i%limits.npcs)],exposure:'none'}));
  assert.equal(validateGeneratedScenario(d,{length}).ok,true);
  const s=new GameSession({id:'scale',player:'姓名：调查员\nHP：12 SAN：60',investigationSetup:{mode:'guided',length,psychologicalPresentation:'stress'}});
  const result=await verifyScenarioRoutes(d,s);
  assert.equal(result.ok,true,`${theme}/${length}: ${result.reason}`);
  console.log(JSON.stringify({theme,length,locations:d.locations.length,clues:d.clues.length,events:d.events.length,routes:result.routes.map(r=>({actions:r.actions,states:r.states,witnessesUnavailable:r.unavailableWitnesses}))}));
  await exerciseFullCase(d,s.investigationSetup,result.routes[0]);
}
console.log('Nine distinct topology/theme/size route fixtures passed shared-rule search and real orchestrator replay.');
console.log('All 45 upper-size behavior playthroughs completed with bounded finales.');
