# -*- coding: utf-8 -*-
"""Testes isolados — FASE 3 (validacao no servidor). Banco TEMPORARIO.
Rodar: python testes/fase3_db.py"""
import os, sys, tempfile, math
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

db.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="dashtest_"), "teste.db")
db.init()
falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond: falhas["n"] += 1

print("== add_operacao rejeita valor/tipo invalidos ==")
check(db.add_operacao({"tipo": "deposito", "valor": -5, "numero_pedido": "2xxxx1", "casa": "p2", "conta": "1"})["status"] == "erro", "valor negativo -> erro")
check(db.add_operacao({"tipo": "deposito", "valor": 0, "numero_pedido": "2xxxx2", "casa": "p2", "conta": "1"})["status"] == "erro", "valor 0 -> erro")
check(db.add_operacao({"tipo": "deposito", "valor": float("inf"), "numero_pedido": "2xxxx3", "casa": "p2", "conta": "1"})["status"] == "erro", "valor infinito -> erro")
check(db.add_operacao({"tipo": "deposito", "valor": float("nan"), "numero_pedido": "2xxxx4", "casa": "p2", "conta": "1"})["status"] == "erro", "valor NaN -> erro")
check(db.add_operacao({"tipo": "transferencia", "valor": 10, "numero_pedido": "2xxxx5", "casa": "p2", "conta": "1"})["status"] == "erro", "tipo desconhecido -> erro")
check(db.add_operacao({"tipo": "deposito", "valor": 30, "numero_pedido": "211000000000000030", "casa": "p2", "conta": "1"})["status"] in ("ok", "promovido"), "deposito valido -> ok")
check(db.add_operacao({"tipo": "saque", "valor": 50, "numero_pedido": "311000000000000050", "casa": "p2", "conta": "1"})["status"] in ("ok", "promovido"), "saque valido -> ok")

print("== id longo preservado exatamente (TEXT, sem virar numero) ==")
LONG = "211270024421054305464"
db.add_operacao({"tipo": "deposito", "valor": 84, "numero_pedido": LONG, "casa": "p2", "conta": "9"})
with db._c() as c:
    got = c.execute("SELECT numero_pedido FROM operacoes WHERE numero_pedido=?", (LONG,)).fetchone()
check(got is not None and got["numero_pedido"] == LONG, "order_no de 21 digitos guardado sem perder digito")

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
