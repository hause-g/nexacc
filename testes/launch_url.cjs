"use strict";
// A resposta moderna do launch e um HTML launcher da PG (nao uma URL): a extensao tem que RODAR
// esse HTML (num iframe) para ele escolher o CDN e abrir o jogo. Formatos antigos ainda vinham como
// URL. Este teste extrai as funcoes REAIS do hook.js e cobre os dois caminhos + o caso do svg.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "extensao", "hook.js"), "utf8");
function pega(n) {
  const re = new RegExp("function " + n + "\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\}");
  const m = src.match(re);
  assert.ok(m, "achou " + n + " no hook.js");
  return m[0];
}
const code = ["ehLauncherHtml", "acharLauncher", "ehUrl", "urlDoLauncher", "ehUrlJogo", "varrerUrl", "urlDaResposta"]
  .map(pega).join("\n") + "\nglobalThis.__t = { ehLauncherHtml, acharLauncher, urlDoLauncher, urlDaResposta };";
(0, eval)(code);
const T = globalThis.__t;

const htmlLauncher = '<!DOCTYPE html><html><head><title>game-launcher BY PG SOFT</title></head><body>'
  + '<img src="data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\'%3e"><script type="module">p.location.replace(y.tt())</script></body></html>';

test("resposta moderna: detecta o HTML launcher em url[0].url e game_url", () => {
  const data = { url: [{ url: htmlLauncher }], socket_url: null, game_url: htmlLauncher, gameid: 2001007 };
  assert.ok(T.acharLauncher(data).includes("game-launcher"), "acha o launcher");
  assert.equal(T.ehLauncherHtml(htmlLauncher), true);
});
test("nao confunde URL de jogo com launcher HTML", () => {
  assert.equal(T.acharLauncher({ game_url: "https://m.cdn/2/index.html?ot=T" }), "");
  assert.equal(T.ehLauncherHtml("https://m.cdn/2/index.html?ot=T"), false);
});
test("formato antigo (URL direta) ainda extrai", () => {
  assert.match(T.urlDaResposta({ game_url: "https://m.cdn/2/index.html?ot=T" }, ""), /\/2\/index\.html/);
  assert.match(T.urlDaResposta({ url: [{ url: "https://m.cdn/7/index.html?ot=T" }] }, ""), /\/7\/index\.html/);
});
test("urlDoLauncher pega o jogo e nunca o xmlns do svg", () => {
  const html = '<svg xmlns="http://www.w3.org/2000/svg"></svg><a href="https://m.cdn/89/index.html?ot=F">x</a>';
  assert.match(T.urlDoLauncher(html), /\/89\/index\.html/);
  assert.equal(T.urlDoLauncher('<svg xmlns="http://www.w3.org/2000/svg"/>'), "");
});
console.log("Launch: deteccao do HTML launcher + extracao de URL (formato antigo) validadas no hook real.");
