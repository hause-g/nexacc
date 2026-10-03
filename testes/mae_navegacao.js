'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),Core=require('../extensao_agente/core_agente.js');
let count=0;function check(x,msg){assert.ok(x,msg);count++;}
function make(session=true,initialPath="/home/promote?active=directData"){
 let now=Date.now(),clicks=0;const statuses=[];class Clock extends Date{static now(){return now;}}
 const id='run',s={'__opag_coleta':id,'__opag_run':JSON.stringify({id,phase:'directData',target:'mes',started:Date.now(),last:Date.now(),members:{},pages:{},fingerprints:[],steps:0})};
 const handlers={},timers=[],sent=[];let conf,scrolled=0,nav='',active=true,ack=true,found=true;
 const button={textContent:'Este Mês',classList:{contains:()=>active},getAttribute:()=>null,click:()=>{clicks++;active=true;}};
 const doc={querySelectorAll:selector=>selector.includes('.ui-tab')&&found?[button]:[],scrollingElement:{set scrollTop(v){scrolled++;},scrollHeight:1000},documentElement:{scrollHeight:1000}};
 const location={hostname:'www.pintorpg.com',get href(){return nav||('https://www.pintorpg.com'+initialPath);},set href(v){nav=v;}};
 const win={AgentumMotherCore:Core,addEventListener:(type,f)=>((handlers[type]=handlers[type]||[]).push(f)),scrollTo:()=>scrolled++};win.top=win;
 const chrome={runtime:{lastError:null,sendMessage:(msg,cb)=>{if(msg.__opagstatus){statuses.push(msg.__opagstatus);cb?.({ok:true});return;}if(msg.__opagfoco){conf=cb;return;}if(msg.__opagev){sent.push(JSON.parse(JSON.stringify(msg.evt)));setImmediate(()=>cb({ok:ack}));}},onMessage:{addListener:()=>{}}}};
 vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'../extensao_agente/bridge_agente.js'),'utf8'),{window:win,document:doc,location,sessionStorage:{getItem:k=>s[k]||null,setItem:(k,v)=>s[k]=v},localStorage:{getItem:()=>session?'{"tokenInfos":{"session_key":"fixture-only"}}':'{"tokenInfos":{}}'},chrome,URL,Date:Clock,console,setInterval:f=>timers.push(f),getComputedStyle:()=>({overflowY:'auto'})});
 const disparar=(tipo,ev)=>(handlers[tipo]||[]).forEach(f=>f(ev));
 return {emit:ev=>disparar('message',{source:win,data:{__opagcap:1,evt:ev}}),
  // interacao REAL do operador (isTrusted=true) x clique da propria extensao (isTrusted=false)
  interagir:()=>disparar('pointerdown',{isTrusted:true}),
  interagirFalso:()=>disparar('pointerdown',{isTrusted:false}),configure:(extra={})=>conf({disponivel:true,casas:[],encerradas:[],periodo:'mes',...extra}),advance:ms=>now+=ms,statuses,get clicks(){return clicks;},tick:()=>timers[0](),refresh:()=>timers[1](),sent,s,get scroll(){return scrolled;},get nav(){return nav;},set found(v){found=v;},set active(v){active=v;},set ack(v){ack=v;}};
}
const wait=()=>new Promise(r=>setTimeout(r,15));
function page(n,more,ids){return {tipo:'agente_membros',fonte:'membros',casa:'pintor',conta_mae:'111',coleta_id:'run',periodo:Core.period('mes'),periodo_observado:true,pagina:n,mais:more,total:3,membros:ids.map(conta=>({conta,deposito:50}))};}
(async()=>{
 const c=make();c.emit(page(1,true,['a','b']));await wait();check(c.sent.length===1,'resposta rápida persistida mesmo antes da configuração');check(c.scroll===0,'sem configuração não navega');c.configure();await wait();check(c.scroll>0,'resposta rápida retomada depois da configuração');c.emit(page(2,false,['c']));await wait();const agg=c.sent.find(x=>x.lista_completa);check(agg&&agg.membros.length===3,'última página reúne membros de todas as páginas');check(c.nav.includes('active=myData'),'navega após persistir lista completa');
 const d=make();d.configure();d.active=false;d.emit(page(1,false,['a','b','c']));await wait();check(!d.nav,'aguarda período ativo');d.active=true;d.tick();await wait();check(d.nav.includes('active=myData'),'resposta guardada não se perde durante seleção de período');
 const e=make();e.configure();e.ack=false;e.emit(page(1,false,['a','b','c']));await wait();check(!e.nav,'falha de gravação impede avanço');e.ack=true;e.tick();await wait();check(e.nav.includes('active=myData'),'retoma após gravar');
 const f=make();f.configure();f.emit(Object.assign(page(null,false,['a']),{total:null}));await wait();check(!f.sent.some(x=>x.lista_completa===true),'fim sem evidência de cobertura fica parcial');
 const g=make();g.configure({casas:['outra']});g.emit(page(1,false,['a','b','c']));await wait();g.tick();check(g.sent.length===1&&!g.nav,'foco não bloqueia entrega passiva e impede navegação');check(g.statuses.some(x=>x.estado==='fora_do_foco'),'motivo do foco explícito');
 const j=make();j.configure();j.emit({...page(1,false,['a']),periodo:'desconhecido',periodo_observado:false});await wait();j.advance(7000);j.tick();await wait();j.advance(7000);j.tick();await wait();j.advance(46000);j.tick();await wait();check(j.clicks===2,'recuperação limitada a duas novas leituras');check(j.sent.length===1&&j.sent[0].periodo==='desconhecido','timeout não fabrica agregado nem confirma período retroativamente');check(j.nav.includes('myData'),'sem lista verdadeira tenta a leitura de totais');
 const k=make();k.configure();k.advance(46000);k.tick();await wait();check(k.sent.length===0,'timeout sem resposta não inventa dados');
 const l=make(false);l.configure();l.tick();check(!l.nav&&l.statuses.some(x=>x.estado==='sem_sessao'),'registro vazio no storage não comprova sessão');
 const missing=make();missing.found=false;missing.configure();await wait();missing.advance(46000);missing.tick();await wait();check(missing.nav.includes('active=myData'),'filtro ausente também avança para Meus Dados');check(missing.sent.length===0,'sem período nem resposta não inventa valores');missing.advance(46000);missing.tick();await wait();check(JSON.parse(missing.s.__opag_run).phase===null,'segunda aba ausente termina sem navegação infinita');
 const resume=make(true,'/home/index');resume.configure();await wait();check(resume.nav.includes('active=directData'),'retoma rota de leitura quando run persiste em outra página');
 const blockedResume=make(true,'/home/index');blockedResume.configure({casas:['outra']});await wait();check(!blockedResume.nav,'retomada respeita foco');
 // PAUSA MANUAL: mexer na conta mae nao pode ser interrompido pela automacao.
 const semPuxao=make(true,'/home/index');semPuxao.interagir();semPuxao.configure();await wait();
 check(!semPuxao.nav,'mexendo na página, a extensão não arranca de volta para o relatório');
 check(semPuxao.statuses.some(x=>x.estado==='pausado_manual'),'a pausa manual é informada ao painel');
 check(JSON.parse(semPuxao.s.__opag_run).phase===null,'a leitura em andamento é encerrada, não fica pendurada');
 semPuxao.advance(300001);semPuxao.tick();await wait();
 check(!semPuxao.nav,'o tique não ressuscita sozinho a leitura encerrada pela pausa');
 semPuxao.refresh();semPuxao.configure();await wait();
 check(semPuxao.nav.includes('active=directData'),'passada a janela, o ciclo seguinte retoma a leitura do zero');

 const semClique=make();semClique.configure();await wait();semClique.active=false;
 const antes=semClique.clicks;semClique.interagir();semClique.advance(4000);semClique.tick();await wait();
 check(semClique.clicks===antes,'durante a pausa não clica na aba de período');
 // a fila nao pode inchar durante a janela: o evento ja foi entregue ao servidor
 semClique.emit(page(1,false,['a']));await wait();semClique.emit(page(2,false,['b']));await wait();
 check(semClique.sent.length>=2,'durante a pausa os eventos continuam sendo entregues ao servidor');
 check(!semClique.nav,'entregar não implica navegar durante a pausa');

 const naoPausa=make();naoPausa.configure();await wait();naoPausa.interagirFalso();naoPausa.tick();await wait();
 check(!naoPausa.statuses.some(x=>x.estado==='pausado_manual'),'clique da própria extensão não pausa a automação');

 // TETO da pausa: renovar a interacao a cada 2 min nao pode manter a leitura parada para sempre.
 const teto=make(true,'/home/index');teto.interagir();teto.configure();await wait();
 check(!teto.nav,'durante a pausa a leitura nao acontece');
 for(let i=0;i<20;i++){teto.advance(120000);teto.interagir();}   // 40 min rolando a pagina sem parar
 teto.advance(1000);teto.refresh();teto.configure();await wait();
 check(!!teto.nav,'passados 30 min de janela continua, a leitura volta a acontecer mesmo com o operador na aba');

 // o que ja foi coletado e entregue antes de encerrar o run (sem navegar)
 const salva=make();salva.configure();await wait();
 salva.emit(page(1,true,['a','b']));await wait();
 const antesEnvio=salva.sent.length,antesNav=salva.nav;
 salva.interagir();await wait();
 const parcial=salva.sent.find(x=>x.coleta_id&&String(x.coleta_id).endsWith(':consolidado'));
 check(salva.sent.length>antesEnvio&&!!parcial,'entrega o consolidado do que ja tinha sido lido');
 check(parcial.motivo==='pausado_manual','o motivo registra que foi a pausa manual');
 check(parcial.lista_completa===false,'consolidado parcial nunca se declara completo');
 check(salva.nav===antesNav,'nao navega: a aba e do operador durante a pausa');
 check(JSON.parse(salva.s.__opag_run).phase===null,'o run e encerrado depois de entregar');

 console.log('Navegação mãe: '+count+' verificações aprovadas');
})().catch(e=>{console.error(e);process.exitCode=1;});
