// Read-only rules for generated case data. Used by both presentation and engine;
// never return an undiscovered source location or a distant witness's position.
export function generatedComponent(session, evidenceId, componentId) {
  return session.scenarioDefinition?.clues?.find(c => c.id === evidenceId)?.components.find(c => c.id === componentId);
}
export function canContactNpc(session, npcId) {
  const npc = session.npcs?.find(n => n.id === npcId);
  return !!npc && npc.visibility !== 'hidden' && npc.status !== 'departed' && npc.hp !== 0
    && npc.locationId === session.playerLocationId && !/昏迷|无法交流/.test(npc.currentState || '');
}
export function hasCapability(session, capability) {
  return session.inventory?.some(item => item.status !== '已失去'
    && session.scenarioDefinition?.equipment?.find(e => e.id === item.id)?.capabilities.includes(capability)) || false;
}
export function generatedComponentAccess(session, evidenceId, componentId) {
  const definition = generatedComponent(session, evidenceId, componentId);
  if (!definition) return { ok: false, reason: '尚无明确保全方法，请先调查来源。' };
  const held = session.evidence?.find(e => e.id === evidenceId)?.artifacts?.some(a => a.component === componentId && a.custody === 'player');
  if (held) return { ok: true, source: 'held' };
  if (definition.alternativeLocationId === session.playerLocationId) return { ok: true, source: 'alternative' };
  if(session.scenarioFlags?.generatedEffects?.unavailable.includes(`${evidenceId}:${componentId}`)) return {ok:false,reason:'原始材料已无法接触，请使用已知替代来源或持有副本。'};
  if (definition.npcId) {
    if (!canContactNpc(session, definition.npcId)) return { ok: false, reason: '目前无法直接联系这位证人，也未持有材料副本。' };
    if (definition.needsCooperation && !session.scenarioFlags?.cooperation?.[definition.npcId]) return { ok: false, reason: '须先取得证人合作。' };
    return { ok: true, source: 'witness' };
  }
  if (definition.locationId === session.playerLocationId && !definition.needsCooperation) return { ok: true, source: 'location' };
  const known = session.locations?.find(l => l.id === definition.locationId);
  return { ok: false, reason: known ? `须先到达${known.name}。` : '材料来源尚待调查。' };
}
export function generatedEvidenceDetails(session, id) {
  const record = session.evidence?.find(e => e.id === id && e.discovered !== false);
  if (!record) return null;
  const clue = session.scenarioDefinition?.clues?.find(c => c.id === id);
  return { rows: (clue?.components || []).map(c => {
    const done = !!record.secured || record.artifacts?.some(a => a.component === c.id && a.custody === 'player') || false;
    const access = generatedComponentAccess(session, id, c.id);
    const equipped = hasCapability(session, c.capability);
    const alternative = session.locations?.find(l => l.id === c.alternativeLocationId);
    const place = session.locations?.find(l => l.id === c.locationId) || alternative;
    // Authored instructions may name an unknown source. Don't emit them until
    // the source is accessible; return a generic investigative next step.
    let action = null, text = access.ok ? access.source === 'alternative' ? c.alternativeAction : c.action : '先调查可接触的材料来源';
    if (!done && access.ok && equipped) action = { kind: 'preserve', evidenceId: id, component: c.id };
    else if (!done && c.npcId && canContactNpc(session, c.npcId) && !session.scenarioFlags?.cooperation?.[c.npcId]) {
      action = { kind: 'cooperate', npcId: c.npcId }; text = '先取得证人合作';
    } else if (!done && place && place.id !== session.playerLocationId && !session.combat?.active) {
      action = { kind: 'move', locationId: place.id }; text = `前往${place.name}`;
    }
    return { key: c.id, label: c.name, done, action, text,
      requirement: place ? `${place.name}的材料或已持有的副本` : '直接接触来源并取得许可，或持有副本；其他来源尚待调查',
      reason: done ? '已经保存' : !equipped ? '缺少对应取证工具。' : access.ok ? session.combat?.active ? '存在危险，须先通过检定。' : '可以执行，消耗1次有效行动。' : access.reason };
  }) };
}
export function generatedActionText(session, action) {
  if(action?.kind==='notebook') return '查看调查笔记';
  if(['escape','negotiate','surrender'].includes(action?.kind)) return {escape:'寻找退路并脱身',negotiate:'谈判争取脱身',surrender:'交出争夺材料并退出'}[action.kind];
  if(action?.kind==='investigate') {
    const target=session.scenarioDefinition.clues.find(c=>c.id===action.evidenceId) || session.npcs.find(n=>n.id===action.evidenceId && n.visibility!=='hidden');
    return target ? `调查${target.name}` : !action.evidenceId ? '调查当前现场' : null;
  }
  if (action?.kind === 'move') {
    const place = session.locations?.find(l => l.id === action.locationId);
    return place ? `进入${place.name}` : null;
  }
  if (action?.kind === 'cooperate') {
    const npc = session.npcs?.find(n => n.id === action.npcId && n.visibility !== 'hidden');
    return npc && canContactNpc(session, npc.id) ? `说服${npc.name}同意合作` : null;
  }
  if (action?.kind === 'preserve' && session.evidence?.some(e => e.id === action.evidenceId && e.discovered !== false)) {
    const component = generatedComponent(session, action.evidenceId, action.component);
    const access = generatedComponentAccess(session, action.evidenceId, action.component);
    return component ? access.source === 'alternative' ? component.alternativeAction : component.action : null;
  }
  return null;
}
