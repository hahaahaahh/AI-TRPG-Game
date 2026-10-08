// Opt-in live API validation. Never included in test:all; uses existing profiles.
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { getLLMProfiles } from '../src/config/LLMConfig.js';
import { LLMProviderRegistry } from '../src/llm/LLMProviderRegistry.js';
import { GameOrchestrator } from '../src/orchestrator/GameOrchestrator.js';
import { RequestSessionRepository } from '../src/persistence/RequestSessionRepository.js';
import { generatedComponentAccess, canContactNpc } from '../../src/shared/GeneratedInvestigationRules.mjs';
import { scenarioProgressService } from '../src/services/ScenarioProgressService.js';
dotenv.config({quiet:true});
const registry = new LLMProviderRegistry(getLLMProfiles());
const profileId=process.argv[2];
if (!registry.has(profileId)) throw new Error('Requested profile is unavailable; no automatic provider substitution.');
const entry=registry.resolve(profileId);
const report={profileId,startedAt:new Date().toISOString(),world:profileId.startsWith('soclaas')?'1920年代商行账目调查，无超自然要素':'科幻空间站货运记录调查，无超自然要素',requests:[],turns:[],status:'running'};
const provider={async generate(request){const start=Date.now();try{const response=await entry.provider.generate(request);report.requests.push({flow:request.flowType,latencyMs:Date.now()-start});console.log(JSON.stringify({flow:request.flowType,latencyMs:Date.now()-start,requests:report.requests.length}));return response;}catch(error){report.requests.push({flow:request.flowType,latencyMs:Date.now()-start,error:error.message});throw error;}}};
let repo=new RequestSessionRepository(),engine=new GameOrchestrator({repository:repo,llmProvider:provider,llmProfileId:profileId});
let current=engine.createSession('标准引导调查实测');
current.phase='CHARACTER_SETTING';current.worldSettings=report.world;
current.player='姓名：陈安\n职业：独立调查员\nHP：12 SAN：60\n侦查：60 说服：60 闪避：55 图书馆使用：60 心理学：50 聆听：50';
current.npcs=[{id:'npc_000',name:'陈安',hp:12,maxHp:12,san:60,maxSan:60,importance:'player',visibility:'visible',status:'active'}];
current.investigationSetup={mode:'guided',length:'standard',psychologicalPresentation:'stress'};
function nextAction(s) {
  if(s.finaleState?.stage==='decision') return '最终决定：公开真相';
  const branch=s.scheduledEvents.find(e=>e.id===s.activeScene?.eventId)?.branches?.[s.activeScene?.branchKey];
  if(s.combat?.active || branch?.combatUpdate?.active) return '谈判争取带着已有记录脱身';
  for(const e of s.evidence.filter(e=>!e.secured)) {
    const clue=s.scenarioDefinition.clues.find(c=>c.id===e.id);
    for(const c of clue.components) {
      if(e.artifacts?.some(a=>a.component===c.id && a.custody==='player')) continue;
      const access=generatedComponentAccess(s,e.id,c.id);
      if(access.ok) return access.source==='alternative'?c.alternativeAction:c.action;
      if(c.npcId && canContactNpc(s,c.npcId) && !s.scenarioFlags.cooperation[c.npcId] && !s.scenarioFlags.failedApproaches[c.npcId]) return `说服${s.npcs.find(n=>n.id===c.npcId).name}同意合作`;
    }
  }
  const clue=s.scenarioDefinition.clues.find(c=>!s.evidence.some(e=>e.id===c.id) && c.requires.every(id=>s.evidence.some(e=>e.id===id)) && c.components.some(c=>c.locationId===s.playerLocationId || c.alternativeLocationId===s.playerLocationId || c.npcId && canContactNpc(s,c.npcId)));
  if(clue) return `调查${clue.name}`;
  const next=s.locations.find(l=>(s.scenarioRules.locationGraph[s.playerLocationId] || []).includes(l.id) && !s.scenarioFlags.investigation.visited.includes(l.id));
  return next?`进入${next.name}`:'调查当前现场';
}
const debug=log=>{if(log.type==='scenario_repair') console.log(JSON.stringify({generationRepair:log.content}));};
try {
  let response=await engine.openStory(current.id,{onDebug:debug});
  if(response.result.branch!=='SCENARIO_PREPARED') throw new Error(response.result.scenarioMessages.join('；'));
  repo=new RequestSessionRepository(response.session);engine=new GameOrchestrator({repository:repo,llmProvider:provider,llmProfileId:profileId});current=repo.findById(current.id);
  await engine.openStory(current.id,{onDebug:debug});
  for(let i=0;i<42 && current.finaleState?.stage!=='complete';i++) {
    repo=new RequestSessionRepository(current.toJSON());engine=new GameOrchestrator({repository:repo,llmProvider:provider,llmProfileId:profileId});current=repo.findById(current.id);
    let input=nextAction(current);
    if(report.turns.at(-1)?.input===input && report.turns.at(-1)?.branch==='CLARIFICATION') input='调查当前现场';
    const start=Date.now();response=await engine.handleMessage(current.id,input);
    for(let j=0;j<4 && current.pendingDiceFlow;j++) response=await engine.confirmDice(current.id);
    const truth=scenarioProgressService.evaluateTruth(current);
    const turn={input,branch:response.result.branch,actions:current.scenarioFlags.investigation.actions,latencyMs:Date.now()-start,hp:current.npcs[0].hp,san:current.npcs[0].san,secured:truth.securedEvidence,proof:truth.factCount,stage:current.finaleState?.stage,events:current.scheduledEvents.map(e=>({id:e.id,status:e.status})),excerpt:(response.result.parsed?.narration || '').slice(-350)};
    report.turns.push(turn);console.log(JSON.stringify(turn));
  }
  report.status=current.finaleState?.stage==='complete'?'complete':'incomplete';
  report.ending=current.endingState;
} catch(error){report.status='failed';report.error=error.message;console.log(JSON.stringify({error:report.error}));}
finally {
  report.elapsedMs=Date.now()-Date.parse(report.startedAt);
  await mkdir('../.player-runtime',{recursive:true});
  const path=`../.player-runtime/live-generated-${entry.provider.provider}.json`;
  await writeFile(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:path,status:report.status,requestCount:report.requests.length,elapsedMs:report.elapsedMs}));
}
