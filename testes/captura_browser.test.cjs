"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { browser, encrypt, settle } = require("./captura_helpers.cjs");
const userKey = "web__lobby__persisted__user", tokenKey = "web__lobby__persisted__token";
const events = b => b.sent.filter(x => x.__opev).map(x => x.evt);
const operations = b => events(b).filter(e => ["deposito", "saque"].includes(e.tipo));
function page(extra = {}) { return browser({ local: { [userKey]: JSON.stringify({ userInfos: { username: "acct-A" } }), ...extra.local }, ...extra }); }
test("hook/bridge reais: depósito DOM 52.00 vale 52, ID longo e dedup exato", async () => {
  const b = page(); await settle();
  await b.dom("Depósito sucesso\nR$ 52.00\nNúmero do Pedido: 123456789012345678901234567890");
  assert.equal(operations(b).length, 1); assert.equal(operations(b)[0].valor, 52);
  assert.equal(operations(b)[0].numero_pedido, "123456789012345678901234567890");
  await b.dom("Depósito sucesso\nR$ 52.00\nNúmero do Pedido: 123456789012345678901234567890");
  assert.equal(operations(b).length, 1);
  await b.dom("Depósito sucesso\nR$ 52,00\nNúmero do Pedido: pedido-texto-LONGO-ABC-0123456789");
  assert.equal(operations(b).length, 2);
  await b.dom("Depósito sucesso R$ 52,00"); assert.equal(operations(b).length, 2);
  await b.dom("Saque bem sucedido R$ 52,00 Número do Pedido: 999999999999");
  assert.equal(operations(b).length, 2);
});
test("troca de conta limpa contexto e DOM, ACK antigo não restaura conta anterior", async () => {
  const b = page(); await settle();
  const initial = events(b).find(e => e.tipo === "ctx" && e.conta === "acct-A");
  await b.storage("acct-B");
  await b.message(initial);
  await b.dom("Depósito sucesso R$ 52,00 Pedido: DEP-1234");
  assert.equal(operations(b).at(-1).conta, "acct-B");
  assert.notEqual(operations(b).at(-1).contexto.geracao, initial.contexto.geracao);
  await b.storage(null);
  await b.dom("Depósito sucesso R$ 52,00 Pedido: DEP-9999");
  assert.equal(operations(b).length, 1);
});
test("ponte retenta mesmo ID após erro até ACK de armazenamento durável", async () => {
  let fail = true;
  const b = page({ ack: (msg, cb) => {
    if (cb) cb(fail ? { status: "erro" } : { status: "persistido", captura_id: msg.evt && msg.evt.captura_id });
  } });
  await settle(); await b.dom("Depósito sucesso R$ 52.00 Pedido: DEP-1111");
  const first = operations(b)[0]; fail = false;
  await b.runInterval(3000);
  assert.equal(operations(b).filter(e => e.captura_id === first.captura_id).length, 2);
  await b.runInterval(3000);
  assert.equal(operations(b).filter(e => e.captura_id === first.captura_id).length, 2);
});
test("hook filtra antes de clone, não lê corpo nem coleta sessão/jogos", async () => {
  const b = page(); await settle();
  await b.fetch("https://mock.invalid/game-api/x/v2/spin", '{"dt":{"si":{"tb":20,"aw":50}}}');
  await b.fetch("https://mock.invalid/not-relevant", "{}");
  assert.equal(b.clones.length, 0);
  let bodyRead = false;
  const opts = { method: "POST", get body() { bodyRead = true; return "password=SEGREDO"; } };
  await b.fetch("https://mock.invalid/finance/certify/cashV3?username=acct-A&token=mock-token",
    JSON.stringify({ code: 1, data: { orderNo: "cash-accepted", secret: "SEGREDO" } }), opts);
  assert.equal(bodyRead, false);
  assert.equal(operations(b).length, 0);
  const pending = events(b).find(e => e.tipo === "pedido");
  assert.equal(pending.numero_pedido, "cash-accepted"); assert.equal(pending.valor, null);
  const output = JSON.stringify(b.sent);
  assert.equal(/SEGREDO|mock-token|__session|jogo_cat|__getSession/.test(output), false);
  assert.ok(b.reads.every(k => [userKey, tokenKey, "lobby_pwa_domain"].includes(k)), "so le user/token + o dominio bonito publico (#3-B), nada de sessao/jogos");
  // A UNICA excecao ao "nao ler corpo": o launch de jogo, cujo corpo cifrado so tem o id.
  let launchLido = false;
  const launch = { method: "POST", get body() { launchLido = true; return "cifrado"; } };
  await b.fetch("https://mock.invalid/hall/api/gameCenter/gameApi/login", '{"code":1,"data":{}}', launch);
  assert.equal(launchLido, true, "o corpo do launch e lido de proposito");
  // e o corpo do saque continua intocado mesmo depois disso
  let saqueLido = false;
  await b.fetch("https://mock.invalid/finance/certify/cashV3", '{"code":1,"data":{"orderNo":"x1"}}',
    { method: "POST", get body() { saqueLido = true; return "password=SEGREDO"; } });
  assert.equal(saqueLido, false, "corpo do saque permanece nao lido");
  // A regra do launch tem que olhar o CAMINHO, nao a URL crua: com substring na query, um saque
  // com ?redirect=/hall/api/gameCenter/gameApi/login faria o corpo do SAQUE ser lido.
  let disfarce = false;
  await b.fetch("https://mock.invalid/finance/certify/cashV3?redirect=/hall/api/gameCenter/gameApi/login",
    '{"code":1,"data":{"orderNo":"x2"}}', { method: "POST", get body() { disfarce = true; return "password=SEGREDO"; } });
  assert.equal(disfarce, false, "query disfarcada de launch nao abre o corpo do saque");
  // O molde do launch NAO pode ir para o servidor: sai do evento no hook e vai por canal proprio
  const molde = { cid: "c1", exitUrl: "https://lobby/x", gameid: 2000002, os_type: 0, platfromid: 7, time: 1 };
  const evento = { tipo: "jogo", casa: "x", id_jogo: "2000002", origem: "lancamento", molde };
  assert.equal("molde" in evento, true);
  const enviado = JSON.stringify(b.sent);
  assert.equal(/exitUrl|platfromid/.test(enviado), false, "molde nunca aparece no que sobe ao servidor");
  // a asserção anti-segredo tem que valer DEPOIS de tudo isso, não só no comeco
  assert.equal(/SEGREDO|mock-token|__session|jogo_cat|__getSession/.test(JSON.stringify(b.sent)), false);
});
test("resposta atrasada permanece na geração/conta da requisição; chave antiga não mistura nova", async () => {
  const b = page(); await settle(); let release;
  b.setFetch(async () => ({ ok: true, clone: () => ({ text: () => new Promise(resolve => { release = resolve; }) }) }));
  await b.context.fetch("https://mock.invalid/finance/certify/orderInfo?username=acct-A&token=token-A");
  await settle(); await b.storage("acct-B");
  release(encrypt('{"data":{"orderNo":"OLD-1234","status":4,"money":52}}', "token-A", "acct-A"));
  await settle();
  assert.equal(operations(b).at(-1).conta, "acct-A");
  await b.fetch("https://mock.invalid/finance/certify/orderInfo?username=acct-B&token=token-B",
    encrypt('{"data":{"orderNo":"WRONG-1234","status":4,"money":52}}', "token-A", "acct-A"));
  assert.equal(operations(b).length, 1);
});
test("identidade tardia reprocessa cashV3 cifrado e histórico na mesma geração", async () => {
  const b = browser(); await settle();
  await b.fetch("https://mock.invalid/finance/certify/cashV3?token=mock-token",
    encrypt('{"code":1,"data":{"orderNo":"CASH-LATE"}}'));
  assert.equal(events(b).filter(e => e.tipo === "pedido").length, 0);
  await b.storage("acct-A");
  const pending = events(b).find(e => e.tipo === "pedido");
  assert.equal(pending.numero_pedido, "CASH-LATE"); assert.equal(pending.conta, "acct-A");
  await b.fetch("https://mock.invalid/finance/pay/orderListV3?token=mock-token",
    encrypt('{"data":{"records":[{"order_no":"DEP-LATE","status":1,"amount":52}]}}'));
  assert.ok(events(b).some(e => e.tipo === "pedido" && e.numero_pedido === "DEP-LATE"));
});
test("XHR real usa texto original, não reserializa ID arredondado de responseType=json", async () => {
  const b = page(); await settle();
  const xhr = new b.context.XMLHttpRequest();
  xhr.open("GET", "https://mock.invalid/finance/certify/orderInfo?username=acct-A");
  xhr.send();
  xhr.load('{"data":{"orderNo":12345678901234567890,"status":4,"money":52}}');
  await settle();
  assert.equal(operations(b)[0].numero_pedido, "12345678901234567890");
  const bad = new b.context.XMLHttpRequest(); bad.responseType = "json";
  bad.response = JSON.parse('{"data":{"orderNo":12345678901234567890,"status":4,"money":52}}');
  bad.open("GET", "https://mock.invalid/finance/certify/orderInfo?username=acct-A"); bad.send(); bad.load("{}");
  await settle();
  assert.equal(operations(b).length, 1);
  assert.ok(events(b).some(e => e.motivo === "resposta_json_com_numero_impreciso"));
  const good = new b.context.XMLHttpRequest(); good.responseType = "json";
  good.response = { code: 1, data: { orderNo: "12345678901234567891", status: 4, money: 52 } };
  good.open("GET", "https://mock.invalid/finance/certify/orderInfo?username=acct-A"); good.send(); good.load("");
  await settle();
  assert.equal(operations(b).length, 2);
  assert.equal(operations(b)[1].numero_pedido, "12345678901234567891");
});
test("conferência manual mantém rota/recência, sem login ou requisição ativa às casas", async () => {
  const b = browser({ local: { [userKey]: '{"username":"acct-A"}', [tokenKey]: "presente" },
    ack: (msg, cb) => {
      if (msg.__opvarrer_check && cb) cb({ ts: Date.now() });
      else if (cb) cb({ status: "persistido", captura_id: msg.evt && msg.evt.captura_id });
    } });
  await settle(); await b.runInterval(8000);
  assert.equal(b.location.href, "https://demo12.com/home/withdraw?active=3");
  assert.equal(b.clones.length, 0);
});
test("varredura sem identidade avisa mas NAO consome o comando: a aba ainda varre depois", async () => {
  // O contexto vem do hook, nao do storage: a identidade pode chegar segundos depois do comando.
  // Consumir a varredura ali deixaria a aba de fora ate o operador clicar de novo.
  const ts = Date.now();
  const b = browser({ local: { [tokenKey]: "presente" },   // sem userKey => sem conta
    ack: (msg, cb) => { if (msg.__opvarrer_check && cb) cb({ ts }); else if (cb) cb({ status: "persistido" }); } });
  await settle(); await b.runInterval(8000);
  assert.equal(b.location.href, "https://demo12.com/home", "sem identidade nao navega");
  const avisos = b.sent.filter(e => e && e.evt && /^varredura_/.test(e.evt.motivo || "")).map(e => e.evt.motivo);
  assert.deepEqual(avisos, ["varredura_sem_identidade"], "avisa uma vez");
  await b.runInterval(8000);
  assert.deepEqual(b.sent.filter(e => e && e.evt && /^varredura_/.test(e.evt.motivo || "")).map(e => e.evt.motivo),
    ["varredura_sem_identidade"], "nao repete o aviso a cada verificacao");
  assert.notEqual(b.session["__op_varr_done"], String(ts), "o comando continua disponivel para esta aba");
});

test("uid do x-object-id vira a conta quando o storage nao tem usuario", async () => {
  // Medido em 12/09: 71 de 96 abas vivas estavam SEM conta. Sem conta a aba nao entra no
  // "Varrer saques", nao le a tela de sucesso e o painel nao sabe de quem ela e. O uid chega em
  // toda requisicao no header x-object-id e identifica a conta tao bem quanto o localStorage.
  const b = browser({ local: { [tokenKey]: "presente" } });   // sem userKey => sem conta
  await settle();
  const contas = () => b.sent.filter(e => e && e.evt && e.evt.tipo === "ctx").map(e => e.evt.conta);
  assert.deepEqual([...new Set(contas())], [""], "comeca sem conta");
  await b.fetch("https://demo12.com/finance/pay/orderInfo", "{}", { headers: { "x-object-id": JSON.stringify({ uid: 778899 }) } });
  assert.equal(contas().pop(), "778899", "o uid do header vira a conta");
  // um SEGUNDO uid diferente na mesma geracao e ambiguidade: nao troca a conta escolhida
  await b.fetch("https://demo12.com/finance/pay/orderInfo", "{}", { headers: { "x-object-id": JSON.stringify({ uid: 111222 }) } });
  assert.equal(contas().pop(), "778899", "dois uids nao fazem a aba trocar de dono sozinha");
});
test("com usuario no storage o uid do header NAO sobrepoe a conta", async () => {
  const b = browser({ local: { [tokenKey]: "presente", [userKey]: '{"username":"acct-A"}' } });
  await settle();
  await b.fetch("https://demo12.com/finance/pay/orderInfo", "{}", { headers: { "x-object-id": JSON.stringify({ uid: 778899 }) } });
  const contas = b.sent.filter(e => e && e.evt && e.evt.tipo === "ctx").map(e => e.evt.conta);
  assert.equal(contas.pop(), "acct-A", "o storage continua mandando");
});
test("relay do jogo vive em TODO frame: iframe entrega a URL da sessao; versao da aba viaja no envelope", async () => {
  // O listener que repassa __opcapurl/__opcapmolde/__oplancado ao worker estava dentro de um bloco
  // que retorna em qualquer iframe. O frame do jogo — o unico que tem a URL com a sessao — nunca
  // teve quem relayasse, e o botao respondeu sem_url_da_sessao em toda versao ate aqui.
  const frame = browser({ frame: true, location: { hostname: "m.pgsoft-games.com",
    href: "https://m.pgsoft-games.com/2/index.html?ot=T&ops=x", origin: "https://m.pgsoft-games.com", pathname: "/2/index.html" } });
  await settle();
  const url = frame.sent.find(m => m.__opjogo_url);
  assert.ok(url, "iframe do jogo precisa relayar a URL ao worker");
  assert.equal(url.url, "https://m.pgsoft-games.com/2/index.html?ot=T&ops=x");
  // no topo o mesmo relay segue valendo para o molde e para o resultado do launch
  const top = page(); await settle();
  top.context.postMessage({ __opcapmolde: 1, corpo: { gameid: 2, cid: "pg" } }); await settle();
  assert.ok(top.sent.find(m => m.__opjogo_molde && m.corpo && m.corpo.cid === "pg"));
  top.context.postMessage({ __oplancado: 1, url: "https://m.x/126/index.html?ot=T", erro: "" }); await settle();
  assert.ok(top.sent.find(m => m.__opjogo_pronto && m.url.includes("/126/")));
  // a versao do codigo da ABA vai no envelope; o evento (que vai ao servidor) nao a carrega
  const ev = top.sent.find(m => m.__opev);
  assert.equal(ev.vp, "9.9"); assert.equal(ev.evt.vp, undefined);
});
test("aba logada lanca sem molde: corpo deterministico, nao cai no clique", async () => {
  // A causa de so funcionar na aba onde o operador tinha aberto o jogo: as outras nao tinham molde.
  // Agora toda aba logada monta o launch com a propria sessao (corpo deterministico), entao posta
  // __oplancar mesmo com molde vazio — nunca mais o caminho de clicar na tela como padrao.
  const b = page(); await settle();
  const now = Date.now();
  b.setAck((msg, cb) => {
    if (msg.__opjogo_check) return cb({ ts: now, casas: [], id_jogo: "2000002", molde: {} });
    if (msg.__opev) return cb({ status: "persistido", captura_id: msg.evt && msg.evt.captura_id });
    cb && cb({});
  });
  await b.runInterval(4000);
  const lancar = b.posts.find(p => p.__oplancar === 1);
  assert.ok(lancar, "aba logada tem que postar __oplancar mesmo sem molde");
  assert.equal(lancar.id_jogo, "2000002");
});
