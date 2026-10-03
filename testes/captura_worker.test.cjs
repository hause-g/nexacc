"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { worker, response, settle, clone } = require("./captura_helpers.cjs");
let sequence = 0;
function op(extra = {}) {
  return { tipo: "saque", valor: 52, numero_pedido: "W-" + (++sequence), casa: "demo12", conta: "acct-A",
    origem: "api", captura_id: "capture:" + sequence, contexto: { geracao: "generation-1" }, ...extra };
}
function order(extra = {}) { return op({ tipo: "pedido", tipo_pedido: "saque", estado: "processando", motivo: "status_nao_final_confirmado", ...extra }); }
const financial = w => w.calls.filter(x => x.url.endsWith("/api/operation"));
test("startup lento não sobrescreve legado com evento novo; só gravação durável responde", async () => {
  const old = op(); delete old.captura_id;
  const w = worker({ data: { opFila: [old] }, holdGet: true });
  let answered = false;
  const incoming = w.receive(op()).then(r => { answered = true; return r; });
  await settle();
  assert.equal(answered, false); assert.equal(w.writes.length, 0);
  w.releaseGet(); await incoming; await w.ready();
  assert.equal(w.data.opFila.length, 2);
  assert.equal(new Set(w.data.opFila.map(x => x.numero_pedido)).size, 2);
  await w.flush();
  assert.equal(w.data.opFila.length, 0); assert.equal(financial(w).length, 2);
  assert.equal(financial(w)[0].body.event_id, undefined);
});
test("100 entradas concorrentes persistem e flush não remove uma revisão de saldo nova", async () => {
  let release;
  const w = worker(); await w.ready();
  await Promise.all(Array.from({ length: 100 }, () => w.receive(op())));
  assert.equal(w.data.opFila.length, 100);
  while (w.data.opFila.length) await w.flush();
  assert.equal(financial(w).length, 100);
  w.setFetch(async (url, body) => new Promise(resolve => { release = () => resolve(response({ status: "ok", event_id: body.event_id, revision: body.revision })); }));
  await w.receive(op({ tipo: "conta", saldo: 10 }));
  const running = w.flush(); await settle();
  await w.receive(op({ tipo: "conta", saldo: 20 }));
  assert.equal(w.data.opFila.length, 2);
  w.setFetch(async (url, body) => response({ status: "ok", event_id: body.event_id, revision: body.revision }));
  release(); await running;
  assert.equal(w.data.opFila.length, 0);
  const updates = w.calls.filter(c => c.url.endsWith("/api/conta")).map(c => c.body);
  assert.deepEqual(updates.map(x => x.saldo), [10, 20]);
  assert.notEqual(updates[0].event_id, updates[1].event_id);
  assert.ok(updates[1].revision > updates[0].revision);
});
test("ACK estrito: HTTP/JSON/negócio/ID/revisão incorretos retêm a fila", async () => {
  const cases = [
    async () => response({}, 503),
    async () => ({ ok: true, json: async () => { throw new Error("invalid json"); } }),
    async () => response({ status: "erro" }),
    async () => response({ status: "ok", error: "negocio" }),
    async () => response({ status: "ok" }),
    async () => response({ status: "ok", event_id: "outro" }),
    async (u, b) => response({ status: "ok", event_id: b.event_id, revision: b.revision + 1 }),
    async (u, b) => response({ status: "desconhecido", event_id: b.event_id }),
    async () => { throw new Error("offline"); }
  ];
  for (const fail of cases) {
    const w = worker({ fetch: fail }); await w.ready(); await w.receive(op()); await w.flush();
    assert.equal(w.data.opFila.length, 1); assert.equal(w.notifications.length, 0);
    assert.ok(w.data.opFila[0]._next > w.shared.now);
  }
  for (const status of ["ok", "duplicado", "enriquecido", "promovido", "descartado"]) {
    const w = worker({ fetch: async (u, b) => response({ status, ack: { event_id: b.event_id, revision: b.revision } }) });
    await w.ready(); await w.receive(op()); await w.flush(); assert.equal(w.data.opFila.length, 0);
  }
});
test("reinício/reenvio depois do commit remoto mantém mesmo event_id e revisão", async () => {
  const received = new Set(), w = worker({ fetch: async (u, b) => { received.add(b.event_id); throw new Error("resposta perdida"); } });
  await w.ready(); await w.receive(op()); await w.flush();
  const before = clone(w.data.opFila[0]), shared = w.shared; w.kill();
  const next = worker({ shared, fetch: async (u, b) => response({ status: received.has(b.event_id) ? "duplicado" : "ok", event_id: b.event_id, revision: b.revision }) });
  await next.ready(); await next.flush();
  assert.equal(financial(next).length, 0); // deadline não reinicia nem provoca rajada
  await next.tick(30000);
  assert.equal(next.data.opFila.length, 0);
  assert.equal(financial(next)[0].body.event_id, before.event_id);
  assert.equal(financial(next)[0].body.revision, before.revision);
  assert.equal(next.notifications.length, 0);
});
test("falha de armazenamento não confirma nem perde entrada; repetição é idempotente", async () => {
  const w = worker(); await w.ready(); const event = op();
  w.failSet();
  assert.equal((await w.receive(event)).status, "erro"); assert.equal(w.data.opFila.length, 0);
  assert.equal((await w.receive(event)).status, "persistido");
  await w.receive(event); assert.equal(w.data.opFila.length, 1);
  await w.flush(); assert.equal(financial(w).length, 1);
});
test("erro na leitura inicial não autoriza gravar uma fila vazia", async () => {
  const old = op(), w = worker({ data: { opFila: [old] }, getErrors: 1 });
  await settle(); assert.equal(w.data.opFila.length, 1);
  await w.receive(op()); assert.equal(w.data.opFila.length, 2);
});
test("falha ao salvar remoção após ACK mantém item para reinício e dedup remoto", async () => {
  const w = worker(); await w.ready(); await w.receive(op());
  w.setFetch(async (u, b) => { w.failSet(); return response({ status: "ok", event_id: b.event_id }); });
  await assert.rejects(() => w.flush()); assert.equal(w.data.opFila.length, 1);
  const shared = w.shared; w.kill();
  const resumed = worker({ shared, fetch: async (u, b) => response({ status: "duplicado", event_id: b.event_id }) });
  await resumed.ready(); await resumed.flush(); assert.equal(resumed.data.opFila.length, 0);
  assert.equal(resumed.notifications.length, 0);
});
test("alarms não reiniciam deadline em startup, eventos novos ou erro de API", async () => {
  const w = worker({ fetch: async () => { throw new Error("offline"); } }); await w.ready();
  await w.receive(op()); await w.flush(); await w.schedule();
  const retry = w.data.opFila[0]._next, existing = clone(w.shared.alarms.get("op-entrega"));
  assert.equal(retry, w.shared.now + 30000);
  const shared = w.shared; w.kill();
  const resumed = worker({ shared }); await resumed.ready(); await resumed.schedule();
  assert.equal(resumed.data.opFila[0]._next, retry);
  assert.equal(resumed.shared.alarms.get("op-entrega").scheduledTime, existing.scheduledTime);
  assert.equal(resumed.created.filter(c => c.name === "op-recuperacao").length, 0);
  await resumed.receive(op());
  assert.equal(resumed.data.opFila[0]._next, retry);
  resumed.shared.alarms.delete("op-recuperacao");
  resumed.shared.alarms.delete("op-entrega");
  await resumed.schedule();
  assert.ok(resumed.shared.alarms.has("op-recuperacao")); assert.ok(resumed.shared.alarms.has("op-entrega"));
});
test("pedidos duráveis sobrevivem restart; operação só encerra depois de ACK", async () => {
  const w = worker({ fetch: async (u, b) => u.endsWith("/api/operation") ? response({ status: "erro" }) : response({ status: "ok", event_id: b.event_id }) });
  await w.ready();
  const pending = order({ numero_pedido: "P-FINAL" });
  await w.receive(pending); await w.flush();
  assert.equal(w.data.opFila.length, 0); assert.equal(Object.values(w.data.opCaptura.pedidos)[0].encerrado, false);
  await w.receive(order({ numero_pedido: "P-FINAL", estado: "confirmado", motivo: "status_final_comprovado" }));
  await w.receive(op({ numero_pedido: "P-FINAL" })); await w.flush();
  assert.equal(Object.values(w.data.opCaptura.pedidos)[0].encerrado, false);
  const shared = w.shared; w.kill();
  const resumed = worker({ shared }); await resumed.ready(); await resumed.tick(30000);
  assert.equal(Object.values(resumed.data.opCaptura.pedidos)[0].encerrado, true);
  await resumed.receive(order({ numero_pedido: "P-FINAL", estado: "processando" }));
  assert.equal(Object.values(resumed.data.opCaptura.pedidos)[0].evento.estado, "confirmado");
  assert.equal(Object.values(resumed.data.opCaptura.pedidos)[0].encerrado, true);
  const calls = resumed.calls.length; await resumed.tick(600000);
  // o alarme so pode CONSULTAR (ping e pedido de abrir jogo); reenviar evento de negocio sem
  // nada pendente duplicaria dinheiro no livro
  const consultas = ["/api/ping", "/api/abrir_jogo"];
  assert.ok(resumed.calls.slice(calls).every(c => consultas.some(r => c.url.endsWith(r))),
    "alarme não pode reenviar evento de negócio");
});
test("API de pedidos indisponível não bloqueia confirmação financeira ou conta", async () => {
  const w = worker({ fetch: async (u, b) => u.endsWith("/api/pedido") ? response({ status: "erro" }, 404) : response({ status: "ok", event_id: b.event_id }) });
  await w.ready(); await w.receive(order()); await w.receive(op()); await w.receive(op({ tipo: "conta", saldo: 52 }));
  await w.flush();
  assert.equal(w.data.opFila.length, 1); assert.equal(w.data.opFila[0].tipo, "pedido");
  assert.equal(financial(w).length, 1);
  assert.equal(Object.values(w.data.opCaptura.pedidos)[0].consulta_ativa, "indisponivel_sem_contrato");
});
test("mesmo valor/ID em contas ou casas distintas não se funde; conflito final preserva pendência", async () => {
  const w = worker(); await w.ready();
  for (const [casa, conta] of [["demo12", "A"], ["demo12", "B"], ["outra", "A"]]) {
    await w.receive(order({ numero_pedido: "ID", casa, conta, estado: "confirmado" }));
    await w.receive(op({ numero_pedido: "ID", casa, conta }));
  }
  await w.flush();
  assert.equal(financial(w).length, 3); assert.equal(w.notifications.length, 3);
  assert.equal(Object.keys(w.data.opCaptura.pedidos).length, 3);
  await w.receive(order({ numero_pedido: "ID", casa: "demo12", conta: "A", estado: "confirmado", valor: 77 }));
  assert.equal(Object.values(w.data.opCaptura.pedidos).find(p => p.evento.conta === "A" && p.evento.casa === "demo12").evento.estado, "verificar");
});
test("identidade tardia somente documento/frame/geração exatos; aba não é identidade", async () => {
  const w = worker(); await w.ready();
  await w.receive(op({ conta: "" }));
  await w.receive(op({ tipo: "ctx", conta: "OUTRA", contexto: { geracao: "generation-2" } }));
  await w.flush(); assert.equal(financial(w).length, 0);
  await w.receive(op({ tipo: "ctx", conta: "FRAME" }), { tab: { id: 11 }, frameId: 1, documentId: "doc-1" });
  await w.flush(); assert.equal(financial(w).length, 0);
  await w.receive(op({ tipo: "ctx", conta: "CORRETA" }));
  await w.flush(); assert.equal(financial(w)[0].body.conta, "CORRETA");
  await w.removeTab(11); assert.equal(Object.keys(w.data.opCaptura.contextos).length, 0);
});
test("notificados são limitados por quantidade/idade e legados suspensos não são enviados", async () => {
  const now = 1789050000000;
  const notifications = Array.from({ length: 650 }, (_, i) => ({ key: "old" + i, ts: now }));
  notifications.push({ key: "expired", ts: now - 31 * 86400000 });
  const w = worker({ data: { opFila: [{ tipo: "jogo", records: [] }, { tipo: "__session" }],
    opCaptura: { notificados: notifications } } });
  await w.ready();
  assert.equal(w.data.opCaptura.notificados.length, 500);
  assert.equal(w.data.opCaptura.notificados.some(x => x.key === "expired"), false);
  await w.receive(op()); await w.flush();
  assert.equal(w.data.opFila.length, 2); assert.equal(w.data.opCaptura.notificados.length, 500);
  assert.equal(financial(w).length, 1);
  const serialized = JSON.stringify(w.calls);
  assert.equal(/api\/(?:sessao|game|jogos_cat|debug)/.test(serialized), false);
});
test("operação entregue antes do histórico final não reabre acompanhamento local", async () => {
  const w = worker(); await w.ready();
  await w.receive(op({ numero_pedido: "BEFORE-HISTORY" })); await w.flush();
  await w.receive(order({ numero_pedido: "BEFORE-HISTORY", estado: "confirmado" })); await w.flush();
  assert.equal(Object.values(w.data.opCaptura.pedidos)[0].encerrado, true);
  await w.receive(order({ numero_pedido: "BEFORE-HISTORY", estado: "confirmado", data: "2026-09-09T00:00:00Z" }));
  assert.equal(Object.values(w.data.opCaptura.pedidos)[0].encerrado, true);
});
test("fila ativa deduplica recibo fora do cache sem mudar ID/revisão", async () => {
  const w = worker(); await w.ready();
  const event = op(); await w.receive(event);
  const shared = w.shared, first = clone(w.data.opFila[0]);
  w.kill();
  shared.data.opCaptura.recebidos = [];
  const resumed = worker({ shared }); await resumed.ready(); await resumed.receive(event);
  assert.equal(resumed.data.opFila.length, 1);
  assert.equal(resumed.data.opFila[0].event_id, first.event_id);
  assert.equal(resumed.data.opFila[0].revision, first.revision);
});
test("descartado reconhece transporte, sem fingir liquidação do pedido", async () => {
  const w = worker({ fetch: async (u, b) => response({ status: "descartado", event_id: b.event_id }) }); await w.ready();
  await w.receive(order({ numero_pedido: "DISCARD", estado: "confirmado" }));
  await w.receive(op({ numero_pedido: "DISCARD" })); await w.flush();
  assert.equal(w.data.opFila.length, 0);
  assert.equal(Object.values(w.data.opCaptura.pedidos)[0].encerrado, false);
  assert.equal(w.notifications.length, 0);
});
test("telemetria player possui slots sem segredos; geração anterior sai do contexto ativo", async () => {
  const w = worker(); await w.ready();
  await w.receive(op({ tipo: "ctx", conta: "A", captura_id: "doc:100", contexto: { geracao: "gen:1" } }));
  await w.receive(op({ tipo: "ctx", conta: "B", captura_id: "doc:101", contexto: { geracao: "gen:2" } }));
  await w.receive(op({ tipo: "ctx", conta: "A", captura_id: "doc:100", contexto: { geracao: "gen:1" } }));
  await w.tick(60000);
  const ping = w.calls.filter(c => c.url.endsWith("/api/ping")).at(-1).body;
  assert.equal(ping.tipo, "player"); assert.equal(ping.slots.length, 1); assert.equal(ping.slots[0].conta, "B");
  assert.deepEqual(Object.keys(ping.slots[0]).sort(), ["tab_id", "frame_id", "casa", "conta", "geracao", "estado", "ultimo_evento"].sort());
});
test("timeout de envio aborta a requisição e conserva o mesmo evento", async () => {
  const w = worker({ fetch: async (u, b, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("timeout")));
  }) });
  await w.ready(); await w.receive(op());
  const running = w.flush(); await settle();
  const timeout = Array.from(w.timers.values()).find(t => t.ms === 15000);
  assert.ok(timeout); timeout.fn(); await running;
  assert.equal(w.data.opFila.length, 1); assert.equal(w.data.opFila[0]._erro, "timeout");
});
test("histórico tardio processando não volta ao servidor após estado final durável", async () => {
  const w = worker(); await w.ready();
  await w.receive(order({ numero_pedido: "NO-REGRESSION", estado: "confirmado" }));
  await w.receive(op({ numero_pedido: "NO-REGRESSION" })); await w.flush();
  const count = w.calls.filter(c => c.url.endsWith("/api/pedido")).length;
  await w.receive(order({ numero_pedido: "NO-REGRESSION", estado: "processando" })); await w.flush();
  assert.equal(w.calls.filter(c => c.url.endsWith("/api/pedido")).length, count);
});

test("recusa determinística sai da fila após 3 tentativas; transitória continua sendo retentada", async () => {
  // 409 (conflito) e 400 (inválido) sao decisao do servidor: reenviar nao muda o resultado.
  // Sem quarentena o mesmo evento voltava a cada 5 min para sempre e a fila nunca esvaziava.
  for (const status of [409, 400, 404]) {
    const w = worker({ fetch: async () => response({ status: "erro", codigo: "conflito" }, status) });
    await w.ready(); await w.receive(op());
    await w.flush(); assert.equal(w.data.opFila.length, 1, "1a tentativa mantem na fila");
    await w.tick(600000); await w.flush(); assert.equal(w.data.opFila.length, 1, "2a tentativa ainda mantem");
    await w.tick(600000); await w.flush();
    assert.equal(w.data.opFila.length, 0, "3a recusa definitiva tira da fila (" + status + ")");
    assert.equal(w.data.opCaptura.rejeitados.length, 1, "o evento e guardado, nao apagado");
    assert.equal(w.data.opCaptura.rejeitados[0].evento.numero_pedido, w.data.opCaptura.rejeitados[0].evento.numero_pedido);
    assert.match(w.data.opCaptura.rejeitados[0].motivo, /^http_/);
    assert.ok(w.data.opCaptura.diagnosticos.some(d => /rejeitado_definitivo/.test(d.motivo)));
  }
  // 429/408/500 e falha de rede continuam retentando indefinidamente
  for (const t of [429, 408, 500, 503]) {
    const w = worker({ fetch: async () => response({ status: "erro" }, t) });
    await w.ready(); await w.receive(op());
    for (let i = 0; i < 4; i++) { await w.flush(); await w.tick(600000); }
    assert.equal(w.data.opFila.length, 1, "transitorio " + t + " nao pode ser descartado");
    assert.equal((w.data.opCaptura.rejeitados || []).length, 0);
  }
});
test("evento rejeitado aparece no ping para o painel não achar que está tudo bem", async () => {
  const w = worker({ fetch: async (url) => url.endsWith("/api/ping")
    ? response({ status: "ok" })
    : response({ status: "erro", codigo: "conflito" }, 409) });
  await w.ready(); await w.receive(op());
  for (let i = 0; i < 3; i++) { await w.flush(); await w.tick(600000); }
  assert.equal(w.data.opFila.length, 0);
  await w.ping();
  const ping = w.calls.filter(c => c.url.endsWith("/api/ping")).pop();
  assert.equal(ping.body.fila, 0, "fila zerada: o evento nao esta mais preso");
  assert.equal(ping.body.estado, "eventos_rejeitados_1", "mas o painel fica sabendo");
});

test("extensao velha se declara velha: o recibo do ping traz a versao empacotada", async () => {
  // Antes, so o painel aberto comparava as versoes. Agora o servidor devolve 'esperada' e a
  // propria extensao passa a dizer que esta atrasada, mesmo com ninguem olhando o painel.
  const w = worker({ ping: { esperada: "9.99" }, fetch: async () => response({ status: "ok" }) });
  await w.ready();
  await w.ping();
  assert.equal(w.data.opCaptura.esperada, "9.99", "guardado em disco: o worker MV3 morre entre pings");
  await w.tick(60000);
  const ping = w.calls.filter(c => c.url.endsWith("/api/ping")).pop();
  assert.equal(ping.body.estado, "versao_antiga_9.99");
  // versao igual a do pacote nao vira alarme
  const atual = worker({ ping: { esperada: require("../extensao/manifest.json").version }, fetch: async () => response({ status: "ok" }) });
  await atual.ready(); await atual.ping(); await atual.tick(60000);
  assert.ok(!/versao_antiga/.test(atual.calls.filter(c => c.url.endsWith("/api/ping")).pop().body.estado));
});

test("varredura de saques deixa de ser cega: desfecho por aba aparece no ping", async () => {
  const w = worker({ fetch: async () => response({ status: "ok" }) });
  await w.ready();
  const diag = m => w.receive({ tipo: "diagnostico", motivo: m, contexto: { geracao: "g-1" } });
  await diag("varredura_navegou"); await diag("varredura_navegou"); await diag("varredura_sem_identidade");
  await w.ping();
  const ping = w.calls.filter(c => c.url.endsWith("/api/ping")).pop();
  assert.equal(ping.body.estado, "varredura_2_navegaram_1_sem_identidade");
  const v = w.data.opCaptura.varredura;
  assert.equal(v.navegou, 2); assert.equal(v.sem_identidade, 1);
  // diagnostico comum nao contamina a contagem da varredura
  await diag("aguardando_hook_da_pagina");
  assert.equal(w.data.opCaptura.varredura.navegou, 2);
  // passado o tempo, o resumo sai do ping e o estado volta ao normal
  await w.tick(200000);
  await w.ping();
  const depois = w.calls.filter(c => c.url.endsWith("/api/ping")).pop();
  assert.ok(!/varredura_/.test(depois.body.estado), 'resumo da varredura expira do ping');
});
test("versao do codigo da ABA entra no slot; ping denuncia aba com codigo antigo; nada disso vai ao servidor", async () => {
  // Recarregar a extensao troca o worker, nao o que ja esta injetado nas abas. O worker dizia
  // "1.45" enquanto a aba rodava o classify.js da 1.43 — invisivel, e custou uma rodada inteira.
  const w = worker(); await w.ready();
  await w.receive(op({ tipo: "ctx", conta: "A", captura_id: "doc:200", contexto: { geracao: "gen:1" } }), undefined, "0.0-velha");
  await w.tick(60000);
  const ping = w.calls.filter(c => c.url.endsWith("/api/ping")).at(-1).body;
  assert.equal(ping.slots[0].versao_pagina, "0.0-velha");
  assert.equal(ping.estado, "abas_com_codigo_antigo_1");
  for (const c of w.calls) { assert.equal(c.body && c.body._vp, undefined); assert.equal(c.body && c.body.vp, undefined); }
});
