/* Conta Mãe: entrega persistida e atualização pelo fluxo normal da página. */
importScripts('origem_main.js');
importScripts('core_agente.js');
const SRV='http://127.0.0.1:8765', Core=AgentumMotherCore;
const storage={
 get(key){key='nexaccDemoAgV1_'+key;return new Promise((resolve,reject)=>chrome.storage.local.get([key],r=>{const e=chrome.runtime.lastError;e?reject(new Error(e.message)):resolve(r&&r[key]);}));},
 set(key,value){key='nexaccDemoAgV1_'+key;return new Promise((resolve,reject)=>chrome.storage.local.set({[key]:value},()=>{const e=chrome.runtime.lastError;e?reject(new Error(e.message)):resolve();}));}
};
const queue=new Core.DurableQueue(storage,'agFila');
let config={casas:[],encerradas:[],periodo:'mes'},configOK=false,installation='',lastError='',lastEvent=null,slots={};
// Recusa DETERMINISTICA do servidor (400 invalido / 409 conflito): reenviar nao muda o resultado.
// Sem isto o mesmo relatorio voltava a cada minuto para sempre e a fila nunca esvaziava.
// 408/429 e 5xx continuam sendo retentados. Contagem por evento, em memoria do worker.
const tentativas=new Map(), MAX_REJEICOES=3;
let rejeitados=0;
function definitivo(erro){
 const m=/^HTTP_(\d{3})$/.exec(String((erro&&erro.message)||erro||''));
 if(!m)return false;
 const c=Number(m[1]);return c>=400&&c<500&&c!==408&&c!==429;
}
const init=Promise.all([queue.ready,storage.get('agInstallation')]).then(async r=>{installation=r[1]||Core.makeId();await storage.set('agInstallation',installation);}).catch(e=>{lastError='persistencia_indisponivel';throw e;});
init.catch(()=>{});
async function request(path,body){
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
 try{
  const r=await fetch(SRV+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:ctl.signal,cache:'no-store'});
  if(!r.ok)throw new Error('HTTP_'+r.status);
  const j=await r.json();if(!j||j.erro||j.error||j.status==='erro')throw new Error('resposta_invalida');return j;
 }finally{clearTimeout(timer);}
}
async function fetchConfig(){
 try{
  const r=await Promise.all([request('/api/foco'),request('/api/encerradas'),request('/api/periodo')]);
  if(!Array.isArray(r[0].casas)||!Array.isArray(r[1].casas)||!['hoje','ontem','mes','semana','ultima'].includes(r[2].periodo)){configOK=false;return false;}
  config={casas:r[0].casas,encerradas:r[1].casas,periodo:r[2].periodo};configOK=true;return true;
 }catch(_){configOK=false;return false;}
}
async function flush(){
 try{await init;await queue.flush(async(ev,eventId)=>{
  try{
   // Legado diagnóstico não é reenviado; não contém operação financeira.
   if(/^__/.test(ev.tipo||''))return true;
   const payload=Object.assign({},ev,{event_id:eventId});
   // Versões antigas não informavam o intervalo observado: não datar retroativamente.
   if(['hoje','ontem','mes','semana','ultima'].includes(payload.periodo)){payload.periodo='desconhecido';payload.periodo_observado=false;}
   const j=await request('/api/agente',payload);
   if(!['ok','duplicado','enriquecido','promovido','descartado'].includes(j.status))return false;
   const ack=j.ack&&typeof j.ack==='object'?j.ack.event_id:j.event_id;
   if(ack!==eventId)return false;
   tentativas.delete(eventId);lastError='';lastEvent=Date.now();return true;
  }catch(erro){
   if(definitivo(erro)){
    const n=(tentativas.get(eventId)||0)+1;tentativas.set(eventId,n);
    if(n>=MAX_REJEICOES){
     tentativas.delete(eventId);rejeitados++;
     lastError='eventos_rejeitados_'+rejeitados;
     return true;   // sai da fila: o servidor ja decidiu, e o estado avisa o painel
    }
   }
   lastError=lastError.startsWith('eventos_rejeitados_')?lastError:'entrega_pendente';return false;
  }
 });}catch(_){lastError='persistencia_indisponivel';}
}
// 'esperada' e a versao que o servidor empacotou, devolvida no ping anterior: a extensao velha
// se declarava 'ativo' e so o painel aberto notava a diferenca. Vai para o armazenamento porque o
// worker MV3 morre entre um ping e outro.
async function ping(){try{await init;const versao=chrome.runtime.getManifest().version;
 const esperada=await storage.get('agEsperada');
 const r=await request('/api/ping',{version:'mae-'+versao,versao:versao,tipo:'mae',instalacao_id:installation,fila:queue.items.length,ultimo_evento:lastEvent,estado:lastError||(esperada&&esperada!==versao?'versao_antiga_'+esperada:'ativo'),slots:Object.values(slots).filter(s=>Date.now()-s.diagnosticado_em<180000).map(s=>({...s,diagnosticado_em:new Date(s.diagnosticado_em).toISOString()}))});
 if(r&&typeof r.esperada==='string'&&r.esperada!==esperada)await storage.set('agEsperada',r.esperada);}catch(_){}}
function alarm(name,minutes){chrome.alarms.get(name,a=>{if(!a)chrome.alarms.create(name,{periodInMinutes:minutes,delayInMinutes:minutes});});}
alarm('opag_refresh',5);alarm('opag_delivery',1);
async function refresh(){
 if(!await fetchConfig())return;
 chrome.tabs.query({url:["http://maeteste.invalid/*"]},tabs=>(tabs||[]).forEach(t=>{if(t.id!=null)chrome.tabs.sendMessage(t.id,Object.assign({__opagrefresh:1},config,{foco:config.casas}),()=>void chrome.runtime.lastError);}));
}
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='opag_refresh')refresh();if(a.name==='opag_delivery'){flush();ping();}});
function demoSender(sender){
 try{return !!sender.tab&&new URL(sender.url).origin==='http://maeteste.invalid'&&new URL(sender.tab.url).origin==='http://maeteste.invalid';}
 catch(_){return false;}
}
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
 if(!demoSender(sender)){respond({ok:false,motivo:'origem_fora_da_demonstracao'});return false;}
 if(!msg)return;
 if(msg.__opagfoco){fetchConfig().then(()=>respond(Object.assign({disponivel:configOK},config)));return true;}
 if(msg.__opagping){ping();flush();return;}
 if(msg.__opagstatus&&sender.tab&&sender.frameId===0){
  const known=['aguardando_configuracao','servidor_indisponivel','fora_do_foco','casa_encerrada','sem_sessao','pausado_manual','periodo_nao_disponivel','periodo_desconhecido','aguardando_resposta','sem_resposta','atualizado','tentando_novamente','conta_alterada','fila_pendente'];
  const x=msg.__opagstatus;let hostname='';try{hostname=AgentumOrigem.host(new URL(sender.url||sender.tab.url).hostname);}catch(_){}
  if(!known.includes(x.estado)||!hostname)return;
  slots[sender.tab.id]={tab_id:sender.tab.id,frame_id:0,casa:String(x.casa||'').slice(0,160),host:hostname,casa_normalizada:hostname,estado:x.estado,diagnosticado_em:Date.now(),ultima_resposta:x.ultima_resposta||null};
  ping();return;
 }
 if(msg.__opagev!==1||!msg.evt)return;
 const ev=Object.assign({},msg.evt);let hostname='';
 try{hostname=AgentumOrigem.host(new URL(sender.url||sender.tab&&sender.tab.url||'').hostname);}catch(_){}
 ev.host=hostname||AgentumOrigem.host(ev.host);ev.casa_normalizada=ev.host;
 if(!['agente_total','agente_membros','agente_info'].includes(ev.tipo)){respond({ok:false,motivo:'tipo_nao_permitido'});return;}
 init.then(()=>queue.push(ev)).then(id=>{respond({ok:true,event_id:id});flush();}).catch(()=>respond({ok:false,motivo:'persistencia_indisponivel'}));return true;
});
init.then(()=>{flush();ping();fetchConfig();}).catch(()=>{});
