'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const source=require('../shared/origem.js');
assert.equal(source.host('WWW.P2-GAITAPG.COM'),'p2-gaitapg.com');
assert.equal(source.host('p2-gaitapg.com.'),'p2-gaitapg.com');
assert.notEqual(source.host('exemplo.vip'),source.host('exemplo1.vip'));
for(const s of ['https://a.com/?token=xx','a.com?secret=x','a.com/path','user@a.com','a.com:80','a..com'])assert.equal(source.host(s),'');
for(const folder of ['extensao','extensao_agente']){
 for(const file of ['origem_main.js','origem_bridge.js'])assert.equal(fs.readFileSync(path.join(__dirname,'..',folder,file),'utf8'),fs.readFileSync(path.join(__dirname,'../shared/origem.js'),'utf8'));
 const m=require('../'+folder+'/manifest.json');
 // O Chrome so mostra o NOME na lista de extensoes: sem a versao ali o operador instala a errada
 // num dos perfis e o teste seguinte nao prova nada. O build crava; aqui e o alarme se alguem tirar.
 assert.ok(m.name.endsWith(' '+m.version),folder+': o nome "'+m.name+'" tem que terminar na versao '+m.version+' — rode build_extensoes.py');
 const worlds=new Map();for(const cs of m.content_scripts)for(const js of cs.js){assert.ok(!worlds.has(js)||worlds.get(js)===(cs.world||'ISOLATED'));worlds.set(js,cs.world||'ISOLATED');}
}
// Nenhum byte de controle cru nos fontes das extensoes: um NUL dentro de uma regex (/\0+$/ escrito
// com o byte real) faz o git tratar o arquivo como binario e o diff do hook some da revisao.
for(const folder of ['extensao','extensao_agente','shared']){
 const dir=path.join(__dirname,'..',folder);
 for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.js'))){
  const buf=fs.readFileSync(path.join(dir,file));
  for(let i=0;i<buf.length;i++){const b=buf[i];assert.ok(b>=0x20||b===9||b===10||b===13,folder+'/'+file+': byte de controle 0x'+b.toString(16)+' no offset '+i+' — use o escape \\0 em vez do byte cru');}
 }
}
// Esquema por DOMÍNIO (filha 1.67): a chave é o domínio de LANÇAMENTO inteiro (p2-gaitapg), não a
// rede (p2). Antes cortava no primeiro traço e juntava lançamentos distintos da mesma rede. Ver casa_por_dominio.cjs.
assert.equal(require('../extensao/normalizar.js').casa('www.p2-gaitapg.com'),'p2-gaitapg','chave = domínio de lançamento inteiro');
console.log('Origem única validada em todos os mundos; sem unir domínios distintos ou mudar dedup legado.');
