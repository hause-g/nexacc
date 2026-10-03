"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const N = require("../extensao/normalizar.js"), parser = require("../extensao/classify.js");
const { encrypt } = require("./captura_helpers.cjs");
const classify = (route, data, ctx = { conta: "acct-A", users: ["acct-A"], tokens: [] }) =>
  parser.classificar({ url: route, host: "demo12.com", resp: typeof data === "string" ? data : JSON.stringify(data) }, ctx);
const ops = items => items.filter(x => ["saque", "deposito"].includes(x.tipo));
test("moeda real: 52.00/ptBR/US, milhares, ausência e centavos seguros", () => {
  for (const value of [52, "52", "52.00", "52,00", "R$ 52.00", "R$ 52,00", "52,00 BRL"]) assert.equal(N.dinheiro(value), 52);
  for (const value of ["1.234,56", "1,234.56", 1234.56]) assert.equal(N.dinheiro(value), 1234.56);
  assert.equal(N.dinheiro("1.234"), 1234);
  assert.equal(N.dinheiro("123456789012.34"), 123456789012.34);
  for (const value of [null, undefined, true, "", "abc", "52lixo", "1,2,3", "12.34,56", 1.234, Infinity, "9007199254740993"]) assert.equal(N.dinheiro(value), null, String(value));
});
test("JSON original preserva IDs longos/textuais, rejeita JSON inválido", () => {
  const raw = '{"data":{"orderNo":123456789012345678901234567890,"money":"52.00","status":4}}';
  assert.equal(ops(classify("finance/certify/orderInfo", raw))[0].numero_pedido, "123456789012345678901234567890");
  const unicode = '{"n":12345678901234567890,"s":"A\\\\B \\"12345678901234567890\\" ç"}';
  assert.equal(N.parseJSON(unicode).s, 'A\\B "12345678901234567890" ç');
  for (const malformed of ['{"a":1}lixo', '{"a":01}', '{"a":', '["a",]']) assert.equal(N.parseJSON(malformed), null);
  assert.equal(N.id(9007199254740992), "");
  const textId = "order-ABCDEFGHIJKLMNOPQRSTUVWXYZ_01234567890123456789";
  assert.equal(ops(classify("finance/pay/orderInfo", { data: { order_no: textId, amount: 52, status: 2 } }))[0].numero_pedido, textId);
});
test("decifração real AES conserva IDs, conta e dinheiro", () => {
  const data = '{"data":{"orderNo":12345678901234567890,"money":"52.00","status":4}}';
  const out = classify("finance/certify/orderInfo", encrypt(data), { tokens: ["mock-token"], users: ["acct-A"] });
  assert.equal(ops(out)[0].numero_pedido, "12345678901234567890");
  assert.equal(ops(out)[0].conta, "acct-A");
  assert.equal(ops(out)[0].valor, 52);
});
test("cashV3 aceita somente code1 + ID real, nunca valor financeiro", () => {
  for (const code of [0, 2, 500, undefined]) {
    const result = classify("finance/certify/cashV3", { code, data: { orderNo: "cash-1", money: 52, status: 4 } });
    assert.equal(result.filter(e => e.tipo === "pedido").length, 0);
    assert.equal(ops(result).length, 0);
  }
  const [pedido] = classify("finance/certify/cashV3", { code: 1, data: { orderNo: "cash-1", money: 52, status: 4 } });
  assert.equal(pedido.tipo, "pedido"); assert.equal(pedido.estado, "identificado"); assert.equal(pedido.valor, null);
});
test("saque final apenas 4; histórico descobre todos pedidos sem inventar falha final", () => {
  for (const status of [undefined, 0, 1, 2, 3, 5, "rejeitado", true]) {
    const result = classify("finance/certify/orderInfo", { data: { orderNo: "P2", money: 52, status } });
    assert.equal(ops(result).length, 0); assert.equal(result[0].tipo, "pedido");
    assert.notEqual(result[0].estado, "falhou");
  }
  for (const status of [4, "4"]) assert.equal(ops(classify("certify/withdrawRecord", { data: { records: [{ orderNo: "W2", money: 52, status }] } })).length, 1);
  for (const value of [undefined, null, "", "lixo", -52, 0]) {
    const result = classify("finance/certify/orderInfo", { data: { orderNo: "W3", money: value, status: 4 } });
    assert.equal(ops(result).length, 0); assert.equal(result[0].valor, null); assert.equal(result[0].estado, "verificar");
  }
});
test("accountPageList não prova conclusão nem por status emprestado de outra rota", () => {
  for (const label of ["Saque", "Solicitação de saque", "Devolução de saque", "Saque rejeitado", "Depósito"]) {
    for (const status of [undefined, 1, 3, 4]) {
      const out = classify("finance/user/accountPageList", { data: { data: [{ orderNo: "ledger-1", item_count: "-52.00", opt_type_text: label, status }] } });
      assert.equal(ops(out).length, 0); assert.equal(out[0].tipo, "pedido");
    }
  }
});
test("depósitos históricos pendentes, valor ausente não soma, data oficial não é inventada", () => {
  const out = classify("finance/pay/orderListV3", { data: { list: [
    { order_no: "D1", status: 1, amount: 52 },
    { order_no: "D2", status: 2 },
    { order_no: "D3", status: 2, amount: "52.00", createTime: "2026-09-09T22:00:00-03:00" }
  ] } });
  assert.equal(out.filter(e => e.tipo === "pedido").length, 3);
  assert.equal(ops(out).length, 1); assert.equal(ops(out)[0].data, "2026-09-09T22:00:00-03:00");
  const account = classify("finance/user/accountTotalV2", { data: { balance: 52 } })[0];
  assert.equal(account.saldo, 52); assert.ok(!("totalCharge" in account)); assert.ok(!("totalWithdraw" in account));
});
test("erros de API, jogos e rotas desconhecidas nunca produzem dinheiro", () => {
  for (const envelope of [{ code: null }, { code: 0 }, { code: 200 }, { code: "0" }, { code: "200" }, { code: 500 }, { code: 1, error: "failed" }, { code: 1, success: false }, { code: 1, status: "error" }]) {
    assert.equal(ops(classify("finance/certify/orderInfo", { ...envelope, data: { orderNo: "W4", status: 4, money: 52 } })).length, 0);
  }
  assert.equal(ops(classify("finance/certify/orderInfo", { code: 1, data: { orderNo: "W4-ok", status: 4, money: 52 } })).length, 1);
  for (const url of ["game-api/x/v2/spin", "bet-manager/recentreport/betrecords", "finance/certify/orderInfoFake", "pay/paysubmit"]) {
    assert.equal(classify(url, { data: { orderNo: "W5", status: 4, money: 52 } }).length, 0);
  }
});

test("PIX gerado (paysubmit): pedido 'identificado' com a hora de criação, sem dinheiro e sem código PIX", () => {
  // Envelope real (952 respostas medidas em 23/09): code '' ou '0000' com success:true; orderNo + createTime epoch.
  const resp = { code: "", success: true, msg: "", orderNo: "211272324560033358883", createTime: 1790180000,
    qrCode: "SEGREDO-PIX-COPIA-E-COLA", payAddress: "SEGREDO-ENDERECO", data: "https://pix.exemplo/pagar", type: 1 };
  const out = classify("finance/pay/paysubmit", resp);
  assert.equal(ops(out).length, 0, "criação do PIX não é dinheiro");
  const ped = out.filter(e => e.tipo === "pedido");
  assert.equal(ped.length, 1);
  assert.equal(ped[0].tipo_pedido, "deposito");
  assert.equal(ped[0].estado, "identificado");
  assert.equal(ped[0].numero_pedido, "211272324560033358883");
  assert.equal(ped[0].valor, null);
  assert.equal(ped[0].data, 1790180000, "hora de criação vira data oficial");
  assert.equal(/SEGREDO/.test(JSON.stringify(out)), false, "código PIX nunca sai no evento");
  assert.equal(classify("finance/pay/paysubmit", { ...resp, code: "0000" }).filter(e => e.tipo === "pedido").length, 1);
  assert.equal(classify("finance/pay/paysubmit", { ...resp, success: false }).length, 0);
  assert.equal(classify("finance/pay/paysubmit", { ...resp, createTime: undefined }).length, 0, "sem hora não registra");
  assert.equal(classify("finance/pay/paysubmit", { ...resp, createTime: "2026-09-23 12:00:00" }).length, 0, "texto sem fuso segue recusado");
});
test("data oficial: ISO com fuso e epoch entram; texto sem fuso continua recusado", () => {
  // No ciclo 13 nenhuma das 183 operacoes tinha data oficial (100% nos ciclos 9-12): a reescrita
  // passou a exigir ISO com fuso, e sem a data o historico descoberto tarde cai no ciclo da
  // observacao. Epoch e inequivoco e volta a entrar; texto sem fuso NAO, para nao inventar horario.
  const comData = extra => classify("finance/pay/orderInfo", { code: 1, data: { order_no: "d-" + JSON.stringify(extra), amount: 52, status: 2, ...extra } });
  const opDe = extra => ops(comData(extra))[0];
  assert.equal(opDe({ createTime: "2026-09-10T12:00:00Z" }).data, "2026-09-10T12:00:00Z");
  assert.equal(opDe({ createTime: "2026-09-10T12:00:00-03:00" }).data, "2026-09-10T12:00:00-03:00");
  assert.equal(opDe({ createTime: 1788922862 }).data, 1788922862, "epoch em segundos");
  assert.equal(opDe({ createTime: 1788922862000 }).data, 1788922862000, "epoch em milissegundos");
  assert.equal(opDe({ finishTime: 1788922862 }).data, 1788922862, "qualquer um dos campos de data serve");
  for (const invalido of ["2026-09-10 12:00:00", "2026-09-10T12:00:00", "10/09/2026", "", 0, 1, -1788922862, 99999999999999, true, {}]) {
    assert.equal(opDe({ createTime: invalido }).data, undefined, "recusado: " + JSON.stringify(invalido));
  }
  // o pedido correspondente carrega a mesma data
  const pedido = comData({ createTime: 1788922862 }).find(x => x.tipo === "pedido");
  assert.equal(pedido.data, 1788922862);
});

test("identidade de jogo: id do launch, nome do catalogo, par slug/id do frame", () => {
  // O lobby fica sempre na mesma URL; o jogo roda num iframe da PG Soft com token efemero.
  // So a identidade sobe — id, slug e nome. Token e HTML de launcher nunca.
  const corpo = encrypt(JSON.stringify({ gameId: "126", platform: "PG", token: "SESSAO-SECRETA-LONGA" }), "tk1", "acct-A");
  const lanc = parser.classificar({ url: "https://h/hall/api/gameCenter/gameApi/login", host: "demo12.com",
    req: corpo, resp: '{"code":1,"data":{"url":[{"url":"<!DOCTYPE html>"}]}}' }, { conta: "acct-A", users: ["acct-A"], tokens: ["tk1"] });
  assert.equal(lanc.length, 1);
  assert.equal(lanc[0].tipo, "jogo");
  assert.equal(lanc[0].id_jogo, "126");
  assert.equal(lanc[0].origem, "lancamento");
  assert.equal(lanc[0].campos.gameId, "126");
  // o molde e o corpo inteiro: e com ele que a extensao refaz o launch de outro jogo sem o
  // operador abrir nada. Sai do evento no hook, entao nunca chega ao servidor.
  assert.deepEqual(lanc[0].molde, { gameId: "126", platform: "PG", token: "SESSAO-SECRETA-LONGA" });
  assert.equal(lanc[0].campos.token, undefined, "o que SOBE continua sem credencial");

  const cat = encrypt(JSON.stringify({ code: 1, data: [{ gameId: "2", gameName: "Gem Saviour" }, { id: "126", name: "Fortune Tiger" }, { gameName: "sem id" }] }), "tk1", "acct-A");
  const jogos = parser.classificar({ url: "https://h/hall/api/gameCenter/gameApi/favoriteGameList", host: "demo12.com", resp: cat },
    { conta: "acct-A", users: ["acct-A"], tokens: ["tk1"] });
  assert.deepEqual(jogos.map(j => [j.id_jogo, j.nome]), [["2", "Gem Saviour"], ["126", "Fortune Tiger"]]);
  assert.ok(jogos.every(j => j.origem === "catalogo"));

  // frame do jogo: o caminho da o id, a rodada da o slug — foi assim que gem=2 e tiger=126 sairam
  assert.deepEqual(parser.jogoDoFrame("https://m.h9demohash.com/2/index.html?ot=TOKEN", "https://api.x/game-api/gem-saviour/v2/spin?traceId=A"),
    { id_jogo: "2", slug: "gem-saviour" });
  assert.equal(parser.jogoDoFrame("https://www.p4-frotapg.com/home/embedded", "https://api.x/game-api/gem-saviour/v2/spin"), null);
  assert.equal(parser.jogoDoFrame("https://m.x/126/index.html", "https://m.x/126/assets/app.js"), null);
});
