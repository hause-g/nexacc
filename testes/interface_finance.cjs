const OUT=require('./artefatos_helpers.cjs')('interface_finance');
const assert=require('node:assert/strict');
const {calculate,split,coverage}=require('../assets/agentum-operacao.js');
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const op=(id,casa,conta,valor,tipo='deposito')=>({numero_pedido:id,casa,conta,valor,tipo});
const records=[op('001','A','1',100),op('002','A','2',200),op('003','A','2',300),op('004','B','1',50),op('005','A','2',701.01,'saque')];
const r=calculate({operacoes:records,gerente:2,bau:1});
assert.equal(r.td,650);assert.equal(r.contas,3);assert.equal(r.qd,4);assert.equal(r.redepositos,1);assert.equal(r.media,650/3);assert.equal(r.resultado,81.01);
assert.equal(calculate({operacoes:[...records,records[0]]}).td,650,'identical order replay deduplicated');
assert.equal(calculate({operacoes:[op('same','A','1',100),op('same','B','1',100)]}).contas,2,'house is part of identity');
assert.equal(calculate({operacoes:[op('001','A','1',null)]}).td,null,'missing is not zero');
assert.equal(calculate({operacoes:[op('001','A',null,10)]}).contas,null,'unknown identity is not a person');
assert.equal(calculate({operacoes:[{...records[0],estado:'processando'}]}).td,0,'pending excluded');
const partial=calculate({operacoes:records,ajustes:[{casa:'A',deposito:800,contas:25}]});
assert.equal(partial.td,850);assert.equal(partial.contas,null);assert.equal(partial.media,null);assert.equal(partial.qd,4,'official count is not orders');
assert.equal(calculate({operacoes:records,ajustes:[{casa:'A',deposito:800,contas:20,unidade_contador:'contas'}]}).contas,21);
assert.equal(calculate({operacoes:records,manuais:{A:600}}).saqMan,-101.01);
for(const value of [-10003,-101,0,101,10003])for(let n=1;n<8;n++){const parts=split(value,n);assert.equal(parts.reduce((a,b)=>a+b,0),value);assert.ok(Math.max(...parts)-Math.min(...parts)<=1);}
assert.equal(coverage({membros:Array(30).fill({}),contas:35,lista_completa:false}),'Lista parcial · 30 de 35 registros recebidos');
assert.equal(calculate({disponivel:false}).td,null);
const fixturePath=path.join(OUT,'interface_backend_fixture.json');
const py=require('./artefatos_helpers.cjs').python();
const generated=spawnSync(py,['-B',path.join(__dirname,'interface_backup_contract.py'),'--finance-fixture'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'}});
assert.equal(generated.status,0,generated.stderr);
{
 const f=JSON.parse(generated.stdout),input={contas:f.snapshot.resumo.contas,efetivo:f.snapshot.resumo_efetivo,gerente:f.request.gerente,bau:f.request.bau,manuais:{a:300}};
 fs.writeFileSync(fixturePath,JSON.stringify(f,null,2));
 const preview=calculate(input),frozen=f.response.resumo;
 assert.equal(preview.td,frozen.deposito);assert.equal(preview.ts,frozen.saque);assert.equal(preview.bonus,frozen.gerente_bau);assert.equal(preview.resultado,frozen.resultado);assert.equal(preview.contas,frozen.contas);assert.equal(preview.media,null);
 console.log('interface_finance: prévia corresponde ao fechamento congelado do backend real');
}
console.log('interface_finance: 18 cenários + 35 rateios de centavos aprovados');
