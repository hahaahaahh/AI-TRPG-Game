// Minimal, sanitized reproductions of the observed provider failures; no credentials/story spoilers.
export const oldActions = [
  {kind:'preserve',targetId:'loc_002',componentId:'component_001'},
  {kind:'notebook',targetId:'',componentId:'component_001'},
  {kind:'cooperate',targetId:'npc_001',componentId:'component_002'},
];
export function malformedRoutes(valid) {
  const draft=structuredClone(valid);
  draft.proofs[0].id='proof_001';
  draft.clues[0].components[0].source.npcId='npc_001';
  draft.clues[0].components[0].capability='说服';
  return draft;
}
