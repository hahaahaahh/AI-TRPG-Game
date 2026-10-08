import assert from 'node:assert/strict';
import { fixture, stagedFixture } from './fixtures/generated-case.js';
import { GameOrchestrator } from '../src/orchestrator/GameOrchestrator.js';
import { RequestSessionRepository } from '../src/persistence/RequestSessionRepository.js';
import { diceService } from '../src/services/DiceService.js';
import { scenarioProgressService } from '../src/services/ScenarioProgressService.js';
import { scheduleService } from '../src/services/ScheduleService.js';
import { state } from '../src/services/InvestigationDirector.js';
import { validateGeneratedAction } from '../src/services/GeneratedInvestigationRuntime.js';
import { interpretAction } from '../src/services/ActionInterpretationService.js';

let current, calls = 0;
const model = { async generate(request) {
  calls++;
  if (request.flowType === 'SCENARIO_GEN') return { content: JSON.stringify(stagedFixture(JSON.parse(request.messages[1].content).stage)) };
  if (request.flowType === 'HISTORY_SUMMARY') return { content: JSON.stringify({ summary: '调查继续，所有机械结果以引擎状态为准。' }) };
  if (request.flowType === 'ENDING_GEN') throw new Error('Mock ending failure: deterministic closure required');
  const scene = current.activeScene;
  return { content: JSON.stringify({ narration: '你查看眼前的材料，并记录本次行动已经确认的信息。'.repeat(25), actions:null,
    npcs:[],locations:[],items:[],options:['A. 调查当前现场','B. 查看调查笔记','C. 调查当前现场','D. 自由行动'],
    time_cost_minutes: 90, time_cost_rationale:'模型的时间不可信', evidence_changes:[],suspicion_delta:0,combat_update:null,current_location_id:current.playerLocationId || '',
    active_event_ack: scene ? {event_id:scene.eventId,outcome:scene.outcome,incorporated:true,perceived_consequence:scene.playerCue} : null }) };
} };
const originalRoll = diceService.rollWithBonusPenalty;
try {
  for (const [length, worldview, gate] of [['short','历史商行',14],['standard','太空殖民地',26],['long','非恐怖奇幻王国',38]]) for (const style of ['evidence','incomplete','failed-check']) {
    calls=0;
    let repo = new RequestSessionRepository();
    let engine = new GameOrchestrator({ repository:repo,llmProvider:model });
    current = engine.createSession('生成测试');
    current.phase = 'CHARACTER_SETTING'; current.player = '姓名：探员\nHP：12 SAN：60\n说服：60 闪避：60 侦查：60 图书馆使用：60';
    current.worldSettings = worldview; current.npcs = [{id:'npc_000',name:'探员',hp:12,maxHp:12,san:60,maxSan:60,importance:'player',status:'active',visibility:'visible'}];
    current.investigationSetup = {mode:'guided',length,psychologicalPresentation:'stress'};
    let preparation;
    for(let i=0;i<6;i++) { preparation=await engine.openStory(current.id); if(preparation.result.branch==='SCENARIO_PREPARED') break; }
    assert.equal(preparation.result.branch,'SCENARIO_PREPARED');
    assert.equal(current.openingDone,false);
    // Simulate browser persistence boundary and a new request-owned repository.
    repo = new RequestSessionRepository(preparation.session); engine = new GameOrchestrator({repository:repo,llmProvider:model}); current = repo.findById(current.id);
    await engine.openStory(current.id);
    assert.equal(current.openingDone,true);
    assert.equal(current.scenarioSource,'generated');
    assert.equal(current.scenarioRules.actionBudget,gate);
    assert.match(current.displayLog.at(-1).content,/引导调查/);
    const startingCalls=calls;
    const help=await engine.handleMessage(current.id,'查看调查笔记');
    assert.equal(help.result.branch,'NOTEBOOK'); assert.equal(calls,startingCalls);
    assert.equal(state(current).actions,0);
    assert.equal(validateGeneratedAction(current,'拍摄账册').ok,false,'discovery must precede preservation');
    diceService.rollWithBonusPenalty=()=>({value:style==='failed-check'?99:1});
    let submitted=0, routeIndex=0;
    const route=['调查账册','进入资料室','抄录账册','进入会客室'];
    while(current.finaleState?.stage!=='complete' && submitted<gate+8) {
      repo=new RequestSessionRepository(current.toJSON()); engine=new GameOrchestrator({repository:repo,llmProvider:model}); current=repo.findById(current.id);
      const danger = current.combat?.active || current.activeScene?.eventId === 'event_001';
      const input=current.finaleState?.stage==='decision' ? '最终决定：公开真相' : danger ? '谈判争取脱身' : style==='evidence' && routeIndex<route.length ? route[routeIndex++] : '调查当前现场';
      const buttonAction = input === '抄录账册' ? { kind:'preserve', evidenceId:'evidence_001', component:current.scenarioDefinition.clues[0].components[0].id } : undefined;
      let response=await engine.handleMessage(current.id,input,{action:buttonAction});
      assert.notEqual(response.result.branch,'CLARIFICATION',JSON.stringify(response.result));
      for(let i=0;i<4 && current.pendingDiceFlow;i++) response=await engine.confirmDice(current.id);
      submitted++;
    }
    assert.equal(current.finaleState?.stage,'complete',`${length}/${style}`);
    assert.ok(submitted<=gate+4,`bounded run: ${submitted}`);
    assert.equal(current.combat,null);
    assert.equal(current.optionBuffer,'');
    assert.doesNotMatch(current.displayLog.at(-1).content,/白桦|雾港|站外公路|未完待续/);
    const truth=scenarioProgressService.evaluateTruth(current);
    assert.equal(truth.factCount,style==='evidence'?1:0);
    const oldId=current.id,oldEnding=JSON.stringify(current.endingState);
    await assert.rejects(engine.handleMessage(oldId,'A'), /锁定|完成/);
    assert.equal(current.finaleState.stage,'complete');
    const replay=engine.restartStory(oldId).session;
    assert.notEqual(replay.id,oldId); assert.deepEqual(replay.scenarioDefinition,current.scenarioDefinition);
    assert.equal(JSON.stringify(current.endingState),oldEnding);
    const another=engine.restartStory(oldId,{regenerate:true}).session;
    assert.equal(another.scenarioDefinition,null);assert.equal(another.worldSettings,worldview);
    console.log(JSON.stringify({length,worldview,style,submitted,calls,actions:state(current).actions,events:current.scheduledEvents.map(e=>({id:e.id,status:e.status})),secured:truth.securedEvidence,proof:truth.factCount,finale:current.finaleState.stage}));
  }
  // A persisted combat flag that no model ever clears cannot exceed the gate budget.
  current.finaleState=null;current.endingState=null;current.subState='AWAITING_INPUT';current.finalChoice=null;current.scenarioClock.mode='normal';
  current.scenarioClock.currentTime='05:59';state(current).actions=current.scenarioRules.actionBudget-1;
  current.combat={active:true,participants:['npc_001'],objective:'脱离危险'};current.activeScene=null;current.scenarioFlags.finale_crisis_resolved=false;state(current).exchanges=0;
  const repo=new RequestSessionRepository(current.toJSON()), engine=new GameOrchestrator({repository:repo,llmProvider:model});current=repo.findById(current.id);
  diceService.rollWithBonusPenalty=()=>({value:99});
  const pre=current.toJSON();
  await engine.handleMessage(current.id,'谈判争取脱身');
  assert.ok(current.pendingDiceFlow);
  engine.cancelDice(current.id);
  assert.equal(state(current).actions,pre.scenarioFlags.investigation.actions);
  assert.equal(current.combat.active,true);
  for(let action=0;action<4 && current.finaleState?.stage!=='decision';action++) {
    await engine.handleMessage(current.id,'谈判争取脱身');
    for(let j=0;j<4 && current.pendingDiceFlow;j++) await engine.confirmDice(current.id);
  }
  assert.equal(current.finaleState.stage,'decision');
  assert.ok(current.finaleState.completedActions<=3);
  let interpretations=0;
  const proposal=await interpretAction(current,'某个含糊请求',{ async generate(){interpretations++;return{content:JSON.stringify({kind:'preserve',targetId:'evidence_999',componentId:'fake'})};} });
  assert.equal(proposal,null);assert.equal(interpretations,1);
  console.log('Generated orchestration, persistence boundary, budgets, proof, finale, restart, cancellation and interpretation checks passed.');
} finally {diceService.rollWithBonusPenalty=originalRoll;}
