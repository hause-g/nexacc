/* Auto Spin: organização visual. Não faz pedidos, gravações ou alterações de configuração. */
(function () {
  'use strict';
  let desmontar = null;

  function montar({ getConfig, getSelecionados }) {
    if (desmontar) desmontar();
    const painel = document.getElementById('asTabConfig');
    const grade = painel && painel.querySelector('.as-grid');
    if (!grade) return;
    const campos = new Map(Array.from(grade.querySelectorAll('.as-field')).map(campo =>
      [campo.querySelector('input,select').id, campo]));
    const checks = new Map(Array.from(grade.querySelectorAll('.as-config input[type="checkbox"]')).map(input =>
      [input.id, input.closest('label')]));
    const lista = grade.querySelector('#asContasList');
    const sincronizar = grade.querySelector('#asSync');
    const acoes = grade.querySelector('.as-actions');
    const aviso = grade.querySelector('#asProvAviso');
    const atualizarCatalogo = grade.querySelector('.as-catalog-actions');
    const dica = grade.querySelector('#asCalcHint');

    const fluxo = document.createElement('div');
    fluxo.className = 'as-config-fluxo';
    fluxo.innerHTML = `
      <section class="as-etapa as-contas" aria-labelledby="asEtapaContas">
        <header class="as-etapa-head">
          <span class="as-etapa-num" aria-hidden="true">1</span>
          <div><h3 id="asEtapaContas">Selecione as contas</h3>
            <p>Marque as contas que deseja usar, conferindo a casa de cada uma.</p></div>
          <span class="as-selecao-total" data-as-total aria-live="polite"></span>
        </header>
        <div class="as-contas-toolbar"><p>A seleção é feita por casa e conta.</p><div data-as-slot="sync"></div></div>
        <div data-as-slot="contas"></div>
        <p class="as-nota">A mesma numeração em casas diferentes representa contas diferentes.</p>
      </section>
      <section class="as-etapa as-config" aria-labelledby="asEtapaConfig">
        <header class="as-etapa-head">
          <span class="as-etapa-num" aria-hidden="true">2</span>
          <div><h3 id="asEtapaConfig">Configure a execução</h3>
            <p>Escolha o jogo e confira os controles que serão enviados ao iniciar.</p></div>
        </header>
        <fieldset class="as-faixa"><legend>Jogo e aposta</legend>
          <div class="as-campos as-campos--catalogo" data-as-slot="catalogo"></div>
          <div data-as-slot="aviso"></div><div data-as-slot="atualizar"></div>
        </fieldset>
        <fieldset class="as-faixa"><legend>Giros e roll</legend>
          <p class="as-nota">Os controles mantêm as regras atuais. Confira abaixo como a combinação será usada.</p>
          <div class="as-controles-execucao">
            <div class="as-controle-modo" data-as-slot="fixos"><span class="as-controle-nome">Quantidade de giros</span><p>Giros pagos por jogo.</p></div>
            <div class="as-controle-modo" data-as-slot="roll"><span class="as-controle-nome">Alvo de roll</span><p>Com aposta definida e sem giros fixos, calcula a quantidade de giros.</p></div>
            <div class="as-controle-modo" data-as-slot="auto"><span class="as-controle-nome">Cálculo automático</span><p>Giros calculados pelo saldo. Giros fixos ou roll preenchidos têm prioridade ao iniciar.</p></div>
          </div>
          <div class="as-explicacao"><span>Como os limites serão usados</span><div data-as-slot="dica"></div></div>
        </fieldset>
        <fieldset class="as-faixa"><legend>Abrangência e condições de parada</legend>
          <div class="as-campos as-campos--limites" data-as-slot="limites"></div>
          <p class="as-nota">Os giros fixos são por jogo. O volume total depende dos jogos e das opções de repetição.</p>
        </fieldset>
        <details class="as-opcoes">
          <summary>Ritmo e conexão <span>Velocidade, ondas e proxies</span></summary>
          <div class="as-opcoes-corpo"><div class="as-campos" data-as-slot="ondas"></div><div class="as-checks" data-as-slot="ritmo"></div></div>
        </details>
        <details class="as-opcoes">
          <summary>Travas, bônus e outras opções <span>Controles específicos e modo de teste</span></summary>
          <div class="as-opcoes-corpo"><div class="as-campos" data-as-slot="extras"></div><div class="as-checks" data-as-slot="extras-checks"></div></div>
        </details>
      </section>
      <section class="as-etapa as-revisao" aria-labelledby="asEtapaRevisao">
        <div class="as-revisao-copy"><header class="as-etapa-head">
          <span class="as-etapa-num" aria-hidden="true">3</span>
          <div><h3 id="asEtapaRevisao">Revise e inicie</h3>
            <p data-as-resumo>Selecione as contas acima.</p></div>
        </header>
        <p class="as-revisao-config" data-as-config></p>
        <p class="as-nota" data-as-opcionais></p></div>
        <div data-as-slot="acoes"></div>
      </section>`;
    const slot = nome => fluxo.querySelector('[data-as-slot="' + nome + '"]');
    const mover = (nome, el) => { if (el) slot(nome).appendChild(el); };
    const moverCampos = (nome, ids) => ids.forEach(id => mover(nome, campos.get(id)));
    const moverChecks = (nome, ids) => ids.forEach(id => mover(nome, checks.get(id)));
    mover('sync', sincronizar); mover('contas', lista); mover('acoes', acoes);
    mover('aviso', aviso); mover('atualizar', atualizarCatalogo); mover('dica', dica);
    moverCampos('catalogo', ['asProvedor', 'asGame', 'asBetMax']);
    moverCampos('fixos', ['asSetSpins']);
    moverCampos('roll', ['asMaxRoll']);
    moverChecks('auto', ['asAutoRoll']);
    moverCampos('limites', ['asMaxSpin', 'asMaxGame', 'asMeta', 'asRollTeto', 'asSaldoLimite', 'asPararApos']);
    moverCampos('ondas', ['asOndaTam', 'asOndaInt']);
    moverChecks('ritmo', ['asModoRapido', 'asTurbo', 'asNoProxy', 'asProxySempre', 'asStealth', 'asLoop']);
    moverCampos('extras', ['asGemTrava', 'asComprarBonus', 'asBetPercent', 'asAbrirJogosN', 'asGemHp', 'asAccountId', 'asBonusDias']);
    moverChecks('extras-checks', ['asPgTrava', 'asZerarSaldo', 'asZerarSaldoTotal', 'asColetarBonus', 'asAbrirJogos', 'asBau', 'asSemExtrato', 'asDryRun']);
    // Não descartar um controle novo adicionado por outro módulo/versão.
    // (O bloco do mix tem os próprios campos e é movido inteiro abaixo.)
    const restantes = Array.from(grade.querySelectorAll('.as-field,.as-config .as-checks>label'))
      .filter(el => !el.closest('#asMixGrupo'));
    restantes.forEach(el => mover('extras', el));
    const rotulos = {
      asBetMax: 'Aposta máxima (R$)', asSetSpins: 'Giros fixos por jogo',
      asMaxRoll: 'Max Roll (R$)', asMaxSpin: 'Máximo de giros por jogo',
      asMaxGame: 'Máximo de jogos', asMeta: 'Meta de saldo (R$)',
      asRollTeto: 'Teto de roll do lote (R$)', asPararApos: 'Parar após N contas'
    };
    Object.entries(rotulos).forEach(([id, texto]) => {
      const label = fluxo.querySelector('label[for="' + id + '"]');
      if (label) label.textContent = texto;
    });
    // Mix "dividir em jogos": preserva o bloco inteiro logo após "Jogo e aposta".
    const mix = grade.querySelector('#asMixGrupo');
    if (mix) {
      const faixa = fluxo.querySelector('[data-as-slot="catalogo"]');
      const alvo = faixa && faixa.closest('fieldset');
      if (alvo) alvo.insertAdjacentElement('afterend', mix);
    }
    grade.replaceWith(fluxo);

    // Leitura para apresentação: não altera campos, seleção, handlers ou payloads.
    function atualizarResumo() {
      const sel = getSelecionados();
      const cfg = getConfig();
      const total = lista.querySelectorAll('.as-check').length;
      const n = sel.pares.length;
      fluxo.querySelector('[data-as-total]').textContent = n + ' de ' + total + ' contas selecionadas';
      const prov = document.getElementById('asProvedor');
      const provedor = prov && prov.selectedOptions[0] ? prov.selectedOptions[0].textContent.split(' — ')[0] : 'Provedor não selecionado';
      const jogo = cfg.game || 'Seleção aleatória de jogos';
      fluxo.querySelector('[data-as-resumo]').textContent =
        (cfg.dry_run ? 'Modo teste • ' : '') + n + ' conta(s) selecionada(s) • ' + provedor + ' • ' + jogo;
      const quantidade = cfg.set_spins > 0 ? cfg.set_spins + ' giros fixos por jogo' :
        cfg.max_roll > 0 ? 'Giros calculados pelo alvo de roll, quando houver aposta definida' :
        cfg.auto_roll ? 'Auto Roll pelo saldo' :
        cfg.max_spin > 0 ? 'Máximo de ' + cfg.max_spin + ' giros por jogo' : 'Quantidade padrão do bot';
      const aposta = cfg.bet_max ? 'R$ ' + Number(cfg.bet_max).toLocaleString('pt-BR', {minimumFractionDigits: 2}) : 'não definida';
      fluxo.querySelector('[data-as-config]').textContent = quantidade + ' • Aposta máxima: ' + aposta;
      const ligados = [];
      for (const [id, label] of checks) {
        const input = document.getElementById(id);
        if (input && input.checked && id !== 'asAutoRoll' && id !== 'asMixOn') {
          const span = label.querySelector('span');
          const text = span ? Array.from(span.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim() : id;
          ligados.push(text);
        }
      }
      fluxo.querySelector('[data-as-opcionais]').textContent = ligados.length ? 'Opções ligadas: ' + ligados.join(' • ') : '';
    }
    fluxo.addEventListener('input', atualizarResumo);
    fluxo.addEventListener('change', atualizarResumo);
    // Selecionar/limpar uma casa muda checkboxes por código; o resumo acompanha o clique.
    const atualizarDepois = () => queueMicrotask(atualizarResumo);
    fluxo.addEventListener('click', atualizarDepois);
    const observer = new MutationObserver(atualizarResumo);
    [lista, document.getElementById('asProvedor'), document.getElementById('asGame')].forEach(el => {
      if (el) observer.observe(el, {childList: true, subtree: true});
    });
    atualizarResumo();
    desmontar = () => {
      observer.disconnect();
      fluxo.removeEventListener('input', atualizarResumo);
      fluxo.removeEventListener('change', atualizarResumo);
      fluxo.removeEventListener('click', atualizarDepois);
    };
  }
  window.AgentumAutoSpinVisual = { montar };
})();
