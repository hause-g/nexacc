/* Normalização compartilhada entre os dois mundos da extensão. */
(function (root) {
  "use strict";
  function id(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : "";
    return typeof value === "string" ? value.trim() : "";
  }
  function dinheiro(value) {
    if (value == null || typeof value === "boolean") return null;
    if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001)) return null;
    var s = String(value).trim().replace(/^R\$\s*/i, "").replace(/\s*BRL$/i, "").trim();
    if (!s) return null;
    if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^-?\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) s = s.replace(/,/g, "");
    else if (typeof value === "string" && /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    else if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
    var n = Number(s), cents = n * 100;
    if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(cents))) return null;
    var sign = s[0] === "-" ? -1n : 1n, parts = s.replace(/^-/, "").split(".");
    var exact = sign * (BigInt(parts[0]) * 100n + BigInt((parts[1] || "").padEnd(2, "0")));
    return BigInt(Math.round(cents)) === exact ? Number(exact) / 100 : null;
  }
  function parseJSON(text) {
    if (typeof text !== "string") return null;
    // Protege inteiros longos antes do parse, sem alterar strings ou reparar JSON inválido.
    var out = "", i = 0;
    try {
      while (i < text.length) {
        if (text[i] === '"') {
          var start = i++;
          while (i < text.length) { if (text[i] === "\\") i += 2; else if (text[i++] === '"') break; }
          out += text.slice(start, i);
        } else if (text[i] === "-" || /\d/.test(text[i])) {
          var match = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
          if (!match) return null;
          var token = match[0];
          out += /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
          i += token.length;
        } else out += text[i++];
      }
      return JSON.parse(out);
    } catch (_) { return null; }
  }
  function casa(host) {
    // Chave = dominio de LANCAMENTO inteiro (11-noitepg), nao a REDE (11). Antes cortava no
    // primeiro traco (.split("-")[0]) e juntava 11-noitepg com 11-bolhapg no mesmo "11" —
    // eram plataformas diferentes tratadas como uma so. Agora cada lancamento e uma casa.
    return String(host || "").replace(/^www\./, "").split(".")[0];
  }
  function uuid() {
    // Identificador de transporte, não é credencial nem ID de transação da casa.
    var c = typeof crypto !== "undefined" ? crypto : null;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    var bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (n) { return n.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  function responseJSON(value) {
    if (typeof value === "string") return value;
    function safe(v) {
      if (typeof v === "number") return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v));
      return !v || typeof v !== "object" || Object.keys(v).every(function (k) { return safe(v[k]); });
    }
    // IDs numéricos já arredondados pelo navegador não podem virar evidência textual.
    try { return safe(value) ? JSON.stringify(value) : null; } catch (_) { return null; }
  }
  var api = { dinheiro: dinheiro, id: id, parseJSON: parseJSON, casa: casa, uuid: uuid, responseJSON: responseJSON };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OrionNormalizar = api;
})(typeof self !== "undefined" ? self : this);
