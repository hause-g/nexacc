'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('./artefatos_helpers.cjs').playwright();
const py=require('./artefatos_helpers.cjs').python();
(async()=>{
 const proc=spawn(py,['-u',path.join(__dirname,'_servidor_integracao.py')],{stdio:['ignore','pipe','pipe']});let browser,errors=[],diag='';proc.stderr.on('data',b=>diag+=b);
 try{
 const port=await new Promise((resolve,reject)=>{let buf='';const t=setTimeout(()=>reject(Error(diag||'timeout')),15000);proc.stdout.on('data',b=>{buf+=b;const m=buf.match(/^(\d+)\r?\n/);if(m){clearTimeout(t);resolve(+m[1]);}});proc.on('exit',()=>{clearTimeout(t);reject(Error(diag));});});
 assert.notEqual(port,8765);const origin='http://127.0.0.1:'+port;
 for(const data of [{tipo:'deposito',valor:100,numero_pedido:'UI-D1',conta:'1'},{tipo:'deposito',valor:50,numero_pedido:'UI-D2',conta:'1'},{tipo:'deposito',valor:100,numero_pedido:'UI-D3',conta:'2'},{tipo:'saque',valor:301.01,numero_pedido:'UI-S1',conta:'1'}]){const r=await fetch(origin+'/api/operation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,casa:'A',origem:'api',estado:'confirmado'})});assert.ok(r.ok);}
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'});
 await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
 await context.addInitScript(()=>{localStorage.setItem('dashboardOperacoes_v1',JSON.stringify({config:{telegram:{}},operacoes:[{id:'one',plataforma:'Alfa',inicio:'2026-09-10',ok:false},{id:'two',plataforma:'Beta',inicio:'2026-09-10',ok:false}],metasAoVivo:['one','two'],historico:[{mes:'Protegido',lucroTotal:99}],chavesPix:[{valor:'pix-teste'}],plataformas:[],cronograma:{}}));sessionStorage.setItem('orionSplash','1');});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/index.html');
 await page.waitForFunction(()=>typeof Estado!=='undefined'&&Estado.conectado&&AoVivo.ops.length===4);
 await page.evaluate(()=>abrirAba('aovivo'));const financial=await page.evaluate(()=>Agentum.finance());assert.equal(financial.resultado,51.01);assert.equal(financial.contas,2);assert.equal(financial.media,125);
 await page.evaluate(()=>fecharCicloAoVivo());await page.locator('#agCloseAccept').check();await page.locator('#agCloseConfirm').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_fechamento_journal'))?.phase==='done');
 const rows=await page.evaluate(()=>estado.operacoes);assert.equal(rows.length,2);assert.equal(rows[0].lucro,25.51);assert.equal(rows[1].lucro,25.5);assert.equal(await page.evaluate(()=>estado.historico[0].lucroTotal),99);
 const backup=await page.evaluate(()=>Agentum.makeBackup());assert.equal(backup.manifesto.cobertura,'parcial');assert.equal(await page.evaluate(async b=>{await Agentum.preflight(b);return true;},backup),true);
 assert.deepEqual(errors,[]);console.log('Navegador + HTTP reais isolados: valores/média/fechamento/duas metas/histórico/backup válido aprovados.');await context.close();
 }finally{if(browser)await browser.close();proc.kill();await new Promise(r=>proc.exitCode!==null?r():proc.on('exit',r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
