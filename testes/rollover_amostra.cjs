/* Rollover (teste): leitura da resposta da RODADA. 25/09 a gem-saviour respondia em binário e a 1.71
   lia "vazio" (60 amostras sem número). Extrai as funções REAIS do hook.js. node testes/rollover_amostra.cjs */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'extensao', 'hook.js'), 'utf8');
function grab(name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, 'não achei ' + name);
  let d = 0, a = src.indexOf('{', m.index), z = -1;
  for (let j = a; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { z = j + 1; break; } } }
  return src.slice(m.index, z);
}
const segredo = /var SEGREDO_GIRO = (\/.*\/i);/.exec(src)[1];
const N = { parseJSON: t => { try { return JSON.parse(t); } catch (_) { return null; } } };
const mod = new Function('N', 'var SEGREDO_GIRO = ' + segredo + ';' + grab('textoDeBytes') + grab('hexInicio') + grab('resumoGiro') +
  'return {textoDeBytes, hexInicio, resumoGiro};')(N);

const bytes = s => new TextEncoder().encode(s).buffer;
// JSON dentro de bytes (arraybuffer) vira JSON legível, com os números de dt.si
const giro = JSON.stringify({ dt: { si: { tb: 0.3, bl: 98.7, blb: 99, atk: 'SEGREDO', sid: '1' } }, err: null });
const r = mod.resumoGiro(mod.textoDeBytes(bytes(giro)), { via: 'xhr', tipo_resposta: 'arraybuffer', bytes: 70, inicio_hex: '7b22' });
assert.strictEqual(r.formato, 'json');
assert.strictEqual(r.caminho, 'dt.si');
assert.deepStrictEqual(r.numeros, { tb: 0.3, bl: 98.7, blb: 99 });
assert.ok(!r.chaves.includes('atk'), 'token não sobe nem como nome de chave');
assert.strictEqual(r.inicio_hex, undefined, 'JSON legível não precisa do hex');
assert.strictEqual(r.tipo_resposta, 'arraybuffer');
// Binário de verdade (protobuf/cifrado): formato nao_json + hex dos primeiros bytes, nenhum número inventado
const bin = new Uint8Array([0x08, 0x96, 0x01, 0xff, 0x00, 0x10, 0x20, 0x30, 0x40]).buffer;
assert.strictEqual(mod.hexInicio(bin), '089601ff00102030');
const rb = mod.resumoGiro(mod.textoDeBytes(bin), { via: 'fetch', bytes: 9, inicio_hex: mod.hexInicio(bin) });
assert.strictEqual(rb.formato, 'nao_json');
assert.strictEqual(rb.inicio_hex, '089601ff00102030');
assert.strictEqual(rb.numeros, undefined);
// Resposta vazia continua dizendo "vazio"
assert.strictEqual(mod.resumoGiro('', {}).formato, 'vazio');
console.log('rollover_amostra.cjs OK');
