/* #3-B: a casa e chaveada pelo DOMINIO BONITO (p2-exemplopg) lido do lobby, nao pelo host cru
   (exemplopg pelado / hash de cloudfront). Testa (1) dominioOficial() REAL extraida do hook.js e
   (2) o override no classify.js REAL. node testes/dominio_oficial.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ---- 1) dominioOficial() real, extraida do hook.js ----
const hookSrc = fs.readFileSync(path.resolve(__dirname, '..', 'extensao', 'hook.js'), 'utf8');
const ini = hookSrc.indexOf('var _domRaw');
const fim = hookSrc.indexOf('function casaAtual');
assert.ok(ini >= 0 && fim > ini, 'nao achei o bloco _domRaw..casaAtual em hook.js');
const bloco = hookSrc.slice(ini, fim);
const btoa = s => Buffer.from(s, 'binary').toString('base64');
const atob = s => Buffer.from(s, 'base64').toString('binary');
const N = { parseJSON: s => { try { return JSON.parse(s); } catch (_) { return null; } } };
// fabrica uma dominioOficial NOVA por cenario (cache mora no _domRaw local); location.hostname mocka o host
function domFactory(valorLobby, hostAtual) {
  const localStorage = { getItem: k => (k === 'lobby_pwa_domain' ? valorLobby : null) };
  const location = { hostname: hostAtual || '' };
  return new Function('N', 'localStorage', 'atob', 'location', bloco + '\n; return dominioOficial;')(N, localStorage, atob, location);
}
const lobby = urls => JSON.stringify({ data: btoa(JSON.stringify(urls)), expires: 9999999999 });

// host ESTÁ no lobby -> confia
assert.equal(domFactory(lobby(['https://p2-exemplopg.com', 'https://exemplopg.com',
  'https://d1exemplo.cloudfront.net', 'https://x-elb.amazonaws.com']), 'exemplopg.com')(), 'p2-exemplopg',
  'host pelado no lobby -> p2-exemplopg');
assert.equal(domFactory(lobby(['https://www.p2-exemplopg.com/lobby']), 'www.p2-exemplopg.com')(), 'p2-exemplopg', 'aceita www e caminho');
assert.equal(domFactory(lobby(['https://p2-exemplopg.com', 'https://z8-fornopg.com']), 'p2-exemplopg.com')(), '',
  '2 dominios bonitos distintos -> ambiguo -> nao adivinha');
assert.equal(domFactory(lobby(['https://d1exemplo.cloudfront.net', 'https://x-elb.amazonaws.com']), 'd1exemplo.cloudfront.net')(), '',
  'nenhum <rede>-<plataforma>pg -> vazio');
assert.equal(domFactory(null, 'qualquer.com')(), '', 'lobby ausente -> vazio');
assert.equal(domFactory('{"data":"@@nao-e-base64@@"}', 'x.com')(), '', 'base64/JSON quebrado -> vazio (try/catch)');
assert.equal(domFactory('{"expires":1}', 'x.com')(), '', 'sem data -> vazio');
// GUARDA ANTI-TROCA: lobby de OUTRA casa (nao inclui o host atual) -> NAO sobrescreve (evita chavear errado)
assert.equal(domFactory(lobby(['https://p2-exemplopg.com', 'https://exemplopg.com']), 'estranho.cloudfront.net')(), '',
  'lobby que nao inclui o host atual nao e usado (cloudfront/ELB compartilhado)');
assert.equal(domFactory(lobby(['https://p2-exemplopg.com']), '')(), '', 'sem host -> nao confia');

// ---- 2) override REAL no classify.js ----
const parser = require('../extensao/classify.js');
function saqueCasa(host, casaOficial) {
  const raw = JSON.stringify({ data: { orderNo: 'PED1', money: '114.00', status: 4 } });
  const out = parser.classificar({ url: 'finance/certify/orderInfo', host, casaOficial, resp: raw },
    { conta: 'c1', users: ['c1'], tokens: [] });
  const op = out.find(x => x.tipo === 'saque');
  return op && op.casa;
}
assert.equal(saqueCasa('exemplopg.com', 'p2-exemplopg'), 'p2-exemplopg', 'dominio pelado + oficial -> chaveia no bonito');
assert.equal(saqueCasa('exemplopg.com', ''), 'exemplopg', 'sem oficial -> host cru (comportamento antigo)');
assert.equal(saqueCasa('exemplopg.com', 'p2 exemplo!'), 'exemplopg', 'oficial malformado -> ignora, cai no host');
assert.equal(saqueCasa('p2-exemplopg.com', 'p2-exemplopg'), 'p2-exemplopg', 'idempotente no proprio dominio bonito');
assert.equal(saqueCasa('d1exemplo.cloudfront.net', 'p2-exemplopg'), 'p2-exemplopg', 'cloudfront + oficial -> bonito');

console.log('dominio_oficial.cjs OK');
