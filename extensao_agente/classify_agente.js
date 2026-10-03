/* classify_agente.js — parser dos endpoints do painel de AGENTE (conta mãe).
   Decifra (AES md5(token+username) ou DEFAULT_KEY) e extrai:
   - agente_total  : depósito/saque/contas do período (myPeriodDataV2) ou total (myTotalData)
   - agente_membros: lista por subordinado {conta, deposito, aposta} (directReportV5)
   - agente_info   : nº de membros diretos (indexInfoV2)
   Puro JS, usa OrionCrypto. Testável em Node e no navegador. */
(function (root) {
  "use strict";
  var node=typeof window==='undefined'&&typeof module!=='undefined'&&module.exports&&typeof require==='function';
  var C = node ? require("./cryptolib.js") : root.OrionCrypto;

  var Core=node?require("./core_agente.js"):root.AgentumMotherCore;
  function parseJSON(s) {
    if(typeof s!=="string")return null;
    s=s.replace(/\0+$/g, "").trim();
    // Preserve IDs numéricos longos antes de JSON.parse.
    s=s.replace(/("(?:userIdx|userId|user_id|uid)"\s*:\s*)(\d{16,})(?=\s*[,}])/g,'$1"$2"');
    try { return JSON.parse(s); } catch (_) { return null; }
  }
  function dataOf(p) {
    var o=p&&p.obj;
    if(!o||o.error||o.erro||o.success===false)return null;
    if(o.code!=null&&Number(o.code)!==1)return null;
    return o.data!=null?o.data:o;
  }
  function decAny(cipherB64, tokens, users) {
    if (!cipherB64) return null;
    var t0 = String(cipherB64).trim()[0];
    if (t0 === "{" || t0 === "[") { var o = parseJSON(cipherB64); return o ? { obj: o, user: null } : null; }
    var dd = parseJSON(C.decifrarDefault(cipherB64)); if (dd) return { obj: dd, user: null };
    for (var ti = 0; ti < tokens.length; ti++) for (var ui = 0; ui < users.length; ui++) {
      var oo = parseJSON(C.decifrarHall(cipherB64, tokens[ti], users[ui]));
      if (oo !== null) return { obj: oo, user: users[ui] };
    }
    return null;
  }
  var num=Core.num;
  function short(host) {
    host = (host || "").replace(/^www\./, "").toLowerCase();
    // painel de agente vem de <prefixo>.<CASA>pg(pay|app)(N).com -> extrai a CASA (ex.: dsryty.pintorpgpay.com -> pintor)
    var m = host.match(/([a-z]+?)pg(?:pay|app)?\d*\./);
    if (m) return m[1];
    var f = host.split(".")[0] || host; return f.indexOf("-") > 0 ? f.split("-")[0] : f;
  }

  function classificar(ev, ctx) {
    var url = ev.url || "", host = ev.host || "", tokens = ctx.tokens || [], users = ctx.users || [], out = [];
    var casa = short(host);
    // id/nome da PRÓPRIA conta-mãe logada (do localStorage, via hook) OU o usuário que decifrou (é a mãe).
    var maeId = ctx.contaMae || "", maeNome = ctx.contaMaeNome || "";
    function comMae(o) {
      if(maeId)o.conta_mae=Core.id(maeId);if(maeNome)o.conta_mae_nome=String(maeNome);
      o.periodo=o.fonte==='total'||o.fonte==='info'?'acumulado':(ev.periodo||'desconhecido');
      o.periodo_observado=ev.periodo_observado===true;o.recebido_em=ev.recebido_em||new Date().toISOString();
      // numero do periodo dito pela propria casa na requisicao (timeEnum): identidade estavel
      if(ev.periodo_enum!=null)o.periodo_enum=Number(ev.periodo_enum);
      o.coleta_id=ev.coleta_id||Core.makeId();o.unidade_contador='desconhecida';return o;
    }

    // TOTAIS por PERÍODO (Este Mês/Semana/Hoje) — o "Depósito Total (pessoas)" do painel
    if (url.indexOf("agent/promote/report/myPeriodDataV2") >= 0) {
      var p = decAny(ev.resp, tokens, users), d = p && p.obj && dataOf(p);
      if (!maeId && p && p.user) maeId = String(p.user);   // fallback: o usuário que decifrou é a mãe
      if (d && d.timeTotalDeposit != null) out.push(comMae({
        tipo: "agente_total", casa: casa, fonte: "periodo",
        deposito: num(d.timeTotalDeposit), contas: num(d.timeTotalDepositPerson),
        primeiro_deposito: num(d.timeTotalFirstDeposit), primeiro_pessoas: num(d.timeTotalFirstDepositPerson),
        saque: num(d.timeTotalWithdraw), saque_pessoas: num(d.timeTotalWithdrawPerson),
        // APOSTA do periodo: a casa manda em timeTotalValidBet. Sem isto o painel mostrava
        // "Apostas informadas: Nao informado", pois so a fonte 'total' (acumulado) trazia aposta.
        aposta: num(d.timeTotalValidBet), aposta_pessoas: num(d.timeTotalValidBetPerson)
      }));
      return out;
    }
    // TOTAIS gerais (fallback / all-time)
    if (url.indexOf("agent/promote/report/myTotalData") >= 0) {
      var t = decAny(ev.resp, tokens, users), td = t && t.obj && dataOf(t);
      if (!maeId && t && t.user) maeId = String(t.user);
      if (td && td.totalDeposit != null) out.push(comMae({
        tipo: "agente_total", casa: casa, fonte: "total",
        deposito: num(td.totalDeposit), contas: num(td.totalMember),
        saque: num(td.totalWithdraw), aposta: num(td.totalValidBet)
      }));
      return out;
    }
    // LISTA por SUBORDINADO — account + deposit + validBet (aposta)
    if (url.indexOf("agent/promote/report/directReportV5") >= 0) {
      var r = decAny(ev.resp, tokens, users), rd = r && r.obj && dataOf(r);
      var arr = rd && (rd.list || (Array.isArray(rd) ? rd : null));
      if (Array.isArray(arr)) {
        var membros = arr.map(function (m) {
          // conta = userIdx (numérico) p/ casar com a captura do jogador; nome = account (username) só p/ exibir
          return { conta: Core.id(m.userIdx != null ? m.userIdx : m.account), nome: String(m.account || ""), deposito: num(m.deposit), aposta: num(m.validBet), isDep: Core.bool(m.isDeposit) == null ? null : Number(Core.bool(m.isDeposit)), online: Core.bool(m.online) == null ? null : Number(Core.bool(m.online)), status: m.status };
        }).filter(function (x) { return x.conta; });
        // A resposta observada traz list/total/more/pageSize, mas NAO pageNo nem totalPages: o
        // numero da pagina vem no corpo da REQUISICAO (page/pageSize), lido pelo hook. Sem isso a
        // cobertura nunca se prova e a lista nunca consolida (349 coletas, 0 listas ate 12/09).
        var page=num(rd.pageNo != null ? rd.pageNo : rd.pageNum != null ? rd.pageNum : rd.current);
        if(page==null)page=num(ev.pagina_pedida);
        var more=Core.bool(rd.more != null ? rd.more : rd.hasNext != null ? rd.hasNext : rd.hasMore);
        var pages=num(rd.totalPages != null ? rd.totalPages : rd.totalPage);
        var total=num(rd.total),size=num(rd.pageSize != null ? rd.pageSize : ev.pageSize);
        // total + pageSize dizem quantas paginas existem; a casa nao manda esse numero pronto.
        if(pages==null&&total!=null&&size!=null&&size>0&&Number.isInteger(total)&&total>=0)pages=Math.max(1,Math.ceil(total/size));
        if(page!=null&&(!Number.isInteger(page)||page<1))page=null;
        if(pages!=null&&(!Number.isInteger(pages)||pages<1))pages=null;
        if(more==null&&page!=null&&pages!=null)more=page<pages;
        // A casa devolve a JANELA que ela usou (startTime/endTime em epoch) — so aqui, nao no
        // endpoint do dinheiro. Como os dois saem com o mesmo timeEnum na mesma leitura, esta
        // janela e a PROVA de quanto vale aquele numero: em 08/09, enum 2 = 1 dia (nao o mes).
        var ini=num(rd.startTime),fim=num(rd.endTime);
        var evento={tipo:"agente_membros",fonte:"membros",casa:casa,membros:membros,mais:more,total:total,pageSize:size,pagina:page,total_paginas:pages,lista_completa:false};
        if(ini!=null&&fim!=null&&fim>ini){evento.janela_inicio=ini;evento.janela_fim=fim;}
        out.push(comMae(evento));
      }
      return out;
    }
    // nº de membros diretos
    if (url.indexOf("agent/promote/index/indexInfoV2") >= 0) {
      var i = decAny(ev.resp, tokens, users), id = i && i.obj && dataOf(i);
      if (id && id.directMembers != null) out.push(comMae({ tipo: "agente_info", fonte:"info", casa: casa, membros_qtd: num(id.directMembers) }));
      return out;
    }
    return out;
  }
  var api = { classificar: classificar };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OrionAgenteClassify = api;
})(typeof self !== "undefined" ? self : this);
