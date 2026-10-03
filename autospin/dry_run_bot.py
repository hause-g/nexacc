# -*- coding: utf-8 -*-
"""Bot FALSO do Modo Teste (dry-run): exercita o pipeline SEM rede e SEM contas.

Imprime linhas no MESMO formato do auto_spin.py (o painel/motor leem igual),
respeita a parada graciosa (SIGBREAK/SIGTERM -> conclui e imprime o relatorio)
e emite #RESUMO no fim. Nenhuma requisicao sai daqui.
"""
import argparse
import json
import os
import random
import signal
import sys
import time

PARAR = {'sinal': False, 'agora': False}


def _handler(signum, frame):
    if PARAR['sinal']:
        PARAR['agora'] = True
        print('\n  [SINAL] Segundo pedido - encerrando sem terminar a rodada aberta.', flush=True)
        return
    PARAR['sinal'] = True
    print(f'\n  [SINAL] Recebido sinal {signum} - concluindo a rodada atual e finalizando...', flush=True)


try:
    signal.signal(signal.SIGTERM, _handler)
    signal.signal(signal.SIGINT, _handler)
    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, _handler)
except Exception:
    pass


def _fmt_tempo(seg):
    h, m, s = int(seg // 3600), int((seg % 3600) // 60), int(seg % 60)
    return '%02d:%02d:%02d' % (h, m, s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', default='Jogo Teste')
    ap.add_argument('--set-spins', type=int, default=20)
    ap.add_argument('--url', default='')
    args = ap.parse_args()

    print('=' * 60)
    print('  AUTO SPIN PG - MODO TESTE (dry-run, sem rede)')
    print('=' * 60)
    print('\nLink: (dry-run)')
    print('Plataforma: (dry-run)')
    print('Token: dry<oculto>')
    print('\nObtendo configuracao da plataforma... (simulado)')
    print(f"Jogo: {args.game} (ID: 0)")
    print('  Proxies carregadas: 0 (modo teste - sem rede)')
    total = max(1, int(args.set_spins))
    print(f'\nIniciando... (Aposta max: R$0.20, Saldo min: R$0.30, Spins fixos: {total}/jogo)')
    print('-' * 60)

    random.seed()
    bet = 0.2
    saldo = round(random.uniform(60, 140), 2)
    saldo_inicial = saldo
    roll = 0.0
    premios = 0.0
    respins = 0
    spin = 0
    t0 = time.time()
    while spin < total:
        if PARAR['agora']:
            break
        spin += 1
        ganho = round(random.uniform(0.2, 2.5), 2) if random.random() < 0.25 else 0.0
        saldo = round(saldo - bet + ganho, 2)
        roll = round(roll + bet, 2)
        premios += ganho
        ts = time.strftime('%Y-%m-%d %H:%M:%S')
        cor = '\033[94m' if ganho > 0 else ''
        print(f"[{ts}] ⚡ FlashROLL ⚡ | 🎰 Spin {spin}/{total} | 💰 Saldo R$ {saldo:.2f} | "
              f"💲BET R$ {bet:.2f} | {cor}📈 Ganho +R$ {ganho:.2f}\033[0m | 🔄 Roll R$ {roll:.2f}",
              flush=True)
        if PARAR['sinal']:
            break
        if random.random() < 0.2 and spin < total:
            respins += 1
            ts = time.strftime('%Y-%m-%d %H:%M:%S')
            print(f"[{ts}] ⚡ FlashROLL ⚡ | 🔁 Re-Spin {respins} | 💰 Saldo R$ {saldo:.2f} | "
                  f"🔄 Roll R$ {roll:.2f}", flush=True)
        time.sleep(random.uniform(0.3, 0.6))

    if PARAR['sinal']:
        print('\n[LOGOUT FINAL] Saldo confirmado: R$ %.2f (dry-run)' % saldo, flush=True)

    tempo = time.time() - t0
    lucro = round(saldo - saldo_inicial, 2)
    print()
    print('=' * 60)
    print('  RESULTADO FINAL')
    print('=' * 60)
    print(f'  Tempo: {_fmt_tempo(tempo)}')
    print('  Jogos executados: 1')
    print(f'  Total spins: {spin}')
    print(f'  Spins pagos: {spin}')
    print('  Spins não pagos: 0')
    print(f'  Re-spins: {respins}')
    print(f'  Premios brutos: R$ {premios:.2f}')
    print('  Total bonus: 0')
    print(f'  Saldo inicial: R$ {saldo_inicial:.2f}')
    print(f'  Saldo final:   R$ {saldo:.2f}')
    print(f'  Lucro/Perda:   R$ {lucro:+.2f}')
    print(f'  Rollover:      R$ {roll:.2f}')
    print('=' * 60)
    if os.environ.get('FLASHROLL_RESUMO') == '1':
        print('#RESUMO ' + json.dumps({
            'saldo_inicial': saldo_inicial, 'saldo_final': saldo, 'lucro': lucro,
            'roll': roll, 'spins': spin, 'spins_pagos': spin, 'spins_nao_pagos': 0,
            'respins': respins, 'premios': round(premios, 2), 'bonus': 0, 'jogos': 1,
            'motivo': ('sinal' if PARAR['sinal'] else 'fim'),
            'tempo_s': round(tempo, 1),
            'modo': {'game': args.game, 'dry_run': True}, 'por_jogo': [],
        }, ensure_ascii=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
