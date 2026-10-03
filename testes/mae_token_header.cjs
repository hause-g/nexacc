/* Regressao: a casa manda o token no HEADER HTTP (nao na query). Se o hook so olhar a query,
   a chave md5(token+username) nunca existe, nenhuma resposta decifra e a captura morre em silencio
   (foi o que aconteceu em 11/09/2026). Este teste falha se voltarmos a ignorar o header.

   Cobre tambem o PERIODO (12/09/2026): a casa marca a aba ativa de varios jeitos e diz o periodo
   escolhido no CORPO cifrado da requisicao (timeEnum). Exigir exatamente '.ui-tab-active' fazia
   tudo virar 'desconhecido' e travava a navegacao da mae. */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const root = path.join(__dirname, "..", "extensao_agente");
// Token e uid SINTETICOS: o teste cifra e decifra com o que estiver aqui, entao nao precisa (e nao
// deve) carregar credencial real de sessao da conta mae num arquivo versionado.
const TOKEN = "f1x7ur3000000000000000000000000000000001", USER = "900000001";
let falhas = 0;
function check(cond, msg) { console.log((cond ? "  ok  " : "  XX  FALHOU: ") + msg); if (!cond) falhas++; }

function cifrar(texto, token, user) {
  const key = crypto.createHash("md5").update(token + user).digest("hex").slice(0, 16);
  const data = Buffer.from(texto), padded = Buffer.alloc(Math.ceil(data.length / 16) * 16); data.copy(padded);
  const aes = crypto.createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from("exemploiv1234567"));
  aes.setAutoPadding(false);
  return Buffer.concat([aes.update(padded), aes.final()]).toString("base64");
}

// Aba como a casa realmente entrega. 'marca' diz COMO o ativo esta sinalizado:
// 'classe' = ui-tab-active | 'variante' = ui-tab-card-active | 'aria' = aria-selected | 'pai' = marca no pai
function aba(rotulo, marca) {
  const el = { textContent: rotulo, className: "ui-tab ui-tab-card", parentElement: null,
               getAttribute: (k) => (marca === "aria" && k === "aria-selected") ? "true" : null };
  if (marca === "classe") el.className = "ui-tab ui-tab-card ui-tab-active";
  if (marca === "variante") el.className = "ui-tab ui-tab-card-active";
  if (marca === "pai") el.parentElement = { className: "ui-tab-wrap ui-tab-active", getAttribute: () => null };
  return el;
}

function montarAba() {
  const posts = [], eventos = {};
  const ctx = vm.createContext({ console, URL, Uint8Array, atob, Date, JSON, Math,
    TextDecoder: class { decode(b) { return Buffer.from(b).toString("utf8"); } },
    crypto: { randomUUID: () => crypto.randomUUID() } });
  ctx.window = ctx; ctx.self = ctx; ctx.top = ctx;
  ctx.location = { hostname: "hft.turistapgpay.com", href: "https://hft.turistapgpay.com/home/promote?active=myData" };
  ctx.__tabs = [aba("Este Mês", "classe")];
  ctx.document = { querySelectorAll: () => ctx.__tabs };
  ctx.localStorage = { getItem: () => JSON.stringify({ userInfos: { username: USER, userId: USER, platfromid: "casa-mae-demo" } }) };
  ctx.sessionStorage = { getItem: () => null, setItem: () => {} };
  ctx.addEventListener = (n, f) => ((eventos[n] ||= []).push(f));
  ctx.postMessage = (d) => posts.push(d);
  ctx.setInterval = () => 0; ctx.setTimeout = () => 0;
  ctx.XMLHttpRequest = class { open() {} send() {} addEventListener() {} };
  ctx.fetch = () => Promise.resolve({ ok: true, status: 200, clone: () => ({ text: () => {
    if (typeof ctx.__onText === "function") ctx.__onText();
    return Promise.resolve(ctx.__resp);
  } }) });
  const carregar = (n) => vm.runInContext(fs.readFileSync(path.join(root, n), "utf8"), ctx, { filename: n });
  ["origem_main.js", "core_agente.js", "cryptolib.js", "classify_agente.js", "hook_agente.js"].forEach(carregar);
  return { ctx, posts };
}

const CORPO = JSON.stringify({ code: 1, msg: "ok", data: {
  timeTotalDeposit: 1873, timeTotalDepositPerson: 20,
  timeTotalFirstDeposit: 1419, timeTotalFirstDepositPerson: 20,
  timeTotalWithdraw: 640, timeTotalWithdrawPerson: 7,
  timeTotalValidBet: 5883, timeTotalValidBetPerson: 20 } });
const URLP = "https://hft.turistapgpay.com/hall/api/agent/promote/report/myPeriodDataV2";
const HDRS = { token: TOKEN, "x-object-id": JSON.stringify({ uid: Number(USER) }) };

async function rodar(ajuste, init) {
  const { ctx, posts } = montarAba();
  ctx.__resp = cifrar(CORPO, TOKEN, USER);
  if (ajuste) ajuste(ctx);
  await ctx.fetch(URLP, Object.assign({ method: "POST", headers: HDRS }, init || {}));
  await new Promise((r) => setImmediate(r));
  return posts.map((p) => p && p.evt).filter(Boolean).find((e) => e.tipo === "agente_total");
}

(async () => {
  console.log("== token SOMENTE no header (caso real da casa) ==");
  {
    const ev = await rodar();
    check(!!ev, "emitiu agente_total com o token vindo do header");
    if (ev) {
      check(ev.deposito === 1873, "deposito decifrado = 1873 (veio " + ev.deposito + ")");
      check(ev.contas === 20, "contas decifradas = 20 (veio " + ev.contas + ")");
      check(ev.saque === 640, "saque decifrado = 640 (veio " + ev.saque + ")");
      // a aposta do periodo vem em timeTotalValidBet; sem ler esse campo o painel dizia
      // "Apostas informadas: Nao informado" mesmo com a casa mostrando o valor na tela
      check(ev.aposta === 5883, "aposta do periodo = 5883 (veio " + ev.aposta + ")");
      check(ev.aposta_pessoas === 20, "pessoas com aposta = 20 (veio " + ev.aposta_pessoas + ")");
    }
  }

  console.log("== controle negativo: sem token nenhum, nao deve inventar dado ==");
  {
    const { ctx, posts } = montarAba();
    ctx.__resp = cifrar(CORPO, TOKEN, USER);
    await ctx.fetch(URLP, { method: "POST", headers: { "x-request-id": "abc" } });
    await new Promise((r) => setImmediate(r));
    check(!posts.map((p) => p && p.evt).filter(Boolean).some((e) => e.tipo === "agente_total"),
      "sem token nao emite evento financeiro (nao decifra)");
  }

  console.log("== filtro de periodo so renderiza DEPOIS da requisicao (caso real) ==");
  {
    const ev = await rodar((ctx) => {
      ctx.__tabs = [];                                                    // no document_start a aba nem existe
      ctx.__onText = () => { ctx.__tabs = [aba("Este Mês", "classe")]; };  // aparece so na resposta
    });
    check(!!ev, "emitiu agente_total mesmo com a aba ausente na saida da requisicao");
    check(!!ev && ev.periodo_observado === true, "periodo foi observado na resposta (nao ficou 'desconhecido')");
    check(!!ev && /^mes@/.test(String(ev.periodo)), "periodo reconhecido como 'mes@AAAA-MM' (veio " + (ev && ev.periodo) + ")");
  }

  console.log("== a marca de 'aba ativa' varia: nenhuma variacao pode virar 'desconhecido' ==");
  for (const marca of ["classe", "variante", "aria", "pai"]) {
    const ev = await rodar((ctx) => { ctx.__tabs = [aba("Este Mês", marca)]; });
    check(!!ev && /^mes@/.test(String(ev.periodo)), "aba ativa por '" + marca + "' e reconhecida (veio " + (ev && ev.periodo) + ")");
  }

  console.log("== controle negativo: aba SEM marca de ativa nao vira periodo ==");
  {
    const ev = await rodar((ctx) => { ctx.__tabs = [aba("Este Mês", null)]; });
    check(!!ev, "o evento continua sendo entregue (o periodo nao bloqueia a entrega)");
    check(!!ev && ev.periodo === "desconhecido", "aba nao-ativa nao e lida como periodo (veio " + (ev && ev.periodo) + ")");
    check(!!ev && ev.periodo_observado === false, "periodo_observado=false quando nada esta ativo");
  }

  console.log("== periodo dito pela casa no CORPO cifrado da requisicao (timeEnum) ==");
  {
    const corpoReq = cifrar(JSON.stringify({ timeEnum: 2, time: 1788922862 }), TOKEN, USER);
    const ev = await rodar(null, { body: corpoReq });
    check(!!ev && ev.periodo_enum === 2, "extraiu timeEnum=2 do corpo cifrado (veio " + (ev && ev.periodo_enum) + ")");
  }
  {
    // sem corpo a captura nao pode inventar um numero de periodo
    const ev = await rodar();
    check(!!ev && ev.periodo_enum === undefined, "sem corpo nao inventa periodo_enum (veio " + (ev && ev.periodo_enum) + ")");
  }

  console.log("== paginacao: o numero da pagina vem da REQUISICAO, nao da resposta ==");
  {
    // A resposta observada da casa traz list/total/more/pageSize e NAO traz pageNo/totalPages.
    // Sem ler page/pageSize do corpo cifrado da requisicao, a cobertura nunca se prova e a lista
    // nunca consolida (349 coletas e ZERO listas consolidadas ate 12/09/2026).
    const lista = (n, total, more) => JSON.stringify({ code: 1, msg: "ok", data: {
      list: Array.from({ length: n }, (_, i) => ({ userIdx: 1000 + i, account: "conta" + i, deposit: 10, validBet: 5 })),
      total: total, pageSize: 20, more: more } });
    const urlLista = "https://hft.turistapgpay.com/hall/api/agent/promote/report/directReportV5";
    const pedir = async (corpoResp, pedido) => {
      const { ctx, posts } = montarAba();
      ctx.__resp = cifrar(corpoResp, TOKEN, USER);
      await ctx.fetch(urlLista, { method: "POST", headers: HDRS, body: cifrar(JSON.stringify(pedido), TOKEN, USER) });
      await new Promise((r) => setImmediate(r));
      return posts.map((p) => p && p.evt).filter(Boolean).find((e) => e.tipo === "agente_membros");
    };
    const uma = await pedir(lista(15, 15, false), { page: 1, pageSize: 20, timeEnum: 2 });
    check(!!uma, "emitiu agente_membros");
    check(!!uma && uma.pagina === 1, "pagina 1 veio do corpo da requisicao (veio " + (uma && uma.pagina) + ")");
    check(!!uma && uma.total_paginas === 1, "total_paginas calculado de total/pageSize (veio " + (uma && uma.total_paginas) + ")");
    check(!!uma && uma.mais === false, "fim de lista confirmado pela resposta");

    const primeira = await pedir(lista(20, 29, true), { page: 1, pageSize: 20, timeEnum: 2 });
    check(!!primeira && primeira.total_paginas === 2, "29 registros com pageSize 20 sao 2 paginas (veio " + (primeira && primeira.total_paginas) + ")");
    const segunda = await pedir(lista(9, 29, false), { page: 2, pageSize: 20, timeEnum: 2 });
    check(!!segunda && segunda.pagina === 2, "segunda pagina identificada (veio " + (segunda && segunda.pagina) + ")");
    check(!!segunda && segunda.total_paginas === 2, "total_paginas estavel entre as paginas");

    // sem page no corpo nao se inventa numero: melhor cobertura nao comprovada do que errada
    const cega = await pedir(lista(15, 15, false), { timeEnum: 2 });
    check(!!cega && cega.pagina === null, "sem page no corpo nao inventa numero de pagina (veio " + (cega && cega.pagina) + ")");
  }

  console.log("\n=== RESULTADO: " + falhas + " falha(s) ===");
  process.exit(falhas ? 1 : 0);
})();
