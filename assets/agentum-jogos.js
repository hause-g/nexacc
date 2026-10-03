/* Menu de jogos — fichas em relevo embaixo da Conta Mãe.
   O lobby nao tem URL por jogo (fica sempre em /home/embedded) e o jogo roda num iframe da PG Soft
   com token efemero: link salvo nao serve. O botao pede o launch na aba que ja esta logada, mesmo
   padrao do "Varrer saques". Enquanto a receita do pedido nao estiver aprendida, a ficha diz isso
   em vez de fingir que funciona. */
(function (root) {
 'use strict';
 const $ = id => document.getElementById(id);
 const h = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 // id do launch = 2000000 + id do jogo na PG Soft. Provado duas vezes por caminho independente:
 // gem-saviour (iframe /2/ + launch 2000002) e fortune-tiger (arquivo /126/ + launch 2000126).
 // Os outros quatro saem da ordem de clique, identica nas quatro casas.
 const CATALOGO = [
  {id: '2000002', nome: 'Gem Saviour',    simbolo: '\u{1F48E}'},
  {id: '2001007', nome: 'Fortune Rabbit', simbolo: '\u{1F430}'},
  {id: '2000098', nome: 'Fortune Ox',     simbolo: '\u{1F402}'},
  {id: '2000068', nome: 'Fortune Mouse',  simbolo: '\u{1F42D}'},
  {id: '2000126', nome: 'Fortune Tiger',  simbolo: '\u{1F42F}'},
  {id: '2000039', nome: 'Fortune Pig',    simbolo: '\u{1F437}'}
 ];
 // Simbolo por jogo: os populares ganham emoji proprio; o resto, ficha generica de cassino.
 const EMOJI = {
  '2000002':'\u{1F48E}','2001007':'\u{1F430}','2000098':'\u{1F402}','2000068':'\u{1F42D}',
  '2000126':'\u{1F42F}','2000039':'\u{1F437}','2001066':'\u{1F40E}','2001046':'\u{1F40D}',
  '2001027':'\u{1F409}','2000089':'\u{1F431}','2000042':'\u{1F418}','2000087':'\u{1F3FA}',
  '2000057':'\u{1F95A}','2000104':'\u{1F335}','2000075':'\u{1F418}','2000074':'\u{1F004}',
  '2000065':'\u{1F004}','2000073':'\u{1F4D6}','2000071':'\u{1F4B0}','2000108':'\u{1F403}'
 };
 // O catalogo vem do servidor (semeado do listPlatformGameV2, 164 jogos com nome oficial); os 6
 // fixos acima sao so reserva se o servidor ainda nao tiver o catalogo. Launch e deterministico:
 // abre por id, nao precisa 'reconhecer' antes.
 // Capa oficial do jogo, servida pelo PROPRIO servidor local (/api/capa) — ele busca no CDN da casa
 // uma vez e guarda em disco. Assim o painel nunca fala com host externo (mantem o isolamento que os
 // testes exigem) e ainda mostra a arte real, 300x400. onerror no <img> cai na ficha com emoji.
 function capaDoJogo(id) { const n = String(id == null ? '' : id).replace(/\D/g, ''); return n ? '/api/capa?id=' + n : ''; }
 function catalogoAtual(estado) {
  const cat = estado && Array.isArray(estado.jogos_catalogo) ? estado.jogos_catalogo : null;
  if (!cat || !cat.length) return CATALOGO;
  return cat.map(j => ({id: String(j.id), nome: String(j.nome || j.id), simbolo: EMOJI[String(j.id)] || '\u{1F3B0}', destaque: !!j.destaque}));
 }
 // Aba propria (menu lateral, logo abaixo de Conta Mae): a pagina JA e a dos jogos, entao nasce
 // aberta. O recolher continua, para quem quiser ver so o ranking.
 const LEMBRAR = 'agentum_jogos_casas';
 const rotulo = c => (root.casaLabel ? root.casaLabel(c) : c);
 let aberto = true, assinatura = '', ofertadasAgora = [];
 let filtro = '', ultimoEstado = null;
 let escolhidas = new Set();
 try { const g = JSON.parse(localStorage.getItem(LEMBRAR) || '[]'); if (Array.isArray(g)) escolhidas = new Set(g); } catch (_) {}

 function instalar() {
  if ($('agJogos')) return true;
  const alvo = $('jgAncora');
  if (!alvo) return false;
  const secao = document.createElement('section');
  secao.id = 'agJogos';
  secao.className = 'gj';
  secao.setAttribute('data-open', '1');
  secao.innerHTML =
   '<div class="gj-card">' +
    '<button class="gj-head" id="agJogosHead" aria-expanded="true" aria-controls="agJogosBody">' +
     '<span class="gj-mark">\u{1F3B0}</span>' +
     '<span class="gj-t"><b>Jogos</b><small id="agJogosSub">abre na aba que já está logada</small></span>' +
     '<span class="gj-chev" aria-hidden="true">▼</span>' +
    '</button>' +
    '<div class="gj-casas" id="agJogosCasas"></div>' +
    '<div class="gj-busca"><input id="agJogosBusca" type="search" placeholder="Buscar jogo pelo nome\u2026" autocomplete="off" spellcheck="false"></div>' +
    '<div class="gj-body" id="agJogosBody"></div>' +
    '<div class="gj-live" id="agJogosLive" role="status"></div>' +
    '<div class="gj-foot" id="agJogosFoot"></div>' +
   '</div>';
  alvo.append(secao);
  $('agJogosHead').addEventListener('click', () => {
   aberto = !aberto;
   secao.setAttribute('data-open', aberto ? '1' : '0');
   $('agJogosHead').setAttribute('aria-expanded', aberto ? 'true' : 'false');
  });
  $('agJogosCasas').addEventListener('change', e => {
   const cx = e.target.closest('input[data-casa]');
   if (!cx) return;
   if (cx.checked) escolhidas.add(cx.dataset.casa); else escolhidas.delete(cx.dataset.casa);
   try { localStorage.setItem(LEMBRAR, JSON.stringify([...escolhidas])); } catch (_) {}
   const marcadas = ofertadasAgora.filter(c => escolhidas.has(c.id)).map(c => c.nome);
   $('agJogosLive').textContent = marcadas.length
    ? 'Vai abrir em: ' + marcadas.join(' · ')
    : 'Nenhuma casa marcada — marque ao menos uma para o botão ter onde abrir.';
  });
  $('agJogosBusca').addEventListener('input', e => {
   filtro = String(e.target.value || '').trim().toLowerCase();
   render(ultimoEstado);
  });
  $('agJogosBody').addEventListener('click', e => {
   const b = e.target.closest('[data-jogo]');
   if (!b) return;
   const jogo = catalogoAtual(ultimoEstado).find(j => j.id === b.dataset.jogo);
   if (!jogo) return;
   const vivo = $('agJogosLive');
   const alvos = ofertadasAgora.filter(c => escolhidas.has(c.id));
   if (!alvos.length) {
    vivo.innerHTML = '<b>' + h(jogo.simbolo + ' ' + jogo.nome) + '</b> — marque ao menos uma casa.';
    return;
   }
   // a ficha e por CASA, mas a aba se reconhece pela CHAVE: manda todas as chaves da casa
   const chaves = [...new Set(alvos.flatMap(c => c.chaves))];
   // nao prometer "abriu": quem abre e a aba, e ela pode nao conseguir. O desfecho volta no aviso.
   vivo.innerHTML = '<b>' + h(jogo.simbolo + ' ' + jogo.nome) + '</b> — pedido enviado para ' + h(alvos.map(c => c.nome).join(' · ')) + '. A aba abre em alguns segundos; se não abrir, aparece o motivo no Ao Vivo.';
   root.Agentum.request('/api/abrir_jogo', {casas: chaves, id_jogo: jogo.id})
    .catch(e => { vivo.innerHTML = '<b>Não consegui pedir:</b> ' + h(e.message || 'servidor não respondeu'); });
  });
  return true;
 }

 // As casas do menu saem das METAS INICIADAS: e o operador dizendo quais esta rodando agora.
 // Casar pelo texto da plataforma ("P2 GAITA", "11  bolhapg") contra as chaves que o servidor
 // conhece, por palavra inteira — "p4" nao pode casar dentro de outra palavra.
 // Nome oficial da casa: a chave que PREFIXA os hosts observados dela. A casa "TECIDO" tem os
 // hosts p2-gaitapg.com e p2-tecidopg.com, entao ela e a P2 — "tecido" e so o pedaco do meio
 // do dominio, que virou chave por acidente de captura.
 // Jogo e coisa de FILHA. O host sem prefixo (barrilpg.com, bolhapg.com, listrapg.com) e sempre
 // da mae; a filha e <casa>-<nome>pg.com. Casa que so tem origem de mae — como a "BARRIL", que e o
 // lado mae da P4 — nao tem jogo para abrir e nao entra no menu. Casa sem origem nenhuma fica:
 // nao da para afirmar o que nao foi observado.
 function temFilha(casa) {
  const origens = casa.origens || [];
  return !origens.length || origens.some(o => o.papel === 'player');
 }
 function nomeOficial(casa) {
  // Nome UNICO em todas as telas: delega ao casaLabel do painel (nome de lancamento p1-fornopg +
  // override manual do operador). So cai no calculo local (prefixo por host) se casaLabel nao existir.
  const chave = (casa.chaves || [])[0];
  if (root.casaLabel && chave != null) { const n = root.casaLabel(chave); if (n) return n; }
  const origens = casa.origens || [];
  const daFilha = origens.filter(o => o.papel === 'player');
  const hosts = (daFilha.length ? daFilha : origens).map(o => String(o.host || '').toLowerCase());
  let melhor = '', pontos = -1;
  (casa.chaves || []).forEach(k => {
   const c = String(k).toLowerCase();
   const quantos = hosts.filter(hst => hst === c || hst.startsWith(c + '-') || hst.startsWith(c + '.')).length;
   if (quantos > pontos || (quantos === pontos && c.length < melhor.length)) { melhor = c; pontos = quantos; }
  });
  return (melhor || (casa.chaves || [])[0] || '').toUpperCase();
 }
 // Uma ficha por CASA, nao por chave: a mesma casa aparecia duas vezes com o mesmo rotulo.
 function casasOperando(servidor) {
  // `estado` do painel e um `let` de script classico: vive no escopo lexico global, nao em window
  const local = (typeof estado !== 'undefined' && estado) || {};
  const iniciadas = Array.isArray(local.metasAoVivo) ? local.metasAoVivo : (local.metaAoVivo ? [local.metaAoVivo] : []);
  const metas = Array.isArray(local.operacoes) ? local.operacoes : [];
  const conhecidas = ((servidor.identidades && servidor.identidades.casas) || []);
  const achadas = new Map();
  const filhas = conhecidas.filter(temFilha);
  const registra = casa => achadas.set(casa.id, {id: casa.id, nome: nomeOficial(casa), chaves: (casa.chaves || []).slice()});
  iniciadas.forEach(id => {
   const m = metas.find(o => o.id === id && !o.ok);
   if (!m) return;
   // Vínculo EXPLÍCITO gravado na meta (m.casaChave) vence o re-adivinhar do nome: fica estável
   // mesmo se o operador mudar o rótulo/pessoa da plataforma. Só cai no casarPlataforma se a meta
   // não tem vínculo ou a chave gravada não bate mais com nenhuma filha conhecida.
   vinculoDaMeta(m, filhas).forEach(registra);
  });
  return [...achadas.values()].sort((a, b) => (a.nome < b.nome ? -1 : 1));
 }
 // Casa(s) da meta: o vínculo gravado (m.casaChave) vence o nome — EXCETO quando o gravado é só uma
 // rede/chave legada sem hífen ("11") e o nome da meta aponta UMA casa de domínio de lançamento
 // (11-gatinhopg). Em 24/09 a OP 2 "11 GATINHOPG" gravou "11" (casa legada 11/bolha) ao iniciar, e o
 // vínculo passou a vencer para sempre: os 14 depósitos da gatinho nunca entravam na operação.
 function vinculoDaMeta(m, casas) {
  if (!m) return [];
  const lista = Array.isArray(casas) ? casas : [];
  const chave = String(m.casaChave || '').toLowerCase();
  const vinc = chave ? lista.find(c => (c.chaves || []).some(k => String(k).toLowerCase() === chave)) : null;
  if (vinc && chave.indexOf('-') >= 0) return [vinc];
  const peloNome = casarPlataforma(m.plataforma, lista);
  if (vinc) {
   const lancamento = peloNome.length === 1 && (peloNome[0].chaves || []).some(k => String(k).indexOf('-') >= 0);
   return lancamento && peloNome[0].id !== vinc.id ? peloNome : [vinc];
  }
  return peloNome;
 }
 // Casa(s) cujo domínio de lançamento bate com a plataforma da meta. Prefere o domínio INTEIRO
 // (p1-casinhapg) ao match por PALAVRA — sem isso "p1-casinhapg" virava ['p1','casinhapg'] e o
 // "p1" casava com o BLOB da rede (chave "p1", que junta lançamentos diferentes) em vez da própria
 // casa p1-casinhapg; o card lia o depósito da chave "p1" (velha) e ignorava o novo (não sincronizava).
 // Pura (sem DOM) — o teste meta_casa_dominio.cjs a extrai e valida.
 function casarPlataforma(plataforma, filhas) {
  const plat = String(plataforma || '').toLowerCase().trim();
  const lista = Array.isArray(filhas) ? filhas : [];
  // Normaliza um pedaço a "rede-plataforma", sem protocolo/www/.tld e sem o sufixo "pg":
  // https://p4-modelopg.com, p4-modelopg, p4-modelo  ->  "p4-modelo".
  const norm = s => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
    .split(/[\/?#]/)[0].split('.')[0].replace(/pg$/, '');
  // O nome da meta é TEXTO LIVRE: o operador põe o domínio + um RÓTULO (nome da pessoa) em qualquer
  // ordem ("p4-modelopg ROTULO1", "ROTULO1 p4-modelopg", "p1-casinha rotulo2") e às vezes sem o "pg".
  // Testa CADA token contra as chaves das casas (ignorando pg/tld), em qualquer posição.
  const tokens = plat.split(/\s+/).filter(Boolean);
  const casaPorToken = function (pred) {
    for (var i = 0; i < tokens.length; i++) {
      var tn = norm(tokens[i]); if (!tn) continue;
      var achou = lista.filter(function (c) { return (c.chaves || []).some(function (k) { return norm(k) === tn && pred(k); }); });
      if (achou.length) return achou;
    }
    return null;
  };
  // 1) token que casa um DOMÍNIO DE LANÇAMENTO inteiro (chave com hífen: p4-modelopg) — vence sobre a
  //    rede solta, então um rótulo ou um "p4"/"p1" perdido não rouba o match da casa certa.
  // 2) senão, token que casa QUALQUER chave (inclui a rede/blob legado: p4, p1, 11).
  var hifen = function (k) { return String(k).indexOf('-') >= 0; };
  // 1b) "REDE PLATAFORMA" com espaço vale como o domínio: "11 GATINHOPG" -> 11-gatinhopg. E um erro
  //     de UMA letra na plataforma ("11 GATINHOPG", 24/09) ainda acha a casa, desde que a rede seja a
  //     mesma, a plataforma tenha 5+ letras e só UMA casa sirva. Antes disso o "11" solto caía no
  //     passo 2 e pegava a casa legada 11/bolha — a OP 2 ficava zerada com os depósitos na gatinho.
  var dist1 = function (a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
  };
  var dominioAproximado = function () {
    var cands = [];
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].indexOf('-') >= 0) cands.push(norm(tokens[i]));
      if (i + 1 < tokens.length && tokens[i].indexOf('-') < 0) cands.push(norm(tokens[i] + '-' + tokens[i + 1]));
    }
    for (var e = 0; e < 2; e++) {
      for (var j = 0; j < cands.length; j++) {
        var cn = cands[j], p = cn.indexOf('-'); if (p < 0) continue;
        var rede = cn.slice(0, p), resto = cn.slice(p + 1);
        var achou = lista.filter(function (c) { return (c.chaves || []).some(function (k) {
          if (!hifen(k)) return false;
          var kn = norm(k), q = kn.indexOf('-');
          if (kn.slice(0, q) !== rede) return false;
          return e === 0 ? kn === cn : (resto.length >= 5 && dist1(kn.slice(q + 1), resto));
        }); });
        if (achou.length === 1 || (e === 0 && achou.length)) return achou;
      }
    }
    return null;
  };
  var alvo = casaPorToken(hifen) || dominioAproximado() || casaPorToken(function () { return true; });
  // 3) fallback por PALAVRA (rede/legado) quando nenhum token casou um domínio.
  if (!alvo) { var palavras = plat.split(/[^a-z0-9]+/).filter(Boolean); alvo = lista.filter(function (c) { return (c.chaves || []).some(function (k) { return palavras.indexOf(String(k).toLowerCase()) >= 0; }); }); }
  // 4) nome da plataforma escrito SEPARADO e com acento, numa rede de domínio numerado: "EXEMPLO CAFÉ"
  //    -> "exemplocafe" casa exemplocafe8.com (01/10: a rede troca o número do domínio; a OP da EXEMPLO ficou
  //    sem os depósitos da exemplocafe8). Prefere a casa de JOGADOR à mãe (exemplocafe.win) de mesmo nome.
  //    Junta palavras VIZINHAS (a mais longa primeiro), então um rótulo junto ("EXEMPLO CAFÉ jpcf") não atrapalha.
  if (!alvo || !alvo.length) {
   var pal = plat.normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).map(function (t) { return t.replace(/[^a-z0-9]/g, ''); }).filter(Boolean);
   for (var tam = pal.length; tam >= 1 && !(alvo && alvo.length); tam--) {
    for (var ini = 0; ini + tam <= pal.length; ini++) {
     var junto = pal.slice(ini, ini + tam).join('');
     if (junto.length < 5) continue;
     var porJunto = lista.filter(function (c) { return (c.chaves || []).some(function (k) { var kn = norm(k).replace(/[^a-z0-9]/g, ''); return kn === junto || kn.replace(/\d+$/, '') === junto; }); });
     if (!porJunto.length) continue;
     var jogador = porJunto.filter(function (c) { return (c.origens || []).some(function (o) { return o && o.papel === 'player'; }); });
     alvo = jogador.length ? jogador : porJunto; break;
    }
   }
  }
  return alvo || [];
 }
 // "Operando" de verdade = casas com aba FILHA LOGADA agora (a extensao ja reporta). E o sinal mais
 // direto de "onde estou operando" — nao depende de marcar meta iniciada. Cada slot com casa+conta
 // e uma aba logada; ping recente = viva. Casa sem filha (so mae) nunca entra.
 function casasComAbaViva(estado) {
  const inst = (estado && estado.instalacoes) || [];
  const conhecidas = (estado && estado.identidades && estado.identidades.casas) || [];
  const porChave = k => conhecidas.find(c => (c.chaves || []).some(x => String(x).toLowerCase() === String(k).toLowerCase()));
  const agora = Date.now(), vivas = new Map();
  inst.forEach(i => {
   if (i.tipo !== 'player') return;
   const ping = Date.parse(String(i.ultimo_ping || '').replace(' ', 'T'));
   if (!Number.isFinite(ping) || agora - ping > 180000) return;   // so instalacao viva
   (i.slots || []).forEach(s => {
    if (!s || !s.casa || !s.conta) return;                        // aba LOGADA (tem conta)
    const casa = porChave(s.casa);
    if (!casa || !temFilha(casa)) return;
    vivas.set(casa.id, {id: casa.id, nome: nomeOficial(casa), chaves: (casa.chaves || []).slice()});
   });
  });
  return [...vivas.values()].sort((a, b) => (a.nome < b.nome ? -1 : 1));
 }
 // "Operando agora" = casa que voce INICIOU em Metas E que esta capturando (aba logada). O cruzamento
 // evita conflito: casa finalizada (fora das metas) some mesmo com aba aberta, e casa de meta iniciada
 // so entra quando a aba dela sobe. Sem meta iniciada, cai nas abas vivas. Usado pelo menu e pelo card Meta.
 function casasOperandoAgora(estado) {
  // "Operando agora" = casas de META INICIADA (nao finalizada). PERSISTE mesmo se a extensao parar
  // de pingar: o operador iniciou a meta e trabalha nela ate FECHAR a operacao. So cai nas abas
  // vivas quando NAO ha nenhuma meta iniciada. (Antes cruzava com aba-viva e a casa sumia quando a
  // extensao parava de reportar — era o "progresso some" que o operador viu.)
  const porMeta = casasOperando(estado || {});
  if (porMeta.length) return porMeta;   // metas INICIADAS: mostra (persiste até fechar), sem filtrar
  const vivas = casasComAbaViva(estado || {});
  // casa cuja operação foi FECHADA (estado.maeOcultas) NÃO volta pelo aba-viva — o progresso fecha
  // junto com a mãe/operação, mesmo com a aba da filha ainda aberta. Volta só ao reiniciar a meta.
  const oc = maeOcultasCli();
  if (!oc.length) return vivas;
  return vivas.filter(c => !(c.chaves || []).some(k => oc.includes(String(k).toLowerCase())));
 }
 // lê estado.maeOcultas do estado CLIENTE (global); função à parte p/ o 'estado' aqui não sofrer o
 // shadow do parâmetro de casasOperandoAgora (que é o estado do SERVIDOR).
 function maeOcultasCli(){ try{ return (typeof estado!=='undefined' && estado && Array.isArray(estado.maeOcultas)) ? estado.maeOcultas : []; }catch(_){ return []; } }
 function render(estado) {
  if (!instalar()) return;
  if (estado) ultimoEstado = estado; else estado = ultimoEstado || {};
  const tabela = (estado && estado.jogos_identidade) || {};
  const casas = Object.keys(tabela).sort();
  // um jogo esta "pronto" quando alguma casa ja ensinou o pedido de launch dele
  const receita = {};
  const clique = {}, casasDoJogo = {};
  casas.forEach(casa => Object.entries(tabela[casa] || {}).forEach(([id, linha]) => {
   if (!linha || linha.origem !== 'lancamento') return;
   (receita[id] = receita[id] || []).push(casa);
   // basta a casa ter reconhecido o jogo: a abertura usa a URL guardada no navegador (que o painel
   // nao ve, por levar token) e so cai no clique aprendido como reserva
   (casasDoJogo[id] = casasDoJogo[id] || []).push(casa);
   clique[id] = casa;
  }));
  const operando = casasOperandoAgora(estado || {});
  const conhecidas = ((estado && estado.identidades && estado.identidades.casas) || []);
  const porChave = k => conhecidas.find(c => (c.chaves || []).some(x => String(x) === String(k)));
  const sabemAbrir = [...new Set(Object.values(casasDoJogo).flat())].map(k => {
   const casa = porChave(k);
   if (casa && !temFilha(casa)) return null;
   return casa ? {id: casa.id, nome: nomeOficial(casa), chaves: (casa.chaves || []).slice()}
               : {id: k, nome: String(k).toUpperCase(), chaves: [k]};
  }).filter(Boolean);
  // dedupe por casa: a mesma casa vinha uma vez por chave e aparecia repetida na tela
  const ofertadas = [...new Map((operando.length ? operando : sabemAbrir).map(c => [c.id, c])).values()]
   .sort((a, b) => (a.nome < b.nome ? -1 : 1));
  const ids = ofertadas.map(c => c.id);
  ofertadasAgora = ofertadas;
  escolhidas = new Set([...escolhidas].filter(c => ids.includes(c)));
  if (!escolhidas.size) ids.forEach(c => escolhidas.add(c));
  const sig = JSON.stringify([casas, ofertadas, [...escolhidas].sort(), filtro, catalogoAtual(estado).length]);
  if (sig === assinatura) return;
  assinatura = sig;
  const listaCat = catalogoAtual(estado);
  // busca por nome; sem filtro, os populares (destaque) primeiro para nao despejar 164 de cara
  const visiveis = filtro
   ? listaCat.filter(j => j.nome.toLowerCase().indexOf(filtro) >= 0)
   : listaCat.slice().sort((a, b) => (b.destaque ? 1 : 0) - (a.destaque ? 1 : 0));
  // Imagem real do jogo, quando o painel ja tiver colhido (mapa id->url); senao, ficha com emoji.
  const imagens = (estado && estado.jogos_imagens) || {};
  // Casa(s) SELECIONADA(s) para abrir (as mesmas dos checkboxes do topo) — texto real, sem inventar.
  const selNomes = ofertadas.filter(c => escolhidas.has(c.id)).map(c => c.nome);
  const casaSelTxt = selNomes.length === 1 ? selNomes[0] + ' selecionada'
    : selNomes.length > 1 ? selNomes.length + ' casas selecionadas'
    : (ofertadas.length ? 'Escolha uma casa acima' : '');
  $('agJogosBody').innerHTML = visiveis.length ? visiveis.map(j => {
   const hue = (parseInt(j.id, 10) || 0) * 47 % 360;                 // cor propria por jogo
   const url = imagens[String(j.id)] || capaDoJogo(j.id);   // override do servidor, senao capa oficial por id
   const thumb = url ? '<img class="gj-thumb" src="' + h(url) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : '';
   return '<button class="gj-btn' + (j.destaque ? ' gj-top' : '') + '" data-jogo="' + h(j.id) + '" data-pronto="1" style="--gj-h:' + hue + '" title="' + h(j.nome) + '">' +
    '<span class="gj-coin">' + thumb + '<span class="gj-emoji">' + j.simbolo + '</span>' + (j.destaque ? '<b class="gj-star">★</b>' : '') + '</span>' +
    '<span class="nxr-gj-body"><span class="gj-nome">' + h(j.nome) + '</span>' +
    (casaSelTxt ? '<span class="nxr-gj-casa">' + h(casaSelTxt) + '</span>' : '') +
    '<span class="nxr-gj-cta">↗ Abrir jogo</span></span></button>';
  }).join('')
   : '<div class="gj-vazio">Nenhum jogo com “' + h(filtro) + '”.</div>';
  $('agJogosCasas').innerHTML = ofertadas.length
   ? '<span>' + (operando.length ? 'Operando' : 'Abrir em') + ':</span>' + ofertadas.map(c => '<label><input type="checkbox" data-casa="' + h(c.id) + '"' +
     (escolhidas.has(c.id) ? ' checked' : '') + '> ' + h(c.nome) + '</label>').join('')
   : '';
  $('agJogosSub').textContent = filtro
   ? visiveis.length + ' de ' + listaCat.length + ' jogos'
   : listaCat.length + ' jogos · busque pelo nome';
  $('agJogosFoot').innerHTML = casas.length
   ? '<span class="gj-dot"></span> ' + casas.map(c => h(root.casaLabel ? root.casaLabel(c) : c)).join(' · ')
   : '<span class="gj-dot gj-off"></span> nenhuma casa reconheceu jogo ainda';
 }
 // casasOperando serve o Vigia tambem: quem esta rodando agora merece destaque la
 root.AgentumJogos = {render: render, CATALOGO: CATALOGO, casasOperando: casasOperando, casasComAbaViva: casasComAbaViva, casasOperandoAgora: casasOperandoAgora, nomeOficial: nomeOficial, casarPlataforma: casarPlataforma, vinculoDaMeta: vinculoDaMeta};
})(window);
