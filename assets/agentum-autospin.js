/* agentum-autospin.js — Painel Auto Spin */
(function () {
  'use strict';

  const API = '';
  let jogos = [];
  let catalogos = [];
  let provedorAtual = 200;
  let contasComSessao = [];
  // Selecao de contas persistente: a lista re-renderiza (sincronizar/nova aba)
  // e sem isso os checks sumiam — o "Iniciar" saia sem contas.
  const selecaoContas = new Set();
  let pollTimer = null;
  let pollIntervaloMs = 0;
  let visibilidadeWired = false;
  let pararTimer = null;
  let pararTimerSeq = 0;
  let paradaSeq = 0;
  let verificandoParada = false;
  let pollEmAndamento = false;

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }
  function fmt(n) { return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

  async function get(url, timeoutMs) {
    const opts = timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined;
    const r = await fetch(API + url, opts);
    if (!r.ok) {
      let motivo = '';
      try { const d = await r.json(); motivo = (d && (d.motivo || d.status)) || ''; } catch { }
      throw new Error(`HTTP ${r.status}${motivo ? ' — ' + motivo : ''}`);
    }
    return r.json();
  }

  async function post(url, data) {
    const r = await fetch(API + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) {
      let motivo = '';
      try { const d = await r.json(); motivo = (d && (d.motivo || d.status)) || ''; } catch { }
      throw new Error(`HTTP ${r.status}${motivo ? ' — ' + motivo : ''}`);
    }
    return r.json();
  }

  async function carregarJogos(pid) {
    try {
      const d = await get('/api/autospin/jogos?pid=' + (pid || provedorAtual));
      jogos = d.jogos || [];
    } catch { jogos = []; }
  }

  async function carregarCatalogos() {
    try {
      const d = await get('/api/autospin/catalogos');
      catalogos = d.catalogos || [];
      if (d.giravel) provedorAtual = d.giravel;
    } catch { catalogos = []; }
  }

  function renderProvedorOptions() {
    const sel = $('#asProvedor');
    if (!sel) return;
    let html = '';
    catalogos.forEach(c => {
      const marca = c.giravel ? ' (o bot gira)' : '';
      html += `<option value="${c.pid}"${c.pid === provedorAtual ? ' selected' : ''}>${escHtml(c.provedor)} — ${c.total} jogos${marca}</option>`;
    });
    if (!html) html = '<option value="200">PG — sem catalogo em cache</option>';
    sel.innerHTML = html;
  }

  function atualizarAvisoProvedor() {
    const aviso = $('#asProvAviso');
    if (!aviso) return;
    const cat = catalogos.find(c => c.pid === provedorAtual);
    if (!cat) {
      aviso.textContent = '';
      aviso.style.display = 'none';
      return;
    }
    if (cat.pid === 13) {
      aviso.textContent = '✅ WG suportado (WebSocket) — giros funcionam neste provedor.';
      aviso.style.display = 'block';
      aviso.style.color = 'var(--green2)';
      return;
    }
    if (!cat.giravel) {
      aviso.textContent = `⚠ ${cat.provedor}: catalogo disponivel para consulta, mas o bot gira apenas PG (Pocket Games) e WG.`;
      aviso.style.display = 'block';
      aviso.style.color = '';
      return;
    }
    aviso.textContent = '';
    aviso.style.display = 'none';
  }

  // Ao escolher um jogo, procura o MESMO nome nos outros provedores e oferece troca.
  let _ultimoJogoBuscado = '';
  async function buscarEmOutrosProvedores() {
    const sel = $('#asGame');
    const aviso = $('#asProvAviso');
    if (!sel || !aviso) return;
    const nome = (sel.value || '').trim();
    if (!nome || nome === _ultimoJogoBuscado) return;
    _ultimoJogoBuscado = nome;
    try {
      const d = await get('/api/autospin/jogos/busca?nome=' + encodeURIComponent(nome));
      const res = (d.resultados || []).filter(r => r.pid !== provedorAtual);
      if (!res.length) return;
      const partes = res.map(r => `${escHtml(r.provedor)}${r.giravel ? ' ✅' : ' ⚠️'}`);
      const giraveis = res.filter(r => r.giravel);
      let html = `🔎 "${escHtml(nome)}" também existe em: ${partes.join(' · ')}`;
      if (giraveis.length) {
        html += ` <button class="btn mini" onclick="window._asUsarProvedor(${giraveis[0].pid}, '${escAttr(escJs(nome))}')" style="font-size:11px;padding:3px 9px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);color:var(--petrol2);cursor:pointer;margin-left:6px">usar ${escHtml(giraveis[0].provedor)}</button>`;
      }
      aviso.innerHTML = html;
      aviso.style.display = 'block';
      aviso.style.color = '';
    } catch (e) { /* silencioso */ }
  }

  window._asUsarProvedor = async function (pid, nomeJogo) {
    provedorAtual = pid;
    const prov = $('#asProvedor');
    if (prov) prov.value = String(pid);
    await carregarJogos(pid);
    renderGameOptions();
    const sel = $('#asGame');
    if (sel && nomeJogo) {
      const opc = Array.from(sel.options).find(o => o.value === nomeJogo);
      if (opc) sel.value = nomeJogo;
    }
    atualizarAvisoProvedor();
  };

  async function carregarContas() {
    try {
      const d = await get('/api/autospin/sessoes');
      contasComSessao = d.contas || [];
    } catch { contasComSessao = []; }
  }

  function renderContasSelect() {
    const el = $('#asContasList');
    if (!el) return;
    if (!el._asWired) {
      el._asWired = true;
      el.addEventListener('change', e => {
        const cb = e.target && e.target.closest ? e.target.closest('.as-check') : null;
        if (!cb) return;
        const chave = cb.dataset.casa + '|' + cb.dataset.conta;
        if (cb.checked) selecaoContas.add(chave); else selecaoContas.delete(chave);
        atualizarPreviaMix();
      });
    }
    if (!contasComSessao.length) {
      el.innerHTML = '<p class="as-vazio">Nenhuma conta ativa agora. Abra as contas no navegador para a extensão capturar a sessão.</p>';
      return;
    }
    // Agrupar por casa
    const casas = {};
    contasComSessao.forEach(c => {
      if (!casas[c.casa]) casas[c.casa] = [];
      casas[c.casa].push(c);
    });
    let html = `<p class="as-info"><b>${contasComSessao.length} contas</b> na lista de sessões recebidas pela extensão.</p>`;
    Object.keys(casas).sort().forEach(casa => {
      const cnt = casas[casa].length;
      html += `<details class="as-casa" open><summary><b>${escHtml(casa)}</b> <span class="as-casa-total">${cnt} contas</span></summary>`;
      casas[casa].forEach(c => {
        const marcada = selecaoContas.has(c.casa + '|' + c.conta) ? ' checked' : '';
        html += `<label class="as-conta"><input type="checkbox" class="as-check"${marcada} data-casa="${escAttr(c.casa)}" data-conta="${escAttr(c.conta)}"><span class="as-conta-copy"><span class="as-conta-id">${escHtml(String(c.conta))}</span><small class="as-conta-host">${escHtml(String(c.host || '—'))}</small></span></label>`;
      });
      html += `<div class="as-casa-actions"><button class="btn mini" onclick="window._asSelCasa('${escAttr(escJs(casa))}',true)">Selecionar todas</button> <button class="btn mini ghost" onclick="window._asSelCasa('${escAttr(escJs(casa))}',false)">Limpar</button></div></details>`;
    });
    el.innerHTML = html;
  }

  window._asSelCasa = function (casa, on) {
    $$('.as-check').forEach(cb => {
      if (cb.dataset.casa === casa) {
        cb.checked = on;
        const chave = cb.dataset.casa + '|' + cb.dataset.conta;
        if (on) selecaoContas.add(chave); else selecaoContas.delete(chave);
      }
    });
    atualizarPreviaMix();
  };

  function getSelecionados() {
    const checks = $$('.as-check:checked');
    const casas = new Set();
    const contas = new Set();
    const pares = [];
    checks.forEach(cb => {
      casas.add(cb.dataset.casa);
      contas.add(cb.dataset.conta);
      pares.push({ casa: cb.dataset.casa, conta: cb.dataset.conta });
    });
    return { pares, casas: [...casas], contas: [...contas] };
  }

  // ─── Dividir em jogos (mix) ────────────────────────────────────────────────
  const jogosPorPid = {};
  let mixSeq = 0;

  function mixLigado() { const c = $('#asMixOn'); return !!(c && c.checked); }

  async function carregarTodosJogos() {
    await Promise.all((catalogos || []).map(async c => {
      if (jogosPorPid[c.pid] || !c.total) return;
      try {
        const d = await get('/api/autospin/jogos?pid=' + c.pid);
        jogosPorPid[c.pid] = d.jogos || [];
      } catch { jogosPorPid[c.pid] = []; }
    }));
  }

  function catalogoCombinado() {
    const opts = [];
    (catalogos || []).forEach(c => {
      (jogosPorPid[c.pid] || []).forEach(nome => {
        opts.push({ value: c.pid + '|' + nome, texto: (c.provedor || c.pid) + ' · ' + nome });
      });
    });
    if (!opts.length) {
      (jogos || []).forEach(nome => opts.push({ value: provedorAtual + '|' + nome, texto: nome }));
    }
    return opts;
  }

  function renderMixOptions() {
    const html = catalogoCombinado()
      .map(o => `<option value="${escAttr(o.value)}">${escHtml(o.texto)}</option>`).join('');
    $$('.asMixJogo').forEach(sel => {
      const atual = sel.value;
      sel.innerHTML = html || '<option value="">(catálogo vazio)</option>';
      if (atual) sel.value = atual;
    });
  }

  function mixLinhaHtml(id, visivel) {
    return `<div class="as-mix-linha" data-mix="${id}">
      <div class="as-field"><label for="asMixJogo${id}">Jogo ${visivel}</label><select class="asMixJogo" id="asMixJogo${id}"></select></div>
      <div class="as-field"><label for="asMixBet${id}">Bet</label><input type="number" class="asMixBet" id="asMixBet${id}" step="0.01" min="0.01" placeholder="0.10"></div>
      <div class="as-field"><label for="asMixGiros${id}">Giros</label><input type="number" class="asMixGiros" id="asMixGiros${id}" min="0" placeholder="0=auto"></div>
      <div class="as-field"><label for="asMixRoll${id}">Max Roll</label><input type="number" class="asMixRoll" id="asMixRoll${id}" step="0.01" min="0" placeholder="0=off"></div>
      <button class="btn mini ghost" onclick="window._asMixRemover(${id})">− remover</button>
    </div>`;
  }

  function atualizarPreviaMix() {
    const el = $('#asMixPrevia');
    if (!el) return;
    const linhas = $$('#asMixJogos .as-mix-linha');
    if (!mixLigado() || !linhas.length) { el.textContent = ''; return; }
    const n = getSelecionados().pares.length;
    const m = linhas.length;
    if (!n) { el.textContent = 'Selecione as contas na lista abaixo.'; return; }
    const sels = $$('#asMixJogos .asMixJogo');
    const base = Math.floor(n / m), resto = n % m;
    const partes = linhas.map((_, i) => {
      const nome = ((sels[i] && sels[i].value) || '').split('|')[1] || '?';
      return `${base + (i < resto ? 1 : 0)} ${nome}`;
    });
    el.textContent = `Prévia: ${n} contas → ${partes.join(' · ')}${resto ? ' (sobra aleatória)' : ''}`;
  }

  function coletarMix() {
    if (!mixLigado()) return null;
    const grupos = [];
    $$('#asMixJogos .as-mix-linha').forEach(l => {
      const sel = l.querySelector('.asMixJogo');
      const val = (sel && sel.value) || '';
      const partes = val.split('|');
      const pid = parseInt(partes[0], 10) || 200;
      const jogo = partes.slice(1).join('|');
      if (!jogo) return;
      grupos.push({
        game: jogo,
        provedor: pid,
        bet_max: parseFloat(l.querySelector('.asMixBet').value) || null,
        set_spins: parseInt(l.querySelector('.asMixGiros').value) || 0,
        max_roll: parseFloat(l.querySelector('.asMixRoll').value) || null,
      });
    });
    return grupos;
  }

  function initMix() {
    const box = $('#asMixJogos');
    if (!box || box.children.length) return;
    mixSeq = 0;
    for (let i = 0; i < 2; i++) {
      mixSeq += 1;
      box.insertAdjacentHTML('beforeend', mixLinhaHtml(mixSeq, i + 1));
    }
    renderMixOptions();
    // Pre-preenche: linha 1 = jogo atual da aba; linha 2 = o proximo do catalogo.
    const sels = $$('#asMixJogos .asMixJogo');
    const opts = [...((sels[0] && sels[0].options) || [])];
    const jogoAtual = $('#asGame') ? $('#asGame').value : '';
    const idx = opts.findIndex(o => o.value === provedorAtual + '|' + jogoAtual);
    if (sels[0] && idx >= 0) sels[0].value = opts[idx].value;
    if (sels[1] && opts.length > 1) sels[1].value = opts[(idx >= 0 ? idx + 1 : 1) % opts.length].value;
    const c = $('#asMixOn');
    if (c) c.addEventListener('change', () => {
      const corpo = $('#asMixCorpo');
      if (corpo) corpo.style.display = c.checked ? '' : 'none';
      atualizarPreviaMix();
    });
  }

  window._asMixAdd = function () {
    const box = $('#asMixJogos');
    if (!box) return;
    const linhas = box.querySelectorAll('.as-mix-linha');
    if (linhas.length >= 4) { toast('Máximo de 4 jogos.', 'warn'); return; }
    mixSeq += 1;
    box.insertAdjacentHTML('beforeend', mixLinhaHtml(mixSeq, linhas.length + 1));
    renderMixOptions();
    atualizarPreviaMix();
  };

  window._asMixRemover = function (id) {
    const box = $('#asMixJogos');
    if (!box) return;
    if (box.querySelectorAll('.as-mix-linha').length <= 2) {
      toast('O mix precisa de pelo menos 2 jogos.', 'warn');
      return;
    }
    const alvo = box.querySelector(`.as-mix-linha[data-mix="${id}"]`);
    if (alvo) alvo.remove();
    box.querySelectorAll('.as-mix-linha').forEach((l, i) => {
      const lab = l.querySelector('label');
      if (lab) lab.textContent = 'Jogo ' + (i + 1);
    });
    atualizarPreviaMix();
  };

  function getConfig() {
    return {
      mix: coletarMix(),
      game: $('#asGame') ? $('#asGame').value : '',
      provedor: $('#asProvedor') ? (parseInt($('#asProvedor').value, 10) || 200) : 200,
      bet_max: $('#asBetMax') ? parseFloat($('#asBetMax').value) || null : null,
      max_spin: $('#asMaxSpin') ? parseInt($('#asMaxSpin').value) || 0 : 0,
      set_spins: $('#asSetSpins') ? parseInt($('#asSetSpins').value) || 0 : 0,
      auto_roll: $('#asAutoRoll') ? $('#asAutoRoll').checked : false,
      max_roll: $('#asMaxRoll') ? (parseFloat($('#asMaxRoll').value) || null) : null,
      meta: $('#asMeta') ? parseFloat($('#asMeta').value) || 0 : 0,
      pg_trava: $('#asPgTrava') ? $('#asPgTrava').checked : false,
      zerar_saldo: $('#asZerarSaldo') ? $('#asZerarSaldo').checked : false,
      zerar_saldo_total: $('#asZerarSaldoTotal') ? $('#asZerarSaldoTotal').checked : false,
      gem_trava: $('#asGemTrava') ? (parseFloat($('#asGemTrava').value) || null) : null,
      coletar_bonus: $('#asColetarBonus') ? $('#asColetarBonus').checked : false,
      comprar_bonus: $('#asComprarBonus') ? parseInt($('#asComprarBonus').value) || 0 : 0,
      max_game: $('#asMaxGame') ? parseInt($('#asMaxGame').value) || 0 : 0,
      no_proxy: $('#asNoProxy') ? $('#asNoProxy').checked : false,
      modo_rapido: $('#asModoRapido') ? $('#asModoRapido').checked : false,
      turbo: $('#asTurbo') ? $('#asTurbo').checked : false,
      proxy_sempre: $('#asProxySempre') ? $('#asProxySempre').checked : false,
      stealth: $('#asStealth') ? $('#asStealth').checked : false,
      bet_percent: $('#asBetPercent') ? parseFloat($('#asBetPercent').value) || 0 : 0,
      saldo_limite: $('#asSaldoLimite') ? parseFloat($('#asSaldoLimite').value) || 0 : 0,
      abrir_jogos: ($('#asAbrirJogos') && $('#asAbrirJogos').checked)
        ? (parseInt($('#asAbrirJogosN') ? $('#asAbrirJogosN').value : '0', 10) || 0) : -1,
      gem_hp: $('#asGemHp') ? parseFloat($('#asGemHp').value) || 0 : 0,
      bau: $('#asBau') ? $('#asBau').checked : false,
      account_id: $('#asAccountId') ? $('#asAccountId').value.trim() : '',
      bonus_dias: $('#asBonusDias') ? parseInt($('#asBonusDias').value, 10) || 0 : 0,
      sem_extrato: $('#asSemExtrato') ? $('#asSemExtrato').checked : false,
      roll_teto_lote: $('#asRollTeto') ? parseFloat($('#asRollTeto').value) || 0 : 0,
      onda_tamanho: $('#asOndaTam') ? parseInt($('#asOndaTam').value, 10) || 0 : 0,
      onda_intervalo: $('#asOndaInt') ? parseFloat($('#asOndaInt').value) || 10 : 10,
      dry_run: $('#asDryRun') ? $('#asDryRun').checked : false,
      parar_ao_finalizar: $('#asPararApos') ? (parseInt($('#asPararApos').value, 10) || 0) : 0,
      loop: $('#asLoop') ? $('#asLoop').checked : false,
    };
  }

  // Calcula giros pelo alvo de roll: roll / bet. Aplica em "Spins Exatos" quando vazio
  // (o max-roll sozinho e apenas TETO; sem set-spins o bot faz so 30-60 giros por jogo).
  function calcularGirosRoll(cfg) {
    if (cfg.auto_roll || !cfg.max_roll || cfg.max_roll <= 0 || !cfg.bet_max || cfg.bet_max <= 0) return 0;
    return Math.ceil(cfg.max_roll / cfg.bet_max);
  }

  function atualizarDica() {
    const hint = $('#asCalcHint');
    if (!hint) return;
    const bet = parseFloat($('#asBetMax') ? $('#asBetMax').value : '') || 0;
    const roll = parseFloat($('#asMaxRoll') ? $('#asMaxRoll').value : '') || 0;
    const fixos = parseInt($('#asSetSpins') ? $('#asSetSpins').value : '') || 0;
    const auto = $('#asAutoRoll') ? $('#asAutoRoll').checked : false;
    if (auto && (fixos > 0 || roll > 0)) {
      hint.textContent = '⚠ Auto Roll ligado — ao INICIAR ele será desligado: o comando digitado (giros/roll) vence.';
      return;
    }
    if (auto) {
      hint.textContent = '⚙ Auto Roll: os giros saem do SALDO ÷ bet (o roll vira só teto).';
      return;
    }
    if (roll > 0 && bet > 0 && !fixos) {
      const calc = Math.ceil(roll / bet);
      hint.textContent = `🧮 R$ ${roll.toFixed(2)} ÷ R$ ${bet.toFixed(2)} = ${calc} giros (aplicado automaticamente).`;
      return;
    }
    if (roll > 0 && bet > 0 && fixos) {
      hint.textContent = `🧮 ${fixos} giros × R$ ${bet.toFixed(2)} = R$ ${(fixos * bet).toFixed(2)} de roll.`;
      return;
    }
    if (!roll && !fixos && !auto) {
      hint.textContent = 'Sem giros definidos: o bot faz 30-60 giros aleatórios por jogo.';
      return;
    }
    hint.textContent = '';
  }

  async function iniciar() {
    const sel = getSelecionados();
    const cfgTeste = $('#asDryRun') && $('#asDryRun').checked;
    if (!sel.contas.length && !cfgTeste) {
      toast('Selecione ao menos uma conta.', 'warn');
      return;
    }
    // Guardrails: bloqueia combinacoes que o bot recusaria (permite escolher antes de iniciar).
    const errosModo = validarModos();
    if (errosModo.length) {
      toast('Combinação inválida: ' + errosModo[0], 'warn');
      return;
    }
    // Mix "dividir em jogos": exige 2+ jogos distintos e 1 conta por jogo.
    if (mixLigado()) {
      const grupos = coletarMix() || [];
      const nomes = grupos.map(g => g.game);
      if (nomes.length < 2) {
        toast('Mix ligado: escolha pelo menos 2 jogos.', 'warn');
        return;
      }
      if (new Set(nomes).size !== nomes.length) {
        toast('Mix ligado: não repita o mesmo jogo em duas linhas.', 'warn');
        return;
      }
      if (!cfgTeste && sel.pares.length < nomes.length) {
        toast(`Mix ligado: ${nomes.length} jogos para ${sel.pares.length} conta(s) — cada jogo precisa de pelo menos 1 conta.`, 'warn');
        return;
      }
    }
    const config = { ...getConfig(), casas: sel.casas, contas: sel.contas, pares: sel.pares, ativas: true };
    // Comando digitado vence o Auto Roll: se o usuario definiu giros exatos ou teto de
    // roll, o Auto Roll e desligado (senao o bot ignoraria os 1000 spins e tiraria os
    // giros do saldo, sem chegar ao roll pedido).
    if (config.auto_roll && (config.set_spins > 0 || (config.max_roll && config.max_roll > 0))) {
      config.auto_roll = false;
      toast('Auto Roll desligado: usando o comando digitado (giros/roll).', 'warn');
    }
    // Calcula os giros pelo alvo de roll quando o usuario nao fixou spins
    const calculados = calcularGirosRoll(config);
    if (calculados > 0 && !config.set_spins) {
      config.set_spins = calculados;
    }
    // Confirmacao para lotes grandes (evita lancamento acidental com dinheiro real).
    const nContas = sel.pares.length;
    if (!cfgTeste && nContas >= 10) {
      const est = (config.set_spins > 0 && config.bet_max > 0)
        ? `\nRoll estimado: R$ ${(config.set_spins * config.bet_max * nContas).toFixed(2)}`
        : '';
      if (!confirm(`Iniciar ${nContas} contas de uma vez?${est}`)) return;
    }
    const btn = $('#asIniciar');
    btn.disabled = true;
    btn.textContent = 'Iniciando...';
    try {
      const r = await post('/api/autospin/iniciar', config);
      const pulados = (r.pulados || []).length;
      const emOndas = config.onda_tamanho > 0 && nContas > config.onda_tamanho;
      const sufixoOndas = emOndas ? ` · restantes em ondas de ${config.onda_tamanho} a cada ${config.onda_intervalo}s` : '';
      if (pulados) {
        toast(`${r.total} job(s) iniciado(s) · ${pulados} pulado(s): já rodando nessa conta.${sufixoOndas}`, 'warn');
      } else if (!r.total) {
        toast('Nenhuma conta com sessão ativa na seleção — abra/atualize as abas dessas contas e clique em "Sincronizar abertas".', 'warn');
      } else {
        toast(`${r.total} job(s) iniciado(s).${sufixoOndas}`, 'ok');
      }
      pollStatus();
      trocarSubaba('exec');
    } catch (e) {
      toast('Erro ao iniciar: ' + e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = '▶ Iniciar';
  }

  async function pararTodos() {
    paradaSeq += 1;
    const minhaSeq = paradaSeq;
    try {
      const r = await post('/api/autospin/parar', {});
      if (minhaSeq !== paradaSeq) return;
      const parados = (r && r.parados) || {};
      if (!Object.values(parados).some(v => v)) {
        toast('Nenhum job rodando.', 'warn');
        pollStatus();
        return;
      }
      toast('Parada solicitada — os jobs concluem a rodada e encerram.', 'warn');
      pollStatus();
      // Confirma o fim REAL: o motor ainda fica em 'parando' por ate ~2 min
      // (conclui a rodada e faz logout) — so avisa "parados" quando zerar.
      const inicio = Date.now();
      pararTimerSeq = minhaSeq;
      if (pararTimer) clearInterval(pararTimer);
      pararTimer = setInterval(async () => {
        // Prazo conferido ANTES do GET: vale mesmo se o servidor nao responder.
        if (pararTimerSeq !== minhaSeq) {
          clearInterval(pararTimer);
          pararTimer = null;
          return;
        }
        if (Date.now() - inicio > 180000) {
          clearInterval(pararTimer);
          pararTimer = null;
          toast('Parada em andamento — veja os cartões ("parando").', 'warn');
          return;
        }
        if (verificandoParada) return;
        verificandoParada = true;
        try {
          const d = await get('/api/autospin/status', 8000);
          if (pararTimerSeq !== minhaSeq) return;
          const ativos = Object.values(d || {}).filter(j => j.status === 'rodando' || j.status === 'parando').length;
          if (!ativos) {
            clearInterval(pararTimer);
            pararTimer = null;
            toast('Todos os jobs parados.', 'ok');
            pollStatus();
          }
        } catch { } finally {
          verificandoParada = false;
        }
      }, 3000);
    } catch (e) {
      if (minhaSeq === paradaSeq) toast('Erro ao parar: ' + e.message, 'err');
    }
  }

  async function limparFinalizados() {
    try {
      const r = await post('/api/autospin/limpar', {});
      toast(`${r.limpos || 0} job(s) removido(s) da lista.`, 'ok');
      pollStatus();
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
  }
  async function sincronizar() {
    const btn = $('#asSync');
    if (btn) { btn.disabled = true; btn.textContent = '⟳ Enviando sinal...'; }
    try {
      const r = await post('/api/autospin/sincronizar', {});
      if (r.status !== 'ok') {
        toast('Erro: ' + (r.motivo || 'falha'), 'err');
        if (btn) { btn.disabled = false; btn.textContent = '⟳ Sincronizar abertas'; }
        return;
      }
      toast('Sinal enviado. As abas abertas reportam em até ~15s (mescla, sem apagar).', 'ok');
      // Acompanha a chegada sem apagar nada: para quando estabilizar
      let tentativas = 0;
      let ultimoTotal = contasComSessao.length;
      let estavel = 0;
      const t = setInterval(async () => {
        tentativas++;
        await carregarContas();
        renderContasSelect();
        if (contasComSessao.length === ultimoTotal) estavel++; else estavel = 0;
        ultimoTotal = contasComSessao.length;
        if (estavel >= 4 || tentativas >= 25) {
          clearInterval(t);
          if (btn) { btn.disabled = false; btn.textContent = '⟳ Sincronizar abertas'; }
          toast(`${contasComSessao.length} contas ativas no painel.`, 'ok');
        }
      }, 3000);
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
      if (btn) { btn.disabled = false; btn.textContent = '⟳ Sincronizar abertas'; }
    }
  }

  async function pollStatus() {
    if (pollEmAndamento) return;
    pollEmAndamento = true;
    let d = null, resumo = null;
    try {
      d = await get('/api/autospin/status', 8000);
      resumo = await get('/api/autospin/resumo', 8000);
    } catch {
      const el = $('#asStatus');
      if (el && !$('#asSemConexao')) {
        const div = document.createElement('div');
        div.id = 'asSemConexao';
        div.className = 'as-sem-conexao';
        div.textContent = '⚠ Sem comunicação com o servidor — tentando reconectar…';
        el.prepend(div);
      }
      pollEmAndamento = false;
      return;
    }
    const av = $('#asSemConexao');
    if (av) av.remove();
    // Rodada terminou? Atualiza o Histórico sozinho (sem recarregar a página).
    const terminais = st => st === 'finalizado' || st === 'desconectada'
      || st === 'parado_pelo_usuario' || st === 'parado_gracioso'
      || (st || '').indexOf('erro') === 0;
    const algumFim = Object.keys(d || {}).some(jid => {
      const ant = ultimoJobs[jid];
      return ant && !terminais(ant.status) && terminais((d[jid] || {}).status);
    });
    if (algumFim) carregarHistorico();
    ultimoJobs = d || {};
    try {
      renderStatus(d, resumo);
    } catch (e) {
      console.error('Auto Spin: falha ao desenhar o status', e);
    }
    agendarPoll();
    pollEmAndamento = false;
  }

  // Ritmo do polling acompanha o tamanho do lote (servidor e navegador aliviam).
  function intervaloPoll() {
    const n = Object.keys(ultimoJobs || {}).length;
    return n > 30 ? 5000 : n > 10 ? 3000 : 2000;
  }

  function agendarPoll() {
    const ms = intervaloPoll();
    if (ms === pollIntervaloMs && pollTimer) return;
    pollIntervaloMs = ms;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, ms);
  }

  function rotuloStatus(s) {
    if (s === 'rodando') return 'rodando';
    if (s === 'parando') return 'parando — concluindo a rodada';
    if (s === 'parado_gracioso') return 'parado (rodada concluída, com logout)';
    if (s === 'parado_pelo_usuario') return 'parado pelo usuário';
    if (s === 'desconectada') return 'desconectada (faça login na casa)';
    if (s && s.indexOf('erro_rc_') === 0) return `erro (código ${s.slice(8)})`;
    return s;
  }

  const VAZIO_CAPRICHADO = `<div class="as-vazio as-vazio-caprichado">
    <div class="vazio-ico"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#e8cb91" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 8v4M12 8v4M15 8v4M4 15h16M12 18.2v.01"/></svg></div>
    <h3>Nenhuma execução em andamento</h3>
    <p>Escolha as contas na aba <b>Configurações</b> e clique em <b>Iniciar</b> — os logs aparecem aqui em tempo real, conta por conta.</p>
    <button class="btn go" onclick="window._asSubaba('config')">⚙ Ir para Configurações</button>
  </div>`;

  // Versao do card = o que muda o visual; cards com a mesma versao NAO sao
  // recriados (scroll preservado e menos re-render com muitos jobs).
  function versaoDoCard(jid, j, ehRodando) {
    const aberto = cardsEstado.has(jid) ? cardsEstado.get(jid) : ehRodando(j);
    const exp = logsExpandidos.get(jid);
    return [j.status, j.atualizado_em || '', aberto ? 1 : 0, exp ? (exp.quando || 1) : 0].join('|');
  }

  function cardHtml(jid, j, ehRodando, ehErro) {
    const statusClass = ehRodando(j) ? 'as-running' : ehErro(j) ? 'as-error' : 'as-done';
    const aberto = cardsEstado.has(jid) ? cardsEstado.get(jid) : ehRodando(j);
    const m = j.metricas || {};
    let html = `<div class="as-job ${statusClass} ${aberto ? '' : 'as-job--fechado'}" data-job="${escAttr(jid)}">
      <div class="as-job-head" role="button" tabindex="0" aria-expanded="${aberto}" onclick="window._asCard('${escAttr(escJs(jid))}')" title="${aberto ? 'Recolher' : 'Expandir'}">
        <span class="as-job-chev">${aberto ? '▾' : '▸'}</span>
        <b>${escHtml(String(j.casa))}/${escHtml(String(j.conta))}</b>
        <span class="as-job-status">${escHtml(rotuloStatus(j.status))}</span>
        ${j.alerta ? `<span class="as-job-alerta" title="${escAttr(String(j.alerta))}">⚠ ${escHtml(String(j.alerta))}</span>` : ''}
        <span class="as-job-time">${j.started_at ? new Date(j.started_at).toLocaleTimeString('pt-BR') : ''}</span>
      </div>`;
    if (!aberto) {
      const r = m.resumo || {};
      const lucro = (typeof r.lucro === 'number') ? r.lucro : null;
      return html + `<div class="as-job-resumo">
        <span>Roll <b>R$ ${fmt(m.roll)}</b></span>
        <span>${m.spins || 0} spins</span>
        ${lucro === null ? '' : `<span class="${lucro >= 0 ? 'as-pos' : 'as-neg'}">${lucro >= 0 ? '+' : '-'}R$ ${fmt(Math.abs(lucro))}</span>`}
        <span class="as-job-motivo">${r.motivo ? 'motivo: ' + escHtml(String(r.motivo)) : ''}</span>
      </div></div>`;
    }
    // Delta do saldo (numeros vivos): selinho verde quando o saldo sobe.
    let deltaSaldo = 0;
    if (m.saldo != null) {
      const antes = saldoAnterior[jid];
      if (antes != null && m.saldo - antes > 0.0001) deltaSaldo = m.saldo - antes;
      saldoAnterior[jid] = m.saldo;
    }
    html += `<div class="as-job-metrics">`;
    if (m.saldo) html += `<span>Saldo: R$ ${fmt(m.saldo)}${deltaSaldo > 0 ? ` <span class="as-delta">+R$ ${fmt(deltaSaldo)}</span>` : ''}</span>`;
    if (m.roll) html += `<span>Roll: R$ ${fmt(m.roll)}</span>`;
    if (m.spins) html += `<span>Spins: ${m.spins}</span>`;
    if (m.spins_calculados) html += `<span>Auto-roll: ${m.spins_calculados} spins</span>`;
    html += `</div>`;
    // Progresso do roll (Max Roll do job ou teto do lote).
    const cfg = j.config || {};
    const teto = Number(cfg.max_roll || 0) > 0 ? Number(cfg.max_roll) : (Number(cfg.roll_teto_lote || 0) > 0 ? Number(cfg.roll_teto_lote) : 0);
    const rollAtual = Number(m.roll || 0);
    if (teto > 0 && rollAtual > 0) {
      const pct = Math.min(100, Math.round((rollAtual / teto) * 100));
      html += `<div class="as-prog"><span class="as-prog-txt">Roll <b>R$ ${fmt(rollAtual)}</b> / R$ ${fmt(teto)}</span><span class="as-prog-trilha"><span class="as-prog-fill" style="width:${pct}%"></span></span><span class="as-prog-pct">${pct}%</span></div>`;
    }
    // Velocidade: acoes = giros pagos + re-spins (o Turbo acelera a cadeia).
    if (j.started_at && m.spins) {
      const decorrido = (Date.now() - new Date(j.started_at).getTime()) / 1000;
      if (decorrido > 3) {
        const acoes = Number(m.spins || 0) + Number(m.respins_vistos || 0);
        const velA = acoes / decorrido;
        const velG = Number(m.spins || 0) / decorrido;
        const mins = Math.floor(decorrido / 60), segs = Math.round(decorrido % 60);
        html += `<div class="as-job-metrics"><span>Velocidade: ${velA.toFixed(2)} ações/s (${velG.toFixed(2)} giros/s)</span><span>Tempo: ${mins}m${segs}s</span></div>`;
      }
    }
    // Quadro de log: ao vivo (janela leve do /status) ou historico sob demanda.
    const exp = logsExpandidos.get(jid);
    html += `<div class="as-logbox" data-joblog="${escAttr(jid)}" tabindex="0" role="region" aria-label="Log da execução">`;
    if (exp) {
      const linhasExp = (exp.spins && exp.spins.length) ? exp.spins : (exp.lines || []);
      html += `<div class="as-lognota">Histórico: últimas ${linhasExp.length} de ${exp.total} linha(s) — congelado às ${new Date(exp.quando).toLocaleTimeString('pt-BR')}</div>`;
      linhasExp.forEach(l => { html += `<div class="as-logline">${ansiToHtml(l)}</div>`; });
    } else {
      const linhas = (j.log_spins_recent && j.log_spins_recent.length)
        ? j.log_spins_recent
        : (j.log_lines_recent || []).slice(-8);
      if (!linhas.length) {
        html += `<div class="as-logline as-logvazia">aguardando giros...</div>`;
      } else {
        linhas.forEach(l => { html += `<div class="as-logline">${ansiToHtml(l)}</div>`; });
      }
    }
    html += `</div>`;
    html += `<div class="as-logacoes">` + (exp
      ? `<button class="btn mini ghost as-logmais" onclick="window._asLogMais('${escAttr(escJs(jid))}')">⟳ Atualizar histórico</button>` +
        `<button class="btn mini ghost as-logvivo" onclick="window._asLogVivo('${escAttr(escJs(jid))}')">↩ Voltar ao ao vivo</button>`
      : `<button class="btn mini ghost as-logmais" onclick="window._asLogMais('${escAttr(escJs(jid))}')">⤒ Carregar mais (até 400 linhas)</button>`) + `</div>`;
    // Cartão de fechamento (T7): números exatos do #RESUMO JSON do bot.
    if (m.resumo) {
      const r = m.resumo;
      const lucro = Number(r.lucro || 0);
      html += `<div class="as-fechamento ${lucro >= 0 ? 'as-fechamento--pos' : 'as-fechamento--neg'}">
        <span class="as-fechamento-titulo">Fechamento</span>
        <span><small>Entrada</small><b>R$ ${fmt(r.saldo_inicial)}</b></span>
        <span><small>Saída</small><b>R$ ${fmt(r.saldo_final)}</b></span>
        <span class="as-fechamento-lucro"><small>Lucro/Perda</small><b>${lucro >= 0 ? '+' : '-'}R$ ${fmt(Math.abs(lucro))}</b></span>
        <span><small>Rollover</small><b>R$ ${fmt(r.roll)}</b></span>
        <span><small>Spins</small><b>${r.spins ?? 0}</b></span>
        <span><small>Bônus</small><b>${r.bonus ?? 0}</b></span>
      </div>`;
    }
    return html + `</div>`;
  }

  function renderStatus(jobs, resumo) {
    const el = $('#asStatus');
    if (!el) return;
    const jids = Object.keys(jobs);
    // Poda de estado de jobs que sumiram (limpar finalizados) — evita vazamento.
    [...cardsEstado.keys()].forEach(k => { if (!(k in jobs)) cardsEstado.delete(k); });
    Object.keys(saldoAnterior).forEach(k => { if (!(k in jobs)) delete saldoAnterior[k]; });
    [...logsExpandidos.keys()].forEach(k => { if (!(k in jobs)) logsExpandidos.delete(k); });
    [...cardsVersoes.keys()].forEach(k => { if (!(k in jobs)) cardsVersoes.delete(k); });
    if (!jids.length) {
      el.innerHTML = VAZIO_CAPRICHADO;
      return;
    }
    // Uma caixa por conta (T8): mostra sempre o job mais recente de cada casa/conta.
    // (Defesa extra: o motor já limpa os antigos ao iniciar de novo na mesma conta.)
    const porConta = {};
    jids.forEach(jid => {
      const j = jobs[jid];
      const chave = `${j.casa}/${j.conta}`;
      const t = j.started_at || j.atualizado_em || '';
      const atual = porConta[chave];
      const tAtual = atual ? (atual.j.started_at || atual.j.atualizado_em || '') : '';
      if (!atual || t >= tAtual) porConta[chave] = { jid, j };
    });
    let visiveis = Object.values(porConta);
    // Filtro rápido (chips) + ordem: rodando primeiro, depois os mais recentes.
    const ehRodando = j => j.status === 'rodando' || j.status === 'parando';
    const ehErro = j => j.status.startsWith('erro') || j.status === 'desconectada';
    const totalVisiveis = visiveis.length;
    const contaRodando = visiveis.filter(x => ehRodando(x.j)).length;
    const contaErro = visiveis.filter(x => ehErro(x.j)).length;
    const contaFin = totalVisiveis - contaRodando - contaErro;
    visiveis = visiveis.filter(x => {
      if (filtroJobs === 'rodando') return ehRodando(x.j);
      if (filtroJobs === 'erros') return ehErro(x.j);
      if (filtroJobs === 'finalizados') return !ehRodando(x.j) && !ehErro(x.j);
      return true;
    });
    visiveis.sort((a, b) => {
      const ra = ehRodando(a.j) ? 0 : 1, rb = ehRodando(b.j) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return (b.j.started_at || '').localeCompare(a.j.started_at || '');
    });
    // Guarda quem estava colado no fim antes de redesenhar (nao atrapalha quem rolou para ler)
    const noFim = {};
    $$('.as-logbox').forEach(box => {
      noFim[box.dataset.joblog] = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
    });
    const chipsInner = `
      <button class="chip as-stat as-stat--filtro ${filtroJobs === 'todos' ? 'as-stat--ativo' : ''}" id="asFiltroTodos" onclick="window._asFiltro('todos')" title="Mostrar todos os jobs"><small>Todos</small><strong>${totalVisiveis}</strong></button>
      <button class="chip as-stat as-stat--filtro ${filtroJobs === 'rodando' ? 'as-stat--ativo' : ''}" id="asFiltroRodando" onclick="window._asFiltro('rodando')" title="Só os que estão girando agora"><small>Rodando</small><strong>${contaRodando}</strong></button>
      <button class="chip as-stat as-stat--filtro ${filtroJobs === 'finalizados' ? 'as-stat--ativo' : ''}" id="asFiltroFinalizados" onclick="window._asFiltro('finalizados')" title="Só os encerrados"><small>Finalizados</small><strong>${contaFin}</strong></button>
      <button class="chip as-stat as-stat--filtro ${filtroJobs === 'erros' ? 'as-stat--ativo' : ''}" id="asFiltroErros" onclick="window._asFiltro('erros')" title="Só os com erro/desconectadas"><small>Erros</small><strong>${contaErro}</strong></button>
      <span class="chip as-stat as-stat--roll"><small>Roll total</small><strong id="asChipRoll">R$ ${fmt(resumo.roll_total)}</strong></span>
      <span class="chip as-stat"><small>Spins</small><strong id="asChipSpins">${resumo.spins_total}</strong></span>`;
    let box = el.querySelector('#asCardsBox');
    if (!box) {
      // Primeira montagem (ou voltando do estado vazio): estrutura completa.
      el.innerHTML = `<div class="as-resumo">${chipsInner}</div><div id="asCardsBox"></div>`;
      box = el.querySelector('#asCardsBox');
      visiveis.forEach(({ jid, j }) => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = cardHtml(jid, j, ehRodando, ehErro);
        box.appendChild(wrapper.firstElementChild);
        cardsVersoes.set(jid, versaoDoCard(jid, j, ehRodando));
      });
    } else {
      const resumoEl = el.querySelector('.as-resumo');
      if (resumoEl) resumoEl.innerHTML = chipsInner;
      // Diff por card: so recria quem mudou (mantem DOM/scroll dos demais).
      const vistos = new Set();
      visiveis.forEach(({ jid, j }) => {
        vistos.add(jid);
        const versao = versaoDoCard(jid, j, ehRodando);
        const atual = [...box.children].find(c => c.dataset && c.dataset.job === jid) || null;
        if (atual && cardsVersoes.get(jid) === versao) return;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = cardHtml(jid, j, ehRodando, ehErro);
        const novo = wrapper.firstElementChild;
        if (atual) box.replaceChild(novo, atual); else box.appendChild(novo);
        cardsVersoes.set(jid, versao);
        const lb = novo.querySelector('.as-logbox');
        if (lb && noFim[jid] !== false) lb.scrollTop = lb.scrollHeight;
      });
      [...box.children].forEach(ch => {
        const id = ch.dataset ? ch.dataset.job : '';
        if (id && !vistos.has(id)) { ch.remove(); cardsVersoes.delete(id); }
      });
      let ph = box.querySelector('.as-filtro-vazio');
      if (!visiveis.length) {
        if (!ph) { ph = document.createElement('p'); ph.className = 'as-vazio as-filtro-vazio'; box.appendChild(ph); }
        ph.textContent = 'Nenhum job neste filtro.';
      } else if (ph) { ph.remove(); }
      // Reordena somente se a ordem visivel mudou (rodando primeiro).
      const ordemAtual = [...box.children].filter(c => c.dataset && c.dataset.job).map(c => c.dataset.job);
      const ordemAlvo = visiveis.map(v => v.jid);
      if (ordemAtual.join('|') !== ordemAlvo.join('|')) {
        ordemAlvo.forEach(id => { const n = [...box.children].find(c => c.dataset && c.dataset.job === id); if (n) box.appendChild(n); });
      }
    }
    // Números vivos nos chips (conta do valor antigo até o novo quando muda).
    const chipRoll = $('#asChipRoll'), chipSpins = $('#asChipSpins');
    const rollAlvo = Number(resumo.roll_total || 0), spinsAlvo = Number(resumo.spins_total || 0);
    const rollDe = (numsAnteriores.roll == null) ? rollAlvo : numsAnteriores.roll;
    const spinsDe = (numsAnteriores.spins == null) ? spinsAlvo : numsAnteriores.spins;
    animarNumero(chipRoll, rollDe, rollAlvo, v => 'R$ ' + fmt(v));
    animarNumero(chipSpins, spinsDe, spinsAlvo, v => String(Math.round(v)));
    if (rollDe !== rollAlvo && chipRoll) chipRoll.classList.add('as-num-vivo');
    if (spinsDe !== spinsAlvo && chipSpins) chipSpins.classList.add('as-num-vivo');
    numsAnteriores.roll = rollAlvo;
    numsAnteriores.spins = spinsAlvo;
    // Auto-scroll: caixa nova ou que ja estava no fim desce; quem rolou para ler fica onde esta.
    $$('.as-logbox').forEach(box => {
      if (noFim[box.dataset.joblog] !== false) box.scrollTop = box.scrollHeight;
    });
  }

  function tabelaHist(colunas, linhas) {
    let html = '<table class="as-tab"><thead><tr>' +
      colunas.map(c => `<th>${escHtml(c)}</th>`).join('') + '</tr></thead><tbody>';
    linhas.forEach(l => {
      html += '<tr>' + l.map(c => {
        if (c && typeof c === 'object' && 'html' in c) return `<td>${c.html}</td>`;
        return `<td>${typeof c === 'string' ? escHtml(c) : (c == null ? '' : c)}</td>`;
      }).join('') + '</tr>';
    });
    return html + '</tbody></table>';
  }

  async function carregarHistorico() {
    try {
      const params = new URLSearchParams();
      if (casaHistFiltro) params.set('casa', casaHistFiltro);
      if (periodoHist > 0) params.set('dias', String(periodoHist));
      const url = '/api/autospin/historico' + (params.toString() ? '?' + params.toString() : '');
      const d = await get(url);
      renderHistorico(d);
    } catch { /* silencioso */ }
  }

  function renderHistorico(d) {
    const chips = $('#asHistChips');
    const geral = (d && d.geral) || {};
    if (chips) {
      chips.innerHTML = `
        <span class="chip as-stat"><small>Execuções</small><strong>${geral.execucoes || 0}</strong></span>
        <span class="chip as-stat as-stat--roll"><small>Roll total</small><strong>R$ ${fmt(geral.roll)}</strong></span>
        <span class="chip as-stat"><small>Lucro total</small><strong>R$ ${fmt(geral.lucro)}</strong></span>
        <span class="chip as-stat"><small>Spins</small><strong>${geral.spins || 0}</strong></span>
        <span class="chip as-stat"><small>Bônus</small><strong>${geral.bonus || 0}</strong></span>`;
    }
    // Casas conhecidas alimentam o filtro (acumula entre respostas).
    ((d && d.por_conta) || []).forEach(c => { if (c.casa) casasHistorico.add(c.casa); });
    const selCasa = $('#asHistCasa');
    if (selCasa) {
      selCasa.innerHTML = ['<option value="">Todas as casas</option>']
        .concat([...casasHistorico].sort().map(c =>
          `<option value="${escAttr(c)}" ${c === casaHistFiltro ? 'selected' : ''}>${escHtml(c)}</option>`))
        .join('');
    }
    const tabR = $('#asHistRodadas');
    if (tabR) {
      const rodadas = (d && d.rodadas) || [];
      if (!rodadas.length) {
        tabR.innerHTML = '<p class="as-vazio">Nenhuma rodada registrada ainda.</p>';
      } else {
        tabR.innerHTML = rodadas.map(r => {
          const lucro = Number(r.lucro || 0);
          const quando = r.fim || r.inicio;
          const data = quando
            ? new Date(quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
            : '';
          const contas = (r.detalhes || []).map(c => {
            const l = Number(c.lucro || 0);
            return `<tr><td>${escHtml(String(c.casa || ''))}</td>` +
              `<td>${escHtml(String(c.conta || ''))}</td>` +
              `<td>R$ ${fmt(c.roll)}</td>` +
              `<td class="${l >= 0 ? 'as-pos' : 'as-neg'}">R$ ${fmt(c.lucro)}</td>` +
              `<td>${c.spins || 0}</td>` +
              `<td>${escHtml(String(c.motivo || ''))}${c.fonte === 'parcial' ? ' (parcial)' : ''}</td></tr>`;
          }).join('');
          return `<details class="as-rodada">
            <summary>
              <span class="as-rodada-quando">${data}</span>
              <b>${escHtml(String(r.casa || ''))}</b>
              <span class="as-rodada-jogo">${escHtml(String(r.game || ''))}</span>
              <span class="as-rodada-contas">${r.contas || 0} contas</span>
              <span>Roll <b>R$ ${fmt(r.roll)}</b></span>
              <span class="${lucro >= 0 ? 'as-pos' : 'as-neg'}">${lucro >= 0 ? '+' : '-'}R$ ${fmt(Math.abs(lucro))}</span>
              <span class="as-rodada-spins">${r.spins || 0} giros</span>
            </summary>
            <table class="as-tab"><thead><tr><th>Casa</th><th>Conta</th><th>Roll</th><th>Lucro</th><th>Giros</th><th>Motivo</th></tr></thead>
            <tbody>${contas}</tbody></table>
          </details>`;
        }).join('');
      }
    }
    const tabJ = $('#asHistJogos');
    if (tabJ) {
      const jogos = (d && d.por_jogo) || [];
      if (!jogos.length) {
        tabJ.innerHTML = '<p class="as-vazio">Sem execuções registradas ainda.</p>';
      } else {
        // Destaques: ⭐ nos 3 melhores lucros e ⚠ nos 3 piores (só com 4+ jogos).
        const marcar = jogos.length >= 4;
        const ordem = jogos.map((j, i) => i)
          .sort((a, b) => Number(jogos[b].lucro || 0) - Number(jogos[a].lucro || 0));
        const topSet = new Map(), piorSet = new Map();
        if (marcar) {
          ordem.slice(0, 3).forEach((i, pos) => topSet.set(i, pos + 1));
          ordem.slice(-3).forEach((i, pos) => piorSet.set(i, 3 - pos));
        }
        tabJ.innerHTML = tabelaHist(['Jogo', 'Exec', 'Spins', 'Roll', 'Lucro', 'Bônus'],
          jogos.map((j, i) => {
            let nome = escHtml(String(j.game || ''));
            let selo = '';
            if (topSet.has(i)) {
              nome = '<span class="as-estrela">⭐</span> ' + nome;
              selo = { html: `<span class="as-selo as-selo--top">TOP ${topSet.get(i)}</span>` };
            } else if (piorSet.has(i)) {
              nome = '<span class="as-pior">⚠</span> ' + nome;
              selo = { html: `<span class="as-selo as-selo--low">PIOR ${piorSet.get(i)}</span>` };
            }
            const lucroCell = selo
              ? { html: `${'R$ ' + fmt(j.lucro)} ${selo.html}` }
              : 'R$ ' + fmt(j.lucro);
            return [{ html: nome }, j.execucoes, j.spins, 'R$ ' + fmt(j.roll), lucroCell, j.bonus];
          }));
      }
    }
    const tabC = $('#asHistContas');
    if (tabC) {
      const contas = (d && d.por_conta) || [];
      tabC.innerHTML = contas.length
        ? tabelaHist(['Conta', 'Exec', 'Roll', 'Lucro', 'Bônus'],
            contas.map(c => [c.casa + '/' + c.conta, c.execucoes, 'R$ ' + fmt(c.roll), 'R$ ' + fmt(c.lucro), c.bonus]))
        : '<p class="as-vazio">Sem execuções registradas ainda.</p>';
    }
    const tabU = $('#asHistUltimas');
    if (tabU) {
      const ultimas = (d && d.ultimas) || [];
      tabU.innerHTML = ultimas.length
        ? tabelaHist(['Quando', 'Conta', 'Jogo', 'Roll', 'Lucro', 'Spins', 'Motivo'],
            ultimas.map(u => [
              u.finalizado_em ? new Date(u.finalizado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '',
              u.casa + '/' + u.conta, u.game, 'R$ ' + fmt(u.roll), 'R$ ' + fmt(u.lucro), u.spins,
              (u.motivo || '') + (u.fonte === 'parcial' ? ' (parcial)' : '')]))
        : '<p class="as-vazio">Sem execuções registradas ainda.</p>';
    }
  }

  async function carregarProxies() {
    try {
      const d = await get('/api/autospin/proxies/saude');
      renderProxies(d);
    } catch { /* silencioso */ }
  }

  function renderProxies(d) {
    const el = $('#asProxyResumo');
    if (!el) return;
    if (!d || !d.total) {
      el.textContent = 'Nenhum teste ainda — clique em Testar agora.';
      return;
    }
    const quando = d.quando ? new Date(d.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    el.innerHTML = `<b>${d.vivas}/${d.total}</b> vivas · mediana <b>${d.ms_mediana == null ? '—' : d.ms_mediana} ms</b> · p90 ${d.ms_p90 == null ? '—' : d.ms_p90} ms${d.amostra ? ' (amostra)' : ''}<br><small>Último teste: ${quando}</small>`;
    const mortas = $('#asProxyMortas');
    if (mortas) {
      mortas.textContent = d.mortas
        ? `${d.mortas} morta(s)${(d.mortas_lista || []).length ? ' — ex.: ' + (d.mortas_lista || []).slice(0, 5).join(', ') : ''}`
        : 'Nenhuma morta.';
    }
  }

  async function testarProxies() {
    const btn = $('#asProxyTestar');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '⚡ Testando... (pode levar ~1 min)';
    try {
      const d = await post('/api/autospin/proxies/testar', {});
      renderProxies(d);
      carregarScoreProxies();
      toast(`${d.vivas}/${d.total} proxies vivas (mediana ${d.ms_mediana == null ? '—' : d.ms_mediana} ms).`, d.vivas ? 'ok' : 'warn');
    } catch (e) {
      toast('Erro no teste de proxies: ' + e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = '⚡ Testar agora (~1 min)';
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escAttr(s) { return escHtml(String(s)).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function escJs(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n'); }

  // Cores ANSI do terminal -> HTML (mesma paleta que o bot usa: 11 vermelho, 92 verde,
  // 93 amarelo, 94 azul, 95 magenta, 96 ciano, 97 branco + negrito)
  const ANSI_CORES = {
    30: '#000000', 31: '#e74c3c', 32: '#27ae60', 33: '#f1c40f', 34: '#3498db',
    35: '#9b59b6', 36: '#1abc9c', 37: '#ecf0f1',
    90: '#7f8c8d', 11: '#ff6b6b', 92: '#5ee0a3', 93: '#ffd93d', 94: '#5dade2',
    95: '#d47fff', 96: '#6ee7f9', 97: '#ffffff',
  };
  const ANSI_FUNDOS = {
    40: '#000000', 41: '#7c1d1d', 42: '#1d5c3a', 43: '#6b5310', 44: '#1d3a6b',
    45: '#5c1d6b', 46: '#0f5c52', 47: '#3a3a3a',
    100: '#4a4a4a', 101: '#a03030', 102: '#2a8a55', 103: '#8a7418', 104: '#2a5da0',
    105: '#7a2a8a', 106: '#188a7a', 107: '#666666',
  };

  function ansiToHtml(texto) {
    const partes = String(texto).split(/\x1b\[([0-9;]*)m/);
    let cor = null, fundo = null, negrito = false;
    let out = '';
    for (let i = 0; i < partes.length; i++) {
      if (i % 2 === 0) {
        const t = escHtml(partes[i]);
        if (!t) continue;
        const estilos = [];
        if (cor) estilos.push('color:' + cor);
        if (fundo) estilos.push('background:' + fundo);
        if (negrito) estilos.push('font-weight:700');
        out += estilos.length ? `<span style="${estilos.join(';')}">${t}</span>` : t;
      } else {
        const codigos = (partes[i] || '0').split(';');
        for (const c of codigos) {
          const n = parseInt(c || '0', 10);
          if (n === 0) { cor = null; fundo = null; negrito = false; }
          else if (n === 1) negrito = true;
          else if (n === 22) negrito = false;
          else if (ANSI_CORES[n]) cor = ANSI_CORES[n];
          else if (ANSI_FUNDOS[n]) fundo = ANSI_FUNDOS[n];
          else if (n === 39) cor = null;
          else if (n === 49) fundo = null;
        }
      }
    }
    return out;
  }

  async function atualizarCatalogos() {
    const btn = $('#asAtualizarCat');
    if (btn) { btn.disabled = true; btn.textContent = '⟳ Atualizando (pode levar ~1 min)...'; }
    try {
      const r = await post('/api/autospin/catalogos/atualizar', {});
      if (r.status === 'ok') {
        const total = (r.catalogos || []).reduce((s, c) => s + c.total, 0);
        toast(`${r.catalogos.length} provedores / ${total} jogos atualizados.`, 'ok');
        await carregarCatalogos();
        renderProvedorOptions();
        await carregarJogos(provedorAtual);
        renderGameOptions();
        atualizarAvisoProvedor();
      } else {
        toast('Erro: ' + (r.motivo || 'falha'), 'err');
      }
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
    if (btn) { btn.disabled = false; btn.textContent = '⟳ Atualizar catálogos de jogos'; }
  }

  function toast(msg, tipo) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show ' + (tipo === 'err' ? 'err' : tipo === 'warn' ? 'warn' : 'ok');
    setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  function renderGameOptions() {
    const sel = $('#asGame');
    if (!sel) return;
    let html = '<option value="">— Aleatório (todos os jogos) —</option>';
    jogos.forEach(j => { html += `<option value="${escAttr(j)}">${escHtml(j)}</option>`; });
    sel.innerHTML = html;
  }

  let subabaAtiva = 'config';
  let filtroJobs = 'todos';
  let ultimoJobs = {};
  let casaHistFiltro = '';
  let periodoHist = 0;
  const cardsEstado = new Map();
  const saldoAnterior = {};
  const numsAnteriores = {};
  const casasHistorico = new Set();
  const logsExpandidos = new Map();   // jid -> snapshot do log sob demanda ("carregar mais")
  const cardsVersoes = new Map();     // jid -> versao renderizada (diff por card)

  // Guardrails de combinacoes (espelham os parser.error do bot) e rotulos curtos.
  const ROTULOS_MODOS = { asZerarSaldo: 'Zerar Saldo', asZerarSaldoTotal: 'Zerar Total', asColetarBonus: 'Coletar Bônus', asAbrirJogos: 'Abrir Jogos', asGemTrava: 'Gem Trava', asComprarBonus: 'Comprar Bônus', asPgTrava: 'PG Trava' };
  const CONFLITOS_MODOS = {
    asZerarSaldo: ['asAbrirJogos', 'asColetarBonus', 'asPgTrava', 'asGemTrava', 'asComprarBonus'],
    asZerarSaldoTotal: ['asAbrirJogos', 'asColetarBonus', 'asPgTrava', 'asGemTrava', 'asComprarBonus'],
    asColetarBonus: ['asAbrirJogos', 'asComprarBonus', 'asPgTrava', 'asZerarSaldo', 'asZerarSaldoTotal', 'asGemTrava'],
    asAbrirJogos: ['asColetarBonus', 'asComprarBonus', 'asZerarSaldo', 'asZerarSaldoTotal', 'asGemTrava'],
    asGemTrava: ['asAbrirJogos', 'asColetarBonus', 'asComprarBonus', 'asPgTrava', 'asZerarSaldo', 'asZerarSaldoTotal'],
    asComprarBonus: ['asColetarBonus', 'asAbrirJogos', 'asZerarSaldo', 'asZerarSaldoTotal'],
    asPgTrava: ['asZerarSaldo', 'asZerarSaldoTotal', 'asGemTrava'],
  };

  function rotuloModo(id) { return ROTULOS_MODOS[id] || id; }

  function modosAtivos() {
    const v = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) || 0 : 0; };
    const c = id => { const el = document.getElementById(id); return !!(el && el.checked); };
    return {
      zerar: c('asZerarSaldo') || c('asZerarSaldoTotal'),
      coletar: c('asColetarBonus'), abrir: c('asAbrirJogos'), pg: c('asPgTrava'),
      gem: v('asGemTrava') > 0, comprar: v('asComprarBonus') > 0,
      meta: v('asMeta') > 0, saldoLimite: v('asSaldoLimite') > 0,
      autoroll: c('asAutoRoll'), betPercent: v('asBetPercent') > 0, bet: v('asBetMax'),
    };
  }

  function validarModos() {
    const m = modosAtivos();
    const erros = [];
    if (m.zerar && (m.abrir || m.coletar || m.pg || m.gem || m.comprar)) erros.push('Zerar Saldo não combina com Abrir Jogos/Coletar/PG Trava/Gem/Comprar.');
    if (m.zerar && (m.meta || m.saldoLimite)) erros.push('Zerar Saldo não combina com Meta/Saldo limite.');
    if (m.coletar && m.abrir) erros.push('Coletar Bônus não combina com Abrir Jogos.');
    if (m.coletar && m.comprar) erros.push('Coletar Bônus não combina com Comprar Bônus.');
    if (m.comprar && m.abrir) erros.push('Comprar Bônus não combina com Abrir Jogos.');
    if (m.gem && (m.abrir || m.coletar || m.comprar || m.pg)) erros.push('Gem Trava roda sozinho (não combina com Abrir/Coletar/Comprar/PG Trava).');
    if (m.autoroll && m.betPercent) erros.push('Auto Roll não combina com Bet %.');
    if (m.autoroll && !m.bet) erros.push('Auto Roll exige Bet Máxima.');
    return erros;
  }

  function limparConflitos(origem) {
    const lista = CONFLITOS_MODOS[origem];
    if (!lista) return;
    const el = document.getElementById(origem);
    if (!el) return;
    const ligado = el.type === 'checkbox' ? el.checked : (parseFloat(el.value) || 0) > 0;
    if (!ligado) return;
    const desligou = [];
    lista.forEach(id => {
      const alvo = document.getElementById(id);
      if (!alvo) return;
      if (alvo.type === 'checkbox' && alvo.checked) { alvo.checked = false; desligou.push(rotuloModo(id)); }
      else if (alvo.type === 'number' && (parseFloat(alvo.value) || 0) > 0) { alvo.value = ''; desligou.push(rotuloModo(id)); }
    });
    if (desligou.length) toast(`${desligou.join(', ')} desligado(s): incompatível(is) com ${rotuloModo(origem)}.`, 'warn');
  }

  function prefersReduzirMovimento() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Numero "vivo": conta suave do valor antigo ate o novo (respeita reduced-motion).
  function animarNumero(el, de, para, formatador) {
    if (!el) return;
    if (prefersReduzirMovimento() || !isFinite(de) || de === para) {
      el.textContent = formatador(para);
      return;
    }
    const t0 = performance.now(), dur = 450;
    const passo = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const v = de + (para - de) * (1 - Math.pow(1 - p, 3));
      el.textContent = formatador(v);
      if (p < 1) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }

  function alternarCard(jid) {
    const j = ultimoJobs[jid] || {};
    const atual = cardsEstado.has(jid) ? cardsEstado.get(jid) : (j.status === 'rodando' || j.status === 'parando');
    cardsEstado.set(jid, !atual);
    pollStatus();
  }

  function alternarTodosCards(aberto) {
    Object.keys(ultimoJobs).forEach(jid => cardsEstado.set(jid, aberto));
    pollStatus();
  }

  function trocarFiltroJobs(f) {
    filtroJobs = f;
    pollStatus();
  }

  function trocarCasaHistorico(casa) {
    casaHistFiltro = casa || '';
    carregarHistorico();
  }

  function trocarPeriodoHistorico(dias) {
    periodoHist = parseInt(dias, 10) || 0;
    carregarHistorico();
  }

  async function carregarScoreProxies() {
    try {
      const d = await get('/api/autospin/proxies/score');
      renderScoreProxies(d);
    } catch { /* silencioso */ }
  }

  function renderScoreProxies(d) {
    const el = $('#asProxyScore');
    if (!el) return;
    if (!d || !d.ativo) {
      el.textContent = 'Score: desligado (sorteio normal de proxies).';
      return;
    }
    const quando = d.quando ? new Date(d.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const aviso = d.vence ? ' — ⚠ vencido (>3 dias): será ignorado nos próximos jobs' : ' (vale por 3 dias)';
    el.innerHTML = `Score <b>ativo</b>: ${d.total} proxies ordenadas (melhor ${d.ms_melhor} ms · pior ${d.ms_pior} ms).<br><small>Atualizado: ${quando}${aviso}</small>`;
  }

  async function carregarLogMais(jid) {
    try {
      const d = await get('/api/autospin/job/' + encodeURIComponent(jid) + '/log?tail=400');
      logsExpandidos.set(jid, { spins: d.spins || [], lines: d.lines || [],
                                total: d.total_lines || 0, quando: Date.now() });
      pollStatus();
    } catch (e) {
      toast('Erro ao carregar o log: ' + e.message, 'err');
    }
  }

  function voltarLogVivo(jid) {
    logsExpandidos.delete(jid);
    pollStatus();
  }

  async function limparScoreProxies() {
    try {
      await post('/api/autospin/proxies/score/limpar', {});
      toast('Score removido: volta ao sorteio normal no próximo job.', 'ok');
      carregarScoreProxies();
    } catch (e) {
      toast('Erro: ' + e.message, 'err');
    }
  }

  async function limparHistorico() {
    if (!confirm('Limpar TODO o histórico de execuções?\n\nOs arquivos de log em disco serão ARQUIVADOS (não apagados).')) return;
    try {
      const r = await post('/api/autospin/historico/limpar', {});
      toast(`Histórico limpo: ${r.removidos || 0} execução(ões) · ${r.logs_arquivados || 0} log(s) arquivado(s).`, 'ok');
      carregarHistorico();
    } catch (e) {
      toast('Erro ao limpar histórico: ' + e.message, 'err');
    }
  }

  function trocarSubaba(t) {
    subabaAtiva = t;
    $$('.as-subaba').forEach(b => b.classList.toggle('as-subaba--ativa', b.dataset.sub === t));
    ['config', 'exec', 'hist'].forEach(k => {
      const el = document.getElementById('asTab' + k.charAt(0).toUpperCase() + k.slice(1));
      if (el) el.style.display = (k === t) ? '' : 'none';
    });
  }

  function init() {
    const app = $('#autospinApp');
    if (!app) return;

    app.innerHTML = `
    <div class="as-subabas" role="tablist" aria-label="Seções do Auto Spin">
      <button class="as-subaba as-subaba--ativa" id="asSubConfig" data-sub="config" onclick="window._asSubaba('config')">⚙ Configurações</button>
      <button class="as-subaba" id="asSubExec" data-sub="exec" onclick="window._asSubaba('exec')">▶ Execução</button>
      <button class="as-subaba" id="asSubHist" data-sub="hist" onclick="window._asSubaba('hist')">📊 Histórico &amp; Rede</button>
    </div>
    <div id="asTabConfig" class="as-tabpane">
    <div class="as-grid">
      <div class="as-config">
        <div class="as-section-heading">
          <span class="as-eyebrow">CONFIGURAÇÕES</span>
          <h3>Parâmetros da execução</h3>
          <p class="as-section-caption">Valores em reais. Quantidades em giros ou contas, conforme o campo.</p>
        </div>
        <fieldset class="as-group">
        <legend>Catálogo</legend>
        <div class="as-row as-row--catalogo">
          <div class="as-field"><label for="asProvedor">Provedor</label><select id="asProvedor"></select></div>
          <div class="as-field"><label for="asGame">Jogo</label><select id="asGame"></select></div>
        </div>
        <div class="as-hint" id="asProvAviso" style="display:none"></div>
        <div class="as-catalog-actions"><button class="btn mini ghost" id="asAtualizarCat" onclick="window._asAtualizarCat()">⟳ Atualizar catálogos de jogos</button></div>
        </fieldset>
        <fieldset class="as-group" id="asMixGrupo">
        <legend style="display:flex;align-items:center;gap:8px">🎲 Dividir em jogos (mix)
          <label class="as-mix-toggle"><input type="checkbox" id="asMixOn"><span>ativar divisão</span></label>
        </legend>
        <div id="asMixCorpo" style="display:none">
          <p class="as-section-caption">As contas selecionadas são divididas por igual entre os jogos (a sobra vai aleatória). Máx. 4 jogos · pode misturar casas. Com o mix ligado, o Jogo/Bet/Giros/Max Roll acima são ignorados — cada jogo manda.</p>
          <div id="asMixJogos"></div>
          <div class="as-mix-acoes">
            <button class="btn mini" id="asMixAdd" onclick="window._asMixAdd()">+ Adicionar jogo (até 4)</button>
            <span class="as-mix-previa" id="asMixPrevia"></span>
          </div>
        </div>
        </fieldset>
        <fieldset class="as-group">
        <legend>Limites e quantidades</legend>
        <div class="as-row">
          <div class="as-field"><label for="asBetMax">Bet Máxima (R$)</label><input type="number" id="asBetMax" step="0.01" min="0.01" placeholder="0.50"></div>
          <div class="as-field"><label for="asMaxSpin">Max Spins/Jogo</label><input type="number" id="asMaxSpin" min="0" placeholder="0=aleatório"></div>
          <div class="as-field"><label for="asSetSpins">Spins Exatos</label><input type="number" id="asSetSpins" min="0" placeholder="0=desligado"></div>
        </div>
        <div class="as-row">
          <div class="as-field"><label for="asMaxRoll">Max Roll (R$)</label><input type="number" id="asMaxRoll" step="0.01" min="0" placeholder="0=desligado"></div>
          <div class="as-field"><label for="asMeta">Meta Saldo (R$)</label><input type="number" id="asMeta" step="0.01" min="0" placeholder="0=desligado"></div>
          <div class="as-field"><label for="asMaxGame">Max Jogos</label><input type="number" id="asMaxGame" min="0" placeholder="0=todos"></div>
        </div>
        <div class="as-row">
          <div class="as-field"><label for="asRollTeto">Teto roll do lote (R$)</label><input type="number" id="asRollTeto" step="0.01" min="0" placeholder="0=desligado"></div>
        </div>
        <div class="as-hint" id="asCalcHint"></div>
        </fieldset>
        <details class="as-group as-grupo-recolhivel">
        <summary>▸ Opções adicionais (trava, bônus, velocidade)</summary>
        <div class="as-grupo-corpo">
        <div class="as-row">
          <div class="as-field"><label for="asGemTrava">Gem Trava Bet</label><input type="number" id="asGemTrava" step="0.01" min="0" placeholder="0=desligado"></div>
          <div class="as-field"><label for="asComprarBonus">Comprar Bonus (Qtd)</label><input type="number" id="asComprarBonus" min="0" placeholder="0=desligado"></div>
          <div class="as-field"><label for="asPararApos">Parar após N contas</label><input type="number" id="asPararApos" min="0" placeholder="0=desligado"></div>
        </div>
        <div class="as-checks">
          <label><input type="checkbox" id="asAutoRoll"><span>Auto Roll<small>Cálculo de giros pelo saldo</small></span></label>
          <label><input type="checkbox" id="asPgTrava"><span>PG Trava<small>Pula ao encontrar bônus</small></span></label>
          <label><input type="checkbox" id="asZerarSaldo"><span>Zerar Saldo</span></label>
          <label><input type="checkbox" id="asZerarSaldoTotal"><span>Zerar Saldo Total</span></label>
          <label><input type="checkbox" id="asColetarBonus"><span>Coletar Bônus</span></label>
          <label><input type="checkbox" id="asNoProxy"><span>Sem Proxy<small>Conexão direta nos giros</small></span></label>
          <label><input type="checkbox" id="asModoRapido"><span>Modo Rápido<small>Intervalo menor entre giros</small></span></label>
          <label><input type="checkbox" id="asTurbo" checked><span>Turbo<small>Intervalo mínimo configurado</small></span></label>
          <label><input type="checkbox" id="asProxySempre" checked><span>Proxy Total<small>Roteamento dos giros pelo proxy</small></span></label>
          <label><input type="checkbox" id="asStealth" checked><span>Stealth<small>Transporte com TLS de navegador (padrão)</small></span></label>
          <label><input type="checkbox" id="asLoop"><span>Loop<small>Repetir a lista</small></span></label>
        </div>
        </div>
        </details>
        <details class="as-group as-grupo-recolhivel">
        <summary>▸ Avançado (extrato, abrir jogos, limites finos)</summary>
        <div class="as-grupo-corpo">
        <div class="as-row">
          <div class="as-field"><label for="asBetPercent">Bet % do saldo</label><input type="number" id="asBetPercent" step="0.1" min="0" placeholder="0=desligado"></div>
          <div class="as-field"><label for="asSaldoLimite">Saldo limite (R$)</label><input type="number" id="asSaldoLimite" step="0.01" min="0" placeholder="0=desligado"></div>
          <div class="as-field"><label for="asAbrirJogosN">Abrir jogos (N)</label><input type="number" id="asAbrirJogosN" min="0" placeholder="0=todos"></div>
        </div>
        <div class="as-row">
          <div class="as-field"><label for="asGemHp">Gem HP (trava)</label><input type="number" id="asGemHp" step="1" min="0" placeholder="0=padrão"></div>
          <div class="as-field"><label for="asAccountId">Account ID (extrato)</label><input type="text" id="asAccountId" placeholder="vazio=automático"></div>
          <div class="as-field"><label for="asBonusDias">Extrato: dias</label><input type="number" id="asBonusDias" min="0" placeholder="padrão"></div>
        </div>
        <div class="as-row">
          <div class="as-field"><label for="asOndaTam">Ondas: contas por vez</label><input type="number" id="asOndaTam" min="0" placeholder="0=desligado (todas de uma vez)"></div>
          <div class="as-field"><label for="asOndaInt">Ondas: intervalo (s)</label><input type="number" id="asOndaInt" min="1" step="1" placeholder="10"></div>
        </div>
        <div class="as-checks">
          <label><input type="checkbox" id="asAbrirJogos"><span>Abrir Jogos<small>Só loga nos jogos (sem girar)</small></span></label>
          <label><input type="checkbox" id="asBau"><span>Gem: travar no Baú<small>Junto com Gem Trava</small></span></label>
          <label><input type="checkbox" id="asSemExtrato"><span>Sem Extrato<small>Coleta jogo a jogo</small></span></label>
          <label><input type="checkbox" id="asDryRun"><span>🧪 Modo Teste<small>Dry-run: bot falso, sem rede nem contas</small></span></label>
        </div>
        </div>
        </details>
        <div class="as-actions">
          <button class="btn go" id="asIniciar" onclick="window._asIniciar()">▶ Iniciar</button>
          <button class="btn danger" id="asParar" onclick="window._asParar()">⏹ Parar Todos</button>
        </div>
      </div>
      <div class="as-contas">
        <div class="as-contas-head">
          <div><span class="as-eyebrow">SESSÕES</span><h3>Contas no painel</h3></div>
          <button class="btn mini ghost" id="asSync" onclick="window._asSync()" title="Solicita uma atualização da lista de sessões, sem apagar o histórico">⟳ Sincronizar abertas</button>
        </div>
        <p class="as-section-caption">Contas agrupadas por casa, com o domínio de origem abaixo de cada identificação.</p>
        <div id="asContasList"></div>
        <p class="as-list-note">Role a lista para ver as demais contas.</p>
      </div>
    </div>
    </div>
    <div id="asTabExec" class="as-tabpane" style="display:none">
    <div class="as-status-area">
      <div class="as-contas-head">
        <div><span class="as-eyebrow">ACOMPANHAMENTO</span><h3>Status em tempo real</h3></div>
        <div class="as-toolbar">
          <button class="btn mini ghost" id="asRecolherTodos" onclick="window._asCards(false)" title="Recolhe todos os cards de job">▸ Recolher todos</button>
          <button class="btn mini ghost" id="asExpandirTodos" onclick="window._asCards(true)" title="Expande todos os cards de job">▾ Expandir todos</button>
          <button class="btn mini ghost" id="asLimpar" onclick="window._asLimpar()" title="Remove da lista os jobs finalizados/parados">🧹 Limpar finalizados</button>
          <button class="btn mini ghost" id="asPararTudo" onclick="window._asParar()" title="Interrompe todos os jobs em execucao">⏹ Parar todos</button>
        </div>
      </div>
      <div class="as-status-intro">
        <p class="as-section-caption">Logs individuais, com rolagem dentro de cada caixa.</p>
        <ul class="as-status-legend" aria-label="Legenda dos estados">
          <li class="as-legend-running">Rodando</li>
          <li class="as-legend-done">Encerrado</li>
          <li class="as-legend-error">Erro</li>
          <li class="as-legend-error">Desconectada</li>
        </ul>
      </div>
      <div id="asStatus">${VAZIO_CAPRICHADO}</div>
    </div>
    </div>
    <div id="asTabHist" class="as-tabpane" style="display:none">
    <div class="as-bottom">
      <div class="as-historico-area">
        <div class="as-contas-head">
          <div><span class="as-eyebrow">RESULTADOS</span><h3>Histórico de execuções</h3></div>
          <div class="as-toolbar">
            <select id="asHistCasa" onchange="window._asHistCasa(this.value)" title="Filtrar por casa"></select>
            <select id="asHistPeriodo" onchange="window._asHistPeriodo(this.value)" title="Filtrar por período">
              <option value="0">Todo o período</option>
              <option value="1">Hoje</option>
              <option value="7">Últimos 7 dias</option>
              <option value="30">Últimos 30 dias</option>
            </select>
            <button class="btn mini ghost" id="asHistAtualizar" onclick="window._asHistAtualizar()" title="Recarrega os números do histórico">⟳ Atualizar</button>
            <button class="btn mini ghost" id="asHistLimpar" onclick="window._asHistLimpar()" title="Limpa o histórico de execuções e arquiva os logs em disco">🧹 Limpar histórico</button>
          </div>
        </div>
        <p class="as-section-caption">Números exatos do #RESUMO de cada job finalizado (grava sozinho).</p>
        <div id="asHistChips" class="as-resumo"></div>
        <h4>Rodadas <small class="as-rodada-dica">(cada lote lançado junto vira uma linha — clique para ver as contas)</small></h4>
        <div id="asHistRodadas" class="as-rodadas"></div>
        <div class="as-hist-grid">
          <div>
            <h4>Por jogo</h4>
            <div id="asHistJogos" class="as-hist-tabela"></div>
          </div>
          <div>
            <h4>Por conta</h4>
            <div id="asHistContas" class="as-hist-tabela"></div>
          </div>
        </div>
        <h4>Últimas execuções</h4>
        <div id="asHistUltimas" class="as-hist-tabela"></div>
      </div>
      <div class="as-proxies-area">
        <div class="as-contas-head">
          <div><span class="as-eyebrow">REDE</span><h3>Proxies do jogo</h3></div>
        </div>
        <p class="as-section-caption">Saúde das proxies fixas usadas nos giros.</p>
        <div id="asProxyResumo" class="as-proxy-resumo">Nenhum teste ainda.</div>
        <div class="as-toolbar">
          <button class="btn mini ghost" id="asProxyTestar" onclick="window._asProxyTestar()">⚡ Testar agora (~1 min)</button>
          <button class="btn mini ghost" id="asProxyScoreLimpar" onclick="window._asProxyScoreLimpar()" title="O bot volta ao sorteio aleatorio de proxies">↺ Limpar score</button>
        </div>
        <div id="asProxyScore" class="as-proxy-score"></div>
        <div id="asProxyMortas" class="as-proxy-mortas"></div>
      </div>
    </div>
    </div>
    `;

    window._asIniciar = iniciar;
    window._asParar = pararTodos;
    window._asSync = sincronizar;
    window._asAtualizarCat = atualizarCatalogos;
    window._asLimpar = limparFinalizados;
    window._asHistAtualizar = carregarHistorico;
    window._asProxyTestar = testarProxies;
    window._asSubaba = trocarSubaba;
    window._asCard = alternarCard;
    window._asCards = alternarTodosCards;
    window._asFiltro = trocarFiltroJobs;
    window._asHistCasa = trocarCasaHistorico;
    window._asHistLimpar = limparHistorico;
    window._asHistPeriodo = trocarPeriodoHistorico;
    window._asProxyScoreLimpar = limparScoreProxies;
    window._asLogMais = carregarLogMais;
    window._asLogVivo = voltarLogVivo;
    trocarSubaba(subabaAtiva);

    // Dica de calculo reage a bet / roll / spins
    ['asBetMax', 'asMaxRoll', 'asSetSpins', 'asAutoRoll'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.addEventListener('input', atualizarDica); el.addEventListener('change', atualizarDica); }
    });
    atualizarDica();

    // Guardrails: um modo exclusivo ligado desliga os incompatíveis (avisa no toast).
    Object.keys(ROTULOS_MODOS).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => limparConflitos(id));
    });

    // Provedor e jogo
    renderProvedorOptions();
    renderGameOptions();
    const prov = $('#asProvedor');
    if (prov) prov.addEventListener('change', async () => {
      provedorAtual = parseInt(prov.value, 10) || 200;
      _ultimoJogoBuscado = '';
      await carregarJogos(provedorAtual);
      renderGameOptions();
      atualizarAvisoProvedor();
    });
    const jogoSel = $('#asGame');
    if (jogoSel) jogoSel.addEventListener('change', buscarEmOutrosProvedores);
    atualizarAvisoProvedor();

    renderGameOptions();
    carregarContas().then(renderContasSelect);
    carregarTodosJogos().then(() => { initMix(); renderMixOptions(); atualizarPreviaMix(); });
    carregarHistorico();
    carregarProxies();
    carregarScoreProxies();

    // Apenas reorganiza os controles existentes e apresenta um resumo de leitura.
    if (window.AgentumAutoSpinVisual) window.AgentumAutoSpinVisual.montar({ getConfig, getSelecionados });

    // Auto-refresh status: ritmo adaptativo + pausa quando a aba nao esta visivel
    // (com muitos jobs isso derruba o uso de CPU do servidor e do navegador).
    pollStatus();
    pollIntervaloMs = 0;
    agendarPoll();
    if (!visibilidadeWired) {
      visibilidadeWired = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        } else if (!pollTimer) {
          pollStatus();
          pollIntervaloMs = 0;
          agendarPoll();
        }
      });
    }
  }

  // Init when tab becomes active
  $$('#sidebar nav button[data-aba="autospin"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        // Em paralelo: a aba volta bem mais rapido depois de um F5.
        await Promise.all([
          catalogos.length ? null : carregarCatalogos(),
          jogos.length ? null : carregarJogos(provedorAtual),
          contasComSessao.length ? null : carregarContas(),
        ]);
      } catch { /* segue para o init */ }
      setTimeout(init, 80);
    });
  });

})();
