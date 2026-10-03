/* Identidade e saúde da leitura. Nenhuma gravação automática do estado do navegador. */
(function(root){
 'use strict';
 const $=id=>document.getElementById(id),h=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={aguardando_configuracao:'Preparando atualização',servidor_indisponivel:'Sem comunicação com o painel',fora_do_foco:'Atualização pausada pelo foco',casa_encerrada:'Casa encerrada',sem_sessao:'Sessão não identificada',pausado_manual:'Pausado — você está usando esta aba',periodo_nao_disponivel:'Filtro de período indisponível',periodo_desconhecido:'Período da resposta não confirmado',aguardando_resposta:'Aguardando relatório',sem_resposta:'Relatório não recebido',atualizado:'Leitura do período recebida',tentando_novamente:'Solicitando nova leitura',conta_alterada:'Conta alterada durante a leitura',fila_pendente:'Entrega pendente'};
 let state=null,signature='',preview=null;
 const fmt=value=>fmtBRL(value);
 const fail=e=>toast(e.message||'Não foi possível concluir.');
 // Nome bonito a partir de uma URL/host colado: p1-festapg.com -> p1-festapg (tira www e o .tld).
 const nomeDaUrl=txt=>{let s=String(txt||'').trim();if(!s)return '';
  if(/[./]/.test(s)){try{s=new URL(/^https?:/i.test(s)?s:'https://'+s).hostname;}catch(_){s=s.split('/')[0].split('?')[0];}
   s=s.replace(/^www\./,'').replace(/\.[a-z.]+$/i,'');}
  return s.trim();};
 // Host revela a plataforma (legível) ou é um cloudfront/hash opaco? p1-fornopg.com e exemplo.vip
 // são legíveis; d2j283p0n7ilt1.cloudfront.net (e rótulos tipo hash) não. Só os opacos viram "sem nome".
 const hostLegivel=host=>{
  host=String(host||'').toLowerCase();
  if(/\.(cloudfront\.net|amazonaws\.com|azureedge\.net|akamaized\.net|fastly\.net)$/.test(host))return false;
  const lbl=host.replace(/^www\./,'').split('.')[0];
  if(lbl.length>=12&&/\d/.test(lbl)&&!/-/.test(lbl))return false;   // rótulo tipo hash (sem hífen, com dígito)
  return true;
 };
 async function request(path,body){const r=await root.Agentum.request(path,body);await pollEstado();return r;}
 function install(){
  if($('agIdentityPanel'))return;
  // Casa dos blocos de casas/extensões = aba AJUSTES (manutenção). Antes ficavam no topo da Conta
  // Mãe e poluíam a operação. render() preenche pelos MESMOS ids, então nada mais muda.
  const target=$('agCasasHomeInner')||$('cmCasas');if(!target)return;
  const apend=node=>$('agCasasHomeInner')?target.append(node):target.before(node);
  // Estado das abas da mae (versao antiga, "Pausado", sem sessao) como secao IRMA, nao filha do
  // painel de diagnostico: dentro dele, a regra de ocultacao do visual escondia junto o unico
  // aviso com acao. O id nao muda, entao render() continua preenchendo o mesmo elemento.
  const transporte=document.createElement('section');transporte.id='agMotherTransport';transporte.className='ag-identity-panel';transporte.setAttribute('role','status');
  apend(transporte);
  const el=document.createElement('section');el.id='agIdentityPanel';el.className='ag-identity-panel';
  el.innerHTML='<details><summary>Identificação e atualização das casas</summary><p class="ag-caption">Os nomes são compartilhados pelo painel. A associação de origens exige conferência e pode ser desfeita.</p><div id="agHouseRegistry"></div><div class="ag-id-controls"><button class="btn mini" id="agUpdateAll">Atualizar todas as casas ativas</button></div></details>';
  apend(el);
  // Bloco proprio, separado do painel de diagnostico: aparece SO quando ha casa repetida a
  // resolver. Assim a tela continua limpa e mesmo assim da pra juntar mae e filha num clique.
  const sug=document.createElement('section');sug.id='agIdSugestoes';sug.className='ag-identity-panel';sug.hidden=true;
  apend(sug);
  const dialog=document.createElement('dialog');dialog.id='agIdentityPreview';dialog.className='ag-id-dialog';
  dialog.innerHTML='<h3>Conferir associação de origens</h3><div id="agIdentityImpact"></div><label><input type="checkbox" id="agIdentityAccept"> Conferi que estas origens pertencem à mesma casa.</label><div class="ag-id-controls"><button class="btn" id="agIdentityCancel">Cancelar</button><button class="btn" id="agIdentityConfirm" disabled>Confirmar associação</button></div>';
  document.body.append(dialog);
  $('agIdentityAccept').onchange=e=>$('agIdentityConfirm').disabled=!e.target.checked||!!preview?.conflitos?.length;
  $('agIdentityCancel').onclick=()=>dialog.close();
  $('agIdentityConfirm').onclick=async()=>{
   if(!preview||!$('agIdentityAccept').checked)return;
   $('agIdentityConfirm').disabled=true;
   try{await request('/api/casas/associar',{origem:preview.origem,destino:preview.destino,token:preview.token,confirmado:true});dialog.close();toast('Origens associadas. Valores e pedidos preservados.');}
   catch(e){fail(e);preview=null;$('agIdentityImpact').textContent='A associação não foi concluída. Feche e gere uma nova prévia.';}
  };
  $('agUpdateAll').onclick=()=>confirmar('Permitir a atualização automática de todas as casas ativas? As casas encerradas continuarão pausadas.',()=>request('/api/foco',{casas:[]}).catch(fail),{ok:'Atualizar todas'});
  async function abrirPrevia(origem,destino){
   preview=await root.Agentum.request('/api/casas/previa',{origem:origem,destino:destino});
   $('agIdentityImpact').innerHTML='<p><b>'+h(preview.chaves_origem.join(', '))+'</b> → <b>'+h(preview.chaves_destino.join(', '))+'</b></p><p>'+h(preview.operacoes)+' operações históricas · depósitos '+h(fmt(preview.depositos))+' · saques '+h(fmt(preview.saques))+'</p><p>'+h(preview.efeito)+'</p><p>Foco envolvido: '+h(preview.foco_afetado.join(', ')||'nenhum')+'. Encerradas: '+h(preview.encerradas_afetadas.join(', ')||'nenhuma')+'.</p><p>Um backup local será criado antes da associação.</p>'+preview.conflitos.map(x=>'<p class="ag-id-warning">'+h(x)+'</p>').join('');
   const origins=document.createElement('p');origins.textContent='Origens observadas: '+Object.entries(preview.origens_observadas||{}).map(([k,v])=>k+': '+(v.map(o=>o.host+' ('+(o.papel==='mae'?'mãe':'filhas')+')').join(', ')||'a confirmar')).join(' · ')+'. Pedidos acompanhados: '+(preview.pedidos_acompanhados||0)+'.';$('agIdentityImpact').append(origins);
   $('agIdentityAccept').checked=false;$('agIdentityConfirm').disabled=true;dialog.showModal();
  }
  const aoClicar=async e=>{
   const b=e.target.closest('button');if(!b)return;
   try{
    if(b.dataset.idRename){const house=state.identidades.casas.find(c=>c.id===b.dataset.idRename);const value=prompt('Nome da casa no painel',casaLabel(house.chaves[0]));if(value===null||!value.trim())return;await request('/api/casas/nome',{id:house.id,nome:value.trim()});renderTudo();}
    // "Salvar nome" da caixa Casas sem nome: pega a URL bonita colada e usa o nome dela (só renomeia).
    if(b.dataset.semnomeSave){const inp=document.querySelector('#cmSemNome input[data-semnome-id="'+b.dataset.semnomeSave+'"]');const nome=nomeDaUrl(inp&&inp.value);if(!nome){toast('Cole a URL bonita da casa (ex.: p1-festapg.com).');return;}await request('/api/casas/nome',{id:b.dataset.semnomeSave,nome:nome});toast('Nome salvo: '+nome);renderTudo();return;}
    if(b.id==='agPrepareIdentity')await abrirPrevia($('agIdFrom').value,$('agIdTo').value);
    // sugestao clicada: abre a MESMA previa conferida, com o par ja escolhido
    if(b.dataset.idPair){const par=b.dataset.idPair.split('|');await abrirPrevia(par[0],par[1]);}
    if(b.dataset.idUndo)confirmar('Desfazer esta associação de identidades? Os pedidos e valores permanecem preservados.',()=>request('/api/casas/desfazer',{id:b.dataset.idUndo}).catch(fail),{ok:'Desfazer associação'});
    // "Limpar" so tira da tela: a associacao continua valendo e o historico continua no servidor.
    if(b.dataset.idLimpar)confirmar('Tirar da tela as associações já feitas? Elas continuam valendo; o desfazer sai desta caixa e associações novas voltam a aparecer.',()=>request('/api/dispensar',{tipo:'identidades',ate:b.dataset.idLimpar}).catch(fail),{ok:'Limpar'});
   }catch(err){fail(err);}
  };
  el.addEventListener('click',aoClicar);sug.addEventListener('click',aoClicar);
  // Caixa "Casas sem nome" vive na aba Conta Mãe (elemento estático): clique e Enter salvam o nome.
  const semNomeEl=$('cmSemNome');
  if(semNomeEl){
   semNomeEl.addEventListener('click',aoClicar);
   semNomeEl.addEventListener('keydown',e=>{if(e.key!=='Enter'||!e.target.matches('input[data-semnome-id]'))return;const btn=semNomeEl.querySelector('[data-semnome-save="'+e.target.dataset.semnomeId+'"]');if(btn)btn.click();});
  }
 }
 function render(s){
  state=s;install();if(!$('agIdentityPanel'))return;
  const installs=(s.instalacoes||[]).filter(i=>Date.now()-new Date(i.ultimo_ping).getTime()<180000);
  const mothers=installs.filter(i=>i.tipo==='mae'),old=installs.filter(i=>s.ext_esperada?.[i.tipo]&&i.versao!==s.ext_esperada[i.tipo]);
  const slots=mothers.flatMap(i=>(i.slots||[]).filter(x=>Date.now()-new Date(x.diagnosticado_em).getTime()<180000));
  const focus=s.foco?.length?'Atualização automática limitada às casas selecionadas.':'Atualização automática permitida para as casas ativas.';
  $('agMotherTransport').innerHTML='<b>Atualização das casas</b><p>'+h(focus)+'</p>'+(old.length?'<p class="ag-id-warning">'+old.length+' instalação(ões) com versão anterior. Pacotes atuais: filhas '+h(s.ext_esperada.player)+' · mãe '+h(s.ext_esperada.mae)+'. Recarregue a extensão e as abas desse navegador.</p>':'')+(!mothers.length?'<p>Sem sinal recente da extensão Conta Mãe.</p>':!slots.length?'<p>Extensão conectada; aguardando comunicação das abas.</p>':'<ul>'+slots.map(x=>'<li><strong>'+h(casaLabel(x.casa))+'</strong><span>'+h(labels[x.estado]||'Estado da leitura a confirmar')+'</span><small>'+h(x.ultima_resposta?'Última resposta: '+new Date(x.ultima_resposta).toLocaleTimeString('pt-BR'):'Nenhuma resposta identificada nesta aba')+'</small></li>').join('')+'</ul>');
  const data=s.identidades;if(!data)return;
  // a marca de "limpar" entra na assinatura: sem isso dispensar nao redesenhava a caixa
  // Casas sem nome (Conta Mãe) renderiza SEMPRE — fora do guard do registro, senão não atualizava
  // quando o foco estava no registro. Tem proteção própria contra apagar o campo enquanto digita.
  renderSemNome(data);
  const sig=JSON.stringify([data,s.dispensados?.identidades||'']);if(sig===signature||$('agHouseRegistry').contains(document.activeElement))return;signature=sig;
  const houses=data.casas||[];
  // Dizer QUAIS casas parecem repetidas. Antes so aparecia a contagem, e achar o par nos dois
  // seletores era trabalho manual — com mae e filha em dominios diferentes, ninguem adivinhava.
  const nomeDe=id=>{const c=houses.find(x=>x.id===id);if(!c)return '?';
   const ap=data.apelidos||{},k=(c.chaves||[]).find(x=>ap[x]);
   return k?ap[k]:(c.nome||casaLabel(c.chaves[0]));};
  // O CARD DE META manda. Ele diz "esta casa é a P2 e o link de hoje é X". Como a URL vira toda
  // semana (o cronograma lança P2 no domingo e na quinta), o host sozinho nunca serve de âncora:
  // o nome do card é a âncora, e o host é só o apelido da vez. A detecção por conta em comum
  // continua existindo, mas como REDE — só entra no que o card não cobriu.
  const hostDe=link=>{try{return new URL(/^https?:/i.test(link)?link:'https://'+link).hostname.replace(/^www\./,'').toLowerCase();}catch(_){return '';}};
  const cards=(()=>{const out=[];try{((root.estado&&root.estado.plataformas)||[]).forEach(p=>{const u=hostDe(p&&p.link);if(u&&p&&p.plataforma)out.push({host:u,nome:String(p.plataforma)});});}catch(_){}return out;})();
  const casaDoHost=u=>houses.find(c=>(c.origens||[]).some(o=>o.host===u));
  const casaDoNome=n=>houses.find(c=>String(c.nome||'').toUpperCase()===n.toUpperCase()||(c.chaves||[]).some(k=>String(k).toUpperCase()===n.toUpperCase()));
  const vistos={},propostas=[],parDe=(a,b)=>[a,b].sort().join('|');
  cards.forEach(m=>{
   const daUrl=casaDoHost(m.host),doNome=casaDoNome(m.nome);
   if(!daUrl||!doNome||daUrl.id===doNome.id)return;
   const k=parDe(daUrl.id,doNome.id);if(vistos[k])return;vistos[k]=1;
   propostas.push({origem:daUrl.id,destino:doNome.id,forte:true,motivo:'card de meta: '+m.host+' é '+m.nome});
  });
  (data.candidatos||[]).forEach(k=>{
   const p=parDe(k.origem,k.destino);if(vistos[p])return;vistos[p]=1;
   propostas.push({origem:k.origem,destino:k.destino,forte:false,
    motivo:k.contas?k.contas+' conta(s) em comum entre mãe e filha':'mesmo domínio: '+[].concat(k.hosts||[]).join(', ')});
  });
  // Sugestão de JUNTAR casas desativada a pedido do operador (não quer associação): redes são só o
  // prefixo (p1/p2/p4/11/18) e cada plataforma é uma casa própria. Fica só o renomear/desfazer.
  const sugestoes='';void propostas;void nomeDe;
  const options=houses.map(c=>'<option value="'+h(c.id)+'">'+h(casaLabel(c.chaves[0]))+' · '+h(c.chaves.join(', '))+'</option>').join('');
  const caixa=$('agIdSugestoes');
  if(caixa){
   // "Desfazer associacao" tambem aqui: dentro de #agIdentityPanel (oculto) ninguem alcancava.
   // Mas associacao ja feita e assunto encerrado: fica recolhida numa linha, sem moldura de caixa,
   // e so abre quando o operador precisa desfazer. Antes ocupava a tela para sempre.
   // Associacao dispensada some da tela; o historico continua inteiro no servidor.
   const marca=s.dispensados?.identidades||'';
   const feitas=(data.historico||[]).filter(e=>!e.desfeito&&!(marca&&String(e.quando||'')<=marca)).slice(-3).reverse();
   const desfazer=feitas.map(e=>'<span>'+h(e.chaves.join(' · '))+' <button class="btn mini" data-id-undo="'+h(e.id)+'">Desfazer associação</button></span>').join(' ')
    +(feitas.length?' <button class="btn mini" data-id-limpar="'+h(feitas.map(e=>String(e.quando||'')).sort().pop())+'">Limpar</button>':'');
   caixa.hidden=!(sugestoes||desfazer);
   caixa.classList.toggle('ag-id-discreto',!sugestoes);
   caixa.innerHTML=(sugestoes?'<b>Casas possivelmente repetidas</b><p>Mãe e filha da mesma casa entram com nomes diferentes quando o domínio muda. Confira e junte — nada é associado automaticamente.</p><div class="ag-id-list">'+sugestoes+'</div>':'')
    +(desfazer?'<details class="ag-id-feitas"><summary>'+feitas.length+' associação(ões) de casas já feitas</summary><p class="ag-caption">'+desfazer+'</p></details>':'');
  }
  $('agHouseRegistry').innerHTML='<div class="ag-id-list">'+houses.map(c=>'<div><strong>'+h(casaLabel(c.chaves[0]))+'</strong><small>'+h(c.chaves.join(' · '))+(c.origens.length?' — '+h([...new Set(c.origens.map(o=>o.host))].join(', ')):' — origem ainda não observada')+'</small><button class="btn mini" data-id-rename="'+h(c.id)+'">Editar nome</button></div>').join('')+'</div>'+(houses.length>1?'<div class="ag-id-controls"><label>Origem<select id="agIdFrom">'+options+'</select></label><label>Associar a<select id="agIdTo">'+options+'</select></label><button class="btn mini" id="agPrepareIdentity">Conferir associação</button></div>':'')+(sugestoes?'<p class="ag-id-warning">Estas casas parecem ser a mesma e aguardam sua conferência. Nada foi associado automaticamente.</p><div class="ag-id-list">'+sugestoes+'</div>':'')+(data.ambiguas.length?'<p>Vínculo mãe–filha a confirmar: '+h(data.ambiguas.map(casaLabel).join(', '))+'.</p>':'')+data.historico.filter(e=>!e.desfeito).slice(-10).reverse().map(e=>'<p>'+h(e.chaves.join(' · '))+' <button class="btn mini" data-id-undo="'+h(e.id)+'">Desfazer associação</button></p>').join('');
  if($('agIdTo')&&houses.length>1)$('agIdTo').selectedIndex=1;
 }
 // CASAS SEM NOME (na aba Conta Mãe): domínio cloudfront/hash que não revela a plataforma. O
 // operador cola a URL bonita e o painel usa o nome dela (só renomeia, não junta nada).
 function renderSemNome(data){
  const alvo=$('cmSemNome');if(!alvo)return;
  if(alvo.contains(document.activeElement))return;   // não apaga o campo enquanto o operador digita
  const houses=(data&&data.casas)||[],ap=(data&&data.apelidos)||{};
  const semNome=houses.filter(c=>{
   const origens=c.origens||[];
   const hosts=origens.map(o=>o.host).filter(Boolean);
   if(!hosts.length)return false;                    // sem captura ainda: não é "cloudfront", ignora
   if(!origens.some(o=>o.papel==='player'))return false; // só LANÇAMENTO (filha); mãe-só cloudfront não entra
   if(hosts.some(hostLegivel))return false;           // já tem domínio que mostra a plataforma
   if((c.chaves||[]).some(k=>ap[k]))return false;     // já nomeada manualmente
   return true;
  });
  if(!semNome.length){alvo.hidden=true;alvo.innerHTML='';return;}
  alvo.hidden=false;
  alvo.innerHTML='<div class="painel cm-semnome"><h3>Casas sem nome <span class="hint">— o domínio não mostra a plataforma</span></h3>'
   +'<p class="ag-caption">O endereço é um cloudfront/código. Cole a URL bonita da casa (ex.: <code>p1-festapg.com</code>) e o painel usa o nome dela. Só dá nome — não junta nada.</p>'
   +semNome.map(c=>{
     const hosts=[...new Set((c.origens||[]).map(o=>o.host).filter(Boolean))].join(', ');
     return '<div class="cm-sn-linha"><div class="cm-sn-quem"><strong>'+h(casaLabel(c.chaves[0]))+'</strong><small>'+h(hosts)+'</small></div>'
      +'<input class="cm-sn-input" data-semnome-id="'+h(c.id)+'" placeholder="cole a URL bonita (ex.: https://p1-festapg.com)">'
      +'<button class="btn mini" data-semnome-save="'+h(c.id)+'">Salvar nome</button></div>';
   }).join('')+'</div>';
 }
 root.AgentumIdentidades={render};
})(window);
