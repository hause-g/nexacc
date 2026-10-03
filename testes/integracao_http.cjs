'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {worker,browser,encrypt,settle}=require('./captura_helpers.cjs');
const mother=require('../extensao_agente/classify_agente.js'),core=require('../extensao_agente/core_agente.js');
const py=require('./artefatos_helpers.cjs').python();
(async()=>{
 const proc=spawn(py,['-u',path.join(__dirname,'_servidor_integracao.py')],{stdio:['ignore','pipe','pipe']});let failures='';proc.stderr.on('data',b=>failures+=b);
 try{
 const port=await new Promise((resolve,reject)=>{let buf='';const timeout=setTimeout(()=>reject(Error('servidor teste: '+failures)),15000);proc.stdout.on('data',b=>{buf+=b;const m=buf.match(/^(\d+)\r?\n/);if(m){clearTimeout(timeout);resolve(Number(m[1]));}});proc.on('exit',()=>{clearTimeout(timeout);reject(Error(failures));});});
 assert.notEqual(port,8765);const origin='http://127.0.0.1:'+port;
 const post=async(route,data)=>{const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {ok:r.ok,status:r.status,json:await r.json()};};
 const state=async()=>{const r=await fetch(origin+'/api/estado');assert.ok(r.ok);return r.json();};
 let current=worker({fetch:async(url,body)=>{const r=await post(new URL(url).pathname,body);return{ok:r.ok,status:r.status,json:async()=>r.json};}});await current.ready();current.shared.now=Date.now();
 const b=browser({local:{web__lobby__persisted__user:'{"username":"acct-A"}'},ack:(msg,cb)=>{if(msg.__opev)current.receive(msg.evt).then(cb);else if(cb)cb({ts:0});}});await settle();
 const capture=async(route,data)=>{await b.fetch('https://mock.invalid/'+route+'?token=mock-token',encrypt(JSON.stringify({code:1,data}),'mock-token',b.store.has('web__lobby__persisted__user')?JSON.parse(b.store.get('web__lobby__persisted__user')).userInfos?.username||JSON.parse(b.store.get('web__lobby__persisted__user')).username:'acct-A'));await current.flush();};
 await capture('finance/certify/cashV3',{orderNo:'WIRE-SAQUE-1',money:52,status:4});
 let s=await state();assert.equal(s.resumo.total_saques,0,'aceite nunca liquida');assert.ok(s.pedidos.some(x=>x.numero_pedido==='WIRE-SAQUE-1'&&x.estado==='identificado'));
 await capture('finance/certify/withdrawRecord',{records:[{orderNo:'WIRE-SAQUE-1',money:52,status:1}]});
 assert.equal((await state()).resumo.total_saques,0);
 await capture('finance/certify/withdrawRecord',{records:[{orderNo:'WIRE-SAQUE-1',money:'52.00',status:4}]});
 s=await state();assert.equal(s.resumo.total_saques,52,JSON.stringify(s.resumo));assert.equal((await (await fetch(origin+'/api/pedidos')).json()).pedidos.find(x=>x.numero_pedido==='WIRE-SAQUE-1').estado,'confirmado');assert.equal(current.data.opFila.length,0,'ACK real esvazia fila');
 await capture('finance/certify/withdrawRecord',{records:[{orderNo:'WIRE-SAQUE-1',money:52,status:4}]});assert.equal((await state()).resumo.total_saques,52,'repetição sem dupla contagem');
 await capture('finance/pay/orderInfo',{order_no:'WIRE-DEP-1',amount:'100.00',status:2});
 await capture('finance/pay/orderInfo',{order_no:'WIRE-DEP-2',amount:50,status:2});
 await capture('finance/pay/orderInfo',{order_no:'WIRE-DEP-PEND',amount:999,status:1});
 s=await state();assert.equal(s.resumo.total_depositos,150);assert.equal(s.resumo_efetivo.contas,1);assert.equal(s.resumo_efetivo.qtd_depositos,2);
 await b.storage('acct-B');await capture('finance/pay/orderInfo',{order_no:'WIRE-DEP-3',amount:150,status:2});
 s=await state();assert.equal(s.resumo.total_depositos,300);assert.equal(s.resumo_efetivo.contas,2);assert.equal(s.resumo_efetivo.deposito/s.resumo_efetivo.contas,150);
 const mae=(route,data)=>mother.classificar({url:'agent/promote/'+route,host:'www.pintorpg.com',resp:JSON.stringify({code:1,data}),periodo:core.period('mes'),periodo_observado:true},{tokens:[],users:['111'],contaMae:'111'})[0];
 for(const ev of [mae('report/myTotalData',{totalDeposit:999,totalWithdraw:20,totalValidBet:1500}),mae('index/indexInfoV2',{directMembers:2}),mae('report/myPeriodDataV2',{timeTotalDeposit:300,timeTotalDepositPerson:3,timeTotalWithdraw:52}),mae('report/directReportV5',{list:[{userIdx:'90071992547409931',account:'A',deposit:150,validBet:99,isDeposit:'1',online:'0'}],more:true,total:2,pageNo:1})]){
 const r=await post('/api/agente',{...ev,event_id:core.makeId()});assert.equal(r.ok,true,JSON.stringify(r));
 }
 s=await state();const m=s.agente.find(x=>x.casa==='pintor');assert.equal(m.deposito_total,300,'acumulado não sobrescreve período');assert.equal(m.lista_completa,false);assert.equal(m.membros.length,1,'parcial visível');assert.equal(m.membros[0].conta,'90071992547409931');
 const version=s.versao;const ping=await post('/api/ping',{tipo:'player',version:'1.24',instalacao_id:'wire-test',fila:0,pendentes:1,estado:'passiva',slots:[]});assert.ok(ping.ok);assert.equal((await state()).versao,version,'ping não invalida fechamento');
 for(const resource of ['/operacoes.db','/telegram/config.json','/shared/cryptolib.js','/controle-servidor.ps1'])assert.equal((await fetch(origin+resource)).status,403);
 current.kill();console.log('Integração HTTP: pipeline real, 3 depósitos/2 contas, saque final, ACK, mãe parcial/acumulado, isolamento e estáticos aprovados.');
 }finally{proc.kill();await new Promise(resolve=>{if(proc.exitCode!==null)resolve();else proc.on('exit',resolve);});}
})().catch(e=>{console.error(e);process.exitCode=1;});
