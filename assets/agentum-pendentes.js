/* Depositos gerados que a casa ainda NAO confirmou.

   Quando a captura grava a operacao, o servidor marca o pedido como 'confirmado' sozinho
   (db._pedido_upsert) e a linha sai daqui sem ninguem clicar em nada.

   O RUIDO: a casa cria DOIS pedidos para o mesmo deposito. O extrato (pay/orderListV3) lista os
   dois, com numero_pedido diferente e milissegundos de distancia; o operador paga um e o outro
   fica preso em 'processando' (ou vira 'verificar' quando a casa o expira). Medido em 12/09/2026:
   29 dos 31 itens abertos ja tinham um deposito IDENTICO gravado no caixa — a lista era quase toda
   sobra, e por isso nao fechava na conferencia. Entao separamos:
     EM ABERTO = nao ha deposito gravado igual -> e o que o operador precisa vigiar
     JA ENTROU = ha deposito gravado igual     -> sobra da casa, fica recolhida

   Nenhum botao cria ou apaga dinheiro: so encerram o acompanhamento. Se a captura chegar depois,
   o servidor sobrescreve para 'confirmado'. */
(function (root) {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dinheiro(v) { try { return root.fmtBRL(v); } catch (_) { return 'R$ ' + Number(v || 0).toFixed(2); } }
  function nome(casa) { try { return root.casaLabel(casa); } catch (_) { return String(casa || '?'); } }
  function aviso(msg) { try { root.toast(msg); } catch (_) {} }
  function desde(iso) {
    var t = new Date(iso).getTime();
    if (!t || isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'agora';
    var m = Math.round(s / 60);
    if (m < 60) return 'há ' + m + ' min';
    var hr = Math.floor(m / 60), resto = m % 60;
    return 'há ' + hr + 'h' + (resto ? ' ' + resto + 'min' : '');
  }
  function chave(casa, conta, valor) { return casa + '|' + conta + '|' + Number(valor || 0).toFixed(2); }

  // Encerra UM pedido reaproveitando /api/pedido. Se a operacao ja existir, o servidor ignora
  // 'falhou' e devolve 'confirmado' — nao da para dispensar o que foi realmente capturado.
  function enviar(d, estado) {
    var tipo = d.tipo || 'deposito';
    // d.pedido pode trazer mais de um numero: quando a casa cria dois pedidos para o mesmo
    // deposito, o ✓/✕ tem que encerrar os DOIS, senao o gemeo reaparece sozinho na proxima leitura.
    var numeros = String(d.pedido || '').split(',').filter(Boolean);
    return numeros.reduce(function (fila, numero) {
      return fila.then(function () {
        return root.Agentum.request('/api/pedido', {
          casa: d.casa, conta: d.conta, numero_pedido: numero, tipo: tipo,
          estado: estado, valor: Number(d.valor), origem: 'painel',
          motivo: estado === 'confirmado' ? 'confirmado manualmente no painel' : 'dispensado manualmente no painel'
        });
      });
    }, Promise.resolve());
  }
  async function encerrar(botao) {
    var estado = botao.dataset.acao === 'ok' ? 'confirmado' : 'falhou';
    botao.disabled = true;
    try {
      await enviar(botao.dataset, estado);
      var rotulo = botao.dataset.tipo === 'saque' ? 'Saque' : 'Depósito';
      aviso(rotulo + (estado === 'confirmado' ? ' confirmado.' : ' dispensado.'));
      if (typeof root.pollEstado === 'function') await root.pollEstado();
    } catch (e) {
      botao.disabled = false;
      aviso((e && e.message) || 'Não foi possível concluir.');
    }
  }

  var sobras = [];
  function limparSobras() {
    if (!sobras.length) return;
    root.confirmar('Dispensar ' + sobras.length + ' pedido(s) cujo depósito já entrou? Nenhum valor é alterado — só encerra o acompanhamento.',
      async function () {
        var erros = 0, lista = sobras.slice();
        for (var i = 0; i < lista.length; i++) {
          try { await enviar(lista[i], 'falhou'); } catch (_) { erros++; }
        }
        aviso(erros ? erros + ' não puderam ser dispensados.' : 'Sobras dispensadas.');
        if (typeof root.pollEstado === 'function') await root.pollEstado();
      }, { ok: 'Dispensar sobras' });
  }

  function instalar() {
    // Id proprio: #avPendentes pertence ao renderPending legado (tabela 'pendentes'), que o
    // recria e esconde a cada renderAoVivo — disputar o mesmo no fazia esta caixa piscar e sumir.
    var el = $('agPendentes');
    if (!el) {
      var ancora = $('agHealth');
      if (!ancora) return null;
      el = document.createElement('section');
      el.id = 'agPendentes'; el.className = 'ag-pend'; el.hidden = true;
      ancora.after(el);
    }
    // Ligar o tratador SEMPRE que faltar, nao so na criacao: se a caixa existir sem ele
    // (recarga parcial, versao anterior em cache), os botoes ficam mortos em silencio.
    if (!el.__opPendLigado) {
      el.__opPendLigado = true;
      el.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.acao) return void encerrar(b);
        if (b.id === 'agPendSobras') { var c = $('agPendCaixaSobras'); if (c) c.hidden = !c.hidden; }
        if (b.id === 'agPendLimpar') limparSobras();
      });
    }
    return el;
  }

  function linha(p) {
    var numeros = p._numeros || [p.numero_pedido];
    var base = 'data-casa="' + esc(p.casa) + '" data-conta="' + esc(p.conta) + '" data-tipo="' + esc(p.tipo || 'deposito')
      + '" data-pedido="' + esc(numeros.join(',')) + '" data-valor="' + esc(p.valor) + '"';
    return '<li>'
      + '<span class="ag-pend-h">' + esc(nome(p.casa)) + '</span>'
      + '<span class="ag-pend-c">' + esc(p.conta || '')
      + (numeros.length > 1 ? ' <b class="ag-pend-par" title="A casa criou ' + numeros.length + ' pedidos para este mesmo depósito; ✓/✕ encerra todos">' + numeros.length + ' pedidos</b>' : '') + '</span>'
      + '<span class="ag-pend-v">' + (p.valor == null ? '<i class="ag-pend-semvalor">valor a confirmar</i>' : esc(dinheiro(p.valor))) + '</span>'
      + '<span class="ag-pend-t">' + (p.estado === 'verificar'
          ? '<b class="ag-pend-alerta" title="A casa e a operação gravada divergem — confira o valor/tipo">conferir</b>'
          : esc(desde(p.primeiro_em || p.observado_em))) + '</span>'
      + '<span class="ag-pend-acoes">'
      + '<button type="button" class="ag-pend-b ok" data-acao="ok" ' + base + ' title="Entrou — confirmar e tirar da lista" aria-label="Confirmar depósito">✓</button>'
      + '<button type="button" class="ag-pend-b no" data-acao="no" ' + base + ' title="Não efetivou — dispensar" aria-label="Dispensar depósito">✕</button>'
      + '</span></li>';
  }

  function render(estado) {
    var el = instalar();
    if (!el) return;
    // Deposito EXPIRADO (a casa encerrou sem pagar) = estado 'verificar' com conflito=0. Esse SAI
    // SOZINHO da lista quando expira — nao precisa o operador dispensar. So permanece o 'verificar'
    // com conflito=1 (a evidencia diverge de uma operacao gravada), que e conferencia de verdade.
    // Alem do 'verificar' expirado (conflito=0), um deposito parado em 'processando' por mais de
    // 30 min tambem ja era: a casa nao paga mais esse PIX. Some do acompanhamento sozinho (o pedido
    // fica no banco; se a captura confirmar depois, vira operacao). So display — nao mexe em dinheiro.
    var LIMITE_MS = 30 * 60 * 1000;
    var abertos = ((estado && estado.pedidos) || []).filter(function (p) {
      if (!p || p.tipo !== 'deposito') return false;
      if (p.estado === 'verificar' && p.conflito) return true;   // conferencia real: permanece
      if (p.estado !== 'processando') return false;
      // idade pelo PRIMEIRO visto (primeiro_em): observado_em é renovado a cada releitura e zerava o relógio
      var t = new Date(p.primeiro_em || p.observado_em).getTime();
      return !(t && !isNaN(t) && (Date.now() - t) > LIMITE_MS);   // >30 min sem confirmar -> sai
    });
    // Saques em acompanhamento: o painel nao os mostrava em lugar nenhum depois que #agTracking
    // foi ocultado. Sao saques que a casa aceitou e nao liquidou (ou expirou) — dinheiro que o
    // operador precisa conferir antes de fechar o ciclo.
    var saques = ((estado && estado.pedidos) || []).filter(function (p) {
      return p && p.tipo === 'saque' && (p.estado === 'processando' || p.estado === 'verificar' || p.estado === 'identificado');
    }).sort(function (a, b) { return String(b.observado_em || '').localeCompare(String(a.observado_em || '')); });
    if (!abertos.length && !saques.length) { el.hidden = true; el.innerHTML = ''; sobras = []; return; }

    // Compara com operacoes (o livro financeiro), nao com os proprios pedidos: o gemeo confirmado
    // nem chega ao painel, porque o servidor ja filtra pedidos finalizados.
    var gravados = {};
    ((estado && estado.operacoes) || []).forEach(function (o) {
      if (o && o.tipo === 'deposito') gravados[chave(o.casa, o.conta, o.valor)] = true;
    });
    // Preferir a decisao do SERVIDOR (pedidos_lista anexa sobra_de olhando o livro inteiro, em
    // qualquer ciclo). O mapa local e so fallback: estado.operacoes traz apenas as 200 do ciclo atual.
    // Quando os DOIS pedidos do mesmo deposito ainda estao abertos, o servidor aponta gemeo_de:
    // uma linha so, com "2 pedidos". Sem isto a mesma conta e valor apareciam duas vezes e
    // pareciam deposito em dobro.
    var porNumero = {};
    abertos.forEach(function (p) { porNumero[p.numero_pedido] = p; });
    var grupos = {}, ordem = [];
    abertos.forEach(function (p) {
      var raiz = p, guarda = 0;
      while (raiz.gemeo_de && porNumero[raiz.gemeo_de] && guarda++ < 5) raiz = porNumero[raiz.gemeo_de];
      if (!grupos[raiz.numero_pedido]) {
        grupos[raiz.numero_pedido] = Object.assign({}, raiz, { _numeros: [] });
        ordem.push(grupos[raiz.numero_pedido]);
      }
      grupos[raiz.numero_pedido]._numeros.push(p.numero_pedido);
    });

    var faltando = [], entrou = [];
    ordem.forEach(function (p) {
      var sobra = p.sobra_de !== undefined ? !!p.sobra_de : !!gravados[chave(p.casa, p.conta, p.valor)];
      (sobra ? entrou : faltando).push(p);
    });
    var ordenar = function (a, b) { return String(b.observado_em || '').localeCompare(String(a.observado_em || '')); };
    faltando.sort(ordenar); entrou.sort(ordenar);
    sobras = entrou.map(function (p) {
      return { casa: p.casa, conta: p.conta, pedido: (p._numeros || [p.numero_pedido]).join(','), valor: p.valor };
    });

    var total = 0, porCasa = {};
    faltando.forEach(function (p) {
      var v = Number(p.valor) || 0, k = p.casa || '?';
      total += v; porCasa[k] = (porCasa[k] || 0) + v;
    });
    var resumo = Object.keys(porCasa).sort().map(function (k) {
      return '<span>' + esc(nome(k)) + ' <b>' + esc(dinheiro(porCasa[k])) + '</b></span>';
    }).join('');

    var html = '';
    if (abertos.length) {
      html += '<div class="ag-pend-top"><span class="ag-pend-tit">Aguardando confirmação</span>'
        + '<span class="ag-pend-tot">' + faltando.length + ' · ' + esc(dinheiro(total)) + '</span></div>';
      html += faltando.length
        ? '<div class="ag-pend-resumo">' + resumo + '</div><ul class="ag-pend-lista">' + faltando.map(linha).join('') + '</ul>'
        : '<p class="ag-pend-nota">Nenhum depósito pendente — tudo que foi gerado já entrou.</p>';
    }
    if (entrou.length) {
      html += '<div class="ag-pend-sobras">'
        + '<button type="button" class="ag-pend-link" id="agPendSobras">'
        + entrou.length + ' pedido(s) duplicados pela casa — o depósito já entrou</button>'
        + '<button type="button" class="ag-pend-link forte" id="agPendLimpar">dispensar sobras</button>'
        + '<div id="agPendCaixaSobras" hidden><ul class="ag-pend-lista">' + entrou.map(linha).join('') + '</ul></div>'
        + '</div>';
    }
    if (saques.length) {
      var somaSaque = saques.reduce(function (s2, p) { return s2 + (Number(p.valor) || 0); }, 0);
      var semValor = saques.filter(function (p) { return p.valor == null; }).length;
      html += '<div class="ag-pend-saques"><div class="ag-pend-top">'
        + '<span class="ag-pend-tit">Saques em acompanhamento</span>'
        + '<span class="ag-pend-tot">' + saques.length + ' · ' + esc(dinheiro(somaSaque))
        + (semValor ? ' + ' + semValor + ' sem valor' : '') + '</span></div>'
        + '<ul class="ag-pend-lista">' + saques.map(linha).join('') + '</ul></div>';
    }
    html += '<p class="ag-pend-nota">Some sozinho quando a captura confirma, <b>quando expira ou após 30 min sem confirmar</b>. Use ✓ se entrou mesmo assim, ✕ se não efetivou.</p>';
    el.innerHTML = html;
    el.hidden = false;
  }

  root.AgentumPendentes = { render: render };
})(window);
