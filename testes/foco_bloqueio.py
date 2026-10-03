# -*- coding: utf-8 -*-
"""Regressao — o foco pode barrar TODAS as abas abertas e a captura parar sem alarde.

Em 11/09/2026 o foco tinha nomes de dominios antigos; as casas abertas ficavam 'fora_do_foco' e
nada era capturado. A aba avisava, mas o aviso se perdia no painel. Aqui garantimos que o servidor
agrega isso num sinal direto: db.captura_bloqueada().

Banco TEMPORARIO, nunca o real. Rodar:  python testes/foco_bloqueio.py
"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

_tmp = tempfile.mkdtemp(prefix="dashfoco_")
db.DB_PATH = os.path.join(_tmp, "teste.db")
db.init()

falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond:
        falhas["n"] += 1

def aba(casa, estado):
    return {"tab_id": abs(hash(casa)) % 1000, "frame_id": 0, "casa": casa,
            "host": casa + ".com", "casa_normalizada": casa, "estado": estado,
            "diagnosticado_em": db.agora(), "ultima_resposta": None}

def instalar(slots):
    with db._lock, db._c() as c:
        c.execute("DELETE FROM instalacoes")
        c.execute("INSERT INTO instalacoes(instalacao_id,tipo,versao,ultimo_ping,fila,estado,slots) "
                  "VALUES(?,?,?,?,?,?,?)",
                  ("inst-teste", "mae", "1.23", db.agora(), 0, "ativo", json.dumps(slots)))

print("== sem foco: nunca reporta bloqueio ==")
db.set_foco([])
instalar([aba("exemplo", "fora_do_foco")])
r = db.captura_bloqueada()
check(r["bloqueado"] is False, "foco vazio => nao bloqueado (vazio significa capturar todas)")

print("== foco aponta para casa que nao esta aberta: TODAS barradas ==")
db.set_foco(["exemplo1"])                      # nome antigo, apos rodizio de dominio
instalar([aba("exemplo", "fora_do_foco"), aba("gaita", "fora_do_foco")])
r = db.captura_bloqueada()
check(r["bloqueado"] is True, "detecta que o foco barrou todas as abas abertas")
check(r["motivo"] == "foco", "motivo informado = foco (veio %r)" % r["motivo"])
check(r["casas_barradas"] == ["exemplo", "gaita"], "lista as casas barradas (veio %r)" % r["casas_barradas"])
check("exemplo1" in r["foco"], "devolve o foco vigente p/ o painel poder corrigir")

print("== basta UMA aba capturando para nao acusar bloqueio ==")
instalar([aba("exemplo", "fora_do_foco"), aba("exemplo1", "atualizado")])
r = db.captura_bloqueada()
check(r["bloqueado"] is False, "uma casa capturando => nao e bloqueio geral")

print("== sem nenhuma aba aberta: nao inventa bloqueio ==")
instalar([])
r = db.captura_bloqueada()
check(r["bloqueado"] is False, "sem abas observadas nao afirma bloqueio")

print("== o sinal aparece no /api/estado ==")
db.set_foco(["exemplo1"])
instalar([aba("exemplo", "fora_do_foco")])
estado = db.estado_snapshot()
check("captura_bloqueada" in estado, "estado expoe captura_bloqueada")
check(estado.get("captura_bloqueada", {}).get("bloqueado") is True, "estado marca bloqueado=True")

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
