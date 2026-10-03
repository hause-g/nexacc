/* Rollover (TESTE, 25/09/2026) — módulo separado de propósito: mexer aqui não mexe no resto do painel.
   Etapa 1 = MEDIR. A filha (1.71+; binário a partir da 1.72) manda os campos das primeiras rodadas de cada jogo aberto; esta aba
   mostra o que chegou para confirmarmos, com giro real, qual campo é a aposta e qual é o saldo antes
   de confiar um freio neles. Nada aqui para jogo, arma nada nem mexe em dinheiro. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const h = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Palpites a CONFIRMAR (nomes vistos em jogos PG). Só destacam a coluna; nada decide com eles.
  const PALPITE = { tb: 'aposta total?', tbb: 'aposta base?', cs: 'valor da moeda?', ml: 'multiplicador?',
    bl: 'saldo depois?', blb: 'saldo antes?', blab: 'saldo após aposta?', tw: 'ganho total?', np: 'lucro líquido?', aw: 'ganho?' };
  let amostras = [], erro = '', timer = null, casaSel = '';
  const ver = v => String(v || '').split('.').map(Number);
  const pelo = (v, a, b) => { const [x, y] = ver(v); return x > a || (x === a && y >= b); };
  const nomeCasa = c => (typeof casaLabel === 'function' ? casaLabel(c) : c) || c;
  // Abas vivas por casa (igual à aba Jogos: o que está rodando AGORA), com a versão que roda DENTRO
  // da aba — atualizar a extensão sem F5 deixa a aba no código velho.
  function abasPorCasa() {
    const ext = (typeof Estado !== 'undefined' && Estado && Estado.instalacoes) || [];
    const casas = new Map();
    ext.filter(i => i.tipo === 'player' && Date.now() - Date.parse(i.ultimo_ping) < 180000).forEach(i => {
      // Uma ABA = o quadro de topo (lobby da casa). Os outros quadros da mesma aba são o JOGO, que roda
      // no domínio da PG (a casa "M" que aparecia com 32 abas): marcam "jogo aberto" na aba, não viram casa.
      const porAba = new Map();
      (i.slots || []).forEach(s => {
        if (!s || !s.tab_id) return;
        const t = porAba.get(s.tab_id) || { topo: null, jogo: false, vpJogo: '' };
        if (String(s.frame_id) === '0') t.topo = s; else { t.jogo = true; t.vpJogo = s.versao_pagina || t.vpJogo; }
        porAba.set(s.tab_id, t);
      });
      porAba.forEach(t => {
        const s = t.topo; if (!s || !s.casa) return;
        const vp = t.vpJogo || s.versao_pagina || i.versao;
        // 1.73 = primeira que lê a resposta da gem-saviour (JSON com inteiro gigante); 1.71/1.72 mandam "vazio".
        const situ = pelo(vp, 1, 73) ? ['ok', 'pronta'] : pelo(i.versao, 1, 73) ? ['aviso', 'extensão nova, falta F5 na aba']
          : pelo(vp, 1, 71) ? ['aviso', (vp || '?') + ': amostra vazia — atualizar'] : ['erro', (vp || '?') + ': sem Rollover — atualizar'];
        const lista = casas.get(s.casa) || []; casas.set(s.casa, lista);
        lista.push({ conta: s.conta || '', vp, situ, jogo: t.jogo });
      });
    });
    return casas;
  }


  function hora(iso) { const d = new Date(iso); return Number.isNaN(+d) ? '—' : d.toLocaleTimeString('pt-BR'); }
  function numeros(n) {
    const ks = Object.keys(n || {});
    if (!ks.length) return '<span class="rl-mut">nenhum número</span>';
    return ks.map(k => `<span class="rl-num${PALPITE[k] ? ' rl-palpite' : ''}" title="${h(PALPITE[k] || '')}"><b>${h(k)}</b>=${h(n[k])}</span>`).join(' ');
  }
  function render() {
    const app = $('rolloverApp'); if (!app) return;
    // Estado é global léxico do index.html (não é propriedade de window)
    const casas = abasPorCasa();
    const todasCasas = [...new Set([...casas.keys(), ...amostras.map(a => a.casa).filter(Boolean)])].sort();
    if (casaSel && !todasCasas.includes(casaSel)) casaSel = '';
    const doFiltro = casaSel ? amostras.filter(a => a.casa === casaSel) : amostras;
    const nAmostras = (casa, conta) => amostras.filter(a => a.casa === casa && (!conta || String(a.conta) === String(conta))).length;
    const pills = `<div class="rl-pills"><button class="btn mini${casaSel ? '' : ' on'}" data-rl-casa="">Todas</button>${todasCasas.map(c => `<button class="btn mini${casaSel === c ? ' on' : ''}" data-rl-casa="${h(c)}">${h(nomeCasa(c))} <small>${(casas.get(c) || []).length} aba(s)</small></button>`).join('')}</div>`;
    const cartoes = [...casas].filter(([c]) => !casaSel || c === casaSel).map(([c, abas]) => {
      const por = {}; abas.forEach(t => { por[t.situ[1]] = (por[t.situ[1]] || 0) + 1; });
      const resumo = Object.entries(por).map(([txt, n]) => `<span class="rl-sit rl-s-${abas.find(t => t.situ[1] === txt).situ[0]}">${n} ${h(txt)}</span>`).join(' ');
      const comJogo = abas.filter(t => t.jogo).length;
      return `<details class="rl-casa"><summary><b>${h(nomeCasa(c))}</b> <span class="rl-mut">${abas.length} aba(s) · ${comJogo} com jogo aberto · ${nAmostras(c)} rodada(s)</span> ${resumo}</summary>
      <ul>${abas.map(t => `<li><span>${t.conta ? 'conta …' + h(String(t.conta).slice(-4)) : '<i>conta não identificada</i>'}</span><span class="rl-sit rl-s-${t.situ[0]}">${h(t.situ[1])}</span>${t.jogo ? '<span class="rl-mut">jogo aberto</span>' : ''}<span class="rl-mut">${t.conta ? nAmostras(c, t.conta) + ' rodada(s)' : ''}</span></li>`).join('')}</ul></details>`;
    }).join('');
    // Transporte (1.72): de onde e como a resposta veio — é o que diz se é JSON, texto cifrado ou binário.
    const transporte = a => [a.via && (a.via + (a.tipo_resposta ? '/' + a.tipo_resposta : '')), a.content_type,
      a.bytes ? a.bytes + ' B' : (a.tamanho ? a.tamanho + ' car.' : ''), a.inicio_hex && 'início ' + a.inicio_hex,
      a.doc && ('jogo ' + a.doc + (a.n ? ' #' + a.n : ''))].filter(Boolean).join(' · ');
    const linhas = doFiltro.map(a => `<tr><td>${h(hora(a.recebido_em))}</td><td>${h(a.casa || '—')}</td><td>${h(a.conta ? '…' + String(a.conta).slice(-4) : '—')}</td><td>${h(a.slug)}</td><td>${h(a.formato)}${a.caminho ? ' · ' + h(a.caminho) : ''}<div class="rl-mut rl-transp">${h(transporte(a))}</div></td><td class="rl-nums">${numeros(a.numeros)}</td></tr>`).join('');
    app.innerHTML = `
      <div class="painel rl-etapa">
        <h3>Etapa 1 · medindo os giros <span class="rl-tag">sem parar nada</span></h3>
        <p class="rl-mut">Abra um jogo numa conta com a filha <b>1.73</b> e gire 3 ou 4 vezes. Cada rodada aparece aqui com os números que a casa devolveu. Os nomes destacados são só palpites (a confirmar com o que o jogo mostra na tela).</p>
        <div class="rl-acoes"><button class="btn mini" id="rlAtualizar">Atualizar</button><button class="btn mini" id="rlLimpar"${amostras.length ? '' : ' disabled'}>Limpar amostras</button></div>
        ${erro ? `<p class="rl-erro">${h(erro)}</p>` : ''}
      </div>
      <div class="painel">
        <h3>Onde está rodando agora</h3>
        ${pills}
        ${cartoes || '<p class="rl-mut">Nenhuma aba de filha com sinal agora' + (casaSel ? ' nesta casa' : '') + '.</p>'}
      </div>
      <div class="painel">
        <h3>Rodadas recebidas <span class="rl-mut">(${doFiltro.length}${casaSel ? ' de ' + h(nomeCasa(casaSel)) : ''}, mais recentes primeiro)</span></h3>
        ${doFiltro.length ? `<div class="rl-tabwrap"><table class="rl-tab"><thead><tr><th>Hora</th><th>Casa</th><th>Conta</th><th>Jogo</th><th>Formato</th><th>Números da resposta</th></tr></thead><tbody>${linhas}</tbody></table></div>`
          : '<p class="rl-mut">Nenhuma rodada ainda. Com a filha 1.73 instalada, gire num jogo e clique em Atualizar.</p>'}
      </div>`;
  }
  async function carregar() {
    try {
      const r = await fetch('/api/rollover/amostras', { cache: 'no-store' });
      const j = await r.json();
      amostras = Array.isArray(j.amostras) ? j.amostras : [];
      erro = '';
    } catch (_) { erro = 'Não foi possível ler as amostras do servidor.'; }
    render();
  }
  async function limpar() {
    try { await fetch('/api/rollover/amostras/limpar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) {}
    carregar();
  }
  function ativa() { const s = $('aba-rollover'); return !!(s && s.classList.contains('ativa')); }
  function ligar() {
    const app = $('rolloverApp'); if (!app || app._rl) return; app._rl = true;
    app.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.rlCasa !== undefined) { casaSel = b.dataset.rlCasa; render(); return; }
      if (b.id === 'rlAtualizar') carregar();
      if (b.id === 'rlLimpar' && confirm('Apagar as amostras de giro do teste? (não mexe em nenhum dado da operação)')) limpar();
    });
    // Só consulta com a aba aberta: fora dela não gasta nada.
    timer = setInterval(() => { if (ativa() && !document.hidden) carregar(); }, 5000);
    document.querySelectorAll('nav button[data-aba="rollover"]').forEach(b => b.addEventListener('click', () => setTimeout(carregar, 50)));
    if (ativa()) carregar(); else render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligar); else ligar();
  root.AgentumRollover = { carregar };
})(window);
