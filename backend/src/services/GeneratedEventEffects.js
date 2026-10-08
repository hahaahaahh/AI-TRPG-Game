export function queueGeneratedEffects(session,event) {
  if(session.scenarioSource!=='generated' || !event.consequences?.length) return;
  const flags=session.scenarioFlags;
  flags.generatedEffects ||= {applied:[],pending:[],unavailable:[],restricted:[]};
  const state=flags.generatedEffects;
  event.consequences.forEach((effect,index)=>{
    const id=`${event.id}:${index}`;
    if(!state.applied.includes(id)&&!state.pending.some(e=>e.id===id)) state.pending.push({id,effect,eventId:event.id,
      due:(event.announcedAction ?? session.scenarioFlags.investigation.actions)+(event.minimumResponseTurns||0)});
  });
  applyGeneratedEffects(session);
}
export function applyGeneratedEffects(session) {
  const state=session.scenarioFlags?.generatedEffects;
  if(!state) return;
  const action=session.scenarioFlags.investigation.actions;
  for(const entry of [...state.pending]) {
    if(entry.due>action || state.applied.includes(entry.id)) continue;
    const c=entry.effect;
    if(c.type==='source_unavailable') state.unavailable.push(`${c.targetId}:${c.componentId}`);
    if(c.type==='access_restriction') state.restricted.push(c.targetId);
    if(c.type==='witness_depart'||c.type==='witness_move') {
      const npc=session.npcs.find(n=>n.id===c.targetId);
      if(npc) {if(c.type==='witness_depart') npc.status='departed'; else npc.locationId=c.destinationId;}
    }
    if(c.type==='psychological_exposure') {
      const id=`${entry.eventId}_exposure`;
      session.scenarioRules.sanEvents[id]={severity:'unease',locationId:c.targetId,at:'00:00'};
      session.scenarioFlags.pendingPsychologicalExposure ||= [];
      session.scenarioFlags.pendingPsychologicalExposure.push(id);
    }
    state.applied.push(entry.id); state.pending=state.pending.filter(e=>e.id!==entry.id);
  }
}
