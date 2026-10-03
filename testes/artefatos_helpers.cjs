/* Somente resultados de testes; não acessa dados do painel. */
'use strict';
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
function artefatos(suite){
 const root=process.env.AGENTUM_ARTIFACTS_DIR||path.join(__dirname,'..');
 const run=process.env.AGENTUM_VALIDATION_DIR||path.join(root,'validacoes',new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid);
 const out=path.join(run,suite);fs.mkdirSync(out,{recursive:true});return out;
}
// Playwright e python resolvidos num lugar so: cinco suites tinham o caminho do runtime local
// escrito na mao, e uma atualizacao dele reprovava a validacao por motivo alheio ao codigo.
function playwright(){
 const tentativas=[process.env.AGENTUM_TEST_PLAYWRIGHT,'playwright',
  path.join(os.homedir(),'.cache/agentum/node_modules/playwright')].filter(Boolean);
 for(const alvo of tentativas){try{return require(alvo);}catch(_){}}
 throw new Error('Playwright nao encontrado; defina AGENTUM_TEST_PLAYWRIGHT com o caminho do modulo');
}
function python(){
 const tentativas=[process.env.AGENTUM_TEST_PYTHON,
  'python'].filter(Boolean);
 return tentativas.find(p=>{try{return fs.existsSync(p);}catch(_){return false;}})||tentativas[0]||'python';
}
module.exports=artefatos;
module.exports.playwright=playwright;
module.exports.python=python;
