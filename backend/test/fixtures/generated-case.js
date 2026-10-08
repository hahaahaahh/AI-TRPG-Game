export function stagedFixture(stage, d=fixture()) {
  if(stage==='outline') return {title:d.title,hook:d.hook,hiddenTruth:d.hiddenTruth,initialLocationIndex:d.locations.findIndex(l=>l.id===d.initialLocationId),
    locations:d.locations.map(({id,...l})=>({...l,connections:l.connections.map(id=>d.locations.findIndex(x=>x.id===id))})),
    npcs:d.npcs.map(({id,locationId,...n})=>({...n,locationIndex:d.locations.findIndex(l=>l.id===locationId)})),
    clues:d.clues.map(({name,description,keywords})=>({name,description,keywords})), proofs:d.proofs.map(({statement})=>({statement})),events:d.events.map(({title,kind})=>({title,kind}))};
  if(stage==='routes') return {equipment:d.equipment.map(({id,...e})=>({...e,capabilities:e.capabilities.map(c=>c==='copy'?'record_text':c)})),clues:d.clues.map(c=>({id:c.id,requires:c.requires,components:c.components.map(({id,locationId,npcId,...c})=>({...c,capability:c.capability==='copy'?'record_text':c.capability,source:{type:npcId?'npc':'location',id:npcId||locationId}}))})),proofs:d.proofs.map(({id,evidenceIds})=>({id,evidenceIds}))};
  return {events:d.events.map(({title,kind,options,...e})=>({...e,responses:['negotiate','escape','surrender'].map((actionId,i)=>({label:['谈判','脱身','交出材料'][i],actionId})),consequences:[]})),crisis:d.crisis,endings:d.endings};
}
export function fixture() {
  return { title: '失踪的账册', hook: '有人请求你找回一份账册。', hiddenTruth: '账册证明合伙人侵吞收入。', initialLocationId: 'loc_001',
    locations: [{ id: 'loc_001', name: '会客室', description: '可安全讨论调查的房间。', connections: ['loc_002'], hazardous: false },
      { id: 'loc_002', name: '资料室', description: '公开资料存放于此。', connections: ['loc_001'], hazardous: false }],
    npcs: [{ id: 'npc_001', name: '管理员', description: '负责保管材料。', motivation: '保住工作。', locationId: 'loc_001', companionIndex: null }],
    equipment: [{ id: 'item_001', name: '笔记工具', description: '用于抄录并标注来源。', capabilities: ['copy'] }],
    clues: [{ id: 'evidence_001', name: '账册', description: '账目留下不一致的数额。', keywords: ['账册', '账目'], requires: [], components: [
      { id: 'copy', name: '账册副本', locationId: null, npcId: 'npc_001', needsCooperation: true, capability: 'copy', action: '抄录账册', alternativeLocationId: 'loc_002', alternativeAction: '抄录公开账册存根' },
    ] }],
    proofs: [{ id: 'fact_001', statement: '资金被合伙人挪用。', evidenceIds: ['evidence_001'] }],
    events: [{ id: 'event_001', title: '索回资料', kind: 'crisis', locationId: 'loc_001', playerCue: '来人挡住去路，要求归还材料。', offscreenCue: '门外传来索要材料的争执声。', aftermathCue: '门前留下争执的痕迹。', options: ['A. 谈判', 'B. 保护记录', 'C. 寻找退路', 'D. 自由行动'], participants: ['npc_001'], threatenedClueIds: [], advanceClueIds: [], exposure: 'unease' }],
    crisis: { objective: '保护已掌握的材料并离开', escape: '经侧门安全离开。', negotiation: '对方同意停止围堵。', surrender: '交出争夺的材料后获准离开。', setback: '被赶出现场，不能继续取证。', contestedClueIds: ['evidence_001'] },
    endings: { expose: '公开已保全的材料。', preserve: '保留副本，等待可靠审查。', destroy: '放弃公开并销毁自己的副本。', withdraw: '退出本次调查。', incomplete: '材料不足以证明指控，案件以证据不足收束。' },
  };
}
