/* ISOLATED: transporte com recibo durável; tela de depósito exige identidade real.
   A conferência manual mantém a rota estabelecida. Não há restauração de sessão. */
(function () {
  "use strict";
  // Guarda de instancia: evita ponte duplicada quando o worker re-injeta os scripts
  // nas abas abertas (recarga da extensao). Contexto antigo morto nao bloqueia o novo.
  if (window.__opBridgeAtivo) return;
  window.__opBridgeAtivo = true;
  var N = globalThis.OrionNormalizar, HOST = location.hostname || "";
  var current = { conta: "", casa: N.casa(HOST), geracao: "" }, pending = new Map(), seen = new Map();
  var inflight = new Set(), prefix = N.uuid(), counter = 0, latestContext = 0, noMainReported = false;
  // Versao do codigo que roda NESTA aba. Recarregar a extensao troca o worker, nao o que ja esta
  // injetado nas abas abertas: o worker dizia "1.45" enquanto a aba rodava a 1.43. Vai no
  // envelope da mensagem, nunca dentro do evento — o servidor nao ve.
  var VERSAO = ""; try { VERSAO = String(chrome.runtime.getManifest().version || ""); } catch (_) {}
  try { chrome.runtime.sendMessage({ __opping: 1 }); } catch (_) {}
  function dispatch(ev) {
    if (inflight.has(ev.captura_id)) return;
    inflight.add(ev.captura_id);
    try {
      chrome.runtime.sendMessage({ __opev: 1, evt: ev, vp: VERSAO }, function (ack) {
        inflight.delete(ev.captura_id);
        if (chrome.runtime.lastError || !ack || ack.status !== "persistido" || ack.captura_id !== ev.captura_id) return;
        pending.delete(ev.captura_id);
        window.postMessage({ __opcap_ack: ev.captura_id }, "*");
      });
    } catch (_) { inflight.delete(ev.captura_id); }
  }
  function fwd(input) {
    var ev = Object.assign({}, input, { host: HOST });
    ev.captura_id = ev.captura_id || prefix + ":" + (++counter);
    pending.set(ev.captura_id, ev); dispatch(ev);
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.__opcap !== 1 || !event.data.evt) return;
    var ev = event.data.evt;
    if (!ev.contexto || !ev.contexto.geracao) return;
    if (ev.tipo === "ctx") {
      var seq = Number(String(ev.captura_id || "").split(":").pop());
      if (seq > latestContext) {
        latestContext = seq;
        if (current.geracao !== ev.contexto.geracao || current.conta !== (ev.conta || "")) seen.clear();
        current = { conta: ev.conta || "", casa: ev.casa || N.casa(HOST), geracao: ev.contexto.geracao };
      }
    }
    // Eventos antigos já carregam sua própria identidade: nunca usar a conta mais recente.
    fwd(ev);
  });
  window.postMessage({ __opcap_ready: 1 }, "*");
  function scan() {
    try {
      if (!current.conta || !current.geracao) return;
      var text = document.body && document.body.innerText || "";
      if (/saque\s*(?:bem\s*sucedid|sucesso|conclu|realizad|aprovad)|retirada/i.test(text)) return;
      var index = text.search(/dep[oó]sito\s*(?:sucesso|conclu[ií]d|realizad|efetuad)/i);
      if (index < 0) return;
      var section = text.slice(index, index + 1500);
      var amount = section.match(/R\$\s*(-?\d[\d.,]*)/) || section.match(/(-?\d[\d.,]*)\s*BRL/i);
      var value = amount ? N.dinheiro(amount[1]) : null;
      var order = section.match(/(?:N[uú]mero\s+do\s+Pedido|Order\s+No|Pedido)[:.\s]*([A-Za-z0-9][A-Za-z0-9_-]{3,})/i);
      // Todo numero de pedido real contem digito. Sem esta checagem a tela capturava o rotulo do
      // botao ("Continuar") como pedido; como nao batia com o ID da API, o servidor nao deduplicava
      // e o MESMO deposito entrava duas vezes (uma TELA + uma API).
      if (order && !/[0-9]/.test(order[1])) order = null;
      if (!(value > 0) || !order) return; // sem ID real não funde operações por conta+valor
      var key = JSON.stringify([current.geracao, current.casa, current.conta, order[1], value]);
      if (seen.has(key)) return;
      seen.set(key, Date.now());
      if (seen.size > 500) seen.delete(seen.keys().next().value);
      fwd({ tipo: "deposito", valor: value, numero_pedido: order[1], casa: current.casa,
        conta: current.conta, origem: "tela", contexto: { geracao: current.geracao } });
    } catch (_) {}
  }
  var timer;
  var observer = new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(scan, 500); });
  try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
  setInterval(function () {
    pending.forEach(dispatch);
    if (!latestContext) {
      window.postMessage({ __opcap_ready: 1 }, "*");
      if (!noMainReported) {
        noMainReported = true;
        fwd({ tipo: "ctx", conta: "", casa: current.casa, contexto: { geracao: prefix + ":ponte" } });
        fwd({ tipo: "diagnostico", motivo: "aguardando_hook_da_pagina", contexto: { geracao: prefix + ":ponte" } });
      }
    }
    scan();
  }, 3000);
  // Relay do botao de jogo, em TODO frame. O frame do jogo e o unico que tem a URL com a sessao
  // (m.<cdn>/<id>/index.html?ot=...); o frame de topo e quem faz o launch e tem o molde. Este
  // listener morava dentro do bloco abaixo, que retorna em qualquer iframe — o worker nunca
  // recebia a URL e o botao respondia sem_url_da_sessao em toda versao. Nada daqui entra na
  // fila de eventos, entao nada disto vai ao servidor.
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data) return;
    try {
      if (e.data.__opcapurl === 1)
        chrome.runtime.sendMessage({ __opjogo_url: 1, url: String(e.data.url || "") }, function () { void chrome.runtime.lastError; });
      else if (e.data.__opcapmolde === 1)
        chrome.runtime.sendMessage({ __opjogo_molde: 1, corpo: e.data.corpo }, function () { void chrome.runtime.lastError; });
      else if (e.data.__oplancado === 1)
        chrome.runtime.sendMessage({ __opjogo_pronto: 1, url: String(e.data.url || ""), erro: e.data.erro || "", launcher: e.data.launcher ? 1 : 0, ok: e.data.ok ? 1 : 0, modo: String(e.data.modo || "") }, function () { void chrome.runtime.lastError; });
      else if (e.data.__opsavelobby === 1)
        chrome.storage.local.set({ op_jogo_lobby: { url: String(e.data.url || ""), quando: Date.now() } }, function () { void chrome.runtime.lastError; });
      else if (e.data.__opdominios === 1)
        chrome.runtime.sendMessage({ __opdominios: 1, casa: String(e.data.casa || ""), dominios: Array.isArray(e.data.dominios) ? e.data.dominios : [] }, function () { void chrome.runtime.lastError; });
      else if (e.data.__oplaunchreq === 1) {
        // ponte pagina->worker: o POST do launch precisa do worker (CORS). Devolve a resposta
        // crua para a pagina, que decifra. Token so trafega para a mesma extensao, nunca ao servidor.
        var _id = e.data.id;
        chrome.runtime.sendMessage({ __oplaunch: 1, url: String(e.data.url || ""), headers: e.data.headers, body: e.data.body }, function (resp) {
          void chrome.runtime.lastError; window.postMessage({ __oplaunchresp: 1, id: _id, resp: resp || { erro: "sem_worker" } }, "*");
        });
      }
    } catch (_) {}
  });
  // Conferência manual existente: somente comando recente do painel, uma navegação por aba.
  (function () {
    if (window.top !== window || /localhost|127\.0\.0\.1|::1|pgpay|pgapp/.test(HOST)) return;
    // "Varrer saques" era cego: o operador clicava e nao sabia quantas abas atenderam. Cada saida
    // agora deixa um diagnostico, e a aba so consome o comando (__op_varr_done) DEPOIS de passar
    // por todas as checagens — antes, uma aba em throttle queimava a varredura sem navegar.
    // Avisa UMA vez por comando de varredura: o check roda a cada 8 s e repetir encheria o
    // diagnostico com a mesma linha.
    function avisar(ts, motivo) {
      try {
        if (sessionStorage.getItem("__op_varr_aviso") === ts + "|" + motivo) return;
        sessionStorage.setItem("__op_varr_aviso", ts + "|" + motivo);
        fwd({ tipo: "diagnostico", motivo: motivo, casa: current.casa, conta: current.conta });
      } catch (_) {}
    }
    function check() {
      try {
        chrome.runtime.sendMessage({ __opvarrer_check: 1 }, function (response) {
          if (chrome.runtime.lastError) return;
          var ts = response && response.ts;
          if (!Number.isFinite(ts) || ts <= 0) return;
          var done = Number(sessionStorage.getItem("__op_varr_done") || 0);
          if (ts <= done) return;                                  // ja atendida por esta aba
          if (Date.now() - ts < 0 || Date.now() - ts >= 120000) return;   // comando antigo
          // Escopo por casa: o painel manda as casas da operacao ao vivo ATIVA. Se a MINHA casa nao
          // esta na lista, ignoro — era este o bug (a varredura mexia em abas de OUTRA operacao).
          // Lista vazia = todas (comportamento antigo). current.casa vazio (aba ainda sem identidade)
          // NAO e excluida, igual "abrir jogo": nao se exclui quem ainda nao se sabe qual casa e.
          var escopo = (response && Array.isArray(response.casas)) ? response.casas : [];
          if (escopo.length && current.casa && escopo.indexOf(current.casa) < 0) return avisar(ts, "varredura_fora_do_escopo");
          // Sem identidade NAO consome a varredura: ela pode chegar segundos depois (o contexto vem
          // do hook, nao do storage) e a aba ainda precisa varrer. So avisa.
          if (!current.conta || !localStorage.getItem("web__lobby__persisted__token")) return avisar(ts, "varredura_sem_identidade");
          var last = Number(sessionStorage.getItem("__op_varr_nav") || 0);
          if (Date.now() - last < 60000) return avisar(ts, "varredura_adiada_por_intervalo");
          sessionStorage.setItem("__op_varr_done", String(ts));
          sessionStorage.setItem("__op_varr_nav", String(Date.now()));
          avisar(ts, "varredura_navegou");
          var target = new URL(location.href);
          target.pathname = "/home/withdraw"; target.searchParams.set("active", "3");
          location.href = target.toString();
        });
      } catch (_) {}
    }
    setInterval(check, 8000);
    check();
    // Abrir jogo pelo painel: REPETE o clique que o operador deu uma vez, com o alvo aprendido
    // naquele momento. Se o alvo nao estiver na tela, avisa e nao clica em nada — clicar no
    // elemento errado aqui abre o jogo errado, com dinheiro do operador.
    function alvoDoJogo(pedido) {
      var el = null;
      try { if (pedido.seletor) el = document.querySelector(pedido.seletor); } catch (_) {}
      if (el) return el;
      if (!pedido.marca) return null;
      var imgs = document.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) {
        var src = String(imgs[i].src || "").split("?")[0];
        if (src && src.indexOf(pedido.marca) >= 0) return imgs[i];
      }
      return null;
    }
    function abrirJogo() {
      try {
        chrome.runtime.sendMessage({ __opjogo_check: 1 }, function (pedido) {
          if (chrome.runtime.lastError || !pedido || !Number.isFinite(pedido.ts) || pedido.ts <= 0) return;
          var feito = Number(sessionStorage.getItem("__op_jogo_done") || 0);
          if (pedido.ts <= feito) return;                                  // ja atendido por esta aba
          if (Date.now() - pedido.ts < 0 || Date.now() - pedido.ts >= 120000) return;   // comando antigo
          // o operador escolhe as casas; lista vazia = todas as abas logadas
          var casas = Array.isArray(pedido.casas) ? pedido.casas : (pedido.casa ? [pedido.casa] : []);
          if (casas.length && current.casa && casas.indexOf(current.casa) < 0) return;   // outra casa
          if (!current.conta) return;                                      // aba sem sessao nao abre nada
          sessionStorage.setItem("__op_jogo_done", String(pedido.ts));
          // TODA aba logada monta o launch com a PROPRIA sessao. O corpo e deterministico
          // (constantes + gameid + time); o molde capturado, quando existe, so refina. Nao depende
          // mais de abrir o jogo antes nem de URL salva — que era por que so funcionava na aba onde
          // o operador tinha aberto o jogo. Se o launch falhar, o worker registra no ping; clicar na
          // tela ficou como reserva manual, nunca automatica (clicar no alvo errado abre jogo errado).
          var molde = pedido.molde && typeof pedido.molde === "object" ? pedido.molde : {};
          try { chrome.runtime.sendMessage({ __opjogo_tentando: 1 }, function () { void chrome.runtime.lastError; }); } catch (_) {}
          window.postMessage({ __oplancar: 1, molde: molde, id_jogo: String(pedido.id_jogo || "") }, "*");
          return;
        });
      } catch (_) {}
    }
    setInterval(abrirJogo, 4000);
  })();

  // ---- Botao "Voltar a casa" na tela do jogo -------------------------------------------------
  // Aberto top-level, a aba do lobby vira o jogo (origem do CDN). O botao "home" do PROPRIO jogo,
  // standalone, costuma cair na raiz do CDN (404) e prender. Este botao injetado SEMPRE volta pro
  // lobby exato salvo no launch (chrome.storage). So aparece em pagina cross-host de um launch
  // recente (a tela do jogo / o 404 do CDN), nunca no proprio lobby.
  function decideVoltar(lob, host, agora) {
    if (!lob || !lob.url) return "";
    if (agora - (lob.quando || 0) > 3 * 3600000) return "";     // launch velho (>3h): nao mostra
    var lh = ""; try { lh = new URL(lob.url).host; } catch (_) { return ""; }
    if (!lh || host === lh) return "";                          // no proprio lobby/casa: nao mostra
    return lob.url;
  }
  (function () {
    if (window.top !== window) return;                          // so no topo, nunca em iframe
    function injeta(url) {
      if (document.getElementById("op-voltar-casa")) return;
      var b = document.createElement("button");
      b.id = "op-voltar-casa"; b.type = "button"; b.textContent = "⟵ Voltar à casa";
      b.style.cssText = "position:fixed;left:10px;top:10px;z-index:2147483647;padding:8px 12px;border:0;border-radius:9px;background:rgba(0,0,0,.72);color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.5)";
      b.addEventListener("click", function () { try { location.assign(url); } catch (_) { try { location.href = url; } catch (__) {} } });
      (document.body || document.documentElement).appendChild(b);
    }
    var timer = null;
    function checa() {
      try {
        chrome.storage.local.get("op_jogo_lobby", function (r) {
          void chrome.runtime.lastError;
          var url = decideVoltar(r && r.op_jogo_lobby, location.host, Date.now());
          if (!url) return;
          injeta(url);
          // algumas engines reescrevem o body: reinjeta enquanto a condicao valer, senao para.
          if (!timer) timer = setInterval(function () {
            chrome.storage.local.get("op_jogo_lobby", function (r2) {
              void chrome.runtime.lastError;
              var u2 = decideVoltar(r2 && r2.op_jogo_lobby, location.host, Date.now());
              if (u2) injeta(u2); else { clearInterval(timer); timer = null; }
            });
          }, 4000);
        });
      } catch (_) {}
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", checa);
    else checa();
    setTimeout(checa, 1500);
  })();
})();
