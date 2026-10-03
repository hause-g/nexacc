/* Funções puras e fila durável da Conta Mãe. Sem rede ou sessão. */
(function(root) {
  'use strict';
  function num(v) {
    if (v == null || typeof v === 'boolean') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    var s=String(v).trim().replace(/(?:R\$|BRL)/gi,'').replace(/\s/g,'');if(!s)return null;
    var c=s.lastIndexOf(','),d=s.lastIndexOf('.');
    if(c>=0&&d>=0)s=c>d?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');else if(c>=0)s=s.replace(',','.');
    return /^-?\d+(?:\.\d+)?$/.test(s)&&Number.isFinite(Number(s))?Number(s):null;
  }
  function bool(v){if(v===true||v===1||v==='1'||v==='true')return true;if(v===false||v===0||v==='0'||v==='false')return false;return null;}
  function id(v){return typeof v==='number'&&!Number.isSafeInteger(v)?'':v==null?'':String(v);}
  function period(code,now){
    if(!['hoje','ontem','mes','semana','ultima'].includes(code))return 'desconhecido';
    var d=new Date(now==null?Date.now():now);if(code==='ontem')d.setDate(d.getDate()-1);
    var s=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');if(code!=='mes')s+='-'+String(d.getDate()).padStart(2,'0');return code+'@'+s;
  }
  function makeId(){return typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);}
  function DurableQueue(storage,key){
    this.storage=storage;this.key=key;this.items=[];this.chain=Promise.resolve();this.sending=false;var self=this;
    this.ready=storage.get(key).then(function(v){
      if(v!=null&&!Array.isArray(v))throw new Error('Fila persistida inválida');
      self.items=(v||[]).map(function(x){return x.event?x:{id:makeId(),event:x};});return storage.set(key,self.items);
    });
  }
  DurableQueue.prototype.change=function(fn){
    var self=this;var next=this.chain.then(function(){return self.ready;}).then(async function(){
      var items=fn(self.items.slice());await self.storage.set(self.key,items);self.items=items;
    });this.chain=next.catch(function(){});return next;
  };
  DurableQueue.prototype.push=function(event){var item={id:makeId(),event:JSON.parse(JSON.stringify(event))};return this.change(function(items){items.push(item);return items;}).then(function(){return item.id;});};
  DurableQueue.prototype.flush=async function(send){
    await this.ready;if(this.sending)return;this.sending=true;
    try{
      await this.chain;
      // Um relatório rejeitado não bloqueia os demais. Lote limitado; falhas vão para o fim.
      var batch=this.items.slice(0,25);
      for(var i=0;i<batch.length;i++){
        var item=batch[i],accepted=await send(item.event,item.id);
        await this.change(function(items){
          var kept=items.filter(function(x){return x.id!==item.id;});
          if(!accepted){var current=items.find(function(x){return x.id===item.id;});if(current)kept.push(current);}
          return kept;
        });
      }
    }finally{this.sending=false;}
  };
  var api={num:num,bool:bool,id:id,period:period,DurableQueue:DurableQueue,makeId:makeId};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;root.AgentumMotherCore=api;
})(typeof self!=='undefined'?self:this);
