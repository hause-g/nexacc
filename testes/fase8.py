# -*- coding: utf-8 -*-
"""Testes isolados — FASE 8 (servidor nao serve arquivos sensiveis). Rodar: python testes/fase8.py
Importa servidor (nao inicia o servidor nem toca no banco: db.init/serve so no __main__)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import servidor

falhas = {"n": 0}
def check(cond, msg):
    print(("  ok  " if cond else "  XX  FALHOU: ") + msg)
    if not cond: falhas["n"] += 1

print("== BLOQUEADOS (dados/segredos/codigo) ==")
for p in ["/operacoes.db", "/operacoes.db-wal", "/telegram/config.json", "/capturas/2026-09-09.jsonl",
          "/logs/ops-2026-09-09.jsonl", "/db.py", "/servidor.py", "/extensao/manifest.json",
          "/extensao_agente/hook_agente.js", "/_backups/x.json", "/CONHECIMENTO-AUTOMACAO-CASAS.md",
          "/extensao.zip", "/Abrir Dashboard.bat", "/seed.js", "/controle-servidor.ps1",
          "/shared/cryptolib.js", "/testes/test.js", "/build/config.js", "/documentacao/test.html"]:
    check(servidor._bloqueado(p), "bloqueia " + p)

print("== BLOQUEADOS mesmo URL-ENCODED / traversal (bypass fechado) ==")
for p in ["/db%2epy", "/servidor%2Epy", "/operacoes%2edb", "/telegram%2fconfig.json",
          "/telegram/config.json", "/%2e%2e/telegram/config.json", "/x%2ejsonl", "/qualquer.json",
          # trailing space/dot (Windows ignora ao abrir -> tem que bloquear igual)
          "/db.py%20", "/db.py%2e", "/db.py%20%20", "/operacoes.db%20", "/servidor.py%2e", "/operacoes.db-wal%20",
          "/operacoes.db::$DATA", "/db.py::$DATA"]:
    check(servidor._bloqueado(p), "bloqueia (encoded/trailing) " + p)

print("== BLOQUEADOS 8.3 (alias NTFS) — guard textual ~digito ==")
for p in ["/OPERAC~1.DB-", "/OPERAC~2.DB-", "/EXTENS~2/hook_agente.js", "/GIT~1/config", "/operac~1.db"]:
    check(servidor._bloqueado(p), "bloqueia (8.3) " + p)

print("== LIBERADOS (app) ==")
for p in ["/", "/index.html", "/assets/agentum-operacao.js", "/service-worker.js", "/manifest.webmanifest", "/icons/icon-192.png"]:
    check(not servidor._bloqueado(p), "libera " + p)

print("== ROBUSTO: _bloqueado_real sobre o caminho JA resolvido (nome longo) ==")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def _fp(rel): return os.path.join(BASE, rel.replace("/", os.sep))
for rel in ["operacoes.db", "operacoes.db-wal", "operacoes.db-shm", "db.py", "servidor.py",
            "extensao_agente/hook_agente.js", "extensao/classify.js", "telegram/config.json", ".git/config"]:
    check(servidor._bloqueado_real(_fp(rel)), "real bloqueia " + rel)
for rel in ["index.html", "assets/agentum-operacao.js", "service-worker.js", "icons/icon-192.png", "manifest.webmanifest"]:
    check(not servidor._bloqueado_real(_fp(rel)), "real libera " + rel)
check(servidor._bloqueado_real(os.path.join(BASE, "..", "fora.txt")), "real bloqueia fora do BASE")

print("\n=== RESULTADO: %d falha(s) ===" % falhas["n"])
sys.exit(1 if falhas["n"] else 0)
