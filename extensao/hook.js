/* MAIN: observa apenas rotas conhecidas. Credenciais para decifração ficam em memória
   da geração atual; nenhum corpo de requisição, sessão ampla ou jogo é coletado. */
(function () {
  "use strict";
  if (window.__opHook) return;
  window.__opHook = true;
  var N = window.OrionNormalizar, classifier = window.OrionClassify, HOST = location.hostname || "";
  var C = window.OrionCrypto;   // cifrar o launch usa a mesma chave que o classify usa para decifrar
  var documentId = N.uuid(), generation = 1, sequence = 0;
  // #3-B: a casa e chaveada pelo DOMINIO BONITO (ex.: p2-exemplopg), lido do lobby, para que deposito
  // e saque da MESMA casa aberta por dominio pelado/cloudfront parem de rachar em chaves diferentes.
  // So sobrescreve quando ha EXATAMENTE 1 chave <rede>-<plataforma>pg no lobby_pwa_domain (inequivoco);
  // 0 ou 2+ -> cai no host cru, nunca adivinha. GUARDA ANTI-TROCA: so confia no lobby quando ele INCLUI
  // o host atual — num cloudfront/ELB compartilhado o localStorage pode ter o lobby de OUTRA casa, e
  // sem isso a captura iria para a casa errada (dinheiro no balde errado). Cache pelo VALOR do lobby
  // (invalida sozinho se o lobby mudar). try/catch cobre atob/JSON. No iframe do jogo (CDN) o host nao
  // esta no lobby -> "" -> nada muda.
  var _domRaw = null, _domKey = "";   // cache: (valor cru do lobby) -> chave resolvida
  function lobbyLista(raw) {
    try {
      if (!raw) return [];
      var env = N.parseJSON(raw); if (!env || !env.data) return [];
      var lista = N.parseJSON(atob(env.data));
      return Array.isArray(lista) ? lista : [];
    } catch (_) { return []; }
  }
  function lobbyDominios() { try { return lobbyLista(localStorage.getItem("lobby_pwa_domain")); } catch (_) { return []; } }
  function dominioOficial() {
    var raw = "";
    try { raw = localStorage.getItem("lobby_pwa_domain") || ""; } catch (_) { return ""; }
    if (raw === _domRaw) return _domKey;                 // mesmo lobby -> usa o cache
    _domRaw = raw; _domKey = "";
    try {
      var doms = lobbyLista(raw);
      if (!doms.length) return _domKey;
      var host = "";
      try { host = String(location.hostname || "").toLowerCase(); } catch (_) { host = ""; }
      var contemHost = !!host && doms.some(function (u) { try { return new URL(u).hostname.toLowerCase() === host; } catch (_) { return false; } });
      if (!contemHost) return _domKey;                   // lobby nao reconhece este host -> nao confia
      var chaves = {};
      doms.forEach(function (u) {
        var m = /^https?:\/\/(?:www\.)?([a-z0-9]{1,12}-[a-z]+pg)\./i.exec(String(u || ""));
        if (m) chaves[m[1].toLowerCase()] = 1;
      });
      var ks = Object.keys(chaves);
      if (ks.length === 1) _domKey = ks[0];              // so quando inequivoco
    } catch (_) {}
    return _domKey;
  }
  function casaAtual() { return dominioOficial() || N.casa(HOST); }
  // Alias informativo: manda ao servidor TODOS os dominios da casa (bonito + cloudfront + ELB), uma
  // vez por pagina, para a reconciliacao e a caixa "Casas sem nome" resolverem hash->nome. Nao
  // re-chaveia nada (a chave ja vem resolvida acima).
  var _dominiosAnunciados = false;
  function anunciarDominios() {
    if (_dominiosAnunciados) return;
    var of = dominioOficial(); if (!of) return;
    var doms = [];
    lobbyDominios().forEach(function (u) {
      try { var h = new URL(u).hostname.toLowerCase(); if (h && doms.indexOf(h) < 0) doms.push(h); } catch (_) {}
    });
    if (!doms.length) return;
    _dominiosAnunciados = true;
    try { window.postMessage({ __opdominios: 1, casa: of, dominios: doms.slice(0, 40) }, "*"); } catch (_) {}
  }
  var CT = { conta: "", users: [], tokens: [] }, retries = [], outbox = new Map();
  // Host da API. O front (lobby, ex.: www.p4-barrilpg.com) NAO serve /hall/api — a API vive num
  // subdominio aleatorio (ex.: vbxb.frotapg.com). Postar o launch na origem do lobby volta 405.
  // O lobby chama /hall/api o tempo todo para o host certo; aprendemos a origem daqui e lancamos nela.
  var API_BASE = "", API_BASE_GC = "";   // GC = host que serve /gameCenter/ (o do launch), o mais fiel
  function lembrarApiBase(u) {
    try {
      var s = String(u || ""); if (s.indexOf("/hall/api/") < 0) return;
      var abs = new URL(s, location.href);
      if (!/^https?:$/.test(abs.protocol)) return;
      // O launch e /hall/api/gameCenter/...: o host que serve isso e exatamente o que precisamos.
      // Qualquer /hall/api serve de reserva, mas pode ser o host de pagamento/financeiro (errado).
      if (s.indexOf("/gameCenter/") >= 0) API_BASE_GC = abs.origin;
      if (abs.origin !== location.origin) API_BASE = abs.origin;
      // browserfingerid tambem viaja como ?fp=GEE... em varias URLs; captura como reserva do header.
      var fp = abs.searchParams.get("fp"); if (fp && !API_HEADERS["browserfingerid"]) API_HEADERS["browserfingerid"] = fp;
    } catch (_) {}
  }
  var lastLocal = "", MAX_RETRIES = 64, RETRY_TTL = 600000;
  function context() { return { geracao: documentId + ":" + generation }; }
  // A casa manda o material de decifragem no HEADER (token / x-object-id), nao na query.
  // Sem isso a chave md5(token+username) nao existe e nenhuma resposta cifrada decifra.
  var SEEN_TOKENS = [], SEEN_USERS = [], SEEN_XOID = "";   // x-object-id cru: 2o header de auth do launch
  // O launch autentica com um CONJUNTO de headers (token, newjwt, sitecode, x-device, device,
  // browserfingerid, platformtype, currency...). Sem eles a casa recusa com "obtain server". O
  // OPTIONS (preflight) da casa lista exatamente quais aceita — capturamos esse conjunto de
  // QUALQUER chamada /hall/api que o lobby faz e replicamos no relaunch. Sao a sessao do proprio
  // operador para a propria casa; nunca vao ao nosso servidor.
  var API_HEADERS = {};
  var HDR_LAUNCH = ["appsystem","appversion","browserfingerid","browsertype","clienttimezone","currency",
    "device","devicebrand","devicemodel","domain","language","newjwt","operatingsystem","physicaldevicemodel",
    "platformtype","sitecode","token","webauthndomain","x-custom-referer","x-device","x-object-id","x-version"];
  function coletarHeaders(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v); });
      else if (Array.isArray(h)) h.forEach(function (p) { if (p && p.length > 1) out[String(p[0]).toLowerCase()] = String(p[1]); });
      else if (typeof h === "object") Object.keys(h).forEach(function (k) { out[String(k).toLowerCase()] = String(h[k]); });
    } catch (_) {}
    return out;
  }
  function guardarHeaders(url, h) {
    try {
      if (String(url || "").indexOf("/hall/api/") < 0) return;
      var got = coletarHeaders(h);
      Object.keys(got).forEach(function (k) { if (got[k]) API_HEADERS[k] = got[k]; });
    } catch (_) {}
  }
  function montarHeadersLaunch(ts) {
    var out = { "content-type": "application/json", "x-data-mode": "plain" };
    HDR_LAUNCH.forEach(function (k) { if (API_HEADERS[k]) out[k] = API_HEADERS[k]; });
    if (!out.token) out.token = CT.tokens[0] || SEEN_TOKENS[0] || "";
    if (!out["x-object-id"] && SEEN_XOID) out["x-object-id"] = SEEN_XOID;
    // timestamp DEVE bater com o time do corpo (no cURL real sao iguais): a casa valida.
    out.timestamp = String(ts || Math.floor(Date.now() / 1000));
    out["x-request-id"] = N.uuid();
    return out;
  }
  function addToken(t) { t = String(t == null ? "" : t).trim(); if (t && SEEN_TOKENS.indexOf(t) < 0) { SEEN_TOKENS.unshift(t); SEEN_TOKENS = SEEN_TOKENS.slice(0, 6); } }
  function addUser(u) {
    u = N.id(u);
    if (!u || SEEN_USERS.indexOf(u) >= 0) return;
    SEEN_USERS.unshift(u); SEEN_USERS = SEEN_USERS.slice(0, 6);
    // O uid do x-object-id identifica a conta tao bem quanto o localStorage, e chega em toda
    // requisicao. Medido em 12/09: 71 de 96 abas vivas estavam SEM conta — nao entram no "Varrer
    // saques", nao leem a tela de sucesso e o painel nao sabe de quem sao. Adotar o uid destrava
    // essas abas SEM inventar identidade: so quando o storage nao tem usuario e ha um unico uid
    // visto nesta geracao. Dois uids distintos = ambiguidade, e ai nao se escolhe nenhum.
    if (!CT.conta && !localUser() && SEEN_USERS.length === 1) change(u, CT.tokens[0] || "", false);
  }
  function eatHeader(k, v) {
    if (/^(token|tk)$/i.test(k)) addToken(v);
    else if (/^x-object-id$/i.test(k)) { if (v) SEEN_XOID = String(v); try { var o = JSON.parse(String(v)); addUser(o.uid || o.userId || o.user_id || o.username); } catch (_) {} }
  }
  function eatHeaders(h) {
    try {
      if (!h) return;
      if (typeof Headers !== "undefined" && h instanceof Headers) { h.forEach(function (v, k) { eatHeader(k, v); }); return; }
      if (Array.isArray(h)) { h.forEach(function (p) { if (p && p.length > 1) eatHeader(p[0], p[1]); }); return; }
      if (typeof h === "object") Object.keys(h).forEach(function (k) { eatHeader(k, h[k]); });
    } catch (_) {}
  }
  function merge(base, extra) { var out = base.slice(); extra.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); return out.slice(0, 6); }
  function snapshot() { return { conta: CT.conta, users: merge(CT.users, SEEN_USERS), tokens: merge(CT.tokens, SEEN_TOKENS), contexto: context() }; }
  function post(ev, snap) {
    // casa_por_aba: evento nascido DENTRO do iframe do jogo, cujo host e o CDN da PG Soft. Deixar
    // o fallback de HOST carimbar aqui gravaria "m" como se fosse a casa.
    if (!ev.casa_por_aba) ev.casa = ev.casa || casaAtual();
    ev.contexto = (snap && snap.contexto) || context();
    ev.captura_id = documentId + ":" + (++sequence);
    if (!ev.conta && snap) ev.conta = snap.conta;
    outbox.set(ev.captura_id, ev);
    window.postMessage({ __opcap: 1, evt: ev }, "*");
  }
  function announce() { post({ tipo: "ctx", casa: casaAtual(), conta: CT.conta }, snapshot()); }
  // O corpo da requisicao NAO e lido em geral — o do saque pode carregar senha. A unica excecao e
  // o launch de jogo, cujo corpo cifrado so tem o id do jogo e e o que permite montar o botao.
  // Ancorado no CAMINHO, nunca na URL crua: sem isso um saque com
  // ?redirect=/hall/api/gameCenter/gameApi/login casaria por substring na query e o corpo do
  // SAQUE — que pode ter senha — seria lido.
  var LANCAMENTO = /\/gameCenter\/gameApi\/login$/i;
  function ehLancamento(url) { return LANCAMENTO.test(String(url || "").split(/[?#]/)[0].replace(/\/+$/, "")); }
  function corpoDoPedido(url, body) {
    if (!ehLancamento(url)) return "";
    return typeof body === "string" && body.length <= 65536 ? body : "";
  }
  // Dentro do iframe do jogo (outra origem, mesmo content script): a rodada diz o slug e o caminho
  // do frame diz o id. A casa vem do referrer, que e o lobby que abriu. Nada de token sobe.
  // O botao do painel vai REPETIR o seu clique, nao inventar uma chamada de API: por isso aqui
  // guardamos como era o alvo clicado no instante em que o lobby pediu o launch. Sem isso, abrir
  // pelo painel viraria chute — e chute aqui abre o jogo errado, com dinheiro do operador.
  var ultimoClique = null;
  try {
    document.addEventListener("pointerdown", function (e) {
      try { ultimoClique = { alvo: e.target, quando: Date.now() }; } catch (_) {}
    }, true);
  } catch (_) {}
  function caminhoDe(el) {
    var partes = [], n = el;
    while (n && n.nodeType === 1 && partes.length < 8 && n !== document.body) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { partes.unshift("#" + n.id); break; }
      var passo = n.tagName.toLowerCase(), pai = n.parentElement;
      if (pai) {
        var iguais = [].slice.call(pai.children).filter(function (x) { return x.tagName === n.tagName; });
        if (iguais.length > 1) passo += ":nth-of-type(" + (iguais.indexOf(n) + 1) + ")";
      }
      partes.unshift(passo); n = pai;
    }
    return partes.join(" > ").slice(0, 300);
  }
  function descritorDoClique() {
    var c = ultimoClique;
    if (!c || Date.now() - c.quando > 10000 || !c.alvo || c.alvo.nodeType !== 1) return null;
    var cartao = c.alvo;
    for (var i = 0; i < 6 && cartao.parentElement; i++) {
      if (cartao.querySelector && cartao.querySelector("img")) break;
      cartao = cartao.parentElement;
    }
    var marca = "";
    try {
      var img = cartao.querySelector && cartao.querySelector("img");
      if (img && img.src) marca = String(img.src).split("?")[0].split("/").pop().slice(0, 60);
      if (!marca) marca = String(cartao.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40);
    } catch (_) {}
    return { seletor: caminhoDe(c.alvo), marca: marca };
  }
  // Refazer o launch: trocar gameid e time no molde, cifrar com a chave viva desta aba e pedir.
  // A resposta traz a URL do launcher; onde exatamente varia por fornecedor (ver urlDaResposta).
  function urlDoLauncher(texto) {
    // A resposta e um HTML/JSON com VARIAS urls: pegar a primeira abria o xmlns do <svg>
    // (www.w3.org/2000/svg) numa aba — nao o jogo. Filtra namespaces/esquema e prefere a URL do
    // jogo (tem /index.html ou um parametro de sessao ot/ops/__hv/token). 1200 p/ nao truncar.
    var todas = String(texto || "").match(/https?:\/\/[^"'\s<>\\]{10,1200}/g) || [];
    var boas = todas.filter(function (u) { return !/(?:^|\.)w3\.org|schema\.|xmlns|\.dtd$|purl\.org|\/ns\//i.test(u); });
    // SO url com cara de jogo (/index.html ou parametro de sessao). Nunca cair em "qualquer url":
    // devolver um logo/asset abriria lixo numa aba. Sem url de jogo -> vazio, e o desfecho reporta.
    var jogo = boas.filter(function (u) { return /\/index\.html|[?&](?:ot|ops|__hv|__sv|token)=/i.test(u); });
    return (jogo[0] || "").replace(/&amp;/g, "&");
  }
  function ehUrl(v) { return typeof v === "string" && /^https?:\/\//.test(v.trim()) ? v.trim() : ""; }
  // A URL do launcher aparece em campos DIFERENTES conforme o fornecedor do jogo. Nas capturas
  // reais: game_url (string) estava em 100% dos casos; url[0].url (array) em 14 de 15; socket_url
  // em 1. O hook lia SO url[0].url — e era null justo no caso que faltava. Procura em todos.
  function ehUrlJogo(u) { return typeof u === "string" && /^https?:\/\//i.test(u) && /\/index\.html|[?&](?:ot|ops|__hv|__sv|token)=/i.test(u) ? u.trim() : ""; }
  function varrerUrl(v, prof) {
    prof = prof || 0; if (prof > 5 || v == null) return "";
    if (typeof v === "string") return ehUrlJogo(v);
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var r = varrerUrl(v[i], prof + 1); if (r) return r; } return ""; }
    if (typeof v === "object") { var ks = Object.keys(v); for (var j = 0; j < ks.length; j++) { var r2 = varrerUrl(v[ks[j]], prof + 1); if (r2) return r2; } return ""; }
    return "";
  }
  function urlDaResposta(dados, bruto) {
    if (dados) {
      if (Array.isArray(dados.url) && dados.url[0]) { var a = ehUrl(dados.url[0].url) || ehUrl(dados.url[0]); if (a) return a; }
      if (Array.isArray(dados.socket_url) && dados.socket_url[0]) { var b = ehUrl(dados.socket_url[0].url) || ehUrl(dados.socket_url[0]); if (b) return b; }
      var g = ehUrl(dados.game_url); if (g) return g;
      var u = ehUrl(dados.url); if (u) return u;
      // A resposta plana (x-data-mode: plain) traz a url em ALGUMA chave de data, e o JSON escapa as
      // barras (https:\/\/...): a regex do bruto nao casava. Varre o OBJETO ja parseado (barras reais).
      var achado = varrerUrl(dados); if (achado) return achado;
    }
    // ultimo recurso: bruto com as barras desescapadas
    return urlDoLauncher(String(bruto || "").replace(/\\\//g, "/"));
  }
  // O POST do launch vai para o HOST DA API (subdominio aleatorio), cross-origin em relacao ao
  // lobby: da pagina, o navegador bloqueia por CORS (TypeError). O service worker, com
  // host_permissions, ignora CORS. A pagina (MAIN) nao fala com o worker direto — passa pela
  // ponte (bridge, ISOLATED). Aqui so o corpo JA CIFRADO trafega; decifrar segue na pagina.
  var _lfSeq = 0, _lfPend = {};
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.__oplaunchresp !== 1) return;
    var p = _lfPend[e.data.id]; if (!p) return;
    delete _lfPend[e.data.id]; clearTimeout(p.t); p.res(e.data.resp || {});
  });
  function fetchViaWorker(url, headers, body) {
    return new Promise(function (res) {
      var id = "lf" + (++_lfSeq);
      _lfPend[id] = { res: res, t: setTimeout(function () { if (_lfPend[id]) { delete _lfPend[id]; res({ erro: "timeout" }); } }, 15000) };
      try { window.postMessage({ __oplaunchreq: 1, id: id, url: url, headers: headers, body: body }, "*"); }
      catch (_) { delete _lfPend[id]; res({ erro: "sem_ponte" }); }
    });
  }
  // A resposta moderna do launch e um HTML launcher da PG (nao uma URL): ele decodifica um blob com
  // varios CDNs, faz health-check (o .gif, CORS *), escolhe um e computa __hv/__sv/ao/or antes de
  // redirecionar. Nao ha URL pronta para extrair — tem que RODAR. Renderiza num iframe na propria
  // aba (origem da casa, onde o script dele roda e o health-check passa), como o lobby faz.
  function ehLauncherHtml(s) {
    return typeof s === "string" && /<(?:!doctype|html|script)/i.test(s) && (s.indexOf("game-launcher") >= 0 || s.indexOf("location.replace") >= 0);
  }
  function acharLauncher(dados) {
    if (!dados) return "";
    var c = (Array.isArray(dados.url) && dados.url[0] && dados.url[0].url) || dados.game_url || (typeof dados.url === "string" ? dados.url : "");
    return ehLauncherHtml(c) ? c : "";
  }
  function abrirLauncher(html) {
    try {
      var velho = document.getElementById("op-jogo-frame"); if (velho) velho.remove();
      var wrap = document.createElement("div");
      wrap.id = "op-jogo-frame";
      wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000";
      var fr = document.createElement("iframe");
      fr.setAttribute("allow", "autoplay; fullscreen; clipboard-write");
      fr.style.cssText = "border:0;width:100%;height:100%;display:block";
      fr.srcdoc = html;
      var x = document.createElement("button");
      x.textContent = "✕";
      x.title = "Fechar jogo";
      x.style.cssText = "position:fixed;top:10px;right:14px;z-index:2147483647;width:42px;height:42px;border-radius:50%;border:0;background:rgba(0,0,0,.65);color:#fff;font-size:20px;cursor:pointer";
      x.onclick = function () { try { wrap.remove(); } catch (_) {} };
      wrap.appendChild(fr); wrap.appendChild(x);
      (document.body || document.documentElement).appendChild(wrap);
      return true;
    } catch (_) { return false; }
  }
  // Abre na PROPRIA aba, no topo (window.top): o jogo fica top-level, como o lobby faz num clique de
  // verdade. Sem iframe (o jogo nao ve "estou emoldurado", que e sinal classico de antibot) e sem
  // nova guia. Agenda a navegacao um tiquinho depois para o desfecho ("aberto") chegar ao worker
  // antes de a pagina descarregar. Rede de seguranca: se em 2,5s a aba NAO tiver navegado (raro: uma
  // CSP barrando o blob), cai no overlay em iframe, que e comprovado — falha silenciosa nunca deixa
  // a aba em branco. Se a navegacao deu certo, a pagina descarregou e este timer nem chega a rodar.
  function abrirNoTopo(u, htmlReserva) {
    // Guarda o LOBBY (a pagina atual, onde o operador esta agora) antes de a aba virar o jogo. A
    // ponte salva em chrome.storage; na tela do jogo, um botao "Voltar a casa" injetado usa isto pra
    // voltar pro lobby exato — sem depender do botao interno do jogo (que cai na raiz do CDN -> 404).
    try { window.postMessage({ __opsavelobby: 1, url: location.href }, "*"); } catch (_) {}
    setTimeout(function () {
      try { (window.top || window).location.assign(u); }
      catch (_) { try { location.assign(u); } catch (__) { try { location.href = u; } catch (___) {} } }
    }, 80);
    if (htmlReserva) setTimeout(function () {
      try { if (!document.getElementById("op-jogo-frame")) abrirLauncher(htmlReserva); } catch (_) {}
    }, 2500);
  }
  // Decide COMO abrir na aba e devolve {ok, modo, topo, url?}. Launcher HTML -> blob top-level
  // (natural); se o blob falhar -> overlay em iframe; formato antigo (URL pronta) -> navega direto no
  // topo. O worker nao abre mais nada: uma instancia so, que e o que parou de duplicar e desconectar.
  function abrirLauncherOuUrl(html, urlAntiga) {
    if (html) {
      var burl = "";
      try { burl = URL.createObjectURL(new Blob([html], { type: "text/html" })); } catch (_) { burl = ""; }
      if (burl) { abrirNoTopo(burl, html); return { ok: 1, modo: "topo", topo: 1 }; }
      return { ok: abrirLauncher(html) ? 1 : 0, modo: "iframe", topo: 0 };
    }
    if (urlAntiga) { abrirNoTopo(urlAntiga, ""); return { ok: 1, modo: "topo_url", topo: 1, url: urlAntiga }; }
    return { ok: 0, modo: "", topo: 0 };
  }
  async function lancarJogo(molde, idJogo) {
    var resposta = { __oplancado: 1, url: "", erro: "" };
    try {
      var token = CT.tokens[0] || SEEN_TOKENS[0], user = CT.conta || SEEN_USERS[0];
      if (!token || !user) { resposta.erro = "sem_sessao"; return window.postMessage(resposta, "*"); }
      // Corpo do launch DETERMINISTICO. As capturas reais (3/3, casas distintas) mostram sempre
      // {os_type:2, platfromid:200, cid:"999998", exitUrl:""} — so gameid e time variam. cid 999998
      // e o regPkgId das contas. Assim QUALQUER aba logada monta o pedido com a propria sessao, sem
      // ter aberto o jogo antes nem depender de molde capturado. O molde, quando existe, so refina.
      var corpo = Object.assign({ os_type: 2, platfromid: 200, cid: "999998" },
                                molde && typeof molde === "object" ? molde : {});
      corpo.gameid = Number(idJogo) || idJogo;
      corpo.time = Math.floor(Date.now() / 1000);
      // exitUrl = o LOBBY da casa (a url bonita onde o operador esta agora). Nos captures a casa
      // manda vazio porque o jogo abre EMBUTIDO no lobby e o botao "home" e tratado pela SPA dela.
      // Nos abrimos TOP-LEVEL, entao o jogo fica na origem do CDN; com exitUrl vazio o "home"/inicio
      // do jogo cai na RAIZ do CDN -> 404 preso (m.<cdn>.com/), sem como sair. Apontando pro lobby,
      // o "home" volta pra casa logada. Ignora exitUrl de molde (pode ser de outra casa): o destino
      // certo e SEMPRE a aba atual.
      try { corpo.exitUrl = location.origin + location.pathname + location.search; }
      catch (_) { try { corpo.exitUrl = location.origin || ""; } catch (__) { corpo.exitUrl = ""; } }
      var base = API_BASE_GC || API_BASE || location.origin;   // host do /gameCenter/ e o mais fiel
      var host = ""; try { host = new URL(base).host; } catch (_) {}
      var url_alvo = base + "/hall/api/gameCenter/gameApi/login";
      // code 0 E code 1 sao SUCESSO nesta API (provado nas capturas: 2717 respostas code=0 msg
      // "success"). O que separa sucesso de erro nao e o code, e ter URL. Quando a casa devolve
      // "Failed to obtain server / muito frequente" (varias abas no mesmo instante), e TRANSITORIO:
      // espera e tenta de novo, ate 3 vezes, re-cifrando o horario a cada tentativa.
      for (var tent = 0; tent < 3; tent++) {
        if (tent) await new Promise(function (r) { setTimeout(r, 1200 + tent * 900); });
        corpo.time = Math.floor(Date.now() / 1000);
        // Corpo TEXTO PURO: o cURL real e as capturas mandam JSON literal com x-data-mode: plain.
        // Ciframos antes (cifrarHall) e a casa respondia errorCode 41020 "Falha na Operacao" —
        // ela lia como plano e recebia base64. Agora vai plano, casando com o header.
        var hdrs = montarHeadersLaunch(corpo.time);
        var resp = await fetchViaWorker(url_alvo, hdrs, JSON.stringify(corpo));
        if (resp.erro) { resposta.erro = resp.erro + "@" + host; continue; }   // rede/worker: tenta de novo
        var bruto = resp.texto || "";
        var obj = N.parseJSON(bruto) || N.parseJSON(C.decifrarHall(bruto, token, user));
        var dados = obj && (obj.data || obj);
        // Caminho moderno: a resposta traz o HTML launcher (ele escolhe o CDN e redireciona). Abre
        // na PROPRIA aba, no topo, como um clique real do lobby. No modo "topo" a pagina vai
        // descarregar, entao posta o desfecho ANTES e retorna; no fallback iframe, segue pro post final.
        var html = acharLauncher(dados) || (ehLauncherHtml(bruto) ? bruto : "");
        var achada = html ? "" : urlDaResposta(dados, bruto);
        if (html || achada) {
          var ab = abrirLauncherOuUrl(html, achada);
          resposta.launcher = html ? 1 : 0;
          resposta.ok = ab.ok; resposta.modo = ab.modo;
          if (ab.url) resposta.url = ab.url;
          resposta.erro = ab.ok ? "" : (html ? "iframe_bloqueado" : "sem_abertura");
          if (ab.ok && ab.topo) { try { window.postMessage(resposta, "*"); } catch (_) {} return; }
          break;
        }
        // Sem URL: monta o diagnostico (code + msg ASCII + chaves) e decide se insiste.
        var code = obj && obj.code != null ? obj.code : (obj && obj.err_code != null ? obj.err_code : "?");
        var msgRaw = ((obj && (obj.msg || obj.message)) || "").toString();
        var transitorio = /obtain server|try again|try later|frequen|rapid|again|tente|aguard/i.test(msgRaw) || !!(obj && obj.err_code);
        var msg = msgRaw.replace(/[^\x20-\x7E]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
        var keys = obj ? Object.keys(obj).slice(0, 6).join(".") : "nulo";
        var dk = (dados && dados !== obj) ? Object.keys(dados).slice(0, 8).join(".") : "";
        var ec = obj && obj.errorCode != null ? obj.errorCode : (obj && obj.error != null ? obj.error : "?");
        var pres = (hdrs.newjwt ? "j" : "") + (hdrs.sitecode ? "s" : "") + (hdrs.token ? "t" : "") + (hdrs["x-object-id"] ? "o" : "") + (hdrs["x-device"] ? "d" : "") + (hdrs["browserfingerid"] ? "f" : "");
        var dk = (dados && typeof dados === "object" && dados !== obj) ? Object.keys(dados).slice(0, 10).join(".") : "";
        resposta.erro = "code" + code + "_ec" + String(ec).slice(0, 10) + "_" + (msg || "semmsg") + "_h[" + pres + "]_[" + keys + "]" + (dk ? "_d[" + dk + "]" : "");
        if (!transitorio) break;   // erro definitivo: nao adianta insistir
      }
    } catch (e) {
      // Nome do erro + host escolhido, sem segredos: e o que falta para saber se e CORS/rede ou
      // host errado. "TypeError" cross-origin = fetch bloqueado (CORS); ai vale tentar sem o host.
      var nome = (e && e.name) || "erro";
      var host = ""; try { host = new URL(API_BASE_GC || API_BASE || location.origin).host; } catch (_) {}
      resposta.erro = "excecao_" + nome + "@" + host;
    }
    try { window.postMessage(resposta, "*"); } catch (_) {}
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.__oplancar !== 1) return;
    lancarJogo(e.data.molde, e.data.id_jogo);
  });
  var jogoAnunciado = "";
  // A URL do frame ja tem o id do jogo e o token da sessao — que e tudo o que o botao precisa.
  // Antes ela so era guardada quando saia uma RODADA, porque a rodada era necessaria para
  // descobrir o slug. Resultado: quem abria o jogo e nao girava ficava sem URL, e o botao nao
  // tinha como abrir nada. O slug continua vindo da rodada; a URL passa a ir na hora.
  var urlAnunciada = "";
  function guardarUrlDoFrame() {
    try {
      if (!/^https?:\/\/[^/]+\/\d{1,6}\/index\.html\?/.test(location.href)) return;
      if (urlAnunciada === location.href) return;
      urlAnunciada = location.href;
      window.postMessage({ __opcapurl: 1, url: location.href }, "*");
    } catch (_) {}
  }
  function olharJogoDoFrame(url) {
    guardarUrlDoFrame();
    try {
      var par = classifier.jogoDoFrame(location.href, url);
      if (!par || jogoAnunciado === par.id_jogo + "|" + par.slug) return;
      jogoAnunciado = par.id_jogo + "|" + par.slug;
      var ev = { tipo: "jogo", id_jogo: par.id_jogo, slug: par.slug, origem: "frame", casa_por_aba: true };
      // O referrer some com Referrer-Policy e o iframe e de outra origem: quando ele vier, vale
      // como pista; quando nao vier, quem sabe a casa e o service worker, que conhece a aba.
      try { var dona = N.casa(new URL(document.referrer).hostname); if (dona) ev.casa = dona; } catch (_) {}
      post(ev, snapshot());
    } catch (_) {}
  }
  // ---- Rollover (TESTE): amostra dos campos da RODADA ----
  // Etapa 1 só MEDE: descobrir, com giro real, quais campos da resposta trazem a aposta e o saldo
  // antes de confiar um freio neles. Só as 8 primeiras rodadas de cada jogo aberto; sobem só
  // números, nomes de chave e metadados do transporte — nada de token.
  // 1.72: a gem-saviour (25/09) respondia em BINÁRIO e a 1.71 só lia texto: 60 amostras "vazio".
  // Agora lê os bytes (arraybuffer/blob/fetch), tenta UTF-8 → JSON e, se não for, anota tamanho,
  // tipo e os 8 primeiros bytes em hex para descobrirmos o formato.
  var amostrasGiro = 0, MAX_AMOSTRAS_GIRO = 8;
  var SEGREDO_GIRO = /token|atk|session|key|auth|senha|password|cpf|phone|mail|sign/i;
  function textoDeBytes(buf) {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf)); } catch (_) { return ""; }
  }
  function hexInicio(buf) {
    try { return Array.prototype.map.call(new Uint8Array(buf).slice(0, 8), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); } catch (_) { return ""; }
  }
  function resumoGiro(text, meta) {
    var out = { formato: typeof text === "string" && text ? "nao_json" : "vazio", tamanho: typeof text === "string" ? text.length : 0 };
    Object.keys(meta || {}).forEach(function (k) { if (meta[k] != null && meta[k] !== "") out[k] = meta[k]; });
    var obj = typeof text === "string" && text ? N.parseJSON(text) : null;
    if (!obj || typeof obj !== "object") return out;
    out.formato = "json";
    delete out.inicio_hex;
    out.chaves_topo = Object.keys(obj).filter(function (k) { return !SEGREDO_GIRO.test(k); }).slice(0, 20);
    var dt = obj.dt && typeof obj.dt === "object" ? obj.dt : null;
    var alvo = dt && dt.si && typeof dt.si === "object" ? dt.si : (dt || obj);
    out.caminho = alvo === obj ? "topo" : alvo === dt ? "dt" : "dt.si";
    var numeros = {}, n = 0;
    Object.keys(alvo).forEach(function (k) {
      var v = alvo[k];
      if (n >= 40 || SEGREDO_GIRO.test(k) || k.length > 24) return;
      if (typeof v === "number" && isFinite(v)) { numeros[k] = v; n++; }
    });
    out.numeros = numeros;
    out.chaves = Object.keys(alvo).filter(function (k) { return !SEGREDO_GIRO.test(k) && k.length <= 24; }).slice(0, 60);
    return out;
  }
  function amostrarGiro(url, text, meta) {
    try {
      if (amostrasGiro >= MAX_AMOSTRAS_GIRO) return;
      var s = classifier.SPIN.exec(String(url || ""));
      if (!s) return;
      amostrasGiro++;
      var m = meta || {};
      m.doc = String(documentId).slice(-6); m.n = amostrasGiro;
      post({ tipo: "giro_amostra", slug: s[1].toLowerCase(), campos: resumoGiro(text, m), casa_por_aba: true }, snapshot());
      // amostra é descartável: não fica na caixa de reenvio (reenviar criava duplicatas — 60 em vez de 8)
      outbox.forEach(function (ev, id) { if (ev.tipo === "giro_amostra") outbox.delete(id); });
    } catch (_) {}
  }
  function amostrarBytes(url, buf, meta) {
    meta = meta || {}; meta.bytes = buf && buf.byteLength || 0;
    var t = textoDeBytes(buf);
    if (!N.parseJSON(t)) meta.inicio_hex = hexInicio(buf);
    amostrarGiro(url, t, meta);
  }
  function change(user, token, force) {
    user = N.id(user); token = typeof token === "string" ? token : "";
    var changed = force || (CT.conta && user !== CT.conta) || (CT.tokens.length && token && token !== CT.tokens[0]);
    if (changed) {
      if (retries.length) post({ tipo: "diagnostico", motivo: "respostas_sem_identidade_na_geracao_encerrada" }, snapshot());
      generation++; retries = [];
      CT = { conta: user, users: user ? [user] : [], tokens: token ? [token] : [] };
    } else {
      CT.conta = user;
      CT.users = user ? [user] : [];
      if (token) CT.tokens = [token];
    }
    announce();
  }
  function localUser() {
    try {
      var value = N.parseJSON(localStorage.getItem("web__lobby__persisted__user") || "{}") || {};
      var u = value.userInfos || value;
      return N.id(u.username != null ? u.username : u.userId != null ? u.userId : u.user_id != null ? u.user_id : u.member_id != null ? u.member_id : u.uid);
    } catch (_) { return ""; }
  }
  function syncLocal() {
    var user = localUser();
    if (user !== lastLocal) { lastLocal = user; change(user, "", !user); reprocess(); }
    anunciarDominios();   // #3-B: manda os dominios da casa uma vez (self-guard), quando o lobby carrega
  }
  function requestContext(url) {
    syncLocal();
    try {
      var parsed = new URL(url, location.href), user = "", token = parsed.searchParams.get("token") || parsed.searchParams.get("tk") || "";
      ["username", "userId", "user_id", "uid"].some(function (k) { user = N.id(parsed.searchParams.get(k)); return !!user; });
      if (/member\/logout(?:[?#]|$)/.test(url)) change("", "", true);
      else if ((user && user !== CT.conta) || (token && token !== CT.tokens[0])) {
        change(user || CT.conta, token, false); reprocess();
      }
    } catch (_) {}
    return snapshot();
  }
  function process(url, method, response, snap, retrying, request) {
    var current = snap.contexto.geracao === context().geracao, events;
    try { events = classifier.classificar({ url: url, host: HOST, method: method, resp: response, req: request, casaOficial: dominioOficial() }, snap); }
    catch (_) { events = [{ tipo: "diagnostico", motivo: "resposta_invalida" }]; }
    var ctx = events.find(function (e) { return e.tipo === "ctx" && e.conta; });
    if (ctx && current) {
      change(ctx.conta, snap.tokens[0] || "", false);
      snap = snapshot();
    }
    events.forEach(function (ev) {
      if (ev.tipo === "ctx") return; // somente change() anuncia o contexto atual
      if (ev.tipo === "jogo" && ev.origem === "lancamento") {
        var d = descritorDoClique();
        if (d) { ev.seletor = d.seletor; ev.marca = d.marca; }
        // o molde sai do evento aqui: vai por canal proprio ao worker e nunca para o servidor
        if (ev.molde) {
          try { window.postMessage({ __opcapmolde: 1, corpo: ev.molde }, "*"); } catch (_) {}
          delete ev.molde;
        }
      }
      post(ev, snap);
    });
    var failed = events.some(function (e) { return e.motivo === "decifracao_ou_json_invalido"; });
    var unbound = !snap.conta && events.some(function (e) { return ["pedido", "deposito", "saque", "conta"].includes(e.tipo); });
    if (failed && !retrying && current) {
      if (typeof response === "string" && response.length <= 262144 && retries.length < MAX_RETRIES) {
        retries.push({ url: url, method: method, response: response, snap: snap, ts: Date.now() });
      } else post({ tipo: "diagnostico", motivo: "limite_buffer_decifracao_conferir_historico" }, snap);
    }
    if (ctx && current) reprocess();
    if (unbound) post({ tipo: "diagnostico", motivo: "identidade_ausente_conferir_historico" }, snap);
    return !failed;
  }
  function reprocess() {
    if (!retries.length || !CT.users.length || !CT.tokens.length) return;
    var pending = retries; retries = [];
    pending.forEach(function (b) {
      if (b.snap.contexto.geracao !== context().geracao || Date.now() - b.ts > RETRY_TTL) {
        post({ tipo: "diagnostico", motivo: "resposta_expirada_conferir_historico" }, b.snap); return;
      }
      if (!process(b.url, b.method, b.response, snapshot(), true)) retries.push(b);
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) return;
    if (event.data.__opcap_ack) outbox.delete(event.data.__opcap_ack);
    if (event.data.__opcap_ready) {
      outbox.forEach(function (ev) { window.postMessage({ __opcap: 1, evt: ev }, "*"); });
      announce();
    }
  });
  window.addEventListener("storage", function (event) {
    if (!event.key || event.key === "web__lobby__persisted__user") syncLocal();
  });
  ["popstate", "hashchange"].forEach(function (type) { window.addEventListener(type, syncLocal); });
  var originalFetch = window.fetch;
  if (originalFetch) window.fetch = function () {
    var args = arguments, url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
    // le o header ANTES de montar o contexto: e daqui que sai o token da decifragem
    eatHeaders((args[1] && args[1].headers) || (args[0] && args[0].headers));
    guardarHeaders(url, (args[1] && args[1].headers) || (args[0] && args[0].headers));
    lembrarApiBase(url);
    olharJogoDoFrame(url);
    if (!classifier.relevante(url)) {
      // rodada do jogo: só a amostra do Rollover (teste); a resposta segue intacta para o jogo
      if (amostrasGiro < MAX_AMOSTRAS_GIRO && classifier.SPIN.test(url)) {
        return originalFetch.apply(this, args).then(function (response) {
          try {
            if (response.ok) {
              var ct = ""; try { ct = String(response.headers.get("content-type") || "").slice(0, 40); } catch (_) {}
              response.clone().arrayBuffer().then(function (buf) { amostrarBytes(url, buf, { via: "fetch", content_type: ct }); }).catch(function () {});
            }
          } catch (_) {}
          return response;
        });
      }
      return originalFetch.apply(this, args);
    }
    var snap = requestContext(url), method = (args[1] && args[1].method) || (args[0] && args[0].method) || "GET";
    // o id do jogo vai no CORPO cifrado do launch; a resposta e um HTML de launcher, sem serventia
    var enviado = ehLancamento(url) ? corpoDoPedido(url, (args[1] && args[1].body) || (args[0] && args[0].body)) : "";
    return originalFetch.apply(this, args).then(function (response) {
      if (!response.ok) { post({ tipo: "diagnostico", motivo: "erro_http_casa" }, snap); return response; }
      try { response.clone().text().then(function (text) { process(url, method, text, snap, false, enviado); }).catch(function () {
        post({ tipo: "diagnostico", motivo: "resposta_ilegivel" }, snap);
      }); } catch (_) {}
      return response;
    });
  };
  var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__opRequest = { method: method, url: String(url || "") };
    lembrarApiBase(url);
    return open.apply(this, arguments);
  };
  // o token chega por setRequestHeader entre open() e send() — capturar aqui e o unico jeito
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { eatHeader(k, v); (this.__opHeaders = this.__opHeaders || {})[String(k).toLowerCase()] = String(v); } catch (_) {} if (setHeader) return setHeader.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (corpo) {
    var xhr = this, req = xhr.__opRequest;
    if (req) { olharJogoDoFrame(req.url); guardarHeaders(req.url, xhr.__opHeaders); }
    if (req && amostrasGiro < MAX_AMOSTRAS_GIRO && !classifier.relevante(req.url) && classifier.SPIN.test(req.url)) {
      xhr.addEventListener("load", function () {
        try {
          if (xhr.status < 200 || xhr.status >= 300) return;
          var rt = xhr.responseType || "text", ct = "";
          try { ct = String(xhr.getResponseHeader("content-type") || "").slice(0, 40); } catch (_) {}
          var meta = { via: "xhr", tipo_resposta: rt, content_type: ct };
          if (rt === "arraybuffer") { amostrarBytes(req.url, xhr.response, meta); return; }
          if (rt === "blob" && xhr.response && xhr.response.arrayBuffer) {
            xhr.response.arrayBuffer().then(function (buf) { amostrarBytes(req.url, buf, meta); }).catch(function () {});
            return;
          }
          var t = rt === "text" ? xhr.responseText : rt === "json" ? N.responseJSON(xhr.response) : "";
          // 1.73: a gem-saviour responde JSON com um inteiro gigante (id da rodada); responseJSON recusa
          // número impreciso de propósito (id arredondado não vira evidência de DINHEIRO) e a amostra
          // saía "vazio". Aposta/saldo são pequenos: para a amostra, serializa assim mesmo e avisa.
          if (t == null && rt === "json" && xhr.response && typeof xhr.response === "object") {
            try { t = JSON.stringify(xhr.response); meta.numero_grande = 1; } catch (_) { t = ""; }
          }
          amostrarGiro(req.url, t == null ? "" : t, meta);
        } catch (_) {}
      }, { once: true });
    }
    if (req && classifier.relevante(req.url)) {
      var snap = requestContext(req.url), enviado = corpoDoPedido(req.url, corpo);
      xhr.addEventListener("load", function () {
        if (xhr.status < 200 || xhr.status >= 300) { post({ tipo: "diagnostico", motivo: "erro_http_casa" }, snap); return; }
        try {
          if (xhr.responseType === "json") {
            var jsonText = N.responseJSON(xhr.response);
            if (jsonText == null) post({ tipo: "diagnostico", motivo: "resposta_json_com_numero_impreciso" }, snap);
            else process(req.url, req.method, jsonText, snap, false, enviado);
            return;
          }
          if (xhr.responseType && xhr.responseType !== "text") {
            post({ tipo: "diagnostico", motivo: "resposta_sem_texto_original_conferir_historico" }, snap); return;
          }
          process(req.url, req.method, xhr.responseText, snap, false, enviado);
        } catch (_) { post({ tipo: "diagnostico", motivo: "resposta_ilegivel" }, snap); }
      }, { once: true });
    }
    return send.apply(this, arguments);
  };
  syncLocal();
  guardarUrlDoFrame();   // frame de jogo aberto agora ja entrega a URL, sem esperar rodada
  announce(); // presença do MAIN mesmo sem login ou alteração no armazenamento
  setInterval(function () {
    syncLocal();
    outbox.forEach(function (ev) { window.postMessage({ __opcap: 1, evt: ev }, "*"); });
  }, 5000);
})();
