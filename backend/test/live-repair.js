// Paid opt-in ONLY. Two saved checkpoints, at most two calls each; no gameplay or HTTP retries.
import dotenv from 'dotenv';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {getLLMProfiles} from '../src/config/LLMConfig.js';
import {LLMProviderRegistry} from '../src/llm/LLMProviderRegistry.js';
import {GameSession} from '../src/domain/GameSession.js';
import {scenarioGenerationService} from '../src/services/ScenarioGenerationService.js';
if(!process.argv.includes('--approved-four-call-cap')) throw new Error('Requires explicit user approval and --approved-four-call-cap');
dotenv.config({quiet:true});
const registry=new LLMProviderRegistry(getLLMProfiles());
const report={startedAt:new Date().toISOString(),maxCalls:4,calls:0,cases:[]};
const reportFile=`live-repair-${Date.now()}.json`;
// Resume this explicitly bounded campaign after one interrupted Qwen request.
const remainingOnly=process.argv.includes('--remaining-three-after-interruption');
if(remainingOnly){report.maxCalls=3;report.priorInterruptedCalls=1;}
for(const [profile,file] of [
  ['soclaas:qwen3.8:27b','live-staged-soclaas-1789584462108.json'],
  ['deepseek:deepseek-flash','live-staged-deepseek-1789584169882.json'],
]) {
  const previous=JSON.parse(await readFile(new URL(`../../.player-runtime/${file}`,import.meta.url),'utf8'));
  const checkpoint=previous.cases[0].preparation;
  const snapshot=JSON.parse(checkpoint.setupSnapshot);
  const session=new GameSession({id:`repair-${crypto.randomUUID()}`,worldSettings:snapshot.world,player:snapshot.player,keyCharacters:snapshot.companions,
    investigationSetup:snapshot.setup,llmProfileId:profile,scenarioPreparation:structuredClone(checkpoint)});
  const provider=registry.resolve(profile).provider;
  provider.maxRetries=0; // Instance-local test setting; never changes .env or normal runtime policy.
  let calls=0;
  const callLimit=remainingOnly&&profile.startsWith('soclaas:')?1:2;
  const bounded={async generate(request){
    if(calls>=callLimit||report.calls>=report.maxCalls)throw new Error('Repair test cap reached');calls++;report.calls++;
    console.log(JSON.stringify({profile,call:calls,phase:'request_started'}));
    const response=await provider.generate(request);
    await mkdir(new URL('../../.player-runtime/',import.meta.url),{recursive:true});
    await writeFile(new URL(`../../.player-runtime/${reportFile}.${report.calls}.response.json`,import.meta.url),JSON.stringify(response,null,2));
    console.log(JSON.stringify({profile,call:calls,phase:'response_saved_validating'}));
    return response;
  }};
  const metricsStart=checkpoint.metrics?.length || 0;
  for(let i=0;i<callLimit;i++) {
    const status=await scenarioGenerationService.step(session,bounded,{command:i===0?'continue':null});
    console.log(JSON.stringify({profile,calls,status,stage:session.scenarioPreparation.stage,issues:session.scenarioPreparation.issues}));
    if(['ready','paused'].includes(status))break;
  }
  report.cases.push({profile,calls,ready:!!session.scenarioDefinition,stage:session.scenarioPreparation.stage,
    issues:session.scenarioPreparation.issues,metrics:session.scenarioPreparation.metrics.slice(metricsStart),checkpoint:session.scenarioPreparation});
  await mkdir(new URL('../../.player-runtime/',import.meta.url),{recursive:true});
  await writeFile(new URL(`../../.player-runtime/${reportFile}`,import.meta.url),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({report:`.player-runtime/${reportFile}`,calls:report.calls,results:report.cases.map(({profile,ready,stage})=>({profile,ready,stage}))}));
