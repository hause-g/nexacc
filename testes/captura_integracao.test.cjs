"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { worker, browser, encrypt, response, settle } = require("./captura_helpers.cjs");
test("pipeline real hook → bridge → worker → API mock: aceite/histórico/erro/restart/final", async () => {
  let fail = false, currentWorker;
  const api = async (url, body) => {
    if (fail && url.endsWith("/api/operation")) return response({ status: "erro", motivo: "teste" });
    return response({ status: "ok", ack: { event_id: body.event_id, revision: body.revision } });
  };
  currentWorker = worker({ fetch: api }); await currentWorker.ready();
  const b = browser({ local: { web__lobby__persisted__user: '{"username":"acct-A"}' }, ack: (msg, cb) => {
    if (msg.__opev) currentWorker.receive(msg.evt).then(cb);
    else if (cb) cb({ ts: 0 });
  } });
  await settle();
  await b.fetch("https://mock.invalid/finance/certify/cashV3?token=mock-token",
    encrypt('{"code":1,"data":{"orderNo":"FLOW-1234","money":52}}'));
  await currentWorker.flush();
  const accepted = currentWorker.calls.find(c => c.url.endsWith("/api/pedido")).body;
  assert.equal(accepted.tipo, "saque"); assert.equal(accepted.numero_pedido, "FLOW-1234");
  assert.equal(accepted.valor, null); assert.equal(accepted.estado, "identificado");
  assert.equal(currentWorker.calls.filter(c => c.url.endsWith("/api/operation")).length, 0);
  await b.fetch("https://mock.invalid/certify/withdrawRecord?token=mock-token",
    encrypt('{"code":1,"data":{"records":[{"orderNo":"FLOW-1234","money":"52.00","status":1}]}}'));
  await currentWorker.flush();
  assert.equal(Object.values(currentWorker.data.opCaptura.pedidos)[0].evento.estado, "processando");
  fail = true;
  await b.fetch("https://mock.invalid/certify/withdrawRecord?token=mock-token",
    encrypt('{"code":1,"data":{"records":[{"orderNo":"FLOW-1234","money":"52.00","status":4}]}}'));
  await currentWorker.flush();
  assert.equal(currentWorker.data.opFila.length, 1);
  const queued = currentWorker.data.opFila[0], shared = currentWorker.shared;
  currentWorker.kill(); fail = false;
  currentWorker = worker({ shared, fetch: api }); await currentWorker.ready(); await currentWorker.tick(30000);
  assert.equal(currentWorker.data.opFila.length, 0);
  assert.equal(Object.values(currentWorker.data.opCaptura.pedidos)[0].encerrado, true);
  const financial = currentWorker.calls.find(c => c.url.endsWith("/api/operation")).body;
  assert.equal(financial.event_id, queued.event_id); assert.equal(financial.revision, queued.revision);
  assert.equal(financial.valor, 52); assert.equal(financial.conta, "acct-A");
  assert.equal(/mock-token|storage|session_key/.test(JSON.stringify(currentWorker.calls)), false);
});
