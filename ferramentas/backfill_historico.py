# -*- coding: utf-8 -*-
"""Backfill do historico de execucoes.

Le a linha `#RESUMO {json}` dos logs em logs/autospin/*.log e grava no
historico.db (INSERT OR IGNORE - nao duplica nem sobrescreve execucoes ja
registradas). Util para popular o historico com execucoes anteriores a
gravacao automatica.

Uso:  python ferramentas/backfill_historico.py
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import motor_autospin as m  # noqa: E402


def _partes_do_nome(nome):
    """casa_conta_timestamp.log -> (casa, conta, started_at iso ou None)."""
    base = nome[:-4] if nome.endswith('.log') else nome
    partes = base.rsplit('_', 2)
    if len(partes) != 3:
        return '', '', None
    casa, conta, ts = partes
    try:
        started = datetime.fromtimestamp(int(ts), timezone.utc).isoformat()
    except (TypeError, ValueError):
        started = None
    return casa, conta, started


def main():
    conn = m._db_historico()
    inseridos = pulados = sem_resumo = 0
    try:
        for arq in sorted(m.LOG_DIR.glob('*.log')):
            try:
                texto = arq.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            achado = re.search(r'^#RESUMO (\{.*\})\s*$', texto, re.M)
            if not achado:
                sem_resumo += 1
                continue
            try:
                dados = json.loads(achado.group(1))
            except ValueError:
                sem_resumo += 1
                continue
            casa, conta, started = _partes_do_nome(arq.name)
            finalizado = datetime.fromtimestamp(arq.stat().st_mtime, timezone.utc).isoformat()
            modo = dados.get('modo') or {}
            por_jogo = dados.get('por_jogo') or []
            game = str(modo.get('game') or '') if isinstance(modo, dict) else ''
            if not game and por_jogo:
                game = str((por_jogo[0] or {}).get('nome') or '')
            if not game:
                game = '(varios)'
            cur = conn.execute(
                "INSERT OR IGNORE INTO execucoes (job_id, casa, conta, started_at, finalizado_em, "
                "game, motivo, tempo_s, saldo_inicial, saldo_final, lucro, roll, spins, spins_pagos, "
                "spins_nao_pagos, respins, premios, bonus, jogos, modo, por_jogo, criado_em) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (arq.stem, casa, conta, started, finalizado, game,
                 str(dados.get('motivo') or ''), dados.get('tempo_s'),
                 dados.get('saldo_inicial'), dados.get('saldo_final'), dados.get('lucro'),
                 dados.get('roll'), dados.get('spins'), dados.get('spins_pagos'),
                 dados.get('spins_nao_pagos'), dados.get('respins'), dados.get('premios'),
                 dados.get('bonus'), dados.get('jogos'),
                 json.dumps(modo, ensure_ascii=False), json.dumps(por_jogo, ensure_ascii=False),
                 datetime.now(timezone.utc).isoformat()))
            if cur.rowcount:
                inseridos += 1
            else:
                pulados += 1
        conn.commit()
    finally:
        conn.close()
    print('Backfill: %d inserido(s) | %d ja existiam | %d sem #RESUMO'
          % (inseridos, pulados, sem_resumo))


if __name__ == '__main__':
    main()
