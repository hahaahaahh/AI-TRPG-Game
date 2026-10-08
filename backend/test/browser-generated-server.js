// Isolated UI smoke-test server, never uses credentials or real providers.
import express from 'express';
import { createApp } from '../src/api/GameController.js';
import { GameSession } from '../src/domain/GameSession.js';
import { stagedFixture } from './fixtures/generated-case.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
let preparationCalls=0;
const mockControl={delayMs:Number(process.env.MOCK_DELAY_MS || 1500),narrationDelayMs:0,failures:Number(process.env.MOCK_FAIL_PREPARATION || 0),distinct:false};
const heldRequests=new Set();
async function waitForTestRelease(flowType) {
  if(!mockControl.hold) return;
  await new Promise(resolve=>heldRequests.add({flowType,resolve}));
}
const provider={apiKey:'mock',model:'browser-mock',async generate(request){
  await waitForTestRelease(request.flowType);
  if(request.flowType==='SCENARIO_GEN') {await new Promise(r=>setTimeout(r,mockControl.delayMs)); preparationCalls++;
    if(preparationCalls<=mockControl.failures) return {content:mockControl.distinct?JSON.stringify({['invalid_'+preparationCalls]:true}):'{}'};
    return{content:JSON.stringify(stagedFixture(JSON.parse(request.messages[1].content).stage))};}
  if(request.flowType==='HISTORY_SUMMARY') return{content:JSON.stringify({summary:'已确认的行动以引擎为准。'})};
  if(request.flowType==='ENDING_GEN') throw new Error('Browser mock ending fallback');
  await new Promise(r=>setTimeout(r,mockControl.narrationDelayMs));
  return{content:JSON.stringify({narration:'会客室里，管理员正在整理纸张。你确认了现在可以接触的资料，准备决定下一步调查方向。'.repeat(15),locations:[],npcs:[],items:[],actions:null,options:['A. 调查账册','B. 查看调查笔记','C. 进入资料室','D. 自由行动'],current_location_id:'loc_001',active_event_ack:null,time_cost_minutes:0,time_cost_rationale:'',evidence_changes:[],suspicion_delta:0,combat_update:null})};
}};
const app=express();app.use(express.json({limit:'2mb'}));
// Only this explicit mock executable serves fault-injection controls. Production never imports it.
if(process.env.MOCK_UI_CONTROLS==='1') {
  app.post('/__test/control',(req,res)=>{
    mockControl.delayMs=Math.max(0,Math.min(30000,Number(req.body.delayMs)||0));
    mockControl.narrationDelayMs=Math.max(0,Math.min(30000,Number(req.body.narrationDelayMs)||0));
    mockControl.failures=Math.max(0,Math.min(6,Number(req.body.failures)||0));
    mockControl.distinct=Boolean(req.body.distinct);preparationCalls=0;res.json(mockControl);
  });
  app.post('/__test/hold',(req,res)=>{mockControl.hold=Boolean(req.body.hold);res.json({hold:mockControl.hold});});
  app.get('/__test/status',(_req,res)=>res.json({held:[...heldRequests].map(r=>r.flowType),preparationCalls}));
  app.post('/__test/release',(_req,res)=>{mockControl.hold=false;for(const r of heldRequests)r.resolve();heldRequests.clear();res.json({released:true});});
  app.get('/__test/store.js',(_req,res)=>res.sendFile(fileURLToPath(new URL('../../src/persistence/SessionStore.js',import.meta.url))));
  app.get('/__test/controls.js',(_req,res)=>res.sendFile(fileURLToPath(new URL('./browser-test-controls.js',import.meta.url))));
  app.get('/',async(_req,res)=>res.type('html').send((await readFile(new URL('../../dist/index.html',import.meta.url),'utf8')).replace('</body>','<script type="module" src="/__test/controls.js"></script></body>')));
}
app.post('/api/sessions',(req,res)=>res.json({session:new GameSession({id:crypto.randomUUID(),title:'浏览器隔离测试',worldSettings:'无超自然的历史商行调查',player:'姓名：测试探员\nHP：12 SAN：60\n说服：60 闪避：60 侦查：60 图书馆使用：60'}).toClientJSON()}));
app.use(createApp({llmProvider:provider}));app.use(express.static(new URL('../../dist',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')));
const server=app.listen(5188,'127.0.0.1',()=>console.log('Mock browser server http://127.0.0.1:5188 (no real API calls)'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
