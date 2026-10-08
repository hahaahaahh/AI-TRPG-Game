import { GameSession } from '../domain/GameSession.js';
import { initializeGeneratedCase, prepareGeneratedAction, resolveGeneratedAction, validateGeneratedAction, advanceGenerated } from './GeneratedInvestigationRuntime.js';
import { generatedComponentAccess } from '../../../src/shared/GeneratedInvestigationRules.mjs';
import { scheduleService } from './ScheduleService.js';
import { enterAnnouncedDanger } from './InvestigationDirector.js';
import { withSimulationDice } from './DiceService.js';

// A conservative route witness, not a promise every player route succeeds.
// Searches with failed optional checks and independent witness alternatives.
export async function verifyScenarioRoutes(definition, source, { maxStates=100000, maxDurationMs=30000 }={}) {
  const deadline=performance.now()+maxDurationMs;
  const routes=[];
  const requiredIds=new Set(definition.proofs.flatMap(p=>p.evidenceIds));
  const includePrerequisites=id=>{for(const p of definition.clues.find(c=>c.id===id)?.requires || []) if(!requiredIds.has(p)){requiredIds.add(p);includePrerequisites(p);}};
  [...requiredIds].forEach(includePrerequisites);
  for(const unavailableWitnesses of [false,true]) {
    const initial=new GameSession({id:'route-check',player:source.player,npcs:structuredClone(source.npcs),worldSettings:source.worldSettings,
      keyCharacters:source.keyCharacters,scenarioSource:'generated',scenarioDefinition:definition,investigationSetup:source.investigationSetup});
    initializeGeneratedCase(initial);
    if(unavailableWitnesses) initial.npcs.filter(n=>n.id!=='npc_000').forEach(n=>n.status='departed');
    const needed=new Set(definition.proofs.flatMap(p=>p.evidenceIds));
    // Include prerequisites, but explore proof-relevant leads before optional ones.
    const core=new Set(needed);
    const expand=id=>{for(const prerequisite of definition.clues.find(c=>c.id===id)?.requires || []) if(!core.has(prerequisite)){core.add(prerequisite);expand(prerequisite);}};
    [...core].forEach(expand);
    const orderedClues=[...definition.clues].sort((a,b)=>Number(core.has(b.id))-Number(core.has(a.id)));
    const goal=s=>[...needed].every(id=>s.evidence.some(e=>e.id===id&&e.secured));
    const queue=new RouteQueue(score), seen=new Set(); let found=null, budgetLimited=false;
    queue.push({session:initial,path:[]});
    while(queue.length) {
      if(performance.now()>=deadline) return {ok:false,category:'search_exhaustion',reason:'路线验证时间预算耗尽，未验证',states:seen.size};
      // Prioritize productive routes. We prove existence, not shortest length.
      const {session:s,path}=queue.pop();
      const progress=s.scenarioFlags.investigation;
      const key=JSON.stringify([s.playerLocationId,progress.actions,progress.visited,s.evidence,s.scenarioFlags.cooperation,s.scenarioFlags.failedApproaches,
        s.npcs.map(n=>[n.id,n.locationId,n.status]),s.combat,s.activeScene?.eventId,s.scheduledEvents.map(e=>[e.id,e.status,e.announcedAction]),s.scenarioFlags.generatedEffects]);
      if(seen.has(key)) continue; seen.add(key);
      if(seen.size%100===0) await new Promise(resolve=>setImmediate(resolve));
      if(seen.size>maxStates || queue.length>20000) return {ok:false,category:'search_exhaustion',reason:'搜索预算耗尽，未验证',states:seen.size};
      if(goal(s) && progress.actions<s.scenarioRules.actionBudget) {found={path,actions:progress.actions,states:seen.size,unavailableWitnesses};break;}
      if(progress.actions>=s.scenarioRules.actionBudget-1) {budgetLimited=true;continue;}
      const candidates=[];
      if(s.combat?.active || s.activeScene && s.scheduledEvents.find(e=>e.id===s.activeScene.eventId)?.phase==='crisis') candidates.push({kind:'negotiate',targetId:'',componentId:'',text:'谈判争取脱身'});
      else {
        for(const clue of orderedClues) {
          if(!s.evidence.some(e=>e.id===clue.id)) candidates.push({kind:'investigate',targetId:clue.id,componentId:'',text:`调查${clue.name}`});
          else for(const c of clue.components) if(!s.evidence.find(e=>e.id===clue.id).artifacts?.some(a=>a.component===c.id&&a.custody==='player') && generatedComponentAccess(s,clue.id,c.id).ok)
            candidates.push({kind:'preserve',targetId:clue.id,componentId:c.id,text:`保全${clue.name}`});
        }
        for(const location of s.locations.filter(l=>l.id!==s.playerLocationId)) candidates.push({kind:'move',targetId:location.id,componentId:'',text:`进入${location.name}`});
      }
      for(const a of candidates) {
        if(!validateGeneratedAction(s,a.text,a).ok) continue;
        const next=new GameSession(structuredClone(s.toJSON()));
        scheduleService.prepareTurn(next,{userText:a.text}); enterAnnouncedDanger(next);
        next.scenarioFlags.actionProposal=a;
        try {
          const tx=prepareGeneratedAction(next,a.text);
          // Alternative routes cannot depend on a successful optional roll.
          if(!tx.resolved) {tx.checkResults=tx.checks.map(c=>({skill:c.skill_name||'SAN',success:false}));resolveGeneratedAction(next);}
          scheduleService.commitActiveScene(next);
          const tick=advanceGenerated(next);
          scheduleService.stageBoundaryEvent(next,tick.newlyEligibleEvents.map(e=>e.id||e));
          queue.push({session:next,path:[...path,{...a}]});
        } catch { /* Impossible transition is not a route. */ }
      }
    }
    if(!found) return {ok:false,category:budgetLimited?'route_budget':'route_blocked',reason:unavailableWitnesses?'证人不可用时没有预算内完整证明路线':'没有预算内完整证明路线',states:seen.size};
    routes.push(found);
  }
  for(const route of routes) {
    const replay=await replayRoute(definition,source,route);
    if(!replay.ok) return replay;
  }
  return {ok:true,routes,verification:'shared-rule-search-and-orchestrator-replay'};
  function score(s) {const p=s.scenarioFlags.investigation;return p.actions - s.evidence.reduce((sum,e)=>sum+((e.secured?6:2)+(e.artifacts?.length||0))*(requiredIds.has(e.id)?2:1),0);}
}

// Cache immutable queued-state priorities; sorting the entire frontier on every
// expansion made otherwise bounded searches take minutes on real model drafts.
class RouteQueue {
  constructor(score){this.items=[];this.score=score;this.sequence=0;}
  get length(){return this.items.length;}
  before(a,b){return a.priority<b.priority || a.priority===b.priority && a.sequence>b.sequence;}
  push(value){
    const node={value,priority:this.score(value.session),sequence:this.sequence++};
    const a=this.items;let i=a.length;a.push(node);
    while(i>0){const parent=(i-1)>>1;if(!this.before(node,a[parent]))break;a[i]=a[parent];i=parent;}a[i]=node;
  }
  pop(){
    const a=this.items,first=a[0],last=a.pop();
    if(a.length){let i=0;while(2*i+1<a.length){let child=2*i+1;if(child+1<a.length&&this.before(a[child+1],a[child]))child++;
      if(!this.before(a[child],last))break;a[i]=a[child];i=child;}a[i]=last;}
    return first.value;
  }
}

async function replayRoute(definition,source,route) {
  return withSimulationDice(async()=>{
    const {GameOrchestrator}=await import('../orchestrator/GameOrchestrator.js');
    const {RequestSessionRepository}=await import('../persistence/RequestSessionRepository.js');
    const current=new GameSession({id:'replay-route',phase:'STORY_PLAY',openingDone:true,player:source.player,npcs:structuredClone(source.npcs),worldSettings:source.worldSettings,
      scenarioSource:'generated',scenarioDefinition:definition,investigationSetup:source.investigationSetup});
    initializeGeneratedCase(current);
    if(route.unavailableWitnesses) current.npcs.filter(n=>n.id!=='npc_000').forEach(n=>n.status='departed');
    const repo=new RequestSessionRepository(current.toJSON());
    const model={async generate(request) {
      const s=repo.findById(current.id),scene=s.activeScene;
      if(request.flowType==='HISTORY_SUMMARY') return {content:JSON.stringify({summary:'机械路线验证。'})};
      if(request.flowType==='ENDING_GEN') throw new Error('验证期间不得提前结局');
      return {content:JSON.stringify({narration:'你核对本次行动的材料和环境变化，实际结果以规则记录为准。'.repeat(25),actions:null,npcs:[],locations:[],items:[],
        options:['A. 调查当前现场','B. 查看调查笔记','C. 调查当前现场','D. 自由行动'],evidence_changes:[],suspicion_delta:0,combat_update:null,current_location_id:s.playerLocationId,
        time_cost_minutes:0,time_cost_rationale:'规则验证',active_event_ack:scene?{event_id:scene.eventId,outcome:scene.outcome,incorporated:true,perceived_consequence:scene.playerCue}:null})};
    }};
    const engine=new GameOrchestrator({repository:repo,llmProvider:model});
    try {
      for(const a of route.path) {
        const action={kind:a.kind,evidenceId:['preserve','investigate'].includes(a.kind)?a.targetId:undefined,npcId:a.kind==='cooperate'?a.targetId:undefined,locationId:a.kind==='move'?a.targetId:undefined,component:a.componentId};
        const response=await engine.handleMessage(current.id,a.text,{action});
        if(response.result.branch==='CLARIFICATION') return {ok:false,reason:'路线搜索与实际行动验证不一致'};
        for(let i=0;i<4&&repo.findById(current.id).pendingDiceFlow;i++) await engine.confirmDice(current.id);
      }
      const s=repo.findById(current.id);
      return {ok:definition.proofs.every(p=>p.evidenceIds.every(id=>s.evidence.some(e=>e.id===id&&e.secured))) && s.scenarioFlags.investigation.actions<s.scenarioRules.actionBudget,reason:`编排器复演未在预算内证明全部事实：${JSON.stringify({actions:s.scenarioFlags.investigation.actions,evidence:s.evidence,path:route.path})}`};
    } catch(error) {return {ok:false,reason:`编排器复演失败：${error.message}`};}
  });
}
