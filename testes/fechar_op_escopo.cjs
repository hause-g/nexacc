/* Fechar operação: (bug1) o escopo não pode voltar ao GLOBAL quando sobra 1 op mas houve fechamento
   parcial (senão a casa fechada reaparece unificada); (bug2) a mãe da casa fechada some da Conta Mãe
   mesmo com a chave da MÃE (exemplo) diferente da FILHA (p2-exemplopg). Extrai as funções REAIS de
   index.html + agentum-operacao.js e mocka os globais. node testes/fechar_op_escopo.cjs */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const idx = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const opsrc = fs.readFileSync(path.resolve(__dirname, '..', 'assets', 'agentum-operacao.js'), 'utf8');

// extrai `marker ... { ...braces... } [;]` do fonte (função window.X=function ou declaração)
function grab(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'não achei: ' + marker);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (src[end] === ';') end++;
  return src.slice(start, end);
}

const gMaeChave = grab(idx, 'window.maeChave=function');
const gOcultar = grab(idx, 'window.ocultarMaesFechadas=function');
const gMostrar = grab(idx, 'window.mostrarMaesDeMetas=function');
const gEscopo = grab(idx, 'window.aovivoEscopo=function');
let gOcultaConta = grab(opsrc, 'function maeOcultaDaConta');
gOcultaConta = gOcultaConta.replace('function maeOcultaDaConta', 'maeOcultaDaConta = function');

// casas por operação: op da p2 -> filha p2-exemplopg; op da p4 -> filha p4-modelopg
const CASAS = { mW1: ['p2-exemplopg'], p2: ['p2-exemplopg'], mWE: ['p4-modelopg'], p4: ['p4-modelopg'] };
function makeEnv(estado, Estado, ops, activeId) {
  const window = {};
  const opsAoVivo = () => ops;
  const opAtivaAoVivo = () => ops.find(o => o.id === activeId) || ops[0] || null;
  const casasDaOp = (op) => {
    const src = (op && op.metaIds) ? op.metaIds : (op && op.id ? [op.id] : []);
    const set = new Set();
    src.forEach(x => (CASAS[x] || []).forEach(c => set.add(c)));
    return set;
  };
  let maeOcultaDaConta;
  const lastState = Estado && Estado._lastState;   // filhas_da_mae do servidor (quando o teste fornece)
  eval(gMaeChave); eval(gOcultar); eval(gMostrar); eval(gEscopo); eval(gOcultaConta);
  return { window, estado, Estado, opsAoVivo, opAtivaAoVivo, casasDaOp, maeOcultaDaConta };
}

// ---- maeChave puro ----
const mc = makeEnv({ maeOcultas: [] }, { ciclo_id: 19 }, [], null).window.maeChave;
assert.equal(mc('p2-exemplopg'), 'exemplo');
assert.equal(mc('p4-modelopg'), 'modelo');
assert.equal(mc('p1-casinhapg'), 'casinha');
assert.equal(mc('exemplopg'), 'exemplo');
assert.equal(mc('11-noitepg'), 'noite');
assert.equal(mc('exemplo'), 'exemplo');

// ---- bug1: escopo ----
const ops2 = [{ id: 'p2', metaIds: ['mW1'] }, { id: 'p4', metaIds: ['mWE'] }];
// 2 ops: escopa à ativa (p2)
let e = makeEnv({ maeOcultas: [], fechamentosParciais: {} }, { ciclo_id: 19 }, ops2, 'p2');
assert.deepEqual([...e.window.aovivoEscopo()], ['p2-exemplopg'], '2 ops -> escopo da ativa');
// 1 op, SEM fechamento parcial: global (null) — como sempre
e = makeEnv({ maeOcultas: [], fechamentosParciais: {} }, { ciclo_id: 19 }, [ops2[1]], 'p4');
assert.equal(e.window.aovivoEscopo(), null, '1 op sem parcial = global');
// 1 op, COM fechamento parcial no ciclo: NÃO volta ao global (o fix) — escopa à ativa
e = makeEnv({ maeOcultas: [], fechamentosParciais: { 19: { resultadoCents: -100 } } }, { ciclo_id: 19 }, [ops2[1]], 'p4');
assert.deepEqual([...e.window.aovivoEscopo()], ['p4-modelopg'], '1 op APÓS fechar parcial -> escopo da ativa (não vaza)');
// 24/09: meta FINALIZADA dentro da operação ativa não traz a casa dela de volta (p1-rolamento encerrada
// aparecia na OP da 11). Só as metas abertas contam; todas fechadas = a operação inteira.
e = makeEnv({ maeOcultas: [], fechamentosParciais: {} }, { ciclo_id: 19 }, [{ id: 'mix', metaIds: ['mW1', 'mWE'] }, ops2[1]], 'mix');
e.window.metasAbertasDaOp = op => (op.metaIds || []).filter(id => id !== 'mW1').map(id => ({ id }));
assert.deepEqual([...e.window.aovivoEscopo()], ['p4-modelopg'], 'meta finalizada (mW1) fica fora do escopo');
e.window.metasAbertasDaOp = () => [];
assert.deepEqual([...e.window.aovivoEscopo()].sort(), ['p2-exemplopg', 'p4-modelopg'], 'todas fechadas -> operação inteira');

// ---- bug2: mãe some ao fechar; guarda protege op ativa ----
// estado inicial: 2 ops ativas, mãe exemplo visível
let st = { maeOcultas: [], fechamentosParciais: {} };
e = makeEnv(st, { ciclo_id: 19 }, ops2, 'p2');
assert.equal(e.maeOcultaDaConta('exemplo'), false, 'mãe exemplo visível com a op p2 ativa');
// fecha a op p2: oculta a mãe derivada (exemplo) e sobra só a p4
e.window.ocultarMaesFechadas(['mW1']);
assert.ok(st.maeOcultas.includes('p2-exemplopg') && st.maeOcultas.includes('exemplo'), 'ocultou filha + mãe derivada');
const e2 = makeEnv(st, { ciclo_id: 19 }, [ops2[1]], 'p4');   // p2 removida
assert.equal(e2.maeOcultaDaConta('exemplo'), true, 'BUG2 FIX: mãe exemplo some ao fechar a op da p2');
assert.equal(e2.maeOcultaDaConta('modelo'), false, 'mãe modelo (op ativa) continua visível');
// 24/09: mãe de chave OPACA (hostExemplo1, chamada de 11-gatinhopg) fecha pela filha dela.
const LS = { filhas_da_mae: { hostExemplo1: [{ filha: '11-gatinhopg', motivo: 'nome dado à mãe' }] } };
const eOp1 = makeEnv({ maeOcultas: ['11-gatinhopg', 'gatinho'] }, { ciclo_id: 19, _lastState: LS }, [], null);
assert.equal(eOp1.maeOcultaDaConta('hostExemplo1'), true, 'mãe opaca some quando a filha dela fechou');
const eOp2 = makeEnv({ maeOcultas: [] }, { ciclo_id: 19, _lastState: LS }, [], null);
assert.equal(eOp2.maeOcultaDaConta('hostExemplo1'), false, 'filha aberta: mãe visível');
// guarda: se a op da p2 ainda estiver ativa, exemplo NÃO some mesmo estando em maeOcultas
const e3 = makeEnv(st, { ciclo_id: 19 }, ops2, 'p2');
assert.equal(e3.maeOcultaDaConta('exemplo'), false, 'op ativa protege a mãe pela chave-mãe derivada');
// reabrir mostra de volta
e3.window.mostrarMaesDeMetas(['mW1']);
assert.ok(!st.maeOcultas.includes('exemplo') && !st.maeOcultas.includes('p2-exemplopg'), 'reabrir remove filha + mãe derivada');

console.log('fechar_op_escopo.cjs OK');
