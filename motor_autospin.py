# -*- coding: utf-8 -*-
"""
Motor Auto Spin — extrai sessões do DB, monta URLs _ti, lança auto_spin.py
como subprocesso por conta e acompanha progresso em tempo real.
"""
import base64
import json
import os
import random
import re
import signal
import sqlite3
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

# Caminhos
DIR = Path(__file__).resolve().parent
DB_PATH = DIR / 'operacoes.db'
# Banco do servidor de sessões (porta 8790) — onde a extensão envia contas ativas em tempo real
ROLLOVER_DIR = Path(os.environ.get('ROLLOVER_SESSOES_DIR', str(DIR / 'rollover_sessoes')))
SESSOES_DB = ROLLOVER_DIR / 'sessoes.db'
AUTO_SPIN = DIR / 'autospin' / 'auto_spin.py'
AUTO_SPIN_WG = DIR / 'autospin' / 'auto_spin_wg.py'
PROVEDOR_WG = 13
LOG_DIR = DIR / 'logs' / 'autospin'
LOG_DIR.mkdir(parents=True, exist_ok=True)
HISTORICO_DB = LOG_DIR / 'historico.db'
PROXIES_FILE = DIR / 'autospin' / 'proxies_game.txt'
PROXIES_SAUDE = DIR / 'autospin' / 'cache' / 'proxies_saude.json'
# Score por proxy (linha -> ms), lido pelo bot para preferir as mais rapidas.
PROXIES_SCORE = DIR / 'autospin' / 'cache' / 'proxies_score.json'
# Alvo leve do teste de saude das proxies. HTTP (sem CONNECT) - calibrado:
# ~29ms mediana com as fixas; o HTTPS via CONNECT nestas proxies fica ~1,1s.
PROXY_TESTE_URL = 'http://www.gstatic.com/generate_204'

# Parada graciosa (T1): o 1o pedido deixa o bot concluir a rodada aberta e fazer
# o logout final; vencido o prazo, repete o sinal (nao espera a rodada) e, logo
# depois, encerra na forca. Prazos por env para os testes de escalonamento.
PRAZO_PARADA_GRACIOSA = float(os.environ.get('AUTOSPIN_PRAZO_GRACIOSO', '120'))
PRAZO_PARADA_IMEDIATA = float(os.environ.get('AUTOSPIN_PRAZO_IMEDIATO', '20'))

# Estado em memória dos processos ativos
_lock = threading.Lock()
_salvar_lock = threading.Lock()  # serializa a escrita do _jobs.json (varios escritores)
_processos = {}  # {job_id: {proc, thread, log_file, config, status, started_at, ...}}
_pedidos_parada = {}  # {job_id: nivel} — quantas vezes a parada foi pedida (escalonamento)
_ondas_ativas = set()       # {lote_id} — lotes com contas ainda por lancar (ondas)
_ondas_canceladas = set()   # {lote_id} — lotes que NAO devem lancar o restante
_ondas_pendentes = set()    # {lote_id} — ondas marcadas antes da thread comecar
_contas_iniciando = set()   # {'casa|conta'} reservadas entre conferir e spawnar (anti-corrida)
_ids_reservados = set()     # {job_id} reservados entre gerar e registrar (anti-colisao de id)
_parada_geral_seq = 0       # incrementa a cada "Parar Tudo"; spawn em andamento se auto-para
_lote_seq = 0               # sufixo para o id do lote (2 lancamentos no mesmo ms nao se misturam)
_lotes_hist = {}            # {lote: {'encerrados': {job_ids}, 'roll': total}} — contabilidade do lote


def _db():
    return sqlite3.connect(str(DB_PATH), timeout=30)


def _db_rollover():
    """Conecta ao banco de sessões ativas (porta 8790)."""
    return sqlite3.connect(str(SESSOES_DB), timeout=30)


def _get_sessoes(casas=None, contas=None, ativas=True, minutos=5, pares=None):
    """Extrai sessões do banco de sessões ativas (rollover, porta 8790).

    ativas=True: só contas atualizadas nos últimos `minutos` minutos.
    pares: lista de {'casa': ..., 'conta': ...} — filtra pelo PAR exato
    (evita o produto cruzado de casas x contas quando o painel seleciona
    contas específicas em casas diferentes).
    """
    from datetime import datetime, timedelta, timezone
    if not SESSOES_DB.exists():
        return []
    conn = _db_rollover()
    conn.row_factory = sqlite3.Row
    q = "SELECT casa, conta, session_key, userkey, jwt_token, host, atualizado_em FROM sessoes WHERE session_key IS NOT NULL AND session_key != ''"
    params = []
    if ativas:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=minutos)).strftime('%Y-%m-%dT%H:%M:%S')
        q += " AND substr(atualizado_em, 1, 19) >= ?"
        params.append(cutoff)
    if casas:
        placeholders = ','.join(['?' for _ in casas])
        q += f" AND casa IN ({placeholders})"
        params.extend(casas)
    if contas:
        placeholders = ','.join(['?' for _ in contas])
        q += f" AND conta IN ({placeholders})"
        params.extend(contas)
    if pares is not None:
        conds = []
        for par in pares:
            try:
                casa_p = str(par.get('casa') or '').strip()
                conta_p = str(par.get('conta') or '').strip()
            except AttributeError:
                continue
            if casa_p and conta_p:
                conds.append("(casa = ? AND conta = ?)")
                params.extend([casa_p, conta_p])
        # Seleção explícita vazia/inválida NÃO pode virar "todas": filtra nada.
        q += " AND (" + " OR ".join(conds) + ")" if conds else " AND 0"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    sessoes = []
    for r in rows:
        sk = r['session_key'] or ''
        if not sk or len(sk) < 39:
            continue
        sessoes.append({
            'casa': r['casa'],
            'conta': r['conta'],
            'session_key': sk,
            'host': r['host'] or '',
            'userkey': r['userkey'] or '',
            'jwt_token': r['jwt_token'] or '',
            'atualizado_em': r['atualizado_em'],
        })
    return sessoes


def montar_url_ti(session_key, host, scheme='https'):
    """Monta URL com _ti que o auto_spin.py entende."""
    ti_data = json.dumps({"session_key": session_key})
    ti_b64 = base64.b64encode(ti_data.encode()).decode()
    return f"{scheme}://{host}/?_ti={ti_b64}"


def montar_args_auto_spin(url, config):
    """Monta lista de argumentos CLI para auto_spin.py (PG) ou auto_spin_wg.py (WG)."""
    # -u: stdout sem buffer, para o log aparecer em tempo real no painel
    provedor = int(config.get('provedor') or 200)
    if provedor == PROVEDOR_WG:
        return _montar_args_wg(url, config)
    args = ['python', '-u', str(AUTO_SPIN), '--url', url]
    if config.get('game'):
        args += ['--game', config['game']]
    if config.get('bet_max') is not None:
        args += ['--bet-max', str(config['bet_max'])]
    if config.get('max_spin', 0) > 0:
        args += ['--max-spin', str(config['max_spin'])]
    if config.get('set_spins', 0) > 0:
        args += ['--set-spins', str(config['set_spins'])]
    if config.get('auto_roll'):
        args.append('--auto-roll')
    if config.get('max_roll') is not None:
        args += ['--max-roll', str(config['max_roll'])]
    if config.get('meta', 0) > 0:
        args += ['--meta', str(config['meta'])]
    if config.get('pg_trava'):
        args.append('--pg-trava')
    if config.get('zerar_saldo'):
        args.append('--zerar-saldo')
    if config.get('zerar_saldo_total'):
        args.append('--zerar-saldo-total')
    if config.get('gem_trava'):
        args += ['--gem-trava', str(config['gem_trava'])]
    if config.get('coletar_bonus'):
        args.append('--coletar-bonus')
    if config.get('comprar_bonus', 0) > 0:
        args += ['--comprar-bonus', str(config['comprar_bonus'])]
    # Flags avancadas (T3)
    if config.get('abrir_jogos') is not None and int(config.get('abrir_jogos', -1)) >= 0:
        args.append('--abrir-jogos')
        if int(config['abrir_jogos']) > 0:
            args.append(str(int(config['abrir_jogos'])))
    if config.get('bet_percent', 0) > 0:
        args += ['--bet-percent', str(config['bet_percent'])]
    if config.get('saldo_limite', 0) > 0:
        args += ['--saldo-limite', str(config['saldo_limite'])]
    if config.get('gem_trava') and config.get('gem_hp', 0) > 0:
        args += ['--hp', str(config['gem_hp'])]
    if config.get('gem_trava') and config.get('bau'):
        args.append('--bau')
    if config.get('coletar_bonus') and config.get('account_id'):
        args += ['--account-id', str(config['account_id'])]
    if config.get('coletar_bonus') and config.get('bonus_dias', 0) > 0:
        args += ['--bonus-dias', str(config['bonus_dias'])]
    if config.get('coletar_bonus') and config.get('sem_extrato'):
        args.append('--sem-extrato')
    if config.get('max_game', 0) > 0:
        args += ['--max-game', str(config['max_game'])]
    if config.get('no_proxy'):
        args.append('--no-proxy')
    if config.get('proxy_sempre'):
        args.append('--proxy-sempre')
    if config.get('loop'):
        args.append('--loop')
    return args


def _montar_args_wg(url, config):
    """Argumentos para o runner WG (WebSocket). Aceita o subconjunto compativel."""
    args = ['python', '-u', str(AUTO_SPIN_WG), '--url', url]
    if config.get('game'):
        args += ['--game', config['game']]
    if config.get('bet_max') is not None:
        args += ['--bet-max', str(config['bet_max'])]
    if config.get('set_spins', 0) > 0:
        args += ['--set-spins', str(config['set_spins'])]
    if config.get('max_spin', 0) > 0:
        args += ['--max-spin', str(config['max_spin'])]
    if config.get('auto_roll'):
        args.append('--auto-roll')
    if config.get('max_roll'):
        args += ['--max-roll', str(config['max_roll'])]
    if config.get('meta', 0) > 0:
        args += ['--meta', str(config['meta'])]
    if config.get('no_proxy'):
        args.append('--no-proxy')
    return args


def _parse_log_line(line):
    """Extrai métricas de uma linha de log do auto_spin."""
    info = {}
    try:
        # Telemetria T6: linha JSON unica no fim do job (FLASHROLL_RESUMO=1)
        if line.startswith('#RESUMO '):
            try:
                dados = json.loads(line[8:])
                if isinstance(dados, dict):
                    info['resumo'] = dados
                    if 'saldo_final' in dados:
                        info['saldo'] = dados['saldo_final']
                    if 'roll' in dados:
                        info['roll'] = dados['roll']
                    if 'spins' in dados:
                        info['spins'] = dados['spins']
            except (ValueError, TypeError):
                pass
        # Saldo
        m = re.search(r'Saldo[:\s]+R\$\s*([\d.,]+)', line)
        if m:
            try:
                info['saldo'] = float(m.group(1).replace(',', '.'))
            except ValueError:
                pass
        # Roll
        m = re.search(r'Roll[:\s]+R\$\s*([\d.,]+)', line)
        if m:
            try:
                info['roll'] = float(m.group(1).replace(',', '.'))
            except ValueError:
                pass
        # Spins (ignora "Re-Spin N", que nao e o contador de giros)
        m = re.search(r'(?<!Re-)(?<!re-)[Ss]pins?[:\s]+(\d+)', line)
        if m:
            info['spins'] = int(m.group(1))
        # Ganho/Perda de um jogo
        m = re.search(r'(Lucro|Ganho|Perda|APROVEITADO)[:\s-]+R\$\s*([-\d.,]+)', line)
        if m:
            try:
                info['ganho_jogo'] = float(m.group(2).replace(',', '.'))
            except ValueError:
                pass
        # Jogo atual
        m = re.search(r'Jogo[:\s]+(.+?)(?:\s*\||$)', line)
        if m:
            info['jogo_atual'] = m.group(1).strip()
        # Status final
        for status in ['FINALIZADO', 'ERRO', 'TRAVADO', 'BONUS', 'ROLLOVER_OK', 'META_ATINGIDA']:
            if status in line:
                info['status'] = status
        # AUTO ROLL
        m = re.search(r'\[AUTO ROLL\].*?(\d+)\s*spin', line)
        if m:
            info['spins_calculados'] = int(m.group(1))
        # MAX ROLL
        m = re.search(r'\[MAX ROLL\].*?R\$\s*([\d.,]+)', line)
        if m:
            try:
                info['max_roll_definido'] = float(m.group(1).replace(',', '.'))
            except ValueError:
                pass
    except Exception:
        pass
    return info


def _limpar_ansi(line):
    """Remove codigos de cor ANSI do log."""
    return re.sub(r'\x1b\[[0-9;]*[A-Za-z]|\[9[0-9]m|\[0m', '', line)


def _linha_de_giro(line):
    """Linha util de progresso: giro/re-spin, erro, fim ou resumo."""
    padroes = ('FlashROLL', 'Spin ', 'Re-Spin', '[ERRO', '[FIM', '[SALDO ZEROU',
               'RESULTADO FINAL', 'Saldo inicial', 'Saldo final', 'Lucro/Perda',
               'Rollover:', 'Bonus', 'TRAVAD', 'AUTO ROLL', 'MAX ROLL', '[LOGOUT',
               '[DESCONECTADA')
    return any(p in line for p in padroes)


def _monitor_thread(job_id, proc, log_path):
    """Monitora subprocesso, parseia log, atualiza estado.

    Le por POSICAO (gets)size + seek), que detecta crescimento do arquivo de forma
    confiavel no Windows mesmo depois de um EOF. Guarda TODAS as linhas uteis.
    """
    _monitor_generico(
        job_id,
        log_path,
        vivo_fn=lambda: proc.poll() is None,
        returncode_fn=lambda: proc.returncode,
    )


def _monitor_thread_pid(job_id, pid, log_path):
    """Monitora um processo RESTAURADO (sem objeto Popen): vivez via PID."""
    _monitor_generico(
        job_id,
        log_path,
        vivo_fn=lambda: _pid_vivo(pid),
        returncode_fn=lambda: None,
    )


def _monitor_generico(job_id, log_path, vivo_fn, returncode_fn):
    MAX_LINHAS = 400
    pos = 0
    pendente = ''

    def _registrar(line):
        try:
            limpa = _limpar_ansi(line)
            info = _parse_log_line(limpa)
            with _lock:
                p = _processos.get(job_id)
                if not p:
                    return
                if info:
                    p['metricas'].update(info)
                    p['ultima_linha'] = limpa
                p['ultimo_log_em'] = datetime.now(timezone.utc).isoformat()
                p['log_lines'].append(limpa)
                if len(p['log_lines']) > MAX_LINHAS:
                    p['log_lines'] = p['log_lines'][-MAX_LINHAS:]
                if _linha_de_giro(limpa):
                    # Guarda a linha ORIGINAL (com codigos ANSI) para o painel pintar as cores
                    p['log_spins'].append(line)
                    if len(p['log_spins']) > MAX_LINHAS:
                        p['log_spins'] = p['log_spins'][-MAX_LINHAS:]
                # "Acoes/s" no painel: re-spins contam como acao (o Turbo acelera
                # a cadeia e isso nao aparecia so com giros pagos).
                if 'Re-Spin' in limpa:
                    p['metricas']['respins_vistos'] = int(p['metricas'].get('respins_vistos') or 0) + 1
                p['atualizado_em'] = datetime.now(timezone.utc).isoformat()
            # T5: teto global de roll do lote (fora do lock; so age se configurado)
            _checar_teto_roll(job_id)
        except Exception:
            pass

    def _ler_novas():
        nonlocal pos, pendente
        try:
            tamanho = os.path.getsize(log_path)
        except OSError:
            return
        if tamanho <= pos:
            return
        try:
            with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
                f.seek(pos)
                bloco = f.read()
                pos = f.tell()
        except OSError:
            return
        pendente += bloco
        partes = pendente.split('\n')
        pendente = partes.pop()  # ultima parte pode estar incompleta
        for linha in partes:
            linha = linha.strip()
            if linha:
                _registrar(linha)

    time.sleep(1)
    while vivo_fn():
        _ler_novas()
        time.sleep(0.5)
    _ler_novas()  # resto final
    if pendente.strip():
        _registrar(pendente.strip())

    rc = returncode_fn()
    with _lock:
        if job_id in _processos:
            p = _processos[job_id]
            em_parada = p.get('status') == 'parando'
            teve_sinal = any('[SINAL]' in l for l in p['log_lines'])
            teve_desconectada = any('[DESCONECTADA]' in l for l in p['log_lines'])
            if rc == 20 or teve_desconectada:
                # Sessao caiu no meio dos giros (T4): exige novo login na casa.
                p['status'] = 'desconectada'
            elif em_parada and rc == 0 and teve_sinal:
                p['status'] = 'parado_gracioso'
            elif em_parada and rc == 0:
                p['status'] = 'finalizado'
            elif em_parada:
                p['status'] = 'parado_pelo_usuario'
            elif rc is None:
                p['status'] = 'finalizado'
            else:
                p['status'] = 'finalizado' if rc == 0 else f'erro_rc_{rc}'
            p['finalizado_em'] = p.get('finalizado_em') or datetime.now(timezone.utc).isoformat()
            p['returncode'] = rc
            _registrar_finalizacao_lote_locked(job_id, p)
    _salvar_registro()
    _registrar_historico(job_id)
    _checar_parada_por_meta()


def _checar_teto_roll(job_id):
    """T5: teto global de roll do lote.

    Quando o roll somado dos jobs do MESMO lote atinge o teto configurado, todos
    os que ainda estao rodando recebem o pedido de parada (gracioso). Chamado a
    cada atualizacao de log, para agir durante a execucao (nao so no fim).
    """
    a_parar = []
    with _lock:
        p = _processos.get(job_id)
        if not p:
            return
        cfg = p.get('config') or {}
        try:
            teto = float(cfg.get('roll_teto_lote') or 0)
        except (TypeError, ValueError):
            teto = 0
        lote = cfg.get('_lote_id')
        if teto <= 0 or not lote:
            return
        membros = [(jid, q) for jid, q in _processos.items()
                   if (q.get('config') or {}).get('_lote_id') == lote]
        hist = _lotes_hist.get(lote) or {}
        encerrados = hist.get('encerrados') or set()
        soma = float(hist.get('roll') or 0) + sum(
            float((q.get('metricas') or {}).get('roll') or 0)
            for jid, q in membros if jid not in encerrados
        )
        rodando = [jid for jid, q in membros
                   if q.get('status') in ('rodando', 'erro_monitor')]
        if soma >= teto:
            # Marca o cancelamento DENTRO do lock (mesma secao que escolhe os
            # jobs): um spawn em paralelo ou ve o cancelamento, ou entra na
            # lista abaixo — sem janela entre escolher e cancelar.
            if lote in _ondas_ativas or lote in _ondas_pendentes:
                _ondas_canceladas.add(lote)
            a_parar.extend(rodando)
    for jid in a_parar:
        parar_job(jid)


def _checar_parada_por_meta():
    """'Parar tudo apos N contas': quando N jobs do MESMO LOTE terminam, interrompe o resto.

    O limite vem do config (parar_ao_finalizar) e o lote (_lote_id, marcado em
    iniciar_jobs) impede que jobs antigos/restaurados contem para o limite novo.
    Chamado SO fora do _lock.
    """
    a_parar = []
    with _lock:
        lotes = {}
        for p in _processos.values():
            cfg = p.get('config') or {}
            try:
                n = int(cfg.get('parar_ao_finalizar') or 0)
            except (TypeError, ValueError):
                n = 0
            lote = cfg.get('_lote_id')
            if n > 0 and lote:
                atual = lotes.get(lote)
                if atual is None or n < atual:
                    lotes[lote] = n
        # Lotes que ja sairam do registro (ex.: "Limpar" no meio) seguem na
        # contabilidade: a checagem nao depende de existir membro no painel.
        for lote, h in _lotes_hist.items():
            try:
                n = int(h.get('meta') or 0)
            except (TypeError, ValueError):
                n = 0
            if n > 0:
                atual = lotes.get(lote)
                if atual is None or n < atual:
                    lotes[lote] = n
        for lote, limite in lotes.items():
            membros = [(jid, p) for jid, p in _processos.items()
                       if (p.get('config') or {}).get('_lote_id') == lote]
            # Finalizados vem da contabilidade do lote (nao do registro atual):
            # "Limpar finalizados"/auto-limpeza nao zeram a contagem da meta.
            finalizados = len((_lotes_hist.get(lote) or {}).get('encerrados') or ())
            rodando = [jid for jid, p in membros
                       if p['status'] in ('rodando', 'erro_monitor')]
            if finalizados >= limite:
                # Marca DENTRO do lock (mesma secao que escolhe os jobs): fecha a
                # janela entre a selecao e o cancelamento para spawns em voo.
                if lote in _ondas_ativas or lote in _ondas_pendentes:
                    _ondas_canceladas.add(lote)
                a_parar.extend(rodando)
    for jid in a_parar:
        parar_job(jid)


# ======================== PERSISTENCIA DE JOBS ========================
JOBS_FILE = LOG_DIR / '_jobs.json'
LOTES_HIST_FILE = LOG_DIR / '_lotes_hist.json'


def _mtime_iso(log_file):
    """Data da ultima escrita do log (fim real do job) em ISO UTC, se existir."""
    try:
        return datetime.fromtimestamp(os.path.getmtime(log_file), tz=timezone.utc).isoformat()
    except (OSError, TypeError, ValueError):
        return None


def _pid_vivo(pid):
    """Verifica se um PID ainda existe (Windows: OpenProcess; POSIX: kill 0)."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == 'nt':
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _args_sem_token(args):
    """Copia dos args com o token da URL _ti mascarado (para o registro em disco)."""
    limpos = []
    for a in (args or []):
        s = str(a)
        limpos.append(re.sub(r'_ti=[^&\s]+', '_ti=<mascarado>', s) if '_ti=' in s else s)
    return limpos


def _metricas_do_log(log_file, limite=400):
    """Ultimas metricas lidas do log (para job sem monitor: roll/saldo/spins)."""
    metricas = {}
    if not log_file:
        return metricas
    try:
        with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
            linhas = f.readlines()[-limite:]
    except OSError:
        return metricas
    for linha in linhas:
        info = _parse_log_line(_limpar_ansi(linha))
        if info:
            metricas.update(info)
    return metricas


def _registrar_finalizacao_lote_locked(job_id, p):
    """Contabilidade do lote ao finalizar (exige _lock tomado).

    Imune ao "Limpar finalizados"/auto-limpeza: meta e teto continuam contando
    mesmo se o registro sair do painel. Guarda tambem o limite da meta, para a
    checagem nao depender de ainda existir membro do lote no registro.
    """
    lote_hist = (p.get('config') or {}).get('_lote_id')
    if not lote_hist:
        return
    h = _lotes_hist.setdefault(lote_hist, {'encerrados': set(), 'roll': 0.0, 'meta': 0})
    try:
        h['meta'] = max(int(h.get('meta') or 0),
                        int((p.get('config') or {}).get('parar_ao_finalizar') or 0))
    except (TypeError, ValueError):
        pass
    if job_id not in h['encerrados']:
        h['encerrados'].add(job_id)
        h['roll'] += float((p.get('metricas') or {}).get('roll') or 0)
    if len(_lotes_hist) > 500:
        # Descarta o lote mais antigo SEM membro e SEM onda (nunca um ativo).
        for lote_antigo in list(_lotes_hist):
            if lote_antigo == lote_hist:
                continue
            if lote_antigo in _ondas_ativas or lote_antigo in _ondas_pendentes:
                continue
            if any((q.get('config') or {}).get('_lote_id') == lote_antigo
                   for q in _processos.values()):
                continue
            del _lotes_hist[lote_antigo]
            break


def _salvar_registro():
    """Grava o estado dos jobs em disco (escrita atomica). Chamar FORA do _lock."""
    try:
        with _salvar_lock:
            with _lock:
                registros = []
                for jid, p in _processos.items():
                    registros.append({
                        'job_id': jid,
                        'casa': p.get('casa', ''),
                        'conta': p.get('conta', ''),
                        'host': p.get('host', ''),
                        'pid': p.get('pid'),
                        'config': p.get('config') or {},
                        # NUNCA gravar o token em disco: a URL _ti vai mascarada.
                        'args': _args_sem_token(p.get('args')),
                        'url_preview': p.get('url_preview', ''),
                        'log_file': p.get('log_file', ''),
                        'started_at': p.get('started_at'),
                        'status': p.get('status'),
                        'finalizado_em': p.get('finalizado_em'),
                    })
            # Contabilidade do lote PRIMEIRO: se cair no meio da gravacao, o
            # historico nunca fica mais velho que o registro de jobs.
            with _lock:
                hist = {lote: {'encerrados': sorted(h['encerrados']),
                               'roll': round(float(h.get('roll') or 0), 2),
                               'meta': int(h.get('meta') or 0)}
                        for lote, h in _lotes_hist.items()}
            tmp_hist = str(LOTES_HIST_FILE) + '.tmp'
            with open(tmp_hist, 'w', encoding='utf-8') as f:
                json.dump(hist, f, ensure_ascii=False, indent=1)
            os.replace(tmp_hist, str(LOTES_HIST_FILE))
            tmp = str(JOBS_FILE) + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(registros, f, ensure_ascii=False, indent=1)
            os.replace(tmp, str(JOBS_FILE))
    except (OSError, ValueError):
        pass


def _carregar_lotes_hist():
    """Restaura a contabilidade dos lotes do disco (chamado no boot)."""
    if not LOTES_HIST_FILE.exists():
        return
    try:
        dados = json.loads(LOTES_HIST_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return
    if not isinstance(dados, dict):
        return
    with _lock:
        for lote, h in dados.items():
            if not lote or not isinstance(h, dict):
                continue
            encerrados = h.get('encerrados') or []
            if not isinstance(encerrados, list):
                continue
            try:
                _lotes_hist[lote] = {
                    'encerrados': {str(j) for j in encerrados},
                    'roll': float(h.get('roll') or 0),
                    'meta': int(h.get('meta') or 0),
                }
            except (TypeError, ValueError):
                continue


def restaurar_jobs():
    """Reconstroi os jobs a partir do registro em disco (chamado na subida do servidor).

    - Job com PID vivo: volta como 'rodando' e o monitor RELÊ o log do comeco
      (reconstroi as linhas) continuando de onde parou.
    - Job com PID morto: volta como 'finalizado' com o relatorio lido do log.
    """
    if not JOBS_FILE.exists():
        return 0
    _carregar_lotes_hist()
    try:
        registros = json.loads(JOBS_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return 0
    if not isinstance(registros, list):
        return 0

    restaurados = 0
    for reg in registros:
        try:
            jid = str(reg.get('job_id') or '')
            if not jid or jid in _processos:
                continue
            pid = int(reg.get('pid') or 0)
            log_file = str(reg.get('log_file') or '')
            vivo = _pid_vivo(pid)
            with _lock:
                _processos[jid] = {
                    'casa': reg.get('casa', ''),
                    'conta': reg.get('conta', ''),
                    'host': reg.get('host', ''),
                    'pid': pid,
                    'status': (('parando' if reg.get('status') == 'parando' else 'rodando') if vivo else (
                        'parado_gracioso' if reg.get('status') == 'parado_gracioso'
                        else 'desconectada' if reg.get('status') == 'desconectada'
                        else 'parado_pelo_usuario' if reg.get('status') in ('parando', 'parado_pelo_usuario')
                        else 'finalizado'
                    )),
                    'config': reg.get('config') or {},
                    'url_preview': reg.get('url_preview', ''),
                    'args': reg.get('args') or [],
                    'log_file': log_file,
                    'started_at': reg.get('started_at'),
                    'atualizado_em': datetime.now(timezone.utc).isoformat(),
                    'finalizado_em': reg.get('finalizado_em') or (
                        (_mtime_iso(log_file) or datetime.now(timezone.utc).isoformat()) if not vivo else None
                    ),
                    'metricas': {},
                    'ultima_linha': '',
                    'log_lines': [],
                    'log_spins': [],
                    'returncode': None,
                }
            if log_file and os.path.exists(log_file):
                t = threading.Thread(
                    target=_monitor_thread_pid, args=(jid, pid, log_file), daemon=True
                )
                try:
                    t.start()
                    with _lock:
                        if jid in _processos:
                            _processos[jid]['thread'] = t
                except Exception:
                    # Sem monitor, o fechamento sincrono abaixo cobre o registro.
                    pass
            if vivo and reg.get('status') == 'parando':
                # Reinicio durante uma parada graciosa: reemite o pedido para
                # nao perder o escalonamento (sinal + watchdog de prazo).
                parar_job(jid)
            if not vivo:
                # Job terminou enquanto o servidor estava fora: registra agora
                # (metricas do log + contabilidade do lote + BI), sem depender
                # do monitor — "Limpar"/novo inicio nao perdem a contribuicao.
                metricas_log = _metricas_do_log(log_file)
                with _lock:
                    p = _processos.get(jid)
                    if p:
                        if metricas_log:
                            p['metricas'] = metricas_log
                        _registrar_finalizacao_lote_locked(jid, p)
                _registrar_historico(jid)
            restaurados += 1
        except Exception:
            continue
    return restaurados


# ======================== HISTORICO DE EXECUCOES ========================

def _db_historico():
    conn = sqlite3.connect(str(HISTORICO_DB), timeout=30)
    conn.execute("""CREATE TABLE IF NOT EXISTS execucoes (
        job_id TEXT PRIMARY KEY,
        casa TEXT, conta TEXT, started_at TEXT, finalizado_em TEXT,
        game TEXT, motivo TEXT, tempo_s REAL,
        saldo_inicial REAL, saldo_final REAL, lucro REAL, roll REAL,
        spins INTEGER, spins_pagos INTEGER, spins_nao_pagos INTEGER, respins INTEGER,
        premios REAL, bonus INTEGER, jogos INTEGER,
        modo TEXT, por_jogo TEXT, criado_em TEXT,
        fonte TEXT DEFAULT 'resumo')""")
    # Migracao leve: bancos criados antes da coluna `fonte`.
    try:
        colunas = [r[1] for r in conn.execute("PRAGMA table_info(execucoes)")]
        if 'fonte' not in colunas:
            conn.execute("ALTER TABLE execucoes ADD COLUMN fonte TEXT DEFAULT 'resumo'")
            conn.commit()
        if 'lote' not in colunas:
            conn.execute("ALTER TABLE execucoes ADD COLUMN lote TEXT")
            conn.commit()
    except sqlite3.Error:
        pass
    return conn


def _registrar_historico(job_id):
    """Grava a execucao no historico.

    Com o #RESUMO (T6) grava os numeros exatos; SEM ele (morte na forca,
    crash, caminho sem telemetria) grava uma linha PARCIAL com o que o painel
    conseguiu ler — nenhum job que passe pelo painel deixa de entrar.
    """
    with _lock:
        p = _processos.get(job_id)
        if not p:
            return False
        config = dict(p.get('config') or {})
        if config.get('dry_run'):
            # Modo Teste nao entra no BI: historico e das operacoes reais.
            return False
        dados = (p.get('metricas') or {}).get('resumo')
        metricas = dict(p.get('metricas') or {})
        status = str(p.get('status') or '')
        casa = p.get('casa', '')
        conta = p.get('conta', '')
        lote = str(config.get('_lote_id') or '')
        started_at = p.get('started_at')
        finalizado_em = p.get('finalizado_em')
    if isinstance(dados, dict):
        fonte = 'resumo'
    else:
        fonte = 'parcial'
        dados = {
            'saldo_inicial': None,
            'saldo_final': metricas.get('saldo'),
            'lucro': None,
            'roll': metricas.get('roll') or 0,
            'spins': metricas.get('spins') or 0,
            'spins_pagos': None, 'spins_nao_pagos': None, 'respins': None,
            'premios': metricas.get('ganho_jogo'),
            'bonus': None, 'jogos': None,
            'motivo': status or 'fim',
            'tempo_s': None,
            'modo': {'game': config.get('game') or ''},
            'por_jogo': [],
        }
    modo = dados.get('modo') or {}
    por_jogo = dados.get('por_jogo') or []
    game = str(modo.get('game') or '') if isinstance(modo, dict) else ''
    if not game:
        game = str(config.get('game') or '')
    if not game and por_jogo:
        game = str((por_jogo[0] or {}).get('nome') or '')
    if not game:
        game = '(varios)'
    conn = _db_historico()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO execucoes (job_id, casa, conta, started_at, finalizado_em, "
            "game, motivo, tempo_s, saldo_inicial, saldo_final, lucro, roll, spins, spins_pagos, "
            "spins_nao_pagos, respins, premios, bonus, jogos, modo, por_jogo, criado_em, fonte, lote) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, casa, conta, started_at, finalizado_em, game,
             str(dados.get('motivo') or ''), dados.get('tempo_s'),
             dados.get('saldo_inicial'), dados.get('saldo_final'), dados.get('lucro'),
             dados.get('roll'), dados.get('spins'), dados.get('spins_pagos'),
             dados.get('spins_nao_pagos'), dados.get('respins'), dados.get('premios'),
             dados.get('bonus'), dados.get('jogos'),
             json.dumps(modo, ensure_ascii=False), json.dumps(por_jogo, ensure_ascii=False),
             datetime.now(timezone.utc).isoformat(), fonte, lote))
        conn.commit()
    except sqlite3.Error:
        return False
    finally:
        conn.close()
    return True


def historico_resumo(casa=None, limite=100, dias=0):
    """Agregados do historico para o painel. `dias`>0 filtra pelo periodo."""
    conn = _db_historico()
    conn.row_factory = sqlite3.Row
    try:
        condicoes = []
        params = []
        if casa:
            condicoes.append("casa = ?")
            params.append(casa)
        if dias and int(dias) > 0:
            from datetime import timedelta
            cutoff = (datetime.now(timezone.utc) - timedelta(days=int(dias))).strftime('%Y-%m-%dT%H:%M:%S')
            condicoes.append("COALESCE(finalizado_em, started_at, '') >= ?")
            params.append(cutoff)
        filtro = ("WHERE " + " AND ".join(condicoes)) if condicoes else ""
        geral = conn.execute(
            "SELECT COUNT(*) AS execucoes, COALESCE(SUM(roll),0) AS roll, "
            "COALESCE(SUM(lucro),0) AS lucro, COALESCE(SUM(spins),0) AS spins, "
            "COALESCE(SUM(bonus),0) AS bonus FROM execucoes " + filtro, params).fetchone()
        por_jogo = conn.execute(
            "SELECT game, COUNT(*) AS execucoes, COALESCE(SUM(spins),0) AS spins, "
            "COALESCE(SUM(roll),0) AS roll, COALESCE(SUM(lucro),0) AS lucro, "
            "COALESCE(SUM(bonus),0) AS bonus FROM execucoes " + filtro +
            " GROUP BY game ORDER BY SUM(roll) DESC LIMIT 15", params).fetchall()
        por_conta = conn.execute(
            "SELECT casa, conta, COUNT(*) AS execucoes, COALESCE(SUM(roll),0) AS roll, "
            "COALESCE(SUM(lucro),0) AS lucro, COALESCE(SUM(bonus),0) AS bonus "
            "FROM execucoes " + filtro +
            " GROUP BY casa, conta ORDER BY SUM(roll) DESC LIMIT 200", params).fetchall()
        ultimas = conn.execute(
            "SELECT job_id, casa, conta, game, finalizado_em, roll, lucro, spins, bonus, motivo, fonte "
            "FROM execucoes " + filtro +
            " ORDER BY COALESCE(finalizado_em, started_at) DESC LIMIT ?",
            params + [int(limite or 100)]).fetchall()
        # 1) As 30 rodadas mais recentes (chave), sem cortar nenhuma pela metade.
        expr = ("COALESCE(NULLIF(lote,''), casa || char(31) || COALESCE(game,'') || char(31) "
                "|| substr(COALESCE(started_at,''),1,16))")
        chaves = [r[0] for r in conn.execute(
            "SELECT " + expr + " AS chave, MAX(COALESCE(finalizado_em, started_at)) AS ultimo "
            "FROM execucoes " + filtro + " GROUP BY chave ORDER BY ultimo DESC LIMIT 30", params)]
        rodadas_rows = []
        if chaves:
            marca = ','.join(['?' for _ in chaves])
            rodadas_rows = conn.execute(
                "SELECT casa, conta, game, lote, started_at, finalizado_em, roll, lucro, spins, bonus, motivo, fonte "
                "FROM execucoes " + (filtro + " AND " if filtro else "WHERE ") + expr + " IN (" + marca + ")",
                params + chaves).fetchall()
    finally:
        conn.close()

    # Rodadas: agrupa pelo lote (jobs novos). Sem lote (historico antigo), cai
    # no casa+jogo+minuto do INICIO — um lote lancado junto comeca no mesmo minuto.
    rodadas = {}
    for r in rodadas_rows:
        r = dict(r)
        quando = (r.get('started_at') or r.get('finalizado_em') or '')
        chave = r.get('lote') or '\x1f'.join([
            str(r.get('casa') or ''), str(r.get('game') or ''), quando[:16]])
        g = rodadas.get(chave)
        if g is None:
            g = rodadas[chave] = {
                'chave': chave, 'lote': r.get('lote') or '',
                'casa': r.get('casa') or '', 'game': r.get('game') or '',
                'casas': [], 'jogos': [],
                'inicio': r.get('started_at'), 'fim': r.get('finalizado_em'),
                'contas': 0, 'roll': 0.0, 'lucro': 0.0, 'spins': 0, 'bonus': 0,
                'detalhes': [],
            }
        g['contas'] += 1
        g['roll'] += float(r.get('roll') or 0)
        g['lucro'] += float(r.get('lucro') or 0)
        g['spins'] += int(r.get('spins') or 0)
        g['bonus'] += int(r.get('bonus') or 0)
        if r.get('casa') and r['casa'] not in g['casas']:
            g['casas'].append(r['casa'])
        if r.get('game') and r['game'] not in g['jogos']:
            g['jogos'].append(r['game'])
        if r.get('started_at') and (not g['inicio'] or r['started_at'] < g['inicio']):
            g['inicio'] = r['started_at']
        if r.get('finalizado_em') and (not g['fim'] or r['finalizado_em'] > g['fim']):
            g['fim'] = r['finalizado_em']
        g['detalhes'].append({
            'casa': r.get('casa') or '',
            'conta': r.get('conta'),
            'game': r.get('game') or '',
            'roll': round(float(r.get('roll') or 0), 2),
            'lucro': round(float(r.get('lucro') or 0), 2),
            'spins': int(r.get('spins') or 0),
            'motivo': r.get('motivo') or '',
            'fonte': r.get('fonte') or '',
        })
    lista_rodadas = sorted(rodadas.values(),
                           key=lambda g: g.get('fim') or g.get('inicio') or '', reverse=True)[:30]
    for g in lista_rodadas:
        g['roll'] = round(g['roll'], 2)
        g['lucro'] = round(g['lucro'], 2)
        # Lote com mais de uma casa/jogo mostra tudo (nao so a primeira linha).
        if len(g['casas']) > 1:
            g['casa'] = ' + '.join(g['casas'])
        if len(g['jogos']) > 1:
            g['game'] = ' + '.join(g['jogos'])
        elif g['jogos']:
            g['game'] = g['jogos'][0]
        g['detalhes'].sort(key=lambda d: (0, int(d['conta'])) if str(d.get('conta') or '').isdigit()
                           else (1, str(d.get('conta') or '')))

    def arred(d, chaves):
        return {k: (round(v, 2) if isinstance(v, (int, float)) else v) for k, v in d.items()}

    return {
        'geral': arred(dict(geral), ('roll', 'lucro')),
        'por_jogo': [arred(dict(r), ('roll', 'lucro')) for r in por_jogo],
        'por_conta': [arred(dict(r), ('roll', 'lucro')) for r in por_conta],
        'ultimas': [dict(r) for r in ultimas],
        'rodadas': lista_rodadas,
    }


# ======================== SAUDE DAS PROXIES ========================

def _parse_linha_proxy(linha):
    """'ip:porta:user:senha' -> 'http://user:senha@ip:porta' (mesmo formato do bot)."""
    linha = (linha or '').strip()
    if not linha:
        return ''
    parts = linha.split(':')
    if len(parts) == 4:
        return f"http://{parts[2]}:{parts[3]}@{parts[0]}:{parts[1]}"
    return f"http://{linha}"


def _resumir_saude(resultados):
    """Agrega resultados (linha, ok, ms) do teste de proxies (puro, sem rede)."""
    vivas = sorted(ms for _, ok, ms in resultados if ok)
    mortas = [linha for linha, ok, _ in resultados if not ok]
    return {
        'total': len(resultados),
        'vivas': len(vivas),
        'mortas': len(mortas),
        'ms_mediana': vivas[len(vivas) // 2] if vivas else None,
        'ms_p90': vivas[min(len(vivas) - 1, int(len(vivas) * 0.9))] if vivas else None,
        'mortas_lista': mortas[:50],
    }


def testar_proxies(amostra=None, workers=60, timeout=6):
    """Testa as proxies do jogo (GET leve por proxy) e salva o resultado em cache."""
    try:
        linhas = [l.strip() for l in
                  open(str(PROXIES_FILE), encoding='utf-8', errors='replace') if l.strip()]
    except OSError:
        linhas = []
    if not linhas:
        return {'erro': 'proxies_game.txt vazio ou ausente'}
    if amostra:
        linhas = random.sample(linhas, min(int(amostra), len(linhas)))

    def testa(linha):
        proxy = _parse_linha_proxy(linha)
        t0 = time.time()
        try:
            r = requests.get(PROXY_TESTE_URL, proxies={'http': proxy, 'https': proxy},
                             timeout=timeout, allow_redirects=False)
            ok = r.status_code in (200, 204)
        except Exception:
            ok = False
        return (linha, ok, int((time.time() - t0) * 1000))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        resultados = list(pool.map(testa, linhas))

    saida = _resumir_saude(resultados)
    saida['quando'] = datetime.now(timezone.utc).isoformat()
    saida['amostra'] = bool(amostra)
    # Score por proxy: vivas ordenadas pela latencia (o bot passa a preferir as
    # rapidas; mortas ficam fora). Só grava com amostra cheia e volume confiavel.
    vivas = sorted(((linha, ms) for linha, ok, ms in resultados if ok), key=lambda x: x[1])
    saida['por_proxy'] = [[linha, ms] for linha, ms in vivas[:200]]
    if not amostra and len(vivas) >= 50:
        try:
            PROXIES_SCORE.parent.mkdir(parents=True, exist_ok=True)
            PROXIES_SCORE.write_text(json.dumps({linha: ms for linha, ms in vivas}),
                                     encoding='utf-8')
            saida['score_gravado'] = len(vivas)
        except OSError:
            pass
    try:
        PROXIES_SAUDE.parent.mkdir(parents=True, exist_ok=True)
        PROXIES_SAUDE.write_text(json.dumps(saida, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass
    return saida


def proxies_saude():
    """Ultimo resultado salvo do teste de proxies."""
    try:
        return json.loads(PROXIES_SAUDE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def limpar_score_proxies():
    """Remove o score (o bot volta ao sorteio aleatorio normal)."""
    try:
        PROXIES_SCORE.unlink()
        return {'removido': True}
    except OSError:
        return {'removido': False}


def score_proxies_ativo():
    """Info do score atual (quantas proxies, a mais rapida e quando foi feito)."""
    try:
        dados = json.loads(PROXIES_SCORE.read_text(encoding='utf-8'))
        if isinstance(dados, dict) and dados:
            ms = sorted(int(v) for v in dados.values())
            quando = datetime.fromtimestamp(PROXIES_SCORE.stat().st_mtime, timezone.utc).isoformat()
            idade_h = (datetime.now(timezone.utc)
                       - datetime.fromtimestamp(PROXIES_SCORE.stat().st_mtime, timezone.utc)
                       ).total_seconds() / 3600
            return {'ativo': True, 'total': len(dados), 'ms_melhor': ms[0], 'ms_pior': ms[-1],
                    'quando': quando, 'idade_h': round(idade_h, 1),
                    'vence': idade_h > 72}
    except (OSError, ValueError):
        pass
    return {'ativo': False}


def arquivar_logs_antigos(dias=30):
    """Move logs de jobs antigos para logs/autospin/arquivo/AAAA-MM/ (nunca apaga).

    Protege logs de jobs ainda na memoria (rodando ou restaurados)."""
    limite = time.time() - max(1, int(dias)) * 86400
    with _lock:
        ativos = {os.path.abspath(p.get('log_file') or '') for p in _processos.values()}
    movidos = 0
    for arq in LOG_DIR.glob('*.log'):
        try:
            mtime = arq.stat().st_mtime
            if mtime >= limite:
                continue
            if os.path.abspath(str(arq)) in ativos:
                continue
            destino_dir = LOG_DIR / 'arquivo' / datetime.fromtimestamp(mtime).strftime('%Y-%m')
            destino_dir.mkdir(parents=True, exist_ok=True)
            destino = destino_dir / arq.name
            if destino.exists():
                destino = destino_dir / (arq.stem + '_' + str(int(mtime)) + '.log')
            os.replace(str(arq), str(destino))
            movidos += 1
        except OSError:
            continue
    return movidos


def limpar_historico():
    """Limpa o historico de execucoes (botao manual do painel).

    Remove as linhas da tabela `execucoes` e MOVE os logs em disco para
    logs/autospin/arquivo/limpeza-<data>/ — os arquivos NAO sao apagados
    (historico em arquivo preservado); logs de jobs ativos ficam protegidos.
    """
    removidos = 0
    conn = _db_historico()
    try:
        cur = conn.execute("DELETE FROM execucoes")
        removidos = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        conn.commit()
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    with _lock:
        ativos = {os.path.abspath(p.get('log_file') or '') for p in _processos.values()}
    destino_dir = LOG_DIR / 'arquivo' / ('limpeza-' + datetime.now().strftime('%Y%m%d-%H%M'))
    movidos = 0
    for arq in LOG_DIR.glob('*.log'):
        try:
            if os.path.abspath(str(arq)) in ativos:
                continue
            destino_dir.mkdir(parents=True, exist_ok=True)
            destino = destino_dir / arq.name
            if destino.exists():
                destino = destino_dir / (arq.stem + '_' + str(int(arq.stat().st_mtime)) + '.log')
            os.replace(str(arq), str(destino))
            movidos += 1
        except OSError:
            continue
    return {'removidos': removidos, 'logs_arquivados': movidos}


def _env_auto_spin(config):
    """Ambiente do subprocesso: log sem buffer + sonos por modo + stealth.

    Modo Rapido/Turbo reduzem tambem os sonos de respin e entre jogos (T2);
    sem os modos, o bot mantem os defaults de producao.
    """
    env = os.environ.copy()
    env['PYTHONUNBUFFERED'] = '1'
    env['PYTHONIOENCODING'] = 'utf-8'
    # T6: telemetria JSON no fim de cada job (o motor le sem regex).
    env['FLASHROLL_RESUMO'] = '1'
    # Modo Rapido: giros 0.15-0.3 · respins 0.5-0.8 · jogos 2-3
    if config.get('modo_rapido'):
        env['AUTO_SPIN_SLEEP_MIN'] = '0.15'
        env['AUTO_SPIN_SLEEP_MAX'] = '0.3'
        env['AUTO_SPIN_SLEEP_RESPIN_MIN'] = '0.5'
        env['AUTO_SPIN_SLEEP_RESPIN_MAX'] = '0.8'
        env['AUTO_SPIN_SLEEP_JOGOS_MIN'] = '2'
        env['AUTO_SPIN_SLEEP_JOGOS_MAX'] = '3'
    # Turbo: giros 0.05-0.15 · respins 0.3-0.5 · jogos 1-2
    if config.get('turbo'):
        env['AUTO_SPIN_SLEEP_MIN'] = '0.05'
        env['AUTO_SPIN_SLEEP_MAX'] = '0.15'
        env['AUTO_SPIN_SLEEP_RESPIN_MIN'] = '0.3'
        env['AUTO_SPIN_SLEEP_RESPIN_MAX'] = '0.5'
        env['AUTO_SPIN_SLEEP_JOGOS_MIN'] = '1'
        env['AUTO_SPIN_SLEEP_JOGOS_MAX'] = '2'
    # Stealth: transporte com impersonacao de TLS de navegador real (curl_cffi)
    if config.get('stealth'):
        env['AUTOSPIN_TRANSPORTE'] = 'cffi'
        env['AUTOSPIN_IMPERSONATE'] = str(config.get('stealth_impersonate') or 'chrome142')
    return env


def _tem_console():
    """True quando o servidor esta preso a um console (permite CTRL_BREAK no filho)."""
    if os.name != 'nt':
        return False
    try:
        import ctypes
        return bool(ctypes.windll.kernel32.GetConsoleWindow())
    except Exception:
        return False


def _creationflags_auto_spin():
    """Flags do subprocesso no Windows.

    CREATE_NEW_PROCESS_GROUP: da um grupo proprio ao filho, necessario para
    entregar CTRL_BREAK_EVENT (parada graciosa do auto_spin.py). Sem console no
    servidor o sinal nao pode ser entregue; nesse caso mantem CREATE_NO_WINDOW
    (sem janela piscando) e a parada degrada para o termino seco de antes.
    """
    if os.name != 'nt':
        return 0
    flags = subprocess.CREATE_NEW_PROCESS_GROUP
    if not _tem_console():
        flags |= subprocess.CREATE_NO_WINDOW
    return flags


def _preparar_job_conta_locked(casa, conta):
    """Uma caixa por conta (T8) — exige o _lock já tomado.

    Antes de iniciar um job para casa+conta:
    - se já existe job RODANDO/parando nessa conta, devolve 'ja_rodando' (não
      duplica: dois bots na mesma conta cruzariam rodadas);
    - senão, remove os jobs antigos da mesma conta (auto-limpeza da caixa, sem
      precisar do botão) — o arquivo de log em disco permanece como histórico.

    Devolve None quando pode iniciar. Usada pelo _spawn_job para conferir +
    reservar a conta de forma ATÔMICA (sem brecha entre a conferência e o
    início do processo).
    """
    antigos = [jid for jid, p in _processos.items()
               if p.get('casa') == casa and p.get('conta') == conta]
    if any(_processos[jid].get('status') in ('rodando', 'parando', 'erro_monitor') for jid in antigos):
        return 'ja_rodando'
    for jid in antigos:
        del _processos[jid]
        _pedidos_parada.pop(jid, None)
    return None


def _spawn_job(sessao, config_global, seq_ref=None):
    """Sobe UM job (guarda T8 + subprocesso + monitor). Devolve (job_id, motivo_pulado).

    seq_ref: sequencia de "Parar Tudo" do LOTE que pediu este spawn. Se mudou,
    o job nasce parando (fecha a janela entre o check do chamador e o spawn).
    """
    chave = f"{sessao['casa']}|{sessao['conta']}"
    with _lock:
        motivo = _preparar_job_conta_locked(sessao['casa'], sessao['conta'])
        if motivo:
            return None, motivo
        # Reserva atômica: outra chamada simultânea para a mesma conta é pulada
        # (sem isso, duas chamadas passavam juntas pela conferência e subiam
        # dois processos com o MESMO job_id — um sobrescrevia o outro no painel).
        if chave in _contas_iniciando:
            return None, 'ja_rodando'
        _contas_iniciando.add(chave)
        # job_id único: reservado sob lock (fecha a colisão entre pares distintos
        # que geram a mesma string, ex.: casa 'a_b'/conta 'c' x casa 'a'/conta 'b_c').
        base = f"{sessao['casa']}_{sessao['conta']}_{int(time.time())}"
        job_id = base
        n = 2
        while job_id in _processos or job_id in _ids_reservados:
            job_id = f"{base}-{n}"
            n += 1
        _ids_reservados.add(job_id)
        seq_antes = _parada_geral_seq if seq_ref is None else seq_ref
        lote = config_global.get('_lote_id') or ''
        # Checagem pre-Popen: se o lote ja foi cancelado (Parar Tudo, meta ou
        # teto) nem sobe processo — evita "nascer para morrer".
        if _parada_geral_seq != seq_antes or (lote and lote in _ondas_canceladas):
            _contas_iniciando.discard(chave)
            _ids_reservados.discard(job_id)
            return None, 'cancelado_por_parada'

    try:
        if config_global.get('dry_run'):
            # Modo Teste: bot falso, sem rede/contas — exercita o pipeline inteiro.
            args = ['python', '-u', str(DIR / 'autospin' / 'dry_run_bot.py'),
                    '--game', str(config_global.get('game') or 'Jogo Teste'),
                    '--set-spins', str(int(config_global.get('set_spins') or 0) or 20)]
        else:
            url = montar_url_ti(sessao['session_key'], sessao['host'])
            args = montar_args_auto_spin(url, config_global)
        log_file = LOG_DIR / f"{job_id}.log"

        # Ambiente do processo (log em tempo real + sonos por modo + stealth)
        env = _env_auto_spin(config_global)
        with open(log_file, 'w', encoding='utf-8') as lf:
            proc = subprocess.Popen(
                args,
                stdout=lf,
                stderr=subprocess.STDOUT,
                cwd=str(DIR / 'autospin'),
                env=env,
                creationflags=_creationflags_auto_spin(),
            )
    except Exception:
        with _lock:
            _contas_iniciando.discard(chave)
            _ids_reservados.discard(job_id)
        raise

    parar_ao_registrar = False
    with _lock:
        _contas_iniciando.discard(chave)
        _ids_reservados.discard(job_id)
        # "Parar Tudo" ou cancelamento do lote (meta/teto) durante o Popen:
        # o job entra e recebe a parada na hora.
        parar_ao_registrar = (_parada_geral_seq != seq_antes) or (lote and lote in _ondas_canceladas)
        _processos[job_id] = {
            'casa': sessao['casa'],
            'conta': sessao['conta'],
            'host': sessao['host'],
            'pid': proc.pid,
            'status': 'rodando',
            'config': config_global.copy(),
            'url_preview': (sessao['host'] + '/?_ti=<mascarado>') if not config_global.get('dry_run') else '(dry-run)',
            'args': args,
            'log_file': str(log_file),
            'started_at': datetime.now(timezone.utc).isoformat(),
            'atualizado_em': datetime.now(timezone.utc).isoformat(),
            'finalizado_em': None,
            'metricas': {},
            'ultima_linha': '',
            'log_lines': [],
            'log_spins': [],
            'returncode': None,
        }

    # Thread de monitoramento
    t = threading.Thread(
        target=_monitor_thread,
        args=(job_id, proc, log_file),
        daemon=True,
    )
    try:
        t.start()
        with _lock:
            _processos[job_id]['thread'] = t
    except Exception:
        # Sem monitor o job nao receberia atualizacoes; marca para o usuario ver.
        with _lock:
            _processos[job_id]['status'] = 'erro_monitor'
    if parar_ao_registrar:
        # "Parar Tudo" aconteceu enquanto este job subia: para agora (o pedido
        # de parada de antes nao alcancava um job que ainda nao existia).
        parar_job(job_id)
    return job_id, None


def _spawn_em_ondas(tarefas, config_global, intervalo, seq_ref=None):
    """Lança o restante do lote em ondas (evita o rate-limit 'muito frequente').

    tarefas: lista de (sessao, config) — o mix de jogos usa config por conta.
    Respeita cancelamento: "Parar Tudo", o teto de roll e o "parar apos N contas"
    marcam o lote em _ondas_canceladas e as contas restantes NAO sao lancadas.
    seq_ref vem do lancamento original (iniciar_jobs): qualquer "Parar Tudo"
    desde entao cancela o restante, mesmo se aconteceu antes desta thread subir.
    """
    lote = config_global.get('_lote_id') or ''
    with _lock:
        _ondas_pendentes.discard(lote)
        _ondas_ativas.add(lote)
        if seq_ref is None:
            seq_ref = _parada_geral_seq
    try:
        for sessao, cfg in tarefas:
            time.sleep(max(1.0, float(intervalo)))
            with _lock:
                cancelado = (lote in _ondas_canceladas) or (_parada_geral_seq != seq_ref)
            if cancelado:
                print(f'[ondas] lote {lote}: cancelado — contas restantes nao serao lancadas')
                return
            try:
                job_id, _motivo = _spawn_job(sessao, cfg, seq_ref=seq_ref)
                if job_id:
                    _salvar_registro()
            except Exception:
                continue
    finally:
        with _lock:
            _ondas_ativas.discard(lote)
            _ondas_canceladas.discard(lote)


def _cancelar_ondas(lote_id=None):
    """Cancela as contas ainda por lancar (todas ou de um lote)."""
    with _lock:
        if lote_id:
            if lote_id in _ondas_ativas or lote_id in _ondas_pendentes:
                _ondas_canceladas.add(lote_id)
        else:
            _ondas_canceladas.update(_ondas_ativas)
            _ondas_canceladas.update(_ondas_pendentes)


def iniciar_jobs(config_global, casas=None, contas=None, ativas=True, pares=None, grupos=None):
    """
    Inicia os bots para cada conta com sessão.

    config_global: dict com chaves como game, bet_max, max_spin, auto_roll, etc.
    casas: lista de casas para filtrar (None = todas)
    contas: lista de contas para filtrar (None = todas)
    pares: lista de {'casa', 'conta'} — seleção exata do painel (tem prioridade;
           evita o produto cruzado casas x contas)
    grupos: lista de {'game', 'provedor', 'bet_max', 'set_spins', 'max_roll'} —
           "dividir em jogos (mix)": as contas são divididas por igual entre os
           jogos (a sobra vai para grupos aleatórios) e cada grupo roda com a sua
           config; tudo no MESMO lote (uma rodada só no histórico).

    Retorna (job_ids, pulados). Com `onda_tamanho` > 0, a primeira onda sobe agora
    e o restante em thread (aparece no painel conforme sobe). `dry_run` dispensa
    sessão real e usa um bot falso local.
    """
    global _lote_seq
    # Sequencia capturada JA na entrada: qualquer "Parar Tudo" a partir do
    # pedido (inclusive durante a leitura das sessoes) cancela este lote.
    with _lock:
        seq_lote = _parada_geral_seq
    if config_global.get('dry_run'):
        sessoes = [{'casa': 'dry-run', 'conta': str(c), 'host': 'dry.local',
                    'session_key': 'x' * 40} for c in (contas or [])]
        if not sessoes:
            sessoes = [{'casa': 'dry-run', 'conta': 'teste', 'host': 'dry.local',
                        'session_key': 'x' * 40}]
    else:
        sessoes = _get_sessoes(casas=casas, contas=contas, ativas=ativas, pares=pares)
        if not sessoes:
            return [], []

    # Lancamento em ondas (opcional): evita 'muito frequente' em lotes grandes.
    try:
        onda = max(0, int(config_global.get('onda_tamanho') or 0))
    except (TypeError, ValueError):
        onda = 0
    try:
        intervalo = float(config_global.get('onda_intervalo') or 10)
    except (TypeError, ValueError):
        intervalo = 10.0

    # Lote: identifica os jobs desta chamada (agrupamento no historico, 'parar
    # apos N contas', teto global de roll e cancelamento das ondas). TODO
    # lancamento ganha id — assim o historico agrupa a rodada mesmo sem meta/teto.
    try:
        teto_lote = float(config_global.get('roll_teto_lote') or 0)
    except (TypeError, ValueError):
        teto_lote = 0
    config_global = dict(config_global)
    with _lock:
        _lote_seq += 1
        seq_lote_n = _lote_seq
    config_global['_lote_id'] = f"lote_{int(time.time() * 1000)}_{seq_lote_n}"
    lote_id = config_global.get('_lote_id') or ''

    # Tarefas (sessao, config): sem mix = config global para todas; com mix as
    # contas sao divididas por igual entre os jogos (sobra aleatoria).
    grupos_ok = [g for g in (grupos or [])
                 if isinstance(g, dict) and str(g.get('game') or '').strip()][:4]
    if len(grupos_ok) >= 2:
        random.shuffle(sessoes)
        base = len(sessoes) // len(grupos_ok)
        resto = len(sessoes) % len(grupos_ok)
        extras = set(random.sample(range(len(grupos_ok)), resto)) if resto else set()
        tarefas = []
        contagem = []
        pos = 0
        for i, g in enumerate(grupos_ok):
            qtd = base + (1 if i in extras else 0)
            cfg = dict(config_global)
            cfg['game'] = str(g.get('game') or '').strip()
            cfg['mix'] = len(grupos_ok)
            try:
                cfg['provedor'] = int(g.get('provedor') or cfg.get('provedor') or 200)
            except (TypeError, ValueError):
                pass
            for chave, cast in (('bet_max', float), ('max_roll', float), ('set_spins', int)):
                valor = g.get(chave)
                if valor is None or valor == '':
                    continue
                try:
                    cfg[chave] = cast(valor)
                except (TypeError, ValueError):
                    pass
            contagem.append(f"{cfg['game']} ({qtd})")
            for sessao in sessoes[pos:pos + qtd]:
                tarefas.append((sessao, cfg))
            pos += qtd
        print('[iniciar] mix ativo: ' + ' · '.join(contagem))
    else:
        tarefas = [(sessao, config_global) for sessao in sessoes]

    job_ids = []
    pulados = []
    imediatas = tarefas if onda <= 0 else tarefas[:onda]
    restantes = [] if onda <= 0 else tarefas[onda:]
    if lote_id:
        with _lock:
            # Registra ANTES de qualquer spawn: meta/teto/parada que disparar
            # durante o lote imediato ja encontra o lote para cancelar (com ou
            # sem ondas restantes).
            _ondas_pendentes.add(lote_id)
    try:
        for sessao, cfg in imediatas:
            with _lock:
                cancelado = (_parada_geral_seq != seq_lote) or (lote_id and lote_id in _ondas_canceladas)
            if cancelado:
                # "Parar Tudo", meta ou teto durante o proprio lancamento: nao sobe o resto.
                pulados.append({'casa': sessao['casa'], 'conta': sessao['conta'],
                                'motivo': 'cancelado_por_parada'})
                continue
            job_id, motivo = _spawn_job(sessao, cfg, seq_ref=seq_lote)
            if motivo:
                pulados.append({'casa': sessao['casa'], 'conta': sessao['conta'], 'motivo': motivo})
            elif job_id:
                job_ids.append(job_id)
                # Salva a cada spawn (como as ondas): se o servidor cair no meio
                # do lote, as contas ja iniciadas ficam registradas.
                _salvar_registro()
    except Exception:
        if lote_id:
            with _lock:
                _ondas_pendentes.discard(lote_id)
                _ondas_canceladas.discard(lote_id)
        raise
    finally:
        # Persiste mesmo se um spawn do meio do lote falhar (senao um job que
        # subiu ficaria fora do registro e o boot nao o recuperaria).
        _salvar_registro()
    if not restantes and lote_id:
        with _lock:
            # Sem ondas: nada mais usa o lote depois do lote imediato.
            _ondas_pendentes.discard(lote_id)
            _ondas_canceladas.discard(lote_id)
    if restantes:
        try:
            threading.Thread(
                target=_spawn_em_ondas, args=(restantes, dict(config_global), intervalo, seq_lote),
                daemon=True, name='ondas-autospin',
            ).start()
        except Exception:
            # Sem thread nao ha quem limpe o pendente (e as ondas nao vao subir).
            if lote_id:
                with _lock:
                    _ondas_pendentes.discard(lote_id)
                    _ondas_canceladas.discard(lote_id)
            raise

    return job_ids, pulados


def verificar_jobs_travados(limite_min=30):
    """Para jobs RODANDO cujo log não avança há muito tempo (bot pendurado).

    Caso real: o bot imprime o relatório final e fica preso sem sair — sem este
    detector o job ficava "rodando" para sempre no painel, com processo vivo.
    """
    agora = datetime.now(timezone.utc)
    a_parar = []
    with _lock:
        for jid, p in _processos.items():
            if p.get('status') != 'rodando':
                continue
            ref = p.get('ultimo_log_em') or p.get('atualizado_em') or p.get('started_at')
            try:
                quando = datetime.fromisoformat(str(ref))
            except (TypeError, ValueError):
                continue
            if quando.tzinfo is None:
                quando = quando.replace(tzinfo=timezone.utc)
            minutos = (agora - quando).total_seconds() / 60
            if minutos >= limite_min:
                p['alerta'] = 'sem log há %.0f min — parada automática' % minutos
                a_parar.append(jid)
    for jid in a_parar:
        print(f'[travado] {jid}: sem log ha mais de {limite_min:.0f} min — parando')
        parar_job(jid)
    return len(a_parar)


def status_job(job_id):
    """Retorna estado de um job."""
    with _lock:
        p = _processos.get(job_id)
        if not p:
            return None
        # Copia sem log completo E sem 'args' (o args carrega a URL _ti com token).
        copia = {k: v for k, v in p.items()
                 if k not in ('log_lines', 'log_spins', 'thread', 'args')}
        copia['log_lines_recent'] = p['log_lines'][-8:]
        copia['log_spins_recent'] = p['log_spins'][-8:]
        copia['total_lines'] = len(p['log_lines'])
        return copia


def log_job(job_id, tail=400):
    """Log guardado em memoria do job (para o 'carregar mais' do card expandido).

    O /status manda so as ultimas linhas (payload leve para 60 jobs); esta rota
    entrega o historico maior sob demanda (janela do monitor: ate 400 linhas).
    """
    with _lock:
        p = _processos.get(job_id)
        if not p:
            return None
        try:
            n = max(10, min(int(tail or 400), 400))
        except (TypeError, ValueError):
            n = 400
        return {
            'job_id': job_id,
            'spins': p['log_spins'][-n:],
            'lines': p['log_lines'][-n:],
            'total_lines': len(p['log_lines']),
            'atualizado_em': p.get('atualizado_em'),
        }


def todos_status():
    """Retorna estado de todos os jobs (janelas enxutas; sem 'args' com token).

    Com muitos jobs a janela de log encolhe (4 linhas em vez de 8): o payload do
    /status e o trabalho do servidor caem, sem perder o essencial do painel.
    """
    with _lock:
        recentes = 4 if len(_processos) > 25 else 8
        result = {}
        for jid, p in _processos.items():
            copia = {k: v for k, v in p.items()
                     if k not in ('log_lines', 'log_spins', 'thread', 'args')}
            copia['log_lines_recent'] = p['log_lines'][-recentes:]
            copia['log_spins_recent'] = p['log_spins'][-recentes:]
            copia['total_lines'] = len(p['log_lines'])
            result[jid] = copia
        return result


def _job_em_parada(job_id):
    """True enquanto o job existir e estiver no estado 'parando'."""
    with _lock:
        p = _processos.get(job_id)
        return bool(p) and p.get('status') == 'parando'


def _enviar_sinal_parada(job_id, pid):
    """Entrega o pedido de parada ao grupo do filho.

    PG (auto_spin.py) tem handler de SIGBREAK: conclui a rodada aberta, faz o
    logout e imprime o relatorio. O segundo pedido e lido como "nao espere a
    rodada". WG (auto_spin_wg.py) nao tem handler: mantem o termino seco.
    Sem console no servidor o CTRL_BREAK falha (OSError) e cai no SIGTERM.
    """
    if not pid:
        return 'sem_pid'
    with _lock:
        p = _processos.get(job_id)
        args = (p.get('args') if p else None) or []
    eh_wg = any('auto_spin_wg' in str(a) for a in args)
    # Sem console o CTRL_BREAK vira no-op silencioso (nao levanta erro) — so
    # tenta quando o servidor tem console, senao vai direto ao termino seco.
    if os.name == 'nt' and not eh_wg and _tem_console():
        try:
            os.kill(pid, signal.CTRL_BREAK_EVENT)
            return 'ctrl_break'
        except (OSError, ValueError):
            pass
    try:
        os.kill(pid, signal.SIGTERM)
        return 'sigterm'
    except (OSError, ProcessLookupError):
        return 'morto'


def _watchdog_parada(job_id, pid):
    """Escalona a parada mesmo com o filho em silencio.

    1o prazo: se ainda nao saiu, repete o pedido (o bot nao espera mais a rodada
    fechar). 2o prazo: encerra na forca. Roda em thread propria porque o prazo
    nao pode depender de linhas novas no log (o bot fica calado ao finalizar).
    """
    limite = time.time() + PRAZO_PARADA_GRACIOSA
    while time.time() < limite:
        if not _job_em_parada(job_id):
            return
        time.sleep(0.5)
    if not _job_em_parada(job_id):
        return
    with _lock:
        _pedidos_parada[job_id] = max(_pedidos_parada.get(job_id, 1), 2)
    _enviar_sinal_parada(job_id, pid)
    limite = time.time() + PRAZO_PARADA_IMEDIATA
    while time.time() < limite:
        if not _job_em_parada(job_id):
            return
        time.sleep(0.5)
    if _job_em_parada(job_id):
        try:
            os.kill(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass
        # Sem monitor (erro_monitor) ninguem fecha o registro: encerra aqui,
        # alimentando a contabilidade do lote (meta/teto) como o monitor faria.
        metricas_log = None
        with _lock:
            p = _processos.get(job_id)
            precisa = bool(p) and not p.get('thread') and p.get('status') == 'parando' and not p.get('metricas')
            log_file = p.get('log_file') if p else None
        if precisa:
            # Le o roll/saldo/spins direto do log (o monitor nunca rodou).
            metricas_log = _metricas_do_log(log_file)
        checar_meta = False
        with _lock:
            p = _processos.get(job_id)
            if p and not p.get('thread') and p.get('status') == 'parando':
                if metricas_log and not p.get('metricas'):
                    p['metricas'] = metricas_log
                p['status'] = 'finalizado'
                p['finalizado_em'] = datetime.now(timezone.utc).isoformat()
                _registrar_finalizacao_lote_locked(job_id, p)
                checar_meta = True
        if checar_meta:
            _salvar_registro()
            _registrar_historico(job_id)
            _checar_parada_por_meta()
            _checar_teto_roll(job_id)


def parar_job(job_id):
    """Pede a parada de um job.

    PG: parada graciosa (conclui a rodada e faz o logout). Novo pedido para o
    MESMO job escala: repete o sinal na hora (nao espera a rodada). O watchdog
    garante os prazos mesmo se o bot ficar em silencio.
    """
    with _lock:
        p = _processos.get(job_id)
        if not p:
            return False
        if p.get('status') not in ('rodando', 'parando', 'erro_monitor'):
            return False  # ja terminou; nada a parar
        pid = p.get('pid')
        p['status'] = 'parando'
        if not p.get('parada_solicitada_em'):
            p['parada_solicitada_em'] = datetime.now(timezone.utc).isoformat()
        nivel = _pedidos_parada.get(job_id, 0) + 1
        _pedidos_parada[job_id] = nivel
    _enviar_sinal_parada(job_id, pid)
    if nivel == 1:
        try:
            threading.Thread(
                target=_watchdog_parada, args=(job_id, pid), daemon=True,
                name=f'watchdog-parada-{job_id}',
            ).start()
        except Exception:
            # Sem watchdog o sinal ja foi enviado; nao deixa isso derrubar
            # parar_todos (os proximos jobs precisam receber o pedido).
            pass
    _salvar_registro()
    return True


def parar_todos():
    """Para todos os jobs rodando e cancela contas ainda em ondas."""
    global _parada_geral_seq
    _cancelar_ondas()
    with _lock:
        _parada_geral_seq += 1
        jids = list(_processos.keys())
    results = {}
    for jid in jids:
        results[jid] = parar_job(jid)
    return results


def limpar_finalizados():
    """Remove da memoria os jobs finalizados, com erro, desconectados ou parados."""
    with _lock:
        jids_to_remove = [
            jid for jid, p in _processos.items()
            if p['status'] == 'finalizado'
            or (p['status'].startswith('erro') and p['status'] != 'erro_monitor')
            or p['status'] in ('parado_pelo_usuario', 'parado_gracioso', 'desconectada')
        ]
        for jid in jids_to_remove:
            del _processos[jid]
            _pedidos_parada.pop(jid, None)
        n = len(jids_to_remove)
        # Contabilidade de lote so vive enquanto houver membro (ou onda) do lote.
        lotes_restantes = {(q.get('config') or {}).get('_lote_id')
                           for q in _processos.values()}
        for lote_hist in list(_lotes_hist):
            if (lote_hist not in lotes_restantes
                    and lote_hist not in _ondas_ativas
                    and lote_hist not in _ondas_pendentes):
                del _lotes_hist[lote_hist]
    _salvar_registro()
    return n


def resumo_execucao():
    """Resumo geral de todos os jobs."""
    status = todos_status()
    total = len(status)
    rodando = sum(1 for p in status.values() if p['status'] == 'rodando')
    finalizados = sum(1 for p in status.values() if p['status'] == 'finalizado')
    erros = sum(1 for p in status.values()
                if p['status'].startswith('erro') or p['status'] == 'desconectada')
    parados = sum(
        1 for p in status.values()
        if p['status'] in ('parado_pelo_usuario', 'parado_gracioso')
    )
    desconectadas = sum(1 for p in status.values() if p['status'] == 'desconectada')

    roll_total = sum(p.get('metricas', {}).get('roll', 0) for p in status.values())
    spins_total = sum(p.get('metricas', {}).get('spins', 0) for p in status.values())

    return {
        'total_jobs': total,
        'rodando': rodando,
        'finalizados': finalizados,
        'erros': erros,
        'parados': parados,
        'desconectadas': desconectadas,
        'roll_total': round(roll_total, 2),
        'spins_total': spins_total,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }


def contas_com_sessao(casas=None, ativas=True):
    """Lista contas com sessão disponível para o frontend."""
    sessoes = _get_sessoes(casas=casas, ativas=ativas)
    return [
        {
            'casa': s['casa'],
            'conta': s['conta'],
            'host': s['host'],
            'session_key_preview': s['session_key'][:10] + '...',
        }
        for s in sessoes
    ]


# ======================== CATALOGOS DE JOGOS POR PROVEDOR ========================
PROVEDORES = {
    13: 'WG', 32: 'REDTIGER', 118: 'DRAGOON SOFT', 200: 'PG', 301: 'PP',
    302: 'TADA', 307: 'CP', 310: 'JDB', 313: 'MG', 316: 'CQ9', 320: 'NETENT',
    362: 'JOKER', 369: 'FC', 396: 'EVOPLAY',
}
PROVEDOR_GIRAVEL = 200  # so PG e giravel pelo bot (protocolo proprio)
CACHE_JOGOS = DIR / 'autospin' / 'cache'


def listar_catalogos():
    """Lista os catalogos em cache por provedor (usa o arquivo mais recente de cada pid)."""
    catalogos = {}
    if not CACHE_JOGOS.exists():
        return []
    for arq in CACHE_JOGOS.glob('*_p*_jogos.json'):
        m = re.match(r'(.+)_p(\d+)_jogos\.json$', arq.name)
        if not m:
            continue
        sitecode, pid = m.group(1), int(m.group(2))
        try:
            dados = json.loads(arq.read_text(encoding='utf-8', errors='replace'))
            lista = dados.get('data', {}).get('g1', [])
        except (OSError, ValueError):
            continue
        try:
            mtime = arq.stat().st_mtime
        except OSError:
            continue
        atual = catalogos.get(pid)
        if not atual or mtime > atual['mtime']:
            catalogos[pid] = {
                'pid': pid,
                'provedor': PROVEDORES.get(pid, f'PID {pid}'),
                'sitecode': sitecode,
                'total': len(lista),
                'arquivo': str(arq),
                'mtime': mtime,
                'giravel': pid == PROVEDOR_GIRAVEL,
            }
    return sorted(catalogos.values(), key=lambda c: (not c['giravel'], c['provedor']))


def jogos_catalogo(pid=None):
    """Jogos (nome + id) de um provedor; sem pid, usa o giravel (PG)."""
    if pid is None:
        pid = PROVEDOR_GIRAVEL
    catalogos = listar_catalogos()
    alvo = next((c for c in catalogos if c['pid'] == pid), None)
    if not alvo:
        return []
    try:
        dados = json.loads(Path(alvo['arquivo']).read_text(encoding='utf-8', errors='replace'))
        lista = dados.get('data', {}).get('g1', [])
    except (OSError, ValueError):
        return []
    jogos = []
    for j in lista:
        if isinstance(j, dict):
            nome = j.get('g1') or j.get('name')
            if nome:
                jogos.append({'nome': str(nome), 'id': j.get('g0')})
        elif isinstance(j, str):
            jogos.append({'nome': j, 'id': None})
    return sorted(jogos, key=lambda j: j['nome'].lower())


def _normalizar_nome(nome):
    return ''.join(c for c in str(nome or '').lower() if c.isalnum())


def buscar_jogo(nome):
    """Procura um nome em TODOS os catalogos. Exato primeiro; parcial se nao houver exato.

    Retorna lista de dicts {provedor, pid, nome, giravel} ordenada com os giraveis primeiro.
    """
    alvo = _normalizar_nome(nome)
    if len(alvo) < 2:
        return []
    exatos = []
    parciais = []
    for cat in listar_catalogos():
        giravel = cat['pid'] in (PROVEDOR_GIRAVEL, PROVEDOR_WG)
        for j in jogos_catalogo(cat['pid']):
            norm = _normalizar_nome(j['nome'])
            if norm == alvo:
                exatos.append({
                    'provedor': cat['provedor'], 'pid': cat['pid'],
                    'nome': j['nome'], 'giravel': giravel,
                })
                break
            if len(parciais) < 30 and alvo in norm:
                parciais.append({
                    'provedor': cat['provedor'], 'pid': cat['pid'],
                    'nome': j['nome'], 'giravel': giravel,
                })
    resultado = exatos if exatos else parciais
    return sorted(resultado, key=lambda r: (not r['giravel'], r['provedor']))


def atualizar_catalogos(host=None):
    """Baixa os catalogos de TODOS os provedores da plataforma e grava no cache.

    Usa so o HOST (config publica da plataforma) - nao precisa de sessao valida.
    """
    import importlib.util
    import sys as _sys

    if not host:
        try:
            conn = _db_rollover()
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT host FROM sessoes WHERE host IS NOT NULL AND host != '' ORDER BY atualizado_em DESC LIMIT 1").fetchone()
            conn.close()
            host = row['host'] if row else ''
        except sqlite3.Error:
            host = ''
    if not host:
        return {'status': 'erro', 'motivo': 'nenhum host de plataforma conhecido'}

    # Carrega o auto_spin como modulo (sem executar o main)
    autospin_dir = str(DIR / 'autospin')
    if autospin_dir not in _sys.path:
        _sys.path.insert(0, autospin_dir)
    spec = importlib.util.spec_from_file_location('auto_spin_cat', str(AUTO_SPIN))
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:
        return {'status': 'erro', 'motivo': f'falha ao carregar auto_spin: {exc}'}

    url = f'https://{host}/'
    plat = mod.dados_plataforma(url)
    if not plat:
        return {'status': 'erro', 'motivo': 'falha ao obter config da plataforma'}
    cfg = plat.get('cfg') or {}
    oss = cfg.get('oss_domain') or []
    sitecode = cfg.get('siteCode')

    resultados = []
    for nome, pid in sorted(mod.PLATFORM_IDS.items(), key=lambda x: x[1]):
        try:
            lista = mod.baixar_jogos_plataforma(oss, sitecode, platform_id=pid)
            if lista:
                resultados.append({'provedor': nome, 'pid': pid, 'total': len(lista)})
        except Exception:
            continue
    return {'status': 'ok', 'host': host, 'sitecode': sitecode, 'catalogos': resultados}
