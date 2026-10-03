# -*- coding: utf-8 -*-
"""Testes isolados — FASE 5 (exclusao com tombstone). Banco TEMPORARIO.
Rodar: python testes/fase5_db.py"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

db.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="dashtest_"), "teste.db")
db.init()
falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond: falhas["n"] += 1
def n_ops(ped):
    with db._c() as c:
        return c.execute("SELECT COUNT(*) n FROM operacoes WHERE numero_pedido=?", (ped,)).fetchone()["n"]

PED = "211000000000000005"
ev = {"tipo": "deposito", "valor": 30, "numero_pedido": PED, "casa": "p2", "conta": "1"}

print("== exclusao NAO ressuscita no reenvio do mesmo evento ==")
db.add_operacao(dict(ev)); check(n_ops(PED) == 1, "op inserida")
db.del_operacao(PED);      check(n_ops(PED) == 0, "op excluida (descartada)")
r = db.add_operacao(dict(ev)); check(r.get("status") == "descartado", "reenvio -> status descartado")
check(n_ops(PED) == 0, "reenvio NAO ressuscitou a op")

print("== restaurar o descarte permite voltar ==")
db.restaurar_descartado(PED)
r2 = db.add_operacao(dict(ev)); check(r2.get("status") in ("ok", "promovido"), "apos restaurar, o evento entra")
check(n_ops(PED) == 1, "op de volta apos restaurar")

print("== limpar operações preserva decisão de descarte até restauração explícita ==")
db.del_operacao(PED); check(n_ops(PED) == 0, "descartada de novo")
db.limpar_operacoes("operacoes")
r3 = db.add_operacao(dict(ev)); check(r3.get("status") == 'descartado', "limpeza não ressuscita descarte")
check(n_ops(PED) == 0, 'nenhuma operação reaparece por reenvio')
db.restaurar_descartado(PED)
check(db.add_operacao(dict(ev)).get('status') == 'ok', 'só restauração explícita permite reentrada')

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
