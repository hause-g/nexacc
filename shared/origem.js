/* Origem observada, nunca equivalência entre operadoras. Fonte única do build. */
(function(root){
 'use strict';
 function host(value){
  var s=String(value||'').trim().toLowerCase().replace(/\.$/,'');
  if(s.length>253||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(s))return '';
  return s.replace(/^www\./,'');
 }
 var api={host:host,normalizada:host};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 root.AgentumOrigem=api;
})(typeof self!=='undefined'?self:this);
