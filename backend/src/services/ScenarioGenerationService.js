import { FlowType } from '../domain/enums.js';
import { normalizeInvestigationSetup, validateGeneratedScenario, SCENARIO_SCHEMA_VERSION } from '../domain/GeneratedScenario.js';
import { inputAssembler } from './InputAssembler.js';
import { PREPARATION_VERSION, PREPARATION_STAGES, stageSchema, assertShape, approveOutline, compilePreparation, validateRuntimeDefinition, buildActionCatalogue, migratePreparation } from '../domain/ScenarioPreparation.js';
import { issue, issueFingerprint, PreparationValidationError } from '../domain/PreparationIssues.js';

export class ScenarioGenerationService {
  async step(session, provider, { onDebug = () => {}, command = null } = {}) {
    if (session.openingDone || session.scenarioId) throw new Error('已开幕案件不能重新准备。');
    const setup = normalizeInvestigationSetup(session.investigationSetup);
    const snapshot = JSON.stringify({ setup, world:session.worldSettings, player:session.player, companions:session.keyCharacters });
    if (setup.mode !== 'guided') throw new Error('请先选择引导调查。');
    if (session.scenarioDefinition) {
      const checked=validateRuntimeDefinition(session.scenarioDefinition,setup,session.keyCharacters.length);
      if(!checked.ok) throw new Error('保存的案件定义无效，请重新准备。');
      return 'ready';
    }
    if(command === 'restart') session.scenarioPreparation=null;
    const p=session.scenarioPreparation ||= { version:PREPARATION_VERSION, setupSnapshot:snapshot, approved:{}, stage:'outline', status:'preparing',
      failedDraft:null, errors:[], category:null, calls:0, totalCalls:0, attempt:1, modelProfile:session.llmProfileId, metrics:[] };
    migratePreparation(p,setup,session.keyCharacters.length);
    if(p.version!==PREPARATION_VERSION || p.setupSnapshot!==snapshot) { p.status='paused'; p.restartRequired=true; p.message='设定或准备版本已变化，请确认重新准备案件。'; return 'paused'; }
    if(command==='continue' && !p.restartRequired) { p.calls=0; p.attempt++; p.status='preparing'; p.repeatedFailures=0; p.failureFingerprint=null; p.message=null; }
    if(p.calls>=6 || p.status==='paused') { p.status='paused'; return 'paused'; }
    const stage=p.stage, schema=stageSchema(stage,p.approved);
    const request=inputAssembler.assemble(FlowType.SCENARIO_GEN,session);
    request.preparationStage=p.failedDraft ? 'repair' : stage;
    request.tools=[{type:'function',function:{name:`prepare_${stage}`,description:'输出当前案件准备阶段',strict:true,parameters:schema}}];
    request.messages=[{role:'system',content:'你在准备有限行动预算的中文调查案件。只调用当前工具，不输出JSON Schema本身。只输出当前阶段的数据，不改变已批准的真相、人物、地点、线索含义。所有说明简洁，不写文学长篇。outline用从0开始的地点数组索引，通路必须双向；其他阶段只能引用已分配ID。每个证人来源必须有可达的独立地点替代。每个线索1至3个组件；优先安排证明必需的线索，给移动和保全留出行动预算。装备是工具，技能是检定，证据是尚待调查的材料：例如说服证人仅获得合作，使用纸笔(record_text)抄录证言才保全；说服不属于装备能力。起始装备不能包含未发现的案件证据，古代世界不要凭空配手机。每事件恰好三个自然中文响应标签，仅从actionCatalogue选择actionId，标签描述相同意图，不承诺成功；绝不构造action对象或新目标。非恐怖世界不得引入超自然。修复时处理全部issues，保留有效内容，不因格式错误改写剧情。'},
      {role:'user',content:JSON.stringify({stage,world:session.worldSettings,player:session.player,companions:session.keyCharacters,setup,
        limits: { ...((await import('../domain/GeneratedScenario.js')).INVESTIGATION_LENGTHS[setup.length]) },
        approved:p.approved,actionCatalogue:stage==='conclusion'?buildActionCatalogue(p.approved):[],failedDraft:p.failedDraft,errors:p.errors,issues:p.issues || [],repairCategory:p.category})}];
    p.calls++; p.totalCalls++; p.status='preparing';
    const started=Date.now(); let response;
    try {
      response=await provider.generate(request);
      p.failedDraft=response.content;
      let parsed;
      try { parsed=JSON.parse(response.content); } catch(error) { p.category='syntax'; throw new PreparationValidationError([issue('syntax','$',response.content.slice(0,4000),'需要完整合法JSON','修复语法而不改变案件含义；'+error.message)]); }
      p.category='structure'; assertShape(parsed,schema);
      const approved=structuredClone(p.approved);
      approved[stage]=stage==='outline'?approveOutline(parsed,setup,session.keyCharacters.length):parsed;
      if(stage==='routes') {
        const candidate=compilePreparation(approved,setup,session.keyCharacters.length,{placeholderConclusion:true});
        p.category='route';
        const {verifyScenarioRoutes}=await import('./ScenarioRouteValidator.js');
        const routes=await verifyScenarioRoutes(candidate,session);
        if(!routes.ok) throw routeError(routes);
        p.coreRouteVerification=routes;
      }
      if(stage==='conclusion') {
        const definition=compilePreparation(approved,setup,session.keyCharacters.length);
        p.category='route';
        const { verifyScenarioRoutes }=await import('./ScenarioRouteValidator.js');
        const routes=await verifyScenarioRoutes(definition,session);
        if(!routes.ok) throw routeError(routes);
        p.routeVerification=routes;
        session.scenarioDefinition=definition; session.scenarioSource='generated'; session.scenarioSchemaVersion=2;
      }
      p.approved=approved; p.failedDraft=null; p.errors=[]; p.issues=[]; p.category=null; p.failureFingerprint=null; p.repeatedFailures=0; p.message=null;
      p.stage=PREPARATION_STAGES[PREPARATION_STAGES.indexOf(stage)+1] || 'complete';
      p.status=session.scenarioDefinition?'ready':p.calls>=6?'paused':'preparing';
    } catch(error) {
      if(!response) p.category='transport';
      p.issues=(error.issues || [issue(p.category==='transport'?'transport':p.category==='route'?'route_blocked':'schema_reference','$',null,String(error.message).slice(0,4000),'仅修复失败阶段，保留已批准内容。')]).slice(0,20);
      p.category=p.issues[0].category;
      p.errors=p.issues.map(i=>`${i.path}: ${i.expected}；${i.guidance}`);
      const fingerprint=issueFingerprint(p.issues);
      p.repeatedFailures=p.failureFingerprint===fingerprint?(p.repeatedFailures||0)+1:1;
      p.failureFingerprint=fingerprint;
      p.status=p.calls>=6 || p.repeatedFailures>=3?'paused':'needs_repair';
      if(p.repeatedFailures>=3) p.message='连续三次修复未解决相同问题，已暂停以避免重复费用。进度已保存，可手动继续或重新准备案件。';
      onDebug({type:'scenario_repair',content:JSON.stringify({stage,category:p.category,errors:p.errors})});
    }
    p.metrics.push({stage,modelProfile:session.llmProfileId,call:p.totalCalls,latencyMs:Date.now()-started,usage:response?.usage || null,transportAttempts:response?._diagnostic?.transportAttempts ?? null,finishReason:response?._diagnostic?.finishReason || null,requestPolicy:response?._diagnostic?.requestPolicy || null,category:p.category});
    onDebug({type:'scenario_preparation',content:JSON.stringify(p.metrics.at(-1))});
    session.generationStatus={stage:p.status,attempts:p.totalCalls,message:p.status==='paused'?(p.message || '准备已暂停，已保存进度，可继续准备。'):null};
    return p.status;
  }

  // Legacy single-output adapter retained for saved v1 definitions and probes.
  async prepare(session, provider, { onDebug = () => {} } = {}) {
    const setup = normalizeInvestigationSetup(session.investigationSetup);
    if (setup.mode !== 'guided') throw new Error('请先选择引导调查模式。');
    session.investigationSetup = setup;
    const companions = session.keyCharacters?.length || 0;
    if (session.scenarioDefinition) {
      const validation = validateGeneratedScenario(session.scenarioDefinition, setup, companions);
      if (!validation.ok) throw new Error(`已保存的案件定义无效：${validation.errors.join('；')}`);
      session.generationStatus = { stage: 'ready', attempts: session.generationStatus?.attempts || 0 };
      return session.scenarioDefinition;
    }
    let repair = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      session.generationStatus = { stage: 'generating', attempts: attempt };
      const assembled = inputAssembler.assemble(FlowType.SCENARIO_GEN, session, { userText: repair });
      onDebug({ type: 'scenario_generation', flowType: FlowType.SCENARIO_GEN, attempt, content: '准备并校验隐藏案件。' });
      try {
        const result = await provider.generate(assembled);
        const definition = JSON.parse(result.content);
        onDebug({ type: 'scenario_output_shape', flowType: FlowType.SCENARIO_GEN, attempt,
          content: JSON.stringify({ rootType: Array.isArray(definition) ? 'array' : typeof definition,
            keys: definition && typeof definition === 'object' ? Object.keys(definition).slice(0, 24) : [],
            characters: result.content.length, finishReason: result._diagnostic?.finishReason || null }) });
        const validation = validateGeneratedScenario(definition, setup, companions);
        if (!validation.ok) throw new Error(validation.errors.join('；'));
        session.scenarioDefinition = structuredClone(definition);
        session.scenarioSource = 'generated';
        session.scenarioSchemaVersion = SCENARIO_SCHEMA_VERSION;
        session.generationStatus = { stage: 'ready', attempts: attempt };
        return session.scenarioDefinition;
      } catch (error) {
        repair = `上次输出无效，请重新输出完整案件并修复：${String(error.message).slice(0, 3000)}`;
        onDebug({ type: 'scenario_repair', flowType: FlowType.SCENARIO_GEN, attempt, content: repair });
      }
    }
    session.generationStatus = { stage: 'failed', attempts: 3, message: '案件生成未通过校验；设定已保留，请重试。' };
    throw new Error(session.generationStatus.message);
  }
}
function routeError(result) {
  return new PreparationValidationError([issue(result.category || 'route_blocked','$.routes',result.reason,
    result.category==='search_exhaustion'?'搜索耗尽：可玩性尚未验证':'需要在正常调查门槛前取得完整证明的可执行路线',
    '保留大纲；检查必需线索前置、移动与保全成本、证人替代来源及事件后果；不得擅自授予证据。')]);
}
export const scenarioGenerationService = new ScenarioGenerationService();
