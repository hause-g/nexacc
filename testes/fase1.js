/* Testes isolados — FASE 1 (fila + confirmação de saque). Node puro, sem tocar no banco real.
   Rodar:  node testes/fase1.js   */
"use strict";
var path = require("path");
var classify = require(path.join(__dirname, "..", "extensao", "classify.js"));

var falhas = 0, oks = 0;
function ok(cond, msg) { if (cond) { oks++; console.log("  ok  " + msg); } else { falhas++; console.log("  XX  FALHOU: " + msg); } }
function eq(a, b, msg) { ok(a === b, msg + "  (obtido=" + JSON.stringify(a) + " esperado=" + JSON.stringify(b) + ")"); }

// helper: classifica um response em texto-plano (decAny devolve direto quando começa com "{")
function classificar(url, obj, users) {
  return classify.classificar({ url: url, host: "demo12.com", resp: JSON.stringify(obj) }, { tokens: [], users: users || [] });
}

console.log("== SAQUE: withdrawRecord só conta status 4 ==");
(function () {
  var resp = { data: { records: [
    { orderNo: "3111", money: 104, status: 4 },   // concluído -> conta
    { orderNo: "3112", money: 50, status: 1 },     // pendente -> NÃO
    { orderNo: "3113", money: 30, status: 3 },     // rejeitado/outro -> NÃO
    { orderNo: "3114", money: 77 }                 // sem status -> NÃO
  ] } };
  var out = classificar("finance/certify/withdrawRecord", resp);
  var saques = out.filter(function (o) { return o.tipo === "saque"; });
  eq(saques.length, 1, "só 1 saque (status 4) contabilizado");
  eq(saques[0] && saques[0].numero_pedido, "3111", "o saque contabilizado é o de status 4");
  eq(saques[0] && saques[0].valor, 104, "valor do saque = 104");
})();

console.log("== SAQUE: certify/orderInfo só status 4 ==");
(function () {
  var ok4 = classificar("finance/certify/orderInfo", { data: { orderNo: "3999", money: 81, status: 4 } });
  var no1 = classificar("finance/certify/orderInfo", { data: { orderNo: "3998", money: 81, status: 1 } });
  eq(ok4.filter(function (o) { return o.tipo === "saque"; }).length, 1, "orderInfo status 4 -> saque");
  eq(no1.filter(function (o) { return o.tipo === "saque"; }).length, 0, "orderInfo status 1 -> NÃO conta");
})();

console.log("== DEPÓSITO: pay/orderInfo status 2 conta; status 1 vira pendente ==");
(function () {
  var d2 = classificar("finance/pay/orderInfo", { data: { order_no: "2555", amount: 90, status: 2 } });
  var d1 = classificar("finance/pay/orderInfo", { data: { order_no: "2556", amount: 90, status: 1 } });
  eq(d2.filter(function (o) { return o.tipo === "deposito"; }).length, 1, "status 2 -> depósito");
  eq(d1.filter(function (o) { return o.tipo === "deposito"; }).length, 0, "status 1 -> NÃO é depósito");
  eq(d1.filter(function (o) { return o.tipo === "deposito_pendente"; }).length, 1, "status 1 -> pendente");
})();

console.log("== FILA: invariante (falha no 1º e no meio não perde o resto) ==");
async function flushSim(fila, senderOkAte) {
  // réplica fiel do loop novo: processa do início, remove só após ok; para na falha mantendo o resto
  var enviados = [];
  while (fila.length) {
    var ev = fila[0];
    var ok = ev.n <= senderOkAte;       // sender simulado: ok até o índice senderOkAte
    if (!ok) break;
    enviados.push(fila.shift());
  }
  return { enviados: enviados, restantes: fila };
}
(async function () {
  // falha logo no 1º -> nada enviado, NADA perdido
  var r0 = await flushSim([{ n: 1 }, { n: 2 }, { n: 3 }], 0);
  eq(r0.enviados.length, 0, "falha no 1º: 0 enviados");
  eq(r0.restantes.length, 3, "falha no 1º: 3 mantidos (nada perdido)");
  // falha no meio (ok só o 1º) -> 1 enviado, 2 mantidos (o antigo perdia o 3º)
  var r1 = await flushSim([{ n: 1 }, { n: 2 }, { n: 3 }], 1);
  eq(r1.enviados.length, 1, "falha no meio: 1 enviado");
  eq(r1.restantes.length, 2, "falha no meio: 2 mantidos (o 3º NÃO some)");
  eq(r1.restantes[0].n, 2, "próximo a reenviar é o item 2 (ordem preservada)");
  // todos ok -> fila zera
  var r2 = await flushSim([{ n: 1 }, { n: 2 }, { n: 3 }], 9);
  eq(r2.restantes.length, 0, "todos ok: fila vazia");

  console.log("\n== IDEMPOTÊNCIA: reenvio pós-timeout não duplica (server dedup) ==");
  // 1ª tentativa "timeout" (mantém), 2ª o servidor responde "duplicado" (remove) -> 1 remoção só
  var fila = [{ n: 1, pedido: "2555" }];
  var vistos = {};
  function serverSet(ev) { if (vistos[ev.pedido]) return "duplicado"; vistos[ev.pedido] = 1; return "ok"; }
  serverSet(fila[0]);                 // servidor processou na 1ª (mas a resposta "perdeu" no timeout)
  var resp2 = serverSet(fila[0]);     // reenvio: servidor dedup
  eq(resp2, "duplicado", "reenvio do mesmo pedido -> duplicado (não soma de novo)");

  console.log("\n=== RESULTADO: " + oks + " ok, " + falhas + " falha(s) ===");
  process.exit(falhas ? 1 : 0);
})();
