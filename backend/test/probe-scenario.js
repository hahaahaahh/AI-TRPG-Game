// Opt-in, one billable generation per invocation; never part of test:all.
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { getLLMProfiles } from '../src/config/LLMConfig.js';
import { LLMProviderRegistry } from '../src/llm/LLMProviderRegistry.js';
import { GameSession } from '../src/domain/GameSession.js';
import { inputAssembler } from '../src/services/InputAssembler.js';
import { validateGeneratedScenario } from '../src/domain/GeneratedScenario.js';
dotenv.config({ quiet: true });
const registry = new LLMProviderRegistry(getLLMProfiles());
const id = process.argv[2];
if (!registry.has(id)) throw new Error('Select an existing model profile; no automatic fallback.');
const { provider, profile } = registry.resolve(id);
const session = new GameSession({ id: 'scenario-policy-probe' });
session.worldSettings = '非恐怖历史商行调查：有人篡改账目掩盖货物亏空，没有超自然现象。';
session.player = '姓名：陈安\n职业：独立调查员\nHP：12 SAN：60\n侦查：60 说服：60 图书馆使用：60';
session.investigationSetup = { mode: 'guided', length: 'standard', psychologicalPresentation: 'stress' };
const report = { id, startedAt: new Date().toISOString(), policy: profile.flowPolicies.SCENARIO_GEN };
const start = Date.now();
try {
  const response = await provider.generate(inputAssembler.assemble('SCENARIO_GEN', session));
  report.usage = response.usage;
  report.finishReason = response._diagnostic?.finishReason;
  report.rawContent = response.content;
  const definition = JSON.parse(response.content);
  report.rootKeys = Object.keys(definition || {});
  report.rootTypes = Object.fromEntries(Object.entries(definition || {}).map(([key, value]) => [key, Array.isArray(value) ? 'array' : typeof value]));
  report.validation = validateGeneratedScenario(definition, session.investigationSetup, 0);
  // Generated diagnostic content, not a player save or executable scenario file.
  report.definition = definition;
} catch (error) { report.error = error.message; }
report.elapsedMs = Date.now() - start;
await mkdir('../.player-runtime', { recursive: true });
const path = `../.player-runtime/scenario-probe-${provider.provider}-${Date.now()}.json`;
await writeFile(path, JSON.stringify(report, null, 2));
const { definition, rawContent, ...summary } = report;
console.log(JSON.stringify({ ...summary, path }));
