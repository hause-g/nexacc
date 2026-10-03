/* Testes isolados — FASE 4 (regra de divisão do fechamento). Node puro. Rodar: node testes/fase4.js
   Réplica fiel da regra do fecharCicloAoVivo: N metas dividem IGUAL, sobra na última; depositantes = contas distintas. */
"use strict";
var falhas = 0, oks = 0;
function ok(c, m) { if (c) { oks++; console.log("  ok  " + m); } else { falhas++; console.log("  XX  FALHOU: " + m); } }
function round2(x) { return Math.round(x * 100) / 100; }

function splitMetas(N, resultado, totDep) {
  var out = [], somaL = 0, somaD = 0;
  for (var i = 0; i < N; i++) {
    if (i === N - 1) { out.push({ lucro: round2(resultado - somaL), dep: totDep - somaD }); }
    else { var l = round2(resultado / N), d = Math.round(totDep / N); out.push({ lucro: l, dep: d }); somaL += l; somaD += d; }
  }
  return out;
}
function soma(a, k) { return a.reduce(function (s, x) { return s + x[k]; }, 0); }

console.log("== 1 meta recebe TUDO ==");
var s1 = splitMetas(1, 100, 7);
ok(s1.length === 1 && s1[0].lucro === 100 && s1[0].dep === 7, "N=1: lucro 100, dep 7");

console.log("== 2 metas: divisão igual, sobra na última, soma exata ==");
var s2 = splitMetas(2, 100, 7);
ok(round2(soma(s2, "lucro")) === 100, "soma dos lucros = 100 (exato)");
ok(soma(s2, "dep") === 7, "soma dos depositantes = 7 (exato)");
ok(s2[0].dep + s2[1].dep === 7 && s2[0].dep >= 0 && s2[1].dep >= 0, "dep soma 7 (sobra ajustada na última)");

console.log("== 3 metas com dízima: soma bate exatamente ==");
var s3 = splitMetas(3, 100, 10);
ok(round2(soma(s3, "lucro")) === 100, "soma dos lucros = 100 (3-way)");
ok(soma(s3, "dep") === 10, "soma dos depositantes = 10");

console.log("== resultado NEGATIVO (perda) divide igual ==");
var s4 = splitMetas(2, -80, 5);
ok(round2(soma(s4, "lucro")) === -80, "soma = -80");
ok(soma(s4, "dep") === 5, "dep soma 5");

console.log("\n=== RESULTADO: " + oks + " ok, " + falhas + " falha(s) ===");
process.exit(falhas ? 1 : 0);
