/* Card "Meta por casa" (aba propria) — progresso de DEPOSITO por casa que voce esta operando vs o
   alvo que voce digita (manual, salvo por ciclo no servidor). O quanto ja entrou vem de
   resumo_efetivo.por_casa; a casa "operando" e a mesma do menu de Jogos (meta iniciada + aba viva). */
(function (root) {
 'use strict';
 const $ = id => document.getElementById(id);
 const h = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const brl = v => typeof root.fmtBRL === 'function' ? root.fmtBRL(v)
   : ('R$ ' + (Number(v) || 0).toLocaleString('pt-BR', {minimumFractionDigits: 0, maximumFractionDigits: 0}));
 let ultimo = null;

 function instalar() {
  if ($('mtLista')) return true;
  const alvo = $('mtAncora'); if (!alvo) return false;
  alvo.insertAdjacentHTML('beforeend', '<div id="mtLista"></div>');
  $('mtLista').addEventListener('change', onAlvo);
  $('mtLista').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input[data-alvo]')) e.target.blur(); });
  return true;
 }
 // Deposito somado da casa: procura em resumo_efetivo.por_casa por QUALQUER chave da casa.
 function depositoDe(estado, chaves) {
  const pc = (estado && estado.resumo_efetivo && estado.resumo_efetivo.por_casa) || [];
  const set = new Set((chaves || []).map(k => String(k).toLowerCase()));
  let dep = 0, contas = 0;
  pc.forEach(c => { if (set.has(String(c.casa || '').toLowerCase())) { dep += Number(c.deposito) || 0; contas += Number(c.contas) || 0; } });
  return {dep, contas};
 }
 function onAlvo(e) {
  const inp = e.target.closest('input[data-alvo]'); if (!inp) return;
  const casa = inp.dataset.alvo;
  const bruto = String(inp.value || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const valor = bruto === '' ? '' : Number(bruto);
  const pedir = root.Agentum && root.Agentum.request;
  if (typeof pedir !== 'function') return;
  pedir('/api/meta_casa', {alvos: {[casa]: (valor === '' || !Number.isFinite(valor)) ? '' : valor}})
   .then(() => { if (root.toast) root.toast('Alvo salvo.'); })
   .catch(err => { if (root.toast) root.toast('Não consegui salvar o alvo: ' + (err.message || 'servidor não respondeu')); });
 }
 function render(estado) {
  if (!instalar()) return;
  if (estado) ultimo = estado; else estado = ultimo || {};
  // Nao reconstruir enquanto o operador digita um alvo — senao o input perde foco/valor.
  const foco = document.activeElement;
  if (foco && foco.closest && foco.closest('#mtLista input')) return;

  const jogos = root.AgentumJogos;
  const casas = (jogos && typeof jogos.casasOperandoAgora === 'function') ? jogos.casasOperandoAgora(estado) : [];
  const alvos = (estado.metas_por_casa && estado.metas_por_casa.alvos) || {};
  const rotulo = c => (root.casaLabel ? root.casaLabel(c) : c);

  if (!casas.length) {
   $('mtLista').innerHTML = '<div class="mc-vazio">Nenhuma casa em operação agora. Inicie uma meta em <b>Metas</b> e abra a casa — o progresso aparece aqui, automático.</div>';
   return;
  }
  const alvoDe = ch => { for (const k of (ch || [])) { const v = alvos[String(k).toLowerCase()] ?? alvos[k]; if (v != null) return Number(v); } return null; };
  let somaDep = 0, somaAlvo = 0;
  const cards = casas.map(casa => {
   const {dep, contas} = depositoDe(estado, casa.chaves);
   const alvo = alvoDe(casa.chaves);
   somaDep += dep; if (alvo) somaAlvo += alvo;
   const pct = alvo ? Math.min(100, Math.round(dep / alvo * 100)) : 0;
   const done = !!(alvo && dep >= alvo);
   const falta = alvo ? Math.max(0, alvo - dep) : null;
   const chave = (casa.chaves || [])[0] || casa.id;
   const alvoTxt = alvo ? alvo.toLocaleString('pt-BR', {maximumFractionDigits: 0}) : '';
   return '<div class="mc-casa' + (done ? ' mc-done' : '') + '">'
    + '<div class="mc-top"><span class="mc-dot"></span><span class="mc-nome">' + h(casa.nome || rotulo(chave)) + '</span><span class="mc-op">operando</span>'
    + '<span class="mc-vals"><b>' + h(brl(dep)) + '</b> / <span class="mc-alvo-wrap">R$ <input type="text" inputmode="numeric" autocomplete="off" data-alvo="' + h(chave) + '" value="' + h(alvoTxt) + '" placeholder="alvo"></span> · ' + contas + ' contas</span></div>'
    + '<div class="mc-bar' + (done ? ' mc-full' : '') + '"><i style="width:' + pct + '%"></i></div>'
    + '<div class="mc-pe">' + (alvo ? (done ? '<span>meta batida ✓</span>' : '<span>faltam ' + h(brl(falta)) + '</span>') : '<span class="mc-semalvo">defina o alvo ao lado →</span>') + '<b>' + (alvo ? pct + '%' : '—') + '</b></div>'
    + '</div>';
  }).join('');
  const pctGeral = somaAlvo ? Math.min(100, Math.round(somaDep / somaAlvo * 100)) : 0;
  const faltaGeral = Math.max(0, somaAlvo - somaDep);
  // Anel proporcional: usa a MESMA pctGeral (expõe em --pct) e mostra o número real no centro
  // (texto acessível via aria-label). Substitui o badge de % antigo; a barra fina abaixo continua.
  const anel = '<div class="nxr-ring" style="--pct:' + pctGeral + '" role="img" aria-label="Progresso geral: '
   + pctGeral + ' por cento"><span class="nxr-ring-num">' + pctGeral + '%</span></div>';
  const geral = somaAlvo
   ? '<div class="mc-geral"><b>' + h(brl(somaDep)) + '</b><span>de ' + h(brl(somaAlvo)) + '</span>' + anel
     + '<div class="nxr-geral-falta"><span>Faltam</span><b>' + h(brl(faltaGeral)) + '</b></div></div>'
     + '<div class="mc-bar mc-geral-bar' + (somaDep >= somaAlvo && somaAlvo ? ' mc-full' : '') + '"><i style="width:' + pctGeral + '%"></i></div>'
   : '<div class="mc-geral"><b>' + h(brl(somaDep)) + '</b><span>somado · defina os alvos por casa para ver o progresso</span></div>';
  $('mtLista').innerHTML = geral + '<div class="mc-cards">' + cards + '</div>'
   + '<p class="mc-rodape">' + casas.length + (casas.length === 1 ? ' casa em operação' : ' casas em operação')
   + ' · alvo salvo por ciclo · atualiza junto com o painel</p>';
 }
 root.AgentumMeta = {render: render};
})(window);
