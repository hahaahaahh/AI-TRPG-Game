// Documentation captures: real UI, isolated browser storage, no model credentials.
// Set PLAYWRIGHT_MODULE to an installed Playwright entry point, then run after npm run build.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {GameOrchestrator} from '../backend/src/orchestrator/GameOrchestrator.js';
import {RequestSessionRepository} from '../backend/src/persistence/RequestSessionRepository.js';
import {GameSession} from '../backend/src/domain/GameSession.js';
import {createApp} from '../backend/src/api/GameController.js';
const require=createRequire(new URL('../backend/package.json',import.meta.url));
const express=require('express');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const output=fileURLToPath(new URL('../docs/screenshots/',import.meta.url));
const provider={apiKey:'documentation-only',model:'界面演示（无模型调用）',async generate(){throw new Error('Documentation capture forbids model generation');}};
const repository=new RequestSessionRepository();
const engine=new GameOrchestrator({repository,llmProvider:provider});
const opening=engine.createBirchStationTutorial().session;
const app=express();
app.get('/capture-store.js',(_req,res)=>res.sendFile(root+'src/persistence/SessionStore.js'));
app.use(createApp({llmProvider:provider}));
app.use(express.static(root+'dist'));
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  await mkdir(output,{recursive:true});
  browser=await chromium.launch({channel:process.env.CAPTURE_BROWSER || 'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2,locale:'zh-CN',colorScheme:'light'});
  // Never send requests outside this disposable local server.
  await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(()=>location.hash.length>1 && document.querySelector('#messages')?.children.length>0);
  async function load(session){
    await page.evaluate(async s=>{const {sessionStore}=await import('/capture-store.js');await sessionStore.saveSession(s);localStorage.setItem('ai-trpg-theme','light');localStorage.setItem('ai-trpg-current-session-id',s.id);},session);
    await page.goto(origin+'/?capture='+Date.now()+'#'+session.id);
    await page.waitForFunction(id=>location.hash==='#'+id && document.querySelector('#messages')?.children.length>0,session.id);
    await page.evaluate(()=>document.fonts.ready);
  }
  async function shot(name){await page.screenshot({path:output+name,animations:'disabled'});console.log(name);}
  await load(opening);
  await page.locator('#messages').evaluate(el=>{el.scrollTop=0;});
  await shot('01-birch-opening.png');
  const details=page.locator('#evidence-panel summary').first();
  if(await details.count())await details.click();
  await page.locator('#evidence-panel').scrollIntoViewIfNeeded();
  await page.locator('#evidence-panel').screenshot({path:output+'02-evidence-details.png',animations:'disabled'});
  const setup=new GameSession({id:crypto.randomUUID(),title:'自由剧本：玩法选择',phase:'CHARACTER_SETTING',subState:'AWAITING_INPUT',
    worldSettings:'十九世纪的海港商行。一份账册失踪，调查以人证和文书为基础，没有超自然力量。',
    player:'姓名：调查员\n职业：文书调查员\nHP：12 SAN：60\n侦查：60 说服：60 图书馆使用：60',
    displayLog:[{role:'system',content:'世界与主角设定已就绪。点击「直接进入故事开幕」，选择本次玩法。'}]});
  await load(setup.toClientJSON());
  await page.getByRole('button',{name:'直接进入故事开幕',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').screenshot({path:output+'03-guided-mode-selector.png',animations:'disabled'});
  if(errors.length)throw new Error(errors.join('\n'));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
