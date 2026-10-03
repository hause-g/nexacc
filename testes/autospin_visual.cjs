/* Visual only: isolated browser, synthetic API, no running server or account data. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const artifacts = require('./artefatos_helpers.cjs');
const { chromium } = artifacts.playwright();
const ROOT = path.resolve(__dirname, '..');
const OUT = artifacts('autospin_visual');
const ORIGIN = 'http://autospin-ui.invalid';
const baseline = process.argv.includes('--baseline');
const script = fs.readFileSync(path.join(ROOT, 'assets/agentum-autospin.js'), 'utf8');
const unchanged = ['get', 'post', 'getConfig', 'getSelecionados', 'calcularGirosRoll',
  'atualizarDica', 'iniciar', 'pararTodos', 'limparFinalizados', 'sincronizar',
  'pollStatus', 'ansiToHtml', 'carregarContas', 'carregarJogos', 'atualizarCatalogos'];
const source = script.replace(/\}\)\(\);\s*$/, `globalThis.__visualFunctions = {${unchanged.join(',')}};})();`);
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*rel="manifest"[^>]*>/gi, '')
  .replace('class="ativa" data-aba="inicio"', 'data-aba="inicio"')
  .replace('<button data-aba="autospin"', '<button class="ativa" data-aba="autospin"')
  .replace('<section class="aba ativa" id="aba-inicio">', '<section class="aba" id="aba-inicio">')
  .replace('<section class="aba" id="aba-autospin">', '<section class="aba ativa" id="aba-autospin">')
  .replace('</head>', '<style>#orionSplash{display:none!important}</style></head>')
  .replace('</body>', '<script src="assets/agentum-autospin-config.js"></script><script src="assets/agentum-autospin.js"></script></body>');
const accounts = Array.from({ length: 18 }, (_, i) => ({
  casa: i < 12 ? 'casa-demonstracao' : 'outra-casa-demonstracao',
  conta: `demo-${String(i + 1).padStart(2, '0')}`,
  host: i < 12 ? 'plataforma-demonstracao.invalid' : 'outra-plataforma-demonstracao.invalid',
}));
const jobs = {};
for (const [i, status] of ['rodando', 'finalizado', 'erro_rc_1'].entries()) {
  jobs[`demonstracao-${i}`] = {
    casa: i === 2 ? 'outra-casa-demonstracao' : 'casa-demonstracao', conta: `demo-${i + 1}`,
    status, started_at: new Date(Date.now() - 40000).toISOString(),
    metricas: { saldo: 24.8, roll: 7.5, spins: 25 },
    log_spins_recent: Array.from({ length: 40 }, (_, n) =>
      `[12:00:${String(n).padStart(2, '0')}] \u26a1 FlashROLL \u26a1 | Spin ${n + 1} | Saldo R$ 24.80 | BET R$ 0.30 | \u001b[94mGanho R$ 0.40\u001b[0m | Roll R$ 7.50`),
  };
}
const summary = { rodando: 1, finalizados: 1, erros: 1, roll_total: 22.5, spins_total: 75 };
// T6/T7: job finalizado com telemetria #RESUMO -> cartao de fechamento no rodape.
jobs['demonstracao-1'].metricas.resumo = {
  saldo_inicial: 30, saldo_final: 24.8, lucro: -5.2, roll: 7.5, spins: 25, bonus: 0,
};
// T8: job ANTIGO da mesma conta do demo-1 — nao pode virar uma 4a caixa (agrupamento).
jobs['demonstracao-0-antigo'] = {
  casa: 'casa-demonstracao', conta: 'demo-1', status: 'finalizado',
  started_at: new Date(Date.now() - 120000).toISOString(),
  metricas: { saldo: 10, roll: 1, spins: 5 },
  log_spins_recent: ['[12:00:00] \u26a1 FlashROLL \u26a1 | Spin 1 | Saldo R$ 10.00'],
};
let empty = false;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [], unexpected = [], posts = [], checks = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      // No continue(): every request is fulfilled from a fixture or blocked.
      if (url.origin !== ORIGIN) { unexpected.push(url.origin + url.pathname); return route.abort(); }
      if (req.method() !== 'GET') { posts.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/autospin/catalogos') return json({ giravel: 200, catalogos: [
        { pid: 200, provedor: 'PG', total: 2, giravel: true },
        { pid: 13, provedor: 'WG', total: 1, giravel: false },
      ] });
      if (url.pathname === '/api/autospin/jogos') return json({ jogos: ['Jogo demonstracao', 'Outro jogo demonstracao'] });
      if (url.pathname === '/api/autospin/jogos/busca') return json({ resultados: [] });
      if (url.pathname === '/api/autospin/sessoes') return json({ contas: empty ? [] : accounts });
      if (url.pathname === '/api/autospin/status') return json(empty ? {} : jobs);
      if (url.pathname === '/api/autospin/resumo') return json(empty ? {} : summary);
      if (url.pathname === '/api/autospin/historico') return json(empty ? {} : {
        geral: { execucoes: 3, roll: 12.5, lucro: -2.1, spins: 40, bonus: 1 },
        por_jogo: [{ game: 'Jogo demonstracao', execucoes: 2, spins: 30, roll: 10, lucro: -1, bonus: 1 }],
        por_conta: [{ casa: 'casa-demonstracao', conta: 'demo-1', execucoes: 2, roll: 10, lucro: -1, bonus: 1 }],
        ultimas: [{ job_id: 'demo', casa: 'casa-demonstracao', conta: 'demo-1', game: 'Jogo demonstracao',
                    finalizado_em: new Date().toISOString(), roll: 10, lucro: -1, spins: 30, bonus: 1, motivo: 'fim' }],
        rodadas: [{
          chave: 'lote_demo', lote: 'lote_demo', casa: 'casa-demonstracao', game: 'Jogo demonstracao',
          inicio: new Date().toISOString(), fim: new Date().toISOString(),
          contas: 2, roll: 10, lucro: -1, spins: 30, bonus: 1,
          detalhes: [
            { casa: 'casa-demonstracao', conta: 'demo-1', roll: 5, lucro: 1, spins: 15, motivo: 'fim', fonte: 'resumo' },
            { casa: 'casa-demonstracao', conta: 'demo-2', roll: 5, lucro: -2, spins: 15, motivo: 'fim', fonte: 'resumo' },
          ],
        }],
      });
      if (url.pathname === '/api/autospin/proxies/saude') return json(empty ? {} : {
        total: 1000, vivas: 998, mortas: 2, ms_mediana: 42, ms_p90: 50,
        mortas_lista: ['10.0.0.1:8080'], quando: new Date().toISOString(), amostra: false,
      });
      if (url.pathname === '/api/autospin/proxies/score') return json(empty ? {} : {
        ativo: true, total: 998, ms_melhor: 35, ms_pior: 240,
      });
      if (/^\/api\/autospin\/job\/[^/]+\/log$/.test(url.pathname)) return json({
        job_id: 'demo', total_lines: 400, atualizado_em: new Date().toISOString(),
        spins: Array.from({ length: 40 }, (_, n) =>
          `[12:00:${String(n).padStart(2, '0')}] \u26a1 FlashROLL \u26a1 | \ud83d\udd01 Re-Spin ${n + 1} | Saldo R$ 10.00 | Roll R$ 1.00`),
        lines: [],
      });
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname === '/assets/agentum-autospin.js') return route.fulfill({ contentType: 'text/javascript', body: source });
      if (url.pathname === '/assets/agentum-autospin-config.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'assets/agentum-autospin-config.js')) });
      if (!/^\/(?:assets|icons)\/[\w./-]+\.(?:css|png|svg)$/.test(url.pathname) || url.pathname.includes('..')) {
        unexpected.push(url.pathname); return route.abort();
      }
      const file = path.join(ROOT, url.pathname.slice(1));
      if (!fs.existsSync(file)) { unexpected.push(url.pathname); return route.abort(); }
      const types = { '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
      return route.fulfill({ contentType: types[path.extname(file)], body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(ORIGIN);
    // The only click is navigation; no start/stop/sync/clear action is invoked.
    await page.locator('nav button[data-aba="autospin"]').click();
    // V3: sub-abas — a Execução precisa estar ativa para os cards/logs ficarem visíveis.
    await page.locator('#asSubExec').click();
    await page.waitForFunction(() => document.querySelectorAll('.as-job').length === 3);
    const controls = await page.locator('#autospinApp input[id], #autospinApp select[id], #autospinApp button[id]').evaluateAll(els =>
      els.map(el => ({ id: el.id, tag: el.tagName, type: el.getAttribute('type'),
        min: el.getAttribute('min'), max: el.getAttribute('max'), step: el.getAttribute('step'),
        value: el.value, checked: el.checked, click: el.getAttribute('onclick') } )).sort((a, b) => a.id.localeCompare(b.id)));
    const functions = await page.evaluate(() => Object.fromEntries(
      Object.entries(globalThis.__visualFunctions).map(([name, fn]) => [name, fn.toString()])));
    const signatures = Object.fromEntries(Object.entries(functions).map(([name, code]) =>
      [name, crypto.createHash('sha256').update(code).digest('hex')]));
    const compare = process.env.AUTOSPIN_VISUAL_BASELINE;
    if (compare) {
      const before = JSON.parse(fs.readFileSync(compare, 'utf8'));
      assert.deepEqual(JSON.parse(JSON.stringify(controls)), before.controls, 'IDs, defaults, constraints and action callbacks unchanged');
      assert.deepEqual(signatures, before.signatures, 'No business, timing or request logic changed');
      checks.push('Controls and non-rendering functions identical to before the visual changes');
    }
    const shot = name => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true, animations: 'disabled' });
    for (const sub of ['config', 'exec']) {
      await page.locator(sub === 'config' ? '#asSubConfig' : '#asSubExec').click();
      for (const width of baseline ? [1440, 390] : [1440, 1280, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        if (!baseline) {
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Page fits ${width}px (${sub})`);
          const overflow = await page.locator('#aba-autospin :is(.as-config,.as-contas,.as-field,.as-actions,.as-logbox)').evaluateAll(els =>
            els.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).map(el => el.className));
          assert.deepEqual(overflow, [], `No clipped panels/fields/logs at ${width}px (${sub})`);
          if (sub === 'exec') {
            const boxes = await page.locator('.as-logbox').evaluateAll(els => els.map(el => ({
              height: el.getBoundingClientRect().height, overflow: getComputedStyle(el).overflowY,
              scrollable: el.scrollHeight > el.clientHeight,
            })));
            assert.ok(boxes.every(b => b.height <= 220 && b.scrollable && b.overflow === 'auto'), 'Logs scroll inside bounded boxes');
          }
        }
        if ([1440, 390, 320].includes(width)) await shot(`${baseline ? 'antes' : 'depois'}-${sub}-${width}`);
      }
    }
    if (!baseline) {

      // A apresentação reutiliza controles e regras: só seleção e edição explícitas mudam valores.
      assert.deepEqual(await page.locator('.as-config-fluxo .as-etapa-head h3').allTextContents(),
        ['Selecione as contas', 'Configure a execução', 'Revise e inicie']);
      const beforeSelection = await page.evaluate(() => __visualFunctions.getConfig());
      await page.locator('#asSubConfig').click();
      await page.locator('.as-check').nth(0).check();
      await page.locator('.as-check').nth(12).check();
      assert.match(await page.locator('[data-as-total]').innerText(), /2 de 18/);
      assert.deepEqual(await page.evaluate(() => __visualFunctions.getConfig()), beforeSelection,
        'Selecionar contas não altera parâmetros da execução');
      const pairs = await page.evaluate(() => __visualFunctions.getSelecionados().pares);
      assert.equal(pairs.length, 2);
      assert.equal(pairs[0].casa, 'casa-demonstracao');
      assert.equal(pairs[1].casa, 'outra-casa-demonstracao');
      await page.locator('#asBetMax').fill('0.50');
      await page.locator('#asSetSpins').fill('100');
      assert.match(await page.locator('[data-as-config]').innerText(), /100 giros fixos por jogo/);
      assert.match(await page.locator('[data-as-config]').innerText(), /0,50/);
      const edited = await page.evaluate(() => __visualFunctions.getConfig());
      await page.locator('#asSubExec').click();
      await page.locator('#asSubConfig').click();
      assert.deepEqual(await page.evaluate(() => __visualFunctions.getConfig()), edited,
        'Trocar subaba mantém os mesmos parâmetros');
      assert.deepEqual(await page.evaluate(() => __visualFunctions.getSelecionados().pares), pairs,
        'Trocar subaba mantém casa e conta selecionadas');
      // Os seletores de modo da imagem não existem: continuam sendo os inputs originais.
      assert.equal(await page.locator('.as-config-fluxo input[type="radio"]').count(), 0);
      const originalIds = controls.map(c => c.id);
      assert.equal(new Set(originalIds).size, originalIds.length, 'Nenhum controle duplicado');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('#asContasList,.as-config-fluxo .as-casa').evaluateAll(els => els.forEach(el => { el.scrollTop = 0; }));
      await shot('fluxo-config-1440');
      await page.setViewportSize({ width: 390, height: 1000 });
      await shot('fluxo-config-390');
      await page.locator('#asBetMax').fill('');
      await page.locator('#asSetSpins').fill('');
      await page.locator('.as-check').nth(0).uncheck();
      await page.locator('.as-check').nth(12).uncheck();
      checks.push('Three visual steps preserve original controls, house/account pairs, configuration and navigation');
      // Aba Configurações: campos rotulados + foco do dropdown.
      await page.locator('#asSubConfig').click();
      for (const el of await page.locator('.as-field input, .as-field select').all()) {
        assert.ok(await el.evaluate(node => node.labels.length > 0), 'Every field has a linked label');
      }
      await page.keyboard.press('Tab');
      await page.locator('#asGame').focus();
      assert.equal(await page.locator('#asGame').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      assert.equal(await page.locator('#asGame').evaluate(el => getComputedStyle(el).colorScheme), 'dark');
      // Aba Execução: log ANSI + cartão de fechamento.
      await page.locator('#asSubExec').click();
      const logText = await page.locator('.as-logbox').first().innerText();
      assert.match(logText, /FlashROLL/);
      assert.match(logText, /\u26a1/);
      assert.doesNotMatch(logText, /\u001b/);
      assert.ok(await page.locator('.as-logline span[style*="color"]').count() > 0, 'ANSI color rendering preserved');
      // V4: cards finalizados nascem recolhidos — expande um para ver o fechamento.
      await page.locator('.as-job[data-job="demonstracao-1"] .as-job-head').click();
      await page.waitForFunction(() => document.querySelectorAll('.as-fechamento').length >= 1);
      assert.ok(await page.locator('.as-fechamento').count() >= 1, 'Closing card renders from #RESUMO');
      assert.match(await page.locator('.as-fechamento').first().innerText(), /Entrada/);
      // V5: log sob demanda ("carregar mais") — snapshot congelado + volta ao ao vivo.
      await page.locator('.as-job[data-job="demonstracao-1"] .as-logmais').click();
      await page.waitForFunction(() => document.querySelector('.as-job[data-job="demonstracao-1"] .as-logvivo') !== null);
      assert.match(await page.locator('.as-job[data-job="demonstracao-1"] .as-lognota').innerText(), /Histórico/);
      // V4: filtro rápido dos chips (com o snapshot ativo, ele sobrevive à troca de filtro).
      await page.locator('#asFiltroRodando').click();
      await page.waitForFunction(() => document.querySelectorAll('.as-job').length === 1);
      await page.locator('#asFiltroTodos').click();
      await page.waitForFunction(() => document.querySelectorAll('.as-job').length === 3);
      assert.ok(await page.locator('.as-job[data-job="demonstracao-1"] .as-lognota').count() === 1,
        'Snapshot do log sobrevive à troca de filtro');
      await page.locator('.as-job[data-job="demonstracao-1"] .as-logvivo').click();
      await page.waitForFunction(() => document.querySelector('.as-job[data-job="demonstracao-1"] .as-lognota') === null);
      // V5: transicao de status no diff por card (rodando -> finalizado recolhe e reordena).
      jobs['demonstracao-0'].status = 'finalizado';
      await page.waitForFunction(() =>
        (document.querySelector('.as-job[data-job="demonstracao-0"]')?.classList.contains('as-job--fechado')) === true);
      // V5: remocao parcial (limpar finalizados) poda o card e o estado.
      delete jobs['demonstracao-2'];
      await page.waitForFunction(() => document.querySelectorAll('.as-job').length === 2);
      // Aba Histórico & Rede: seções renderizam com os dados mockados (itens 1/7).
      await page.locator('#asSubHist').click();
      await page.waitForFunction(() =>
        (document.querySelector('#asHistUltimas')?.innerText || '').includes('Jogo demonstracao'));
      assert.match(await page.locator('#asHistChips').innerText(), /Execuções/);
      // Rodadas: agrupamento por lote com resumo e detalhe expansível.
      assert.match(await page.locator('#asHistRodadas').innerText(), /2 contas/);
      await page.locator('#asHistRodadas summary').first().click();
      await page.waitForTimeout(250);
      assert.match(await page.locator('#asHistRodadas').innerText(), /demo-1/);
      assert.equal(await page.locator('#asHistRodadas .as-rodada[open] tbody tr').count(), 2,
        'Rodada abre com as contas do lote');
      // Mix "dividir em jogos": toggle revela, adiciona até 4 e remove respeitando o mínimo 2.
      await page.locator('#asSubConfig').click();
      await page.locator('#asMixOn').check();
      assert.ok(await page.locator('#asMixCorpo').isVisible(), 'Mix revela o corpo ao ligar');
      assert.equal(await page.locator('#asMixJogos .as-mix-linha').count(), 2, 'Mix abre com 2 jogos');
      await page.locator('#asMixAdd').click();
      await page.locator('#asMixAdd').click();
      assert.equal(await page.locator('#asMixJogos .as-mix-linha').count(), 4, 'Mix adiciona até 4 jogos');
      await page.locator('#asMixAdd').click();
      assert.equal(await page.locator('#asMixJogos .as-mix-linha').count(), 4, 'Mix não passa de 4 jogos');
      await page.locator('#asMixJogos .as-mix-linha [onclick*="_asMixRemover"]').first().click();
      assert.equal(await page.locator('#asMixJogos .as-mix-linha').count(), 3, 'Mix remove um jogo');
      await page.locator('#asMixJogos .as-mix-linha [onclick*="_asMixRemover"]').first().click();
      assert.equal(await page.locator('#asMixJogos .as-mix-linha').count(), 2, 'Mix volta para 2 jogos');
      await page.locator('#asMixJogos .as-mix-linha [onclick*="_asMixRemover"]').first().click();
      assert.equal(await page.locator('#asMixJogos .as-mix-linha').count(), 2, 'Mix não fica com menos de 2 jogos');
      await page.locator('#asMixOn').uncheck();
      assert.ok(!(await page.locator('#asMixCorpo').isVisible()), 'Mix esconde o corpo ao desligar');
      assert.match(await page.locator('#asProxyResumo').innerText(), /998\/1000/);
      assert.match(await page.locator('#asProxyScore').innerText(), /ativo/);
      // Volta para Configurações: status refresh não reseta campos.
      await page.locator('#asSubConfig').click();
      await page.locator('#asSetSpins').fill('1000');
      summary.spins_total = 76;
      await page.waitForFunction(() => document.getElementById('asStatus').textContent.includes('76'));
      assert.equal(await page.locator('#asSetSpins').inputValue(), '1000', 'Status refresh does not reset fields');
      checks.push('Responsive at six widths; bounded logs, linked labels, dark dropdown, keyboard focus and ANSI text');
      const isolatedStyles = await page.evaluate(() => {
        const sheet = document.querySelector('link[href*="agentum-autospin.css"]');
        const take = () => ['.sidebar', '.topbar', '#aba-inicio .sub', '.topchip'].map(selector => {
          const s = getComputedStyle(document.querySelector(selector));
          return { color: s.color, font: s.font, background: s.backgroundImage, border: s.borderColor };
        });
        const enabled = take();
        sheet.disabled = true;
        const disabled = take();
        sheet.disabled = false;
        return { enabled, disabled };
      });
      assert.deepEqual(isolatedStyles.enabled, isolatedStyles.disabled, 'Style changes cannot leak into other dashboard sections');
      checks.push('Navigation, topbar and other sections retain their existing styles');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.locator('#asIniciar').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      checks.push('Reduced-motion preference respected');
      empty = true;
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.reload();
      await page.locator('nav button[data-aba="autospin"]').click();
      await page.waitForFunction(() => document.querySelector('#asStatus .as-vazio'));
      // Espera a LISTA de contas carregar (o status vazio aparece antes; ler a lista
      // na sequencia era uma corrida que falhava conforme o formulario crescia).
      await page.waitForFunction(() =>
        (document.querySelector('#asContasList')?.innerText || '').includes('Nenhuma conta'));
      assert.match(await page.locator('#asContasList').innerText(), /Nenhuma conta/);
      await page.setViewportSize({ width: 320, height: 1000 });
      await shot('vazio-320');
      checks.push('Empty state renders without fake jobs or accounts');
    }
    assert.deepEqual(errors, [], 'No browser script errors');
    assert.deepEqual(unexpected, [], 'Only explicitly mocked or local asset requests');
    assert.deepEqual(posts, [], 'No execution, synchronization, stop or clear action sent');
    fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify({ baseline, controls, signatures, checks,
      safety: { errors, unexpected, posts, liveConnections: 0 } }, null, 2));
    console.log(JSON.stringify({ status: 'ok', baseline, checks, artifacts: OUT }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
