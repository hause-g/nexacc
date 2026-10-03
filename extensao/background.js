/* NexAcc Demo: fila durável com ACK. Sem exportação de sessão ou relay autenticado. */
"use strict";
importScripts("origem_main.js");
importScripts("normalizar.js");
const SRV = "http://127.0.0.1:8765";
const DEMO_STORAGE = "nexaccDemoEventosV1";
const N = OrionNormalizar;
const ACK = new Set(["ok", "duplicado", "enriquecido", "promovido", "descartado"]);
const RECOVERY = "op-recuperacao", DELIVERY = "op-entrega";
const NOTIFIED_MAX = 500, NOTIFIED_TTL = 30 * 86400000;
let state = null, initializing = null, writer = Promise.resolve(), flushing = null, fastTimer = null;
let storageError = "", serverError = "", lastPing = 0;
function copy(v) { return JSON.parse(JSON.stringify(v)); }
function localGet() {
  return new Promise((resolve, reject) => chrome.storage.local.get([DEMO_STORAGE], r => {
    const err = chrome.runtime.lastError; err ? reject(new Error("storage_read")) : resolve(r && r[DEMO_STORAGE] || {});
  }));
}
function localSet(value) {
  return new Promise((resolve, reject) => chrome.storage.local.set({ [DEMO_STORAGE]: value }, () => {
    const err = chrome.runtime.lastError; err ? reject(new Error("storage_write")) : resolve();
  }));
}
function uuid() { return N.uuid(); }
// http_400/409 = o servidor decidiu; http_408/429 e 5xx = tentar de novo depois.
function definitivo(reason) {
  const m = /^http_(\d{3})$/.exec(String(reason || ""));
  if (!m) return false;
  const code = Number(m[1]);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}
function key(ev) { return JSON.stringify([ev.casa || "", ev.conta || "", ev.tipo_pedido || ev.tipo, ev.numero_pedido || ""]); }
function scope(ev) {
  const c = ev.contexto || {};
  return JSON.stringify([c.tab_id, c.frame_id, c.documento_id || "", c.geracao || ""]);
}
function diag(draft, reason) {
  draft.opCaptura.diagnosticos.push({ motivo: reason, observado_em: new Date().toISOString() });
  draft.opCaptura.diagnosticos = draft.opCaptura.diagnosticos.slice(-100);
}
async function initialize() {
  if (state) return;
  if (!initializing) initializing = (async () => {
    const saved = await localGet();
    const meta = Object.assign({ schema: 1, instalacao_id: uuid(), sequencia: 0, pedidos: {}, contextos: {}, context_heads: {},
      recebidos: [], entregues: {}, notificados: [], diagnosticos: [], rejeitados: [], ultimo_evento: null }, saved.opCaptura || {});
    const draft = { opFila: Array.isArray(saved.opFila) ? saved.opFila : [], opCaptura: meta };
    draft.opFila.forEach(ev => {
      if (!ev._queue_id) ev._queue_id = uuid();
      if (!Number.isSafeInteger(ev.revision)) ev.revision = ++meta.sequencia;
      if (!Number.isFinite(ev._next)) ev._next = Date.now();
      if (!ev._tries) ev._tries = 0;
      // Eventos antigos sem event_id usam ACK legado, sem forçar campo novo retroativamente.
    });
    prune(draft);
    await localSet(draft);
    state = draft;
    storageError = "";
  })().catch(error => { storageError = "persistencia_indisponivel"; throw error; }).finally(() => { initializing = null; });
  return initializing;
}
function mutate(fn) {
  const run = writer.then(async () => {
    await initialize();
    const draft = copy(state), result = fn(draft);
    await localSet(draft); // memória só avança depois da gravação concluída
    state = draft; storageError = "";
    return result;
  });
  writer = run.catch(() => { storageError = "persistencia_indisponivel"; });
  return run;
}
function prune(draft) {
  const m = draft.opCaptura, now = Date.now();
  m.notificados = m.notificados.filter(x => now - x.ts < NOTIFIED_TTL).slice(-NOTIFIED_MAX);
  m.recebidos = m.recebidos.slice(-2000);
  const delivered = Object.entries(m.entregues).sort((a, b) => a[1].ts - b[1].ts);
  delivered.slice(0, Math.max(0, delivered.length - 2000)).forEach(([k]) => { delete m.entregues[k]; });
  // Pendências/conflitos nunca expiram. Só compacta cache de terminais já entregues.
  const closed = Object.entries(m.pedidos).filter(([, p]) => p.encerrado).sort((a, b) => a[1].atualizado - b[1].atualizado);
  closed.slice(0, Math.max(0, closed.length - 2000)).forEach(([k]) => { delete m.pedidos[k]; });
}
function clean(input, sender) {
  const ev = {};
  ["tipo", "tipo_pedido", "numero_pedido", "valor", "casa", "conta", "origem", "data", "observado_em",
    "estado", "motivo", "status", "saldo", "bonus", "totalCharge", "totalWithdraw", "host", "casa_normalizada",
    "id_jogo", "slug", "nome", "seletor", "marca", "erro_login"].forEach(k => {
    if (input[k] != null && ["string", "number"].includes(typeof input[k])) ev[k] = input[k];
  });
  // corpo do launch: so escalar curto, e nada com cara de credencial. O servidor filtra de novo.
  if (input.campos && typeof input.campos === "object" && !Array.isArray(input.campos)) {
    const campos = {};
    // Lista POSITIVA, espelhando classify.js: bloquear por nome erra sempre (sk, sign, pwd, mima).
    const ACEITOS = ["gameid", "gamecode", "gamename", "gametype", "gamekind", "platform", "vendor", "provider", "slug"];
    for (const [k, v] of Object.entries(input.campos).slice(0, 40)) {
      if (!ACEITOS.includes(String(k).toLowerCase())) continue;
      if (typeof v === "number" || typeof v === "boolean") campos[k] = v;
      else if (typeof v === "string" && v.length <= 24) campos[k] = v;
    }
    if (Object.keys(campos).length) ev.campos = campos;
  }
  // nomes de chave apenas; nenhum valor atravessa
  // vetor de permissoes da conta: so numeros, tamanho limitado, sem interpretacao
  if (Array.isArray(input.permissoes)) {
    const v = input.permissoes.slice(0, 20).map(x => (typeof x === "number" ? x : Number(x)))
      .filter(x => Number.isFinite(x));
    if (v.length) ev.permissoes = v;
  }
  if (typeof input.auditoria === "number") ev.auditoria = input.auditoria;
  // sinais do login: so escalar, nome curto, nada com cara de credencial (o classify ja filtrou)
  if (input.sinais && typeof input.sinais === "object" && !Array.isArray(input.sinais)) {
    const sinais = {};
    for (const [k, v] of Object.entries(input.sinais).slice(0, 80)) {
      if (k.length > 40 || /token|session|jwt|senha|password|passwd|cpf|phone|mobile|email|key|auth/i.test(k)) continue;
      if (typeof v === "number" && Math.abs(v) < 1e12) sinais[k] = v;
    }
    if (Object.keys(sinais).length) ev.sinais = sinais;
  }
  if (Array.isArray(input.campos_vistos)) {
    const nomes = input.campos_vistos.filter(k => typeof k === "string" && k.length <= 40).slice(0, 40);
    if (nomes.length) ev.campos_vistos = nomes;
  }
  ev.conta = N.id(input.conta); ev.casa = N.id(input.casa);
  // Metadado de origem; nunca altera a chave financeira legada.
  let source='';try{source=new URL(sender.url||sender.tab&&sender.tab.url||'').hostname;}catch(_){}
  ev.host=AgentumOrigem.host(source||input.host);ev.casa_normalizada=ev.host;
  if (input.numero_pedido != null) ev.numero_pedido = N.id(input.numero_pedido);
  ev.contexto = { tab_id: sender && sender.tab ? sender.tab.id : null,
    frame_id: sender && sender.frameId != null ? sender.frameId : 0,
    documento_id: sender && sender.documentId || "",
    geracao: N.id(input.contexto && input.contexto.geracao) };
  return ev;
}
function track(draft, ev) {
  const k = key(ev), previous = draft.opCaptura.pedidos[k];
  if (previous && previous.final_observado) {
    if (!["confirmado", "falhou"].includes(ev.estado)) return false;
    const prior = previous.evento;
    if (prior.estado !== ev.estado || (prior.valor != null && ev.valor != null && prior.valor !== ev.valor)) {
      ev.estado = "verificar"; ev.motivo = "conflito_evidencias_finais";
    } else if (prior.estado === ev.estado && prior.valor === ev.valor && prior.data === ev.data) return false;
  } else if (previous && ["estado", "valor", "motivo", "data", "origem"].every(k => previous.evento[k] === ev[k])) return false;
  ev.revision = ++draft.opCaptura.sequencia;
  const delivered = draft.opCaptura.entregues[k];
  const settled = !!(delivered && delivered.valor === ev.valor) || !!(previous && previous.financeiro_entregue && previous.evento.valor === ev.valor);
  draft.opCaptura.pedidos[k] = { evento: copy(ev), final_observado: ev.estado === "confirmado" || ev.estado === "falhou" || !!(previous && previous.final_observado),
    encerrado: ev.estado === "confirmado" && settled, atualizado: Date.now(), proxima_verificacao: null, tentativas_consulta: 0,
    consulta_ativa: "indisponivel_sem_contrato", motivo_consulta: "conferir_nas_abas",
    financeiro_entregue: settled };
  return true;
}
async function receive(input, sender, vp) {
  const allowed = ["ctx", "diagnostico", "pedido", "deposito", "saque", "deposito_pendente", "conta", "jogo"];
  if (!allowed.includes(input.tipo)) return { status: "ignorado", motivo: "captura_desativada" };
  const captureId = N.id(input.captura_id) || uuid(), ev = clean(input, sender);
  // versao do codigo que roda NA ABA: fica no slot do ping, fora do payload (wire() nao a envia)
  ev._vp = typeof vp === "string" ? vp.slice(0, 12) : "";
  const result = await mutate(draft => {
    const meta = draft.opCaptura;
    if (meta.recebidos.includes(captureId) || draft.opFila.some(q => q._capture_id === captureId))
      return { status: "persistido", captura_id: captureId };
    ev.contexto.instalacao_id = meta.instalacao_id;
    // Identidade de jogo nasce DENTRO do iframe da PG Soft, que e outra origem e nao sabe de que
    // casa veio. Quem sabe e o worker: a aba ja anunciou o contexto do lobby no frame de topo.
    if (ev.tipo === "jogo" && !ev.casa) {
      const daAba = Object.values(meta.contextos)
        .filter(c => c && c.tab_id === ev.contexto.tab_id && c.casa)
        .sort((a, b) => (a.frame_id || 0) - (b.frame_id || 0))[0];
      if (!daAba) { diag(draft, "jogo_sem_casa_na_aba"); return { status: "ignorado", motivo: "casa_da_aba_desconhecida" }; }
      ev.casa = daAba.casa;
    }
    if (ev.tipo === "ctx") {
      const sk = scope(ev);
      const slotKey = JSON.stringify([ev.contexto.tab_id, ev.contexto.frame_id, ev.contexto.documento_id]);
      const sequence = Number(captureId.split(":").pop()) || 0;
      const head = meta.context_heads[slotKey];
      if (head && sequence && sequence <= head.sequence) return { status: "persistido", captura_id: captureId };
      meta.context_heads[slotKey] = { sequence, geracao: ev.contexto.geracao };
      // Só a geração atual aparece como contexto vivo; pedidos antigos guardam seu próprio contexto.
      Object.keys(meta.contextos).forEach(k => {
        const s = JSON.parse(k);
        if (s[0] === ev.contexto.tab_id && s[1] === ev.contexto.frame_id && k !== sk) delete meta.contextos[k];
      });
      if (ev.conta) {
        const prior = meta.contextos[sk];
        if (!prior || (typeof prior === "string" ? prior : prior.conta) === ev.conta) {
          meta.contextos[sk] = { tab_id: ev.contexto.tab_id, frame_id: ev.contexto.frame_id,
            casa: ev.casa, conta: ev.conta, geracao: ev.contexto.geracao,
            estado: "contexto_observado", ultimo_evento: new Date().toISOString() };
          if (ev._vp) meta.contextos[sk].versao_pagina = ev._vp;
          // Identidade tardia só vincula o mesmo documento/frame/geração.
          draft.opFila.filter(q => !q.conta && scope(q) === sk && q.casa === ev.casa).forEach(q => {
            q.conta = ev.conta; q._next = Math.min(q._next, Date.now());
            if (q.tipo === "pedido") {
              const old = key(Object.assign({}, q, { conta: "" }));
              delete meta.pedidos[old]; track(draft, q);
            }
          });
        } else diag(draft, "conflito_contexto_geracao");
      } else meta.contextos[sk] = { tab_id: ev.contexto.tab_id, frame_id: ev.contexto.frame_id,
        casa: ev.casa, conta: "", geracao: ev.contexto.geracao,
        estado: "identidade_ausente", ultimo_evento: new Date().toISOString() };
      if (ev._vp) meta.contextos[sk].versao_pagina = ev._vp;
      const scopes = Object.keys(meta.contextos);
      scopes.slice(0, Math.max(0, scopes.length - 256)).forEach(k => { delete meta.contextos[k]; });
      const heads = Object.keys(meta.context_heads);
      heads.slice(0, Math.max(0, heads.length - 256)).forEach(k => { delete meta.context_heads[k]; });
    } else if (ev.tipo === "diagnostico") {
      diag(draft, ev.motivo || "captura_incompleta");
      // "Varrer saques" era cego: o operador clicava e nao sabia quantas abas atenderam. As abas
      // relatam o desfecho e o worker resume no ping, que o painel ja mostra.
      if (/^varredura_/.test(ev.motivo || "")) {
        const v = draft.opCaptura.varredura = draft.opCaptura.varredura || {};
        if (Date.now() - (v.quando || 0) > 180000) { v.navegou = 0; v.sem_identidade = 0; v.adiada = 0; }
        v.quando = Date.now();
        if (ev.motivo === "varredura_navegou") v.navegou = (v.navegou || 0) + 1;
        else if (ev.motivo === "varredura_sem_identidade") v.sem_identidade = (v.sem_identidade || 0) + 1;
        else v.adiada = (v.adiada || 0) + 1;
      }
    } else {
      const slot = meta.contextos[scope(ev)];
      if (!ev.conta && slot) ev.conta = typeof slot === "string" ? slot : slot.conta;
      if (slot && typeof slot === "object" && slot.conta === ev.conta) slot.ultimo_evento = new Date().toISOString();
      if (ev.tipo === "deposito_pendente") {
        ev.tipo = "pedido"; ev.tipo_pedido = "deposito"; ev.estado = "processando";
        ev.motivo = "status_nao_final_confirmado"; ev.origem = "api";
        if (meta.pedidos[key(ev)]) return { status: "persistido", captura_id: captureId };
      }
      if (ev.tipo === "pedido") {
        ev.valor = N.dinheiro(ev.valor);
        if (!["saque", "deposito"].includes(ev.tipo_pedido) || !ev.numero_pedido ||
            !["identificado", "processando", "confirmado", "falhou", "verificar"].includes(ev.estado)) {
          diag(draft, "pedido_invalido"); return { status: "rejeitado", motivo: "pedido_invalido" };
        }
      }
      // A revisão não é reutilizada se um recibo antigo já saiu do cache limitado.
      ev.event_id = meta.instalacao_id + ":" + captureId + ":" + (meta.sequencia + 1);
      ev.observado_em = ev.observado_em || new Date().toISOString();
      let enqueue = true;
      if (ev.tipo === "pedido") enqueue = track(draft, ev);
      else ev.revision = ++meta.sequencia;
      if (enqueue) {
        ev._queue_id = ev.event_id; ev._capture_id = captureId; ev._next = Date.now(); ev._tries = 0;
        draft.opFila.push(ev);
      }
      meta.ultimo_evento = ev.observado_em;
    }
    meta.recebidos.push(captureId); prune(draft);
    return { status: "persistido", captura_id: captureId };
  });
  wakeSoon();
  return result;
}
function sendable(ev) {
  // identidade de jogo nao tem conta nem valor: e so id/slug/nome para montar o botao depois
  if (ev.tipo === "jogo") return !!ev.casa && !!ev.id_jogo;
  // conta que falhou o login nao traz status nem saldo: o codigo do erro E a informacao
  if (ev.tipo === "conta" && ev.erro_login !== undefined) return !!ev.casa && !!ev.conta;
  if (!["deposito", "saque", "deposito_pendente", "pedido", "conta"].includes(ev.tipo)) return false;
  if (!ev.casa || !ev.conta) return false;
  if (["deposito", "saque"].includes(ev.tipo)) return !!ev.numero_pedido && N.dinheiro(ev.valor) > 0;
  return ev.tipo === "conta" || !!ev.numero_pedido;
}
function wire(ev) {
  const body = {};
  ["tipo", "valor", "numero_pedido", "casa", "conta", "origem", "data", "observado_em", "contexto", "event_id",
    "revision", "estado", "motivo", "status", "saldo", "bonus", "totalCharge", "totalWithdraw", "host", "casa_normalizada",
    "id_jogo", "slug", "nome", "campos", "campos_vistos", "seletor", "marca", "auditoria", "erro_login"].forEach(k => {
    if (ev[k] !== undefined) body[k] = ev[k];
  });
  if (Array.isArray(ev.permissoes)) body.permissoes = ev.permissoes;
  if (ev.sinais) body.sinais = ev.sinais;
  let path = "/api/operation";
  if (ev.tipo === "pedido") { path = "/api/pedido"; body.tipo = ev.tipo_pedido; }
  else if (ev.tipo === "deposito_pendente") path = "/api/pendente"; // filas de versões anteriores
  else if (ev.tipo === "conta") path = "/api/conta";
  else if (ev.tipo === "jogo") path = "/api/jogo";
  return { path, body };
}
async function postJSON(path, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(SRV + path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw new Error("http_" + response.status);
    const result = await response.json();
    if (!result || typeof result !== "object" || !ACK.has(result.status) || result.error || result.erro || result.success === false)
      throw new Error("ack_invalido");
    // ID ausente é permitido somente no evento legado que não enviou ID.
    const receipt = result.ack && typeof result.ack === "object" ? result.ack : result;
    const ackId = typeof result.ack === "string" ? result.ack : receipt.event_id;
    if (body.event_id && ackId !== body.event_id) throw new Error("ack_event_id");
    if (body.event_id && result.event_id != null && result.event_id !== body.event_id) throw new Error("ack_event_id");
    if (receipt.revision != null && receipt.revision !== body.revision) throw new Error("ack_revision");
    if (result.revision != null && result.revision !== body.revision) throw new Error("ack_revision");
    return result;
  } finally { clearTimeout(timer); }
}
function wakeSoon() {
  schedule().catch(() => {});
  if (!fastTimer) fastTimer = setTimeout(() => { fastTimer = null; flush().catch(() => {}); }, 100);
}
async function ensureRecovery() {
  const current = await chrome.alarms.get(RECOVERY);
  if (!current) await chrome.alarms.create(RECOVERY, { periodInMinutes: 1 });
}
let scheduling = Promise.resolve();
function schedule() {
  const next = scheduling.then(async () => {
    await ensureRecovery();
    if (!state) return;
    const pending = state.opFila.filter(sendable);
    if (!pending.length) { await chrome.alarms.clear(DELIVERY); return; }
    const when = Math.min(...pending.map(ev => ev._next));
    const existing = await chrome.alarms.get(DELIVERY);
    // Nunca adia um alarme existente ao receber eventos ou reiniciar o worker.
    if (!existing || existing.scheduledTime > when) await chrome.alarms.create(DELIVERY, { when });
  });
  scheduling = next.catch(() => {});
  return next;
}
async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    await initialize(); await writer;
    let count = 0;
    while (count++ < 25) {
      const event = state.opFila.find(ev => sendable(ev) && ev._next <= Date.now());
      if (!event) break;
      const snapshot = copy(event), request = wire(snapshot);
      let ack, reason;
      try { ack = await postJSON(request.path, request.body); serverError = ""; }
      catch (error) { reason = error.message || "rede"; serverError = reason; }
      const notification = await mutate(draft => {
        const index = draft.opFila.findIndex(ev => ev._queue_id === snapshot._queue_id && ev.revision === snapshot.revision);
        if (index < 0) return null; // uma revisão nova nunca é removida por ACK antigo
        const current = draft.opFila[index];
        if (!ack) {
          current._tries++; current._next = Date.now() + Math.min(300000, 30000 * Math.pow(2, Math.min(current._tries - 1, 4)));
          current._erro = reason;
          // Recusa DETERMINISTICA do servidor (400 invalido / 409 conflito): reenviar nao muda o
          // resultado. Sem isto o mesmo evento voltava a cada 5 min para sempre e a fila nunca
          // esvaziava, escondendo pendencia real. 408/429 e 5xx continuam sendo retentados.
          if (definitivo(reason) && current._tries >= 3) {
            draft.opFila.splice(index, 1);
            draft.opCaptura.rejeitados = (draft.opCaptura.rejeitados || []).concat([
              { evento: snapshot, motivo: reason, quando: new Date().toISOString() }]).slice(-200);
            diag(draft, "rejeitado_definitivo_" + reason);
            // A recusa deixou de estar pendente: quem precisa aparecer no ping agora e a
            // quarentena, nao o http_409 da ultima tentativa.
            serverError = "";
          }
          return null;
        }
        draft.opFila.splice(index, 1);
        let notify = null;
        if (["deposito", "saque"].includes(snapshot.tipo)) {
          const k = key(snapshot), pending = draft.opCaptura.pedidos[k];
          if (ack.status !== "descartado") draft.opCaptura.entregues[k] = { valor: snapshot.valor, ts: Date.now() };
          // 'descartado' autoriza retirar transporte, mas não significa operação gravada.
          if (pending && ack.status !== "descartado") {
            pending.financeiro_entregue = true;
            pending.encerrado = pending.evento.estado === "confirmado" && pending.evento.valor === snapshot.valor;
          }
          if (ack.status === "ok" && !draft.opCaptura.notificados.some(n => n.key === k)) {
            draft.opCaptura.notificados.push({ key: k, ts: Date.now() }); notify = snapshot;
          }
        } else if (snapshot.tipo === "pedido") {
          const pending = draft.opCaptura.pedidos[key(snapshot)];
          if (pending && pending.evento.revision === snapshot.revision && snapshot.estado === "falhou" && ack.status !== "descartado")
            pending.encerrado = true;
        }
        prune(draft); return notify;
      });
      if (notification) notificar(notification);
    }
  })().finally(() => { flushing = null; schedule().catch(() => {}); });
  return flushing;
}
function notificar(ev) {
  try {
    chrome.notifications.create("op-" + ev._queue_id, { type: "basic", iconUrl: "icon.png",
      title: (ev.tipo === "deposito" ? "Depósito " : "Saque ") + ev.valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
      message: ev.casa + " · #" + ev.conta.slice(-4), priority: 1 });
  } catch (_) {}
}
// Abrir jogo pelo painel: quem abre e a ABA, na PROPRIA aba e no topo (como um clique real). O
// worker NAO abre mais nova guia. Reabrir aqui pela URL salva (chrome.tabs.create) criava uma
// SEGUNDA instancia do jogo — uma no iframe da aba e outra na guia nova, com a MESMA sessao — e as
// duas se desconectavam. Fica como no-op para o __opjogo_check sempre devolver o pedido e a aba
// lancar uma vez so. A URL salva (jogoUrl) continua guardada para diagnostico, mas nao abre nada.
async function abrirJogoPedido() {
  return false;
}
async function pingVersao() {
  try {
    await initialize(); if (Date.now() - lastPing < 30000) return; lastPing = Date.now();
    // 'esperada' e o pacote que o servidor tem em disco, devolvido no ping anterior. Fica no
    // armazenamento porque o worker MV3 morre entre um ping e outro; em memoria quase nunca
    // sobreviveria. Sem isso a extensao velha se declarava saudavel e so o painel denunciava.
    const m = state.opCaptura, version = chrome.runtime.getManifest().version, esperada = m.esperada;
    const rejeitados = (m.rejeitados || []).length;
    const v = m.varredura || {}, j = m.jogo || {};
    // desfecho do botao de jogo: sem isto, clicar e nao acontecer nada nao deixava rastro nenhum
    const jogo = Date.now() - (j.quando || 0) < 180000 ? "jogo_" + j.resultado : "";
    // abas cujo codigo injetado e mais velho que este worker: F5 nelas, nao recarregar de novo
    const antigas = Object.values(m.contextos).filter(s => s && typeof s === "object" && s.versao_pagina && s.versao_pagina !== version).length;
    const varrendo = Date.now() - (v.quando || 0) < 180000
      ? "varredura_" + (v.navegou || 0) + "_navegaram_" + (v.sem_identidade || 0) + "_sem_identidade" : "";
    const recibo = await postJSON("/api/ping", { version, versao: version, tipo: "player", instalacao_id: m.instalacao_id,
      fila: state.opFila.length, pendentes: Object.values(m.pedidos).filter(p => !p.encerrado).length,
      slots: Object.values(m.contextos).filter(slot => slot && typeof slot === "object"),
      // evento recusado em definitivo nao fica preso na fila, mas tem que aparecer no painel
      ultimo_evento: m.ultimo_evento, estado: storageError || serverError ||
        (jogo ? jogo :
         varrendo ? varrendo :
         rejeitados ? "eventos_rejeitados_" + rejeitados :
         state.opFila.some(ev => !sendable(ev)) ? "fila_precisa_verificar" :
         antigas ? "abas_com_codigo_antigo_" + antigas :
         esperada && esperada !== version ? "versao_antiga_" + esperada :
         !Object.keys(m.contextos).length ? "aguardando_comunicacao_das_abas" : "passiva_consulta_ativa_nao_validada") });
    if (recibo && typeof recibo.esperada === "string" && recibo.esperada !== esperada)
      await mutate(draft => { draft.opCaptura.esperada = recibo.esperada; });
  } catch (_) {}
}
// Rollover (TESTE, 1.71): amostra dos campos da RODADA. Fora da fila durável de propósito: giro não
// é dinheiro, é frequente, e perder uma amostra não custa nada. A casa/conta vêm da aba (o iframe do
// jogo é outra origem e não sabe). Sobem só números e nomes de chave; o servidor filtra de novo.
const giroVistos = new Set();   // a ponte reenvia até ter recibo: sem isto cada reenvio virava amostra nova
async function giroAmostra(input, sender) {
  const capturaId = String(input.captura_id || "");
  if (capturaId && giroVistos.has(capturaId)) return { status: "persistido", captura_id: capturaId };
  if (capturaId) { giroVistos.add(capturaId); if (giroVistos.size > 500) giroVistos.delete(giroVistos.values().next().value); }
  const tab = sender && sender.tab && sender.tab.id;
  await initialize();   // só LEITURA do contexto da aba — nada é gravado no armazenamento
  const slot = Object.values((state && state.opCaptura && state.opCaptura.contextos) || {})
    .filter(c => c && c.tab_id === tab && c.casa)
    .sort((a, b) => (a.frame_id || 0) - (b.frame_id || 0))[0] || null;
  const c = input.campos && typeof input.campos === "object" ? input.campos : {};
  const numeros = {};
  if (c.numeros && typeof c.numeros === "object")
    for (const [k, v] of Object.entries(c.numeros).slice(0, 40))
      if (typeof v === "number" && Number.isFinite(v) && k.length <= 24) numeros[k] = v;
  const lista = a => (Array.isArray(a) ? a.filter(x => typeof x === "string" && x.length <= 24).slice(0, 60) : []);
  const body = { casa: slot ? slot.casa : "", conta: slot ? slot.conta : "", slug: String(input.slug || "").slice(0, 40),
    formato: String(c.formato || "").slice(0, 12), caminho: String(c.caminho || "").slice(0, 8),
    tamanho: Number(c.tamanho) || 0, chaves_topo: lista(c.chaves_topo), chaves: lista(c.chaves), numeros,
    via: String(c.via || "").slice(0, 8), tipo_resposta: String(c.tipo_resposta || "").slice(0, 16),
    content_type: String(c.content_type || "").slice(0, 40), bytes: Number(c.bytes) || 0,
    inicio_hex: /^[0-9a-f]{0,16}$/.test(String(c.inicio_hex || "")) ? String(c.inicio_hex || "") : "",
    doc: String(c.doc || "").slice(0, 8), n: Number(c.n) || 0, numero_grande: c.numero_grande ? 1 : 0,
    versao: String(chrome.runtime.getManifest().version || "") };
  postJSON("/api/giro_amostra", body).catch(() => {});
  return { status: "persistido", captura_id: capturaId };
}
function demoSender(sender) {
  try {
    return !!sender.tab && new URL(sender.url).origin === "http://filhateste.invalid"
      && new URL(sender.tab.url).origin === "http://filhateste.invalid";
  } catch (_) { return false; }
}
// Listeners registrados imediatamente; inclusive durante leitura de armazenamento lenta.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!demoSender(sender)) {
    respond({ status: "erro", motivo: "origem_fora_da_demonstracao" });
    return false;
  }
  if (msg && ["__opsessao", "__opsess_check", "__oplaunch", "__opjogo_url", "__opjogo_molde", "__opjogo_check"].some(k => msg[k])) {
    respond({ status: "erro", motivo: "recurso_indisponivel_na_demonstracao", ts: 0 });
    return false;
  }
  if (msg && msg.__opev === 1 && msg.evt && msg.evt.tipo === "giro_amostra") {
    giroAmostra(msg.evt, sender).then(respond, () => respond({ status: "persistido", captura_id: String(msg.evt.captura_id || "") }));
    return true;
  }
  if (msg && msg.__opev === 1 && msg.evt) {
    receive(msg.evt, sender, msg.vp).then(respond, () => respond({ status: "erro", motivo: "persistencia_indisponivel" }));
    return true;
  }
  if (msg && msg.__opping) { pingVersao(); flush().catch(() => {}); return; }
  if (msg && msg.__opjogo_pronto) {
    // A aba abriu o jogo sozinha, na PROPRIA aba e no topo (como um clique real). O worker NAO abre
    // mais nada — so registra o desfecho para o painel. Abrir aqui (nova guia) duplicava a sessao e
    // as duas instancias se desconectavam. modo: topo | topo_url | iframe.
    const res = msg.ok ? ("aberto_" + (msg.modo || (msg.launcher ? "launcher" : "url")))
                       : ("launch_" + (msg.erro || (msg.launcher ? "iframe" : "falhou")));
    mutate(draft => { draft.opCaptura.jogo = {quando: Date.now(), resultado: res}; }).catch(() => {});
    return;
  }
  if (msg && msg.__opjogo_falhou) {
    const porque = msg.motivo === "sem_molde_aprendido" ? "sem_molde" : "nao_achei_na_tela";
    mutate(draft => { draft.opCaptura.jogo = {quando: Date.now(), resultado: porque}; }).catch(() => {});
    return;
  }
  if (msg && msg.__opjogo_tentando) {
    // Beacon: a aba VAI lancar agora. Se o desfecho ficar preso em "tentando_lancar", o launch da
    // aba nao voltou (problema no hook); se virar launch_*/aberto, voltou. Desambigua num disparo so.
    mutate(draft => { draft.opCaptura.jogo = {quando: Date.now(), resultado: "tentando_lancar"}; }).catch(() => {});
    return;
  }
  if (msg && msg.__opdominios) {
    // #3-B: alias informativo (casa bonita -> dominios). Fire-and-forget: nao entra na fila de
    // capturas nem tem ack; se falhar, a proxima pagina reenvia. Nao re-chaveia nada.
    try {
      fetch(SRV + "/api/dominios_casa", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ casa: String(msg.casa || ""), dominios: Array.isArray(msg.dominios) ? msg.dominios : [] }) }).catch(() => {});
    } catch (_) {}
    return false;
  }
  if (msg && msg.__opvarrer_check) {
    fetch(SRV + "/api/varrer_saque").then(r => { if (!r.ok) throw new Error("http"); return r.json(); })
      .then(j => respond(j && Number.isFinite(j.ts) ? j : { ts: 0 }), () => respond({ ts: 0 }));
    return true;
  }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if ([RECOVERY, DELIVERY].includes(alarm.name)) { flush().catch(() => {}); pingVersao(); }
});
if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(tabId => {
  mutate(draft => {
    Object.keys(draft.opCaptura.contextos).forEach(k => { if (JSON.parse(k)[0] === tabId) delete draft.opCaptura.contextos[k]; });
    Object.keys(draft.opCaptura.context_heads).forEach(k => { if (JSON.parse(k)[0] === tabId) delete draft.opCaptura.context_heads[k]; });
  }).catch(() => {});
});
ensureRecovery().catch(() => {});
initialize().then(() => { wakeSoon(); pingVersao(); }, () => {});
