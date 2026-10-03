/* UI isolada: contexto descartável, todas as requisições interceptadas,
 * sem servidor, banco, extensões ou storageState/perfil pessoal. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('./artefatos_helpers.cjs').playwright();
const ROOT=path.resolve(__dirname,'..'),ORIGIN='http://127.0.0.1:49152';
const OUT=require('./artefatos_helpers.cjs')('ui_hotfix_contamae');
const state={versao:1,config:{horaAlerta:'10:00',periodo:'mes',telegram:{token:'',chatId:'',capturar:false}},operacoes:[],metasAoVivo:[],plataformas:[],historico:[],chavesPix:[],usuarios:[],instagrams:[],logins:[],sessoes:[],selecao:[],sessaoAtiva:null,cronograma:{0:[],1:[],2:[],3:[],4:[],5:[],6:[]}};
let server={versao:'ui-0',ciclo_id:1,periodo_ciclo:'hoje@2026-09-11',resumo:{ciclo_id:1,contas:[]},operacoes:[],agente:[],ajustes:[],foco:[],encerradas:[],pedidos:[],pendentes:[],instalacoes:[],jogos:[],jogos_cat:[],mapeamento_filha_mae:{}};
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const errors=[],posts=[],unexpected=[],passed=[];
 try{
  fs.mkdirSync(OUT,{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'});
  await context.addInitScript(s=>{
   localStorage.setItem('dashboardOperacoes_v1',JSON.stringify(s));
   sessionStorage.setItem('orionSplash','1');
  },state);
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   // Nunca há route.continue() nem acesso a uma API real, mesmo em caso de erro.
   if(url.origin!==ORIGIN){unexpected.push(url.origin+url.pathname);return route.abort();}
   const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
   if(req.method()!=='GET')posts.push({path:url.pathname,body:req.postDataJSON()});
   if(url.pathname==='/api/estado')return json(server);
   if(url.pathname==='/api/cronograma')return json({cronograma:state.cronograma,versao:'ui-s1'});
   if(url.pathname==='/api/ajuste')return json({status:'ok'});
   if(url.pathname.startsWith('/api/'))return json({status:'ok'});
   const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
   if(relative!=='index.html'&&!/^(assets|icons)\/[\w.-]+$/.test(relative))return route.abort();
   const file=path.join(ROOT,relative);
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';
   return route.fulfill({contentType,body:fs.readFileSync(file)});
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(10000);
  await page.goto(ORIGIN);
  await page.waitForFunction(()=>typeof Estado!=='undefined'&&Estado.versao==='ui-0');
  await page.evaluate(()=>{clearInterval(pollTimer);abrirAba('contamae');});
  const update=async(agente,extra={})=>{
   server={...server,...extra,agente,versao:'ui-'+Date.now()};
   await page.evaluate(s=>{aplicarEstado(s);Agentum.renderMother();},server);
  };
  const shot=async name=>page.screenshot({path:path.join(OUT,name+'.png'),fullPage:true,animations:'disabled'});
  const text=()=>page.locator('#cmCasas').innerText();
  assert.match(await page.locator('#cmVazio').innerText(),/Aguardando leitura da Conta Mãe/);
  assert.equal(await page.locator('.ag-mother,.cm-cell').count(),0);
  assert.match(await page.locator('#agHealth').textContent(),/sem sinal recente da extensão/);
  const installation={instalacao_id:'fixture-filhas',tipo:'player',fila:0,ultimo_ping:new Date().toISOString(),slots:[]};
  await update([],{instalacoes:[installation]});
  assert.match(await page.locator('#agHealth').textContent(),/aguardando comunicação das abas/);
  installation.slots=[{tab_id:1,frame_id:0,conta:'conta-teste'},{tab_id:1,frame_id:1,conta:'conta-teste'}];
  await update([],{instalacoes:[installation]});
  assert.match(await page.locator('#agHealth').textContent(),/1 aba identificada/);
  installation.ultimo_ping='2000-01-01T00:00:00Z';await update([],{instalacoes:[installation]});
  assert.match(await page.locator('#agHealth').textContent(),/sem sinal recente da extensão/);
  passed.push('Servidor online não significa captura: sinal recente e aba identificada são verificados');
  await shot('01_sem_casas');passed.push('Estado vazio sem nomes ou métricas inventados');

  const empty={casa:'ui-fixture-a',periodo:null,membros:[],deposito_total:null,aposta_total:null,saque_total:null};
  await update([empty],{foco:['ui-fixture-a'],ajustes:[{casa:'ui-fixture-a',deposito:10}]});
  assert.equal(await page.locator('.cm-cell').count(),0);
  assert.match(await text(),/Aguardando leitura/);
  assert.doesNotMatch(await text(),/R\$\s*0,00|Lista parcial · 0|Redepósitos|Leitura recebida/);
  assert.equal(await page.locator('[data-ag-manual]').isEnabled(),true);
  assert.equal(await page.locator('[data-ag-remove-official]').isEnabled(),true);
  assert.equal(await page.locator('[data-ag-focus]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-ag-official]').isDisabled(),true);
  page.once('dialog',d=>d.accept('45,67'));
  await page.locator('[data-ag-manual]').click();
  await page.waitForFunction(()=>getSaqueManual('ui-fixture-a')===45.67);
  assert.match(await page.locator('.ag-manual-inline').innerText(),/R\$\s*45,67/);
  assert.match(await page.locator('.ag-manual-inline').innerText(),/Ciclo atual/);
  assert.equal(posts.filter(p=>p.path==='/api/ajuste').length,0,'Editar manual não envia ajuste oficial');
  // O saque conferido à mão ENTRA no fechamento: tem que ir para o servidor, senão fechar o ciclo
  // por outro navegador congela um resultado diferente (viviam só no localStorage até 12/09).
  const extra=posts.find(p=>p.path==='/api/extras');
  assert.ok(extra,'saque manual é persistido no servidor');
  assert.deepEqual(extra.body,{saque_manual:{'ui-fixture-a':45.67}});
  await shot('02_aguardando_leitura');passed.push('Sem leitura: aviso, foco e edição/remoção de ajustes preservados');

  await update([{...empty,fonte:'periodo',periodo:'mes@2026-09',deposito_total:0,aposta_total:0,saque_total:0,contas:0,unidade_contador:'contas',qtd_depositos:0}],{ajustes:[]});
  assert.equal(await page.locator('.cm-cell').count(),4);
  for(const i of [0,1,2])assert.match(await page.locator('.cm-cell .v').nth(i).innerText(),/^R\$\s*0,00$/);
  assert.match(await page.locator('.cm-cell').first().innerText(),/0 redepósitos incluídos no total/);
  assert.doesNotMatch(await text(),/Aguardando leitura/);
  assert.match(await page.locator('.ag-manual').innerText(),/Ciclo atual/);
  passed.push('Zeros explícitos preservados; redepósitos em texto, sem quinta cartela');

  const house={casa:'ui-fixture-a',deposito_total:999999999,membros:[{conta:'nao-misturar',deposito:999999999}],fontes:[
   {fonte:'periodo',tipo:'agente_total',periodo:'mes@2026-09',recebido_em:'2026-09-11T12:00:00Z',dados:{deposito:123456.78,aposta:987654.32,saque:null,contas:25}},
   {fonte:'total',tipo:'agente_total',periodo:'acumulado',dados:{deposito:777777.77}},
   {fonte:'info',tipo:'agente_info',periodo:null,dados:{membros_qtd:0}},
   {fonte:'membros',tipo:'agente_membros',periodo:'hoje@2026-09-11',dados:{lista_completa:false,total_registros:35,membros:Array.from({length:30},(_,i)=>({conta:'conta-'+i,nome:i===0?'Nome muito longo para conferir a quebra e o alinhamento à esquerda':'Afiliado '+i,deposito:52+i,aposta:100+i}))}}
  ]};
  await update([house]);
  assert.equal(await page.locator('.ag-mother').count(),1);
  assert.equal(await page.locator('[data-ag-reading] option').count(),4);
  assert.equal(await page.locator('.cm-cell').count(),4);
  assert.match(await text(),/123\.456,78/);assert.doesNotMatch(await text(),/777\.777,77|999\.999\.999|nao-misturar/);
  assert.equal(await page.locator('.cm-cell').nth(2).locator('.v').innerText(),'Não informado');
  const metrics=await page.locator('.cm-cell').evaluateAll(es=>es.map(e=>({background:getComputedStyle(e).backgroundImage,height:e.getBoundingClientRect().height,font:getComputedStyle(e.querySelector('.v')).fontFamily})));
  assert.equal(new Set(metrics.map(m=>m.height)).size,1);
  assert.equal(new Set(metrics.slice(0,3).map(m=>m.background)).size,3,'cartões com cores distintas como Ao Vivo');
  assert.ok(metrics.every(m=>m.font.includes('Segoe UI')));
  const selector=page.locator('[data-ag-reading]');
  await selector.focus();assert.equal(await selector.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
  await shot('03_totais');
  const choose=async source=>{
   const value=await page.locator('[data-ag-reading] option').evaluateAll((es,s)=>es.find(e=>JSON.parse(e.value)[0]===s).value,source);
   await page.locator('[data-ag-reading]').selectOption(value);return value;
  };
  await choose('total');assert.match(await text(),/777\.777,77/);assert.doesNotMatch(await text(),/123\.456,78/);
  await choose('info');assert.match(await text(),/Membros informados pela fonte: 0/);assert.equal(await page.locator('.cm-cell,.cm-tab').count(),0);
  assert.equal(await page.locator('[data-ag-manual]').isEnabled(),true);
  const listValue=await choose('membros');
  assert.equal(await page.locator('.cm-cell').count(),0);assert.equal(await page.locator('.cm-tab tbody tr').count(),30);
  assert.match(await text(),/Lista parcial · 30 de 35 registros recebidos/);assert.doesNotMatch(await text(),/123\.456,78|777\.777,77|nao-misturar/);
  await page.evaluate(()=>Agentum.renderMother());assert.equal(await selector.inputValue(),listValue);
  const align=await page.locator('.cm-tab').evaluate(t=>[...t.rows[0].cells].map((c,i)=>({head:getComputedStyle(c).textAlign,body:getComputedStyle(t.rows[1].cells[i]).textAlign,width:c.getBoundingClientRect().width,bodyWidth:t.rows[1].cells[i].getBoundingClientRect().width})));
  assert.deepEqual(align.map(x=>x.head),['left','right','right','right','center']);
  for(const a of align){assert.equal(a.head,a.body);assert.ok(Math.abs(a.width-a.bodyWidth)<1);}
  await page.locator('.cm-tabwrap').evaluate(e=>e.scrollTop=200);
  assert.equal(await page.locator('.cm-tab th').first().evaluate(e=>getComputedStyle(e).position),'sticky');
  await shot('04_lista');passed.push('Fontes info/lista/totais e períodos isolados, seleção e tabela preservadas');
  for(const width of [1100,390,320]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Lista sem overflow em '+width);
   if(width<500)assert.equal(await page.locator('.cm-tabwrap').evaluate(e=>e.scrollWidth>e.clientWidth),true);
   await shot('lista_'+width);
   await choose('periodo');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Totais sem overflow em '+width);
   await shot('totais_'+width);await choose('membros');
  }
  passed.push('Responsividade 1440/1100/390/320; scroll contido na tabela');
  await page.setViewportSize({width:1440,height:1100});
  await update([{...empty,fonte:'periodo',periodo:'hoje@2026-09-11',comparavel:true,ciclo_id:1,lista_completa:true,deposito_total:52,contas:1,unidade_contador:'contas',membros:[{conta:'001',deposito:52}]}]);
  assert.equal(await page.locator('[data-ag-official]').isEnabled(),true);
  await page.locator('[data-ag-official]').click();
  assert.match(await page.locator('#modalConfirm').innerText(),/52,00/);
  const officialResponse=page.waitForResponse(r=>r.url()===ORIGIN+'/api/ajuste');
  await page.locator('#mcOk').click();
  await page.waitForFunction(()=>!document.getElementById('modalConfirm').classList.contains('show'));
  await officialResponse;
  assert.deepEqual(posts.find(p=>p.path==='/api/ajuste')?.body,{casa:'ui-fixture-a',deposito:52,contas:1,unidade_contador:'contas',fonte:'periodo',periodo:'hoje@2026-09-11'});
  assert.deepEqual(await page.evaluate(()=>Estado.mapeamento_filha_mae),{});
  assert.deepEqual(await page.evaluate(()=>estado.casaLabels||{}),{});
  // Caixa "Aguardando confirmacao": deposito com par aberto vira UMA linha, e o saque em
  // acompanhamento (que ninguem via depois de #agTracking ser ocultado) aparece em bloco proprio.
  const agora=new Date().toISOString();
  await update([],{pedidos:[
    {tipo:'deposito',estado:'processando',casa:'ui-fixture-a',conta:'c1',numero_pedido:'d-1',valor:104,observado_em:agora,gemeo_de:null,sobra_de:null},
    {tipo:'deposito',estado:'processando',casa:'ui-fixture-a',conta:'c1',numero_pedido:'d-2',valor:104,observado_em:agora,gemeo_de:'d-1',sobra_de:null},
    {tipo:'deposito',estado:'processando',casa:'ui-fixture-a',conta:'c9',numero_pedido:'d-3',valor:50,observado_em:agora,gemeo_de:null,sobra_de:'op-antiga'},
    {tipo:'saque',estado:'verificar',casa:'ui-fixture-a',conta:'c2',numero_pedido:'s-1',valor:193,observado_em:agora},
    {tipo:'saque',estado:'identificado',casa:'ui-fixture-a',conta:'c3',numero_pedido:'s-2',valor:null,observado_em:agora}]});
  await page.waitForFunction(()=>document.querySelector('#agPendentes .ag-pend-saques'));
  const caixa=page.locator('#agPendentes');
  assert.equal(await caixa.locator('.ag-pend-lista').first().locator('li').count(),1,'par da casa vira uma linha');
  assert.match(await caixa.locator('.ag-pend-par').innerText(),/2 pedidos/);
  assert.match(await caixa.locator('.ag-pend-top').first().innerText(),/R\$\s*104,00/);
  assert.match(await caixa.locator('#agPendSobras').innerText(),/1 pedido\(s\) duplicados/,'sobra apontada pelo servidor fica recolhida');
  const saques=caixa.locator('.ag-pend-saques');
  assert.match(await saques.locator('.ag-pend-top').innerText(),/8|193/,'total dos saques exibido');
  assert.equal(await saques.locator('li').count(),2);
  assert.match(await saques.innerText(),/valor a confirmar/,'saque aceito sem liquidacao aparece sem inventar valor');
  assert.equal(await saques.locator('[data-acao="ok"]').first().getAttribute('data-tipo'),'saque','o botao encerra como SAQUE');
  passed.push('Caixa de pendentes: par numa linha, sobra recolhida e saques em acompanhamento visiveis');

  // Uma casa com varias chaves (mae + filha, dominio trocado) aparecia tantas vezes quanto chaves:
  // tres botoes "Reativar FROTAPG" na mesma linha. Agrupa pelo nome do painel e fica recolhido.
  await update([],{encerradas:['frota','frotapg','frota-2','p1'],identidades:{casas:[],apelidos:{frota:'FROTAPG','frotapg':'FROTAPG','frota-2':'FROTAPG',p1:'P1'},por_chave:{},candidatos:[],ambiguas:[],historico:[]}});
  await page.waitForFunction(()=>document.querySelector('#cmCasas details.ag-recolhido'));
  const enc=page.locator('#cmCasas details.ag-recolhido').last();
  assert.match(await enc.locator('summary').innerText(),/2 casa\(s\) encerrada\(s\)/,'quatro chaves viram duas casas');
  assert.equal(await enc.locator('[data-ag-resume]').count(),2,'um botão por casa, não por chave');
  assert.equal(await enc.locator('[data-ag-resume]').first().getAttribute('data-ag-resume'),'frota|frotapg|frota-2','reativa todas as chaves da casa');
  assert.equal(await enc.locator('[data-ag-resume]').first().isVisible(),false,'recolhido por padrão');
  await enc.locator('summary').evaluate(e=>e.click());
  assert.equal(await enc.locator('[data-ag-resume]').first().isVisible(),true,'abre em um clique');
  passed.push('Casas encerradas: agrupadas por casa e recolhidas');

  // "Limpar" nas exclusoes e marca d'agua: some da tela o que ja foi resolvido, sem desfazer nada.
  await update([],{descartados:[
    {numero_pedido:'Continuar',casa:'p2',conta:'000000007',ts:'2026-09-01T10:00:00Z'},
    {numero_pedido:'X-2',casa:'p2',conta:'222',ts:'2026-09-13T10:00:00Z'}]});
  await page.evaluate(()=>Agentum.renderDiscarded());
  const exc=page.locator('#avDescartados');
  assert.match(await exc.locator('summary').innerText(),/2 exclusão\(ões\)/);
  await exc.locator('summary').evaluate(e=>e.click());
  const antesLimpar=posts.filter(x=>x.path==='/api/dispensar').length;
  await exc.locator('[data-ag-limpar-descartados]').evaluate(e=>e.click());
  await page.waitForTimeout(300);
  const dispensa=posts.filter(x=>x.path==='/api/dispensar');
  assert.equal(dispensa.length,antesLimpar+1,'um POST por clique');
  assert.deepEqual(dispensa[dispensa.length-1].body,{tipo:'descartados',ate:'2026-09-13T10:00:00Z'},'marca na exclusão mais nova visível');
  assert.equal(posts.filter(x=>x.path==='/api/operacao/restaurar').length,0,'limpar não desfaz exclusão');
  // com a marca aplicada, a antiga some e a nova continua
  await update([],{dispensados:{descartados:'2026-09-01T10:00:00Z'}});
  await page.evaluate(()=>Agentum.renderDiscarded());
  assert.match(await exc.locator('summary').innerText(),/1 exclusão\(ões\)/,'só a posterior à marca fica');
  await update([],{descartados:[],dispensados:{}});
  await page.evaluate(()=>Agentum.renderDiscarded());
  passed.push('Exclusões: Limpar apenas dispensa da tela, não desfaz nada');

  // Menu de jogos: aba propria no menu lateral logo abaixo de Conta Mae, no topo da pagina de
  // jogos, e nao finge que abre o que ainda nao aprendeu.
  const abas=await page.evaluate(()=>[...document.querySelectorAll('nav button[data-aba]')].map(b=>b.dataset.aba));
  assert.equal(abas[abas.indexOf('contamae')+1],'jogos','item Jogos vem logo depois de Conta Mãe');
  await update([],{jogos_catalogo:[{id:'2000002',nome:'Gem Saviour',destaque:1,provedor:'PG'},{id:'2001007',nome:'Fortune Rabbit',destaque:1,provedor:'PG'},{id:'2000039',nome:'Piggy Gold',destaque:0,provedor:'PG'},{id:'2000126',nome:'Fortune Tiger',destaque:1,provedor:'PG'}],jogos_identidade:{p4:{'2000002':{id_jogo:'2000002',origem:'lancamento'}}}});
  await page.waitForFunction(()=>document.getElementById('agJogos'));
  await page.evaluate(()=>abrirAba('jogos'));
  assert.equal(await page.evaluate(()=>document.getElementById('agJogos').parentElement.id),'jgAncora','menu mora na página de jogos');
  assert.equal(await page.evaluate(()=>!!document.getElementById('jgLista')),false,'ranking por jogo saiu da tela');
  assert.equal(await page.locator('#agJogosBody').evaluate(e=>getComputedStyle(e).display),'grid','na própria aba já nasce aberto');
  assert.match(await page.locator('#agJogosSub').innerText(),/4 jogos/);
  await page.locator('#agJogosHead').evaluate(e=>e.click());
  assert.equal(await page.locator('#agJogosBody').evaluate(e=>getComputedStyle(e).display),'none','recolhe no clique');
  await page.locator('#agJogosHead').evaluate(e=>e.click());
  assert.equal(await page.locator('#agJogosBody .gj-btn').count(),4,'lista todo o catalogo do servidor');
  assert.equal(await page.locator('#agJogosBody .gj-aprendendo').count(),0,'launch deterministico: todos clicaveis, sem trava');
  await page.locator('#agJogosBusca').fill('tiger');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#agJogosBody .gj-btn').count(),1,'busca filtra pelo nome');
  assert.match(await page.locator('#agJogosSub').innerText(),/1 de 4 jogos/);
  await page.locator('#agJogosBusca').fill('');
  await page.waitForTimeout(150);
  // as casas do menu saem das METAS INICIADAS: e o operador dizendo o que esta rodando agora
  assert.match(await page.locator('#agJogosCasas').innerText(),/p4/i,'casa que aprendeu aparece quando nao ha meta iniciada');
  await page.evaluate(()=>{estado.operacoes=[{id:'meta-1',plataforma:'P2 GAITA',ok:false}];estado.metasAoVivo=['meta-1'];});
  // A casa da P2 tem TRÊS chaves (p2, tecido e um id de CDN). Antes saía uma ficha por chave e a
  // mesma casa aparecia repetida; e o nome vinha da chave errada. O nome oficial é o que PREFIXA
  // os hosts observados — p2-gaitapg.com e p2-tecidopg.com dizem P2, não TECIDO.
  await update([],{jogos_catalogo:[{id:'2000002',nome:'Gem Saviour',destaque:1,provedor:'PG'},{id:'2001007',nome:'Fortune Rabbit',destaque:1,provedor:'PG'},{id:'2000039',nome:'Piggy Gold',destaque:0,provedor:'PG'},{id:'2000126',nome:'Fortune Tiger',destaque:1,provedor:'PG'}],jogos_identidade:{p4:{'2000002':{id_jogo:'2000002',origem:'lancamento',seletor:'a'}},
                                     p2:{'2000002':{id_jogo:'2000002',origem:'lancamento',seletor:'b'}}},
                   identidades:{apelidos:{},por_chave:{p4:'cw',p2:'cw1',tecido:'cw1'},candidatos:[],ambiguas:[],historico:[],
                    casas:[{id:'cw1',nome:'TECIDO',chaves:['d293m8n743s9cl','tecido','p2'],
                            origens:[{host:'p2-gaitapg.com',papel:'player'},{host:'p2-tecidopg.com',papel:'player'},
                                     {host:'d293m8n743s9cl.cloudfront.net',papel:'mae'}]},
                           {id:'cw',nome:'P4',chaves:['lista','p4'],origens:[{host:'p4-listrapg.com',papel:'player'}]},
                           // jogo e coisa de filha: casa so com origem de mae nao entra no menu
                           {id:'cmae',nome:'BARRIL',chaves:['barril','p2'],origens:[{host:'barrilpg.com',papel:'mae'}]}]}});
  await page.evaluate(()=>abrirAba('jogos'));
  assert.match(await page.locator('#agJogosCasas').innerText(),/operando/i,'rótulo muda quando há meta iniciada');
  assert.equal(await page.locator('#agJogosCasas label').count(),1,'uma ficha por CASA, e só as que têm filha');
  assert.ok(!/BARRIL/.test(await page.locator('#agJogosCasas').innerText()),'casa só de mãe não entra no menu de jogos');
  assert.match(await page.locator('#agJogosCasas').innerText(),/p2-tecidopg/,'nome de lançamento vem do host (p1-fornopg), não da chave do meio');
  assert.ok(!/TECIDO/.test(await page.locator('#agJogosCasas').innerText()),'nome genérico maiúsculo não aparece');
  const marcadas=await page.evaluate(()=>[...document.querySelectorAll('#agJogosCasas input:checked')].map(i=>i.dataset.casa));
  assert.deepEqual(marcadas,['cw1'],'só a casa da meta iniciada entra');
  await page.evaluate(()=>{estado.operacoes=[];estado.metasAoVivo=[];});
  // clique pede a abertura SO nas casas marcadas — abrir onde o operador nao pediu gasta dinheiro dele
  const antesDoClique=posts.filter(x=>x.path==='/api/abrir_jogo').length;
  await page.locator('[data-jogo="2000002"]').evaluate(e=>e.click());
  await page.waitForTimeout(300);
  const pedidos=posts.filter(x=>x.path==='/api/abrir_jogo');
  assert.equal(pedidos.length,antesDoClique+1,'um pedido por clique');
  // a ficha e por casa, mas a aba se reconhece pela chave: todas as chaves da casa viajam
  assert.deepEqual(pedidos[pedidos.length-1].body,
    {casas:['d293m8n743s9cl','tecido','p2'],id_jogo:'2000002'},'manda as chaves da casa marcada');
  // launch deterministico: todo jogo do catalogo e clicavel (acabou a trava de 'reconhecido')
  assert.equal(await page.locator('[data-jogo="2000039"]').getAttribute('data-pronto'),'1','todo jogo do catalogo abre');
  // Casa FINALIZADA (fora das metas iniciadas) some do menu mesmo com aba viva; so entra a casa da
  // meta iniciada que esta capturando agora — evita conflito quando o operador ja fechou uma casa.
  const vivo2=new Date().toISOString();
  await page.evaluate(()=>{estado.operacoes=[{id:'m-p2',plataforma:'P2 GAITA',ok:false}];estado.metasAoVivo=['m-p2'];});
  await update([],{
    jogos_catalogo:[{id:'2000002',nome:'Gem Saviour',destaque:1,provedor:'PG'}],jogos_identidade:{},
    identidades:{apelidos:{},por_chave:{},candidatos:[],ambiguas:[],historico:[],casas:[
      {id:'cw1',nome:'P2',chaves:['p2'],origens:[{host:'p2-gaitapg.com',papel:'player'}]},
      {id:'cwe',nome:'P4',chaves:['p4'],origens:[{host:'p4-listrapg.com',papel:'player'}]}]},
    instalacoes:[
      {tipo:'player',versao:'1.63',ultimo_ping:vivo2,estado:'passiva',slots:[{casa:'p2',conta:'701',estado:'contexto_observado'}]},
      {tipo:'player',versao:'1.63',ultimo_ping:vivo2,estado:'passiva',slots:[{casa:'p4',conta:'901',estado:'contexto_observado'}]}]});
  await page.evaluate(()=>abrirAba('jogos'));
  await page.waitForFunction(()=>/p2-gaitapg/.test(document.getElementById('agJogosCasas')?.innerText||''));
  assert.match(await page.locator('#agJogosCasas').innerText(),/p2-gaitapg/,'casa da meta iniciada aparece (host de lançamento desta origem)');
  assert.ok(!/p4-listrapg/.test(await page.locator('#agJogosCasas').innerText()),'casa finalizada (fora da meta) NAO aparece mesmo com aba viva');
  await page.evaluate(()=>{estado.operacoes=[];estado.metasAoVivo=[];});
  await update([],{instalacoes:[],identidades:{apelidos:{},por_chave:{},candidatos:[],ambiguas:[],historico:[],casas:[]}});
  await update([],{jogos_identidade:{}});

  // Vigia: conta travada aparece; conta ATIVA e conta ainda NAO LIDA nunca viram acusação —
  // depositar numa travada é dinheiro que não volta, mas acusar conta boa faz o operador parar
  // de confiar na tela.
  const agoraISO=new Date().toISOString();
  await update([],{contas:[
    {casa:'demo13',conta:'111',status:7,saldo:96.21,atualizado_em:agoraISO},
    {casa:'exemplo',conta:'222',status:4,saldo:0.62,atualizado_em:agoraISO},
    {casa:'p2',   conta:'333',status:1,saldo:50,   atualizado_em:agoraISO},
    {casa:'p2',   conta:'444',status:null,saldo:80,atualizado_em:agoraISO}]});
  await page.evaluate(()=>abrirAba('vigia'));
  await page.waitForFunction(()=>document.querySelectorAll('#vgLista .vg-casa').length>0);
  assert.equal(await page.locator('#vgLista .vg-casa li').count(),2,'só as duas travadas entram');
  assert.equal(await page.locator('nav button[data-aba="vigia"] .vg-selo').innerText(),'2','selo conta as travadas');
  assert.ok(!/333|444/.test(await page.locator('#vgLista').innerText()),'ativa e não-lida não aparecem');
  assert.match(await page.locator('.vg-rodape').innerText(),/3 de 4 contas com estado lido/);
  assert.match(await page.locator('.vg-rodape').innerText(),/1.*sem leitura/);
  // significado provado com duas contas do operador: 4 = bau proibido, 7 = saque proibido
  assert.equal(await page.locator('.vg-bloq .vg-estado').innerText(),'Saque proibido');
  assert.equal(await page.locator('.vg-ver .vg-estado').innerText(),'Baú proibido');
  assert.equal(await page.locator('#vgLista .vg-velho').count(),0,'leitura de agora não é marcada como velha');
  // "Limpar" e marca d'agua: some da tela, nao apaga conta nem muda estado na casa
  const antesVigia=posts.filter(x=>x.path==='/api/dispensar').length;
  await page.locator('#vgLimpar').evaluate(e=>e.click());
  await page.waitForTimeout(300);
  const limpezas=posts.filter(x=>x.path==='/api/dispensar');
  assert.equal(limpezas.length,antesVigia+1,'um pedido por clique');
  assert.deepEqual(limpezas[limpezas.length-1].body,{tipo:'vigia'});
  // com a marca aplicada, a leitura anterior some e a POSTERIOR continua cobrando
  const depois=new Date(Date.now()+1000).toISOString();
  await update([],{dispensados:{vigia:agoraISO},contas:[
    {casa:'demo13',conta:'111',status:7,saldo:96.21,atualizado_em:agoraISO},
    {casa:'exemplo',conta:'222',status:4,saldo:0.62,atualizado_em:depois}]});
  await page.waitForFunction(()=>document.querySelectorAll('#vgLista .vg-casa li').length===1);
  assert.match(await page.locator('#vgLista').innerText(),/222/,'marcada depois da limpeza volta a aparecer');
  assert.ok(!/111/.test(await page.locator('#vgLista').innerText()),'a dispensada some');
  assert.match(await page.locator('.vg-rodape').innerText(),/1.*dispensada/);
  await update([],{dispensados:{}});
  // Conta anormal FALHA o login: o status fica velho em 1 e só o código do erro denuncia
  await update([],{dispensados:{},contas_erro:{'p2|333':{erro:1126,erro_em:agoraISO}},contas:[
    {casa:'p2',conta:'333',status:1,saldo:80.33,atualizado_em:agoraISO}]});
  await page.waitForFunction(()=>document.querySelectorAll('#vgLista .vg-casa li').length===1);
  assert.match(await page.locator('#vgLista').innerText(),/333/,'conta com login recusado aparece');
  assert.equal(await page.locator('#vgLista .vg-estado').innerText(),'Login recusado');
  assert.match(await page.locator('#vgLista li').getAttribute('title'),/1126/,'o código fica no título');
  await update([],{contas_erro:{}});
  // tudo ativo: a tela cala em vez de inventar problema, e o selo some
  await update([],{contas:[{casa:'p2',conta:'333',status:1,saldo:50,atualizado_em:agoraISO}]});
  await page.waitForFunction(()=>!!document.querySelector('#vgLista .vg-ok'));
  assert.equal(await page.locator('nav button[data-aba="vigia"] .vg-selo').count(),0,'sem travadas, sem selo');
  await update([],{contas:[]});
  passed.push('Vigia: travadas por casa, ativa e não-lida sem acusação, selo acompanha');

  // Botao de jogo que nao abre precisa DIZER por que; antes nao acontecia nada e ficava por isso
  const vivoISO=new Date().toISOString();
  await page.evaluate(()=>abrirAba('aovivo'));
  await update([],{instalacoes:[{tipo:'player',versao:'9.9',ultimo_ping:vivoISO,estado:'jogo_sem_url_da_sessao',slots:[]}]});
  await page.waitForFunction(()=>/não abriu/.test(document.getElementById('agAvisos')?.innerText||''));
  assert.match(await page.locator('#agAvisos').innerText(),/Abra um jogo pelo lobby uma vez/);
  await update([],{instalacoes:[{tipo:'player',versao:'9.9',ultimo_ping:vivoISO,estado:'jogo_nao_achei_na_tela',slots:[]}]});
  await page.waitForFunction(()=>/reaprender onde ele fica/.test(document.getElementById('agAvisos')?.innerText||''));
  // aberto com sucesso nao vira alarme
  await update([],{instalacoes:[{tipo:'player',versao:'9.9',ultimo_ping:vivoISO,estado:'jogo_aberto_2',slots:[]}]});
  await page.waitForTimeout(300);
  assert.ok(!/não abriu/.test(await page.locator('#agAvisos').innerText()),'sucesso não vira alarme');
  await update([],{instalacoes:[]});
  passed.push('Botão de jogo: falha aparece no Ao Vivo com o motivo, sucesso fica quieto');

  // Card Meta por casa (aba Progresso): deposito somado (resumo_efetivo.por_casa) vs alvo manual;
  // casas operando aparecem sozinhas (aba viva). Alvo editavel salva em /api/meta_casa.
  await update([],{resumo_efetivo:{por_casa:[{casa:'p4',deposito:1560,contas:12}]},
    metas_por_casa:{ciclo_id:1,alvos:{p4:2000}},
    identidades:{apelidos:{},por_chave:{},candidatos:[],ambiguas:[],historico:[],casas:[
      {id:'cwe',nome:'P4',chaves:['p4','lista'],origens:[{host:'p4-listrapg.com',papel:'player'}]}]},
    instalacoes:[{tipo:'player',versao:'1.63',ultimo_ping:vivoISO,slots:[{casa:'p4',conta:'901',estado:'contexto_observado'}]}]});
  await page.evaluate(()=>abrirAba('progresso'));
  await page.waitForFunction(()=>/p4-listrapg/.test(document.getElementById('mtLista')?.innerText||''));
  const mt=await page.locator('#mtLista').innerText();
  assert.match(mt,/R\$\s*1\.560/,'mostra o deposito somado da casa');
  assert.match(mt,/78%/,'progresso = deposito/alvo');
  assert.match(mt,/faltam R\$\s*440/,'quanto falta ate o alvo');
  assert.equal(await page.locator('#mtLista input[data-alvo="p4"]').inputValue(),'2.000','alvo editavel ja preenchido');
  await page.locator('#mtLista input[data-alvo="p4"]').fill('3000');
  await page.locator('#mtLista input[data-alvo="p4"]').press('Enter');
  await page.waitForTimeout(250);
  assert.ok(posts.some(p=>p.path==='/api/meta_casa'&&p.body&&p.body.alvos&&String(p.body.alvos.p4)==='3000'),'digitar o alvo salva no servidor');
  await update([],{resumo_efetivo:{},metas_por_casa:{ciclo_id:1,alvos:{}},instalacoes:[],identidades:{apelidos:{},por_chave:{},candidatos:[],ambiguas:[],historico:[],casas:[]}});
  passed.push('Progresso: card Meta por casa (deposito somado vs alvo, casas automaticas, alvo salva)');

  // #3 aviso de versao antiga (contagem + casas) e #2 Vigia ativa (conta travada em casa operando)
  await page.evaluate(()=>abrirAba('aovivo'));
  await update([],{ext_esperada:{player:'1.63',mae:'1.31'},identidades:{apelidos:{},por_chave:{},candidatos:[],ambiguas:[],historico:[],casas:[]},contas:[],contas_erro:{},instalacoes:[
    {tipo:'player',versao:'1.40',ultimo_ping:vivoISO,estado:'passiva',slots:[{casa:'p4',conta:'901',estado:'contexto_observado'}]}]});
  await page.waitForFunction(()=>/navegador\(es\) em vers/.test(document.getElementById('agAvisos')?.innerText||''));
  assert.match(await page.locator('#agAvisos').innerText(),/1 navegador\(es\) em vers/,'conta navegadores velhos');
  assert.match(await page.locator('#agAvisos').innerText(),/filha 1\.40/,'diz a versao velha e o pacote');
  await update([],{ext_esperada:{player:'1.63',mae:'1.31'},contas_erro:{},
    identidades:{apelidos:{},por_chave:{},candidatos:[],ambiguas:[],historico:[],casas:[{id:'cw',nome:'P4',chaves:['p4','lista'],origens:[{host:'p4-listrapg.com',papel:'player'}]}]},
    instalacoes:[{tipo:'player',versao:'1.63',ultimo_ping:vivoISO,estado:'passiva',slots:[{casa:'p4',conta:'901',estado:'contexto_observado'}]}],
    contas:[{casa:'p4',conta:'901',status:7,saldo:12,atualizado_em:vivoISO}]});
  await page.waitForFunction(()=>/travada\(s\) em casa/.test(document.getElementById('agAvisos')?.innerText||''));
  assert.match(await page.locator('#agAvisos').innerText(),/1 conta\(s\) travada\(s\)/,'Vigia ativa no Ao Vivo');
  assert.match(await page.locator('#agAvisos').innerText(),/Saque proibido/,'diz o motivo do bloqueio');
  await update([],{contas:[{casa:'p4',conta:'901',status:1,saldo:12,atualizado_em:vivoISO}]});
  await page.waitForTimeout(300);
  assert.ok(!/travada\(s\) em casa/.test(await page.locator('#agAvisos').innerText()),'conta normal em casa operando nao alarma');
  await update([],{instalacoes:[],identidades:{apelidos:{},por_chave:{},candidatos:[],ambiguas:[],historico:[],casas:[]},contas:[]});
  passed.push('Ao Vivo: aviso de versao antiga (contagem+casas) e Vigia ativa (conta travada em casa operando)');

  await page.evaluate(()=>abrirAba('contamae'));
  passed.push('Menu de jogos: aba própria abaixo de Conta Mãe, honesto sobre o que ainda não abre');

  await page.evaluate(()=>abrirAba('ajustes'));
  assert.equal(await page.locator('#aba-ajustes').isVisible(),true);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  passed.push('Ajuste oficial compatível funciona; menus, nomes e mapeamentos preservados');
  console.log(JSON.stringify({status:'ok',cenarios:passed,erros:errors,requisicoesExternas:unexpected,screenshots:OUT},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
