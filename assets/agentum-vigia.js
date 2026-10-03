/* Vigia — contas travadas, ao vivo.
   A casa devolve o estado da conta em member/login e member/user/info; a filha ja grava isso em
   contas.status desde sempre e ninguem olhava. 1=ativa, 4=verificar, qualquer outro=bloqueada,
   null=ainda nao lido. O "nao lido" NUNCA vira acusacao: depositar numa conta travada e dinheiro
   que nao volta, mas acusar conta boa faz o operador parar de confiar na tela. */
(function (root) {
 'use strict';
 const $ = id => document.getElementById(id);
 const h = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const VELHO = 24 * 3600 * 1000;   // estado lido ha mais de um dia pode ja ter mudado na casa

 // Provado com duas contas do proprio operador, que ele sabia estarem proibidas:
 // user_status 4 = recolha de bau proibida · 7 = saque proibido · 1 = normal.
 // (Antes eu li isso no vetor userOptResult — era coincidencia: as contas do arquivo com o mesmo
 // vetor tinham status 1, ou seja, estavam sas. O vetor varia entre contas boas e nao e permissao.)
 // Codigo desconhecido continua "Bloqueada": nomear sem evidencia e o que faz a tela mentir.
 function estadoDe(status) {
  const n = Number(status);
  if (n === 1) return null;                                          // normal: nao e problema
  if (n === 4) return {rotulo: 'Baú proibido', classe: 'vg-ver', dica: 'A casa não deixa recolher o baú desta conta.'};
  if (n === 7) return {rotulo: 'Saque proibido', classe: 'vg-bloq', dica: 'A casa não deixa sacar desta conta.'};
  return {rotulo: 'Bloqueada', classe: 'vg-bloq', dica: 'Estado ' + status + ', ainda sem significado confirmado.'};
 }
 // Login recusado: o codigo vem da casa. Nao batizo nenhum sem o operador confirmar — nomear
 // errado aqui e pior que nao nomear, porque ele para de confiar na tela.
 function falhaDe(codigo) {
  return {rotulo: 'Login recusado', classe: 'vg-bloq',
          dica: 'A casa recusou o login desta conta (código ' + codigo + '). O último estado lido pode estar velho.'};
 }
 function quando(iso) {
  const t = Date.parse(String(iso || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return {texto: 'sem leitura', velho: true};
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const texto = s < 90 ? 'agora' : s < 3600 ? 'há ' + Math.floor(s / 60) + ' min'
    : s < 86400 ? 'há ' + Math.floor(s / 3600) + ' h' : 'há ' + Math.floor(s / 86400) + ' d';
  return {texto: texto, velho: Date.now() - t > VELHO};
 }
 function dinheiro(v) {
  return typeof root.fmtBRL === 'function' && v != null ? root.fmtBRL(v) : (v == null ? '—' : String(v));
 }

 function agrupar(estado) {
  const contas = Array.isArray(estado.contas) ? estado.contas : [];
  // "Limpar" e marca d'agua, nao delete: some da tela o que ja foi resolvido, e uma conta lida de
  // novo como travada DEPOIS da marca volta a aparecer sozinha. Nada do banco e apagado.
  const marca = (estado.dispensados && estado.dispensados.vigia) || '';
  const casas = {};
  let lidas = 0, semLeitura = 0, dispensadas = 0;
  // Conta que fica anormal FALHA o login, entao o status nunca e relido e continua "normal".
  // O codigo do erro e o unico sinal que sobra — e ele vale mais que o status velho.
  const erros = estado.contas_erro || {};
  contas.forEach(c => {
   const falha = erros[(c.casa || '') + '|' + c.conta];
   if (c.status == null && !falha) { semLeitura++; return; }
   if (c.status != null) lidas++;
   const problema = falha ? falhaDe(falha.erro) : estadoDe(c.status);
   if (!problema) return;
   if (falha) c = Object.assign({}, c, {atualizado_em: falha.erro_em || c.atualizado_em});
   if (marca && String(c.atualizado_em || '').replace(' ', 'T') <= marca) { dispensadas++; return; }
   const casa = c.casa || 'casa não identificada';
   (casas[casa] = casas[casa] || []).push({
    conta: c.conta, estado: problema, status: c.status,
    lido: quando(c.atualizado_em), saldo: c.saldo
   });
  });
  return {casas: casas, lidas: lidas, semLeitura: semLeitura, dispensadas: dispensadas, total: contas.length};
 }

 function instalar() {
  if ($('vgLista')) return true;
  const alvo = $('aba-vigia');
  if (!alvo) return false;
  alvo.insertAdjacentHTML('beforeend', '<div id="vgLista"></div>');
  return true;
 }

 function render(estado) {
  if (!instalar()) return;
  const d = agrupar(estado || {});
  const daAba = root.AgentumJogos && root.AgentumJogos.casasOperando;
  const operando = typeof daAba === 'function' ? daAba(estado || {}) : [];
  const nomes = Object.keys(d.casas).sort((a, b) => d.casas[b].length - d.casas[a].length);
  const total = nomes.reduce((s, n) => s + d.casas[n].length, 0);

  const cobertura = '<p class="vg-rodape">' + h(d.lidas) + ' de ' + h(d.total) + ' contas com estado lido'
   + (d.semLeitura ? ' · <b>' + h(d.semLeitura) + '</b> ainda sem leitura — essas não são acusadas' : '')
   + (d.dispensadas ? ' · <b>' + h(d.dispensadas) + '</b> dispensadas por você' : '')
   + '. O estado vem da própria casa, na resposta de login.</p>';

  if (!total) {
   $('vgLista').innerHTML = '<div class="vg-ok"><span class="vg-ok-marca">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    + '</span><div><b>Nenhuma conta travada</b><span>Entre as ' + h(d.lidas) + ' contas já lidas, todas responderam ativas.</span></div></div>' + cobertura;
   marcar(0);
   return;
  }

  $('vgLista').innerHTML = nomes.map(casa => {
   const linhas = d.casas[casa].slice().sort((a, b) => (a.estado.rotulo < b.estado.rotulo ? -1 : 1));
   const rotulo = root.casaLabel ? root.casaLabel(casa) : casa;
   // operando agora vem por CASA (com todas as chaves dela), nao por chave solta
   const naOperacao = operando.some(o => (o.chaves || []).some(k => String(k).toLowerCase() === String(casa).toLowerCase()));
   return '<section class="vg-casa' + (naOperacao ? ' vg-operando' : '') + '">'
    + '<header><b>' + h(rotulo) + '</b>'
    + (naOperacao ? '<span class="vg-agora">operando agora</span>' : '')
    + '<span class="vg-conta-num">' + linhas.length + (linhas.length === 1 ? ' conta' : ' contas') + '</span></header>'
    + '<ul>' + linhas.map(l =>
      '<li class="' + l.estado.classe + (l.lido.velho ? ' vg-velho' : '') + '" title="' + h(l.estado.dica || '') + '">'
      + '<span class="vg-id">' + h(l.conta) + '</span>'
      + '<span class="vg-estado">' + h(l.estado.rotulo) + '</span>'
      + '<span class="vg-lido">' + h(l.lido.texto) + '</span>'
      + '<span class="vg-saldo">' + h(dinheiro(l.saldo)) + '</span></li>').join('')
    + '</ul></section>';
  }).join('')
   + '<div class="vg-acoes"><button class="btn mini" id="vgLimpar">Dispensar avisos (' + total + ')</button>'
   + '<span>Some da tela sem apagar nada. Se a casa marcar de novo depois disso, volta sozinha.</span></div>'
   + cobertura;
  ligarLimpar(estado);
  marcar(total);
 }

 // "Limpar": carimba o instante e some com o que e anterior a ele. Nenhuma conta e apagada e
 // nenhum estado e alterado na casa — e so a tela parando de cobrar o que voce ja resolveu.
 function ligarLimpar(estado) {
  const botao = $('vgLimpar');
  if (!botao) return;
  botao.onclick = () => {
   botao.disabled = true;
   const pedir = root.Agentum && root.Agentum.request;
   if (typeof pedir !== 'function') { botao.disabled = false; return; }
   pedir('/api/dispensar', {tipo: 'vigia'})
    .then(() => { if (root.toast) root.toast('Avisos dispensados — saíram da tela. Se a casa informar o estado de novo, o aviso reaparece.'); })
    .catch(e => { botao.disabled = false; if (root.toast) root.toast('Não consegui limpar: ' + (e.message || 'servidor não respondeu')); });
  };
 }
 // Selo no menu: a unica marca que o Vigia deixa fora da aba dele.
 function marcar(quantas) {
  const botao = document.querySelector('nav button[data-aba="vigia"]');
  if (!botao) return;
  let selo = botao.querySelector('.vg-selo');
  if (!quantas) { if (selo) selo.remove(); return; }
  if (!selo) { selo = document.createElement('span'); selo.className = 'vg-selo'; botao.append(selo); }
  selo.textContent = quantas > 99 ? '99+' : String(quantas);
 }
 root.AgentumVigia = {render: render, estadoDe: estadoDe};
})(window);
