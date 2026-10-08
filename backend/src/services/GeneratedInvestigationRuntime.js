import { investigationMilestones } from '../domain/GeneratedScenario.js';
import { generatedComponentAccess, canContactNpc, hasCapability } from '../../../src/shared/GeneratedInvestigationRules.mjs';
import { knownRoute } from '../../../src/shared/InvestigationRules.mjs';
import { applyGeneratedEffects } from './GeneratedEventEffects.js';

export const isGenerated = session => session.scenarioSource === 'generated' && !!session.scenarioDefinition;
export const budget = session => session.scenarioRules?.actionBudget || 26;
export const commitmentAt = session => session.scenarioRules?.commitmentAt || 24;
export const resourceLabel = session => session.investigationSetup?.psychologicalPresentation === 'stress' ? '心理承受力' : '理智';
export const progressState = session => session.scenarioFlags.investigation ||= { actions: 0, act: 'opening', attempted: [], injuries: [], dressings: 2, grounding: 0, milestones: [], rewards: [], receipts: [] };
const copy = value => structuredClone(value);

export function initializeGeneratedCase(session) {
  const d = session.scenarioDefinition, milestones = investigationMilestones(session.investigationSetup.length);
  session.scenarioId = `generated:${session.id}`;
  session.title = d.title;
  session.scenarioRules = {
    pacingVersion: 3, actionBudget: milestones.gate, commitmentAt: milestones.commitment, milestones,
    initialLocationId: d.initialLocationId,
    locationCatalog: Object.fromEntries(d.locations.map(l => [l.id, { name: l.name, description: l.description, hazardous: l.hazardous }])),
    locationGraph: Object.fromEntries(d.locations.map(l => [l.id, [...l.connections]])),
    clueCatalog: Object.fromEntries(d.clues.map(c => [c.id, { source: c.name, description: c.description, keywords: c.keywords,
      reliability: 'high', category: 'document', locationIds: c.components.map(x => x.locationId).filter(Boolean),
      preservationHint: c.components.map(x => x.name).join('、') + '：查看详细信息，按当前可接触的来源取证。' }])),
    truths: Object.fromEntries(d.proofs.map(p => [p.id, [...p.evidenceIds]])), sanEvents: {},
  };
  session.scenarioClock = { currentTime: '00:10', deadline: '06:00', turn: 0, phase: 'hook', mode: 'normal' };
  session.playerLocationId = d.initialLocationId;
  const player = session.npcs.find(n => n.id === 'npc_000');
  if (player) player.locationId = d.initialLocationId;
  session.npcs = [player, ...d.npcs.map(n => ({ id: n.id, name: n.name, baseDescription: n.description,
    currentState: '在场观察周围。', importance: 'key', locationId: n.companionIndex !== null ? d.initialLocationId : n.locationId,
    visibility: n.locationId === d.initialLocationId || n.companionIndex !== null ? 'visible' : 'hidden',
    hp: null, maxHp: null, san: null, maxSan: null, status: 'active', attributes: null }))].filter(Boolean);
  session.inventory = d.equipment.map(e => ({ id: e.id, name: e.name, description: e.description, status: '已获得' }));
  session.locations = [];
  session.evidence = [];
  session.scenarioFlags = { cooperation: {}, failedApproaches: {} };
  session.sanity = { startSan: player?.maxSan || player?.san || 50, resolvedEventIds: [], traumaHistory: [], activeTrauma: null };
  session.combat = null; session.activeScene = null; session.finaleState = null; session.finalChoice = null; session.endingState = null; session.suspicion = 0;
  progressState(session).visited = [d.initialLocationId];
  revealNeighborhood(session);
  const developments = d.events.filter(e => e.kind === 'development');
  session.scheduledEvents = d.events.map(e => {
    const due = e.kind === 'development' ? Math.round(milestones.gate * (.25 + .35 * developments.indexOf(e) / Math.max(1, developments.length - 1))) : milestones[e.kind];
    const branch = (cue, remote = false) => ({ playerCue: cue, playerOptions: [...e.options], instruction: cue,
      outcome: remote ? 'remote' : 'present', leavesAftermath: remote, aftermathInstruction:e.aftermathCue, aftermathPlayerCue:e.aftermathCue,
      ...(e.kind === 'crisis' ? { combatUpdate: { active: true, objective: d.crisis.objective, participants: e.participants }, moveParticipantsToScene: true } : {}),
    });
    if (e.exposure !== 'none') session.scenarioRules.sanEvents[e.id] = { severity: e.exposure, locationId: e.locationId, at: '00:00' };
    return { id: e.id, text: e.title, at: '00:00', dueAction: due, priority: e.kind === 'crisis' ? 80 : 40,
      phase: e.kind, status: 'dormant', fired: false, revealed: false, advanceClueIds: e.advanceClueIds,
      consequences:e.consequences || [], responses:e.responses || [],
      minimumResponseTurns: e.threatenedClueIds.length || e.consequences?.some(c=>['source_unavailable','witness_depart','access_restriction'].includes(c.type)) ? 2 : 0, absencePolicy: 'resolve',
      placement: e.kind === 'crisis' ? { mode: 'player_current' } : { mode: 'local', locationId: e.locationId },
      branches: { foreground: branch(e.playerCue), present: branch(e.playerCue), nearby: branch(e.offscreenCue, true), absent: branch(e.offscreenCue, true), expired: branch(e.offscreenCue, true) },
      aftermathInstruction: e.aftermathCue, aftermathPlayerCue: e.aftermathCue, revealsLocations: [e.locationId],
    };
  });
}

export function revealNeighborhood(session) {
  const d = session.scenarioDefinition;
  const location = d.locations.find(l => l.id === session.playerLocationId);
  for (const id of [location.id, ...location.connections]) if (!session.locations.some(l => l.id === id)) {
    const source = d.locations.find(l => l.id === id);
    session.locations.push({ id, name: source.name, description: id === location.id ? source.description : '从当前地点已确认的通路；具体情况需抵达后调查。' });
  }
  for (const n of session.npcs) if (n.locationId === location.id) n.visibility = 'visible';
}

export function generatedTargets(session, text) {
  const normalized = text.toLowerCase();
  return session.scenarioDefinition.clues.filter(c => [c.name, ...c.keywords, ...c.components.map(x => x.name)].some(k => k && normalized.includes(k.toLowerCase()))).map(c => c.id);
}
export function classifyGeneratedAction(session, input) {
  const text = String(input).split('对应行动：').pop().trim();
  const d = session.scenarioDefinition;
  const ids = generatedTargets(session, text);
  const npc = session.npcs.filter(n => n.id !== 'npc_000' && n.visibility !== 'hidden').find(n => text.includes(n.name));
  const place = session.locations.filter(l => text.includes(l.name)).sort((a,b) => b.name.length-a.name.length)[0];
  if (/进入|前往|返回|回到|走向|^去|go to|move to|return to|enter/i.test(text)) return { kind: 'move', targetId: place?.id || '', componentId: '', ids, text };
  if (/包扎|bandage/i.test(text)) return { kind: 'recover_hp', targetId: '', componentId: '', ids, text };
  if (/稳定情绪|平复|grounding|calm down/i.test(text)) return { kind: 'recover_stress', targetId: '', componentId: '', ids, text };
  if (session.combat?.active || session.activeScene && session.scheduledEvents.find(e => e.id === session.activeScene.eventId)?.branches?.[session.activeScene.branchKey]?.combatUpdate?.active) {
    return { kind: /交出|投降|surrender/i.test(text) && !/不|拒绝|don't/i.test(text) ? 'surrender' : /谈判|说服|分歧|negotia|persuad/i.test(text) ? 'negotiate' : 'escape', targetId: '', componentId: '', ids, text };
  }
  if (/说服|谈判|合作|persuad|convince|negotia/i.test(text)) return { kind: 'cooperate', targetId: npc?.id || '', componentId: '', ids, text };
  if (/拍|抄|复制|取样|装袋|录音|保存|保全|封存|photo|copy|record|sample|preserve/i.test(text)) {
    const clue = d.clues.find(c => c.id === ids[0]);
    const matched = clue?.components.filter(c => text.includes(c.action) || text.includes(c.name) || c.alternativeAction && text.includes(c.alternativeAction)) || [];
    return { kind: 'preserve', targetId: clue?.id || '', componentId: matched.length === 1 ? matched[0].id : clue?.components.length === 1 ? clue.components[0].id : '', ids, text };
  }
  if (/调查|检查|观察|搜索|查看|核对|解读|聆听|询问|追问|inspect|examine|investigate|search|listen|ask/i.test(text)) return { kind: 'investigate', targetId: ids[0] || npc?.id || '', componentId: '', ids, text };
  return { kind: 'unclear', targetId: '', componentId: '', ids, text };
}

export function validateGeneratedAction(session, input, proposal = null) {
  const a = proposal || classifyGeneratedAction(session, input), text = String(input);
  const reject = message => ({ ok: false, message: `【行动尚未执行】${message} 本次不消耗行动压力。` });
  const danger = !!session.combat?.active || !!session.activeScene && !!session.scheduledEvents.find(e => e.id === session.activeScene.eventId)?.branches?.[session.activeScene.branchKey]?.combatUpdate?.active;
  if (/然后|接着|随后|再去|；|;|\bthen\b/i.test(text)) return reject('请一次只选择一个目标，移动与调查分开执行。');
  if (/如果|假如|要不要|是否|do not|don't|不要/i.test(text)) return reject('请明确本次实际执行的行动，不执行假设或否定的动作。');
  if (a.kind === 'unclear') return { ...reject('请说明目标和做法，或选择已有选项。'), needsInterpretation: true };
  if (danger && !['escape','negotiate','surrender'].includes(a.kind)) return reject('请先处理眼前危险：脱离、谈判或交出争夺材料。');
  if (a.ids?.length > 1) return reject('请先选择一项证据目标。');
  let cost = 1;
  if (a.kind === 'move') {
    if (/调查|检查|询问|抄|拍|inspect|search|ask|copy/i.test(text)) return reject('先移动，抵达后的调查需另一次行动。');
    const route = knownRoute(session, a.targetId);
    if (!route) return reject('请指定一个已知且可达的地点。');
    if(route.slice(1).some(id=>session.scenarioFlags.generatedEffects?.restricted.includes(id))) return reject('通路已受限，请选择其他已知路线。');
    if (route.slice(1,-1).some(id => session.scenarioRules.locationCatalog[id]?.hazardous)) return reject('不能跳过途中危险地点，请先进入相邻地点。');
    const visited = progressState(session).visited || [];
    cost = route.every(id => visited.includes(id) && !session.scenarioRules.locationCatalog[id]?.hazardous) ? 0 : 1;
  } else if (a.kind === 'preserve') {
    if (!session.evidence.some(e => e.id === a.targetId && e.discovered !== false)) return reject('请先调查并发现这项材料，再进行保全。');
    const access = generatedComponentAccess(session, a.targetId, a.componentId);
    if (!access.ok) return reject(access.reason);
    const c = session.scenarioDefinition.clues.find(c => c.id === a.targetId)?.components.find(c => c.id === a.componentId);
    if (!hasCapability(session, c.capability)) return reject('缺少对应的取证工具。');
  } else if (a.kind === 'cooperate') {
    if (!canContactNpc(session, a.targetId)) return reject('目前无法与该证人直接交流。');
    if (session.scenarioFlags.cooperation?.[a.targetId]) return reject('合作已经取得，可直接询问或保存可接触材料。');
    if (session.scenarioFlags.failedApproaches?.[a.targetId]) return reject('这个交涉已失败，不能反复重掷；请使用调查笔记提示的替代材料来源。');
  } else if (a.kind === 'investigate') {
    if (a.targetId && !session.npcs.some(n => n.id === a.targetId) && !session.scenarioDefinition.clues.some(c => c.id === a.targetId)) return reject('请指定可接触的人物或材料，地点调查无需填写其他目标。');
    if (a.targetId.startsWith('npc_') && !canContactNpc(session, a.targetId)) return reject('请先与人物建立直接联系。');
    if (a.targetId.startsWith('evidence_') && !availableClues(session).some(c => c.id === a.targetId)) return reject('材料不在可接触范围，或尚缺少前置线索。');
  } else if (!['recover_hp','recover_stress','escape','negotiate','surrender'].includes(a.kind)) return reject('该行动类型无效。');
  return { ok: true, cost, kind: a.kind, proposal: a };
}
function availableClues(session) {
  return session.scenarioDefinition.clues.filter(c => c.requires.every(id => session.evidence.some(e => e.id === id && e.discovered !== false))
    && c.components.some(component => component.locationId === session.playerLocationId || component.alternativeLocationId === session.playerLocationId || component.npcId && canContactNpc(session, component.npcId)));
}
function skillCheck(session, skill, damage = false) {
  const value = Number(new RegExp(`${skill}[：:\\s]+(\\d+)`).exec(session.player)?.[1] || 25);
  const player = session.npcs.find(n => n.id === 'npc_000');
  return { type: 'skill_check', trigger: 'player', target: 'player', skill_name: skill, skill_point: value, bonus_dice: 0, penalty_dice: 0,
    on_success: [], on_fail: damage ? [{ target: 'player', attr: 'hp', effect: 'damage', diceCount: 1, diceSides: Math.max(2, Math.ceil((player?.maxHp || 10) / 4)), diceBonus: 0 }] : [], on_critical_success: [], on_critical_failure: [] };
}
export function prepareGeneratedAction(session, input) {
  const s = progressState(session);
  const a = session.scenarioFlags.actionProposal || classifyGeneratedAction(session, input);
  delete session.scenarioFlags.actionProposal;
  const preflight = validateGeneratedAction(session, input, a);
  if (!preflight.ok) throw new Error(preflight.message);
  const tx = { ...a, id: `${session.id}:${session.scenarioClock.turn + 1}`, input, checks: [], receipts: [], resolved: false,
    wasCombat: !!session.combat?.active, hpBefore: session.npcs.find(n => n.id === 'npc_000')?.hp, travelOnly: preflight.cost === 0 };
  s.transaction = tx;
  if (['cooperate','negotiate','escape'].includes(a.kind)) tx.checks.push(skillCheck(session, a.kind === 'escape' ? '闪避' : '说服', a.kind === 'escape'));
  const clue = availableClues(session).find(c => c.id === a.targetId) || (!a.targetId ? availableClues(session).find(c => !session.evidence.some(e => e.id === c.id)) : null);
  if (a.kind === 'investigate' && /解读|辨认|隐藏|聆听|谎言/.test(input) && !s.attempted.includes(`${a.kind}:${a.targetId}`)) tx.checks.push(skillCheck(session, /聆听/.test(input) ? '聆听' : /谎言/.test(input) ? '心理学' : /解读/.test(input) ? '图书馆使用' : '侦查'));
  if (clue && a.kind === 'investigate') tx.discoveryId = clue.id;
  const event = session.scenarioDefinition.events.find(e => e.id === session.activeScene?.eventId && e.exposure !== 'none');
  if (event && !session.sanity.resolvedEventIds.includes(event.id) && (event.locationId === session.playerLocationId || event.kind === 'crisis')) {
    tx.checks.push({ type: 'sancheck', trigger: 'others', target: 'player', san_event_id: event.id, san_severity: event.exposure });
    // The same event can confront the player at a different location.
    session.scenarioRules.sanEvents[event.id].locationId = session.playerLocationId;
  }
  const exposure=session.scenarioFlags.pendingPsychologicalExposure?.find(id=>!session.sanity.resolvedEventIds.includes(id)&&session.scenarioRules.sanEvents[id]?.locationId===session.playerLocationId);
  if(exposure && !tx.checks.some(c=>c.type==='sancheck')) tx.checks.push({type:'sancheck',trigger:'others',target:'player',san_event_id:exposure,san_severity:'unease'});
  if(s.analysisAdvantage && tx.checks.some(c=>c.type==='skill_check')) {tx.checks.find(c=>c.type==='skill_check').bonus_dice=1;s.analysisAdvantage=false;tx.receipts.push('【分析优势】此前核对材料获得的一次奖励骰已用于本次检定。');}
  tx.receipts.push(`【行动消耗】${tx.travelOnly ? 0 : 1}次有效行动。`);
  if (!tx.checks.length) resolveGeneratedAction(session);
  return tx;
}
export function resolveGeneratedAction(session) {
  const s = progressState(session), tx = s.transaction;
  if (!tx || tx.resolved) return;
  tx.resolved = true;
  const d = session.scenarioDefinition, p = session.npcs.find(n => n.id === 'npc_000');
  const skillResults = (tx.checkResults || []).filter(r => r.skill !== 'SAN');
  const success = !skillResults.some(r => !r.success);
  if (tx.checks.some(c => c.type === 'skill_check')) s.attempted.push(`${tx.kind}:${tx.targetId}`);
  if(tx.kind==='investigate' && success && tx.checks.some(c=>c.type==='skill_check')) {s.analysisAdvantage=true;tx.receipts.push('【分析优势】交叉核对成功，下一次技能检定获得一次奖励骰。');}
  if (tx.kind === 'move') {
    for (const companion of d.npcs.filter(n => n.companionIndex !== null)) {
      const npc = session.npcs.find(n => n.id === companion.id);
      if (npc && npc.status !== 'departed' && npc.locationId === session.playerLocationId) npc.locationId = tx.targetId;
    }
    session.playerLocationId = tx.targetId; p.locationId = tx.targetId;
    s.visited ||= []; if (!s.visited.includes(tx.targetId)) s.visited.push(tx.targetId);
    revealNeighborhood(session);
    tx.receipts.push(`【移动】到达${session.locations.find(l => l.id === tx.targetId).name}。`);
  }
  if (tx.kind === 'cooperate') {
    if (success) { session.scenarioFlags.cooperation[tx.targetId] = true; tx.receipts.push('【合作已取得】证人同意提供可接触的材料；保全需要下一行动。'); }
    else { session.scenarioFlags.failedApproaches[tx.targetId] = true; tx.receipts.push('【交涉未成】对方拒绝此次请求；已有线索不变，可调查独立存根或其他材料。'); }
    for (const c of d.clues) for (const component of c.components.filter(c => c.npcId === tx.targetId)) if (component.alternativeLocationId) {
      const l = d.locations.find(l => l.id === component.alternativeLocationId);
      if (!session.locations.some(x => x.id === l.id)) session.locations.push({ id: l.id, name: l.name, description: '证人透露此处有独立材料来源。' });
    }
  }
  if (tx.discoveryId) {
    const c = d.clues.find(c => c.id === tx.discoveryId);
    if (!session.evidence.some(e => e.id === c.id)) session.evidence.push({ id: c.id, source: c.name, description: c.description, discovered: true, secured: false, artifacts: [], reliability: 'high', category: 'document' });
    tx.receipts.push(`【发现线索】${c.name}：${c.description} 尚未保全，请查看证据详情。${success ? '' : '深入分析未取得优势，但基本线索不会被失败封锁。'}`);
  } else if (tx.kind === 'investigate') tx.receipts.push('【调查完成】未发现新的可确认材料；请核对已有笔记或前往已知通路。');
  if (tx.kind === 'preserve') {
    const c = d.clues.find(c => c.id === tx.targetId), record = session.evidence.find(e => e.id === c.id);
    const access = generatedComponentAccess(session, c.id, tx.componentId);
    if (access.ok) {
      record.artifacts ||= [];
      if (!record.artifacts.some(a => a.component === tx.componentId && a.custody === 'player')) record.artifacts.push({ component: tx.componentId, custody: 'player', actionId: tx.id });
      record.secured = c.components.every(component => record.artifacts.some(a => a.component === component.id && a.custody === 'player'));
      tx.receipts.push(`【${record.secured ? '证据已保全' : '组件已保全'}】${c.name}：${record.secured ? '可用于证明。' : '仍需补足其他组件。'}`);
    }
  }
  if (tx.kind === 'recover_hp') {
    const injury = s.injuries.find(i => !i.treated);
    if (s.dressings > 0 && injury && p.hp < p.maxHp) { const amount = Math.min(Math.max(1, Math.ceil(p.maxHp / 6)), injury.damage, p.maxHp-p.hp); p.hp += amount; injury.treated = true; s.dressings--; tx.receipts.push(`【包扎完成】生命恢复${amount}，剩余${s.dressings}份敷料。`); }
    else tx.receipts.push('【无法恢复】没有可处理的新伤，或恢复用品已用完。');
  }
  if (tx.kind === 'recover_stress') {
    if (s.grounding < 2) { s.grounding++; session.sanity.activeTrauma = null; tx.receipts.push(`【情绪稳定】暂时压力缓解，${resourceLabel(session)}数值不变。`); }
    else tx.receipts.push('【休整已用完】本局两次休整机会已经使用。');
  }
  if (tx.wasCombat) {
    s.exchanges = (s.exchanges || 0) + 1;
    if (tx.kind === 'surrender' || success || s.exchanges >= 3) {
      session.finaleState ||= {};
      session.finaleState.crisisSnapshot ||= copy(session.combat);
      let outcome = tx.kind === 'surrender' ? d.crisis.surrender : success ? tx.kind === 'negotiate' ? d.crisis.negotiation : d.crisis.escape : d.crisis.setback;
      if (tx.kind === 'surrender') for (const e of session.evidence.filter(e => d.crisis.contestedClueIds.includes(e.id))) {
        for (const a of e.artifacts || []) a.custody = 'opponent'; e.secured = false;
      }
      session.finaleState.resolutionOutcome = { kind: tx.kind === 'surrender' ? 'surrender' : success ? 'resolved' : 'forced_retreat', text: outcome };
      session.combat = null; session.scenarioFlags.finale_crisis_resolved = true; s.climaxResolvedAt = s.actions + 1;
      tx.receipts.push(`【危机结束】${outcome} 没有因此获得新证据。`);
    }
  }
  s.receipts = tx.receipts;
}
export function advanceGenerated(session) {
  const s = progressState(session), m = session.scenarioRules.milestones;
  if (!s.transaction?.travelOnly) s.actions++;
  applyGeneratedEffects(session);
  s.act = s.actions >= m.gate ? 'finale' : s.actions >= m.consolidation || session.scenarioFlags.finale_crisis_resolved ? 'consolidation' : s.actions >= m.crisis ? 'confrontation' : s.actions >= Math.round(m.gate*.25) ? 'investigation' : 'opening';
  const eligible = [];
  for (const e of session.scheduledEvents) {
    const advance = e.advanceClueIds?.some(id => session.evidence.some(c => c.id === id && c.discovered !== false)) ? 2 : 0;
    if (!e.fired && e.status === 'dormant' && s.actions >= Math.max(1,e.dueAction-advance)) { e.status = 'eligible'; e.eligibleAtAction = s.actions; eligible.push(e); }
  }
  const previous = session.scenarioClock.currentTime, minutes = Math.min(360,10+Math.floor(s.actions*350/m.gate));
  session.scenarioClock.currentTime = `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
  session.scenarioClock.turn++;
  session.scenarioClock.phase = {opening:'hook',investigation:'investigation',confrontation:'crisis',consolidation:'aftermath',finale:'finale'}[s.act];
  return { advanced: true, cost: 0, previous, currentTime: session.scenarioClock.currentTime, deadlineReached: s.actions >= m.gate, newlyEligibleEvents: eligible, firedEvents: [], revealedLocations: [] };
}
export function generatedOptions(session) {
  const local = availableClues(session), pending = session.evidence.find(e => !e.secured);
  const consolidating=progressState(session).actions >= session.scenarioRules.milestones.consolidation;
  const next = !consolidating && local.find(c => !session.evidence.some(e => e.id === c.id));
  const adjacent = session.scenarioRules.locationGraph[session.playerLocationId] || [];
  const destination = session.locations.find(l => adjacent.includes(l.id) && !progressState(session).visited?.includes(l.id)) || session.locations.find(l => adjacent.includes(l.id));
  const preserve = pending && session.scenarioDefinition.clues.find(c => c.id === pending.id)?.components.find(c => generatedComponentAccess(session, pending.id, c.id).ok);
  return [`A. ${next ? `调查${next.name}` : consolidating ? '查看调查笔记' : '调查当前现场'}`, `B. ${preserve ? generatedComponentAccess(session,pending.id,preserve.id).source === 'alternative' ? preserve.alternativeAction : preserve.action : '查看调查笔记'}`, `C. ${destination ? `进入${destination.name}` : '查看调查笔记'}`, 'D. 自由行动'];
}
