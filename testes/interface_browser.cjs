const OUT=require('./artefatos_helpers.cjs')('interface_browser');
/* Navegador descartável. Todas as requisições são interceptadas; nenhuma chega à rede.
 * Não lê banco, arquivo conectado, perfis, credenciais ou estado real. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {chromium}=require('./artefatos_helpers.cjs').playwright();
const ROOT=path.resolve(__dirname,'..'),ORIGIN='http://127.0.0.1:49152';
const clone=x=>JSON.parse(JSON.stringify(x)),KEY='dashboardOperacoes_v1';
const state={versao:1,config:{horaAlerta:'10:00',periodo:'mes',telegram:{token:'',chatId:'',capturar:false}},operacoes:[{id:'m1',plataforma:'Meta Alfa',inicio:'2026-09-10',ok:false,lucro:null,depositantes:null},{id:'m2',plataforma:'Meta Beta',inicio:'2026-09-10',ok:false,lucro:null,depositantes:null}],metasAoVivo:['m1','m2'],plataformas:[{plataforma:'Alfa',nome:'Operador de teste',link:'',meta:'60'}],historico:[{mes:'Agosto de teste',lucroTotal:123.45,depositantes:2,ops:1,acerto:1}],chavesPix:[{valor:'pix-de-teste',nota:'preservar'}],usuarios:[],instagrams:[],logins:[],sessoes:[],selecao:[],sessaoAtiva:null,cronograma:{0:[],1:[],2:['Alfa'],3:[],4:[],5:[],6:[]}};
function backend(){
 const ops=[{numero_pedido:'D01',casa:'A',conta:'001',tipo:'deposito',valor:100},{numero_pedido:'D02',casa:'A',conta:'001',tipo:'deposito',valor:50},{numero_pedido:'D03',casa:'A',conta:'002',tipo:'deposito',valor:100},{numero_pedido:'S01',casa:'A',conta:'001',tipo:'saque',valor:301.01}];
 return {versao:'v1',ciclo_id:1,periodo_ciclo:'hoje@2026-09-10',ext_esperada:{player:'9.7',mae:'8.2'},ext_player:'9.7',ext_mae:'8.2',operacoes:ops,resumo:{ciclo_id:1,contas:[{casa:'A',conta:'001',qd:2,td:150,qs:1,ts:301.01},{casa:'A',conta:'002',qd:1,td:100,qs:0,ts:0}]},jogos:[],jogos_cat:[],pedidos:[{numero_pedido:'PENDENTE-0001',tipo:'saque',casa:'A',conta:'002',valor:null,estado:'verificar',motivo:'A última consulta não foi concluída.',observado_em:'2026-09-10T15:20:00Z',ciclo_id:1}],instalacoes:[{instalacao_id:'teste',tipo:'player',fila:null,versao:'9.7',estado:'passivo'}],ajustes:[],agente:[{casa:'A',periodo:'hoje@2026-09-10',fonte:'directData',lista_completa:false,contas:35,unidade_contador:'desconhecida',deposito_total:123456.78,aposta_total:987654.32,saque_total:null,recebido_em:'2026-09-10T15:20:00Z',membros:Array.from({length:30},(_,i)=>({conta:String(i+1).padStart(3,'0'),nome:i===0?'Nome de afiliado muito longo para validar alinhamento e quebra':`Conta ${i+1}`,deposito:i===0?123456.78:i%2?null:100,aposta:54321.09}))}],foco:[],encerradas:[],pendentes:[]};
}
const sha=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const py=require('./artefatos_helpers.cjs').python();
const generated=spawnSync(py,['-B',path.join(__dirname,'interface_backup_contract.py'),'--finance-fixture'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'}});
assert.equal(generated.status,0,generated.stderr);const realFixture=JSON.parse(generated.stdout),bank=realFixture.banco;
fs.writeFileSync(path.join(OUT,'interface_banco_fixture.json'),JSON.stringify(bank,null,2));
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});let passed=0;const errors=[],requests=[],unexpectedToasts=[];
 try{
 const context=await browser.newContext({viewport:{width:1600,height:1300},serviceWorkers:'block',acceptDownloads:true});
 let server=backend(),closures=new Map(),restores=new Map(),dropClose=false,dropRestore=false,rejectClose=false,rejectRestore=false,restoreCalls=0,scheduleOffline=false,schedule=clone(state.cronograma),scheduleRev='s1',telegramUpdates=[],apiFailure=false;
 await context.addInitScript(({state,KEY})=>{if(!localStorage.getItem(KEY))localStorage.setItem(KEY,JSON.stringify(state));sessionStorage.setItem('orionSplash','1');},{state,KEY});
 const routeHandler=async route=>{
  const req=route.request(),url=new URL(req.url());requests.push({method:req.method(),path:url.pathname,origin:url.origin,contentType:req.headers()['content-type'],body:req.postData()});
  const json=x=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)});
  if(url.pathname==='/api/estado')return json(server);
  if(url.pathname==='/api/cronograma'){if(scheduleOffline)return route.abort();if(req.method()==='POST'){schedule=req.postDataJSON().cronograma;scheduleRev='s2';}return json(req.method()==='GET'?{cronograma:schedule,versao:scheduleRev}:{status:'ok',versao:scheduleRev});}
  if(url.hostname==='api.telegram.org'&&url.pathname.endsWith('/getUpdates'))return json({ok:true,result:telegramUpdates});
  if(['/api/varrer_saque','/api/ciclo/novo','/api/operation'].includes(url.pathname)){
   if(apiFailure)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({status:'erro',codigo:'conflito',motivo:'Conflito de teste preservado'})});
   return json(url.pathname==='/api/varrer_saque'?{status:'ok',ts:123}:url.pathname==='/api/ciclo/novo'?{ok:true,ciclo:2}:{status:'duplicado'});
  }
  if(url.pathname==='/api/backup')return json(bank);
  if(url.pathname==='/api/restore/validar')return json({status:'ok'});
  if(url.pathname==='/api/restore/status'){const id=url.searchParams.get('id');return json(restores.has(id)?{status:'ok',restore_id:id,estado:'concluido',resposta:restores.get(id)}:{status:'nao_encontrado',restore_id:id});}
  if(url.pathname==='/api/restore'){
   if(rejectRestore){rejectRestore=false;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({status:'erro',codigo:'conflito',motivo:'Versão alterada antes de restaurar'})});}
   const body=req.postDataJSON();restoreCalls++;const result={status:'ok',estado:'concluido',restore_id:body.restore_id};restores.set(body.restore_id,result);
   if(dropRestore){dropRestore=false;return route.abort();}return json(result);
  }
  if(url.pathname==='/api/ciclo/fechar'){
   if(rejectClose){rejectClose=false;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({status:'erro',codigo:'conflito',motivo:'Versão alterada antes de fechar'})});}
   const b=req.postDataJSON();if(!closures.has(b.fechamento_id))closures.set(b.fechamento_id,{status:'ok',fechamento_id:b.fechamento_id,ciclo_id:1,novo_ciclo_id:2,metas_ids:b.metas_ids,resumo:{deposito:250,saque:301.01,contas:2,gerente_bau:0,resultado:51.01,por_casa:[{casa:'A',deposito:250,saque:301.01,contas:2}]}});
   if(dropClose){dropClose=false;return route.abort();}return json(closures.get(b.fechamento_id));
  }
  if(url.pathname.startsWith('/api/'))return json({status:'ok'});
  if(url.origin!==ORIGIN)return route.abort();
  const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
  if(relative!=='index.html'&&relative!=='seed.js'&&!/^(assets|icons)\/[\w.-]+$/.test(relative))return route.abort();
  const file=path.join(ROOT,relative);if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const ext=path.extname(file),mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[ext]||'application/octet-stream';
  return route.fulfill({contentType:mime,body:fs.readFileSync(file)});
 };await context.route('**/*',routeHandler);
 await context.exposeBinding('observeToast',(_,text)=>{if(/Cannot read|undefined|is not (a function|defined)|TypeError|ReferenceError|SyntaxError/i.test(text))unexpectedToasts.push(text);});
 await context.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>new MutationObserver(()=>window.observeToast(document.getElementById('toast')?.textContent||'')).observe(document.getElementById('toast'),{childList:true,subtree:true,characterData:true})));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(ORIGIN);await page.waitForFunction(()=>typeof Agentum!=='undefined'&&typeof Estado!=='undefined'&&Estado.versao==='v1');
 await page.evaluate(()=>{clearInterval(pollTimer);abrirAba('aovivo');});
 assert.equal(await page.locator('#avDepTotal').innerText(),'R$ 250,00');assert.equal(await page.locator('#avMediaVal').innerText(),'R$ 125,00');assert.match(await page.locator('#extVer').getAttribute('title'),/9.7/);passed++;
 await page.screenshot({path:path.join(OUT,'interface_01_aovivo.png'),animations:'disabled'});
 assert.equal(await page.locator('#agTracking').isVisible(),false);await page.locator('#agOrderList button').first().evaluate(e=>e.click());await page.screenshot({path:path.join(OUT,'interface_02_detalhe.png'),animations:'disabled'});
 assert.match(await page.locator('#agDrawer').innerText(),/Valor a confirmar/);assert.equal(await page.locator('#agDrawer a').count(),0);await page.keyboard.press('Escape');assert.equal(await page.locator('#agDrawer').evaluate(e=>e.open),false);passed++;
 await page.locator('#agTracking summary').evaluate(e=>e.click());assert.equal(await page.locator('#agTracking').getAttribute('open'),null);await page.locator('#agTracking summary').evaluate(e=>e.click());passed++;
 await page.evaluate(()=>abrirAba('contamae'));assert.match(await page.locator('#cmCasas').innerText(),/Lista parcial · 30 de 35 registros recebidos/);
 const align=await page.locator('.cm-tab').evaluate(t=>[...t.rows[0].cells].map((c,i)=>({head:getComputedStyle(c).textAlign,body:getComputedStyle(t.rows[1].cells[i]).textAlign,width:c.getBoundingClientRect().width,bodyWidth:t.rows[1].cells[i].getBoundingClientRect().width})));
 assert.deepEqual(align.map(x=>x.head),['left','right','right','right','center']);align.forEach(a=>{assert.equal(a.head,a.body);assert.ok(Math.abs(a.width-a.bodyWidth)<1);});passed++;
 await page.locator('.cm-tabwrap').evaluate(e=>e.scrollTop=220);assert.equal(await page.locator('.cm-tab th').first().evaluate(e=>getComputedStyle(e).position),'sticky');
 await page.screenshot({path:path.join(OUT,'interface_03_mae.png'),animations:'disabled'});
 for(const width of [1100,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'page overflow '+width);await page.screenshot({path:path.join(OUT,`interface_mae_${width}.png`),animations:'disabled'});}passed++;
 await page.setViewportSize({width:1600,height:1300});await page.evaluate(()=>abrirAba('aovivo'));await page.locator('#avFechar').click();assert.equal(await page.locator('#agClose').evaluate(e=>e.open),true);assert.equal(await page.locator('#agCloseConfirm').isDisabled(),true);
 await page.screenshot({path:path.join(OUT,'interface_04_fechamento.png'),animations:'disabled'});
 rejectClose=true;await page.locator('#agCloseAccept').check();await page.locator('#agCloseConfirm').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_fechamento_journal'))?.phase==='rejected');
 assert.equal(await page.evaluate(()=>estado.operacoes.filter(o=>o.ok).length),0);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentum_fechamento_journal')).rejection.httpStatus),409);assert.equal(closures.size,0);await page.waitForFunction(()=>Estado.versao!==null);await page.locator('#avFechar').click();passed++;
 dropClose=true;await page.locator('#agCloseAccept').check();await page.locator('#agCloseConfirm').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_fechamento_journal'))?.phase==='sent');
 assert.equal(await page.evaluate(()=>estado.operacoes.filter(o=>o.ok).length),0);await page.locator('#agCloseCancel').click();await page.evaluate(()=>Agentum.recover('close'));
 assert.equal(closures.size,1);const closed=await page.evaluate(()=>estado.operacoes);assert.equal(closed.length,2);assert.equal(Math.round((closed[0].lucro+closed[1].lucro)*100),5101);assert.equal(closed[0].lucro,25.51);assert.equal(closed[1].lucro,25.5);passed++;
 await page.evaluate(()=>Agentum.recover('close'));assert.equal(closures.size,1);assert.equal(await page.evaluate(()=>estado.historico[0].lucroTotal),123.45);assert.equal(await page.evaluate(()=>estado.chavesPix[0].valor),'pix-de-teste');passed++;
 await page.evaluate(()=>abrirAba('ajustes'));await page.screenshot({path:path.join(OUT,'interface_05_ajustes.png'),animations:'disabled'});
 const envelope=await page.evaluate(()=>Agentum.makeBackup());assert.equal(envelope.manifesto.cobertura,'parcial');assert.ok('saqueManual' in envelope.navegador.extras);
 assert.equal(await page.evaluate(async e=>{e.navegador.estado.operacoes[0].lucro=999;try{await Agentum.preflight(e);return false;}catch(_){return true;}},clone(envelope)),true,'tampered preflight rejected');passed++;
 // Preflight deve rejeitar objetos malformados antes de qualquer POST destrutivo.
 const malformed=clone(envelope);malformed.navegador.estado.historico=[null];malformed.manifesto.hashes.navegador=sha(malformed.navegador);
 assert.equal(await page.evaluate(async e=>{try{await Agentum.preflight(e);return false;}catch(_){return true;}},malformed),true);assert.equal(restoreCalls,0);passed++;
 // Banco confirma, resposta se perde: browser intacto, status recupera sem reaplicar o banco.
 const target=clone(envelope);target.navegador.estado.config.metaMes=321;target.navegador.extras.aovivo_extra=JSON.stringify({bau:3,gerente:2});target.manifesto.hashes.navegador=sha(target.navegador);
 const currentBefore=await page.evaluate(()=>localStorage.getItem('dashboardOperacoes_v1'));rejectRestore=true;
 await page.locator('#bkFile').setInputFiles({name:'backup-recusado.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(target))});await page.locator('#mcOk').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_restore_journal'))?.phase==='rejected');
 assert.equal(await page.evaluate(()=>localStorage.getItem('dashboardOperacoes_v1')),currentBefore);assert.equal(restoreCalls,0);await page.waitForFunction(()=>Estado.versao!==null);passed++;
 dropRestore=true;
 await page.locator('#bkFile').setInputFiles({name:'backup-teste.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(target))});await page.locator('#mcOk').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_restore_journal'))?.phase==='sent');
 assert.equal(await page.evaluate(()=>localStorage.getItem('dashboardOperacoes_v1')),currentBefore);await page.evaluate(()=>Agentum.recover('restore'));
 assert.equal(restoreCalls,1);assert.equal(await page.evaluate(()=>estado.config.metaMes),321);assert.equal(await page.evaluate(()=>AoVivo.bau),3);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentum_restore_journal')).phase),'done');passed++;
 // Queda da escrita local após commit do banco: diário retoma sem novo POST.
 const target2=await page.evaluate(()=>Agentum.makeBackup());target2.navegador.estado.config.metaMes=654;target2.manifesto.hashes.navegador=sha(target2.navegador);
 await page.evaluate(()=>{const original=Storage.prototype.setItem;window.restoreStorage=()=>Storage.prototype.setItem=original;let failed=false;Storage.prototype.setItem=function(k,v){if(k==='dashboardOperacoes_v1'&&!failed){failed=true;throw Error('Falha de armazenamento simulada.');}return original.call(this,k,v);};});
 await page.locator('#bkFile').setInputFiles({name:'backup2.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(target2))});await page.locator('#mcOk').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_restore_journal'))?.phase==='server_committed');
 assert.equal(await page.evaluate(()=>estado.config.metaMes),321);await page.evaluate(()=>{window.restoreStorage();return Agentum.recover('restore');});assert.equal(restoreCalls,2);assert.equal(await page.evaluate(()=>estado.config.metaMes),654);passed++;
 // Telemetria se atualiza mesmo com a revisão financeira idêntica.
 const sameVersion=clone(server);sameVersion.instalacoes[0].fila=7;await page.evaluate(s=>aplicarEstado(s),sameVersion);assert.match(await page.locator('#agDiagnostics').innerText(),/fila 7/);passed++;
 // Mesmo rótulo de mês não prova que o ciclo e a fonte cobrem o mesmo intervalo.
 assert.equal(await page.evaluate(()=>Agentum.compatible({periodo:'hoje@2026-09-10',lista_completa:true})),false);passed++;
 // Arquivamento preserva as linhas completas e é idempotente pelo diário.
 await page.evaluate(()=>{abrirAba('operacoes');fecharMes();});await page.locator('#mcOk').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_mes_journal'))?.phase==='done');
 assert.equal(await page.evaluate(()=>estado.operacoes.length),0);assert.equal(await page.evaluate(()=>estado.historico[0].operacoes.length),2);assert.equal(await page.evaluate(()=>estado.historico[0].lucroTotal),51.01);passed++;
 // Telegram: chat exato, offset com o formulário na mesma escrita, lote repetido não reprocessa.
 await page.evaluate(async()=>{estado.config.telegram={token:'TOKEN_ARTIFICIAL',chatId:'123',capturar:true,lastUpdateId:0};await salvar();});
 telegramUpdates=[{update_id:1,message:{chat:{id:999},text:'malicioso'}},{update_id:2,message:{chat:{id:123},text:'permitido'}},{update_id:3,edited_message:{chat:{id:123},text:'editado'}}];
 await page.evaluate(()=>{window.tgProcessed=[];processarFormTelegram=text=>{tgProcessed.push(text);return false;};return pollTelegram();});await page.evaluate(()=>pollTelegram());
 assert.deepEqual(await page.evaluate(()=>tgProcessed),['permitido']);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dashboardOperacoes_v1')).config.telegram.lastUpdateId),3);passed++;
 // Cronograma: foco/click sem alteração não envia; alteração offline fica pendente e retoma.
 await page.evaluate(()=>abrirAba('cronograma'));const postsBefore=requests.filter(r=>r.method==='POST'&&r.path==='/api/cronograma').length;
 await page.locator('input[data-add-dia="0"][data-add-tipo="encerra"]').click();await page.waitForTimeout(20);assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/api/cronograma').length,postsBefore);
 scheduleOffline=true;await page.locator('input[data-add-dia="0"][data-add-tipo="encerra"]').fill('Casa teste');await page.locator('input[data-add-dia="0"][data-add-tipo="encerra"]').press('Enter');await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_cronograma_journal'))?.phase==='pending');scheduleOffline=false;await page.evaluate(()=>Agentum.syncSchedule());assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentum_cronograma_journal')).phase),'done');assert.deepEqual(schedule['0'],['Casa teste']);
 // lançamento cadastrado no mesmo dia vai ao servidor em 'lancamentos', sem mexer nos encerramentos
 await page.locator('input[data-add-dia="0"][data-add-tipo="lanca"]').fill('Casa nova');await page.locator('input[data-add-dia="0"][data-add-tipo="lanca"]').press('Enter');await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agentum_cronograma_journal'))?.phase==='done'&&JSON.parse(localStorage.getItem('agentum_cronograma_journal')).cronograma.lancamentos);await page.evaluate(()=>Agentum.syncSchedule());assert.deepEqual(schedule.lancamentos['0'],['Casa nova']);assert.deepEqual(schedule['0'],['Casa teste']);passed++;
 const page2=await context.newPage();await page2.goto(ORIGIN);await page2.waitForFunction(()=>typeof estado!=='undefined'&&estado.operacoes.length===0);
 await page.evaluate(async()=>{estado.config.metaMes=987;await salvar();});await page2.waitForFunction(()=>document.getElementById('agRecovery').textContent.includes('outra janela'));
 await page2.evaluate(async()=>{estado.config.metaMes=999;await salvar();});assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dashboardOperacoes_v1')).config.metaMes),987);passed++;
 await page2.close();
 // Mãe real: total e membros nunca emprestam campos de outra fonte, mesmo no mesmo mês.
 const sourceState=clone(server);sourceState.versao='sources';sourceState.agente=[{casa:'A',deposito_total:999999,membros:[{conta:'errada',deposito:999999}],fontes:[{fonte:'periodo',periodo:'mes@2026-09',tipo:'agente_total',recebido_em:'2026-09-10T12:00:00Z',dados:{deposito:200,contas:25}},{fonte:'membros',periodo:'mes@2026-09',tipo:'agente_membros',recebido_em:'2026-09-10T12:00:00Z',dados:{membros_recebidos:1}}],listas:[{fonte:'membros',periodo:'mes@2026-09',lista_completa:true,membros:[{conta:'001',nome:'Mesmo período, fonte própria',deposito:100,aposta:200}],total_paginas:1}],listas_parciais:[{fonte:'membros',periodo:'hoje@2026-09-10',lista_completa:false,membros:[{conta:'002',deposito:50}],membros_recebidos:1}]}];
 await page.evaluate(s=>{aplicarEstado(s);abrirAba('contamae');},sourceState);
 const sources=await page.evaluate(()=>Agentum.motherViews());assert.equal(sources.length,4);assert.equal(sources.find(s=>s.fonte==='periodo').membros.length,0);assert.equal(sources.find(s=>s.fonte==='membros').deposito_total,undefined);assert.equal(sources.some(s=>s.membros.some(m=>m.conta==='errada')),false);assert.equal(await page.locator('.ag-mother').count(),1);passed++;
 // Leituras do backend real: um cartão por identidade, fontes separadas e seleção em memória.
 await page.evaluate(s=>{aplicarEstado(s);abrirAba('contamae');},{...server,versao:'mother-real',agente:realFixture.snapshot.agente});
 assert.equal(await page.locator('.ag-mother').count(),1);assert.equal(await page.locator('[data-ag-reading] option').count(),5);assert.equal(await page.locator('.cm-cell').count(),4);
 const kpis=await page.locator('.cm-cell').evaluateAll(es=>es.map(e=>({padding:getComputedStyle(e).padding,height:e.getBoundingClientRect().height})));
 assert.equal(new Set(kpis.map(x=>x.padding)).size,1);assert.equal(new Set(kpis.map(x=>x.height)).size,1);assert.notEqual(kpis[0].padding,'0px');
 await page.locator('.ag-more summary').click();assert.match(await page.locator('.ag-more').innerText(),/Indicador da fonte: 25 · unidade a confirmar/);await page.locator('.ag-more summary').click();
 await page.waitForFunction(()=>!document.getElementById('toast').classList.contains('show'));await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:path.join(OUT,'interface_03_mae.png'),animations:'disabled'});
 const fullReading=await page.locator('[data-ag-reading] option').evaluateAll(es=>es.find(e=>e.textContent.endsWith(' · completa')).value);
 await page.locator('[data-ag-reading]').selectOption(fullReading);assert.equal(await page.locator('.cm-cell').count(),0);assert.equal(await page.locator('.cm-tab tbody tr').count(),20);
 await page.evaluate(()=>{Agentum.renderMother();Agentum.renderComparison();});assert.equal(await page.locator('[data-ag-reading]').inputValue(),fullReading);assert.equal(await page.locator('#avConferencia .conf-chip').count(),1);
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:path.join(OUT,'interface_06_mae_lista.png'),animations:'disabled'});
 for(const width of [1100,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(OUT,`interface_mae_${width}.png`),animations:'disabled'});}
 await page.setViewportSize({width:1600,height:1300});passed++;
 const twoMothers=clone(realFixture.snapshot.agente);twoMothers[0].fontes.push({...clone(twoMothers[0].fontes.find(f=>f.fonte==='periodo')),conta_mae:'mae-teste-2'});
 await page.evaluate(s=>aplicarEstado(s),{...server,versao:'two-mothers',agente:twoMothers});assert.equal(await page.locator('.ag-mother').count(),2);passed++;
 // Botões legados: JSON explícito, duplicado é ACK; conflito não produz sucesso.
 await page.evaluate(()=>abrirAba('aovivo'));
 const pendingRecord={numero_pedido:'P-DUP',casa:'A',conta:'001',valor:100};
 await page.evaluate(p=>Agentum.confirmPending([p]),pendingRecord);await page.locator('#mcOk').click();await page.waitForFunction(()=>/depósito.*confirmado/.test(document.getElementById('toast').textContent));
 apiFailure=true;await page.evaluate(p=>Agentum.confirmPending([p]),pendingRecord);await page.locator('#mcOk').click();await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Conflito de teste preservado'));
 await page.evaluate(()=>{window.cycleSuccess=0;return Agentum.newCycle(()=>cycleSuccess++);});assert.equal(await page.evaluate(()=>cycleSuccess),0);
 apiFailure=false;await page.evaluate(()=>Agentum.newCycle(()=>cycleSuccess++));assert.equal(await page.evaluate(()=>cycleSuccess),1);
 await page.evaluate(()=>Agentum.scanWithdrawals());await page.locator('#mcOk').click();await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Conferência solicitada'));
 const actions=requests.filter(r=>r.method==='POST'&&['/api/varrer_saque','/api/ciclo/novo'].includes(r.path));assert.ok(actions.length>=3);for(const r of actions){assert.equal(r.origin,ORIGIN);assert.match(r.contentType,/application\/json/);const corpo=JSON.parse(r.body);// virar o ciclo exige NOMEAR o ciclo aberto e confirmar: e o que impede clique perdido, aba
// velha com JS antigo e requisicao reenviada de fecharem a operacao do operador
if(r.path==='/api/ciclo/novo'){assert.equal(corpo.confirmado,true);assert.equal(Number.isInteger(corpo.ciclo_id),true);}else assert.ok(Array.isArray(corpo.casas),'varrer_saque leva as casas da operacao ao vivo ativa (escopo)');}passed++;
 const rejectedPayloads=await page.evaluate(async()=>{
  const original=window.fetch,results=[];
  try{for(const [status,body] of [[409,'null'],[503,'{"status":"erro"}'],[200,'{"ok":false}']]){
   window.fetch=async()=>new Response(body,{status});try{await Agentum.request('/api/teste',{});results.push(false);}catch(e){results.push(e.httpStatus===status&&!e.semCommit);}
  }
  for(const [status,body] of [[503,'{"ok":true}'],[200,'{"ok":false}']]){window.fetch=async()=>new Response(body,{status});try{await tgSend('teste artificial sem rede');results.push(false);}catch(e){results.push(true);}}
  }finally{window.fetch=original;}return results;
 });assert.deepEqual(rejectedPayloads,[true,true,true,true,true]);assert.equal(await page.locator('#agServerHost').innerText(),new URL(ORIGIN).host);passed++;
 // Instalação vazia de verdade: sem seed, banco financeiro vazio comprovado e menus preservados.
 const emptyContext=await browser.newContext({serviceWorkers:'block',viewport:{width:1100,height:900}});await emptyContext.route('**/*',routeHandler);
 const empty=await emptyContext.newPage();empty.on('pageerror',e=>errors.push(e.message));await empty.goto(ORIGIN);await empty.waitForFunction(()=>typeof estado!=='undefined'&&typeof Agentum!=='undefined');
 assert.equal(await empty.evaluate(()=>estado.operacoes.length),0);assert.equal(await empty.evaluate(()=>estado.historico.length),0);assert.equal(await empty.evaluate(()=>estado.chavesPix.length),0);assert.equal(await empty.locator('script[src="seed.js"]').count(),0);passed++;
 // Formulário e botão de início continuam criando/vinculando a mesma meta real da interface.
 await empty.evaluate(()=>abrirAba('formularios'));await empty.locator('#fPlat').fill('Plataforma teste');await empty.locator('#fNome').fill('Nome teste');await empty.locator('#fMeta').fill('60');await empty.locator('#fSalvar').click();
 await empty.waitForFunction(()=>estado.operacoes.length===1);await empty.evaluate(()=>{abrirAba('operacoes');togglePickOp(estado.operacoes[0].id);});await empty.locator('#iniciarOp').click();
 assert.equal(await empty.evaluate(()=>estado.metasAoVivo[0]===estado.operacoes[0].id),true);assert.equal(await empty.evaluate(()=>estado.plataformas[0].nome),'Nome teste');passed++;
 await emptyContext.close();
 assert.deepEqual(errors,[]);assert.deepEqual(unexpectedToasts,[]);assert.equal(requests.some(r=>r.path.includes('/sendMessage')),false);assert.equal(requests.some(r=>r.path.startsWith('/api/')&&r.origin!==ORIGIN),false);passed++;
 fs.writeFileSync(path.join(OUT,'interface_resultados.json'),JSON.stringify({passed,errors,unexpectedToasts,network:'Todas as requisições interceptadas; sem rede real.',frames:8,requests:requests.map(r=>r.path)},null,2));
 console.log(JSON.stringify({passed,errors,closeIds:closures.size,restoreCalls}));await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
