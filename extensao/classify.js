/* Respostas passivas. Apenas estados comprovados geram eventos financeiros. */
(function (root) {
  "use strict";
  var node = typeof window === "undefined" && typeof module !== "undefined" && module.exports && typeof require === "function";
  var C = node ? require("./cryptolib.js") : root.OrionCrypto;
  var N = node ? require("./normalizar.js") : root.OrionNormalizar;
  function endpoint(url) { return String(url || "").split(/[?#]/)[0].replace(/\/+$/, ""); }
  function relevante(url) {
    return /(?:finance\/(?:certify\/(?:cashV3|orderInfo|withdrawRecord)|pay\/(?:orderInfo|orderListV3)|user\/(?:accountPageList|accountTotalV2))|certify\/withdrawRecord|pay\/paysubmit|member\/(?:login|getFastLogin|logout|user\/info)|gameCenter\/gameApi\/(?:login|favoriteGameList))$/.test(endpoint(url));
  }
  // O lobby nunca muda de URL: o jogo entra num iframe da PG Soft em m.<cdn>/<ID>/index.html com
  // um token efemero na query. Entao nao ha link por jogo para guardar — so a IDENTIDADE (id do
  // jogo, slug, nome), que e o que permite pedir o launch depois na aba ja logada.
  var FRAME_JOGO = /^https?:\/\/[^/]+\/(\d{1,6})\/index\.html/i;
  var SPIN = /\/game-api\/([a-z0-9][a-z0-9-]{1,40})\/v\d+\/spin(?:$|[?#])/i;
  // O que o corpo do launch pode ensinar sobre o JOGO. Tudo o mais e descartado na origem.
  // Lista POSITIVA. Alem do que identifica o jogo, entram os campos que dao a FORMA do pedido de
// lancamento (cid, os_type, platfromid, time, exitUrl): sao identificadores de plataforma, um
// horario e a URL de saida da propria casa — nenhum e sessao. A sessao mora no header token e na
// chave que cifra o corpo, e nenhum dos dois passa por aqui. Com a forma no servidor, UM perfil
// aprende e todos os outros abrem o jogo sem o operador abrir nada.
var CAMPOS_JOGO = ["gameid", "gamecode", "gamename", "gametype", "gamekind", "platform", "vendor", "provider", "slug",
                   "cid", "exiturl", "os_type", "ostype", "platfromid", "platformid", "time", "language", "currency"];
  function jogoDoFrame(frameUrl, requestUrl) {
    var f = FRAME_JOGO.exec(String(frameUrl || "")), s = SPIN.exec(String(requestUrl || ""));
    if (!f || !s) return null;
    return { id_jogo: f[1], slug: s[1].toLowerCase() };
  }
  function status(v, expected) { return v === expected || v === String(expected); }
  function valido(obj) {
    return obj && typeof obj === "object" && !obj.error && !obj.erro && obj.success !== false &&
      !["error", "erro", "failed"].includes(obj.status) &&
      // Somente code=1 foi observado nestas rotas; status interno não supera erro do envelope.
      (!("code" in obj) || [1, "1"].includes(obj.code));
  }
  function decAny(text, ctx) {
    if (typeof text !== "string" || !text.trim()) return null;
    var obj = N.parseJSON(text);
    if (obj) return { obj: obj, user: N.id(ctx.conta) || (ctx.users.length === 1 ? N.id(ctx.users[0]) : "") };
    for (var token of ctx.tokens) for (var user of ctx.users) {
      try { obj = N.parseJSON(C.decifrarHall(text, token, user)); } catch (_) { obj = null; }
      if (obj) return { obj: obj, user: N.id(user) };
    }
    return null;
  }
  // ISO com fuso, ou epoch. Epoch e inequivoco (nao ha fuso para inventar), e sem ele a data
  // oficial se perdia: no ciclo 13 nenhuma das 183 operacoes tinha data, contra 100% nos ciclos
  // 9-12 — o que faz historico descoberto tarde (extrato, withdrawRecord, "Varrer saques") cair no
  // ciclo da OBSERVACAO em vez do ciclo em que aconteceu.
  // Texto sem fuso continua RECUSADO de proposito: interpretar "2026-09-10 12:00:00" como horario
  // local erraria por horas se a casa publicar no fuso dela, e jogaria a operacao no ciclo errado.
  var EPOCH_MIN = 946684800;            // 2000-01-01 em segundos
  var EPOCH_MAX = 4102444800;           // 2100-01-01 em segundos
  function date(row) {
    for (var k of ["data", "finishTime", "successTime", "createTime", "orderTime", "created_at", "create_time"]) {
      var v = row[k];
      if (typeof v === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))) return v;
      if (typeof v === "number" && Number.isFinite(v)
          && ((v >= EPOCH_MIN && v <= EPOCH_MAX) || (v >= EPOCH_MIN * 1000 && v <= EPOCH_MAX * 1000))) return v;
    }
    return undefined; // não inventa fuso nem horário oficial
  }
  var SEGREDO_CONTA = /token|session|jwt|senha|password|passwd|cpf|phone|mobile|email|key|auth|gesture|finger/i;
  function sinaisDe(obj) {
    var saida = {};
    if (!obj || typeof obj !== "object") return saida;
    Object.keys(obj).slice(0, 80).forEach(function (k) {
      if (k.length > 40 || SEGREDO_CONTA.test(k)) return;
      var v = obj[k];
      if (typeof v === "boolean") saida[k] = v ? 1 : 0;
      else if (typeof v === "number" && Math.abs(v) < 1e12) saida[k] = v;
    });
    return saida;
  }
  function classificar(ev, context) {
    // #3-B: quando o hook resolve o dominio BONITO da casa (ev.casaOficial, ex.: p2-exemplopg), a
    // captura e chaveada por ele — nao pelo host cru (exemplopg pelado, hash de cloudfront). So aceita
    // uma chave com cara de <rede>-<plataforma>pg; senao cai no host, como sempre.
    var casaOf = (ev.casaOficial && /^[a-z0-9][a-z0-9\-]{1,30}$/.test(ev.casaOficial)) ? String(ev.casaOficial).toLowerCase() : "";
    var ctx = Object.assign({ tokens: [], users: [] }, context), url = endpoint(ev.url), casa = casaOf || N.casa(ev.host), out = [];
    if (!relevante(url)) return out;
    function diagnostic(motivo) { return [{ tipo: "diagnostico", motivo: motivo, casa: casa, conta: N.id(ctx.conta) || "" }]; }
    if (/member\/logout$/.test(url)) return [];
    // Identidade de jogo. O launch manda o id do jogo no CORPO cifrado da requisicao e responde um
    // HTML da PG Soft (launcher com token de uso unico) — nada disso vira link reutilizavel, entao
    // so o id interessa. O catalogo de favoritos traz id + nome de varios de uma vez.
    if (/gameCenter\/gameApi\/login$/.test(url)) {
      var pedido = decAny(ev.req, ctx);
      var corpo = pedido && (pedido.obj && pedido.obj.data != null && typeof pedido.obj.data === "object" ? pedido.obj.data : pedido.obj);
      if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return diagnostic("lancamento_de_jogo_ilegivel");
      var alvo = N.id(corpo.gameId != null ? corpo.gameId : corpo.gameid != null ? corpo.gameid : corpo.id);
      // Extrai aqui, na origem: mandar o corpo decifrado inteiro faria um segredo atravessar o
      // postMessage antes de qualquer filtro. Lista POSITIVA — o que nao esta nela nao viaja.
      var campos = {};
      Object.keys(corpo).forEach(function (k) {
        if (CAMPOS_JOGO.indexOf(String(k).toLowerCase()) < 0) return;
        var v = corpo[k];
        if (typeof v === "number" || typeof v === "boolean") campos[k] = v;
        // exitUrl e uma URL da casa e nao cabe em 24; o resto continua curto de proposito.
        else if (typeof v === "string" && v.length <= (String(k).toLowerCase() === "exiturl" ? 200 : 24)) campos[k] = v;
      });
      // Só os NOMES das chaves do corpo, nunca os valores: e o que falta para montar o pedido do
      // botao depois, sem que nenhum conteudo do launch precise ser visto por ninguem.
      var vistos = Object.keys(corpo).map(String).filter(function (k) { return k.length <= 40; }).slice(0, 40);
      // O molde e o corpo decifrado inteiro. Ele NAO vai para o servidor: o hook o arranca deste
      // evento e entrega so ao worker, que guarda no proprio navegador. E com ele que o botao
      // refaz o launch de qualquer jogo, trocando gameid e time — sem o operador abrir nada.
      out.push({ tipo: "jogo", casa: casa, id_jogo: alvo || "sem_id", origem: "lancamento",
                 campos: campos, campos_vistos: vistos, molde: corpo });
      return out;
    }
    if (/gameCenter\/gameApi\/favoriteGameList$/.test(url)) {
      var cat = decAny(ev.resp, ctx);
      if (!cat || !valido(cat.obj)) return diagnostic("catalogo_de_jogos_ilegivel");
      var lista = cat.obj.data != null ? cat.obj.data : cat.obj;
      lista = Array.isArray(lista) ? lista : (lista && (lista.list || lista.records || lista.games)) || [];
      if (!Array.isArray(lista)) return out;
      lista.slice(0, 200).forEach(function (g) {
        if (!g || typeof g !== "object") return;
        var gid = N.id(g.gameId != null ? g.gameId : g.id != null ? g.id : g.code);
        if (!gid) return;
        var nome = g.gameName != null ? g.gameName : g.name != null ? g.name : g.title;
        var linha = { tipo: "jogo", casa: casa, id_jogo: gid, origem: "catalogo" };
        if (typeof nome === "string" && nome.trim()) linha.nome = nome.trim().slice(0, 80);
        out.push(linha);
      });
      return out;
    }
    if (/member\/(login|getFastLogin)$/.test(url)) {
      var obj = N.parseJSON(ev.resp);
      if (obj && !valido(obj)) return diagnostic("resposta_login_invalida");
      try {
        if (obj && obj.encryptString) obj = N.parseJSON(C.decifrarDefault(obj.encryptString));
        if (!obj && /getFastLogin$/.test(url)) for (var token of ctx.tokens) { obj = N.parseJSON(C.decifrarSession(ev.resp, token)); if (obj) break; }
      } catch (_) { obj = null; }
      if (!valido(obj)) {
        // Conta que fica anormal FALHA o login — entao o user_status nunca e relido e o painel
        // segue mostrando o ultimo estado bom. O codigo do erro e o unico sinal que sobra, e ate
        // agora ele era jogado fora junto com a resposta.
        var codigo = obj && (obj.code != null ? obj.code : obj.errorCode);
        var deQuem = N.id(ctx.conta);
        if (deQuem && codigo != null && Number(codigo) !== 1)
          return [{ tipo: "conta", casa: casa, conta: deQuem, erro_login: Number(codigo) }];
        return diagnostic("resposta_login_invalida");
      }
      var login = obj.data || obj, user = N.id(login.username != null ? login.username : login.userId);
      if (!user) return diagnostic("identidade_ausente");
      out.push({ tipo: "ctx", casa: casa, conta: user });
      var account = { tipo: "conta", casa: casa, conta: user };
      if (login.user_status != null) account.status = login.user_status;
      // A casa manda mais do que o status: um vetor de permissoes que VARIA entre contas enquanto
      // o status vem 1 em todas. "Saque proibido" e "bau proibido" devem morar aqui. Sobe cru, sem
      // interpretacao — dizer qual posicao e qual sem uma conta comprovadamente proibida e chute.
      if (Array.isArray(login.userOptResult)) account.permissoes = login.userOptResult.slice(0, 20);
      if (login.auditMode != null) account.auditoria = login.auditMode;
      // "Baú proibido" saiu do vetor acima; "saque proibido" NAO esta la — a conta travada tem o
      // mesmo padrao de 54 contas boas. Entao levamos todos os SINAIS escalares do login para
      // comparar conta travada com conta sa. So numero e booleano: nome com cara de credencial
      // (token, senha, cpf, telefone, e-mail) fica de fora, e texto nao viaja de jeito nenhum.
      account.erro_login = 0;          // login deu certo: apaga o erro anterior desta conta
      account.sinais = sinaisDe(login);
      if (login.permissionOpt && typeof login.permissionOpt === "object") {
        var extra = sinaisDe(login.permissionOpt), destino = account.sinais;
        Object.keys(extra).forEach(function (k) { destino["permissionOpt." + k] = extra[k]; });
      }
      var balance = N.dinheiro(login.game_gold);
      if (balance != null) account.saldo = balance;
      out.push(account);
      return out;
    }
    var decoded = decAny(ev.resp, ctx);
    if (!decoded) return diagnostic("decifracao_ou_json_invalido");
    // pay/paysubmit (PIX gerado) tem envelope proprio: code '' ou '0000' com success:true (medido em 952
    // respostas reais). valido() exige code=1 e a recusaria — por isso a validacao dela e a parte, abaixo.
    var criacaoDeposito = /pay\/paysubmit$/.test(url);
    if (!criacaoDeposito && !valido(decoded.obj)) return diagnostic("erro_api_casa");
    var data = decoded.obj.data != null ? decoded.obj.data : decoded.obj, conta = decoded.user;
    function pedido(row, tipo, value, number, final, origem, accepted) {
      var id = N.id(number);
      if (!id) { out.push({ tipo: "diagnostico", casa: casa, conta: conta, motivo: "pedido_sem_id_conferir_historico" }); return; }
      var amount = N.dinheiro(value), known = amount != null && amount > 0;
      var state = final && known ? "confirmado" : accepted ? "identificado" : status(row.status, 1) ? "processando" : "verificar";
      var reason = final ? (known ? "status_final_comprovado" : "valor_ausente_ou_invalido") : accepted ? "aceite_com_id_sem_liquidacao" : "status_nao_final_confirmado";
      var event = { tipo: "pedido", tipo_pedido: tipo, numero_pedido: id, valor: known ? amount : null,
        casa: casa, conta: conta, estado: state, motivo: reason, origem: origem, observado_em: new Date().toISOString() };
      var official = date(row); if (official) event.data = official;
      out.push(event);
      if (final && known) {
        var op = { tipo: tipo, valor: amount, numero_pedido: id, casa: casa, conta: conta, origem: origem };
        if (official) op.data = official;
        out.push(op);
      } else if (tipo === "deposito" && status(row.status, 1)) {
        // Sinal legado preservado; o worker atual unifica no /api/pedido.
        out.push({ tipo: "deposito_pendente", valor: known ? amount : null, numero_pedido: id, casa: casa, conta: conta });
      }
    }
    function records(d) { return Array.isArray(d) ? d : d && (d.records || d.list || d.data); }
    if (criacaoDeposito) {
      // Criacao do deposito (PIX gerado): orderNo + createTime (epoch UTC). Vira pedido 'identificado' SEM
      // valor e SEM operacao — so crava a HORA DE CRIACAO; o servidor poe o pedido no ciclo dessa hora e a
      // operacao que chegar depois herda o ciclo (pedido_original). Medido em 23/09: 439 de 952 orderNo =
      // numero_pedido gravado depois; observado 4 s a 77 min apos o createTime, nunca antes (sem fuso a
      // calibrar). So numero e hora saem daqui: qrCode/payAddress (codigo PIX) nunca entram no evento.
      var o = decoded.obj;
      var ped = o && o.orderNo != null ? o : (data && typeof data === "object" && data.orderNo != null ? data : null);
      var hora = ped ? { status: null, createTime: ped.createTime, create_time: ped.create_time } : null;
      if (!ped || o.success === false || ped.success === false || !date(hora)) return [];
      pedido(hora, "deposito", null, ped.orderNo, false, "paysubmit", true);
      return out;
    }
    if (/certify\/cashV3$/.test(url)) {
      if (status(decoded.obj.code, 1) && data) pedido(data, "saque", null, data.orderNo, false, "cashV3", true);
    } else if (/certify\/orderInfo$/.test(url)) {
      if (data) pedido(data, "saque", data.money != null ? data.money : data.realMoney, data.orderNo, status(data.status, 4), "api");
    } else if (/pay\/orderInfo$/.test(url)) {
      if (data) pedido(data, "deposito", data.amount, data.order_no, status(data.status, 2), "api");
    } else if (/pay\/orderListV3$/.test(url)) {
      var deposits = records(data);
      if (Array.isArray(deposits)) deposits.forEach(function (r) { if (r) pedido(r, "deposito", r.amount, r.order_no, status(r.status, 2), "extrato"); });
    } else if (/certify\/withdrawRecord$/.test(url)) {
      var withdrawals = records(data);
      if (Array.isArray(withdrawals)) withdrawals.forEach(function (r) {
        if (!r) return;
        var v = r.money != null ? r.money : r.amount != null ? r.amount : r.applyAmount != null ? r.applyAmount : r.cashAmount;
        pedido(r, "saque", v, r.orderNo || r.orderNumber || r.tradeNo || r.id, status(r.status, 4), "withdrawRecord");
      });
    } else if (/user\/accountPageList$/.test(url)) {
      var ledger = records(data);
      if (Array.isArray(ledger)) ledger.forEach(function (r) {
        if (!r) return;
        var label = String(r.opt_type_text || r.deal_type_name || r.opt_type_name || "");
        var withdraw = /saque|retirad|withdraw/i.test(label), deposit = /dep[oó]sito/i.test(label);
        if (!withdraw && !deposit) return;
        // Sem contrato de liquidação deste extrato: inclusive devoluções/rejeições só acompanham.
        var v = N.dinheiro(r.item_count);
        pedido(r, withdraw ? "saque" : "deposito", v == null ? null : Math.abs(v), r.orderNo, false, "accountPageList");
      });
    } else if (/member\/user\/info$/.test(url)) {
      if (data && data.userStatus != null) out.push({ tipo: "conta", casa: casa, conta: conta, status: data.userStatus });
    } else if (/user\/accountTotalV2$/.test(url) && data) {
      var a = { tipo: "conta", casa: casa, conta: conta };
      [["balance", "saldo"], ["totalChargeAmount", "totalCharge"], ["totalWithdrawAmount", "totalWithdraw"]].forEach(function (pair) {
        var v = N.dinheiro(data[pair[0]]); if (v != null) a[pair[1]] = v;
      });
      if (Object.keys(a).length > 3) out.push(a);
    }
    return out;
  }
  var api = { classificar: classificar, relevante: relevante, jogoDoFrame: jogoDoFrame, SPIN: SPIN };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OrionClassify = api;
})(typeof self !== "undefined" ? self : this);
