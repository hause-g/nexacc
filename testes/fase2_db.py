# -*- coding: utf-8 -*-
"""Testes isolados — FASE 2 (identidade com CASA no db.py). Banco TEMPORARIO, nunca o real.
Rodar:  python testes/fase2_db.py"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

_tmp = tempfile.mkdtemp(prefix="dashtest_")
db.DB_PATH = os.path.join(_tmp, "teste.db")   # aponta o db pro temporario ANTES de init
db.init()

falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond: falhas["n"] += 1

def conta_ops(**w):
    with db._c() as c:
        q = "SELECT COUNT(*) n FROM operacoes"
        cond, args = [], []
        for k, v in w.items():
            cond.append(k + "=?"); args.append(v)
        if cond: q += " WHERE " + " AND ".join(cond)
        return c.execute(q, args).fetchone()["n"]

print("== mesma conta+valor em CASAS diferentes NAO se fundem ==")
db.add_operacao({"tipo": "deposito", "valor": 50, "numero_pedido": "deposito-A-50", "casa": "p2", "conta": "111"})
db.add_operacao({"tipo": "deposito", "valor": 50, "numero_pedido": "deposito-B-50", "casa": "p4", "conta": "111"})
check(conta_ops(tipo="deposito") == 2, "2 depositos (um por casa) — nao deduplicou entre casas")
check(conta_ops(casa="p2") == 1 and conta_ops(casa="p4") == 1, "cada casa com o seu")

print("== 2 depositos IGUAIS na MESMA conta+casa (order_no diferentes) contam os dois ==")
db.add_operacao({"tipo": "deposito", "valor": 30, "numero_pedido": "211000000000000001", "casa": "p2", "conta": "222"})
db.add_operacao({"tipo": "deposito", "valor": 30, "numero_pedido": "211000000000000002", "casa": "p2", "conta": "222"})
check(conta_ops(conta="222") == 2, "2 depositos reais de R$30 (order_no distintos) — nao sumiu nenhum")

print("== IDs distintos da tela/API NÃO são fundidos por conta+valor ==")
db.add_operacao({"tipo": "saque", "valor": 104, "numero_pedido": "saque-p2-104", "casa": "p2", "conta": "333"})   # tela
r = db.add_operacao({"tipo": "saque", "valor": 104, "numero_pedido": "311000000000000009", "casa": "p2", "conta": "333", "origem": "api"})  # API mesmo casa
check(r.get("status") == "ok", "API inseriu identidade distinta; não promove por valor")
check(conta_ops(conta="333") == 2, "as duas identidades permanecem preservadas")
with db._c() as c:
    pedidos = {r['numero_pedido'] for r in c.execute("SELECT numero_pedido FROM operacoes WHERE conta='333'")}
check(pedidos == {"311000000000000009", "saque-p2-104"}, "ambos os IDs originais foram preservados")

print("== PROMOCAO NAO cruza casas diferentes ==")
db.add_operacao({"tipo": "saque", "valor": 77, "numero_pedido": "saque-p2-77", "casa": "p2", "conta": "444"})    # tela na p2
r2 = db.add_operacao({"tipo": "saque", "valor": 77, "numero_pedido": "311000000000000077", "casa": "p4", "conta": "444", "origem": "api"})  # API na p4
check(r2.get("status") != "promovido", "API da 'p4' NAO promoveu a tela da 'p2'")
check(conta_ops(conta="444") == 2, "ficaram 2 linhas (casas diferentes) — sem falso merge")

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
