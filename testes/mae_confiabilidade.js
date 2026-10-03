'use strict';
const assert=require('node:assert/strict'), fs=require('fs'),vm=require('vm'),path=require('path');
const core=require('../extensao_agente/core_agente.js'), classifier=require('../extensao_agente/classify_agente.js');
let checks=0;function eq(a,b,label){assert.deepEqual(a,b,label);checks++;}
function event(url,data,meta={}){return classifier.classificar(Object.assign({url:'agent/promote/'+url,host:'www.pintorpg.com',resp:JSON.stringify({code:1,data}),periodo:'mes@2026-09',periodo_observado:true,coleta_id:'run1'},meta),{tokens:[],users:['1111'],contaMae:'1111'});}
(async()=>{
 eq(['52.00','R$ 52,00','BRL 1.234,56','1,234.56',null,false,''].map(core.num),[52,52,1234.56,1234.56,null,null,null],'moeda e ausência');
 eq(['0','1',0,1,false,true,'false','x'].map(core.bool),[false,true,false,true,false,true,false,null],'booleanos explícitos');
 const list=event('report/directReportV5',{list:[{userIdx:'900719925474099310',account:'Teste',deposit:'52.00',validBet:null,isDeposit:'0',online:'0'}],more:false,total:1,pageNo:1,totalPages:1})[0];
 eq(list.membros[0].conta,'900719925474099310','ID longo texto');eq(list.membros[0].isDep,0,'string zero não vira verdadeiro');eq(list.membros[0].aposta,null,'não inventa aposta zero');eq(list.periodo,'mes@2026-09','período capturado');
 eq(event('report/directReportV5',{list:[],more:false,total:0,pageNo:1})[0].membros,[],'vazio válido emitido');
 eq(event('report/directReportV5',{list:[]})[0].mais,null,'mais desconhecido não é fim');
 // A casa devolve a janela que usou (startTime/endTime): e a prova de quanto vale o timeEnum.
 const janela=event('report/directReportV5',{list:[],more:false,total:0,pageNo:1,totalPages:1,startTime:1788836400,endTime:1788922799})[0];
 eq([janela.janela_inicio,janela.janela_fim],[1788836400,1788922799],'janela medida repassada');
 eq('janela_inicio' in event('report/directReportV5',{list:[],startTime:1788922799,endTime:1788836400})[0],false,'janela invertida não é repassada');
 eq('janela_inicio' in event('report/directReportV5',{list:[]})[0],false,'sem janela não inventa janela');
 eq(event('report/myTotalData',{totalDeposit:123,totalWithdraw:4})[0].periodo,'acumulado','separa acumulado');
 eq(event('report/myPeriodDataV2',{timeTotalDeposit:0,timeTotalDepositPerson:0})[0].deposito,0,'zero válido');
 eq(classifier.classificar({url:'agent/promote/report/myPeriodDataV2',resp:JSON.stringify({code:9,data:{timeTotalDeposit:200}})},{tokens:[],users:[]}),[],'erro envelope não total');
 eq(classifier.classificar({url:'agent/promote/report/myPeriodDataV2',resp:'{"data":{"timeTotalDeposit":200}}lixo'},{tokens:[],users:[]}),[],'JSON truncado não aceito');
 let disk=[{tipo:'agente_total',deposito:1}],release;
 const storage={get:()=>new Promise(r=>release=()=>r(structuredClone(disk))),set:async(k,v)=>{disk=structuredClone(v);}};
 const q=new core.DurableQueue(storage,'q');const pushed=q.push({tipo:'agente_total',deposito:2});let sent=[];const flushed=q.flush(async(e)=>{sent.push(e.deposito);return true;});release();await pushed;await flushed;await q.flush(async(e)=>{sent.push(e.deposito);return true;});
 eq(sent,[1,2],'evento novo durante hidratação não perde antigo');eq(disk,[],'fila confirma persistência vazia');
 await q.push({deposito:3});await q.flush(async()=>false);eq(q.items.length,1,'falha mantém fila');
 let sending;const held=q.flush(()=>new Promise(r=>sending=r));await new Promise(r=>setImmediate(r));await q.push({deposito:4});sending(true);await held;eq(q.items.map(x=>x.event.deposito),[4],'remoção por ID não remove evento concorrente');
 const restarted=new core.DurableQueue({get:async()=>structuredClone(disk),set:storage.set},'q');await restarted.ready;eq(restarted.items[0].event.deposito,4,'reinício recupera evento não entregue');
 const independent=new core.DurableQueue({get:async()=>[],set:async()=>{}},'q');await independent.push({deposito:1});await independent.push({deposito:2});await independent.flush(async e=>e.deposito===2);eq(independent.items.map(x=>x.event.deposito),[1],'um relatório rejeitado não bloqueia o seguinte');
 let fail=false,sd=[];const bad=new core.DurableQueue({get:async()=>[],set:async(k,v)=>{if(fail)throw Error('quota');sd=structuredClone(v);}},'q');await bad.ready;fail=true;await assert.rejects(bad.push({deposito:9}));checks++;eq(bad.items,[],'persistência rejeitada não falsifica aceite');
 // Exercita o background verdadeiro: HTTP 200 com status erro não esvazia.
 const handlers={},alarms={opag_refresh:{name:'opag_refresh',scheduledTime:123}},calls=[],store={nexaccDemoAgV1_agFila:[{id:'evt1',event:{tipo:'agente_total',casa:'a',deposito:10}}],nexaccDemoAgV1_agInstallation:'installation'};
 let accept=false;
 const chrome={runtime:{lastError:null,getManifest:()=>({version:'test'}),onMessage:{addListener:f=>handlers.message=f}},storage:{local:{get:(keys,cb)=>setImmediate(()=>cb(Object.fromEntries(keys.map(k=>[k,store[k]])))),set:(o,cb)=>{Object.assign(store,structuredClone(o));setImmediate(cb);}}},alarms:{get:(k,cb)=>cb(alarms[k]),create:(k,v)=>{calls.push(k);alarms[k]=v;},onAlarm:{addListener:f=>handlers.alarm=f}},tabs:{query:(q,cb)=>cb([]),sendMessage(){}}};
 const pings=[];
 const sandbox={chrome,console,AbortController,setTimeout,clearTimeout,fetch:async(url,opt)=>{
  if(url.endsWith('/api/ping'))pings.push(JSON.parse(opt.body));
  return {ok:true,json:async()=>url.endsWith('/api/agente')?{status:accept?'ok':'erro',event_id:'evt1'}:url.endsWith('/api/periodo')?{periodo:'mes'}:url.endsWith('/api/ping')?{ok:true,status:'ok',esperada:'9.99'}:{casas:[]}};
 },AgentumMotherCore:core,importScripts(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extensao_agente/background_agente.js'),'utf8'),sandbox);
 await new Promise(r=>setTimeout(r,40));eq(store.nexaccDemoAgV1_agFila.length,1,'background mantém erro de negócio');eq(calls.includes('opag_refresh'),false,'reinício não posterga alarme existente');
 accept=true;handlers.alarm({name:'opag_delivery'});await new Promise(r=>setTimeout(r,40));eq(store.nexaccDemoAgV1_agFila.length,0,'background remove após ACK válido');
 // A versao empacotada volta no recibo do ping e fica no armazenamento (o worker MV3 morre entre
 // um ping e outro); no ping seguinte a propria extensao se declara atrasada.
 eq(store.nexaccDemoAgV1_agEsperada,'9.99','versão esperada guardada em disco');
 handlers.alarm({name:'opag_delivery'});await new Promise(r=>setTimeout(r,40));
 eq(pings[pings.length-1].estado,'versao_antiga_9.99','extensão velha se declara velha sozinha');
 console.log('Conta Mãe: '+checks+' verificações aprovadas');
})().catch(e=>{console.error(e);process.exitCode=1;});
