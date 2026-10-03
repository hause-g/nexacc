# -*- coding: utf-8 -*-
"""Testes isolados — OPCIONAIS (retencao de capturas/logs + descartados/restaurar).
Bancos e diretorios TEMPORARIOS. Rodar: python testes/opcionais.py"""
import os, sys, tempfile, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db, servidor

falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond: falhas["n"] += 1

print("== PRESERVAÇÃO: histórico antigo permanece durante investigação ==")
tmp = tempfile.mkdtemp(prefix="ret_")
antigo = os.path.join(tmp, "2020-01-01.jsonl"); novo = os.path.join(tmp, "hoje.jsonl")
open(antigo, "w").close(); open(novo, "w").close()
os.utime(antigo, (time.time() - 30 * 86400, time.time() - 30 * 86400))  # 30 dias atras
rm = servidor._purge_antigos(14, [tmp])
check(rm == 0, "retenção automática não remove arquivos")
check(os.path.exists(antigo), "arquivo de 30 dias preservado")
check(os.path.exists(novo), "arquivo recente PRESERVADO")
for name in ('operacoes.db','operacoes.db-wal','backup.sqlite3','ops-2020-01-01.jsonl','temp.tmp'):
    path = os.path.join(tmp,name)
    with open(path,'w') as handle: handle.write('fixture')
    os.utime(path,(time.time()-90*86400,time.time()-90*86400))
servidor._purge_antigos(14,[tmp])
check(len(os.listdir(tmp))==7,'nenhum banco, backup, WAL ou evidência financeira foi apagado')

print("== DESCARTADOS: lista + restaurar ==")
db.DB_PATH = os.path.join(tempfile.mkdtemp(prefix="dsc_"), "t.db"); db.init()
PED = "211000000000000009"
ev = {"tipo": "deposito", "valor": 30, "numero_pedido": PED, "casa": "p2", "conta": "1"}
db.add_operacao(dict(ev))
db.del_operacao(PED)
lst = db.descartados_lista()
check(len(lst) == 1 and lst[0]["numero_pedido"] == PED, "descartados_lista mostra o pedido descartado")
check(db.add_operacao(dict(ev)).get("status") == "descartado", "reenvio bloqueado (tombstone)")
db.restaurar_descartado(PED)
check(len(db.descartados_lista()) == 0, "apos restaurar, some da lista de descartados")
check(db.add_operacao(dict(ev)).get("status") in ("ok", "promovido"), "apos restaurar, o evento entra de novo")

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
