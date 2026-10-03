"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { worker, settle, clone } = require("./captura_helpers.cjs");
const root = path.resolve(__dirname, "..");
const fixture = { url: "http://filhateste.invalid/home", tab: { id: 11, url: "http://filhateste.invalid/home" }, frameId: 0, documentId: "demo-doc" };

test("mensagens antigas de sessão/URL/relay são recusadas sem rede ou persistência", async () => {
  const w = worker(); await w.ready(); await settle();
  const before = JSON.stringify({ calls: w.calls, data: w.rawData });
  for (const kind of ["__opsessao", "__opsess_check", "__oplaunch", "__opjogo_url", "__opjogo_molde", "__opjogo_check"]) {
    const result = await w.send({ [kind]: 1, dados: { session_key: "fixture-secret", jwt_token: "fixture-jwt" },
      url: "https://outside.example/?token=fixture-secret", body: "fixture-secret", corpo: { token: "fixture-secret" } }, fixture);
    assert.equal(result.motivo, "recurso_indisponivel_na_demonstracao");
  }
  assert.equal(JSON.stringify({ calls: w.calls, data: w.rawData }), before);
});

test("eventos sem origem de fixture comprovada não entram na fila", async () => {
  const w = worker(); await w.ready();
  const before = JSON.stringify({ calls: w.calls, data: w.rawData });
  for (const sender of [{}, { ...fixture, url: undefined }, { ...fixture, tab: { id: 11 } },
    { ...fixture, url: "https://outside.example/home" },
    { ...fixture, url: "http://filhateste.invalid.evil.example/home" },
    { ...fixture, tab: { id: 11, url: "http://outside.example/home" } }]) {
    const response = await w.send({ __opev: 1, evt: { tipo: "conta", conta: "demo", casa: "demo" } }, sender);
    assert.equal(response.motivo, "origem_fora_da_demonstracao");
  }
  assert.equal(JSON.stringify({ calls: w.calls, data: w.rawData }), before);
});

test("iniciar a demo não importa nem apaga filas e URLs legadas", async () => {
  const old = { opFila: [{ tipo: "conta", conta: "legacy-fixture", casa: "old-fixture", token: "fixture-secret" }],
    opCaptura: { jogoUrl: { antiga: { url: "https://outside.example/?token=fixture-secret" } } } };
  const w = worker({ rawData: clone(old) }); await w.ready(); await w.flush();
  assert.deepEqual(w.rawData.opFila, old.opFila);
  assert.deepEqual(w.rawData.opCaptura, old.opCaptura);
  assert.deepEqual(w.data.opFila, []);
  assert.equal(JSON.stringify(w.calls).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(w.data).includes("fixture-secret"), false);
});

test("manifests não concedem captura em sites reais nem reinjeção", () => {
  for (const [folder, host] of [["extensao", "filhateste"], ["extensao_agente", "maeteste"]]) {
    const m = JSON.parse(fs.readFileSync(path.join(root, folder, "manifest.json")));
    assert.deepEqual(m.host_permissions, ["http://127.0.0.1:8765/*"]);
    assert.equal(m.permissions.includes("scripting"), false);
    for (const script of m.content_scripts) {
      assert.deepEqual(script.matches, [`http://${host}.invalid/*`]);
      assert.equal(script.js.includes("sessao_export.js"), false);
      for (const file of script.js) assert.ok(fs.existsSync(path.join(root, folder, file)));
    }
  }
  assert.equal(fs.existsSync(path.join(root, "extensao/sessao_export.js")), false);
});

test("worker de relatórios ignora armazenamento antigo e remetentes externos", async () => {
  const store = { agFila: [{ id: "legacy", event: { tipo: "agente_total", token: "fixture-secret" } }], agInstallation: "old-fixture" };
  const old = clone(store), calls = [], handlers = {};
  const core = require("../extensao_agente/core_agente.js");
  const chrome = {
    runtime: { getManifest: () => ({ version: "demo-test" }), onMessage: { addListener: fn => handlers.message = fn } },
    storage: { local: {
      get: (keys, cb) => queueMicrotask(() => cb(Object.fromEntries(keys.filter(k => k in store).map(k => [k, clone(store[k])])))),
      set: (data, cb) => { Object.assign(store, clone(data)); queueMicrotask(cb); }
    } },
    alarms: { get: (key, cb) => cb({ name: key }), create() {}, onAlarm: { addListener() {} } },
    tabs: { query: (query, cb) => cb([]), sendMessage() {} }
  };
  const sandbox = { chrome, URL, console, AbortController, setTimeout, clearTimeout, AgentumMotherCore: core, importScripts() {},
    fetch: async (url, options) => {
      assert.ok(url.startsWith("http://127.0.0.1:8765/api/"));
      calls.push({ url, body: options.body });
      return { ok: true, json: async () => url.endsWith("/api/periodo") ? { periodo: "mes" } : { status: "ok", casas: [] } };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "extensao_agente/background_agente.js"), "utf8"), sandbox);
  await settle();
  assert.deepEqual(store.agFila, old.agFila);
  assert.deepEqual(store.nexaccDemoAgV1_agFila, []);
  const before = JSON.stringify({ store, calls });
  let response;
  handlers.message({ __opagev: 1, evt: { tipo: "agente_total", token: "fixture-secret" } },
    { url: "https://outside.example/", tab: { id: 1, url: "https://outside.example/" } }, r => response = r);
  await settle();
  assert.equal(response.motivo, "origem_fora_da_demonstracao");
  assert.equal(JSON.stringify({ store, calls }), before);
  assert.equal(JSON.stringify(calls).includes("fixture-secret"), false);
});
