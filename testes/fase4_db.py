# -*- coding: utf-8 -*-
"""Testes isolados — FASE 4 (versao() muda no enriquecido/promocao). Banco TEMPORARIO.
Rodar: python testes/fase4_db.py"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

db.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="dashtest_"), "teste.db")
db.init()
falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond: falhas["n"] += 1

print("== identidade ausente não cria operação; identidade completa muda revisão ==")
v0 = db.versao()
r0 = db.add_operacao({"tipo": "deposito", "valor": 30, "numero_pedido": "211000000000000001", "casa": "p2", "conta": None})
v1 = db.versao()
check(r0.get('status') == 'erro' and v1 == v0, "sem identidade: rejeita sem alterar dados/revisão")
r = db.add_operacao({"tipo": "deposito", "valor": 30, "numero_pedido": "211000000000000001", "casa": "p2", "conta": "999"})  # mesma op, agora com conta
check(r.get("status") == "ok", "identidade completa permite gravar a operação")
v2 = db.versao()
check(v2 != v1, "gravar operação muda revisão")

from dados_validacao import agora
r = db.add_operacao({"tipo":"deposito","valor":30,"numero_pedido":"211000000000000001","casa":"p2","conta":"999","data":agora()})
check(r.get('status') == 'enriquecido', 'data oficial enriquece a MESMA identidade exata')
check(db.versao() != v2, 'enriquecimento real muda revisão')

print("== revisão muda para NOVA identidade, sem promoção heurística ==")
db.add_operacao({"tipo": "saque", "valor": 104, "numero_pedido": "saque-p2-104", "casa": "p2", "conta": "333"})
v3 = db.versao()
r2 = db.add_operacao({"tipo": "saque", "valor": 104, "numero_pedido": "311000000000000009", "casa": "p2", "conta": "333", "origem": "api"})
check(r2.get("status") == "ok", "nova identidade gravada sem substituir a anterior")
v4 = db.versao()
check(v4 != v3, "nova operação muda revisão")
with db._c() as c:
    check(c.execute("SELECT COUNT(*) FROM operacoes WHERE conta='333'").fetchone()[0] == 2, 'preserva as duas identidades')
db.set_conta({'casa':'p2','conta':'999','saldo':10})
v5 = db.versao()
db.set_conta({'casa':'p2','conta':'999','saldo':11})
check(db.versao() != v5, 'mudança de saldo com mesmo tamanho textual muda revisão')

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
