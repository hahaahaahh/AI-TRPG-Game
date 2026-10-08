// Versioned data contract. Never evaluate model-generated scripts or expressions.
export const SCENARIO_SCHEMA_VERSION = 1;
export const INVESTIGATION_LENGTHS = Object.freeze({
  short: { gate: 14, locations: 4, clues: 5, npcs: 3, proofs: 3, events: 4 },
  standard: { gate: 26, locations: 6, clues: 8, npcs: 5, proofs: 4, events: 6 },
  long: { gate: 38, locations: 8, clues: 10, npcs: 6, proofs: 5, events: 8 },
});
const str = { type: 'string' };
const strings = { type: 'array', items: str };
const nullable = { anyOf: [str, { type: 'null' }] };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', items });
export const generatedScenarioSchema = object({
  title: str, hook: str, hiddenTruth: str, initialLocationId: str,
  locations: array(object({ id: str, name: str, description: str, connections: strings, hazardous: { type: 'boolean' } })),
  npcs: array(object({ id: str, name: str, description: str, motivation: str, locationId: str, companionIndex: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] } })),
  equipment: array(object({ id: str, name: str, description: str, capabilities: strings })),
  clues: array(object({ id: str, name: str, description: str, keywords: strings, requires: strings,
    components: array(object({ id: str, name: str, locationId: nullable, npcId: nullable, needsCooperation: { type: 'boolean' },
      capability: str, action: str, alternativeLocationId: nullable, alternativeAction: str })),
  })),
  proofs: array(object({ id: str, statement: str, evidenceIds: strings })),
  events: array(object({ id: str, title: str, kind: { type: 'string', enum: ['warning', 'development', 'crisis', 'consolidation', 'commitment'] },
    locationId: str, playerCue: str, offscreenCue: str, aftermathCue: str, options: strings,
    participants: strings, threatenedClueIds: strings, advanceClueIds: strings,
    exposure: { type: 'string', enum: ['none', 'unease', 'major'] },
  })),
  crisis: object({ objective: str, escape: str, negotiation: str, surrender: str, setback: str, contestedClueIds: strings }),
  endings: object({ expose: str, preserve: str, destroy: str, withdraw: str, incomplete: str }),
});

export function normalizeInvestigationSetup(input = {}) {
  const mode = input.mode ?? 'free';
  const length = input.length ?? 'standard';
  const psychologicalPresentation = input.psychologicalPresentation ?? 'stress';
  if (!['free', 'guided'].includes(mode) || !INVESTIGATION_LENGTHS[length]
    || !['sanity', 'stress'].includes(psychologicalPresentation)) throw new Error('调查模式、长度或心理资源设置无效。');
  return { mode, length, psychologicalPresentation };
}

// The provider's strict schema is not a trust boundary. Validate every value
// locally, including providers that ignore strict tools.
function shapeErrors(value, schema, path, errors) {
  if (schema.anyOf) {
    if (!schema.anyOf.some(candidate => { const found = []; shapeErrors(value, candidate, path, found); return found.length === 0; })) errors.push(`${path}: 类型无效`);
    return;
  }
  const valid = schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'null' ? value === null : schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type;
  if (!valid) { errors.push(`${path}: 需要${schema.type}`); return; }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: 不允许的值`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: 超出范围`);
  if (schema.type === 'string' && value.length > 4000) errors.push(`${path}: 文本过长`);
  if (schema.type === 'object') {
    for (const key of schema.required) shapeErrors(value[key], schema.properties[key], `${path}.${key}`, errors);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) errors.push(`${path}.${key}: 未定义字段`);
  }
  if (schema.type === 'array') {
    if (value.length > 40) { errors.push(`${path}: 元素过多`); return; }
    value.forEach((item, index) => shapeErrors(item, schema.items, `${path}[${index}]`, errors));
  }
}

export function validateGeneratedScenario(value, setup = {}, companionCount = 0) {
  const errors = [];
  shapeErrors(value, generatedScenarioSchema, 'scenario', errors);
  if (errors.length) return { ok: false, errors };
  const normalized = normalizeInvestigationSetup(setup), limits = INVESTIGATION_LENGTHS[normalized.length];
  const need = (condition, message) => { if (!condition) errors.push(message); };
  for (const field of ['title', 'hook', 'hiddenTruth']) need(value[field].trim(), `${field}不能为空`);
  const maps = {};
  for (const [field, cap, prefix] of [['locations', limits.locations, 'loc'], ['npcs', limits.npcs, 'npc'], ['equipment', 8, 'item'], ['clues', limits.clues, 'evidence'], ['proofs', limits.proofs, 'fact'], ['events', limits.events, 'event']]) {
    need(value[field].length > 0 && value[field].length <= cap, `${field}数量必须在1到${cap}之间`);
    maps[field] = new Map(value[field].map(item => [item.id, item]));
    need(maps[field].size === value[field].length, `${field}标识重复`);
    for (const item of value[field]) need(new RegExp(`^${prefix}_\\d{3}$`).test(item.id) && item.id !== 'npc_000', `${field}标识无效：${item.id}`);
  }
  need(maps.locations.has(value.initialLocationId), '初始地点不存在');
  for (const location of value.locations) {
    need(location.name.trim() && location.description.trim(), '地点名称和描述不能为空');
    for (const id of location.connections) {
      need(maps.locations.has(id), `路线引用未知地点：${id}`);
      need(maps.locations.get(id)?.connections.includes(location.id), `路线必须双向：${location.id}/${id}`);
    }
  }
  const reachable = new Set(), queue = [value.initialLocationId];
  while (queue.length) { const id = queue.shift(); if (reachable.has(id)) continue; reachable.add(id); queue.push(...(maps.locations.get(id)?.connections || [])); }
  need(value.locations.every(l => reachable.has(l.id)), '地点网络不连通');
  const companionIndexes = value.npcs.filter(n => n.companionIndex !== null).map(n => n.companionIndex);
  need(companionIndexes.length === companionCount && new Set(companionIndexes).size === companionCount
    && companionIndexes.every(i => i < companionCount), '同伴必须逐一保留并计入NPC上限');
  for (const npc of value.npcs) need(maps.locations.has(npc.locationId) && npc.name.trim() && npc.motivation.trim(), `NPC信息或位置无效：${npc.id}`);
  const capabilities = new Set(value.equipment.flatMap(e => e.capabilities));
  for (const clue of value.clues) {
    need(clue.name.trim() && clue.description.trim() && clue.keywords.some(k => k.trim()), `线索缺少可用名称、描述或关键词：${clue.id}`);
    need(clue.components.length >= 1 && clue.components.length <= 3, `线索组件数量无效：${clue.id}`);
    need(new Set(clue.components.map(c => c.id)).size === clue.components.length, `组件重复：${clue.id}`);
    for (const id of clue.requires) need(maps.clues.has(id), `前置线索不存在：${id}`);
    for (const c of clue.components) {
      need(/^[a-z][a-z0-9_]{0,39}$/.test(c.id), `组件标识无效：${clue.id}`);
      need(c.name.trim() && c.action.trim() && capabilities.has(c.capability), `组件缺少可用保全方法或工具：${clue.id}/${c.id}`);
      need(Boolean(c.locationId) !== Boolean(c.npcId), `组件必须指定一个地点或证人来源：${clue.id}/${c.id}`);
      if (c.locationId) need(maps.locations.has(c.locationId), `组件地点不存在：${c.locationId}`);
      if (c.npcId) need(maps.npcs.has(c.npcId), `证人不存在：${c.npcId}`);
      if (c.npcId || c.needsCooperation) need(maps.locations.has(c.alternativeLocationId) && c.alternativeAction.trim(), `受阻来源缺少可达替代方案：${clue.id}/${c.id}`);
      need(!c.needsCooperation || !!c.npcId, `合作要求必须指定证人：${clue.id}/${c.id}`);
      if (c.alternativeLocationId) need(maps.locations.has(c.alternativeLocationId), '替代来源地点不存在');
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { errors.push(`前置线索循环：${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of maps.clues.get(id)?.requires || []) visit(prerequisite);
    visiting.delete(id); visited.add(id);
  }
  value.clues.forEach(c => visit(c.id));
  for (const proof of value.proofs) need(proof.statement.trim() && proof.evidenceIds.length > 0 && proof.evidenceIds.every(id => maps.clues.has(id)), `真相证明无效：${proof.id}`);
  need(value.events.filter(e => e.kind === 'crisis').length === 1, '必须且只能有一个中央危机');
  for (const event of value.events) {
    need(maps.locations.has(event.locationId), '事件地点不存在');
    need(event.title.trim() && event.playerCue.trim() && event.offscreenCue.trim() && event.aftermathCue.trim(), '事件必须有现场、远处和余波提示');
    need(event.options.length === 4 && event.options.every((o, i) => o.startsWith('ABCD'[i] + '.')) && event.options[3] === 'D. 自由行动', '事件必须提供四个有效选项');
    need(event.participants.every(id => maps.npcs.has(id)), '事件参与者不存在');
    need([...event.threatenedClueIds, ...event.advanceClueIds].every(id => maps.clues.has(id)), '事件线索引用不存在');
    if (event.kind === 'crisis') need(event.participants.length > 0, '危机缺少参与者');
  }
  need(value.crisis.contestedClueIds.every(id => maps.clues.has(id)), '争夺材料不存在');
  for (const field of ['objective', 'escape', 'negotiation', 'surrender', 'setback']) need(value.crisis[field].trim(), `危机缺少${field}`);
  for (const [key, text] of Object.entries(value.endings)) need(text.trim() && !/未完待续|故事才刚刚开始/.test(text), `结局${key}缺少确定后果`);
  return { ok: errors.length === 0, errors };
}

export function investigationMilestones(length = 'standard') {
  const gate = INVESTIGATION_LENGTHS[length].gate;
  return { gate, warning: Math.round(gate * .1), crisis: Math.round(gate * .65), consolidation: Math.round(gate * .8), commitment: Math.round(gate * .92) };
}
