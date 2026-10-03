"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const root = path.join(__dirname, "..", "extensao");
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function worker(options = {}) {
  const shared = options.shared || { data: clone(options.data || {}), alarms: new Map(), now: 1789050000000 };
  const namespace = "nexaccDemoEventosV1";
  shared.rawData ||= options.rawData || { [namespace]: shared.data };
  const calls = [], writes = [], notifications = [], created = [], messages = [], removed = [], alarmListeners = [];
  const timers = new Map();
  let timer = 0, alive = true, readHeld = null, setErrors = 0, getErrors = options.getErrors || 0;
  let handler = options.fetch || (async (url, body) => response({ status: "ok", event_id: body.event_id, revision: body.revision }));
  const runtime = {
    lastError: null, getManifest: () => JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")),
    onMessage: { addListener: fn => messages.push(fn) }
  };
  function callback(cb, error, result) {
    queueMicrotask(() => {
      if (!alive) return;
      runtime.lastError = error ? { message: "mock failure" } : null;
      cb(result); runtime.lastError = null;
    });
  }
  const chrome = {
    runtime,
    storage: { local: {
      get: (keys, cb) => {
        const perform = () => callback(cb, getErrors-- > 0, clone(Object.fromEntries(keys.filter(k => k in shared.rawData).map(k => [k, shared.rawData[k]]))));
        if (options.holdGet) { options.holdGet = false; readHeld = perform; } else perform();
      },
      set: (value, cb) => {
        const error = setErrors-- > 0;
        if (alive && !error) { Object.assign(shared.rawData, clone(value)); shared.data = shared.rawData[namespace] || {}; writes.push(clone(value)); }
        callback(cb, error);
      }
    } },
    alarms: {
      get: async name => clone(shared.alarms.get(name)),
      clear: async name => shared.alarms.delete(name),
      create: async (name, info) => {
        created.push({ name, info: clone(info) });
        shared.alarms.set(name, { name, scheduledTime: info.when ?? shared.now + info.periodInMinutes * 60000, periodInMinutes: info.periodInMinutes });
      },
      onAlarm: { addListener: fn => alarmListeners.push(fn) }
    },
    tabs: { onRemoved: { addListener: fn => removed.push(fn) } },
    notifications: { create: (id, data) => { notifications.push({ id, data: clone(data) }); } }
  };
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [shared.now])); } static now() { return shared.now; } }
  // API de navegador simulada: não compartilha handles nativos de AbortSignal entre VMs.
  class MockAbortController {
    constructor() { this.listeners = []; this.signal = { aborted: false, addEventListener: (name, fn) => { if (name === "abort") this.listeners.push(fn); } }; }
    abort() { this.signal.aborted = true; this.listeners.forEach(fn => fn()); }
  }
  const sandbox = {
    chrome, URL, Date: FakeDate, crypto: { randomUUID: () => crypto.randomUUID() }, AbortController: MockAbortController, console,
    setTimeout: (fn, ms) => { const id = ++timer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, opts) => {
      if (!/^http:\/\/127\.0\.0\.1:8765\/api\/(operation|pedido|pendente|conta|ping|varrer_saque|abrir_jogo)$/.test(url))
        throw new Error("REDE PROIBIDA: " + url);
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      calls.push({ url, body: clone(body) });
      // Ping não interfere nos cenários de entrega; options.ping acrescenta campos do recibo.
      if (url.endsWith("/api/ping")) return response(Object.assign({ status: "ok" }, options.ping || {}));
      // Abrir jogo: o worker consulta em todo alarme. Sem carimbo não há comando, que é o padrão;
      // options.abrirJogo injeta um pedido quando o cenário precisar dele.
      if (url.endsWith("/api/abrir_jogo")) return response(Object.assign({ ts: 0 }, options.abrirJogo || {}));
      return handler(url, body, opts);
    }
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = name => vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name });
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  return {
    shared, calls, writes, notifications, created, timers,
    get data() { return shared.data; },
    get rawData() { return shared.rawData; },
    async send(msg, sender) {
      let response;
      for (const fn of messages) fn(msg, sender, r => { response = r; });
      await settle();
      return response;
    },
    setFetch(fn) { handler = fn; },
    failSet(n = 1) { setErrors = n; },
    releaseGet() { readHeld(); },
    async ready() { await vm.runInContext("initialize()", context); await settle(); },
    async flush() { await vm.runInContext("flush()", context); await settle(); },
    async alarm(name = "op-recuperacao") { alarmListeners.forEach(fn => fn({ name })); await settle(); },
    async tick(ms) { shared.now += ms; await this.alarm(); },
    async schedule() { await vm.runInContext("schedule()", context); },
    async ping() { await vm.runInContext("lastPing=0;pingVersao()", context); await settle(); },
    async removeTab(id) { removed.forEach(fn => fn(id)); await settle(); },
    receive(ev, sender = { tab: { id: 11 }, frameId: 0, documentId: "doc-1" }, vp) {
      return new Promise(resolve => {
        const fixtureSender = { ...sender, url: sender.url || "http://filhateste.invalid/home", tab: { ...sender.tab, url: sender.tab && sender.tab.url || "http://filhateste.invalid/home" } };
        for (const fn of messages) if (fn({ __opev: 1, evt: clone(ev), vp }, fixtureSender, resolve) === true) break;
      });
    },
    kill() { alive = false; timers.clear(); }
  };
}
function encrypt(text, token = "mock-token", user = "acct-A") {
  const key = crypto.createHash("md5").update(token + user).digest("hex").slice(0, 16);
  const data = Buffer.from(text), padded = Buffer.alloc(Math.ceil(data.length / 16) * 16); data.copy(padded);
  const aes = crypto.createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from("exemploiv1234567"));
  aes.setAutoPadding(false);
  return Buffer.concat([aes.update(padded), aes.final()]).toString("base64");
}
function browser(options = {}) {
  const events = {}, sent = [], posts = [], intervals = [], timeouts = [], clones = [], reads = [];
  const store = new Map(Object.entries(options.local || {})), session = new Map();
  let handler = options.fetch || (async () => ({ ok: true, clone: () => ({ text: async () => "{}" }) }));
  let ackHandler = options.ack || ((msg, cb) => cb && cb({ status: "persistido", captura_id: msg.evt && msg.evt.captura_id }));
  class MockTextDecoder { decode(bytes) { return Buffer.from(bytes).toString("utf8"); } }
  const context = vm.createContext({ console, URL, TextDecoder: MockTextDecoder, Uint8Array, atob, crypto: { randomUUID: () => crypto.randomUUID() }, Date });
  const sandbox = context;
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox;
  if (options.frame) sandbox.top = {};   // iframe: window.top !== window
  sandbox.location = { hostname: "demo12.com", href: "https://demo12.com/home", origin: "https://demo12.com", pathname: "/home", hash: "" };
  if (options.location) Object.assign(sandbox.location, options.location);
  sandbox.document = { body: { innerText: "" }, documentElement: {} };
  sandbox.localStorage = { getItem: key => { reads.push(key); return store.get(key) || null; } };
  sandbox.sessionStorage = { getItem: key => session.get(key) || null, setItem: (k, v) => session.set(k, v) };
  sandbox.addEventListener = (name, fn) => (events[name] ||= []).push(fn);
  sandbox.postMessage = data => {
    posts.push(clone(data));
    queueMicrotask(() => { for (const fn of events.message || []) fn({ source: vm.runInContext("window", context), data: clone(data) }); });
  };
  sandbox.chrome = { runtime: {
    lastError: null, getManifest: () => ({ version: "9.9" }), sendMessage: (msg, cb) => { sent.push(clone(msg)); ackHandler(msg, cb); }
  } };
  sandbox.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  sandbox.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };
  sandbox.clearTimeout = () => {};
  sandbox.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() {} };
  sandbox.fetch = (...args) => handler(...args);
  sandbox.XMLHttpRequest = class {
    constructor() { this.events = {}; this.responseType = ""; this.status = 200; }
    open(method, url) { this.url = url; }
    send() {}
    addEventListener(name, cb) { (this.events[name] ||= []).push(cb); }
    load(text) { this.responseText = text; (this.events.load || []).splice(0).forEach(fn => fn()); }
  };
  function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
  load("normalizar.js"); load("cryptolib.js"); load("classify.js");
  if (options.hook !== false) load("hook.js");
  if (options.bridge !== false) load("bridge.js");
  return {
    context, sent, posts, intervals, timeouts, store, reads, session, clones,
    get location() { return sandbox.location; },
    setFetch(fn) { handler = fn; }, setAck(fn) { ackHandler = fn; },
    async fetch(url, text, opts) {
      handler = async () => ({ ok: true, clone: () => { clones.push(url); return { text: async () => text }; } });
      await sandbox.fetch(url, opts); await settle();
    },
    async runInterval(ms) { intervals.filter(x => x.ms === ms).forEach(x => x.fn()); await settle(); },
    async dom(text) { sandbox.document.body.innerText = text; await this.runInterval(3000); },
    async message(ev) { sandbox.postMessage({ __opcap: 1, evt: ev }); await settle(); },
    async storage(user) {
      if (user) store.set("web__lobby__persisted__user", JSON.stringify({ userInfos: { username: user } }));
      else store.delete("web__lobby__persisted__user");
      (events.storage || []).forEach(fn => fn({ key: "web__lobby__persisted__user" })); await settle();
    },
    load, settle
  };
}
module.exports = { worker, browser, encrypt, response, settle, clone };
