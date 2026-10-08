import assert from 'node:assert/strict';
import {GameSession} from '../../src/domain/GameSession.js';
import {GameOrchestrator} from '../../src/orchestrator/GameOrchestrator.js';
import {RequestSessionRepository} from '../../src/persistence/RequestSessionRepository.js';
import {initializeGeneratedCase} from '../../src/services/GeneratedInvestigationRuntime.js';
import {withSimulationDice} from '../../src/services/DiceService.js';

export async function exerciseFullCase(definition,setup,route) {
  for(const behavior of ['complete-proof','exploratory','high-pressure','failed-check','noncompliant']) await withSimulationDice(async()=>{
    let s=new GameSession({id:`matrix-${behavior}`,phase:'STORY_PLAY',openingDone:true,scenarioDefinition:structuredClone(definition),scenarioSource:'generated',
      investigationSetup:setup,player:'姓名：测试调查员\nHP：12 SAN：60\n说服：60 闪避：60'});
    initializeGeneratedCase(s);
    if(behavior==='high-pressure')s.suspicion=9;
    let calls=0;
    const model={async generate(request){
      calls++;
      if(request.flowType==='ENDING_GEN')throw new Error('Mock forces deterministic closure');
      if(request.flowType==='HISTORY_SUMMARY')return{content:JSON.stringify({summary:'规则状态为准。'})};
      const scene=s.activeScene;
      return{content:JSON.stringify({narration:'你检查了当前可接触的材料，实际行动与资源结果以本轮规则记录为准。'.repeat(20),actions:null,npcs:[],locations:[],items:[],
        options:['A. 调查当前现场','B. 查看调查笔记','C. 调查当前现场','D. 自由行动'],current_location_id:s.playerLocationId,
        time_cost_minutes:0,time_cost_rationale:'',evidence_changes:[],suspicion_delta:0,combat_update:null,
        active_event_ack:scene&&behavior!=='noncompliant'?{event_id:scene.eventId,outcome:scene.outcome,incorporated:true,perceived_consequence:scene.playerCue}:null})};
    }};
    let routeIndex=0,submissions=0;
    // Route witnesses include safe revisits, which are free submissions rather than actions.
    while(s.finaleState?.stage!=='complete' && submissions<setupGate(setup)+route.path.length+8) {
      const repo=new RequestSessionRepository(structuredClone(s.toJSON()));s=repo.findById(s.id);
      const engine=new GameOrchestrator({repository:repo,llmProvider:model});
      let text='调查当前现场',action;
      if(s.finaleState?.stage==='decision')text='最终决定：公开真相';
      else if(behavior==='complete-proof' && routeIndex<route.path.length){
        const a=route.path[routeIndex++];text=a.text;action={kind:a.kind,evidenceId:['preserve','investigate'].includes(a.kind)?a.targetId:undefined,
          npcId:a.kind==='cooperate'?a.targetId:undefined,locationId:a.kind==='move'?a.targetId:undefined,component:a.componentId};
      } else if(s.combat?.active || s.activeScene && s.scheduledEvents.find(e=>e.id===s.activeScene.eventId)?.phase==='crisis')text='谈判争取脱身';
      else if(behavior==='exploratory' && submissions%3===0){
        const next=s.locations.find(l=>!s.scenarioFlags.investigation.visited.includes(l.id));
        if(next){text=`进入${next.name}`;action={kind:'move',locationId:next.id};}
      } else if(behavior==='failed-check') {
        const witness=s.npcs.find(n=>n.id!=='npc_000'&&n.locationId===s.playerLocationId&&!s.scenarioFlags.failedApproaches?.[n.id]);
        if(witness){text=`说服${witness.name}同意合作`;action={kind:'cooperate',npcId:witness.id};}
      }
      const response=await engine.handleMessage(s.id,text,{action});
      assert.notEqual(response.result.branch,'CLARIFICATION',`${definition.title}/${behavior}: ${JSON.stringify(response.result)}`);
      for(let j=0;j<5&&s.pendingDiceFlow;j++)await engine.confirmDice(s.id);
      assert(!s.pendingDiceFlow,'dice must terminate');submissions++;
    }
    assert.equal(s.finaleState?.stage,'complete',`${definition.title}/${behavior}`);
    assert(s.scenarioFlags.investigation.actions<=setupGate(setup)+3);
    assert.equal(s.optionBuffer,'');assert(!s.combat?.active);
    if(behavior==='complete-proof')assert(definition.proofs.every(p=>p.evidenceIds.every(id=>s.evidence.some(e=>e.id===id&&e.secured))));
    console.log(JSON.stringify({matrix:definition.title,length:setup.length,behavior,submissions,actions:s.scenarioFlags.investigation.actions,calls,secured:s.evidence.filter(e=>e.secured).length,ending:s.finaleState.stage}));
  });
}
function setupGate(setup){return {short:14,standard:26,long:38}[setup.length];}
