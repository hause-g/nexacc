/* Agentum: apresentação operacional e recuperação. Sem dados de demonstração.
 * Funções financeiras puras também são importadas pelos testes Node. */
(function(root){
  'use strict';
  const clone=x=>JSON.parse(JSON.stringify(x));
  const known=x=>x!==null && x!==undefined && x!=='' && typeof x!=='boolean' && Number.isFinite(Number(x));
  const cents=x=>known(x)&&Number.isSafeInteger(Math.round(Number(x)*100))?Math.round(Number(x)*100):null;
  const count=x=>known(x)&&Number.isSafeInteger(Number(x))&&Number(x)>=0?Number(x):null;
  const money=x=>x===null?null:x/100;
  const identity=(c,a)=>JSON.stringify([String(c||''),String(a||'')]);
  const split=(value,n)=>{
    if(!Number.isSafeInteger(value)||!Number.isSafeInteger(n)||n<1) throw Error('Divisão inválida.');
    const base=Math.trunc(value/n),rest=value-base*n;
    return Array.from({length:n},(_,i)=>base+(i<Math.abs(rest)?Math.sign(rest):0));
  };
  function aggregate(input){
    const groups=new Map(), seen=new Set();
    const rows=Array.isArray(input.contas)?input.contas:null;
    function entry(casa,conta){
      const key=identity(casa,conta);
      if(!groups.has(key)) groups.set(key,{casa,conta,chave:key,qd:0,td:0,qs:0,ts:0});
      return groups.get(key);
    }
    function sum(r,k,v){r[k]=r[k]===null||v===null?null:r[k]+v;}
    if(rows) rows.forEach(o=>{
      const r=entry(o.casa,o.conta);
      ['qd','qs'].forEach(k=>sum(r,k,count(o[k])));
      ['td','ts'].forEach(k=>sum(r,k,cents(o[k])));
    });
    else (input.operacoes||[]).forEach(o=>{
      if(!['saque','deposito'].includes(o.tipo)||o.estado&&o.estado!=='confirmado') return;
      const key=identity(o.casa,o.conta)+JSON.stringify([o.tipo,o.numero_pedido]);
      if(o.numero_pedido&&seen.has(key)) return;
      if(o.numero_pedido) seen.add(key);
      const r=entry(o.casa,o.conta),s=o.tipo==='saque';
      r[s?'qs':'qd']++;sum(r,s?'ts':'td',cents(o.valor));
    });
    return [...groups.values()].map(r=>({...r,td:money(r.td),ts:money(r.ts),resultado:r.td===null||r.ts===null?null:money(r.ts-r.td)}));
  }
  function calculate(input={}){
    const accounts=aggregate(input), casas=new Map();
    for(const a of accounts){
      if(!casas.has(a.casa)) casas.set(a.casa,{casa:a.casa,td:0,ts:0,qd:0,qs:0,contas:0});
      const c=casas.get(a.casa);
      for(const k of ['td','ts']) c[k]=c[k]===null||a[k]===null?null:c[k]+cents(a[k]);
      for(const k of ['qd','qs']) c[k]=c[k]===null||a[k]===null?null:c[k]+a[k];
      if(a.qd===null||a.qd>0&&(!a.conta||a.conta==='?'||!a.casa||a.casa==='?')) c.contas=null;
      else if(a.qd>0&&c.contas!==null) c.contas++;
    }
    let oficial=false;
    const adjustments=new Map((input.ajustes||[]).map(a=>[a.casa,a]));
    adjustments.forEach((a,casa)=>{
      const dep=cents(a.deposito);if(dep===null)return;
      const c=casas.get(casa)||{casa,td:0,ts:0,qd:0,qs:0,contas:0};
      const same=c.td===dep;
      c.td=dep;c.oficial=true;oficial=true;
      // O contador legado pode representar depósitos. Só usar como pessoas com unidade comprovada.
      if(['contas','pessoas'].includes(a.unidade_contador)||a.contas_verificadas===true) c.contas=count(a.contas);
      else if(!same) c.contas=null;
      casas.set(casa,c);
    });
    // O servidor resolve ajustes de escopo e vínculo. A mesma base alimenta todas as vistas.
    if(input.efetivo){
      const ef=input.efetivo;casas.clear();
      (ef.por_casa||[]).forEach(c=>casas.set(c.casa,{casa:c.casa,td:cents(c.deposito),ts:cents(c.saque),qd:count(c.depositos),qs:count(c.saques),contas:count(c.contas),oficial:!!c.oficial}));
      oficial=(ef.por_casa||[]).some(c=>c.oficial);
    }
    let manual=0;const manualSemVinculo=[];
    for(const [casa,value] of Object.entries(input.manuais||{})){
      const v=cents(value),rows=[...casas.values()].filter(c=>c.casa===casa||input.mapeamento?.[c.casa]===casa);
      if(v!==null&&rows.length&&rows.every(c=>c.ts!==null)){manual+=v-rows.reduce((s,c)=>s+c.ts,0);}
      else if(v!==null)manualSemVinculo.push(casa);
    }
    const all=[...casas.values()];
    const sum=k=>all.some(c=>c[k]===null)?null:all.reduce((s,c)=>s+c[k],0);
    let td=sum('td'),ts=sum('ts'),qd=sum('qd'),qs=sum('qs'),n=sum('contas');
    if(ts!==null)ts+=manual;
    if(input.efetivo){const ef=input.efetivo;td=cents(ef.deposito);ts=cents(ef.saque);if(ts!==null)ts+=manual;qd=count(ef.qtd_depositos);qs=count(ef.qtd_saques);n=count(ef.contas);}
    if(input.disponivel===false){td=ts=qd=qs=n=null;}
    const extra=v=>v===null||v===undefined||v===''?0:cents(v);
    const ger=extra(input.gerente),bau=extra(input.bau),bonus=ger===null||bau===null?null:(ger+bau)*10;
    const saldo=td===null||ts===null?null:ts-td;
    return {td:money(td),ts:money(ts),qd,qs,contas:n,bonus:money(bonus),saldo:money(saldo),
      resultado:saldo===null||bonus===null?null:money(saldo+bonus),saqMan:money(manual),manualSemVinculo,oficial,
      media:td===null||n===null||n===0?null:td/100/n,
      redepositos:qd===null||n===null||qd<n?null:qd-n,
      accounts,por_casa:all.map(c=>({...c,td:money(c.td),ts:money(c.ts),resultado:c.td===null||c.ts===null?null:money(c.ts-c.td)}))};
  }
  function coverage(ca){
    const received=count(ca.membros_recebidos)??(Array.isArray(ca.membros)?ca.membros.length:0);
    const total=count(ca.total_registros??ca.registros_total??ca.contas);
    return ca.lista_completa===true?'Lista completa · '+received+' registros recebidos':
      'Lista parcial · '+received+(total!==null&&total>=received?' de '+total:'')+' registros recebidos';
  }
  // Recorta o resumo efetivo para um subconjunto de casas (a operação ao vivo ATIVA) e recompõe os
  // totais do ciclo a partir do subconjunto. calculate usa ef.deposito/saque/qtd/contas diretamente,
  // então os totais precisam vir já somados. Semântica de nulo igual à do sum() do calculate: se
  // ALGUMA casa do escopo tem o campo nulo, o total daquele campo é nulo. escopo é um Set de chaves
  // em minúsculas; null/ausente devolve o efetivo intacto (0/1 operação = global, idêntico a hoje).
  function scopeEfetivo(efetivo,escopo){
    if(!escopo||!efetivo||!Array.isArray(efetivo.por_casa)) return efetivo;
    const pc=efetivo.por_casa.filter(c=>escopo.has(String(c.casa||'').toLowerCase()));
    const soma=k=>pc.reduce((s,c)=>{if(s===null)return null;const v=c[k];if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?s+n:null;},0);
    return {...efetivo,por_casa:pc,deposito:soma('deposito'),saque:soma('saque'),qtd_depositos:soma('depositos'),qtd_saques:soma('saques'),contas:soma('contas'),oficial:pc.some(c=>c.oficial)};
  }
  // Fechamento POR OPERAÇÃO. Como o servidor fecha o ciclo inteiro de uma vez, as operações
  // intermediárias fecham no cliente (congelam suas metas com o resultado escopado delas) e SÓ a
  // última gira o ciclo. A última recebe o RESÍDUO = total congelado do servidor − o que já foi
  // atribuído às operações fechadas antes (both em centavos). Garante que a soma das operações bate
  // com o total autoritativo do servidor (nada é criado nem perdido) mesmo com capturas tardias.
  function residualClose(serverResultCents, serverContas, alreadyResultCents, alreadyContas, n){
    if(!Number.isSafeInteger(n)||n<1) throw Error('Divisão por operação inválida.');
    const resultado = serverResultCents - (alreadyResultCents||0);
    if(!Number.isSafeInteger(resultado)) throw Error('Resíduo de fechamento inválido.');
    const values = split(resultado, n);
    const resto = (serverContas===null||serverContas===undefined||alreadyContas===null||alreadyContas===undefined) ? null : (serverContas - (alreadyContas||0));
    const contas = (resto===null||!Number.isSafeInteger(resto)||resto<0) ? null : split(resto, n);
    return {values, contas, resultado};
  }
  const API={calculate,aggregate,split,cents,count,coverage,scopeEfetivo,residualClose};
  if(typeof module!=='undefined'&&module.exports) module.exports=API;
  root.Agentum=API;
  if(typeof document==='undefined')return;

  const $=id=>document.getElementById(id), h=x=>esc(x), fmt=x=>fmtBRL(x);
  const KEY='dashboardOperacoes_v1', CLOSE='agentum_fechamento_journal', RESTORE='agentum_restore_journal';
  const EXTRAS=['aovivo_extra','saqueManual','menuCompacto','ultimoAlerta','orion.onix.motion.v1'];
  let base=null,conflict=false,saving=Promise.resolve(),busy=false,drawerReturn=null;
  let lastState=null, recovered=false;
  function read(key){const s=localStorage.getItem(key);return s?JSON.parse(s):null;}
  function journal(key,value){localStorage.setItem(key,JSON.stringify(value));}
  function currentExtras(){return Object.fromEntries(EXTRAS.map(k=>[k,localStorage.getItem(k)]));}
  function error(e){toast(e.message||'Não foi possível concluir.');renderDiagnostics();}
  async function request(path,body){
    const response=await fetch(SRV+path,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(15000)});
    let j;try{j=await response.json();if(!j||typeof j!=='object'||Array.isArray(j))throw Error();}catch(_){const error=Error('Resposta inválida do servidor. A recuperação foi preservada.');error.httpStatus=response.status;error.codigo=null;error.semCommit=false;throw error;}
    if(!response.ok||j.status==='erro'||j.status==='error'||j.ok===false){
      const error=Error(j.motivo||j.erro||'O servidor não confirmou a ação.');
      error.httpStatus=response.status;error.codigo=j.codigo||null;
      // Somente recusa estruturada do receptor é prova de que ESTA transação não foi aplicada.
      error.semCommit=['erro','error'].includes(j.status)&&([400,401,403,404,405,409,410,413,415,422].includes(response.status)||response.ok&&['invalido','conflito'].includes(j.codigo));
      throw error;
    }
    return j;
  }
  async function exclusive(fn){
    if(!navigator.locks) throw Error('Este navegador não oferece bloqueio entre janelas. Abra no Chrome ou Edge atualizado.');
    return navigator.locks.request('agentum-dados',{mode:'exclusive'},fn);
  }
  function ensureBase(){
    if(conflict||localStorage.getItem(KEY)!==base){conflict=true;renderRecovery();throw Error('Há alterações em outra janela. Recarregue os dados antes de continuar.');}
  }
  const MONTH='agentum_mes_journal';
  const terminal=j=>j&&['done','rejected'].includes(j.phase);
  function pending(){return [CLOSE,RESTORE,MONTH].some(k=>{const j=read(k);return j&&!terminal(j);});}
  function rejectJournal(key,j,error){
    j.phase='rejected';j.rejection={httpStatus:error.httpStatus,codigo:error.codigo,motivo:error.message,at:new Date().toISOString()};journal(key,j);
    Estado.versao=null;pollEstado();renderRecovery();
  }
  function commitState(next){
    const raw=JSON.stringify(next);localStorage.setItem(KEY,raw);base=raw;estado=next;
    // Também espelha no servidor: "Fechar operação" gravava só no navegador e a cópia do servidor
    // ficava sem o fechamento até a próxima edição comum (24/09).
    flashSalvo();agendarEscrita();if(typeof agendarServidor==='function')agendarServidor();
  }
  function save(){
    const next=clone(estado);
    saving=saving.catch(()=>{}).then(()=>exclusive(async()=>{
      ensureBase();if(pending())throw Error('Conclua a recuperação antes de editar os dados.');commitState(next);
    })).catch(e=>{conflict=true;sessionStorage.setItem('agentum_rascunho_conflito',JSON.stringify(next));error(e);renderRecovery();});
    return saving;
  }
  function captureInput(){
    const S=Estado.resumo,manuais={},accounts=S&&Array.isArray(S.contas)?S.contas:undefined;
    let efetivo=lastState?.resumo_efetivo||S?.efetivo;
    // Operações ao vivo em PARALELO: com 2+ operações abertas, o card contabiliza SÓ as casas da
    // operação ATIVA. window.aovivoEscopo devolve esse conjunto de chaves (ou null quando há 0/1
    // operação — aí nada muda, o Ao Vivo é global e idêntico ao de hoje, e os testes seguem válidos).
    const escopo=(typeof window!=='undefined'&&window.aovivoEscopo)?window.aovivoEscopo():null;
    efetivo=scopeEfetivo(efetivo,escopo);
    const noEscopo=c=>!escopo||escopo.has(String(c||'').toLowerCase());
    // com escopo ativo não puxa casas da mãe fora da operação (senão o saque manual delas somaria)
    const houses=new Set([...(efetivo?.por_casa||accounts||AoVivo.ops||[]).map(o=>o.casa),...(escopo?[]:(Estado.agente||[]).map(o=>o.casa))]);
    houses.forEach(c=>{if(!noEscopo(c))return;const v=getSaqueManual(c);if(v!==null)manuais[c]=v;});
    // Gerente/BAU por operação quando há 2+ (cada operação tem o seu bônus); global caso contrário.
    const opB=(typeof window!=='undefined'&&window.aovivoOpAtiva)?window.aovivoOpAtiva():null;
    const gerente=opB?(opB.gerente??null):AoVivo.gerente, bau=opB?(opB.bau??null):AoVivo.bau;
    // Associação de identidades serve à conferência; ajustes financeiros mantêm o escopo original.
    return {contas:accounts,operacoes:AoVivo.ops||[],ajustes:Estado.ajustes||[],efetivo,mapeamento:{},gerente,bau,manuais,disponivel:!!lastState};
  }
  const finance=()=>calculate(captureInput());
  // A mãe deve ler o período que o ciclo pede (hoje: "mes"). Em 23/09 a rolamento só tinha leituras "hoje"
  // e "desconhecido" (nenhuma de mês) — com período diferente os totais não batem com o Ao Vivo e o
  // "Usar depósito oficial" fica incompatível. Mostra a divergência no card em vez de deixar silenciosa.
  const NOME_PERIODO={hoje:'Hoje',ontem:'Ontem',semana:'Esta semana',ultima:'Última semana',mes:'Este mês',desconhecido:'período não identificado'};
  function periodoDivergente(ca){
    const esperado=lastState&&typeof lastState.periodo_ciclo==='string'?lastState.periodo_ciclo:null;
    const lido=typeof ca.periodo==='string'?ca.periodo.split('@')[0]:null;
    if(!esperado||!lido||lido===esperado||lido==='acumulado')return '';
    return `<span class="ag-status ag-alert" title="A mãe está lendo um período diferente do que o ciclo pede — os totais não se comparam com o Ao Vivo. Se persistir, a troca de aba de período não está pegando nesta casa.">lendo: ${h(NOME_PERIODO[lido]||lido)} · o ciclo pede: ${h(NOME_PERIODO[esperado]||esperado)}</span>`;
  }
  // Automação D — mãe × filhas (servidor: db._divergencia_mae). O rótulo "hoje" da mãe não garante a
  // janela (rolamento 23/09 devolvia o mês), então o servidor testa dia/mês em UTC e Brasília e confere
  // conta a conta. O aviso só sobe com PROVA (conta com valor diferente/sem captura, ou total que
  // diverge numa janela já confirmada); total de outro período fica no card, sem alarme.
  const divDe=casa=>(Array.isArray(lastState?.divergencia_mae)?lastState.divergencia_mae:[]).find(d=>d.casa===casa)||null;
  const DIV_RECENTE_MS=30*60000;
  function divProblemas(d){
    if(!d)return [];
    const k=d.contas||{},out=[];
    if(k.qtd_diferentes)out.push(k.qtd_diferentes+(k.qtd_diferentes===1?' conta com valor diferente':' contas com valor diferente'));
    if(k.qtd_sem_captura)out.push(k.qtd_sem_captura+(k.qtd_sem_captura===1?' conta que nenhuma filha capturou':' contas que nenhuma filha capturou'));
    ['deposito','saque'].forEach(t=>{const e=divExplicacao(d,t);if(e)out.push('diferença de '+fmt(Math.abs(d.diferenca[t]))+' = '+e);});
    if(d.janela)['deposito','saque'].forEach(t=>{const s=d.situacao?.[t];if((s==='mae_maior'||s==='filha_maior')&&!divExplicacao(d,t))out.push((t==='deposito'?'depósito':'saque')+' '+(s==='mae_maior'?'da mãe maior em ':'das filhas maior em ')+fmt(Math.abs(d.diferenca[t])));});
    return out;
  }
  const TIPO_TXT={deposito:'depósito',saque:'saque'};
  function divExplicacao(d,t){
    const ps=d&&d.explicado_por&&d.explicado_por[t];if(!ps||!ps.length)return '';
    const quando=x=>{const q=new Date(x);return Number.isNaN(+q)?'':' desde '+q.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});};
    const um=ps.length===1?ps[0]:null;
    return um?`${TIPO_TXT[t]} de ${fmt(um.valor)} da conta ${um.conta} parado em "${um.estado}"${quando(um.quando)}`
      :`${ps.length} pedidos de ${TIPO_TXT[t]} parados (${fmt(ps.reduce((a,x)=>a+x.valor,0))})`;
  }
  // Resolvida = nada a fazer: tudo bate, OU o depósito oficial aplicado é o total atual da mãe (o
  // oficial já cobre a diferença) e o saque não diverge. Aí o bloco e o aviso somem (24/09: poluíam
  // o card depois de ajustar). Se a mãe mudar o total ou o saque divergir, voltam sozinhos.
  function divResolvida(d){
    if(!d)return false;
    const okS=s=>s==null||s==='igual'||s==='aguardando_mae';
    if(!okS(d.situacao?.saque))return false;
    const chaves=[d.casa,...(d.filhas||[])].map(x=>String(x).toLowerCase());
    const aj=(Estado.ajustes||[]).find(a=>chaves.includes(String(a.casa||'').toLowerCase())&&cents(a.deposito)!==null);
    if(aj&&cents(aj.deposito)===cents(d.mae.deposito))return true;
    const k=d.contas||{};
    return okS(d.situacao?.deposito)&&!k.qtd_diferentes&&!k.qtd_sem_captura;
  }
  const divRecente=d=>!!d&&Number.isFinite(Date.parse(d.lida_em))&&Date.now()-Date.parse(d.lida_em)<DIV_RECENTE_MS;
  function divergenciaCard(ca){
    // Sem nenhuma filha capturando (ex.: a8-hummerpg) não há o que comparar: a linha "Filha:" já diz.
    const d=divDe(ca.casa);if(!d||divResolvida(d)||!(d.filhas||[]).length||(d.conta_mae&&ca.conta_mae&&String(d.conta_mae)!==String(ca.conta_mae)))return '';
    const hora=x=>{const t=new Date(x);return Number.isNaN(+t)?'—':t.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});};
    const linha=(t,rot)=>{
      const m=d.mae[t],c=d.capturado[t],q=d.capturado[t==='deposito'?'qtd_depositos':'qtd_saques'],s=d.situacao[t];
      if(m==null)return '';
      const sinal=s==='igual'?'<span class="ag-status" title="Bate no centavo">✓</span>':s==='aguardando_mae'?'<span class="ag-status" title="Capturado nos últimos 15 min antes da leitura; a mãe ainda não mostrou">aguardando a mãe</span>':`<span class="ag-status ${d.janela?'ag-alert':''}">${s==='mae_maior'?'mãe +':'filhas +'}${h(fmt(Math.abs(d.diferenca[t])))}</span>`;
      return `<div>${rot}: mãe <b>${h(fmt(m))}</b> · filhas <b>${h(fmt(c))}</b> (${q}) ${sinal}</div>`;
    };
    const outras=(d.outras_janelas||[]).map(o=>o.janela+': dep. '+fmt(o.deposito)+' · saque '+fmt(o.saque)).join('\n');
    const k=d.contas;
    let contasTxt='';
    if(k){
      const nomes=a=>a.slice(0,5).map(x=>h(x.nome||x.conta)+' (mãe '+h(fmt(x.mae))+(x.capturado!=null?' × capturado '+h(fmt(x.capturado)):'')+')').join(', ')+(a.length>5?' …':'');
      contasTxt=`<div>Contas (${h(k.janela||'')}): <b>${k.iguais}</b> batem uma a uma${k.qtd_diferentes?` · <span class="ag-status ag-alert">${k.qtd_diferentes} diferente(s)</span> ${nomes(k.diferentes)}`:''}${k.qtd_sem_captura?` · <span class="ag-status ag-alert">${k.qtd_sem_captura} sem captura</span> ${nomes(k.sem_captura)}`:''}${k.lista_completa?'':' · lista da mãe parcial'}</div>`;
    }
    const totalFora=!d.janela&&['deposito','saque'].some(t=>['mae_maior','filha_maior'].includes(d.situacao[t]));
    const contasOk=k&&k.iguais>0&&!k.qtd_diferentes&&!k.qtd_sem_captura;
    const DICA={deposito:{mae_maior:'a mãe viu depósito que nenhuma filha capturou: conta sem aba aberta ou pedido não lido',filha_maior:'depósito capturado que a mãe não conta: confira se não foi estornado'},
      saque:{mae_maior:'saque que nenhuma filha capturou: confira o extrato das contas',filha_maior:'saque capturado que a mãe ainda não conta: pode estar pendente ou ter sido recusado na casa'}};
    const dicas=d.janela?['deposito','saque'].map(t=>DICA[t][d.situacao[t]]).filter(Boolean):[];
    const ok=s=>s==null||s==='igual'||s==='aguardando_mae';
    const expl=['deposito','saque'].map(t=>divExplicacao(d,t)).filter(Boolean);
    const semFilha=!(d.filhas||[]).length;
    const porque=expl.length?'A diferença é o '+h(expl.join(' e o '))+': a casa já conta, a filha não viu a confirmação. Confira na aba da conta.'
      :semFilha?'Nenhuma filha capturou nesta casa na janela da leitura — sem captura, não há o que conferir.'
      :d.janela?(ok(d.situacao.saque)?`Janela que bateu: <b>${h(d.janela)}</b>.`:`O depósito bate na janela <b>${h(d.janela)}</b>; o saque não.`)+(dicas.length?' '+h((s=>s.charAt(0).toUpperCase()+s.slice(1))(dicas.join('; ')))+'.':'')
      :totalFora&&contasOk?'O total da mãe não bate em nenhuma janela (dia/mês, UTC/Brasília), mas as contas batem uma a uma: o total é de outro período, não falta captura.'
      :'Nenhuma janela (dia/mês, UTC/Brasília) bate com o total da mãe — compare pela lista de contas antes de usar o total.';
    return `<div class="ag-note ag-div" title="${h('Leitura da mãe às '+hora(d.lida_em)+' · filhas contadas até a mesma hora.'+(outras?'\nOutras janelas testadas:\n'+outras:''))}"><b>Mãe × filhas</b> <small>leitura das ${h(hora(d.lida_em))}</small>${linha('deposito','Depósito')}${linha('saque','Saque')}${contasTxt}<small>${porque}</small></div>`;
  }
  // Qual filha é desta mãe — SÓ leitura, sem associar (associar junta chaves e metas; o operador
  // não quer, 24/09). Servidor: db._filhas_da_mae (associada > mesmo domínio > mesmo nome).
  function filhaDaMae(ca){
    const mapa=lastState&&lastState.filhas_da_mae;if(!mapa||!(ca.casa in mapa))return '';
    const fs=mapa[ca.casa]||[];
    if(!fs.length)return '<p class="ag-caption ag-filha">Filha: nenhuma captura de filha ligada a esta mãe ainda.</p>';
    return `<p class="ag-caption ag-filha">Filha${fs.length>1?'s':''}: ${fs.map(f=>`<b>${h(f.filha)}</b> <small>(${h(f.motivo)})</small>`).join(' · ')}</p>`;
  }
  const divAvisados=new Set();
  function avisoDivergencia(){
    const casos=(Array.isArray(lastState?.divergencia_mae)?lastState.divergencia_mae:[])
      // Casa sem NENHUMA filha capturando (ex.: hummer 24/09) não vira alarme: não há o que conferir.
      .filter(d=>divRecente(d)&&!divResolvida(d)&&(d.filhas||[]).length&&!(Estado.encerradas||[]).includes(d.casa)).map(d=>({d,p:divProblemas(d)})).filter(x=>x.p.length);
    casos.forEach(({d,p})=>{const chave=d.casa+'|'+p.join('|');if(!divAvisados.has(chave)){divAvisados.add(chave);if(typeof toast==='function')toast('Mãe × filhas — '+casaLabel(d.casa)+': '+p.join(' · '));}});
    if(!casos.length)return '';
    return `<div class="ag-aviso ag-alert"><b>Mãe × filhas não batem:</b> ${casos.map(({d,p})=>`${h(casaLabel(d.casa))} — ${h(p.join(' · '))}`).join('; ')}. <button class="btn mini" data-aba-ir="contamae">Ver na Conta Mãe</button></div>`;
  }
  function periodText(p){
    if(!p)return 'Período não informado';
    if(typeof p==='object')return p.rotulo||p.label||(p.inicio&&p.fim?p.inicio+' — '+p.fim:'Período não informado');
    if(p==='desconhecido')return 'Período não informado';
    if(String(p).includes('@')){const [kind,date]=String(p).split('@');return (kind==='hoje'?'Dia ':kind==='mes'?'Mês ':kind+' · ')+date;}
    return ({hoje:'Hoje',ontem:'Ontem',semana:'Esta semana',ultima:'Última semana',mes:'Este mês'})[p]||String(p);
  }
  function compatible(ca){
    if(lastState?.identidades?.ambiguas?.includes(ca.casa))return false;
    if(ca.comparavel===false)return false;
    const p=lastState&&lastState.periodo_ciclo;
    const cycleRange=lastState?.intervalo_ciclo||(typeof p==='object'?p:null),sourceRange=ca.intervalo||(typeof ca.periodo==='object'?ca.periodo:null);
    const sameRange=cycleRange&&sourceRange&&cycleRange.inicio&&cycleRange.fim&&cycleRange.inicio===sourceRange.inicio&&cycleRange.fim===sourceRange.fim;
    const explicit=ca.comparavel===true&&ca.ciclo_id===Estado.ciclo_id&&!!p&&p!=='desconhecido'&&JSON.stringify(ca.periodo)===JSON.stringify(p);
    return !!(sameRange||explicit)&&ca.lista_completa===true;
  }
  function statusText(p){return ({identificado:'Pedido identificado',processando:'Aguardando a casa',confirmado:'Confirmação observada',falhou:'Falha informada pela casa',verificar:'Precisa verificar',conflito:'Precisa verificar'})[p.estado]||'Estado a confirmar';}
  function observed(p){const d=new Date(p.observado_em||p.atualizado_em);return Number.isNaN(+d)?'Horário não informado':d.toLocaleString('pt-BR');}
  function safeReason(p){
    const m=String(p.motivo||'');
    // Não levar respostas brutas, URLs ou credenciais do transporte à apresentação.
    if(!m||/[{}<>]|https?:|token|senha|authorization|cookie/i.test(m))return p.estado==='processando'?'O pedido ainda aguarda conclusão.':'Aguarde nova evidência ou confira o histórico na aba já aberta.';
    return m.slice(0,240);
  }
  function knownOrders(){return Array.isArray(Estado.pedidos)?Estado.pedidos:[];}
  function healthText(){
    const inst=Estado.instalacoes;
    if(!Array.isArray(inst)||!inst.length)return 'Filas externas: cobertura não confirmada';
    const unknown=inst.some(i=>count(i.fila)===null);
    const n=inst.reduce((s,i)=>s+(count(i.fila)||0),0);
    return unknown?'Filas externas: quantidade a confirmar':n+(n===1?' evento conhecido aguardando envio':' eventos conhecidos aguardando envio')+' · cobertura parcial';
  }
  function captureHealth(){
    const now=Date.now(),active=(Estado.instalacoes||[]).filter(i=>i.tipo==='player'&&Number.isFinite(Date.parse(i.ultimo_ping))&&now-Date.parse(i.ultimo_ping)<180000);
    if(!active.length)return 'Filhas: sem sinal recente da extensão';
    const linked=new Set();
    active.forEach(i=>(Array.isArray(i.slots)?i.slots:[]).forEach(s=>{if(s.conta)linked.add(i.instalacao_id+':'+s.tab_id);}));
    return linked.size?'Filhas: '+linked.size+(linked.size===1?' aba identificada':' abas identificadas'):'Filhas: aguardando comunicação das abas';
  }
  function renderAvisos(){
    // Sinais que o servidor ja produz e que ficavam invisiveis: captura barrada pelo foco
    // (captura_bloqueada nunca era lido) e extensao desatualizada (o unico texto com acao
    // morava dentro de #agIdentityPanel, oculto pelo visual; sobrava uma pilula sem explicacao).
    const host=$('agHealth');if(!host)return;
    let el=$('agAvisos');
    if(!el){el=document.createElement('div');el.id='agAvisos';el.className='ag-note ag-avisos';host.before(el);}
    const linhas=[];
    // Vigia ativa: conta travada numa casa que voce esta operando AGORA = risco de depositar em conta
    // morta. A Vigia ja detecta; aqui o aviso sobe para o topo do Ao Vivo, onde voce esta trabalhando.
    try{
      const jogos=window.AgentumJogos,vigia=window.AgentumVigia;
      if(jogos&&vigia&&typeof jogos.casasComAbaViva==='function'&&typeof vigia.estadoDe==='function'){
        const operadas=new Set(jogos.casasComAbaViva(lastState||{}).flatMap(c=>(c.chaves||[]).map(k=>String(k).toLowerCase())));
        if(operadas.size){
          const contas=Array.isArray(lastState?.contas)?lastState.contas:[],erros=lastState?.contas_erro||{},travadas=[];
          contas.forEach(c=>{
            const casa=String(c.casa||'').toLowerCase();
            if(!operadas.has(casa))return;
            const falha=erros[(c.casa||'')+'|'+c.conta];
            if(c.status==null&&!falha)return;                 // sem leitura NUNCA acusa
            const prob=falha?{rotulo:'Login recusado'}:vigia.estadoDe(c.status);
            if(prob)travadas.push({casa:c.casa,conta:c.conta,rotulo:prob.rotulo});
          });
          if(travadas.length){
            const amostra=travadas.slice(0,5).map(t=>`${h(casaLabel(t.casa))} · ${h(t.conta)} (${h(t.rotulo)})`).join('; ');
            linhas.push(`<div class="ag-aviso ag-alert"><b>${travadas.length} conta(s) travada(s) em casa que você está operando:</b> ${amostra}${travadas.length>5?' …':''}. Não deposite nessas. <button class="btn mini" data-aba-ir="vigia">Ver na Vigia</button></div>`);
          }
        }
      }
    }catch(_){}
    try{const div=avisoDivergencia();if(div)linhas.push(div);}catch(_){}
    const b=lastState?.captura_bloqueada;
    if(b?.bloqueado){
      const casas=(b.casas_barradas||[]).map(c=>casaLabel(c)).join(', ')||'todas as abas abertas';
      linhas.push(`<div class="ag-aviso ag-alert"><b>Captura parada pelo foco.</b> O foco (${h((b.foco||[]).join(', ')||'—')}) não bate com as casas abertas (${h(casas)}); nada está sendo lido. <button class="btn mini" data-ag-foco-todas="1">Capturar todas as casas</button></div>`);
    }
    const now=Date.now(),exp=Estado.ext_esperada||{};
    const velhas=(Estado.instalacoes||[]).filter(i=>Number.isFinite(Date.parse(i.ultimo_ping))&&now-Date.parse(i.ultimo_ping)<180000&&exp[i.tipo]&&i.versao!==exp[i.tipo]);
    if(velhas.length){
      const porTipo={};velhas.forEach(i=>{(porTipo[i.tipo]=porTipo[i.tipo]||new Set()).add(i.versao);});
      const txt=Object.entries(porTipo).map(([t,vs])=>(t==='mae'?'Conta Mãe ':'filha ')+h([...vs].join('/'))+' → pacote '+h(exp[t])).join(' · ');
      const casasV=new Set();velhas.forEach(i=>(i.slots||[]).forEach(s=>{if(s&&s.casa)casasV.add(casaLabel(s.casa));}));
      const onde=casasV.size?` Casas: ${h([...casasV].sort().join(', '))}.`:'';
      linhas.push(`<div class="ag-aviso"><b>${velhas.length} navegador(es) em versão antiga:</b> ${txt}.${onde} Recarregue a extensão em chrome://extensions e dê F5 nas abas daquele navegador — as correções novas não estão valendo lá.</div>`);
    }
    // Evento recusado em definitivo sai da fila para nao travar os seguintes; sem esta faixa a
    // recusa era silenciosa e o dinheiro simplesmente nao chegava ao livro.
    const recusas=(Estado.instalacoes||[]).map(i=>({i,m:/^eventos_rejeitados_(\d+)$/.exec(i.estado||'')}))
      .filter(x=>x.m&&Number.isFinite(Date.parse(x.i.ultimo_ping))&&now-Date.parse(x.i.ultimo_ping)<180000);
    if(recusas.length){
      const total=recusas.reduce((s,x)=>s+Number(x.m[1]),0);
      const quais=[...new Set(recusas.map(x=>x.i.tipo==='mae'?'Conta Mãe':'filha'))].join(' e ');
      linhas.push(`<div class="ag-aviso ag-alert"><b>${total} evento(s) recusados pelo servidor (${h(quais)}).</b> Saíram da fila depois de 3 tentativas: o servidor recusou em definitivo (dado inválido ou conflito), então esses lançamentos não entraram no livro. Confira o registro de erros do servidor antes de fechar o ciclo.</div>`);
    }
    // Desfecho do botao de jogo. Sem esta faixa, clicar e nao acontecer nada na aba nao deixava
    // rastro nenhum — e o operador ficava sem saber se o problema era dele ou do painel.
    const dosJogos=(Estado.instalacoes||[]).map(i=>({i,m:/^jogo_(.+)$/.exec(i.estado||'')}))
      .filter(x=>x.m&&Number.isFinite(Date.parse(x.i.ultimo_ping))&&now-Date.parse(x.i.ultimo_ping)<180000);
    const ruim=dosJogos.find(x=>!/^aberto_/.test(x.m[1]));
    if(ruim){
      const porque=ruim.m[1]==='sem_url_da_sessao'
        ? 'Nenhum jogo foi aberto nessa casa desde o último login, então a extensão ainda não tem a sessão para abrir direto. Abra um jogo pelo lobby uma vez.'
        : 'A extensão não encontrou o jogo na tela daquela aba. Abra-o uma vez pelo lobby para ela reaprender onde ele fica.';
      linhas.push(`<div class="ag-aviso"><b>O botão de jogo não abriu.</b> ${h(porque)}</div>`);
    }
    const tardias=Array.isArray(lastState?.operacoes_tardias)?lastState.operacoes_tardias:[];
    if(tardias.length){
      const soma=tardias.reduce((s,o)=>s+(cents(o.valor)||0),0)/100,ciclos=[...new Set(tardias.map(o=>o.ciclo_id))].sort((a,b)=>a-b);
      const lista=tardias.slice(0,6).map(o=>`${h(casaLabel(o.casa))} · ${h(o.conta||'conta a confirmar')} · ${h(o.tipo==='deposito'?'depósito':'saque')} ${h(fmt(Number(o.valor)))} (ciclo ${h(o.ciclo_id)})`).join('; ');
      linhas.push(`<div class="ag-aviso"><b>${tardias.length} operação(ões) chegaram depois do fechamento do ciclo ${h(ciclos.join(', '))}:</b> ${h(fmt(soma))}. Estão no livro do ciclo em que aconteceram, não neste. ${h(lista)}${tardias.length>6?' …':''}</div>`);
    }
    el.hidden=!linhas.length;el.innerHTML=linhas.join('');
    if(!el._wired){el._wired=true;el.addEventListener('click',e=>{
      const ir=e.target.closest('[data-aba-ir]');
      if(ir){if(typeof window.abrirAba==='function')window.abrirAba(ir.dataset.abaIr);return;}
      const bt=e.target.closest('[data-ag-foco-todas]');if(!bt)return;bt.disabled=true;
      mutation('/api/foco',{casas:[]}).then(()=>{toast('Foco limpo: todas as casas ativas voltam a ser capturadas.');refresh();}).catch(err=>{bt.disabled=false;error(err);});
    });}
  }
  function renderTracking(){
    renderAvisos();
    const orders=knownOrders(),panel=$('agTracking'),list=$('agOrderList');if(!panel)return;
    panel.hidden=!orders.length;
    $('agTrackSummary').textContent=orders.length+' pedido'+(orders.length===1?'':'s')+' em acompanhamento';
    $('agTrackingHint').textContent=healthText();
    list.innerHTML=orders.map((p,i)=>`<div class="ag-order-row"><div><b>${h(p.conta?'Conta '+p.conta:'Conta a confirmar')}</b><small>${h(casaLabel(p.casa))} · ${h(p.tipo==='deposito'?'Depósito':'Saque')} · ciclo ${h(p.ciclo_id??'a confirmar')}</small></div><strong>${cents(p.valor)===null?'Valor a confirmar':h(fmt(Number(p.valor)))}</strong><span class="ag-status ${p.estado==='verificar'||p.estado==='falhou'?'ag-alert':''}">${h(statusText(p))}</span><div><span>${h(observed(p))}</span><small>${h(safeReason(p))}</small></div><button class="btn mini" data-ag-order="${i}">Ver detalhes</button></div>`).join('');
    const p=lastState?.periodo_ciclo,range=lastState?.intervalo_ciclo;
    const period=range?periodText(range):p&&typeof p==='object'?periodText(p):'Ciclo '+(Estado.ciclo_id??'a confirmar')+' · intervalo a confirmar';
    $('agHealth').textContent=(Estado.conectado?'Servidor conectado':'Servidor indisponível')+' · '+captureHealth()+' · '+(orders.length?orders.length+(orders.length===1?' pedido conhecido':' pedidos conhecidos'):'Nenhuma pendência conhecida')+' · '+period;
  }
  function openOrder(index){
    const p=knownOrders()[index];if(!p)return;
    drawerReturn=document.activeElement;
    const fields=[['Pedido',p.numero_pedido||'Identidade a confirmar'],['Tipo',p.tipo==='deposito'?'Depósito':'Saque'],['Casa',casaLabel(p.casa)],['Conta',p.conta||'Identidade a confirmar'],['Valor',cents(p.valor)===null?'Valor a confirmar':fmt(Number(p.valor))],['Estado',statusText(p)],['Ciclo de origem',p.ciclo_id??'Não informado'],['Última evidência',observed(p)]];
    $('agDrawerBody').innerHTML='<dl class="ag-detail">'+fields.map(([k,v])=>`<div><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join('')+'</dl><div class="ag-note">'+h(safeReason(p))+'</div><p class="sub">Acompanhamento por respostas observadas. A consulta direta depende de validação da integração. Confira este pedido no histórico da aba que já está aberta.</p>';
    $('agDrawer').showModal();$('agDrawerClose').focus();
  }
  function closeDrawer(){$('agDrawer').close();if(drawerReturn&&drawerReturn.isConnected)drawerReturn.focus();}

  function renderMediaNew(r){
    const v=$('avMediaVal'),d=$('avMediaDelta'),a=$('avMediaAlvo');
    v.textContent=fmt(r.media);
    d.textContent=r.media===null?(r.oficial?'Total oficial aplicado · quantidade de contas a confirmar':'Média disponível após identificar contas com depósito'):fmt(r.td)+' ÷ '+r.contas+' contas';
    d.className='am-delta '+(r.media===null?'neu':r.media>=mediaAlvo()?'pos':'neg');
    if(document.activeElement!==a)a.value=mediaAlvo();
    if(!a._wired){a._wired=true;a.addEventListener('input',()=>{const n=Number(a.value);estado.config.mediaAlvo=n>0?n:80;salvar();renderMediaNew(finance());});}
  }
  function enhanceLive(){
    const r=finance();
    $('avDepQtd').textContent=r.qd??'—';$('avSaqQtd').textContent=r.qs??'—';
    $('agSaqLabel').textContent=r.qs===1?'confirmado e gravado':'confirmados e gravados';
    $('agDepAccounts').textContent=r.contas===null?'Contas a confirmar':r.contas+' contas identificadas';
    $('agRedeposits').textContent=r.redepositos===null?'Redepósitos a confirmar':r.redepositos+(r.redepositos===1?' redepósito incluído':' redepósitos incluídos');
    if(r.resultado===null){$('avResVal').textContent='—';$('topResVal').textContent='—';$('avResDelta').textContent='Aguardando valores confirmados do ciclo.';}
    if(!Estado.conectado&&lastState)$('avResDelta').textContent+=' · Últimos dados recebidos; servidor indisponível.';
    if(r.manualSemVinculo.length)$('avResDelta').textContent+=' · Saque manual aguardando vínculo explícito: '+r.manualSemVinculo.map(casaLabel).join(', ')+'.';
    renderTracking();renderDiagnostics();renderRecovery();
  }

  function mapping(){return lastState&&lastState.mapeamento_filha_mae||{};}
  function mappedHouse(casa){const map=mapping();return typeof map[casa]==='string'?map[casa]:casa;}
  function capturedFor(ca,conta){
    if(!compatible(ca))return null;
    const rows=finance().accounts.filter(a=>mappedHouse(a.casa)===ca.casa&&String(a.conta)===String(conta));
    return rows.length===1?rows[0]:null;
  }
  // Depósito CAPTURADO (Ao Vivo) somado da casa, mesmo sem compatibilidade — só para MOSTRAR a
  // divergência quando o operador força o total da mãe. Casa filha->mãe pelo mapa OU pela chave-mãe
  // derivada (p2-exemplopg->exemplo). Devolve centavos ou null (sem match/algum td nulo).
  function capturedTotal(ca){
    const mc=(typeof window!=='undefined'&&window.maeChave)?window.maeChave:(x=>String(x||'').toLowerCase().split('-').pop().replace(/pg$/,''));
    const alvo=String(ca.casa||'').toLowerCase();
    const rows=finance().accounts.filter(a=>{const fc=String(a.casa||'').toLowerCase();return mappedHouse(a.casa)===ca.casa||fc===alvo||mc(fc)===alvo;});
    if(!rows.length)return null;
    let s=0;for(const a of rows){const t=cents(a.td);if(t===null)return null;s+=t;}
    return s;
  }
  function motherCounts(ca){
    const unit=ca.unidade_contador,n=count(ca.contas),members=ca.membros||[];
    const identified=ca.lista_completa===true&&members.every(m=>m.conta&&cents(m.deposito)!==null)?new Set(members.filter(m=>cents(m.deposito)>0).map(m=>identity(ca.casa,m.conta))).size:null;
    const accounts=['contas','pessoas'].includes(unit)?n:count(ca.contas_distintas)??identified;
    const deposits=unit==='depositos'?n:count(ca.qtd_depositos);
    return {accounts,deposits,repeat:accounts===null||deposits===null||deposits<accounts?null:deposits-accounts};
  }
  // A janela devolvida pela casa (startTime/endTime) prova o que o enum vale; sem ela sobra o
  // voto de rótulo. O aviso diz qual das duas provas reprovou a leitura.
  function conflitoProva(c){
    if(Array.isArray(c.rotulos_da_janela))
      return ' — a casa devolveu '+h(c.rotulos_da_janela.length?c.rotulos_da_janela.map(periodText).join(' ou '):'um intervalo que não é nenhum dos períodos do painel');
    return c.enum_calibrado!=null?' (calibrado: '+h(c.enum_calibrado)+')':'';
  }
  function motherViews(){
    return (Estado.agente||[]).flatMap(house=>{
      if(!Array.isArray(house.fontes)||!house.fontes.length)return [house];
      const views=new Map();
      const view=(source,period,account='',variant='')=>{
        const key=JSON.stringify([source,period,account,variant]);
        if(!views.has(key))views.set(key,{casa:house.casa,conta_mae:account||null,fonte:source,periodo:period,unidade_contador:'desconhecida',lista_completa:false,membros:[],_tipo:'informacao',_variant:variant});
        return views.get(key);
      };
      for(const source of house.fontes){
        const data=source.dados||{},account=source.conta_mae??data.conta_mae??'',variant=source.tipo==='agente_membros'?(data.lista_completa?'completa':'parcial'):'',v=view(source.fonte,source.periodo,account,variant);
        Object.assign(v,{recebido_em:source.recebido_em,unidade_contador:source.unidade_contador,conta_mae:account||null,conta_mae_nome:data.conta_mae_nome,coleta_id:data.coleta_id,pagina:data.pagina,total_paginas:data.total_paginas,periodo_enum:data.periodo_enum,periodo_conflito:data.periodo_conflito});
        if(source.tipo==='agente_total'){
          Object.assign(v,{_tipo:'totais',deposito_total:data.deposito,contas:data.contas,saque_total:data.saque,aposta_total:data.aposta,lista_completa:false});
        }else if(source.tipo==='agente_info')v.membros_qtd=data.membros_qtd;
        else if(source.tipo==='agente_membros'){
          v._tipo='lista';v.membros=Array.isArray(data.membros)?data.membros:[];v.membros_recebidos=data.membros_recebidos;v.total_registros=data.total_registros;v.lista_completa=data.lista_completa===true&&Array.isArray(data.membros);
        }
      }
      for(const list of [...(house.listas_parciais||[]),...(house.listas||[])]){
        const v=view(list.fonte,list.periodo,list.conta_mae||'',list.lista_completa?'completa':'parcial');Object.assign(v,{_tipo:'lista',membros:list.membros||[],membros_recebidos:list.membros_recebidos??list.membros?.length,lista_completa:list.lista_completa===true,coleta_id:list.coleta_id,pagina:list.pagina,total_paginas:list.total_paginas,recebido_em:list.recebido_em});
      }
      return [...views.values()];
    });
  }
  const motherSelection=new Map();
  const motherIdentity=v=>JSON.stringify([v.casa,v.conta_mae||'']);
  const readingIdentity=v=>JSON.stringify([v.fonte,v.periodo,v._variant||'']);
  const sourceName=v=>({periodo:'Totais do período',total:'Acumulado da fonte',membros:'Lista de afiliados',info:'Informações de afiliados'})[v.fonte]||'Leitura recebida';
  function motherCards(){
    const grouped=new Map();
    motherViews().forEach(v=>{const key=motherIdentity(v);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(v);});
    return [...grouped].map(([key,options])=>{
      options.sort((a,b)=>({periodo:0,membros:1,total:2,info:3}[a.fonte]??4)-({periodo:0,membros:1,total:2,info:3}[b.fonte]??4)||String(b.recebido_em||'').localeCompare(String(a.recebido_em||'')));
      const selected=options.find(v=>readingIdentity(v)===motherSelection.get(key))||options[0];
      return {key,options,selected};
    });
  }
  // Uma casa fica OCULTA na Conta Mãe quando a operação dela foi FECHADA (a mãe some junto com o
  // progresso). NUNCA esconde uma casa em operação ATIVA (reabrir a operação traz a mãe de volta) —
  // por isso, enquanto o operador não fecha a meta, a mãe não pode sumir (nem ao trocar de aba).
  function maeOcultaDaConta(casa){
    const oc=(typeof estado!=='undefined'&&Array.isArray(estado.maeOcultas))?estado.maeOcultas:[];
    const k=String(casa||'').toLowerCase();
    // A mãe também fecha pela FILHA dela (servidor: filhas_da_mae). Mãe de chave opaca (hostExemplo1,
    // que o operador chamou de 11-gatinhopg) nunca batia com a chave da filha fechada e ficava na tela (24/09).
    const filhasDela=((typeof lastState!=='undefined'&&lastState&&lastState.filhas_da_mae&&lastState.filhas_da_mae[casa])||[]).map(f=>String(f.filha||'').toLowerCase());
    const mc=(typeof window!=='undefined'&&window.maeChave)?window.maeChave:(x=>String(x||'').toLowerCase().split('-').pop().replace(/pg$/,''));
    // Também pela chave-mãe DERIVADA da filha fechada: exemplocafe8 (fechada 01/10) -> mãe exemplocafe, que
    // o servidor não liga (rede de domínio numerado) e ficava na tela depois de finalizar a meta.
    if(!oc.includes(k)&&!oc.some(x=>mc(x)===k)&&!filhasDela.some(f=>oc.includes(f)))return false;
    // Operação ATIVA protege a mãe dela: casa a chave da filha OU a chave-mãe derivada (p2-exemplopg->exemplo).
    try{ const ops=(typeof opsAoVivo==='function')?opsAoVivo():[]; for(const op of ops){ const s=(typeof casasDaOp==='function')?casasDaOp(op):null; if(s){ for(const fc of s){ const f=String(fc).toLowerCase(); if(f===k||mc(f)===k||filhasDela.includes(f))return false; } } } }catch(e){}
    return true;
  }
  function renderMother(){
    const cards=motherCards(),all=cards.map(g=>g.selected),closed=Estado.encerradas||[],casas=all.filter(c=>!closed.includes(c.casa)&&!maeOcultaDaConta(c.casa));
    const wrap=$('cmCasas');$('cmVazio').style.display=all.length?'none':'block';
    $('cmVazio').innerHTML='<b>Aguardando leitura da Conta Mãe</b><br>Mantenha a conta de agente aberta e autenticada. Os valores serão exibidos após a próxima leitura dos relatórios.';
    wrap.innerHTML=casas.map((ca,i)=>{
      const counts=motherCounts(ca),cmp=compatible(ca),manual=getSaqueManual(ca.casa),on=(Estado.foco||[]).includes(ca.casa);
      const sourceLabel=sourceName(ca),group=cards.find(g=>g.key===motherIdentity(ca)),isList=ca._tipo==='lista',isInfo=ca._tipo==='informacao';
      const hasTotals=['deposito_total','aposta_total','saque_total'].some(k=>cents(ca[k])!==null);
      const hasMembers=Array.isArray(ca.membros)&&ca.membros.length>0;
      const waiting=!hasTotals&&!hasMembers&&!isList&&(!isInfo||count(ca.membros_qtd)===null);
      const value=x=>cents(x)===null?'<span class="ag-value-pending">Não informado</span>':h(fmt(x));
      // A conferência manual pertence à casa e ao ciclo, não à fonte selecionada.
      const manualContent=`<div class="l">Saque conferido manualmente</div><div class="v">${value(manual)}</div><small>Ciclo atual</small><button class="btn mini" data-ag-manual="${h(ca.casa)}">Editar valor</button>`;
      const countLabel=[counts.accounts===null?null:counts.accounts+' contas',counts.deposits===null?null:counts.deposits+' depósitos',counts.repeat===null?null:counts.repeat+' redepósitos incluídos no total'].filter(Boolean).join(' · ');
      const adjusted=(Estado.ajustes||[]).some(a=>a.casa===ca.casa);
      // rollover sutil: quantas vezes o depósito foi apostado (aposta ÷ depósito). Ex.: 12.724 ÷ 4.526 = 2,8×.
      const _dep=cents(ca.deposito_total),_apo=cents(ca.aposta_total);
      const rolloverTxt=(_dep&&_dep>0&&_apo!=null)?(_apo/_dep).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'×':'';
      const rows=(ca.membros||[]).map(m=>{
        const cap=capturedFor(ca,m.conta),dep=cents(m.deposito),diff=cap&&dep!==null&&cap.td!==null?cents(cap.td)-dep:null;
        const label=diff===null?'Sem comparação compatível':diff===0?'Totais iguais; pedidos não conciliados individualmente':'Diferença de '+fmt(Math.abs(diff)/100);
        return `<tr><td title="${h(m.conta||'Identidade a confirmar')}">${h(m.nome||m.conta||'Conta a confirmar')}</td><td>${h(fmt(m.deposito==null?null:Number(m.deposito)))}</td><td>${h(fmt(m.aposta==null?null:Number(m.aposta)))}</td><td>${h(fmt(cap?cap.td:null))}</td><td><span class="ag-status ${diff?'ag-alert':''}" role="img" aria-label="${h(label)}" title="${h(label)}">${diff===null?'—':diff===0?'✓':'!'}</span></td></tr>`;
      }).join('');
      return `<article class="cm-card ag-mother"><header class="cm-top"><strong class="cm-casa">${h(casaLabel(ca.casa))}</strong><button class="btn mini cm-editnome" data-ag-rename="${h(ca.casa)}" title="Editar o nome desta casa (ex.: 11-noitepg)">✏️</button><span>${h(ca.conta_mae_nome||'')}${ca.conta_mae?' · '+h(ca.conta_mae):''}</span><span class="ag-updated">Atualizado: ${h(observed({observado_em:ca.recebido_em||ca.atualizado_em}))}</span></header>${filhaDaMae(ca)}
        ${group.options.length>1?`<label class="ag-reading">Fonte e período <select data-ag-reading="${h(group.key)}" aria-label="Leitura de ${h(casaLabel(ca.casa))}">${group.options.map(v=>`<option value="${h(readingIdentity(v))}" ${v===ca?'selected':''}>${h(sourceName(v))} · ${h(periodText(v.periodo))}${v._variant?' · '+h(v._variant):''}</option>`).join('')}</select></label>`:`<p class="ag-caption">Fonte: ${h(waiting&&sourceLabel==='Leitura recebida'?'A confirmar':sourceLabel)}</p>`}
        <div class="ag-scope"><b>Período da fonte: ${h(periodText(ca.periodo))}${ca.periodo_enum!=null?' · enum '+h(ca.periodo_enum):''}</b><span>${h(waiting?'Dados financeiros ainda não recebidos':ca._tipo==='totais'?'Totais da fonte · cobertura dos pedidos não comprovada':isInfo?'Informações de membros · cobertura da lista a confirmar':coverage(ca))}</span>${ca.periodo_conflito?`<span class="ag-status ag-alert" title="O número do período que a casa pediu não bate com a aba lida; a leitura não foi gravada como ${h(ca.periodo_conflito.rotulo_lido)}">aba dizia “${h(ca.periodo_conflito.rotulo_lido)}”, a casa pediu enum ${h(ca.periodo_conflito.enum)}${conflitoProva(ca.periodo_conflito)}</span>`:''}${periodoDivergente(ca)}</div>
        ${divergenciaCard(ca)}
        ${waiting?`<div class="ag-note ag-waiting" role="status"><b>Aguardando leitura</b><p>Esta fonte ainda não informou valores. Abra a página de afiliados na conta de agente para receber a leitura.</p>${countLabel?`<p>Indicadores recebidos: ${h(countLabel)}.</p>`:''}</div>`:isList?`<p class="ag-caption">${counts.accounts===null?'Contas com depósito: a confirmar.':counts.accounts+' contas com depósito identificadas nesta lista.'} Os valores por registro pertencem somente à leitura selecionada.</p>`:isInfo?`<p class="ag-note">Membros informados pela fonte: <b>${count(ca.membros_qtd)??'a confirmar'}</b></p>`:hasTotals?`<div class="cm-nums"><div class="cm-cell"><div class="l">Depósitos informados</div><div class="v">${value(ca.deposito_total)}</div><small>${h(countLabel||'Contas e quantidade de depósitos a confirmar')}</small></div><div class="cm-cell"><div class="l">Apostas informadas</div><div class="v">${value(ca.aposta_total)}</div>${rolloverTxt?`<small class="cm-roll" title="Aposta ÷ depósito — quantas vezes o depósito foi apostado (rollover)">${h(rolloverTxt)} do depósito</small>`:''}</div><div class="cm-cell"><div class="l">Saques informados</div><div class="v">${value(ca.saque_total)}</div></div><div class="cm-cell ag-manual">${manualContent}</div></div>`:`<p class="ag-caption">Valores recebidos por registro na tabela abaixo. Totais da fonte ainda não informados.${countLabel?' '+h(countLabel)+'.':''}</p>`}
        ${waiting||isList||isInfo||!hasTotals?`<div class="ag-manual ag-manual-inline">${manualContent}</div>`:''}
        <p class="ag-caption">${cmp?'Valores do mesmo período. Totais iguais não comprovam cada pedido.':'Conferência indisponível: período ou cobertura ainda não compatíveis.'}</p>
        <div class="cm-acoes">${!isList&&!isInfo?`<button class="btn mini" data-ag-official="${i}" ${cents(ca.deposito_total)===null?'disabled title="A fonte ainda não informou um depósito total."':cmp?'title="Aplicar o total da mãe como oficial do ciclo."':'title="Período/cobertura não confirmados como do ciclo — aplica assim mesmo; confira a divergência antes."'}>${cents(ca.deposito_total)!==null&&!cmp?'Usar depósito oficial (forçar)':'Usar depósito oficial'}</button>`:''}${adjusted?`<button class="btn mini" data-ag-remove-official="${h(ca.casa)}">Remover ajuste oficial</button>`:''}<button class="btn mini ${on?'on':''}" aria-pressed="${on}" data-ag-focus="${h(ca.casa)}">${on?'Captura em foco':'Focar captura'}</button><details class="ag-more"><summary>Mais</summary><button class="btn danger mini" data-ag-end="${h(ca.casa)}">Encerrar casa</button><p>Fonte: ${h(ca.fonte||'não informada')}<br>Indicador da fonte: ${count(ca.contas)??'não informado'} · ${['contas','pessoas','depositos'].includes(ca.unidade_contador)?h(ca.unidade_contador):'unidade a confirmar'}<br>Coleta: ${h(ca.coleta_id||'não informada')} · página ${h(ca.pagina??'—')} de ${h(ca.total_paginas??'—')}</p></details></div>
        ${isList||rows?`<div class="cm-tabwrap" role="region" aria-label="Contas de ${h(casaLabel(ca.casa))}" tabindex="0"><table class="cm-tab"><colgroup><col class="ag-col-name"><col class="ag-col-money"><col class="ag-col-money"><col class="ag-col-money"><col class="ag-col-status"></colgroup><thead><tr><th scope="col">Conta</th><th scope="col">Depósito</th><th scope="col">Aposta</th><th scope="col">Capturado</th><th scope="col">Conferência</th></tr></thead><tbody>${rows||'<tr><td colspan="5">Nenhum registro recebido para esta fonte e período.</td></tr>'}</tbody></table></div>`:''}</article>`;
    }).join('');
    if(all.length&&!casas.length)wrap.innerHTML='<p class="ag-note">Todas as casas estão encerradas neste momento.</p>';
    // Uma casa pode ter varias chaves (mae e filha, dominio trocado): agrupadas pelo nome do
    // painel, senao aparecia "Reativar FROTAPG" tres vezes. Recolhido: casa encerrada e decisao
    // ja tomada, nao pendencia — abre so quando quiser reativar.
    if(closed.length){
      const porNome=new Map();
      closed.forEach(c=>{const nome=casaLabel(c);porNome.set(nome,(porNome.get(nome)||[]).concat([c]));});
      const botoes=[...porNome].map(([nome,chaves])=>`<button class="btn mini" data-ag-resume="${h(chaves.join('|'))}">Reativar ${h(nome)}</button>`).join(' ');
      const extras=(porNome.size>1?' <button class="btn mini" data-ag-resume-todas="1">Reativar todas</button>':'')+' <button class="btn mini danger" data-ag-remove-todas="1">Remover todas</button>';
      wrap.innerHTML+=`<details class="ag-note ag-recolhido"><summary>${porNome.size} casa(s) encerrada(s)</summary><p>${botoes}${extras}</p></details>`;
    }
    if(!wrap._agWired){wrap._agWired=true;wrap.addEventListener('click',async e=>{
      const b=e.target.closest('button');if(!b)return;
      try{
        if(b.dataset.agRename){if(typeof renomearCasa==='function')renomearCasa(b.dataset.agRename);return;}
        if(b.dataset.agManual){
          const casa=b.dataset.agManual,v=prompt('Saque total conferido manualmente em '+casaLabel(casa)+' (R$). Deixe vazio para remover.',getSaqueManual(casa)??'');
          if(v===null)return;const clean=v.trim(),n=clean.includes(',')?Number(clean.replace(/\./g,'').replace(',','.')):Number(clean);
          if(clean&&(!Number.isFinite(n)||n<0)){toast('Informe um valor válido, igual ou maior que zero.');return;}
          await exclusive(async()=>{ensureBase();if(pending())throw Error('Conclua a recuperação antes de alterar o saque.');setSaqueManual(casa,clean?n:'');});renderTudo();return;
        }
        if(b.dataset.agOfficial!==undefined){
          // MESMO filtro do renderMother (encerradas + maeOcultaDaConta): senão o índice do botão
          // aponta para a casa errada quando alguma mãe está oculta.
          const current=motherCards().map(g=>g.selected).filter(c=>!(Estado.encerradas||[]).includes(c.casa)&&!maeOcultaDaConta(c.casa)),ca=current[Number(b.dataset.agOfficial)];
          if(!ca)throw Error('A fonte mudou. Confira novamente.');
          if(cents(ca.deposito_total)===null)throw Error('A fonte ainda não informou um depósito total.');
          const ct=motherCounts(ca).accounts;
          const contasTxt=ct===null?'A média ficará a confirmar até identificar a quantidade de contas.':'Contas identificadas: '+ct+'.';
          const aplicar=()=>request('/api/ajuste',{casa:ca.casa,deposito:ca.deposito_total,contas:ct,unidade_contador:ct===null?'desconhecida':'contas',fonte:ca.fonte,periodo:ca.periodo}).then(()=>{Estado.versao=null;pollEstado();}).catch(error);
          if(compatible(ca)){
            confirmar('Aplicar '+fmt(ca.deposito_total)+' de '+periodText(ca.periodo)+'? '+contasTxt,aplicar,{ok:'Aplicar total oficial'});
          }else{
            // Divergência: o operador FORÇA o total da mãe como oficial mesmo sem período/cobertura
            // confirmados como do ciclo (pedido do operador 22/09). Mostra a diferença vs o Ao Vivo.
            const cap=capturedTotal(ca),dep=cents(ca.deposito_total);
            const divTxt=cap===null?' O capturado no Ao Vivo desta casa não pôde ser somado para comparação.':' Capturado no Ao Vivo: '+fmt(cap/100)+' · diferença de '+fmt(Math.abs(dep-cap)/100)+'.';
            confirmar('⚠ Período/cobertura desta fonte ('+periodText(ca.periodo)+') NÃO estão confirmados como do ciclo. Forçar '+fmt(ca.deposito_total)+' como depósito oficial de '+casaLabel(ca.casa)+'?'+divTxt+' '+contasTxt,aplicar,{ok:'Forçar total oficial',perigo:true});
          }
          return;
        }
        if(b.dataset.agRemoveOfficial){const body={casa:b.dataset.agRemoveOfficial,deposito:'',expected_versao:String(Estado.versao)};confirmar('Remover o ajuste oficial de '+casaLabel(body.casa)+'? Os depósitos capturados voltam a compor o resultado.',()=>request('/api/ajuste',body).then(()=>{Estado.versao=null;pollEstado();}).catch(error),{ok:'Remover ajuste'});return;}
        if(b.dataset.agFocus){const casas=(Estado.foco||[]).slice(),i=casas.indexOf(b.dataset.agFocus);if(i<0)casas.push(b.dataset.agFocus);else casas.splice(i,1);await request('/api/foco',{casas});}
        if(b.dataset.agResumeTodas){
          const todas=(lastState?.encerradas||[]);
          if(!todas.length)return;
          confirmar('Reativar as '+todas.length+' chave(s) de casa encerradas? Elas voltam a ser capturadas.',
            ()=>Promise.all(todas.map(c=>request('/api/encerrar',{casa:c,on:false}))).then(()=>{Estado.versao=null;pollEstado();}).catch(error),{ok:'Reativar todas'});
          return;
        }
        if(b.dataset.agRemoveTodas){
          const todas=(lastState?.encerradas||[]);
          if(!todas.length)return;
          confirmar('Remover as '+todas.length+' chave(s) de casas encerradas? Apaga as leituras da mãe delas e limpa a lista; elas só voltam se forem capturadas de novo. Não dá pra desfazer.',
            async ()=>{try{for(const c of todas)await request('/api/agente/remover',{casa:c});for(const c of todas)await request('/api/encerrar',{casa:c,on:false});Estado.versao=null;pollEstado();}catch(err){error(err);}},
            {ok:'Remover todas',perigo:true});
          return;
        }
        if(b.dataset.agResume)for(const casa of b.dataset.agResume.split('|'))await request('/api/encerrar',{casa:casa,on:false});
        if(b.dataset.agEnd){confirmar('Encerrar '+casaLabel(b.dataset.agEnd)+'? A casa poderá ser reativada em seguida.',()=>request('/api/encerrar',{casa:b.dataset.agEnd,on:true}).then(()=>{Estado.versao=null;pollEstado();}).catch(error),{ok:'Encerrar casa'});return;}
        Estado.versao=null;pollEstado();
      }catch(e){error(e);}
    });}
    if(!wrap._agSelect){wrap._agSelect=true;wrap.addEventListener('change',e=>{if(!e.target.matches('[data-ag-reading]'))return;motherSelection.set(e.target.dataset.agReading,e.target.value);renderMother();renderComparison();});}
    const clear=$('cmLimpar');if(clear&&!clear._wired){clear._wired=true;clear.addEventListener('click',()=>confirmar('Limpar as leituras da Conta Mãe? Confira a cobertura do backup em Ajustes antes de continuar.',()=>request('/api/agente/limpar',{}).then(()=>{Estado.versao=null;pollEstado();}).catch(error),{ok:'Limpar leituras',perigo:true}));}
  }
  function renderComparison(){
    const wrap=$('avConferencia'),list=motherCards().map(g=>g.selected).filter(c=>!(Estado.encerradas||[]).includes(c.casa)&&!maeOcultaDaConta(c.casa));
    wrap.hidden=!list.length;
    wrap.innerHTML='<h3>Conferência por período</h3><div class="conf-row">'+list.map(c=>{
      const rows=finance().por_casa.filter(r=>mappedHouse(r.casa)===c.casa);
      const valid=compatible(c)&&rows.length&&rows.every(r=>r.td!==null)&&cents(c.deposito_total)!==null;
      const dep=rows.reduce((s,r)=>s+(cents(r.td)||0),0),diff=valid?cents(c.deposito_total)-dep:null;
      return `<div class="conf-chip ${diff===null?'wait':diff===0?'ok':'dif'}"><b>${h(casaLabel(c.casa))}</b><small>${h(periodText(c.periodo))}</small><p>${diff===null?'Período ou cobertura sem comparação':diff===0?'Totais iguais · pedidos ainda sujeitos à conferência':'Diferença de depósitos: '+h(fmt(diff/100))}</p></div>`;
    }).join('')+'</div>';
  }

  function linkedMetas(){
    let ids=Array.isArray(estado.metasAoVivo)?estado.metasAoVivo:[];
    if(!ids.length&&estado.metaAoVivo)ids=[estado.metaAoVivo];
    return [...new Set(ids)].map(id=>estado.operacoes.find(o=>o.id===id&&!o.ok)).filter(Boolean);
  }
  function validateFrozen(j,requestBody){
    const s=j&&j.resumo;
    if(!j||j.status!=='ok'||j.fechamento_id!==requestBody.fechamento_id||j.ciclo_id!==requestBody.ciclo_id||!Number.isInteger(j.novo_ciclo_id)||!Array.isArray(j.metas_ids)||JSON.stringify(j.metas_ids)!==JSON.stringify(requestBody.metas_ids)||!s)throw Error('Resposta de fechamento incompatível. O diário foi preservado.');
    for(const k of ['deposito','saque','gerente_bau','resultado'])if(cents(s[k])===null)throw Error('Resumo congelado incompleto: '+k+'.');
    if(cents(s.saque)-cents(s.deposito)+cents(s.gerente_bau)!==cents(s.resultado))throw Error('O resumo congelado não confere.');
    if(s.contas!==null&&count(s.contas)===null)throw Error('Quantidade de contas inválida no fechamento.');
    if(!Array.isArray(s.por_casa))throw Error('Resumo por casa ausente.');
    return j;
  }
  function closePreview(){
    if(pending()){renderRecovery();toast('Há uma recuperação pendente em Ajustes.');abrirAba('ajustes');return;}
    // Com 2+ operações ao vivo, fechar age SÓ na operação ATIVA (as outras seguem ao vivo); a última
    // é que gira o ciclo no servidor. finance() já vem escopado na operação ativa nesse caso.
    const ops=(typeof opsAoVivo==='function')?opsAoVivo():[];
    const intermediaria=ops.length>=2;
    const opAtiva=intermediaria&&typeof opAtivaAoVivo==='function'?opAtivaAoVivo():null;
    const metas=intermediaria?(window.metasAbertasDaOp?window.metasAbertasDaOp(opAtiva):[]):linkedMetas();
    const r=finance();
    if(!metas.length){toast(intermediaria?'Esta operação não tem meta aberta para fechar.':'Inicie uma meta existente em Metas antes de fechar a operação.');return;}
    if(!Estado.conectado||r.resultado===null||!lastState){toast('Aguarde os valores confirmados do servidor.');return;}
    const values=split(cents(r.resultado),metas.length);
    $('agCloseNumbers').innerHTML=[['Depósitos',r.td],['Saques',r.ts],['Gerente e BAU',r.bonus],['Resultado',r.resultado]].map(([k,v])=>`<div><span>${k}</span><b>${h(fmt(v))}</b></div>`).join('');
    $('agCloseMetas').innerHTML=metas.map((m,i)=>`<div><b>${h(m.plataforma||'Meta')}</b><span>${h(fmt(values[i]/100))}</span></div>`).join('');
    const orders=knownOrders(),restantes=ops.length-1;
    $('agCloseCoverage').textContent=intermediaria
      ? 'Fecha SÓ esta operação com o resultado das casas dela. '+(restantes===1?'A outra operação continua ao vivo neste ciclo':restantes+' operações continuam ao vivo neste ciclo')+' — o ciclo no servidor só é girado ao fechar a última.'
      : (orders.length?orders.length+(orders.length===1?' pedido conhecido permanecerá associado ao ciclo de origem. ':' pedidos conhecidos permanecerão associados aos ciclos de origem. '):'Nenhuma pendência conhecida. ')+healthText()+'. O fechamento usará os valores confirmados pelo servidor.';
    $('agCloseAccept').checked=false;$('agCloseConfirm').disabled=true;
    if(intermediaria){
      const opB=window.aovivoOpAtiva?window.aovivoOpAtiva():null;
      const payload={opId:opAtiva.id,metasIds:metas.map(m=>m.id),valuesCents:values,
        contasArr:(r.contas===null?null:split(r.contas,metas.length)),
        resultadoCents:cents(r.resultado),contas:r.contas,manual:r.saqMan||0,
        gerente:(opB&&opB.gerente)||0,bau:(opB&&opB.bau)||0,
        ciclo_id:Estado.ciclo_id??Estado.resumo?.ciclo_id};
      $('agCloseConfirm').onclick=()=>{ if(busy)return; $('agClose').close(); window.aplicarFechamentoParcial(payload); toast('Operação fechada. '+(restantes===1?'A outra continua ao vivo.':restantes+' continuam ao vivo.')); };
      $('agClose').showModal();$('agCloseCancel').focus();
      return;
    }
    // Fechamento FINAL (única operação ou modo legado): gira o ciclo no servidor. O Gerente/BAU e o
    // saque manual das operações já fechadas antes (parciais) entram no total, para que o resumo
    // congelado do servidor contenha TODOS os bônus e o resíduo da última operação feche a conta.
    const cicloId=Estado.ciclo_id??Estado.resumo?.ciclo_id;
    const parc=(estado.fechamentosParciais&&estado.fechamentosParciais[String(cicloId)])||{gerente:0,bau:0,manual:0};
    const snapshot={base:localStorage.getItem(KEY),extras:JSON.stringify(currentExtras()),metas_ids:metas.map(m=>m.id),ciclo_id:cicloId,expected_versao:String(Estado.versao),gerente:(AoVivo.gerente??0)+(parc.gerente||0),bau:(AoVivo.bau??0)+(parc.bau||0),saque_manual:(r.saqMan||0)+(parc.manual||0)};
    $('agCloseConfirm').onclick=()=>beginClose(snapshot);
    $('agClose').showModal();$('agCloseCancel').focus();
  }
  async function beginClose(snapshot){
    if(busy)return;busy=true;$('agCloseConfirm').disabled=true;
    try{
      await saving;await exclusive(async()=>{
        ensureBase();if(snapshot.base!==base||snapshot.extras!==JSON.stringify(currentExtras())||snapshot.expected_versao!==String(Estado.versao))throw Error('Os dados mudaram durante a conferência. Abra a prévia novamente.');
        if(pending())throw Error('Outra recuperação está em andamento.');
        const body={fechamento_id:crypto.randomUUID(),ciclo_id:snapshot.ciclo_id,metas_ids:snapshot.metas_ids,gerente:snapshot.gerente,bau:snapshot.bau,saque_manual:snapshot.saque_manual,expected_versao:snapshot.expected_versao};
        const j={v:1,phase:'prepared',request:body,before:base,stateBefore:clone(estado),extras:currentExtras(),at:new Date().toISOString()};
        journal(CLOSE,j);await resumeClose(j);
      });$('agClose').close();
    }catch(e){if(read(CLOSE)?.phase==='rejected')$('agClose').close();error(e);}finally{busy=false;renderRecovery();}
  }
  async function resumeClose(j){
    if(terminal(j))return;
    if(!j.response){
      j.phase='sent';journal(CLOSE,j);
      let response;
      try{response=await request('/api/ciclo/fechar',j.request);}catch(error){if(error.semCommit)rejectJournal(CLOSE,j,error);throw error;}
      j.response=validateFrozen(response,j.request);
      j.phase='server_committed';journal(CLOSE,j);
    }
    validateFrozen(j.response,j.request);
    const current=read(KEY),response=j.response;
    if(current&&current.fechamentosAplicados&&current.fechamentosAplicados[response.fechamento_id]){
      j.phase='browser_committed';journal(CLOSE,j);
    }else{
      if(localStorage.getItem(KEY)!==j.before)throw Error('O servidor fechou o ciclo, mas as metas foram alteradas em outra janela. Preserve o diário e confira os dados antes de aplicar.');
      const next=clone(j.stateBefore||JSON.parse(j.before)),ids=response.metas_ids;
      // Resíduo: as operações fechadas ANTES neste ciclo (parciais) já receberam sua parte no cliente;
      // o resumo congelado do servidor é do ciclo INTEIRO (com todos os bônus). A última operação
      // recebe o que sobra = total do servidor − já atribuído. Sem parciais, resíduo = total (idêntico
      // ao fechamento de sempre). A soma das operações fecha exatamente o total autoritativo do servidor.
      const parc=(next.fechamentosParciais&&next.fechamentosParciais[String(response.ciclo_id)])||{resultadoCents:0,contas:0};
      const rc=residualClose(cents(response.resumo.resultado),response.resumo.contas,parc.resultadoCents||0,parc.contas,ids.length);
      const values=rc.values,accounts=rc.contas;
      ids.forEach((id,i)=>{const m=next.operacoes.find(o=>o.id===id&&!o.ok);if(!m)throw Error('Uma meta vinculada não está mais disponível.');m.ok=true;m.lucro=values[i]/100;m.depositantes=accounts?accounts[i]:null;if(!m.fimManual)m.fimManual=j.at.slice(0,10);m.fechamento_id=response.fechamento_id;});
      next.metaAoVivo=null;next.metasAoVivo=[];
      next.aovivoOps=[];next.aovivoAtiva=null;   // ciclo girou: todas as operações do ciclo encerradas
      if(next.fechamentosParciais)delete next.fechamentosParciais[String(response.ciclo_id)];
      // a mãe das casas fechadas some junto com o progresso (só da tela; volta ao reiniciar a operação)
      try{ if(typeof window!=='undefined'&&window.ocultarMaesFechadas) window.ocultarMaesFechadas(ids,next); }catch(e){}
      next.fechamentosAplicados=next.fechamentosAplicados||{};
      next.fechamentosAplicados[response.fechamento_id]=clone(response);
      const now=new Date(j.at);j.monthTotal=next.operacoes.filter(o=>{const d=parseISO(o.inicio);return d&&d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();}).reduce((s,o)=>s+(cents(o.lucro)||0),0)/100;
      journal(CLOSE,j);commitState(next);j.phase='browser_committed';journal(CLOSE,j);
    }
    // Os extras só são limpos se ainda são os que entraram no fechamento.
    if(localStorage.getItem('aovivo_extra')===j.extras.aovivo_extra)localStorage.setItem('aovivo_extra',JSON.stringify({bau:null,gerente:null}));
    AoVivo.bau=read('aovivo_extra')?.bau??null;AoVivo.gerente=read('aovivo_extra')?.gerente??null;
    if(!j.telegram){j.telegram='available';journal(CLOSE,j);}
    j.phase='done';journal(CLOSE,j);Estado.versao=null;pollEstado();renderTudo();
    toast('Operação fechada nas metas iniciadas. Resultado: '+fmt(response.resumo.resultado));
    await sendFrozenTelegram(j);
  }
  function telegramText(j){
    const s=j.response.resumo;
    return '<b>Operação fechada</b> · ciclo '+h(j.response.ciclo_id)+'\nDepósitos: '+fmt(s.deposito)+' · Saques: '+fmt(s.saque)+'\nGerente e BAU: '+fmt(s.gerente_bau)+'\n<b>Resultado: '+fmt(s.resultado)+'</b>\n'+s.por_casa.map(c=>'• '+h(casaLabel(c.casa))+': depósitos '+fmt(c.deposito)+' · saques '+fmt(c.saque)).join('\n')+'\nMês acumulado no fechamento: '+fmt(j.monthTotal);
  }
  async function sendFrozenTelegram(j,manual=false){
    const cfg=tgCfg();if(!cfg.token||!cfg.chatId||!cfg.resumoAoFinalizar)return;
    if(j.telegram!=='available'&&!manual)return;
    j.telegram='sending';journal(CLOSE,j);
    try{const r=await tgSend(telegramText(j));if(!r||r.ok!==true)throw Error('Envio não confirmado.');j.telegram='sent';}
    catch(_){j.telegram='unknown';}journal(CLOSE,j);renderRecovery();
  }

  function validateTree(x,depth=0){
    if(depth>50)throw Error('Arquivo com estrutura excessivamente profunda.');
    if(x===null||typeof x==='string'||typeof x==='boolean')return;
    if(typeof x==='number'){if(!Number.isFinite(x))throw Error('Número inválido no arquivo.');return;}
    if(typeof x!=='object')throw Error('Valor inválido no arquivo.');
    for(const [k,v] of Object.entries(x)){if(['__proto__','constructor','prototype'].includes(k))throw Error('Chave inválida no arquivo.');validateTree(v,depth+1);}
  }
  function validateBrowser(b){
    if(!b||typeof b!=='object'||!b.estado||!b.extras)throw Error('Componente do navegador ausente.');
    validateTree(b);
    const s=b.estado;
    for(const k of ['operacoes','historico','plataformas'])if(!Array.isArray(s[k]))throw Error('Lista inválida no navegador: '+k+'.');
    if(!s.config||typeof s.config!=='object'||Array.isArray(s.config)||!s.cronograma||typeof s.cronograma!=='object')throw Error('Preferências ou cronograma inválidos.');
    const dias=o=>Object.entries(o).every(([k,v])=>/^[0-6]$/.test(k)&&Array.isArray(v)&&v.every(x=>typeof x==='string'));
    // 'lancamentos' = {'0'..'6': [...]}, ao lado dos encerramentos (mesmo formato do servidor)
    const {lancamentos,...encerra}=s.cronograma;
    if(!dias(encerra)||(lancamentos!==undefined&&(!lancamentos||typeof lancamentos!=='object'||Array.isArray(lancamentos)||!dias(lancamentos))))throw Error('Cronograma inválido.');
    const ids=new Set();s.operacoes.forEach(o=>{
      if(!o||typeof o.id!=='string'||!o.id||ids.has(o.id))throw Error('Meta sem identidade única.');ids.add(o.id);
      for(const k of ['lucro','depositantes'])if(o[k]!=null&&o[k]!==''&&!known(o[k]))throw Error('Valor inválido em uma meta.');
    });
    for(const k of ['chavesPix','usuarios','instagrams','logins','sessoes','selecao','atividade'])if(!Array.isArray(s[k]))throw Error('Lista inválida: '+k+'.');
    for(const k of ['historico','plataformas','chavesPix','usuarios','instagrams','logins','sessoes','atividade'])if(s[k].some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error('Registro inválido: '+k+'.');
    if(s.config.telegram&&(!s.config.telegram||typeof s.config.telegram!=='object'||Array.isArray(s.config.telegram)))throw Error('Preferências do Telegram inválidas.');
    if(s.sessoes.some(x=>typeof x.id!=='string'||!Array.isArray(x.opsIds)||!Array.isArray(x.operando)))throw Error('Sessão inválida no arquivo.');
    if(s.selecao.some(x=>typeof x!=='string')||s.metasAoVivo!=null&&(!Array.isArray(s.metasAoVivo)||s.metasAoVivo.some(x=>typeof x!=='string')))throw Error('Vínculos de metas inválidos.');
    if(s.plataformas.some(p=>typeof p.plataforma!=='string'))throw Error('Cadastro de plataforma inválido.');
    if(s.historico.some(p=>typeof p.mes!=='string'||!known(p.lucroTotal)))throw Error('Histórico inválido no arquivo.');
    for(const k of Object.keys(b.extras))if(!EXTRAS.includes(k))throw Error('Preferência externa não reconhecida: '+k+'.');
    for(const k of EXTRAS){const v=b.extras[k];if(v!==null&&typeof v!=='string')throw Error('Preferência ausente ou inválida: '+k+'.');}
    for(const k of ['aovivo_extra','saqueManual'])if(b.extras[k]!==null){
      let x;try{x=JSON.parse(b.extras[k]);}catch(_){throw Error('Valor salvo inválido: '+k+'.');}
      if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Valor salvo inválido: '+k+'.');
      for(const [name,v] of Object.entries(x))if((k==='aovivo_extra'&&!['bau','gerente'].includes(name))||v!==null&&(!known(v)||Number(v)<0))throw Error('Valor salvo inválido: '+k+'.');
    }
    return b;
  }
  async function digest(x){
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(x)));
    return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
  }
  function validateBank(b){
    if(!b||b._v!==2||!Number.isInteger(b.schema_version)||b.schema_version<1||!b.tabelas||!b.manifesto)throw Error('Banco sem manifesto válido. Exporte novamente com o servidor atualizado.');
    const required=['ciclos','operacoes','jogos','jogos_cat','contas','agente','agente_membros','ajustes','foco','descartados','encerradas','pendentes','pedidos','fechamentos'];
    required.forEach(k=>{if(!Array.isArray(b.tabelas[k]))throw Error('Tabela ausente no backup: '+k+'.');});
    for(const [k,rows] of Object.entries(b.tabelas))if(!Array.isArray(rows)||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw Error('Tabela inválida: '+k+'.');
    validateTree(b);return b;
  }
  async function preflight(envelope){
    validateTree(envelope);
    if(envelope.formato!=='agentum-backup'||envelope.versao!==3||!envelope.manifesto?.hashes)throw Error('Formato de backup não reconhecido. O arquivo não foi aplicado.');
    validateBrowser(envelope.navegador);
    for(const part of ['navegador','banco'])if(await digest(envelope[part])!==envelope.manifesto.hashes[part])throw Error('A integridade de '+part+' não confere.');
    if(!envelope.banco)throw Error('Este arquivo contém apenas o navegador. A restauração conjunta exige banco validado.');
    validateBank(envelope.banco);
    const result=await request('/api/restore/validar',{banco:envelope.banco});
    if(!['ok','valido','validado'].includes(result.status))throw Error('O servidor não confirmou a validação integral.');
    return envelope;
  }
  async function makeBackup(){
    await saving;ensureBase();
    const rawBefore=localStorage.getItem(KEY),extrasBefore=JSON.stringify(currentExtras());
    const navegador={estado:clone(estado),extras:currentExtras()};validateBrowser(navegador);
    let banco=null,reason='Filas das extensões e instalações ausentes não estão incluídas.';
    try{banco=validateBank(await request('/api/backup'));}catch(e){reason='Banco indisponível ou ainda sem validação integral. '+reason;}
    if(rawBefore!==localStorage.getItem(KEY)||extrasBefore!==JSON.stringify(currentExtras()))throw Error('Os dados mudaram durante o backup. Exporte novamente.');
    const manifest={cobertura:'parcial',motivo:reason,corte_coordenado:false,instalacoes:(Estado.instalacoes||[]).map(i=>({instalacao_id:i.instalacao_id,tipo:i.tipo,versao:i.versao,fila:count(i.fila)})),hashes:{navegador:await digest(navegador),banco:await digest(banco)}};
    return {formato:'agentum-backup',versao:3,exportado_em:new Date().toISOString(),navegador,banco,manifesto:manifest};
  }
  async function exportBackup(){
    try{
      const envelope=await makeBackup(),blob=new Blob([JSON.stringify(envelope,null,2)],{type:'application/json'}),a=document.createElement('a');
      const url=URL.createObjectURL(blob);a.href=url;a.download='agentum-backup-'+hojeLocalISO()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('Backup exportado · cobertura parcial. '+(envelope.banco?'Banco, navegador e extras incluídos.':'Somente navegador e extras.'));
    }catch(e){error(e);}
  }
  async function importBackup(file){
    try{
      if(file.size>40*1024*1024)throw Error('Arquivo acima do limite de 40 MB.');
      const envelope=await preflight(JSON.parse(await file.text()));
      const previous=await makeBackup();
      if(!previous.banco)throw Error('Não foi possível preservar o banco atual antes da restauração.');
      const snapshot={raw:localStorage.getItem(KEY),extras:JSON.stringify(currentExtras()),versao:String(Estado.versao)};
      confirmar('Backup validado · cobertura parcial. Banco, metas, histórico, formulários, preferências e extras serão substituídos pelos dados deste arquivo. Filas externas não estão incluídas. A cópia anterior será preservada no diário de recuperação.',()=>restoreBackup(envelope,previous,snapshot),{titulo:'Restaurar backup validado',ok:'Restaurar banco e navegador',perigo:true});
    }catch(e){error(e);}
  }
  async function restoreBackup(envelope,previous,snapshot){
    if(busy)return;busy=true;
    try{await saving;await exclusive(async()=>{
      ensureBase();if(pending())throw Error('Há outra recuperação pendente.');
      if(snapshot.raw!==localStorage.getItem(KEY)||snapshot.extras!==JSON.stringify(currentExtras())||snapshot.versao!==String(Estado.versao))throw Error('Os dados mudaram. Selecione o arquivo e confira novamente.');
      const j={v:1,phase:'prepared',restore_id:crypto.randomUUID(),envelope,previous,before:base,extras:currentExtras(),expected_versao:snapshot.versao,appliedExtras:[]};
      journal(RESTORE,j);await resumeRestore(j);
    });}catch(e){error(e);}finally{busy=false;renderRecovery();}
  }
  async function resumeRestore(j){
    validateBrowser(j.envelope.navegador);validateBank(j.envelope.banco);
    if(terminal(j))return;
    if(j.phase==='sent'){
      const result=await request('/api/restore/status?id='+encodeURIComponent(j.restore_id));
      if(result.status==='ok'&&result.restore_id===j.restore_id&&result.estado==='concluido'&&result.resposta?.status==='ok'){j.response=result.resposta;j.phase='server_committed';journal(RESTORE,j);}
      else if(result.status==='ok'&&result.restore_id===j.restore_id&&['preparado','falhou'].includes(result.estado)){j.phase='prepared';journal(RESTORE,j);}
      else if(!['nao_encontrado','not_found','inexistente'].includes(result.status))throw Error('O estado da restauração ainda não foi confirmado. Preserve o diário e tente recuperar novamente.');
    }
    if(j.phase==='prepared'||j.phase==='sent'){
      j.phase='sent';journal(RESTORE,j);
      let response;
      try{response=await request('/api/restore',{confirmar:true,restore_id:j.restore_id,banco:j.envelope.banco,expected_versao:j.expected_versao});}catch(error){if(error.semCommit)rejectJournal(RESTORE,j,error);throw error;}
      if(response.status!=='ok'||response.restore_id!==j.restore_id)throw Error('A restauração do banco não foi confirmada com a identidade esperada.');
      j.response=response;j.phase='server_committed';journal(RESTORE,j);
    }
    const target=JSON.stringify(j.envelope.navegador.estado),raw=localStorage.getItem(KEY);
    if(raw!==j.before&&raw!==target)throw Error('Banco restaurado; dados do navegador alterados em outra janela. O diário foi mantido para conferência.');
    // Validar TODOS os extras antes de aplicar qualquer um. Cada escrita é recuperável.
    for(const k of EXTRAS){const now=localStorage.getItem(k),dest=j.envelope.navegador.extras[k];if(now!==j.extras[k]&&now!==dest)throw Error('Preferência alterada em outra janela: '+k+'.');}
    for(const k of EXTRAS){const value=j.envelope.navegador.extras[k];if(value===null)localStorage.removeItem(k);else localStorage.setItem(k,value);if(!j.appliedExtras.includes(k))j.appliedExtras.push(k);journal(RESTORE,j);}
    commitState(clone(j.envelope.navegador.estado));j.phase='browser_committed';journal(RESTORE,j);
    AoVivo.bau=read('aovivo_extra')?.bau??null;AoVivo.gerente=read('aovivo_extra')?.gerente??null;
    j.phase='done';journal(RESTORE,j);Estado.versao=null;renderTudo();pollEstado();toast('Banco e navegador restaurados. Cópia anterior preservada.');
  }
  async function writeConnected(){
    if(!fileHandle)return;
    try{
      if(await fileHandle.queryPermission({mode:'readwrite'})!=='granted')return;
      const envelope=await makeBackup(),w=await fileHandle.createWritable();await w.write(JSON.stringify(envelope,null,2));await w.close();
    }catch(e){$('bkStatus').textContent='Arquivo conectado · gravação pendente: '+e.message;}
  }
  // Mês de uma meta = mês em que ela COMEÇOU (o mesmo critério do "mês acumulado" do fechamento).
  // Não usa o fim: a Data fim é a planejada e passa do mês (p4-sweater lançada 28/09 termina 02/10).
  function mesDaMeta(o){const d=parseISO(o.inicio)||parseISO(o.fimManual);return d?d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'):null;}
  function mesAtual(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  function nomeMes(ym){const [a,m]=ym.split('-').map(Number);return new Date(a,m-1,1).toLocaleDateString('pt-BR',{month:'long',year:'numeric'});}
  // Concluídas de meses ANTERIORES ao atual (o que o lembrete do dia 1 cobra).
  function pendentesDeArquivo(){const atual=mesAtual();return estado.operacoes.filter(o=>o.ok&&o.plataforma&&mesDaMeta(o)&&mesDaMeta(o)<atual);}
  function archiveMonth(){
    // Operação ao vivo não bloqueia mais: arquivar só tira metas JÁ concluídas, e as operações em
    // andamento usam as metas abertas e o acumulado de fechamentos parciais, que ficam intactos.
    if(pending()){toast('Conclua a recuperação pendente em Ajustes antes de arquivar o mês.');return;}
    const concluidas=estado.operacoes.filter(o=>o.ok&&o.plataforma);
    if(!concluidas.length){toast('Não há metas concluídas para arquivar.');return;}
    // Arquiva os meses que já acabaram, cada um com o nome dele. Sem nenhum, oferece o mês corrente.
    const antigos=pendentesDeArquivo(),rows=antigos.length?antigos:concluidas.filter(o=>(mesDaMeta(o)||mesAtual())===mesAtual());
    if(!rows.length){toast('Não há metas concluídas para arquivar.');return;}
    const grupos={};rows.forEach(o=>{const k=mesDaMeta(o)||mesAtual();(grupos[k]=grupos[k]||[]).push(o);});
    const meses=Object.keys(grupos).sort(),total=rows.reduce((s,o)=>s+(cents(o.lucro)||0),0),snapshot=localStorage.getItem(KEY),revision=String(Estado.versao);
    const resumo=meses.map(k=>nomeMes(k)+': '+grupos[k].length+(grupos[k].length===1?' meta':' metas')).join(' · ');
    const ficam=estado.operacoes.length-rows.length;
    confirmar('Arquivar '+rows.length+' metas concluídas ('+resumo+'), com resultado '+fmt(total/100)+'? '+(ficam?ficam+(ficam===1?' meta continua':' metas continuam')+' em Metas (abertas ou de '+nomeMes(mesAtual())+').':''),async()=>{
      try{await saving;await exclusive(async()=>{ensureBase();if(snapshot!==base||pending()||revision!==String(Estado.versao))throw Error('Os dados mudaram. Confira o mês novamente.');
        const next=clone(estado),date=new Date(),todosIds=rows.map(o=>o.id);
        meses.slice().reverse().forEach(k=>{
          const frozen=clone(grupos[k]),ids=frozen.map(o=>o.id),soma=frozen.reduce((s,o)=>s+(cents(o.lucro)||0),0),profits=frozen.map(o=>o.lucro).filter(known).map(Number),positive=profits.filter(v=>v>0).length,negative=profits.filter(v=>v<0).length,depositants=frozen.every(o=>count(o.depositantes)!==null)?frozen.reduce((s,o)=>s+Number(o.depositantes),0):null;
          next.historico.unshift({id:crypto.randomUUID(),mes:nomeMes(k),periodo:frozen.map(o=>o.inicio).filter(Boolean).sort().join(' · '),lucroTotal:soma/100,depositantes:depositants,ops:frozen.length,acerto:positive+negative?positive/(positive+negative):0,melhor:profits.length?Math.max(...profits):0,pior:profits.length?Math.min(...profits):0,ldMedio:depositants?soma/100/depositants:null,fechadoEm:date.toLocaleString('pt-BR'),operacoes:frozen,fechamentos:Object.values(next.fechamentosAplicados||{}).filter(f=>f.metas_ids.some(id=>ids.includes(id)))});
        });
        next.operacoes=next.operacoes.filter(o=>!todosIds.includes(o.id));
        const j={v:1,phase:'prepared',before:base,after:next,expected_versao:String(Estado.versao)};journal(MONTH,j);resumeMonth(j);
      });}catch(e){error(e);}
    },{ok:'Arquivar metas concluídas'});
  }
  function resumeMonth(j){
    if(j.phase==='done')return;
    const target=JSON.stringify(j.after),raw=localStorage.getItem(KEY);
    if(raw!==j.before&&raw!==target)throw Error('O mês mudou em outra janela. O diário mensal foi preservado.');
    commitState(j.after);j.phase='done';journal(MONTH,j);renderTudo();abrirAba('historico');toast('Mês arquivado com as metas e os resumos preservados.');
  }

  const SCHEDULE='agentum_cronograma_journal';let scheduleVersion=null,scheduleBusy=false,scheduleBaseline=null,scheduleRemote=null;
  let scheduleJob=null;
  async function syncSchedule(){
    if(scheduleBusy){await scheduleJob;return syncSchedule();}
    if(pending()||conflict)return;scheduleBusy=true;
    scheduleJob=exclusive(async()=>{
      const local=read(SCHEDULE),remote=await request('/api/cronograma');
      scheduleVersion=String(remote.versao);
      scheduleRemote=clone(remote.cronograma);
      if(local&&local.phase!=='done'){
        if(JSON.stringify(remote.cronograma)!==JSON.stringify(local.before)&&JSON.stringify(remote.cronograma)!==JSON.stringify(local.cronograma)&&String(local.expected_versao)!==scheduleVersion)throw Error('Cronograma alterado no servidor. Confira as versões em Ajustes antes de enviar.');
        if(JSON.stringify(remote.cronograma)!==JSON.stringify(local.cronograma)){
          const r=await request('/api/cronograma',{cronograma:local.cronograma,expected_versao:scheduleVersion});if(r.status!=='ok')throw Error('Cronograma não confirmado.');scheduleVersion=String(r.versao??scheduleVersion);
        }
        local.phase='done';journal(SCHEDULE,local);scheduleRemote=clone(local.cronograma);
      }else if(base&&(remote.cronograma===null||remote.cronograma&&Object.keys(remote.cronograma).length===0)&&Object.values(estado.cronograma||{}).some(a=>a.length)){
        const j={phase:'pending',cronograma:clone(estado.cronograma),expected_versao:scheduleVersion};journal(SCHEDULE,j);
        const r=await request('/api/cronograma',{cronograma:j.cronograma,expected_versao:scheduleVersion});if(r.status!=='ok')throw Error('Inicialização do cronograma não confirmada.');j.phase='done';journal(SCHEDULE,j);scheduleVersion=String(r.versao??scheduleVersion);
      }
    }).catch(e=>{const p=read(SCHEDULE);if(p&&p.phase!=='done'){p.motivo=e.message;journal(SCHEDULE,p);}}).finally(()=>{scheduleBusy=false;renderRecovery();});
    await scheduleJob;
  }
  // Fila parada em perfil offline da versão ATUAL = evento que ainda pode ser entregue (é só abrir o perfil).
  // Fila em versão antiga = órfã de reinstalação (não volta). E o motivo das órfãs: remover+carregar apaga o
  // armazenamento da extensão; ↻ Recarregar preserva.
  function filaOfflineTexto(){
    const s=lastState||{},parada=(count(s.fila_player_offline)||0)+(count(s.fila_mae_offline)||0),orfa=(count(s.fila_player_orfa)||0)+(count(s.fila_mae_orfa)||0);
    return (parada?parada+(parada===1?' evento parado':' eventos parados')+' em perfis offline da versão atual — abra esses perfis para entregar. ':'')
      +(orfa?orfa+(orfa===1?' evento ficou':' eventos ficaram')+' em versões antigas da extensão (não voltam). ':'')
      +'Para atualizar a extensão use ↻ Recarregar em chrome://extensions — remover e carregar de novo apaga os eventos ainda não entregues.';
  }
  function renderDiagnostics(){
    const el=$('agDiagnostics');if(!el)return;
    const inst=Estado.instalacoes||[],expected=Estado.ext_esperada||{};
    // Uptime + quedas do supervisor nas últimas 24h: queda repetida vira sinal visível, e o motivo
    // fica em logs/servidor-erro.log (gravado pelo próprio servidor).
    const srv=Estado.servidor||{},quedas=Number.isFinite(srv.quedas_24h)?srv.quedas_24h:null;
    const desde=srv.iniciado_em?new Date(srv.iniciado_em).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):null;
    const srvTxt=(Estado.conectado?'Conectado':'Indisponível')+(desde?' · no ar desde '+desde:'')+(quedas!==null?' · '+quedas+(quedas===1?' queda':' quedas')+' em 24h':'');
    el.innerHTML=`<div class="ag-diag-grid"><div><span>Servidor</span><b class="${quedas>=2?'ag-alert':''}" title="${h(srv.ultima_queda?'Última queda: '+srv.ultima_queda+' · motivo em logs/servidor-erro.log':'Sem quedas registradas')}">${h(srvTxt)}</b></div><div><span>Extensões esperadas</span><b>Filha ${h(expected.player||'a confirmar')} · Mãe ${h(expected.mae||'a confirmar')}</b></div><div><span>Acompanhamento</span><b>Respostas observadas</b></div><div><span>Backup</span><b>Cobertura parcial</b></div></div><p class="ag-caption">${h(healthText())}. A consulta ativa depende de validação por integração.</p>`+
      `<p class="ag-caption">${h(filaOfflineTexto())}</p>`+
      (inst.length?'<ul class="ag-installations">'+inst.map(i=>`<li><b>${h(i.tipo==='mae'?'Conta Mãe':'Conta filha')}</b> · ${h(i.versao||'versão não informada')} · fila ${count(i.fila)??'a confirmar'} · ${h(i.estado||'estado não informado')}</li>`).join('')+'</ul>':'<p>Nenhuma instalação com cobertura confirmada.</p>')+
      '<details class="ag-caption"><summary>Investigação e retenção de registros</summary><p>Investigação temporária por casa: indisponível neste servidor. Retenção dos registros técnicos: configuração não informada. Nenhuma limpeza automática será acionada pelo painel.</p></details>';
  }
  function renderRecovery(){
    const el=$('agRecovery');if(!el)return;
    const close=read(CLOSE),restore=read(RESTORE),schedule=read(SCHEDULE),month=read(MONTH),items=[];
    if(conflict)items.push('<p>'+(root.agentumStorageError?'Os dados salvos não puderam ser lidos. As gravações estão bloqueadas; o conteúdo original permanece no navegador.':'Há alterações em outra janela. Seu rascunho foi preservado nesta janela.')+'</p><button class="btn" data-ag-reload>Recarregar dados salvos</button><button class="btn ghost" data-ag-draft>Exportar rascunho</button>');
    if(close&&!terminal(close))items.push('<p>Fechamento aguardando recuperação. As metas receberão o resumo confirmado pelo servidor.</p><button class="btn" data-ag-recover="close">Recuperar fechamento</button>');
    if(restore&&!terminal(restore))items.push('<p>Restauração aguardando recuperação. A cópia anterior permanece no diário.</p><button class="btn" data-ag-recover="restore">Recuperar restauração</button>');
    if(close?.phase==='rejected')items.push('<p>O servidor recusou o fechamento sem aplicar a operação: '+h(close.rejection.motivo)+'. Confira a prévia atualizada.</p><button class="btn" data-ag-reopen>Revisar fechamento</button>');
    if(restore?.phase==='rejected')items.push('<p>O servidor recusou a restauração sem aplicar o backup: '+h(restore.rejection.motivo)+'. Os dados do navegador foram preservados.</p><button class="btn" data-ag-import>Selecionar backup novamente</button>');
    if(month&&month.phase!=='done')items.push('<p>Arquivamento mensal aguardando recuperação.</p><button class="btn" data-ag-recover="month">Recuperar arquivamento</button>');
    if(close&&['unknown','sending'].includes(close.telegram))items.push('<p>Envio do resumo ao Telegram sem confirmação. Confira no aplicativo antes de reenviar.</p><button class="btn ghost" data-ag-telegram>Reenviar resumo congelado</button>');
    if(schedule&&schedule.phase!=='done')items.push('<p>Cronograma salvo no navegador; envio pendente. '+h(schedule.motivo||'')+'</p><button class="btn ghost" data-ag-schedule>Conferir e tentar enviar</button>');
    el.hidden=!items.length;el.innerHTML=items.join('');
    if(pending()&&$('agHealth')&&!$('agHealth').textContent.includes('Recuperação pendente'))$('agHealth').textContent+=' · Recuperação pendente em Ajustes';
  }
  async function recover(kind){
    if(busy)return;busy=true;
    try{await saving;await exclusive(async()=>{const j=read(kind==='restore'?RESTORE:kind==='month'?MONTH:CLOSE);if(j)await(kind==='restore'?resumeRestore(j):kind==='month'?resumeMonth(j):resumeClose(j));});}catch(e){error(e);}finally{busy=false;renderRecovery();}
  }
  function install(){
    base=localStorage.getItem(KEY);
    $('agServerHost').textContent=new URL(SRV).host;
    conflict=!!root.agentumStorageError;
    scheduleBaseline=JSON.stringify(estado.cronograma);
    const legacyLive=renderAoVivo,legacyApply=aplicarEstado;
    AoVivo.resumo=finance;AoVivo.porConta=()=>finance().accounts;AoVivo.porCasa=()=>finance().por_casa;
    AoVivo.mapaFilhaMae=mapping;
    renderMedia=renderMediaNew;renderContaMae=renderMother;renderConferencia=renderComparison;
    renderIndicadoresAoVivo=()=>{};
    renderAoVivo=()=>{legacyLive();enhanceLive();};
    fecharCicloAoVivo=closePreview;fecharMes=archiveMonth;
    salvar=save;exportarBackup=exportBackup;importarBackup=importBackup;escreverArquivo=writeConnected;pollTelegram=pollTelegramSafe;
    aplicarEstado=j=>{
      if(!j||j.versao===undefined||!j.resumo||!Array.isArray(j.operacoes))throw Error('Estado do servidor inválido.');
      lastState=j;Estado.identidades=j.identidades||null;Estado.pedidos=Array.isArray(j.pedidos)?j.pedidos:[];Estado.instalacoes=Array.isArray(j.instalacoes)?j.instalacoes:[];
      Estado.ext_esperada=j.ext_esperada||{};Estado.ciclo_id=j.ciclo_id??j.resumo.ciclo_id;
      Estado.telemetria_versao=j.telemetria_versao;Estado.mapeamento_filha_mae=j.mapeamento_filha_mae||{};Estado.servidor=j.servidor||null;
      legacyApply(j);renderTracking();renderDiagnostics();if(root.AgentumIdentidades)root.AgentumIdentidades.render(j);if(root.AgentumPendentes)root.AgentumPendentes.render(j);if(root.AgentumJogos)root.AgentumJogos.render(j);if(root.AgentumMeta)root.AgentumMeta.render(j);if(root.AgentumVigia)root.AgentumVigia.render(j);
      const expected=j.ext_esperada||{},v=$('extVer');
      v.textContent='filha '+(j.ext_player||'—')+' · mãe '+(j.ext_mae||'—');
      const staleInstall=(j.instalacoes||[]).some(i=>Date.now()-new Date(i.ultimo_ping).getTime()<180000&&expected[i.tipo]&&i.versao!==expected[i.tipo]);
      const knownExpected=expected.player&&expected.mae,mismatch=staleInstall||knownExpected&&((j.ext_player&&j.ext_player!==expected.player)||(j.ext_mae&&j.ext_mae!==expected.mae));
      v.className='ext-ver '+(knownExpected&&!mismatch?'ok':'old');v.title='Versões esperadas informadas pelo servidor: filha '+(expected.player||'não informada')+' · mãe '+(expected.mae||'não informada');
      if(!recovered){recovered=true;renderRecovery();syncSchedule();}
    };
    pollEstado=()=>request('/api/estado').then(aplicarEstado).catch(()=>{Estado.conectado=false;setConn(false);enhanceLive();});
    $('agCloseAccept').addEventListener('change',e=>{$('agCloseConfirm').disabled=!e.target.checked;});
    $('agCloseCancel').addEventListener('click',()=>$('agClose').close());
    $('agDrawerClose').addEventListener('click',closeDrawer);
    $('agDrawer').addEventListener('close',()=>{if(drawerReturn?.isConnected)drawerReturn.focus();});
    $('agOrderList').addEventListener('click',e=>{const b=e.target.closest('[data-ag-order]');if(b)openOrder(Number(b.dataset.agOrder));});
    $('agRecovery').addEventListener('click',async e=>{
      const b=e.target.closest('button');if(!b)return;
      if(b.dataset.agRecover)recover(b.dataset.agRecover);
      if(b.hasAttribute('data-ag-reopen')){abrirAba('aovivo');closePreview();}
      if(b.hasAttribute('data-ag-import'))$('bkFile').click();
      if(b.hasAttribute('data-ag-reload')){clearTimeout(salvarTimer);location.reload();}
      if(b.hasAttribute('data-ag-draft')){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([sessionStorage.getItem('agentum_rascunho_conflito')||JSON.stringify(estado)],{type:'application/json'}));a.href=url;a.download='agentum-rascunho-conflito.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      if(b.hasAttribute('data-ag-telegram'))confirmar('O resumo pode já ter sido entregue. Reenviar o mesmo resumo congelado?',()=>sendFrozenTelegram(read(CLOSE),true),{ok:'Reenviar'});
      if(b.hasAttribute('data-ag-schedule'))reviewSchedule();
    });
    // Bloqueio de edição alcança os listeners antigos sem substituí-los.
    for(const event of ['click','input','change'])document.addEventListener(event,e=>{
      if(e.target.closest('#agRecovery,nav,.topbar,#agDrawer,#agClose,.modal-bg')||!e.target.closest('main'))return;
      if((conflict||pending())&&e.target.closest('button,input,select,textarea')&&!e.target.closest('#bkExport')){e.preventDefault();e.stopImmediatePropagation();toast('Conclua a recuperação em Ajustes antes de editar.');}
    },true);
    $('dias-grid').addEventListener('click',queueSchedule);
    $('dias-grid').addEventListener('keydown',e=>{if(e.key==='Enter')queueSchedule();});
    window.addEventListener('storage',e=>{
      if(e.key===KEY&&e.newValue!==base){conflict=true;sessionStorage.setItem('agentum_rascunho_conflito',JSON.stringify(estado));renderRecovery();toast('Dados alterados em outra janela. Confira Ajustes.');}
      if([CLOSE,RESTORE,SCHEDULE,MONTH].includes(e.key))renderRecovery();
      if(e.key==='aovivo_extra'){const x=read('aovivo_extra')||{};AoVivo.bau=x.bau??null;AoVivo.gerente=x.gerente??null;renderAoVivo();}
      if(e.key==='saqueManual')renderAoVivo();
    });
    window.addEventListener('online',syncSchedule);
    $('avTestar').textContent='Diagnóstico';$('avTestar').addEventListener('click',()=>abrirAba('ajustes'));
    testarCaptura=()=>{renderDiagnostics();abrirAba('ajustes');};
    renderRecovery();
  }
  function queueSchedule(){setTimeout(()=>{
    const raw=JSON.stringify(estado.cronograma);if(raw===scheduleBaseline)return;
    const old=read(SCHEDULE),before=scheduleRemote===null?JSON.parse(scheduleBaseline):scheduleRemote;scheduleBaseline=raw;
    journal(SCHEDULE,{phase:'pending',cronograma:clone(estado.cronograma),before:old?.phase==='pending'?old.before:clone(before),...(scheduleVersion!==null?{expected_versao:scheduleVersion}:{})});
    syncSchedule();
  },0);}
  async function mutation(path,body,accepted=['ok']){
    return exclusive(async()=>{
      ensureBase();if(pending())throw Error('Conclua a recuperação antes desta ação.');
      const result=await request(path,body);
      if(!accepted.includes(result.status))throw Error('O servidor não confirmou a ação.');
      return result;
    });
  }
  function refresh(){Estado.versao=null;return pollEstado();}
  function deleteOperation(ped,casa,conta){
    const candidates=(AoVivo.ops||[]).filter(o=>String(o.numero_pedido)===String(ped)&&(!casa||o.casa===casa)&&(!conta||o.conta===conta));
    if(candidates.length!==1){toast('Identifique a casa e a conta deste pedido antes de excluir.');return;}
    const o=candidates[0];
    confirmar('Excluir '+(o.tipo==='saque'?'saque':'depósito')+' '+fmt(o.valor)+' de '+casaLabel(o.casa)+' · conta '+o.conta+'? O histórico de meses fechados será preservado.',()=>{
      mutation('/api/operacao/excluir',{numero_pedido:o.numero_pedido,casa:o.casa,conta:o.conta},['ok','nao_encontrado']).then(r=>{toast(r.status==='ok'?'Operação excluída.':'A operação já não estava neste ciclo.');refresh();}).catch(error);
    },{ok:'Excluir operação',perigo:true});
  }
  function clearOperations(){
    confirmar('Limpar as operações capturadas do ciclo atual? Meses fechados e jogos serão preservados.',()=>mutation('/api/operacoes/limpar',{escopo:'operacoes'}).then(r=>{
      const n=count(r.removidos?.operacoes);if(n===null)throw Error('A quantidade removida não foi confirmada.');toast(n+(n===1?' operação removida.':' operações removidas.'));refresh();
    }).catch(error),{ok:'Limpar operações',perigo:true});
  }
  function scanWithdrawals(){
    // Escopo: só as casas da operação ao vivo ATIVA (o painel sabe qual está no card). Assim o botão
    // não navega abas de OUTRA operação — era o bug. Sem operação aberta, lista vazia = todas, como antes.
    let casas=[];
    try{ const s=(typeof casasDaOp==='function'&&typeof opAtivaAoVivo==='function')?casasDaOp(opAtivaAoVivo()):null; if(s&&s.size) casas=[...s]; }catch(e){}
    const alvo=casas.length?('nas casas desta operação ('+casas.length+')'):('em TODAS as abas abertas');
    confirmar('Conferir saques '+alvo+'? As abas serão direcionadas à página de saque para observar o histórico. A consulta depende da resposta de cada casa.',()=>mutation('/api/varrer_saque',{casas}).then(r=>{
      if(!known(r.ts))throw Error('A solicitação de conferência não foi identificada.');toast('Conferência solicitada. Acompanhe as respostas das abas.');refresh();
    }).catch(error),{ok:'Conferir nas abas'});
  }
  async function newCycle(onOk,onErr){
    try{await exclusive(async()=>{
      ensureBase();if(pending())throw Error('Conclua a recuperação antes de zerar o ciclo.');
      // nomear o ciclo que esta aberto e o que impede clique perdido, aba velha e reenvio de
      // virarem fechamento: o servidor recusa qualquer pedido que nao case com o ciclo atual
      const alvo=Estado.ciclo_id;
      if(!Number.isInteger(alvo))throw Error('Ciclo atual não confirmado pelo servidor. Nada foi zerado.');
      const r=await request('/api/ciclo/novo',{ciclo_id:alvo,confirmado:true});
      if(r.ok!==true||!Number.isInteger(r.ciclo))throw Error('O novo ciclo não foi confirmado. Confira o estado antes de repetir.');
      Estado.versao=null;Sync.alerta=false;if(onOk)onOk();await pollEstado();
    });}catch(e){error(e);if(onErr)onErr(e);}
  }
  async function reconcile(){
    try{
      const d=await request('/api/diagnostico'),r=finance(),wrap=$('avDiag');
      if(count(d.total_operacoes)===null||count(d.contas_distintas)===null||!Array.isArray(d.suspeitos))throw Error('Diagnóstico incompleto; contagens a confirmar.');
      // Compara o que o servidor tem no ciclo com o que o PAINEL conhece (a lista completa do ciclo), não
      // com o finance() — este é escopado pela operação ativa e gerava "contagens diferem" falso em
      // multi-operação (ex.: servidor 236 × painel 206).
      const lista=(typeof AoVivo!=='undefined'&&Array.isArray(AoVivo.ops))?AoVivo.ops:null;
      const total=lista?lista.length:null,same=total!==null&&total===d.total_operacoes;
      const escopo=(typeof window!=='undefined'&&window.aovivoEscopo)?window.aovivoEscopo():null;
      const ativa=escopo&&r.qd!==null&&r.qs!==null?'<br>Operação ativa (escopo do card): '+(r.qd+r.qs)+' operações.':'';
      wrap.innerHTML='<div class="ag-note"><b>Conferência dos registros conhecidos</b><p>Servidor: '+d.total_operacoes+' operações · '+d.contas_distintas+' contas.<br>Painel: '+(total??'a confirmar')+' operações.'+ativa+'</p><p>'+(!same?'As contagens diferem. Atualize e confira novamente.':d.suspeitos.length?'Há '+d.suspeitos.length+' registros que precisam de conferência.':'Contagens iguais. A cobertura das fontes continua parcial.')+'</p></div>';wrap.style.display='block';
      toast(same?'Registros conferidos · cobertura parcial.':'As contagens diferem. Confira o diagnóstico.');
    }catch(e){error(e);}
  }
  // Exclusao ja dispensada some da tela; a lapide continua no banco, entao nada volta ao livro.
  function visiveis(){
    const marca=lastState?.dispensados?.descartados||'';
    return (Estado.descartados||[]).map((p,i)=>({p,i})).filter(x=>!(marca&&String(x.p.ts||'')<=marca));
  }
  function renderDiscarded(){
    const list=visiveis();let el=$('avDescartados');
    if(!el){el=document.createElement('div');el.id='avDescartados';el.className='ag-note';$('avLogPainel').before(el);}
    el.hidden=!list.length;
    // Exclusao ja feita nao e pendencia: linha recolhida, com o desfazer a um clique.
    el.className='ag-note ag-recolhido';
    el.innerHTML=`<details><summary>${list.length} exclusão(ões) neste ciclo</summary><p>`+list.map(({p,i})=>`<button class="btn mini" data-ag-undo="${i}">Desfazer ${h(p.numero_pedido)} · ${h(p.conta||'conta a confirmar')}</button>`).join(' ')+' <button class="btn mini" data-ag-limpar-descartados="1">Limpar</button></p></details>';
    if(!el._wired){el._wired=true;el.addEventListener('click',e=>{
      if(e.target.closest('[data-ag-limpar-descartados]')){
        const ate=visiveis().map(x=>String(x.p.ts||'')).sort().pop();
        if(!ate)return;
        mutation('/api/dispensar',{tipo:'descartados',ate:ate}).then(()=>{toast('Exclusões antigas dispensadas. Nada volta ao livro; exclusões novas voltam a aparecer.');refresh();}).catch(error);
        return;
      }
      const b=e.target.closest('[data-ag-undo]');if(!b)return;const p=(Estado.descartados||[])[Number(b.dataset.agUndo)];if(!p)return;
      mutation('/api/operacao/restaurar',{numero_pedido:p.numero_pedido,casa:p.casa,conta:p.conta}).then(()=>{toast('Exclusão desfeita. O registro poderá retornar quando for observado novamente.');refresh();}).catch(error);
    });}
  }
  function renderPending(){
    const list=Estado.pendentes||[];let el=$('avPendentes');
    if(!el){el=document.createElement('div');el.id='avPendentes';el.className='ag-note';$('avLogPainel').before(el);}
    el.hidden=!list.length;
    const total=list.every(p=>cents(p.valor)!==null)?list.reduce((s,p)=>s+cents(p.valor),0)/100:null;
    el.innerHTML='<b>Depósitos aguardando confirmação</b><p>'+list.length+' registros · '+fmt(total)+'. Valores fora do resultado até confirmação.</p>'+list.map((p,i)=>`<div class="ag-pending-row"><span>${h(casaLabel(p.casa))} · conta ${h(p.conta||'a confirmar')} · ${h(fmt(p.valor))}</span><button class="btn mini" data-ag-pending="${i}" ${cents(p.valor)===null||!p.conta||!p.casa?'disabled':''}>Confirmar após conferir</button><button class="btn danger mini" data-ag-remove-pending="${i}">Encerrar pedido</button></div>`).join('');
    if(!el._wired){el._wired=true;el.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
      const i=b.dataset.agPending??b.dataset.agRemovePending,p=(Estado.pendentes||[])[Number(i)];if(!p)return;
      if(b.dataset.agPending!==undefined)confirmPending([p]);else removePending(p);
    });}
  }
  function confirmPending(list){
    if(!list?.length)return;
    if(list.some(p=>!p.casa||!p.conta||!p.numero_pedido||cents(p.valor)===null)){toast('Confira a identidade e o valor de cada depósito antes de confirmar.');return;}
    confirmar('Você conferiu a conclusão '+(list.length===1?'do depósito':'dos '+list.length+' depósitos')+' no histórico da casa? '+list.map(p=>p.numero_pedido+': '+fmt(p.valor)).join(' · '),async()=>{
      let completed=0;
      try{for(const p of list){await mutation('/api/operation',{tipo:'deposito',numero_pedido:p.numero_pedido,valor:p.valor,casa:p.casa,conta:p.conta,origem:'manual',estado:'confirmado'},['ok','duplicado','promovido','enriquecido']);completed++;}toast(completed+(completed===1?' depósito confirmado.':' depósitos confirmados.'));}
      catch(e){error(e);}finally{refresh();}
    },{ok:'Confirmar depósitos conferidos'});
  }
  function removePending(p){
    confirmar('Encerrar o acompanhamento do pedido '+p.numero_pedido+' de '+casaLabel(p.casa)+' · conta '+p.conta+'? Será registrado como encerrado manualmente.',()=>mutation('/api/pendente/remover',{numero_pedido:p.numero_pedido,casa:p.casa,conta:p.conta}).then(()=>{toast('Pedido encerrado manualmente.');refresh();}).catch(error),{ok:'Encerrar pedido'});
  }
  async function reviewSchedule(){
    try{const remote=await request('/api/cronograma'),j=read(SCHEDULE);if(!j||j.phase==='done')return;
      const line=x=>Object.entries(x||{}).filter(([d])=>/^[0-6]$/.test(d)).map(([d,n])=>DIAS[Number(d)]+': '+(n.join(', ')||'sem plataformas')+(x.lancamentos&&(x.lancamentos[d]||[]).length?' · lança: '+x.lancamentos[d].join(', '):'')).join('\n');
      confirmar('Versão salva neste navegador:\n'+line(j.cronograma)+'\n\nVersão no servidor:\n'+line(remote.cronograma)+'\n\nEnviar a versão deste navegador?',()=>{j.expected_versao=String(remote.versao);j.before=remote.cronograma;journal(SCHEDULE,j);syncSchedule();},{ok:'Enviar versão deste navegador'});
    }catch(e){error(e);}
  }
  let telegramBusy=false;
  // Saúde do Telegram visível em Ajustes: cada saída da captura e cada envio dizem POR QUÊ. Antes todas
  // as saídas eram silenciosas (token inválido, webhook ativo, rede, recuperação pendente) e o operador
  // só percebia que "o Telegram parou".
  const telegramSaude={captura:null,envio:null};
  const TG_COR={ativa:'#8fe9c4',ok:'#8fe9c4',pausada:'#e9c178',desligada:'#9db2c2',erro:'#ff9db0',falhou:'#ff9db0'};
  function tgSaude(tipo,estadoTg,motivo){telegramSaude[tipo]={estado:estadoTg,motivo,quando:new Date()};renderTelegramSaude();}
  function renderTelegramSaude(){
    const el=$('tgSaude');if(!el)return;
    const hora=d=>d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const linha=(rot,s)=>s?`<span style="color:${TG_COR[s.estado]||'inherit'}"><b>${h(rot)}:</b> ${h(s.estado)} — ${h(s.motivo)} <small>(${hora(s.quando)})</small></span>`:'';
    el.innerHTML=[linha('Captura de formulários',telegramSaude.captura),linha('Último envio',telegramSaude.envio)].filter(Boolean).join('<br>');
  }
  function journalPendente(){
    const nomes={[CLOSE]:'um fechamento de ciclo',[RESTORE]:'uma restauração de backup',[MONTH]:'um arquivamento de mês'};
    for(const k of [CLOSE,RESTORE,MONTH]){const j=read(k);if(j&&!terminal(j))return nomes[k];}
    return 'uma recuperação';
  }
  async function pollTelegramSafe(){
    const cfg=tgCfg();if(telegramBusy)return;
    const pausa=!cfg.capturar?['desligada','marque "Capturar formulários" para ativar']
      :(!cfg.token||!cfg.chatId)?['pausada','sem token ou chat id']
      :pending()?['pausada','há '+journalPendente()+' em andamento — conclua o aviso de recuperação no topo de Ajustes']
      :conflict?['pausada','o painel está com conflito de versão — recarregue a página']:null;
    if(pausa){tgSaude('captura',pausa[0],pausa[1]);return;}
    telegramBusy=true;
    try{await saving;await exclusive(async()=>{
      ensureBase();if(pending())return;const t=tgCfg(),memoryBefore=JSON.stringify(estado);
      const response=await fetch('https://api.telegram.org/bot'+t.token+'/getUpdates?timeout=0&offset='+((count(t.lastUpdateId)||0)+1)),j=await response.json().catch(()=>null);
      if(!response.ok||!j||!j.ok||!Array.isArray(j.result)){tgSaude('captura','erro','o Telegram recusou: '+((j&&j.description)||('HTTP '+response.status)));return;}
      ensureBase();if(memoryBefore!==JSON.stringify(estado))return;const before=clone(estado);let changed=false,recebidos=0;
      try{
        const updates=j.result.filter(u=>Number.isSafeInteger(u.update_id)).sort((a,b)=>a.update_id-b.update_id);
        for(const u of updates){
          if(u.update_id<=(count(t.lastUpdateId)||0))continue;
          const m=u.message; // edições não repetem comandos/formulários já recebidos
          if(m&&m.chat&&String(m.chat.id)===String(t.chatId)&&typeof m.text==='string'&&processarFormTelegram(m.text)){changed=true;recebidos++;}
          t.lastUpdateId=u.update_id;
        }
        // Formulário e offset são uma única escrita; uma queda não deixa só um deles salvo.
        commitState(clone(estado));if(changed)renderFormularios();
        tgSaude('captura','ativa','última verificação'+(recebidos?' · '+recebidos+(recebidos===1?' formulário recebido':' formulários recebidos'):''));
      }catch(e){estado=before;throw e;}
    });}catch(_){tgSaude('captura','erro','sem resposta do Telegram (rede) — tenta de novo em 15 s');/* Sem apagar offset nem dados quando a consulta falha. */}finally{telegramBusy=false;}
  }
  Object.assign(API,{pendentesDeArquivo,nomeMes,install,finance,preflight,makeBackup,validateBrowser,validateBank,telegramText,recover,request,periodText,compatible,healthText,syncSchedule,closePreview,archiveMonth,renderMedia:renderMediaNew,pollTelegram:pollTelegramSafe,exportBackup,importBackup,renderComparison,renderMother,motherViews,deleteOperation,clearOperations,scanWithdrawals,newCycle,reconcile,renderDiscarded,renderPending,confirmPending,removePending});
  API.registrarEnvioTelegram=(ok,motivo)=>tgSaude('envio',ok?'ok':'falhou',motivo||(ok?'entregue':'não confirmado'));
})(typeof window==='undefined'?globalThis:window);
