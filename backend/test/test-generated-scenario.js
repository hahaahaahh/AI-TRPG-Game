import assert from 'node:assert/strict';
import { validateGeneratedScenario, investigationMilestones, INVESTIGATION_LENGTHS } from '../src/domain/GeneratedScenario.js';
import { ScenarioGenerationService } from '../src/services/ScenarioGenerationService.js';
import { GameSession } from '../src/domain/GameSession.js';
import { buildStrictTools } from '../src/domain/StrictSchemaRegistry.js';
import { generatedComponentAccess, generatedEvidenceDetails, canContactNpc } from '../../src/shared/GeneratedInvestigationRules.mjs';

import { fixture } from './fixtures/generated-case.js';

for (const length of Object.keys(INVESTIGATION_LENGTHS)) {
  assert.equal(validateGeneratedScenario(fixture(), { length }).ok, true);
  assert.equal(investigationMilestones(length).gate, INVESTIGATION_LENGTHS[length].gate);
}
for (const mutate of [
  d => d.locations[0].connections.push('loc_999'),
  d => { d.locations[0].connections = []; d.locations[1].connections = []; },
  d => d.clues[0].requires.push('evidence_001'),
  d => d.clues[0].components[0].npcId = 'npc_999',
  d => d.clues[0].components[0].capability = 'unavailable',
  d => d.clues[0].components[0].alternativeLocationId = null,
  d => d.endings.incomplete = '未完待续',
  d => d.events[0].options = ['A. 一个选项'],
  d => d.script = 'arbitrary code',
  d => d.locations.push(structuredClone(d.locations[0])),
]) { const definition = fixture(); mutate(definition); assert.equal(validateGeneratedScenario(definition).ok, false); }
assert.equal(validateGeneratedScenario(fixture(), {}, 1).ok, false);
const service = new ScenarioGenerationService();
const session = new GameSession({ worldSettings: '历史调查', player: '姓名：探员', investigationSetup: { mode: 'guided', length: 'standard', psychologicalPresentation: 'stress' } });
let requests = 0;
await service.prepare(session, { async generate(request) {
  requests++;
  assert.equal(request.maxTokens, 8192);
  assert.equal(request.flowType, 'SCENARIO_GEN');
  return { content: requests === 1 ? '{}' : JSON.stringify(fixture()) };
} });
assert.equal(requests, 2);
assert.equal(session.generationStatus.stage, 'ready');
const restored = new GameSession(session.toJSON());
await service.prepare(restored, { generate() { throw new Error('Validated definition must be reused.'); } });
assert.deepEqual(restored.scenarioDefinition, session.scenarioDefinition);
const failing = new GameSession({ investigationSetup: { mode: 'guided' } });
let failures = 0;
await assert.rejects(service.prepare(failing, { async generate() { failures++; return { content: 'bad JSON' }; } }), /设定已保留/);
assert.equal(failures, 3);
assert.equal(failing.scenarioDefinition, null);
assert.equal(failing.scenarioId, null);
assert.equal(failing.generationStatus.stage, 'failed');
assert.equal(buildStrictTools('SCENARIO_GEN').tools[0].function.name, 'output_scenario');
Object.assign(session, { locations: [{ id: 'loc_001', name: '会客室' }], playerLocationId: 'loc_001',
  npcs: [{ id: 'npc_001', name: '管理员', locationId: 'loc_001', visibility: 'visible', status: 'active' }],
  inventory: [{ id: 'item_001', status: '已获得' }], evidence: [{ id: 'evidence_001', discovered: true, secured: false }], scenarioFlags: {} });
assert.equal(canContactNpc(session, 'npc_001'), true);
assert.equal(generatedComponentAccess(session, 'evidence_001', 'copy').ok, false);
assert.equal(generatedEvidenceDetails(session, 'evidence_001').rows[0].action.kind, 'cooperate');
session.scenarioFlags.cooperation = { npc_001: true };
assert.equal(generatedComponentAccess(session, 'evidence_001', 'copy').ok, true);
session.npcs[0].locationId = 'loc_002';
assert.equal(canContactNpc(session, 'npc_001'), false);
assert.equal(generatedComponentAccess(session, 'evidence_001', 'copy').ok, false);
assert.doesNotMatch(JSON.stringify(generatedEvidenceDetails(session, 'evidence_001')), /资料室|loc_002|公开账册存根/);
session.playerLocationId = 'loc_002';
assert.equal(generatedComponentAccess(session, 'evidence_001', 'copy').source, 'alternative');
session.playerLocationId = 'loc_001';
session.evidence[0].artifacts = [{ component: 'copy', custody: 'player' }];
assert.equal(generatedComponentAccess(session, 'evidence_001', 'copy').source, 'held');
console.log('Generated scenario contract, references, access alternatives, cycles, budgets, repairs and persistence passed.');
