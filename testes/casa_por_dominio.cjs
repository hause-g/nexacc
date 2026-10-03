/* Esquema por DOMÍNIO (filha): a chave da casa é o domínio de lançamento inteiro (11-noitepg),
   não a rede (11). Extrai o casa() real de normalizar.js e verifica que cada lançamento é uma
   chave própria e que dois lançamentos da MESMA rede não se agrupam. node testes/casa_por_dominio.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'extensao', 'normalizar.js'), 'utf8');
const m = /function\s+casa\s*\(\s*host\s*\)\s*\{/.exec(src);
assert.ok(m, 'não achei function casa(host) em normalizar.js');
let i = src.indexOf('{', m.index), depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
const code = src.slice(m.index, end);
const casa = (new Function(code + '; return casa;'))();

const casos = {
  '11-noitepg.com': '11-noitepg',
  '11-bolhapg.com': '11-bolhapg',
  'www.p1-fornopg.com': 'p1-fornopg',
  'p1-assinarpg.com': 'p1-assinarpg',
  'a8-ofuropg.com': 'a8-ofuropg',
  'p4-listrapg.com': 'p4-listrapg',
  'd2j283p0n7ilt1.cloudfront.net': 'd2j283p0n7ilt1',
  '': '',
};
for (const [host, esperado] of Object.entries(casos)) {
  assert.strictEqual(casa(host), esperado, host + ' deve virar ' + JSON.stringify(esperado));
}
// O ponto central: dois lançamentos da MESMA rede viram chaves DIFERENTES (não agrupa por "11"/"p1").
assert.notStrictEqual(casa('11-noitepg.com'), casa('11-bolhapg.com'), '11-noitepg != 11-bolhapg');
assert.notStrictEqual(casa('p1-fornopg.com'), casa('p1-assinarpg.com'), 'p1-fornopg != p1-assinarpg');
// Estático: não pode mais existir o corte no primeiro traço na função casa.
assert.ok(!/split\(["']\.["']\)\[0\]\.split\(["']-["']\)/.test(src), 'normalizar.js não pode cortar no primeiro traço (rede)');

console.log(JSON.stringify({ status: 'ok', verificados: Object.keys(casos).length + 3 }, null, 2));
