/* cryptolib.js — MD5 + AES-128-CBC (decrypt), puro JS, sem dependências.
   Usado pela extensão para decifrar as respostas /hall/api das casas PG.
   Chave = md5(token+username).slice(0,16); IV fixo; zero-padding. */
(function (root) {
  "use strict";

  /* ---------------- MD5 (string ASCII/UTF-8 -> hex) ---------------- */
  function md5(str) {
    function toBytes(s) {
      var out = [], i, c;
      for (i = 0; i < s.length; i++) {
        c = s.charCodeAt(i);
        if (c < 128) out.push(c);
        else if (c < 2048) { out.push(192 | (c >> 6), 128 | (c & 63)); }
        else { out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); }
      }
      return out;
    }
    function rl(x, c) { return (x << c) | (x >>> (32 - c)); }
    function add(a, b) { return (a + b) & 0xffffffff; }
    var bytes = toBytes(str), origLen = bytes.length, bitLen = origLen * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var i = 0; i < 8; i++) { bytes.push(bitLen & 0xff); bitLen = Math.floor(bitLen / 256); }
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    var S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    var K = [];
    for (var k = 0; k < 64; k++) K[k] = (Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296)) & 0xffffffff;
    for (var off = 0; off < bytes.length; off += 64) {
      var M = [];
      for (var j = 0; j < 16; j++) {
        M[j] = bytes[off + j*4] | (bytes[off + j*4 + 1] << 8) | (bytes[off + j*4 + 2] << 16) | (bytes[off + j*4 + 3] << 24);
      }
      var A = a0, B = b0, C = c0, D = d0, F, g;
      for (var idx = 0; idx < 64; idx++) {
        if (idx < 16) { F = (B & C) | (~B & D); g = idx; }
        else if (idx < 32) { F = (D & B) | (~D & C); g = (5*idx + 1) % 16; }
        else if (idx < 48) { F = B ^ C ^ D; g = (3*idx + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7*idx) % 16; }
        F = add(add(add(F, A), K[idx]), M[g]);
        A = D; D = C; C = B; B = add(B, rl(F, S[idx]));
      }
      a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
    }
    function hex(n) { var s = ""; for (var i = 0; i < 4; i++) { s += ("0" + ((n >> (i*8)) & 0xff).toString(16)).slice(-2); } return s; }
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  /* ---------------- AES-128 (tabelas geradas) ---------------- */
  var SBOX = new Uint8Array(256), INV = new Uint8Array(256), E = new Uint8Array(256), L = new Uint8Array(256);
  (function initTables() {
    var x = 1, i;
    for (i = 0; i < 255; i++) { E[i] = x; L[x] = i; x ^= ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff; }
    E[255] = E[0];
    function mulinv(a) { return a === 0 ? 0 : E[(255 - L[a]) % 255]; }
    for (i = 0; i < 256; i++) {
      var s = mulinv(i), xx = s, c;
      for (c = 0; c < 4; c++) { s = ((s << 1) | (s >> 7)) & 0xff; xx ^= s; }
      xx ^= 0x63; SBOX[i] = xx & 0xff;
    }
    for (i = 0; i < 256; i++) INV[SBOX[i]] = i;
  })();
  function gmul(a, b) { if (a === 0 || b === 0) return 0; return E[(L[a] + L[b]) % 255]; }

  function expandKey(key) { // key: 16 bytes -> 176 bytes
    var w = new Uint8Array(176), i;
    for (i = 0; i < 16; i++) w[i] = key[i];
    var rcon = 1;
    for (i = 16; i < 176; i += 4) {
      var t0 = w[i-4], t1 = w[i-3], t2 = w[i-2], t3 = w[i-1];
      if (i % 16 === 0) {
        var tmp = t0; t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[tmp];
        rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x1b : 0)) & 0xff;
      }
      w[i] = w[i-16] ^ t0; w[i+1] = w[i-15] ^ t1; w[i+2] = w[i-14] ^ t2; w[i+3] = w[i-13] ^ t3;
    }
    return w;
  }
  function decryptBlock(block, w) {
    var s = block.slice(0);
    function addRK(round) { for (var i = 0; i < 16; i++) s[i] ^= w[round*16 + i]; }
    function invShift() {
      var t = s.slice(0), rr, cc;
      for (rr = 1; rr < 4; rr++) for (cc = 0; cc < 4; cc++) s[rr + 4*cc] = t[rr + 4*((cc - rr + 4) % 4)];
    }
    function invSub() { for (var i = 0; i < 16; i++) s[i] = INV[s[i]]; }
    function invMix() {
      for (var cc = 0; cc < 4; cc++) {
        var a0 = s[4*cc], a1 = s[4*cc+1], a2 = s[4*cc+2], a3 = s[4*cc+3];
        s[4*cc]   = gmul(a0,14) ^ gmul(a1,11) ^ gmul(a2,13) ^ gmul(a3,9);
        s[4*cc+1] = gmul(a0,9)  ^ gmul(a1,14) ^ gmul(a2,11) ^ gmul(a3,13);
        s[4*cc+2] = gmul(a0,13) ^ gmul(a1,9)  ^ gmul(a2,14) ^ gmul(a3,11);
        s[4*cc+3] = gmul(a0,11) ^ gmul(a1,13) ^ gmul(a2,9)  ^ gmul(a3,14);
      }
    }
    var round;
    addRK(10);
    for (round = 9; round >= 1; round--) { invShift(); invSub(); addRK(round); invMix(); }
    invShift(); invSub(); addRK(0);
    return s;
  }
  function cbcDecrypt(cipher, key, iv) {
    var w = expandKey(key), out = new Uint8Array(cipher.length), prev = iv.slice(0), i, b;
    for (i = 0; i + 16 <= cipher.length; i += 16) {
      var block = cipher.subarray(i, i + 16);
      var dec = decryptBlock(block, w);
      for (b = 0; b < 16; b++) out[i + b] = dec[b] ^ prev[b];
      prev = block.slice(0);
    }
    return out;
  }
  /* AES encrypt — espelho do decrypt acima. Existe para CIFRAR o corpo do launch (POST
     /gameCenter/gameApi/login) com a chave da sessao. Sem isto o hook chamava C.cifrarHall,
     que nao existia: undefined(...) estourava e o botao de jogo caia em jogo_launch_excecao. */
  function encryptBlock(block, w) {
    var s = block.slice(0);
    function addRK(round) { for (var i = 0; i < 16; i++) s[i] ^= w[round*16 + i]; }
    function sub() { for (var i = 0; i < 16; i++) s[i] = SBOX[s[i]]; }
    function shift() {
      var t = s.slice(0), rr, cc;
      for (rr = 1; rr < 4; rr++) for (cc = 0; cc < 4; cc++) s[rr + 4*cc] = t[rr + 4*((cc + rr) % 4)];
    }
    function mix() {
      for (var cc = 0; cc < 4; cc++) {
        var a0 = s[4*cc], a1 = s[4*cc+1], a2 = s[4*cc+2], a3 = s[4*cc+3];
        s[4*cc]   = gmul(a0,2) ^ gmul(a1,3) ^ a2 ^ a3;
        s[4*cc+1] = a0 ^ gmul(a1,2) ^ gmul(a2,3) ^ a3;
        s[4*cc+2] = a0 ^ a1 ^ gmul(a2,2) ^ gmul(a3,3);
        s[4*cc+3] = gmul(a0,3) ^ a1 ^ a2 ^ gmul(a3,2);
      }
    }
    var round;
    addRK(0);
    for (round = 1; round <= 9; round++) { sub(); shift(); mix(); addRK(round); }
    sub(); shift(); addRK(10);
    return s;
  }
  function cbcEncrypt(plain, key, iv) {
    var w = expandKey(key), out = new Uint8Array(plain.length), prev = iv.slice(0), i, b;
    for (i = 0; i + 16 <= plain.length; i += 16) {
      var block = plain.slice(i, i + 16);
      for (b = 0; b < 16; b++) block[b] ^= prev[b];
      var enc = encryptBlock(block, w);
      for (b = 0; b < 16; b++) out[i + b] = enc[b];
      prev = enc.slice(0);
    }
    return out;
  }

  /* ---------------- helpers ---------------- */
  function b64ToBytes(b64) {
    var bin = (typeof atob === "function") ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function strToBytes(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; }
  function bytesToB64(bytes) {
    if (typeof btoa === "function") { var bin = ""; for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin); }
    return Buffer.from(bytes).toString("base64");
  }

  function cifrarHall(texto, token, username, iv) {
    // Mesma chave e IV que decifrarHall: md5(token+username)[:16] como ASCII, IV fixo.
    var keyHex = md5(String(token) + String(username)).slice(0, 16);
    var key = strToBytes(keyHex);
    var ivb = strToBytes(iv || "exemploiv1234567");
    var raw = (typeof TextEncoder === "function") ? new TextEncoder().encode(String(texto))
              : strToBytes(unescape(encodeURIComponent(String(texto))));
    // ZERO-padding ate o bloco de 16 — exatamente o que decifrarHall remove no outro sentido.
    var padLen = (16 - (raw.length % 16)) % 16;
    var padded = new Uint8Array(raw.length + padLen); padded.set(raw);
    return bytesToB64(cbcEncrypt(padded, key, ivb));
  }

  function decifrarHall(cipherB64, token, username, iv) {
    var keyHex = md5(String(token) + String(username)).slice(0, 16);
    var key = strToBytes(keyHex);
    var ivb = strToBytes(iv || "exemploiv1234567");
    var cipher = b64ToBytes(cipherB64);
    var n = cipher.length - (cipher.length % 16);
    var plain = cbcDecrypt(cipher.subarray(0, n), key, ivb);
    // remove padding zero e chars de controle (igual ao checker), depois decodifica UTF-8
    var keep = [];
    for (var i = 0; i < plain.length; i++) { var c = plain[i]; if (c >= 32 || c === 9 || c === 10 || c === 13) keep.push(c); }
    var bytes = new Uint8Array(keep);
    var txt = (typeof TextDecoder === "function") ? new TextDecoder("utf-8").decode(bytes)
              : Buffer.from(bytes).toString("utf8");
    return txt.replace(/\0+$/,"").trim();
  }

  function decifrarDefault(cipherB64, iv) {
    // chave fixa DEFAULT_KEY — usada no member/login.encryptString (traz o userId/saldo/status da conta)
    var key = strToBytes("exemplokey123456");
    var ivb = strToBytes(iv || "exemploiv1234567");
    var cipher = b64ToBytes(cipherB64);
    var n = cipher.length - (cipher.length % 16);
    if (n < 16) return "";
    var plain = cbcDecrypt(cipher.subarray(0, n), key, ivb);
    var keep = [];
    for (var i = 0; i < plain.length; i++) { var c = plain[i]; if (c >= 32 || c === 9 || c === 10 || c === 13) keep.push(c); }
    var bytes = new Uint8Array(keep);
    return ((typeof TextDecoder === "function") ? new TextDecoder("utf-8").decode(bytes) : Buffer.from(bytes).toString("utf8")).trim();
  }

  function decifrarSession(cipherB64, token, iv) {
    // chave por sessao: double_token(session_key) = md5(tk + md5(tk)).slice(2,18)
    // usada no getFastLogin (login por sessao/Cash bot) — NAO precisa do username
    var inner = md5(String(token));
    var keyHex = md5(String(token) + inner).slice(2, 18);
    var key = strToBytes(keyHex);
    var ivb = strToBytes(iv || "exemploiv1234567");
    var cipher = b64ToBytes(cipherB64);
    var n = cipher.length - (cipher.length % 16);
    if (n < 16) return "";
    var plain = cbcDecrypt(cipher.subarray(0, n), key, ivb);
    var keep = [];
    for (var i = 0; i < plain.length; i++) { var c = plain[i]; if (c >= 32 || c === 9 || c === 10 || c === 13) keep.push(c); }
    var bytes = new Uint8Array(keep);
    return ((typeof TextDecoder === "function") ? new TextDecoder("utf-8").decode(bytes) : Buffer.from(bytes).toString("utf8")).trim();
  }

  var api = { md5: md5, cifrarHall: cifrarHall, decifrarHall: decifrarHall, decifrarDefault: decifrarDefault, decifrarSession: decifrarSession };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OrionCrypto = api;
})(typeof self !== "undefined" ? self : this);
