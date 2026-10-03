/* Operações ao vivo em PARALELO: o card contabiliza SÓ as casas da operação ATIVA.
   Prova a MATEMÁTICA do escopo usando as funções REAIS scopeEfetivo() + calculate() do módulo
   (sem cópia — se a lógica mudar, o teste acompanha). node testes/aovivo_escopo.cjs
   O que garante: (1) sem escopo = global; (2) cada operação soma só suas casas; (3) conservação
   (soma das operações == global); (4) bônus Gerente/BAU por operação; (5) nulo propaga; (6) casa
   case-insensitive. */
'use strict';
const assert = require('assert');
const { calculate, scopeEfetivo, residualClose } = require('../assets/agentum-operacao.js');

// resumo efetivo do servidor: 3 casas de 2 redes diferentes, totais do ciclo já somados.
const efetivo = {
  deposito: 350, saque: 350, qtd_depositos: 6, qtd_saques: 4, contas: 6,
  por_casa: [
    { casa: 'p1-fornopg', deposito: 100, saque: 150, depositos: 2, saques: 1, contas: 2, oficial: false },
    { casa: '11-noitepg', deposito: 50,  saque: 20,  depositos: 1, saques: 1, contas: 1, oficial: false },
    { casa: 'p4-listrapg', deposito: 200, saque: 180, depositos: 3, saques: 2, contas: 3, oficial: false },
  ],
};
const base = { operacoes: [], ajustes: [], mapeamento: {}, manuais: {}, disponivel: true };
const money = n => Math.round(n * 100) / 100;
const run = (esc, extra = {}) => calculate({ ...base, ...extra, efetivo: scopeEfetivo(efetivo, esc) });

// (1) SEM escopo (0/1 operação): idêntico ao global de hoje.
const g = run(null);
assert.strictEqual(g.td, 350, 'global td');
assert.strictEqual(g.ts, 350, 'global ts');
assert.strictEqual(g.resultado, 0, 'global resultado');
assert.strictEqual(g.qd, 6, 'global qd'); assert.strictEqual(g.qs, 4, 'global qs'); assert.strictEqual(g.contas, 6, 'global contas');

// (2) Operação 1 = só p1-fornopg.
const op1 = run(new Set(['p1-fornopg']));
assert.strictEqual(op1.td, 100, 'op1 td'); assert.strictEqual(op1.ts, 150, 'op1 ts');
assert.strictEqual(op1.resultado, 50, 'op1 resultado (+50)');
assert.strictEqual(op1.qd, 2, 'op1 qd'); assert.strictEqual(op1.qs, 1, 'op1 qs'); assert.strictEqual(op1.contas, 2, 'op1 contas');
assert.strictEqual(op1.por_casa.length, 1, 'op1 só 1 casa no detalhamento');

// (3) Operação 2 = 11-noitepg + p4-listrapg (rede diferente NÃO importa; são casas próprias).
const op2 = run(new Set(['11-noitepg', 'p4-listrapg']));
assert.strictEqual(op2.td, 250, 'op2 td'); assert.strictEqual(op2.ts, 200, 'op2 ts');
assert.strictEqual(op2.resultado, -50, 'op2 resultado (-50)');
assert.strictEqual(op2.qd, 4, 'op2 qd'); assert.strictEqual(op2.qs, 3, 'op2 qs'); assert.strictEqual(op2.contas, 4, 'op2 contas');

// (4) CONSERVAÇÃO: as operações particionam o ciclo — a soma bate com o global.
assert.strictEqual(money(op1.td + op2.td), g.td, 'soma dos depósitos == global');
assert.strictEqual(money(op1.ts + op2.ts), g.ts, 'soma dos saques == global');
assert.strictEqual(money(op1.resultado + op2.resultado), g.resultado, 'soma dos resultados == global');
assert.strictEqual(op1.qd + op2.qd, g.qd, 'soma qd == global');
assert.strictEqual(op1.contas + op2.contas, g.contas, 'soma contas == global');

// (5) Bônus Gerente/BAU POR OPERAÇÃO (entra no resultado da operação dona).
const op1b = run(new Set(['p1-fornopg']), { gerente: 1, bau: 0 }); // 1 gerente -> +R$10
assert.strictEqual(op1b.resultado, 60, 'op1 com 1 gerente -> +10 no resultado');
const op2b = run(new Set(['11-noitepg', 'p4-listrapg']), { gerente: 0, bau: 2 }); // 2 BAU -> +R$20
assert.strictEqual(op2b.resultado, -30, 'op2 com 2 BAU -> -50+20');

// (6) NULO propaga: casa do escopo sem depósito -> total do escopo indeterminado (não zera errado).
const efNulo = { ...efetivo, por_casa: [{ casa: 'p1-fornopg', deposito: null, saque: 150, depositos: 2, saques: 1, contas: 2 }, ...efetivo.por_casa.slice(1)] };
const opNulo = calculate({ ...base, efetivo: scopeEfetivo(efNulo, new Set(['p1-fornopg'])) });
assert.strictEqual(opNulo.td, null, 'depósito nulo -> td nulo');
assert.strictEqual(opNulo.resultado, null, 'depósito nulo -> resultado nulo (não finge 0)');

// (7) Chave da casa é comparada em minúsculas (escopo minúsculo casa com por_casa em maiúsculas).
const efCase = { ...efetivo, por_casa: [{ ...efetivo.por_casa[0], casa: 'P1-FORNOPG' }] };
const opCase = calculate({ ...base, efetivo: scopeEfetivo(efCase, new Set(['p1-fornopg'])) });
assert.strictEqual(opCase.td, 100, 'case-insensitive: casa MAIÚSCULA ainda entra no escopo');

// (8) residualClose puro: a última operação recebe o RESÍDUO (total do servidor − já atribuído).
const rc = residualClose(0 /*servidor result cents*/, 6 /*servidor contas*/, 5000 /*já atribuído a op1*/, 2 /*contas op1*/, 1 /*metas da op2*/);
assert.deepStrictEqual(rc.values, [-5000], 'resíduo op2 = 0 - 5000 = -5000 (=-R$50)');
assert.deepStrictEqual(rc.contas, [4], 'contas resíduo = 6 - 2 = 4');
// contas indeterminadas no servidor -> resíduo de contas nulo (não inventa)
assert.strictEqual(residualClose(0, null, 5000, 2, 1).contas, null, 'servidor sem contas -> contas nula');
// divisão do resíduo entre 2 metas da última operação
assert.deepStrictEqual(residualClose(-3000, 4, 0, 0, 2).values, [-1500, -1500], 'resíduo dividido entre 2 metas');

// (9) PONTA A PONTA: ciclo com op1 (p1, 1 meta) fechada ANTES no cliente e op2 (11+p4, 1 meta)
// fechando por último no servidor. Com bônus só na op1. Conservação = soma bate com o servidor.
(() => {
  // op1 intermediária: resultado escopado da op1 COM 1 gerente (+R$10) -> R$60 (6000 centavos), 2 contas.
  const rop1 = calculate({ ...base, gerente: 1, bau: 0, efetivo: scopeEfetivo(efetivo, new Set(['p1-fornopg'])) });
  assert.strictEqual(rop1.resultado, 60, 'op1 fecha no cliente com +60');
  const jaResult = Math.round(rop1.resultado * 100), jaContas = rop1.contas; // 6000, 2
  // op2 final: servidor congela o ciclo INTEIRO com o gerente/bau TOTAL (op1 1 + op2 0 = 1 gerente),
  // então o total do servidor = saldo global (0) + bônus total (+10) = R$10 (1000 centavos), 6 contas.
  const totalServidorCents = 1000, totalServidorContas = 6;
  const fin = residualClose(totalServidorCents, totalServidorContas, jaResult, jaContas, 1);
  assert.deepStrictEqual(fin.values, [-5000], 'op2 recebe o resíduo -R$50 (seu saldo, sem bônus)');
  assert.deepStrictEqual(fin.contas, [4], 'op2 recebe 4 contas');
  // Conservação: op1 (60) + op2 (-50) == total do servidor (10). Nada criado, nada perdido.
  assert.strictEqual(jaResult + fin.values[0], totalServidorCents, 'soma das operações == total do servidor');
  assert.strictEqual(jaContas + fin.contas[0], totalServidorContas, 'soma das contas == total do servidor');
})();

console.log(JSON.stringify({ status: 'ok', global: g.resultado, op1: op1.resultado, op2: op2.resultado, conservacao: 'ok', verificacoes: 30 }, null, 2));
