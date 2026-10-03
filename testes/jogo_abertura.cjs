/* Teste isolado da abertura do jogo (filha 1.64): a aba abre na PROPRIA aba, no topo (como um
   clique real) — nada de nova guia, nada de iframe quando o blob funciona. Extrai as funcoes reais
   do hook.js e exercita cada ramo, sem navegador. Mais checagem estatica: worker sem tabs.create,
   bridge repassando o modo. Roda com: node testes/jogo_abertura.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RAIZ = path.resolve(__dirname, '..');
const hook = fs.readFileSync(path.join(RAIZ, 'extensao', 'hook.js'), 'utf8');
const bg = fs.readFileSync(path.join(RAIZ, 'extensao', 'background.js'), 'utf8');
const bridge = fs.readFileSync(path.join(RAIZ, 'extensao', 'bridge.js'), 'utf8');

// Recorta uma funcao nomeada pelo casamento de chaves (sem depender de indentacao).
function recortar(src, nome) {
  const re = new RegExp('function\\s+' + nome + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  assert.ok(m, 'nao achei a funcao ' + nome + ' no hook.js');
  let i = src.indexOf('{', m.index), profundidade = 0, fim = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') profundidade++;
    else if (src[j] === '}') { profundidade--; if (profundidade === 0) { fim = j + 1; break; } }
  }
  assert.ok(fim > 0, 'chaves desbalanceadas em ' + nome);
  return src.slice(m.index, fim);
}

const codigo = recortar(hook, 'abrirNoTopo') + '\n' + recortar(hook, 'abrirLauncherOuUrl');

// Monta um sandbox controlado e devolve as funcoes reais mais o registrador de efeitos.
function montar(opts) {
  opts = opts || {};
  const rec = { assigns: [], iframes: [] };
  const sb = {
    Blob: function (partes, cfg) { this.partes = partes; this.cfg = cfg; },
    URL: { createObjectURL: opts.blobQuebra ? function () { throw new Error('blob barrado'); }
                                            : function () { return 'blob:casa/xyz'; } },
    // getElementById truthy => a rede de seguranca (rescue) enxerga um frame e nao faz nada;
    // assim o teste isola a navegacao top-level do fallback.
    document: { getElementById: function () { return {}; } },
    setTimeout: function (fn) { try { fn(); } catch (_) {} },
    abrirLauncher: function (html) { rec.iframes.push(html); return true; },
    location: { assign: function (u) { rec.assigns.push('self:' + u); }, href: '' },
  };
  sb.window = { top: { location: { assign: function (u) { rec.assigns.push('top:' + u); } } }, location: sb.location };
  const fabricar = new Function('sb', 'with (sb) { ' + codigo + '; return { abrirLauncherOuUrl: abrirLauncherOuUrl, abrirNoTopo: abrirNoTopo }; }');
  return { api: fabricar(sb), rec: rec };
}

const passos = [];

// 1) Launcher HTML com blob OK -> abre TOP-LEVEL (nova guia nenhuma, iframe nenhum).
{
  const { api, rec } = montar();
  const r = api.abrirLauncherOuUrl('<!doctype html><script>location.replace(1)</script>', '');
  assert.deepStrictEqual({ ok: r.ok, modo: r.modo, topo: r.topo }, { ok: 1, modo: 'topo', topo: 1 }, 'launcher deve abrir no topo');
  assert.deepStrictEqual(rec.assigns, ['top:blob:casa/xyz'], 'navegou o TOPO para o blob');
  assert.deepStrictEqual(rec.iframes, [], 'nao caiu no iframe quando o blob funciona');
  passos.push('launcher HTML: abre top-level via blob na propria aba (sem iframe, sem nova guia)');
}

// 2) Blob barrado -> cai no overlay iframe (rede de seguranca), sem navegar o topo.
{
  const { api, rec } = montar({ blobQuebra: true });
  const r = api.abrirLauncherOuUrl('<!doctype html>launcher', '');
  assert.deepStrictEqual({ ok: r.ok, modo: r.modo, topo: r.topo }, { ok: 1, modo: 'iframe', topo: 0 }, 'sem blob deve usar iframe');
  assert.strictEqual(rec.iframes.length, 1, 'renderizou o overlay em iframe');
  assert.deepStrictEqual(rec.assigns, [], 'no fallback nao navega o topo');
  passos.push('blob barrado: fallback para overlay iframe, comprovado');
}

// 3) Formato antigo (URL pronta) -> navega direto no topo.
{
  const { api, rec } = montar();
  const url = 'https://cdn.exemplo.com/126/index.html?token=abc&__hv=1';
  const r = api.abrirLauncherOuUrl('', url);
  assert.deepStrictEqual({ ok: r.ok, modo: r.modo, topo: r.topo, url: r.url }, { ok: 1, modo: 'topo_url', topo: 1, url: url }, 'URL antiga navega no topo');
  assert.deepStrictEqual(rec.assigns, ['top:' + url], 'navegou o TOPO para a URL');
  assert.deepStrictEqual(rec.iframes, [], 'URL antiga nao usa iframe');
  passos.push('formato antigo (URL): navega top-level direto');
}

// 4) Nem HTML nem URL -> nao abre nada.
{
  const { api, rec } = montar();
  const r = api.abrirLauncherOuUrl('', '');
  assert.deepStrictEqual({ ok: r.ok, modo: r.modo, topo: r.topo }, { ok: 0, modo: '', topo: 0 }, 'sem nada, ok:0');
  assert.deepStrictEqual(rec.assigns, [], 'sem nada nao navega');
  assert.deepStrictEqual(rec.iframes, [], 'sem nada nao abre iframe');
  passos.push('sem launcher e sem URL: nao abre nada (ok:0)');
}

// 5) Estatica: o WORKER nunca abre nova guia (foi a duplicacao que desconectava). Casa a FORMA DE
// CHAMADA (com parentese), para nao confundir com a mencao em comentario.
assert.ok(!/chrome\.tabs\.create\s*\(/.test(bg), 'background.js nao pode mais CHAMAR chrome.tabs.create(...)');
passos.push('worker (background.js): sem chamada a chrome.tabs.create — nenhuma nova guia');

// 6) Estatica: o bridge repassa o modo para o desfecho no painel.
assert.ok(/__opjogo_pronto[\s\S]{0,200}modo:\s*String\(e\.data\.modo/.test(bridge), 'bridge deve repassar o modo no __opjogo_pronto');
passos.push('bridge.js: repassa o modo (topo/topo_url/iframe) ao worker');

// 7) Estatica: hook define os dois helpers e o lancarJogo usa o decisor.
assert.ok(/function\s+abrirLauncherOuUrl\b/.test(hook) && /function\s+abrirNoTopo\b/.test(hook), 'hook deve definir abrirLauncherOuUrl e abrirNoTopo');
assert.ok(/abrirLauncherOuUrl\(html,\s*achada\)/.test(hook), 'lancarJogo deve chamar abrirLauncherOuUrl(html, achada)');
passos.push('hook.js: lancarJogo usa o decisor abrirLauncherOuUrl');

// 8) Botao "Voltar a casa" (decideVoltar): mostra so em pagina cross-host de um launch recente.
const decCode = recortar(bridge, 'decideVoltar');
const decideVoltar = (new Function('sb', 'with (sb) { ' + decCode + '; return decideVoltar; }'))({ URL });
const AGORA = 1700000000000;
const lobby = { url: 'https://www.p1-fornopg.com/?id=000000008', quando: AGORA - 60000 };
assert.strictEqual(decideVoltar(lobby, 'ascx.fornopgpay1.com', AGORA), lobby.url, 'jogo cross-host recente: volta pro lobby');
assert.strictEqual(decideVoltar(lobby, 'www.p1-fornopg.com', AGORA), '', 'no proprio lobby: nao mostra');
assert.strictEqual(decideVoltar({ url: lobby.url, quando: AGORA - 4 * 3600000 }, 'ascx.fornopgpay1.com', AGORA), '', 'launch velho (>3h): nao mostra');
assert.strictEqual(decideVoltar(null, 'ascx.fornopgpay1.com', AGORA), '', 'sem lobby salvo: nao mostra');
assert.strictEqual(decideVoltar({ url: 'nao-e-url', quando: AGORA }, 'ascx.fornopgpay1.com', AGORA), '', 'url ruim: nao mostra');
assert.ok(/__opsavelobby/.test(hook) && /op_jogo_lobby/.test(bridge), 'hook salva o lobby no launch e bridge guarda em op_jogo_lobby');
passos.push('bridge.js: decideVoltar (botao Voltar a casa) — cross-host recente sim; lobby/velho/ruim/sem-lobby nao');

console.log(JSON.stringify({ status: 'ok', cenarios: passos }, null, 2));
