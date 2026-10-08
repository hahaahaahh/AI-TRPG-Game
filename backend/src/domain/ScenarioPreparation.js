import { generatedScenarioSchema, INVESTIGATION_LENGTHS, validateGeneratedScenario } from './GeneratedScenario.js';
import { issue, shapeIssues, PreparationValidationError } from './PreparationIssues.js';

export const PREPARATION_VERSION = 2;
export const PREPARATION_STAGES = ['outline', 'routes', 'conclusion'];
const str = { type: 'string' }, integer = { type: 'integer', minimum: 0 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', items });
const nullableInt = { anyOf: [integer, { type: 'null' }] };
const capabilities = {type:'string',enum:['record_text','record_audio','capture_image','copy_digital','sample','seal']};
const ref = ids => ({ type: 'string', enum: ids.length ? ids : [''] });
const pick = (schema, keys) => object(Object.fromEntries(keys.map(k => [k, schema.properties[k]])));
const entity = field => generatedScenarioSchema.properties[field].items;
export const outlineSchema = object({
  title: str, hook: str, hiddenTruth: str, initialLocationIndex: integer,
  locations: array(object({ name: str, description: str, connections: array(integer), hazardous: { type: 'boolean' } })),
  npcs: array(object({ name: str, description: str, motivation: str, locationIndex: integer, companionIndex: nullableInt })),
  clues: array(pick(entity('clues'), ['name','description','keywords'])),
  proofs: array(object({ statement: str })),
  events: array(pick(entity('events'), ['title','kind'])),
});
export function stageSchema(stage, approved = {}) {
  const o = approved.outline;
  if (stage === 'outline') return outlineSchema;
  const ids = field => o[field].map(x => x.id);
  if (stage === 'routes') return object({
    equipment: array(object({name:str,description:str,capabilities:array(capabilities)})),
    clues: array(object({ id: ref(ids('clues')), requires: array(ref(ids('clues'))), components: array(object({
      name: str, source: {anyOf:['location','npc'].map(type => object({type:ref([type]),id:ref(ids(type==='location'?'locations':'npcs'))}))},
      needsCooperation: { type:'boolean' }, capability: capabilities, action: str,
      alternativeLocationId: { anyOf:[ref(ids('locations')), {type:'null'}] }, alternativeAction: str,
    })) })),
    proofs: array(object({ id:ref(ids('proofs')), evidenceIds:array(ref(ids('clues'))) })),
  });
  return object({ events: array(object({ id: ref(ids('events')),
    ...pick(entity('events'), ['playerCue','offscreenCue','aftermathCue','exposure']).properties,
    locationId: ref(ids('locations')), participants: array(ref(ids('npcs'))),
    threatenedClueIds: array(ref(ids('clues'))), advanceClueIds: array(ref(ids('clues'))),
    responses: array(object({ label:str, actionId:ref(buildActionCatalogue(approved).map(a=>a.id)) })),
    consequences: array({anyOf:[
      ...approved.routes.clues.map(c=>object({type:ref(['source_unavailable']),targetId:ref([c.id]),componentId:ref(c.components.map((_,i)=>canonical('component',i))),destinationId:{type:'null'}})),
      object({type:ref(['witness_move']),targetId:ref(ids('npcs')),componentId:ref(['']),destinationId:ref(ids('locations'))}),
      object({type:ref(['witness_depart']),targetId:ref(ids('npcs')),componentId:ref(['']),destinationId:{type:'null'}}),
      object({type:ref(['access_restriction','psychological_exposure']),targetId:ref(ids('locations')),componentId:ref(['']),destinationId:{type:'null'}}),
    ]}),
  })), crisis: generatedScenarioSchema.properties.crisis, endings: generatedScenarioSchema.properties.endings });
}

// Validate shape locally even when hosted tools claim strict output.
export function assertShape(value, schema, path = '$') {
  const errors=shapeIssues(value,schema,path);
  if(errors.length) throw new PreparationValidationError(errors);
}
const canonical = (prefix,i) => `${prefix}_${String(i+1).padStart(3,'0')}`;
export function buildActionCatalogue({outline:o,routes:r}) {
  if(!o || !r) return [];
  const result=[];
  const add=(kind,targetId,componentId,label)=>result.push({id:[kind,targetId,componentId].filter(Boolean).join(':'),label,action:{kind,targetId,componentId}});
  o.locations.forEach(l=>add('move',l.id,'',`前往${l.name}`));
  o.npcs.forEach(n=>{add('investigate',n.id,'',`询问${n.name}`);add('cooperate',n.id,'',`争取${n.name}合作`);});
  o.clues.forEach(c=>{
    add('investigate',c.id,'',`调查${c.name}`);
    r.clues.find(x=>x.id===c.id)?.components.forEach((part,i)=>add('preserve',c.id,canonical('component',i),`尝试保全${c.name}：${part.name}`));
  });
  for(const [kind,label] of Object.entries({notebook:'查看调查笔记',escape:'尝试脱身',negotiate:'谈判争取脱身',surrender:'交出争夺材料以退出危机'})) add(kind,'','',label);
  return result;
}

export function migratePreparation(p, setup, companions) {
  if(p.version!==1) return;
  const a=p.approved ||= {};
  // Do not rewrite locked story content. Revalidate retained routes under the new contract.
  if(a.routes) {
    try { assertShape(a.routes,stageSchema('routes',a)); compilePreparation(a,setup,companions,{placeholderConclusion:true}); }
    catch(error) { p.legacyApprovedRoutes=a.routes; p.failedDraft=JSON.stringify(a.routes); delete a.routes; delete a.conclusion; p.stage='routes'; p.errors=error.issues || []; }
  }
  const convert=conclusion=>({...conclusion,events:conclusion.events.map(e=>({...e,responses:e.responses.map(r=>{
    if(r.actionId) return r;
    const entry=buildActionCatalogue(a).find(x=>r.action && Object.keys(r.action).length===3 && ['kind','targetId','componentId'].every(k=>r.action[k]===x.action[k]));
    if(!entry) throw new Error('旧事件行动无法精确映射；请修复事件阶段。');
    return {label:r.label,actionId:entry.id};
  })}))});
  if(a.conclusion) {
    try { const converted=convert(a.conclusion); assertShape(converted,stageSchema('conclusion',a)); a.conclusion=converted; }
    catch { p.failedDraft=JSON.stringify(a.conclusion); delete a.conclusion; p.stage='conclusion'; }
  } else if(p.stage==='conclusion' && p.failedDraft && a.routes) {
    try { p.failedDraft=JSON.stringify(convert(JSON.parse(p.failedDraft))); } catch { /* Keep exact failed output for repair. */ }
  }
  p.version=PREPARATION_VERSION; p.migration='v1-to-v2';
}
export function approveOutline(d, setup, companions) {
  assertShape(d,outlineSchema);
  const limits = INVESTIGATION_LENGTHS[setup.length];
  for (const field of ['locations','npcs','clues','proofs','events']) if (!d[field].length || d[field].length > limits[field]) throw new Error(`${field}: 数量超过限制`);
  const out = structuredClone(d);
  for (const [field,prefix] of Object.entries({locations:'loc',npcs:'npc',clues:'evidence',proofs:'fact',events:'event'})) out[field] = out[field].map((x,i) => ({...x,id:canonical(prefix,i)}));
  const locationId = i => { if (!out.locations[i]) throw new Error('地点索引不存在'); return out.locations[i].id; };
  out.initialLocationId = locationId(out.initialLocationIndex); delete out.initialLocationIndex;
  out.locations.forEach(l => { l.connections=l.connections.map(locationId); });
  out.npcs.forEach(n => { n.locationId=locationId(n.locationIndex); delete n.locationIndex; });
  if (out.npcs.filter(n=>n.companionIndex!==null).length !== companions || new Set(out.npcs.filter(n=>n.companionIndex!==null).map(n=>n.companionIndex)).size !== companions
    || out.npcs.some(n=>n.companionIndex!==null && n.companionIndex>=companions)) throw new Error('同伴必须逐一保留');
  for (const l of out.locations) for (const id of l.connections) if (!out.locations.find(x=>x.id===id).connections.includes(l.id)) throw new Error('地点通路必须双向');
  const seen=new Set(), queue=[out.initialLocationId];
  while(queue.length) { const id=queue.shift(); if(seen.has(id)) continue; seen.add(id); queue.push(...out.locations.find(l=>l.id===id).connections); }
  if(seen.size!==out.locations.length) throw new Error('地点网络不连通');
  if(out.events.filter(e=>e.kind==='crisis').length!==1) throw new Error('必须恰好一个危机事件');
  if (![out.title,out.hook,out.hiddenTruth,...out.locations.map(l=>l.name),...out.npcs.map(n=>n.motivation),...out.proofs.map(p=>p.statement)].every(s=>s.trim())) throw new Error('核心信息不能为空');
  return out;
}
export function compilePreparation(approved, setup, companions, { placeholderConclusion = false } = {}) {
  const { outline:o, routes:r } = approved;
  assertShape(r,stageSchema('routes',approved));
  if(!placeholderConclusion) assertShape(approved.conclusion,stageSchema('conclusion',approved));
  const availableCapabilities=new Set(r.equipment.flatMap(e=>e.capabilities));
  const errors=[];
  r.clues.forEach((clue,i)=>clue.components.forEach((c,j)=>{
    const path=`$.clues[${i}].components[${j}]`;
    if(!availableCapabilities.has(c.capability)) errors.push(issue('equipment_access',`${path}.capability`,c.capability,`需要现有装备能力：${[...availableCapabilities].join(',')}`,'说服是技能，不是工具；选择支持的保全方法或明确提供符合设定的普通工具。'));
    if(c.source.type==='npc' && (!c.alternativeLocationId || !c.alternativeAction.trim())) errors.push(issue('equipment_access',`${path}.alternativeLocationId`,c.alternativeLocationId,'证人需要独立可达的地点替代','保留证言含义，提供不依赖该证人的材料来源。'));
  }));
  r.equipment.forEach((e,i)=>{
    if(o.clues.some(c=>c.name.trim()===e.name.trim())) errors.push(issue('equipment_access',`$.equipment[${i}].name`,e.name,'起始装备不能是未发现的案件证据','提供空白记录工具等普通装备，而不是案件材料。'));
  });
  if(errors.length) throw new PreparationValidationError(errors);
  const uniqueCoverage = (list, reference, label) => { if(list.length!==reference.length || new Set(list.map(x=>x.id)).size!==reference.length || list.some(x=>!reference.some(y=>y.id===x.id))) throw new Error(`${label}: 必须逐一覆盖批准的ID`); };
  uniqueCoverage(r.clues,o.clues,'线索'); uniqueCoverage(r.proofs,o.proofs,'证明');
  const d = {...structuredClone(o), equipment:r.equipment.map((x,i)=>({...x,id:canonical('item',i)})),
    clues:o.clues.map(c=>{const route=r.clues.find(x=>x.id===c.id); return {...c,requires:route.requires,components:route.components.map((x,i)=>({
      id:canonical('component',i), name:x.name, locationId:x.source.type==='location'?x.source.id:null,npcId:x.source.type==='npc'?x.source.id:null,
      needsCooperation:x.needsCooperation,capability:x.capability,action:x.action,alternativeLocationId:x.alternativeLocationId,alternativeAction:x.alternativeAction,
    }))};}), proofs:o.proofs.map(p=>({...p,evidenceIds:r.proofs.find(x=>x.id===p.id).evidenceIds})) };
  const conclusion=approved.conclusion;
  if (placeholderConclusion) {
    d.events=o.events.map(e=>({...e,locationId:o.initialLocationId,playerCue:'提示',offscreenCue:'提示',aftermathCue:'提示',options:['A. 谈判','B. 退出','C. 观察','D. 自由行动'],participants:[o.npcs[0].id],threatenedClueIds:[],advanceClueIds:[],exposure:'none'}));
    d.crisis={objective:'退出',escape:'安全退出。',negotiation:'对方让路。',surrender:'交出指定材料。',setback:'被迫离开。',contestedClueIds:[]};
    d.endings={expose:'结束。',preserve:'结束。',destroy:'结束。',withdraw:'结束。',incomplete:'证据不足结案。'};
  } else {
    uniqueCoverage(conclusion.events,o.events,'事件');
    const catalogue=buildActionCatalogue(approved);
    d.events=o.events.map(e=>{
      const event=conclusion.events.find(x=>x.id===e.id);
      const responses=event.responses.map((r,i)=>{
        const entry=catalogue.find(x=>x.id===r.actionId);
        if(!entry) throw new PreparationValidationError([issue('schema_reference',`$.events.${e.id}.responses[${i}].actionId`,r.actionId,'必须选择目录中的行动ID','只选择actionId，不构造目标或组件。')]);
        if(!/[\u3400-\u9fff]/.test(r.label) || /必定|一定成功|保证成功|自动获得|必然成功|(?:loc|npc|evidence|fact|component|item|event)_\d+/.test(r.label)) throw new PreparationValidationError([issue('schema_reference',`$.events.${e.id}.responses[${i}].label`,r.label,'需要不承诺成功且不含内部ID的中文行动描述','描述尝试的行动，不预告结果。')]);
        // Canonical intent stays visible even when the model adds contextual wording.
        const label=r.label===entry.label?entry.label:`${entry.label}（${r.label.replace(/^[ABC][.。．、]\s*/,'')}）`;
        return {label,action:structuredClone(entry.action)};
      });
      return {...e,...event,responses,options:responses.map((r,i)=>`${'ABC'[i]}. ${r.label}`).concat('D. 自由行动')};
    });
    d.crisis=conclusion.crisis; d.endings=conclusion.endings;
  }
  // Keep the existing v1 runtime shape: v2 additions are validated separately.
  const base={...d,events:d.events.map(({responses,consequences,...e})=>e)};
  const validation=validateGeneratedScenario(base,setup,companions);
  if(!validation.ok) throw new PreparationValidationError(validation.errors.map(message=>issue(
    /工具|证人|替代|合作|来源/.test(message)?'equipment_access':'schema_reference',
    /^\$[^:：]*/.exec(message)?.[0] || '$.scenario',null,message,'保留批准的大纲，只修复当前阶段的相关引用或路线。')));
  if (!placeholderConclusion) for (const e of d.events) {
    if(e.responses.length!==3) throw new Error('事件需要三个行动');
    for(const {label,action:a} of e.responses) {
      if(!label.trim()) throw new Error('行动标签不能为空');
      const valid=a.kind==='move'?d.locations.some(x=>x.id===a.targetId):a.kind==='cooperate'?d.npcs.some(x=>x.id===a.targetId):a.kind==='preserve'?d.clues.some(x=>x.id===a.targetId && x.components.some(c=>c.id===a.componentId)):
        a.kind==='investigate'?!a.targetId||d.clues.some(x=>x.id===a.targetId)||d.npcs.some(x=>x.id===a.targetId):['escape','negotiate','surrender','notebook'].includes(a.kind)&&!a.targetId;
      if(!valid) throw new Error(`${e.id}: 事件行动目标无效 ${JSON.stringify(a)}；move引用地点，investigate引用人物/线索或空字符串，preserve必须引用线索和其组件；escape/negotiate/surrender/notebook不填写targetId。`);
    }
    for(const c of e.consequences) {
      const valid=c.type==='source_unavailable'?d.clues.some(x=>x.id===c.targetId&&x.components.some(k=>k.id===c.componentId)):
        c.type.startsWith('witness_')?d.npcs.some(x=>x.id===c.targetId)&&(c.type!=='witness_move'||d.locations.some(l=>l.id===c.destinationId)):
        d.locations.some(x=>x.id===c.targetId);
      if(!valid) throw new Error('事件后果目标无效');
      if(c.type==='source_unavailable'&&!e.threatenedClueIds.includes(c.targetId)) throw new Error('受威胁材料必须有回应窗口');
    }
  }
  return d;
}

export function validateRuntimeDefinition(d, setup, companions) {
  return validateGeneratedScenario({...d,events:d.events.map(({responses,consequences,...event})=>event)},setup,companions);
}
