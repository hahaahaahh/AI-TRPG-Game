// Paid opt-in campaign: two matched cases/profile, six preparation calls/case,
// at most one playthrough/profile and ninety gameplay calls. No automatic resume.
import dotenv from 'dotenv';
import {mkdir,writeFile} from 'node:fs/promises';
import {getLLMProfiles} from '../src/config/LLMConfig.js';
import {LLMProviderRegistry} from '../src/llm/LLMProviderRegistry.js';
import {GameOrchestrator} from '../src/orchestrator/GameOrchestrator.js';
import {RequestSessionRepository} from '../src/persistence/RequestSessionRepository.js';
dotenv.config({quiet:true});
const id=process.argv[2],registry=new LLMProviderRegistry(getLLMProfiles());
if(!registry.has(id)) throw new Error('Unknown selected profile');
const entry=registry.resolve(id),report={id,startedAt:new Date().toISOString(),cases:[],gameplay:[]};
let playing=false,gameCalls=0;
const provider={async generate(r){if(playing&&gameCalls>=90) throw new Error('Live gameplay budget exhausted');if(playing) gameCalls++;return entry.provider.generate(r);}};
const worlds=['非恐怖历史商行：调查账目篡改与失踪货物，所有真相有现实原因。','非恐怖科幻空间站：调查货运身份伪造和生命维持配额盗用，无超自然现象。'];
const candidates=[];
for(const world of worlds) {
  let repo=new RequestSessionRepository(),engine=new GameOrchestrator({repository:repo,llmProvider:provider,llmProfileId:id}),s=engine.createSession('阶段生成实测');
  s.phase='CHARACTER_SETTING';s.worldSettings=world;s.player='姓名：陈安\nHP：12 SAN：60\n侦查：60 说服：60 闪避：60 图书馆使用：60';
  s.npcs=[{id:'npc_000',name:'陈安',hp:12,maxHp:12,san:60,maxSan:60,importance:'player',visibility:'visible',status:'active'}];
  s.investigationSetup={mode:'guided',length:'standard',psychologicalPresentation:'stress'};
  for(let i=0;i<6;i++) {
    const response=await engine.openStory(s.id);
    console.log(JSON.stringify({world,branch:response.result.branch,stage:s.scenarioPreparation?.stage,calls:s.scenarioPreparation?.calls,errors:s.scenarioPreparation?.errors}));
    if(['SCENARIO_PREPARED','SCENARIO_PAUSED','SCENARIO_PREPARATION_FAILED'].includes(response.result.branch)) break;
    repo=new RequestSessionRepository(structuredClone(response.session));engine=new GameOrchestrator({repository:repo,llmProvider:provider,llmProfileId:id});s=repo.findById(s.id);
  }
  report.cases.push({world,prepared:!!s.scenarioDefinition,preparation:s.scenarioPreparation});
  if(s.scenarioDefinition)candidates.push(s.toJSON());
}
const selected=candidates.find(s=>s.worldSettings===worlds[id.startsWith('deepseek')?1:0])||candidates[0];
if(selected) {
  playing=true;
  let repo=new RequestSessionRepository(structuredClone(selected)),engine=new GameOrchestrator({repository:repo,llmProvider:provider,llmProfileId:id}),s=repo.findById(selected.id);
  try {
    await engine.openStory(s.id);
    const path=selected.scenarioPreparation.routeVerification.routes[0].path;let pathIndex=0;
    for(let turn=0;turn<34 && s.finaleState?.stage!=='complete' && gameCalls<90;turn++) {
      const start=Date.now();let text,action;
      if(s.finaleState?.stage==='decision') text='最终决定：公开真相';
      else if(s.combat?.active||s.activeScene&&s.scheduledEvents.find(e=>e.id===s.activeScene.eventId)?.phase==='crisis') text='谈判争取脱身';
      else if(pathIndex<path.length){const a=path[pathIndex++];text=a.text;action={kind:a.kind,evidenceId:['preserve','investigate'].includes(a.kind)?a.targetId:undefined,locationId:a.kind==='move'?a.targetId:undefined,npcId:a.kind==='cooperate'?a.targetId:undefined,component:a.componentId};}
      else text='调查当前现场';
      let r=await engine.handleMessage(s.id,text,{action});
      for(let n=0;n<4&&s.pendingDiceFlow;n++)r=await engine.confirmDice(s.id);
      const row={turn,text,branch:r.result.branch,actions:s.scenarioFlags.investigation.actions,stage:s.finaleState?.stage,secured:s.evidence.filter(e=>e.secured).map(e=>e.id),hp:s.npcs[0].hp,san:s.npcs[0].san,latencyMs:Date.now()-start,narration:r.result.parsed?.narration,events:s.scheduledEvents.map(e=>({id:e.id,status:e.status}))};
      report.gameplay.push(row);console.log(JSON.stringify({...row,narration:undefined}));
      repo=new RequestSessionRepository(structuredClone(s.toJSON()));engine=new GameOrchestrator({repository:repo,llmProvider:provider,llmProfileId:id});s=repo.findById(s.id);
    }
    report.ending=s.endingState;report.completed=s.finaleState?.stage==='complete';
  }catch(error){report.gameError=error.message;}
}
report.gameCalls=gameCalls;report.finishedAt=new Date().toISOString();
await mkdir('../.player-runtime',{recursive:true});
const path=`../.player-runtime/live-staged-${entry.provider.provider}-${Date.now()}.json`;
await writeFile(path,JSON.stringify(report,null,2));
console.log(JSON.stringify({report:path,prepared:report.cases.map(c=>c.prepared),completed:report.completed||false,gameCalls}));
