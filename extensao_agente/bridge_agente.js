/* Navegação de leitura da Conta Mãe. Respostas entram na fila durável antes de avançar a página; entrega HTTP tem ACK próprio. */
(function(){
 'use strict';
 var Core=window.AgentumMotherCore, run=null, config=null, evidence=[], processing=false, deliveryBlocked=false,lastStatus='',lastStatusAt=0,lastResponse=null;
 var LABELS={hoje:['hoje'],ontem:['ontem'],semana:['esta semana','essa semana','semana atual'],ultima:['ultima semana'],mes:['este mes','mes atual']};
 function get(k){try{return sessionStorage.getItem(k);}catch(_){return null;}}
 function put(k,v){try{sessionStorage.setItem(k,v);return true;}catch(_){return false;}}
 function save(){if(run)put('__opag_run',JSON.stringify(run));}
 try{run=JSON.parse(get('__opag_run')||'null');}catch(_){}
 function text(el){return String(el&&el.textContent||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
 // PAUSA MANUAL: enquanto o operador mexe na conta mae, a automacao nao navega nem clica.
 // Sem isto a pagina era arrancada de volta no meio do trabalho (start() renavega por ate 120s
 // e o tique reclica a aba a cada 3s). So interacao REAL conta: o clique da propria extensao
 // chega com isTrusted=false, entao a automacao nunca se pausa sozinha.
 var PAUSA_MANUAL=300000,TETO_PAUSA=1800000;
 function pausado(){
  var ultimo=Number(get('__opag_manual')||0);
  if(!ultimo||Date.now()-ultimo>=PAUSA_MANUAL)return false;
  // TETO: sem ele, rolar a pagina a cada 2 min renova a pausa indefinidamente e a leitura da mae
  // nunca roda — captura parada em silencio, que e o modo de falha que este projeto ja pagou caro.
  // Passados 30 min de janela continua, a automacao volta a agir mesmo com o operador na aba.
  return Date.now()-Number(get('__opag_manual_inicio')||ultimo)<TETO_PAUSA;
 }
 function encerrarRun(){if(run&&run.phase){run.phase=null;run.motivo='pausado_manual';run.unknown=false;run.retries=0;save();}}
 function marcarManual(){
  var quando=Date.now(),ultimo=Number(get('__opag_manual')||0);
  if(!ultimo||quando-ultimo>=PAUSA_MANUAL)put('__opag_manual_inicio',String(quando)); // nova janela
  put('__opag_manual',String(quando));
  // Encerra a leitura em andamento. Retomar pela metade seria pior que recomecar: o operador pode
  // ter trocado de aba, de periodo ou de pagina, e os prazos de 45s/120s venceriam durante a pausa.
  // Mas o que JA foi coletado e entregue antes (sem navegar — a aba e do operador agora).
  if(!run||!run.phase)return;
  var evidencia=run.phase==='directData'?run.lastEvidence:null;
  if(evidencia&&!processing){
   processing=true;
   finishList(evidencia,'pausado_manual',true).catch(function(){}).then(function(){processing=false;encerrarRun();});
   return;
  }
  encerrarRun();
 }
 ['pointerdown','keydown','wheel'].forEach(function(nome){
  try{window.addEventListener(nome,function(e){if(e&&e.isTrusted)marcarManual();},true);}catch(_){}
 });
 function siteOK(){
  try{
   if(window.top!==window||/^(localhost|127\.0\.0\.1)$/.test(location.hostname)||/pgpay|pgapp/i.test(location.hostname))return false;
   var stored=JSON.parse(localStorage.getItem('web__lobby__persisted__token')||'null'),t=stored&&(stored.tokenInfos||stored);
   // Só verifica presença em memória; não transmite a sessão nem efetua login.
   return !!(t&&['session_key','jwt_token','userkey'].some(k=>typeof t[k]==='string'&&t[k].trim()));
  }catch(_){return false;}
 }
 function casa(){var h=location.hostname.replace(/^www\./,'').toLowerCase(),m=h.match(/([a-z]+?)pg(?:pay|app)?\d*\./);return m?m[1]:h.split('.')[0].split('-')[0];}
 function allowed(c){return c&&c.disponivel!==false&&(!c.casas.length||c.casas.indexOf(casa())>=0)&&c.encerradas.indexOf(casa())<0;}
 function status(reason){
  if(reason===lastStatus&&Date.now()-lastStatusAt<30000)return;
  lastStatus=reason;lastStatusAt=Date.now();
  try{chrome.runtime.sendMessage({__opagstatus:{estado:reason,casa:casa(),ultima_resposta:lastResponse}},()=>void chrome.runtime.lastError);}catch(_){}
 }
 function blocked(){
  if(!siteOK())return 'sem_sessao';
  if(pausado())return 'pausado_manual';
  if(!config)return 'aguardando_configuracao';
  if(config.disponivel===false)return 'servidor_indisponivel';
  if(config.encerradas.includes(casa()))return 'casa_encerrada';
  if(config.casas.length&&!config.casas.includes(casa()))return 'fora_do_foco';
  if(deliveryBlocked)return 'fila_pendente';
  return '';
 }
 function nav(tab){var u=new URL(location.href);u.pathname='/home/promote';u.searchParams.set('active',tab);location.href=u.toString();}
 function atReport(tab){try{var u=new URL(location.href);return u.pathname.replace(/\/+$/,'')==='/home/promote'&&u.searchParams.get('active')===tab;}catch(_){return false;}}
 function targetButton(){var xs=document.querySelectorAll('.ui-tab,[role=tab]'),ls=LABELS[run&&run.target]||[];for(var i=0;i<xs.length;i++)if(ls.includes(text(xs[i])))return xs[i];return null;}
 // Mesma tolerancia do hook: a marca de "ativo" pode vir como ui-tab-active, ui-tab-card-active,
 // aria-selected, ou estar no elemento pai. Aceitar so '.ui-tab-active' travava a navegacao inteira.
 function marked(el){
  if(!el)return false;
  try{
   if(el.getAttribute&&el.getAttribute('aria-selected')==='true')return true;
   var cl=el.classList;
   if(cl&&typeof cl.contains==='function'){
    if(cl.contains('ui-tab-active')||cl.contains('active'))return true;
    for(var i=0;i<(cl.length||0);i++)if(/(?:^|[_-])active(?:$|[_-])/.test(String(cl[i])))return true;
   }
   var c=el.className;c=String(c&&c.baseVal!=null?c.baseVal:c||'');
   return /(?:^|[\s_-])active(?:$|[\s_-])/.test(c);
  }catch(_){return false;}
 }
 function active(){var b=targetButton();return !!(b&&(marked(b)||marked(b.parentElement)));}
 function configuration(){return new Promise(resolve=>{try{chrome.runtime.sendMessage({__opagfoco:1},c=>{if(chrome.runtime.lastError){if(config)config.disponivel=false;return resolve(null);}if(c){config=c;if(c.disponivel!==false)drain();}resolve(c);});}catch(_){if(config)config.disponivel=false;resolve(null);}});}
 function deliver(evt){return new Promise(resolve=>{try{chrome.runtime.sendMessage({__opagev:1,evt:evt},r=>resolve(!chrome.runtime.lastError&&!!(r&&r.ok)));}catch(_){resolve(false);}});}
 function start(c){
  if(pausado()){status('pausado_manual');return;}
  if(!siteOK()||!allowed(c)){status(blocked()||'servidor_indisponivel');return;}
  if(evidence.length||processing){status('fila_pendente');return;}
  if(run&&run.phase&&Date.now()-run.started<120000){if(['directData','myData'].includes(run.phase)&&!atReport(run.phase))nav(run.phase);return;}
  var last=Number(get('__opag_lastReload')||0);if(Date.now()-last<120000)return;
  run={id:Core.makeId(),phase:'directData',target:c.periodo,started:Date.now(),last:Date.now(),members:{},pages:{},fingerprints:[],steps:0,complete:false,retries:0,unknown:false};
  if(!put('__opag_lastReload',String(Date.now()))||!put('__opag_coleta',run.id))return;
  save();nav('directData');
 }
 function more(){
  var elements=Array.from(document.querySelectorAll('button,[role=button]'));
  var b=elements.find(x=>/^(carregar mais|mostrar mais|mais registros)$/i.test(text(x))&&!x.disabled);
  if(b){b.click();return;}
  // A aplicação observada usa rolagem; não criar URL/API para a página seguinte.
  var areas=Array.from(document.querySelectorAll('main,section,div')).filter(x=>x.clientHeight>100&&x.scrollHeight>x.clientHeight+30&&/auto|scroll/.test(getComputedStyle(x).overflowY));
  areas.sort((a,b)=>b.scrollHeight-a.scrollHeight);
  var el=areas[0]||document.scrollingElement;if(el)el.scrollTop=el.scrollHeight;
  window.scrollTo(0,document.documentElement.scrollHeight);
 }
 async function finishList(ev,reason,semNav){
  var members=Object.values(run.members),pages=Object.keys(run.pages).map(Number).sort((a,b)=>a-b);
  var consecutive=pages.length>0&&pages[0]===1&&pages.every((p,i)=>p===i+1);
  var countProof=ev.total!=null&&members.length===ev.total;
  var complete=ev.mais===false&&(consecutive||countProof)&&!reason;
  var aggregate=Object.assign({},ev,{coleta_id:run.id+':consolidado',membros:members,pagina:1,total_paginas:complete?1:null,lista_completa:complete,mais:ev.mais,motivo:reason||(!complete?'cobertura_nao_comprovada':'')});
  if(!await deliver(aggregate))return false;
  // semNav: entregar o consolidado sem mexer na pagina (pausa manual) — quem chamou encerra o run.
  if(semNav)return true;
  run.complete=complete;run.phase='myData';run.last=Date.now();save();nav('myData');return true;
 }
 async function process(ev){
  if(!run||!run.phase||!config||!allowed(config)||!active())return;
  if(ev.coleta_id!==run.id||ev.periodo!==Core.period(run.target)||!ev.periodo_observado)return;
  if(run.account&&ev.conta_mae&&run.account!==ev.conta_mae){run.phase=null;run.motivo='conta_alterada';save();status('conta_alterada');return;}
  if(run.phase==='directData'&&ev.tipo==='agente_membros'){
   if(run.account&&run.account!==ev.conta_mae){run.phase=null;run.motivo='conta_alterada';save();status('conta_alterada');return;}
   run.account=ev.conta_mae;run.last=Date.now();run.lastEvidence=ev;run.unknown=false;
   var fingerprint=JSON.stringify((ev.membros||[]).map(x=>[x.conta,x.deposito,x.aposta]));
   if(run.fingerprints.includes(fingerprint))return;
   run.fingerprints.push(fingerprint);(ev.membros||[]).forEach(x=>{run.members[x.conta]=x;});
   if(Number.isInteger(ev.pagina)&&ev.pagina>0)run.pages[ev.pagina]=true;
   run.steps++;save();
   if(ev.mais===true&&run.steps<30){more();return;}
   await finishList(ev,ev.mais===true?'limite_de_paginas':null);
  }else if(run.phase==='myData'&&ev.tipo==='agente_total'&&ev.fonte==='periodo'){
   run.phase=null;run.last=Date.now();run.motivo='atualizado';save();status('atualizado');
  }
 }
 async function drain(){
  if(processing)return;processing=true;
  try{
   while(evidence.length){
    var ev=evidence[0];
    if(!ev.__delivered){if(!await deliver(ev)){deliveryBlocked=true;status('fila_pendente');return;}deliveryBlocked=false;Object.defineProperty(ev,'__delivered',{value:true,enumerable:false});}
    if(!config)return;
    // Ja entregue ao servidor. Durante a pausa nao ha maquina de estados para avancar (o run foi
    // encerrado), entao o evento sai da fila em vez de acumular por toda a janela de 5 min.
    if(pausado()){evidence.shift();continue;}
    // Se o período ainda não está ativo, preservar a resposta rápida até o próximo tick.
    if(run&&run.phase&&ev.coleta_id===run.id&&ev.periodo===Core.period(run.target)&&!active())return;
    if(run&&run.phase&&ev.coleta_id===run.id&&(!ev.periodo_observado||ev.periodo==='desconhecido')){run.unknown=true;save();status('periodo_desconhecido');}
    evidence.shift();await process(ev);
   }
  }finally{processing=false;}
 }
 window.addEventListener('message',e=>{if(e.source!==window||!e.data||e.data.__opagcap!==1||!e.data.evt)return;var ev=e.data.evt;if(!['agente_total','agente_membros','agente_info'].includes(ev.tipo))return;lastResponse=new Date().toISOString();evidence.push(ev);drain();});
 chrome.runtime.onMessage.addListener(msg=>{if(msg&&msg.__opagrefresh){config={casas:msg.foco||[],encerradas:msg.encerradas||[],periodo:msg.periodo,disponivel:true};start(config);}});
 configuration().then(c=>{if(c)start(c);});
 setInterval(function(){
  drain();var reason=blocked();if(reason){status(reason);return;}
  if(!run||!run.phase){status(run&&run.motivo||'aguardando_resposta');return;}
  if(!active()){
   if(Date.now()-run.last>45000&&!processing){
    // A navegação não depende de reconhecer o filtro. Nenhum período é inventado.
    if(run.phase==='directData'){
     if(run.lastEvidence){processing=true;finishList(run.lastEvidence,'periodo_nao_disponivel').finally(()=>processing=false);}
     else{run.phase='myData';run.last=Date.now();run.unknown=false;run.retries=0;save();status('periodo_nao_disponivel');nav('myData');}
    }else{run.phase=null;run.motivo='periodo_nao_disponivel';save();status(run.motivo);}
    return;
   }
   var b=targetButton();if(b&&(!run.lastClick||Date.now()-run.lastClick>3000)){run.lastClick=Date.now();b.click();}
   status('periodo_nao_disponivel');return;
  }
  // Nova leitura pela UI já observada. Não atribuir período a resposta antiga.
  if(run.unknown&&Date.now()-run.last>6000&&(run.retries||0)<2){
   run.retries=(run.retries||0)+1;run.last=Date.now();save();status('tentando_novamente');
   var button=targetButton();if(button)button.click();return;
  }
  status(run.unknown?'periodo_desconhecido':'aguardando_resposta');
  if(Date.now()-run.last>45000&&!processing){
   if(run.phase==='directData'){
    // Só consolidar se houve uma resposta verdadeira com período comprovado.
    if(run.lastEvidence){processing=true;finishList(run.lastEvidence,'tempo_de_consulta_esgotado').finally(()=>processing=false);}
    else {run.phase='myData';run.last=Date.now();run.unknown=false;run.retries=0;save();status('sem_resposta');nav('myData');}
   }else{run.phase=null;run.motivo=run.unknown?'periodo_desconhecido':'sem_resposta';save();status(run.motivo);}
  }
 },1000);
 setInterval(()=>configuration().then(c=>{if(c)start(c);}),300000);
})();
