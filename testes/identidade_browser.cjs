/* Interface real em perfil descartável, sem rede externa ou dados pessoais. */
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require('./artefatos_helpers.cjs').playwright();
const ROOT=path.resolve(__dirname,'..'),ORIGIN='http://127.0.0.1:49444';
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],posts=[];
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const server={versao:'identity-test',resumo:{contas:[]},operacoes:[],agente:[],pedidos:[],pendentes:[],foco:['gaita'],encerradas:[],instalacoes:[{tipo:'mae',versao:'1.19',ultimo_ping:new Date().toISOString(),slots:[{casa:'gaita',estado:'fora_do_foco',diagnosticado_em:new Date().toISOString()}]}],ext_esperada:{player:'1.26',mae:'1.20'},identidades:{casas:[{id:'a',nome:'P2',chaves:['p2'],origens:[{host:'p2-gaitapg.com',papel:'player'}]},{id:'b',nome:'GAITA',chaves:['gaita'],origens:[{host:'p2-gaitapg.com',papel:'mae'}]}],apelidos:{},por_chave:{p2:'a',gaita:'b'},candidatos:[{origem:'a',destino:'b'}],ambiguas:[],historico:[]}};
  await context.route('**/*',r=>{
   const req=r.request(),u=new URL(req.url()),json=x=>r.fulfill({contentType:'application/json',body:JSON.stringify(x)});
   if(u.origin!==ORIGIN)return r.abort();
   if(u.pathname.startsWith('/api/')){
    if(req.method()==='POST')posts.push({url:u.pathname,body:req.postDataJSON()});
    if(u.pathname==='/api/estado')return json(server);
    if(u.pathname==='/api/casas/previa')return json({status:'ok',origem:'a',destino:'b',token:'preview-test',chaves_origem:['p2'],chaves_destino:['gaita'],depositos:10,saques:8,operacoes:2,pedidos_acompanhados:1,origens_observadas:{p2:[{host:'p2-gaitapg.com',papel:'player'}]},conflitos:[],efeito:'Mantém pedidos e valores.',foco_afetado:['gaita'],encerradas_afetadas:[]});
    if(u.pathname==='/api/cronograma')return json({cronograma:{},versao:'test'});
    return json({status:'ok'});
   }
   const rel=u.pathname==='/'?'index.html':u.pathname.slice(1),file=path.join(ROOT,rel);
   if(rel!=='index.html'&&!/^(assets|icons)\/[\w.-]+$/.test(rel))return r.abort();
   return fs.existsSync(file)?r.fulfill({body:fs.readFileSync(file),contentType:{'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]}):r.fulfill({status:404,body:''});
  });
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(ORIGIN);await p.waitForFunction(()=>typeof AgentumIdentidades!=='undefined'&&document.getElementById('agIdentityPanel'));
  // Os blocos de casas/identidade agora moram na aba AJUSTES (antes ficavam no topo da Conta Mãe).
  await p.evaluate(()=>{clearInterval(pollTimer);abrirAba('ajustes');});
  const initial=await p.evaluate(()=>localStorage.getItem('dashboardOperacoes_v1'));
  assert.match(await p.locator('#agMotherTransport').innerText(),/versão anterior/);
  assert.match(await p.locator('#agMotherTransport').innerText(),/pausada pelo foco/);
  // O estado das abas da mae fica FORA do painel oculto: precisa estar realmente visivel.
  assert.equal(await p.locator('#agMotherTransport').isVisible(),true,'aviso de versão/estado da mãe visível');
  assert.equal(await p.locator('#agIdentityPanel #agMotherTransport').count(),0,'transporte não é filho do painel oculto');
  // Sugestão de JUNTAR casas desativada (o operador não quer associação): a caixa não propõe pares.
  assert.doesNotMatch(await p.locator('#agIdSugestoes').innerText().catch(()=>''),/possivelmente repetidas|Conferir/,'sem sugestão de juntar casas');
  // Avisos acionaveis (Ao Vivo): extensao desatualizada vem do fixture (mae 1.19 x pacote 1.20).
  assert.match(await p.locator('#agAvisos').innerText(),/navegador\(es\) em vers/);
  assert.match(await p.locator('#agAvisos').innerText(),/1\.19 → pacote 1\.20/);
  assert.equal(await p.locator('#agAvisos').evaluate(e=>e.hidden),false);
  assert.equal(posts.filter(x=>x.url.startsWith('/api/casas')).length,0,'nenhuma associação ao renderizar');
  // Bloco oculto por escolha do usuário; contrato legado é exercitado sem exibi-lo.
  assert.equal(await p.locator('#agIdentityPanel').isVisible(),false);
  await p.locator('#agIdentityPanel summary').evaluate(e=>e.click());await p.locator('#agPrepareIdentity').evaluate(e=>e.click());
  await p.locator('#agIdentityPreview').waitFor({state:'visible'});
  assert.equal(await p.locator('#agIdentityConfirm').isDisabled(),true);
  assert.match(await p.locator('#agIdentityImpact').innerText(),/p2-gaitapg.com/);
  await p.locator('#agIdentityCancel').click();assert.equal(posts.filter(x=>x.url==='/api/casas/associar').length,0);
  await p.locator('#agPrepareIdentity').evaluate(e=>e.click());await p.locator('#agIdentityAccept').check();await p.locator('#agIdentityConfirm').click();
  await p.waitForFunction(()=>!document.getElementById('agIdentityPreview').open);
  assert.equal(posts.filter(x=>x.url==='/api/casas/associar').length,1);
  assert.equal(posts.find(x=>x.url==='/api/casas/associar').body.confirmado,true);
  assert.equal(await p.evaluate(()=>localStorage.getItem('dashboardOperacoes_v1')),initial,'estado do navegador preservado');
  // Depois de associar, o "Desfazer associacao" tem que ser alcancavel na caixa visivel.
  await p.evaluate(s=>aplicarEstado({...s,versao:'hist',identidades:{...s.identidades,candidatos:[],historico:[{id:'h1',quando:new Date().toISOString(),desfeito:false,chaves:['p2','gaita']}]}}),server);
  assert.equal(await p.locator('#agIdSugestoes').isVisible(),true,'caixa continua visível só com histórico');
  // Associação já feita não é pendência: fica recolhida numa linha, mas alcançável em um clique
  // (o regresso que isto barra é voltar a ficar escondida por CSS, como dentro do painel oculto).
  assert.equal(await p.locator('#agIdSugestoes summary').isVisible(),true,'linha das associações feitas visível');
  assert.equal(await p.locator('#agIdSugestoes [data-id-undo="h1"]').isVisible(),false,'recolhida por padrão');
  await p.locator('#agIdSugestoes summary').evaluate(e=>e.click());
  assert.equal(await p.locator('#agIdSugestoes [data-id-undo="h1"]').isVisible(),true,'Desfazer associação alcançável');
  // Captura barrada pelo foco: faixa com acao que limpa o foco (POST /api/foco {casas:[]}).
  await p.evaluate(s=>aplicarEstado({...s,versao:'bloq',captura_bloqueada:{bloqueado:true,motivo:'foco',casas_barradas:['gaita'],foco:['nome-antigo']}}),server);
  assert.match(await p.locator('#agAvisos').innerText(),/Captura parada pelo foco/);
  assert.match(await p.locator('#agAvisos').innerText(),/nome-antigo/);
  const focoAntes=posts.filter(x=>x.url==='/api/foco').length;
  await p.locator('#agAvisos [data-ag-foco-todas]').evaluate(e=>e.click());
  await p.waitForTimeout(300);
  const foco=posts.filter(x=>x.url==='/api/foco');
  assert.equal(foco.length,focoAntes+1,'clique limpa o foco uma vez');
  assert.deepEqual(foco[foco.length-1].body.casas,[],'foco vazio = capturar todas');
  // Evento recusado em definitivo sai da fila; sem faixa, o dinheiro nao chega e ninguem sabe.
  await p.evaluate(s=>aplicarEstado({...s,versao:'recusa',instalacoes:[{tipo:'player',versao:s.ext_esperada.player,ultimo_ping:new Date().toISOString(),estado:'eventos_rejeitados_2',slots:[]}]}),server);
  assert.match(await p.locator('#agAvisos').innerText(),/2 evento\(s\) recusados/);
  assert.match(await p.locator('#agAvisos').innerText(),/filha/);
  await p.evaluate(s=>aplicarEstado({...s,versao:'recusa-morta',instalacoes:[{tipo:'player',versao:s.ext_esperada.player,ultimo_ping:new Date(Date.now()-600000).toISOString(),estado:'eventos_rejeitados_2',slots:[]}]}),server);
  assert.ok(!/recusados/.test(await p.locator('#agAvisos').innerText()),'instalação morta não alarma');
  await p.evaluate(s=>aplicarEstado(s),server);
  const scope=await p.evaluate(s=>{
   setSaqueManual('gaita',20);
   const j={...s,versao:'escopo-a',resumo:{contas:[{casa:'p2',conta:'123',qd:1,td:10,qs:1,ts:8}]},agente:[{casa:'gaita'}],mapeamento_filha_mae:{}};
   aplicarEstado(j);const before=Agentum.finance().ts;
   aplicarEstado({...j,versao:'escopo-b',mapeamento_filha_mae:{p2:'gaita'}});const after=Agentum.finance().ts;
   setSaqueManual('gaita','');aplicarEstado(s);return {before,after};
  },server);
  assert.deepEqual(scope,{before:8,after:8},'alias de conferência não transfere ajuste manual para outra origem financeira');
  // CASAS SEM NOME (aba Conta Mãe): domínio cloudfront sem plataforma -> caixa pra nomear pela URL.
  // Muta o próprio mock p/ o estado ficar consistente mesmo se a troca de aba disparar um poll.
  server.versao='sem-nome';
  server.identidades.casas.push({id:'cf',nome:'D2J283P0N7ILT1',chaves:['d2j283p0n7ilt1'],origens:[{host:'d2j283p0n7ilt1.cloudfront.net',papel:'player'}]});
  server.identidades.por_chave.d2j283p0n7ilt1='cf';server.identidades.candidatos=[];
  await p.evaluate(()=>pollEstado());
  await p.evaluate(()=>abrirAba('contamae'));
  assert.equal(await p.locator('#cmSemNome').isVisible(),true,'caixa Casas sem nome visível na Conta Mãe');
  assert.match(await p.locator('#cmSemNome').innerText(),/Casas sem nome/);
  assert.equal(await p.locator('#cmSemNome input[data-semnome-id="cf"]').count(),1,'campo pra nomear a casa cloudfront');
  assert.equal(await p.locator('#cmSemNome input[data-semnome-id="a"]').count(),0,'casa com domínio legível não entra na caixa');
  await p.locator('#cmSemNome input[data-semnome-id="cf"]').fill('https://www.p1-festapg.com');
  const antesNome=posts.filter(x=>x.url==='/api/casas/nome').length;
  await p.locator('#cmSemNome [data-semnome-save="cf"]').click();
  await p.waitForTimeout(400);
  const nomePost=posts.filter(x=>x.url==='/api/casas/nome');
  assert.equal(nomePost.length,antesNome+1,'salvar nome envia /api/casas/nome uma vez');
  assert.deepEqual(nomePost[nomePost.length-1].body,{id:'cf',nome:'p1-festapg'},'usa o nome bonito derivado da URL colada');
  await p.evaluate(()=>abrirAba('ajustes'));
  const out=require('./artefatos_helpers.cjs')('identidade');fs.mkdirSync(out,{recursive:true});
  for(const width of [1440,760,390]){await p.setViewportSize({width,height:1000});await p.screenshot({path:path.join(out,width+'.png'),fullPage:true});const overflow=await p.locator('#agIdentityPanel').evaluate(e=>e.scrollWidth>e.clientWidth+1);assert.equal(overflow,false,'controles cabem em '+width+'px');}
  assert.deepEqual(errors,[]);console.log('Identidade UI: prévia/confirmação/cancelamento, versões, estados, preservação e 3 larguras aprovados.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
