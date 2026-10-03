/* Match meta -> casa por DOMÍNIO de lançamento (card "Meta por casa" / menu de Jogos).
   Regressão do bug "não sincroniza": a meta "p1-casinhapg" era quebrada em ['p1','casinhapg'] e o
   "p1" casava com o BLOB da rede (chave "p1", que junta lançamentos diferentes) em vez da casa
   p1-casinhapg — o card lia o depósito da chave velha e ignorava o novo. Extrai a função REAL
   casarPlataforma() de agentum-jogos.js. node testes/meta_casa_dominio.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'agentum-jogos.js'), 'utf8');
const m = /function\s+casarPlataforma\s*\(/.exec(src);
assert.ok(m, 'não achei function casarPlataforma em agentum-jogos.js');
let i = src.indexOf('{', m.index), depth = 0, end = -1;
for (let j = i; j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
}
const casarPlataforma = (new Function(src.slice(m.index, end) + '; return casarPlataforma;'))();

// Mesmo cenário do bug real: o blob legado da rede p1 + a casa nova limpa p1-casinhapg.
const filhas = [
  { id: 'blob', chaves: ['forno', 'veleiro', 'assinar', 'p1'] },
  { id: 'limpa', chaves: ['p1-casinhapg'] },
];
const ids = plat => casarPlataforma(plat, filhas).map(c => c.id).sort();

// 1) O CERNE: "p1-casinhapg" casa SÓ com a casa p1-casinhapg, nunca com o blob da rede.
assert.deepStrictEqual(ids('p1-casinhapg'), ['limpa'], 'p1-casinhapg -> só a casa p1-casinhapg');
assert.deepStrictEqual(ids('P1-CASINHAPG'), ['limpa'], 'case-insensitive');
assert.deepStrictEqual(ids('https://www.p1-casinhapg.com/'), ['limpa'], 'aceita URL bonita inteira');
assert.deepStrictEqual(ids('p1-casinhapg.com'), ['limpa'], 'aceita host com .tld');
// caso REAL do operador: meta nomeada "p1-casinha" (sem o "pg") casa com a casa "p1-casinhapg".
assert.deepStrictEqual(ids('p1-casinha'), ['limpa'], 'p1-casinha (sem pg) -> casa p1-casinhapg, não o blob');
assert.deepStrictEqual(ids('p1-casinha.com'), ['limpa'], 'p1-casinha.com -> casa p1-casinhapg');
// caso REAL: meta com RÓTULO depois do domínio ("p1-casinhapg ROTULO1" / "p1-casinha rotulo2"). O
// rótulo (nome da pessoa) NÃO pode jogar o match no blob da rede via a palavra "p1".
assert.deepStrictEqual(ids('p1-casinhapg ROTULO1'), ['limpa'], 'domínio + rótulo -> casa do domínio, não o blob');
assert.deepStrictEqual(ids('p1-casinha rotulo2'), ['limpa'], 'domínio(sem pg) + rótulo -> casa do domínio');
// POSIÇÃO INDEPENDENTE: o domínio pode vir DEPOIS do rótulo, e uma rede solta antes não rouba o match.
assert.deepStrictEqual(ids('ROTULO1 p1-casinhapg'), ['limpa'], 'rótulo ANTES do domínio -> casa do domínio');
assert.deepStrictEqual(ids('rotulo2 p1-casinha'), ['limpa'], 'rótulo antes + sem pg -> casa do domínio');
assert.deepStrictEqual(ids('p1 p1-casinhapg'), ['limpa'], 'rede solta antes NÃO rouba: o domínio inteiro vence o blob');

// 2) Fallback por palavra só quando NENHUMA casa tem o domínio inteiro (legado/rede).
assert.deepStrictEqual(ids('p1'), ['blob'], 'meta só com a rede "p1" cai no blob (chave p1)');
assert.deepStrictEqual(ids('p1-assinarpg'), ['blob'], 'sem casa p1-assinarpg limpa, cai no blob por palavra');

// 3) Match EXATO por chave também vale p/ casas de rede que agrupam chaves de propósito (11+bolha).
const rede91 = [{ id: 'n91', chaves: ['11', 'bolha'] }];
assert.deepStrictEqual(casarPlataforma('11', rede91).map(c => c.id), ['n91'], '11 -> casa 11/bolha');
assert.deepStrictEqual(casarPlataforma('bolha', rede91).map(c => c.id), ['n91'], 'bolha -> casa 11/bolha');

// 3b) 24/09: meta "11 GATINHOPG" (espaço + letra faltando) casava com a casa legada 11/bolha e a OP 2
//     ficava zerada com 14 depósitos na 11-gatinhopg. Rede + espaço + plataforma = o domínio; um erro
//     de uma letra só vale com a mesma rede e casa única.
const rede91b = [{ id: 'n91', chaves: ['11', 'bolha'] }, { id: 'gatinho', chaves: ['11-gatinhopg'] }, { id: 'kiwi', chaves: ['p2-gatinhopg'] }];
const ids91 = plat => casarPlataforma(plat, rede91b).map(c => c.id).sort();
assert.deepStrictEqual(ids91('11 GATINHOPG'), ['gatinho'], 'rede + espaço + plataforma com 1 letra a menos');
assert.deepStrictEqual(ids91('11 GATINHOPG'), ['gatinho'], 'rede + espaço + plataforma');
assert.deepStrictEqual(ids91('11-gatinhopg'), ['gatinho'], 'domínio com 1 letra a menos');
assert.deepStrictEqual(ids91('11 gatinhopg ROTULO1'), ['gatinho'], 'com rótulo depois');
assert.deepStrictEqual(ids91('11'), ['n91'], 'só a rede continua na casa 11/bolha');
assert.deepStrictEqual(ids91('11 kxtxnpg'), ['n91'], '2 letras erradas NÃO é aproximação: cai no fallback');
assert.deepStrictEqual(ids91('18 gatinhopg'), [], 'outra rede não pega a gatinho da 11');

// 3c) Vínculo gravado na meta: vence o nome, MENOS quando é só a rede ("11") e o nome aponta um
//     domínio de lançamento único — a OP 2 tinha casaChave "11" gravado ao iniciar.
const fn = name => { const mm = new RegExp('function\\s+' + name + '\\s*\\(').exec(src); let d = 0, a = src.indexOf('{', mm.index), z = -1;
  for (let j = a; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { z = j + 1; break; } } }
  return src.slice(mm.index, z); };
const vinculoDaMeta = (new Function(fn('casarPlataforma') + ';' + fn('vinculoDaMeta') + '; return vinculoDaMeta;'))();
const vid = m => vinculoDaMeta(m, rede91b).map(c => c.id);
assert.deepStrictEqual(vid({ plataforma: '11 GATINHOPG', casaChave: '11' }), ['gatinho'], 'vínculo só de rede não prende a meta na casa legada');
assert.deepStrictEqual(vid({ plataforma: 'ROTULO1', casaChave: '11-gatinhopg' }), ['gatinho'], 'vínculo de domínio vence o nome');
assert.deepStrictEqual(vid({ plataforma: '11 bolha', casaChave: '11' }), ['n91'], 'vínculo de rede continua quando o nome também é da rede');
assert.deepStrictEqual(vid({ plataforma: '11 GATINHOPG' }), ['gatinho'], 'sem vínculo: pelo nome');

// 4) Sem match nenhum -> lista vazia (não inventa casa).
assert.deepStrictEqual(ids('zzz-nadapg'), [], 'plataforma desconhecida não casa com ninguém');
assert.deepStrictEqual(ids(''), [], 'plataforma vazia não casa');

console.log(JSON.stringify({ status: 'ok', verificacoes: 28 }, null, 2));
