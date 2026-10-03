# -*- coding: utf-8 -*-
"""Testes isolados — FASE 9 (backup/restore do SQLite). Bancos TEMPORARIOS (nunca o real).
Rodar: python testes/fase9_db.py"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db

falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond: falhas["n"] += 1
def cont(tabela):
    with db._c() as c:
        return c.execute("SELECT COUNT(*) n FROM " + tabela).fetchone()["n"]

# --- ambiente 1: cria dados e exporta ---
db.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="dash1_"), "t.db"); db.init()
db.add_operacao({"tipo": "deposito", "valor": 30, "numero_pedido": "211000000000000001", "casa": "p2", "conta": "1"})
db.add_operacao({"tipo": "saque", "valor": 50, "numero_pedido": "311000000000000001", "casa": "p2", "conta": "1"})
db.set_agente({"tipo": "agente_total", "casa": "demo12", "fonte": "periodo", "deposito": 100, "contas": 2, "saque": 0, "conta_mae": "000000001", "conta_mae_nome": "casa-mae-demo"})
db.set_ajuste({"casa": "p2", "deposito": 30, "contas": 1})
db.set_foco(["demo12"])
n_op, n_ag, n_aj, n_fo = cont("operacoes"), cont("agente"), cont("ajustes"), cont("foco")
snap = db.exportar()
check(n_op == 2 and n_ag == 1 and n_aj == 1 and n_fo == 1, "ambiente 1 populado (2 ops, 1 agente, 1 ajuste, 1 foco)")

# --- ambiente 2 (separado): banco NOVO vazio, restaura o snapshot ---
db.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="dash2_"), "t.db"); db.init()
check(cont("operacoes") == 0, "ambiente 2 comeca vazio")
r = db.importar({'confirmar':True,'restore_id':'legacy-suite-restore','banco':snap})
check(r.get("status") == "ok", "importar retornou ok")
check(cont("operacoes") == n_op and cont("agente") == n_ag and cont("ajustes") == n_aj and cont("foco") == n_fo, "contagens batem apos restore")
mae = next((a for a in db.agente_lista() if a['casa']=='demo12'),None)
check(mae and mae["conta_mae"] == "000000001" and mae["conta_mae_nome"] == "casa-mae-demo", "id+nome da mae restaurados")

# --- restore é idempotente (roda 2x, nao duplica) ---
check(db.importar({'confirmar':True,'restore_id':'legacy-suite-restore','banco':snap}) == r, 'repetição recupera mesma resposta congelada')
check(cont("operacoes") == n_op, "restore 2x nao duplica (substitui)")
check(db.importar({'confirmar':True,'restore_id':'unsafe','banco':{'_v':1,'tabelas':{}}}).get('status') == 'erro', 'backup legado incompleto rejeitado sem apagar')
check(cont('operacoes') == n_op, 'rejeição mantém operações intactas')
check(set(snap['tabelas']) == set(db._BACKUP_TABLES) and 'pendentes' in snap['tabelas'] and 'pedidos' in snap['tabelas'] and 'fechamentos' in snap['tabelas'], 'manifesto inclui todas as tabelas de negócio')

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
