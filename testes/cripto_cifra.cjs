"use strict";
// cifrarHall precisa produzir EXATAMENTE o que a casa espera no corpo do launch. Prova em tres
// frentes: (1) bate com o AES-128-CBC do Node com zero-padding (implementacao padrao como oraculo),
// (2) ida e volta com decifrarHall recupera o texto, (3) nao sobra bloco de PKCS#7 no fim.
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("crypto");
const C = require("../shared/cryptolib.js");

function oraculo(texto, token, user, iv) {
  const key = crypto.createHash("md5").update(token + user).digest("hex").slice(0, 16);
  const data = Buffer.from(texto, "utf8");
  const pad = Buffer.alloc(Math.ceil(data.length / 16) * 16 || 16); data.copy(pad);
  const c = crypto.createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv || "exemploiv1234567"));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(pad), c.final()]).toString("base64");
}

test("cifrarHall existe e bate com o AES-CBC padrao do Node (zero-padding)", () => {
  assert.equal(typeof C.cifrarHall, "function", "cifrarHall tem que existir — sua ausencia era o jogo_launch_excecao");
  const casos = [
    [JSON.stringify({ os_type: 2, platfromid: 200, cid: "999998", exitUrl: "", gameid: 2000002, time: 1789571924 }), "abc123", "000000002"],
    ["x", "tk", "u"],                         // curto, forca zero-padding de um bloco
    ["1234567890123456", "t2", "u2"],         // exatamente 16 bytes, sem padding
    [JSON.stringify({ gameid: 2001007, time: 1789580000, cid: "999998" }), "TOKEN-LONGO-abcdef", "000000003"],
  ];
  for (const [txt, tk, u] of casos) {
    assert.equal(C.cifrarHall(txt, tk, u), oraculo(txt, tk, u), "cifra diverge do padrao para: " + txt.slice(0, 24));
  }
});

test("ida e volta: decifrarHall(cifrarHall(x)) === x", () => {
  const corpo = JSON.stringify({ os_type: 2, platfromid: 200, cid: "999998", exitUrl: "", gameid: 2000126, time: 1789571000 });
  const cifrado = C.cifrarHall(corpo, "sess-tok", "000000004");
  assert.equal(C.decifrarHall(cifrado, "sess-tok", "000000004"), corpo);
});

test("sem bloco PKCS#7 sobrando: saida e multiplo de 16 e do tamanho do texto zero-preenchido", () => {
  const corpo = JSON.stringify({ os_type: 2, platfromid: 200, cid: "999998", exitUrl: "", gameid: 2000002, time: 1789571924 });
  const bytes = Buffer.from(C.cifrarHall(corpo, "abc", "000000002"), "base64").length;
  const esperado = Math.ceil(Buffer.byteLength(corpo) / 16) * 16;
  assert.equal(bytes % 16, 0);
  assert.equal(bytes, esperado, "um bloco a mais aqui e o PKCS#7 que a casa rejeitaria");
});

console.log("cifrarHall validado contra o AES padrao, ida e volta, e sem padding extra.");
