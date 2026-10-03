/* Regressao: a tela de sucesso capturava o rotulo do botao ("Continuar") como numero de pedido.
   Como esse texto nao bate com o ID real da API, o servidor nao deduplicava e o MESMO deposito
   entrava duas vezes (TELA + API) — visto em producao 11/09/2026 na P2 (R$ 15,00 duplicado). */
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { browser, settle } = require("./captura_helpers.cjs");
const userKey = "web__lobby__persisted__user";
const events = (b) => b.sent.filter((x) => x.__opev).map((x) => x.evt);
const deposits = (b) => events(b).filter((e) => e.tipo === "deposito");
const page = () => browser({ local: { [userKey]: JSON.stringify({ userInfos: { username: "acct-A" } }) } });

test("tela: rotulo de botao sem digito nao vira numero de pedido", async () => {
  const b = page(); await settle();
  // tela real: o texto do botao "Continuar" caia logo depois da palavra "Pedido"
  await b.dom("Depósito sucesso\nR$ 15,00\nPedido\nContinuar");
  assert.equal(deposits(b).length, 0, "nao deve emitir deposito com pedido='Continuar'");

  // controles: IDs legitimos continuam passando (numerico real e alfanumerico com digito)
  await b.dom("Depósito sucesso\nR$ 15,00\nNúmero do Pedido: 211269624451136908750");
  assert.equal(deposits(b).length, 1);
  assert.equal(deposits(b)[0].numero_pedido, "211269624451136908750");

  await b.dom("Depósito sucesso\nR$ 20,00\nPedido: DEP-1234");
  assert.equal(deposits(b).length, 2);
  assert.equal(deposits(b)[1].numero_pedido, "DEP-1234");
});

test("tela: pedido igual ao da API mantem um unico deposito", async () => {
  const b = page(); await settle();
  const id = "211269624451136908750";
  await b.dom("Depósito sucesso\nR$ 15,00\nNúmero do Pedido: " + id);
  await b.dom("Depósito sucesso\nR$ 15,00\nNúmero do Pedido: " + id);
  assert.equal(deposits(b).length, 1, "mesmo pedido nao pode virar dois depositos");
});
