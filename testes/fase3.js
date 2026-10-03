/* Testes isolados — FASE 3 (num() monetário). Node puro.  Rodar: node testes/fase3.js */
"use strict";
var path = require("path");
var classify = require(path.join(__dirname, "..", "extensao", "classify.js"));
var falhas = 0, oks = 0;
function ok(c, m) { if (c) { oks++; console.log("  ok  " + m); } else { falhas++; console.log("  XX  FALHOU: " + m); } }

function dep(amount) {
  var o = classify.classificar({ url: "finance/pay/orderInfo", host: "demo12.com", resp: JSON.stringify({ data: { order_no: "2555", amount: amount, status: 2 } }) }, { tokens: [], users: [] });
  return o.filter(function (x) { return x.tipo === "deposito"; })[0];
}

console.log("== num() rejeita lixo e trata BR/US sem chutar ==");
ok(!dep("52lixo"), 'amount "52lixo" -> rejeitado (sem depósito)');
ok(dep(90) && dep(90).valor === 90, "amount 90 -> 90");
ok(dep("104") && dep("104").valor === 104, '"104" -> 104');
ok(dep("11.6") && dep("11.6").valor === 11.6, '"11.6" -> 11.6');
var br = dep("1.234,56"); ok(br && br.valor === 1234.56, 'BR "1.234,56" -> 1234.56');
var us = dep("1,234.56"); ok(us && us.valor === 1234.56, 'US "1,234.56" -> 1234.56 (não 1.23)');
var cc = dep("104,5"); ok(cc && cc.valor === 104.5, '"104,5" -> 104.5');
ok(!dep(""), "amount vazio -> rejeitado");
ok(!dep("abc"), 'amount "abc" -> rejeitado');

console.log("\n=== RESULTADO: " + oks + " ok, " + falhas + " falha(s) ===");
process.exit(falhas ? 1 : 0);
