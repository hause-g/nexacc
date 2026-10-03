'use strict';
// Chrome real, perfis descartáveis, somente rotas/contas fictícias em servidor isolado.
// Cobre a deduplicação de arquivos entre MAIN e ISOLATED que a VM única não reproduz.
const fs=require('fs'),path=require('path'),http=require('http'),os=require('os'),assert=require('assert/strict');
const {spawn}=require('child_process');
let chromium;
({chromium}=require('./artefatos_helpers.cjs').playwright());
const ROOT=path.resolve(__dirname,'..');
const executable=[process.env.AGENTUM_TEST_CHROMIUM,path.join(os.homedir(),'AppData/Local/ms-playwright/chrome-win64/chrome.exe'),chromium.executablePath()].find(p=>p&&fs.existsSync(p));
assert.ok(executable,'Chrome/Chromium de teste necessário; informe AGENTUM_TEST_CHROMIUM. Não usar perfil pessoal.');
const fixture=(route)=>{
 if(route.endsWith('/directReportV5'))return {code:1,data:{list:[{userIdx:'12345678901234567890',account:'membro-teste',deposit:10,validBet:20,isDeposit:true}],pageNo:1,totalPages:1,more:false,total:1}};
 if(route.endsWith('/myPeriodDataV2'))return {code:1,data:{timeTotalDeposit:10,timeTotalDepositPerson:1,timeTotalWithdraw:0}};
 if(route.endsWith('/orderListV3'))return {code:1,data:{records:[{order_no:'211000000000000000001',amount:10,status:2},{order_no:'211000000000000000002',amount:10,status:1}]}};
 if(route.endsWith('/cashV3'))return {code:1,data:{orderNo:'311000000000000000001'}};
 if(route.endsWith('/orderInfo'))return {code:1,data:{orderNo:'311000000000000000001',money:8,status:4}};
 return {};
};
async function until(fn,label){for(let i=0;i<600;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Tempo esgotado: '+label);}
async function run(folder,withoutFilter=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentum-mv3-')),calls=[],errors=[],denied=[],mother=folder==='extensao_agente';let scan=0;
 const python=require('./artefatos_helpers.cjs').python();
 const server=spawn(python,['-u',path.join(__dirname,'_servidor_integracao.py')],{stdio:['ignore','pipe','pipe']});
 let serverErrors='';server.stderr.on('data',b=>serverErrors+=b);
 const realPort=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>{server.kill();reject(Error('Servidor isolado: '+serverErrors));},15000);server.stdout.on('data',b=>{out+=b;const m=out.match(/^(\d+)\r?\n/);if(m){clearTimeout(timer);resolve(+m[1]);}});server.on('exit',()=>{clearTimeout(timer);reject(Error('Servidor isolado encerrado: '+serverErrors));});});
 assert.notEqual(realPort,8765);
 const api=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;let body={};try{body=JSON.parse(raw);}catch{}
  calls.push({path:req.url,body});res.setHeader('Content-Type','application/json');
  if(['/api/operation','/api/pedido','/api/conta','/api/agente','/api/ping'].includes(req.url)){
   try{const reply=await fetch('http://127.0.0.1:'+realPort+req.url,{method:'POST',headers:{'Content-Type':'application/json'},body:raw});res.statusCode=reply.status;res.end(await reply.text());}catch(e){res.statusCode=500;res.end('{}');}return;
  }
  let reply={status:'ok',event_id:body.event_id,revision:body.revision};
  if(req.url==='/api/foco')reply={casas:['maeteste']};if(req.url==='/api/encerradas')reply={casas:[]};if(req.url==='/api/periodo')reply={periodo:'mes'};if(req.url==='/api/varrer_saque')reply={ts:scan};res.end(JSON.stringify(reply));
 });await new Promise(r=>api.listen(0,'127.0.0.1',r));const port=api.address().port;
 const ext=path.join(root,'ext');fs.cpSync(path.join(ROOT,folder),ext,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json'),'utf8')),worlds=new Map();
 for(const cs of manifest.content_scripts)for(const file of cs.js){assert.ok(!worlds.has(file)||worlds.get(file)===(cs.world||'ISOLATED'),'Script repetido entre mundos: '+file);worlds.set(file,cs.world||'ISOLATED');}
 for(const file of ['manifest.json',manifest.background.service_worker]){const p=path.join(ext,file);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('127.0.0.1:8765','127.0.0.1:'+port));}
 let browser, debugPage, debugWorker;
 try{
  browser=await chromium.launchPersistentContext(path.join(root,'perfil'),{executablePath:executable,headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--disable-extensions-except='+ext,'--load-extension='+ext]});
  await browser.route('**/*',async r=>{
   const u=new URL(r.request().url());if(u.hostname==='127.0.0.1'&&u.port===String(port))return r.continue();
   // Exportador de sessao (1.80, porta 8790): servidor paralelo esperado; mocka sem tocar em nada real.
   if(u.hostname==='127.0.0.1'&&u.port==='8790')return r.fulfill({contentType:'application/json',body:'{"status":"ok"}'});
   if(!['filhateste.invalid','maeteste.invalid'].includes(u.hostname)){denied.push(u.hostname);return r.abort();}
   if(u.pathname.includes('/finance/')||u.pathname.includes('/agent/promote/'))return r.fulfill({contentType:'application/json',body:JSON.stringify(fixture(u.pathname))});
   let script='';
   if(mother&&u.pathname==='/home/promote'){
    const report=u.searchParams.get('active')==='directData'?'directReportV5':'myPeriodDataV2';
    script=`<script>setTimeout(()=>fetch('/agent/promote/report/${report}?token=token-sintetico'),40)</script>`;
   }
   return r.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><body>'+(withoutFilter?'':'<button class="ui-tab ui-tab-active">Este Mês</button>')+'<h1>Teste local</h1>'+script+'</body>'});
  });
  const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker',{timeout:15000});
  debugWorker=worker;
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  debugPage=page;
  await page.addInitScript(()=>{window.require=()=>{throw new Error('Loader da página não pertence à extensão');};localStorage.setItem('web__lobby__persisted__user',JSON.stringify({userInfos:{username:'conta-teste',userId:'123456'}}));localStorage.setItem('web__lobby__persisted__token',JSON.stringify({tokenInfos:{session_key:'sessao-sintetica'}}));});
  await page.goto('http://'+(mother?'maeteste':'filhateste')+'.invalid/home');
  if(mother){
   await until(()=>calls.some(c=>c.path==='/api/agente'&&c.body.fonte==='periodo'),'mãe directData -> myData');
   assert.ok(calls.some(c=>c.body.tipo==='agente_membros'&&c.body.membros?.[0]?.conta==='12345678901234567890'));
   if(!withoutFilter)assert.ok(calls.some(c=>c.body.lista_completa===true&&c.body.membros.length===1));
   else assert.ok(!calls.some(c=>c.body.lista_completa===true),'sem filtro não fabrica cobertura');
   assert.equal(new URL(page.url()).searchParams.get('active'),'myData');
   assert.ok(calls.filter(c=>c.path==='/api/agente').every(c=>withoutFilter?c.body.periodo==='desconhecido':c.body.periodo!=='desconhecido'));
  }else{
   await until(()=>worker.evaluate(async()=>Object.keys((await chrome.storage.local.get('opCaptura')).opCaptura?.contextos||{}).length>0),'contexto filha');
   assert.equal(await page.evaluate(()=>isSecureContext),false,'exercita fallback de UUID em HTTP');
   await page.evaluate(async()=>{await fetch('/finance/pay/orderListV3?username=conta-teste');await fetch('/finance/certify/cashV3?username=conta-teste');});
   await until(()=>calls.some(c=>c.path==='/api/operation'&&c.body.tipo==='deposito'),'depósito confirmado');
   assert.ok(!calls.some(c=>c.path==='/api/operation'&&c.body.tipo==='saque'),'aceite não vira saque');
   assert.equal(calls.filter(c=>c.path==='/api/operation'&&c.body.tipo==='deposito').length,1,'depósito pendente não soma');
   await page.evaluate(()=>new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET','/finance/certify/orderInfo?username=conta-teste');x.responseType='json';x.onload=resolve;x.send();}));
   await until(()=>calls.some(c=>c.path==='/api/operation'&&c.body.tipo==='saque'),'saque status4 com JSON exato');
   assert.equal(calls.find(c=>c.path==='/api/operation'&&c.body.tipo==='saque').body.numero_pedido,'311000000000000000001');
   scan=Date.now();await until(()=>new URL(page.url()).pathname==='/home/withdraw','conferência manual');assert.equal(new URL(page.url()).searchParams.get('active'),'3');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(denied,[]);
  const stored=await (await fetch('http://127.0.0.1:'+realPort+'/api/estado')).json();
  if(mother&&!withoutFilter){assert.equal(stored.agente[0].deposito_total,10);assert.equal(stored.agente[0].membros[0].conta,'12345678901234567890');assert.equal(stored.agente[0].lista_completa,true);}
  else if(!mother){assert.equal(stored.resumo.total_depositos,10);assert.equal(stored.resumo.total_saques,8);assert.ok(stored.instalacoes.some(i=>i.tipo==='player'));}
  assert.ok(!JSON.stringify(calls).includes('sessao-sintetica'));assert.ok(!JSON.stringify(calls).includes('token-sintetico'));
  console.log(folder+(withoutFilter?' (sem filtro de período)':'')+': MV3 real aprovado (MAIN + ISOLATED + worker + HTTP; sem perfil/dados reais).');
 }catch(e){
  console.error(JSON.stringify({folder,url:debugPage&&debugPage.url(),errors,calls,run:debugPage&&await debugPage.evaluate(()=>sessionStorage.getItem('__opag_run')),worker:debugWorker&&await debugWorker.evaluate(async()=>await chrome.storage.local.get(['agFila']))}));
  throw e;
 }finally{if(browser)await browser.close();await new Promise(r=>api.close(r));server.kill();await new Promise(r=>server.exitCode!==null?r():server.on('exit',r));}
}
(async()=>{await run('extensao');await run('extensao_agente');await run('extensao_agente',true);})().catch(e=>{console.error(e.stack);process.exitCode=1;});
