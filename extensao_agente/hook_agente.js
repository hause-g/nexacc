/* Intercepta apenas relatórios observados da conta mãe; não guarda request, headers ou sessão. */
(function(){
 'use strict';if(window.__opAgHook)return;window.__opAgHook=true;
 var HOST=location.hostname||'',Core=window.AgentumMotherCore;
 var CT={tokens:[],users:[],contaMae:'',contaMaeNome:'',geracao:0};
 var labels={hoje:'hoje',ontem:'ontem','esta semana':'semana','essa semana':'semana','semana atual':'semana','ultima semana':'ultima','este mes':'mes','mes atual':'mes'};
 function relevant(u){return /agent\/promote\/(report\/(?:directReportV5|myPeriodDataV2|myTotalData)|index\/indexInfoV2)(?:[/?]|$)/i.test(u||'');}
 function text(el){return String(el&&el.textContent||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
 // A casa marca a aba ativa de varios jeitos (ui-tab-active, ui-tab-card-active, aria-selected) e as
 // vezes a marca fica no elemento PAI. Exigir exatamente '.ui-tab-active' fazia toda leitura virar
 // 'desconhecido' mesmo com o clique caindo certo na aba.
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
 function period(){
  var xs=document.querySelectorAll('.ui-tab,[role=tab]');
  for(var i=0;i<xs.length;i++){
   var el=xs[i],lb=labels[text(el)];
   if(lb&&(marked(el)||marked(el.parentElement)))return Core.period(lb);
  }
  return 'desconhecido';
 }
 // A casa manda o material de decifragem no HEADER (token / x-object-id), nao na query.
 // Sem isso a chave md5(token+username) nao existe e nenhuma resposta decifra.
 var SEEN_TOKENS=[],SEEN_USERS=[];
 function addToken(t){t=String(t==null?'':t).trim();if(t&&SEEN_TOKENS.indexOf(t)<0){SEEN_TOKENS.unshift(t);SEEN_TOKENS=SEEN_TOKENS.slice(0,6);}}
 function addUser(u){u=Core.id(u);if(u&&SEEN_USERS.indexOf(u)<0){SEEN_USERS.unshift(u);SEEN_USERS=SEEN_USERS.slice(0,6);}}
 function eatHeader(k,v){
  if(/^(token|tk)$/i.test(k))addToken(v);
  else if(/^x-object-id$/i.test(k)){try{var o=JSON.parse(String(v));addUser(o.uid||o.userId||o.user_id||o.username);}catch(_){}}
 }
 function eatHeaders(h){
  try{
   if(!h)return;
   if(typeof Headers!=='undefined'&&h instanceof Headers){h.forEach(function(v,k){eatHeader(k,v);});return;}
   if(Array.isArray(h)){h.forEach(function(p){if(p&&p.length>1)eatHeader(p[0],p[1]);});return;}
   if(typeof h==='object')Object.keys(h).forEach(function(k){eatHeader(k,h[k]);});
  }catch(_){}
 }
 // A casa diz o periodo escolhido NO CORPO da requisicao (cifrado): {"timeEnum":N,"time":...}.
 // Esse numero sai junto com a requisicao: nao depende da aba ter renderizado nem do texto do
 // rotulo, entao e a identidade confiavel do periodo daquela resposta.
 // Alem do timeEnum, o corpo traz page/pageSize do directReportV5 — a resposta NAO tem numero de
 // pagina nem total de paginas (so list/total/more/pageSize), entao sem ler isto aqui a coleta
 // nunca prova cobertura: 349 coletas e ZERO listas consolidadas ate 12/09.
 function corpoDe(body){
  var s=typeof body==='string'?body.trim():'';if(!s)return null;
  var Cx=window.OrionCrypto;
  function pick(t){var o=null;if(!t)return null;try{o=JSON.parse(String(t).replace(/\0+$/,'').trim());}catch(_){return null;}return o&&typeof o==='object'&&(o.timeEnum!=null||o.page!=null)?o:null;}
  if(s.charAt(0)==='{'){var direto=pick(s);if(direto)return direto;}
  if(!Cx)return null;
  var v=pick(Cx.decifrarDefault(s));if(v)return v;
  for(var i=0;i<CT.tokens.length;i++)for(var j=0;j<CT.users.length;j++){v=pick(Cx.decifrarHall(s,CT.tokens[i],CT.users[j]));if(v)return v;}
  return null;
 }
 function anotarCorpo(snap,body){
  var o=null;try{o=corpoDe(body);}catch(_){}
  if(!o)return;
  if(o.timeEnum!=null&&isFinite(o.timeEnum))snap.periodo_enum=Number(o.timeEnum);
  if(o.page!=null&&isFinite(o.page))snap.pagina=Number(o.page);
  if(o.pageSize!=null&&isFinite(o.pageSize))snap.pageSize=Number(o.pageSize);
 }
 function context(url){
  var obj={};try{var raw=JSON.parse(localStorage.getItem('web__lobby__persisted__user')||'{}');obj=raw.userInfos||raw;}catch(_){}
  var uid=Core.id(obj.username||obj.userId||obj.user_id||obj.uid);
  if(uid!==CT.users[0]){CT={tokens:[],users:uid?[uid]:[],contaMae:Core.id(obj.userId||obj.user_id||obj.uid||uid),contaMaeNome:String(obj.platfromid||obj.platformId||''),geracao:CT.geracao+1};}
  try{var u=new URL(url,location.href),t=u.searchParams.get('token')||u.searchParams.get('tk');if(t)addToken(t);}catch(_){}
  SEEN_TOKENS.forEach(function(t){if(CT.tokens.indexOf(t)<0)CT.tokens.push(t);});
  SEEN_USERS.forEach(function(u){if(CT.users.indexOf(u)<0)CT.users.push(u);});
  CT.tokens=CT.tokens.slice(0,6);CT.users=CT.users.slice(0,6);
  var snap=JSON.parse(JSON.stringify(CT));snap.periodo=period();snap.coleta_id=Core.makeId();
  try{snap.coleta_id=sessionStorage.getItem('__opag_coleta')||snap.coleta_id;}catch(_){}
  return snap;
 }
 function handle(url,resp,snap,status){
  if(status<200||status>=300||!snap)return;
  context(url);if(snap.geracao!==CT.geracao)return;
  // O filtro de periodo costuma NAO estar renderizado quando a requisicao sai (document_start),
  // o que marcava tudo como 'desconhecido'. Na resposta a aba ja existe: aproveita a leitura.
  // Conservador: so promove de 'desconhecido' p/ conhecido — nunca sobrescreve um periodo ja observado.
  var per=snap.periodo;
  if(per==='desconhecido'){var visto=period();if(visto!=='desconhecido')per=visto;}
  var out=[];
  try{out=window.OrionAgenteClassify.classificar({url:url,host:HOST,resp:resp,periodo:per,periodo_observado:per!=='desconhecido',periodo_enum:snap.periodo_enum==null?null:snap.periodo_enum,pagina_pedida:snap.pagina==null?null:snap.pagina,pageSize:snap.pageSize==null?null:snap.pageSize,coleta_id:snap.coleta_id,recebido_em:new Date().toISOString()},snap);}catch(_){}
  out.forEach(function(ev){ev.host=window.AgentumOrigem.host(HOST);ev.casa_normalizada=ev.host;try{window.postMessage({__opagcap:1,evt:ev},'*');}catch(_){}});
 }
 var original=window.fetch;
 if(original)window.fetch=function(){
  var args=arguments,url=typeof args[0]==='string'?args[0]:(args[0]&&args[0].url)||'';
  // le o header ANTES de montar o contexto: e daqui que sai o token da decifragem
  eatHeaders((args[1]&&args[1].headers)||(args[0]&&args[0].headers));
  if(!relevant(url))return original.apply(this,args);
  var snap=context(url);
  anotarCorpo(snap,args[1]&&args[1].body);
  return original.apply(this,args).then(function(r){if(r.ok)r.clone().text().then(function(body){handle(url,body,snap,r.status);}).catch(function(){});return r;});
 };
 var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send,xh=XMLHttpRequest.prototype.setRequestHeader;
 XMLHttpRequest.prototype.open=function(m,u){this.__agurl=String(u);return xo.apply(this,arguments);};
 // o token chega por setRequestHeader entre open() e send() — capturar aqui e o unico jeito
 XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{eatHeader(k,v);}catch(_){}if(xh)return xh.apply(this,arguments);};
 XMLHttpRequest.prototype.send=function(corpo){
  var self=this,url=this.__agurl||'';
  if(relevant(url)){var snap=context(url);anotarCorpo(snap,corpo);this.addEventListener('load',function(){try{var body=self.responseType===''||self.responseType==='text'?self.responseText:JSON.stringify(self.response);handle(url,body,snap,self.status);}catch(_){}},{once:true});}
  return xs.apply(this,arguments);
 };
})();
