"""API local, sem efeitos ao importar. Bind loopback e autorização de origem."""
import atexit
import datetime
import faulthandler
import hashlib
import ipaddress
import json
import os
import re
import secrets
import subprocess
import threading
import time
import traceback
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
import urllib.request
import urllib.error
import db
from dados_validacao import Invalido, agora, objeto, serializar

import motor_autospin

BASE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE, 'logs')
CAP_DIR = os.path.join(BASE, 'capturas')
# Cache local das capas de jogo: o servidor busca UMA vez no CDN da casa e guarda em disco, e o
# painel so pede /api/capa (127.0.0.1) — nunca fala com host externo. As capas PG sao iguais em
# qualquer casa, entao um host serve todas. id vira so digitos + base fixa: nao da pra apontar o
# fetch para outro host (sem SSRF).
CAPA_DIR = os.path.join(BASE, 'cache_capas')
CAPA_BASE = 'https://ascx.fornopgpay1.com/game_pictures/g/EA/200/3/'
PORT = 8765
_log_lock = threading.Lock()
LOG_MAX_BYTES = 2 * 1024 * 1024
LOG_FILES = 4
MAX_BODY = 64 * 1024 * 1024
_STATIC_ROOT = {'/', '/index.html', '/manifest.webmanifest', '/service-worker.js', '/favicon.ico'}
_STATIC_TYPES = {'.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2'}
_DENY_SUFFIX = ('.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3', '.py', '.pyc', '.json', '.jsonl',
                '.zip', '.bat', '.vbs', '.ps1', '.md', '.env', '.toml', '.ini', '.log')


def _bloqueado(path):
    try:
        p = unquote(urlsplit(path).path).replace('\\', '/')
    except ValueError:
        return True
    if any(ord(ch) < 32 for ch in p) or '..' in p or ':' in p or re.search(r'~[0-9]', p):
        return True
    if any(seg != seg.rstrip(' .') for seg in p.split('/')):
        return True
    p = p.lower()
    if p in _STATIC_ROOT:
        return False
    return not (p.startswith(('/assets/', '/icons/')) and os.path.splitext(p)[1] in _STATIC_TYPES
                and not any(seg.startswith('.') for seg in p.split('/') if seg))


def _bloqueado_real(path):
    try:
        root, real = os.path.realpath(BASE), os.path.realpath(path)
        if os.path.commonpath((root, real)) != root:
            return True
        relative = '/' + os.path.relpath(real, root).replace('\\', '/')
        return _bloqueado('/' if relative == '/.' else relative)
    except (ValueError, OSError):
        return True


def _log_op(data, result):
    """Somente diagnóstico técnico: não grava valor, conta, pedido, sessão ou payload."""
    status = result.get('status') if isinstance(result, dict) else 'erro'
    status = status if status in ('ok', 'erro', 'duplicado', 'enriquecido', 'descartado') else 'outro'
    kind = data.get('tipo') if isinstance(data, dict) else None
    row = {'ts': agora(), 'evento': 'recepcao_operacao', 'status': status,
           'tipo': kind if kind in ('deposito', 'saque') else 'desconhecido'}
    _log_technical(row)


def _log_technical(row):
    line = (serializar(row) + '\n').encode('utf-8')
    try:
        with _log_lock:
            os.makedirs(LOG_DIR, exist_ok=True)
            path = os.path.join(LOG_DIR, 'tecnico-api.jsonl')
            if os.path.exists(path) and os.path.getsize(path) + len(line) > LOG_MAX_BYTES:
                for i in range(LOG_FILES - 1, 0, -1):
                    older = os.path.join(LOG_DIR, 'tecnico-api.' + str(i) + '.jsonl')
                    newer = os.path.join(LOG_DIR, 'tecnico-api.' + str(i-1) + '.jsonl') if i > 1 else path
                    if os.path.isfile(newer):
                        os.replace(newer, older)
            with open(path, 'ab') as handle:
                handle.write(line)
    except OSError:
        pass


def _purge_antigos(dias=14, dirs=None):
    # Compatibilidade: retenção histórica automática desativada nesta entrega.
    return 0


# --- Diagnóstico de queda -----------------------------------------------------------------------
# O supervisor (_servidor.bat) só anota "servidor caiu" — sem traceback nem motivo; foram ~12 quedas
# entre 13 e 21/09 sem causa registrada. Aqui o próprio processo grava em logs/servidor-erro.log:
# marcador de início, exceção não tratada (thread principal ou não), falha fatal do interpretador
# (faulthandler) e marcador de saída normal. Queda SEM traceback e SEM "saída normal" = processo morto
# de fora (Windows, memória, janela fechada). O .bat não é editado: cmd lê .bat em execução por
# deslocamento de bytes e editar um rodando corrompe a próxima linha.
SERVIDOR_INICIO = None
_ERRO_LOG = os.path.join(LOG_DIR, 'servidor-erro.log')
_ERRO_MAX_BYTES = 1024 * 1024
_QUEDA = re.compile(r'\[(\d{2})/(\d{2})/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})')


class _Tee:
    """stderr que continua no console E fica gravado no arquivo."""
    def __init__(self, *alvos):
        self.alvos = [a for a in alvos if a is not None]

    def write(self, texto):
        for alvo in self.alvos:
            try:
                alvo.write(texto)
            except Exception:
                pass
        return len(texto)

    def flush(self):
        for alvo in self.alvos:
            try:
                alvo.flush()
            except Exception:
                pass

    def isatty(self):
        return False


def _carimbo():
    return datetime.datetime.now().strftime('%d/%m/%Y %H:%M:%S')


def _preparar_diagnostico_de_queda(caminho=None):
    caminho = caminho or _ERRO_LOG
    try:
        os.makedirs(os.path.dirname(caminho), exist_ok=True)
        if os.path.exists(caminho) and os.path.getsize(caminho) > _ERRO_MAX_BYTES:
            os.replace(caminho, caminho[:-4] + '.1.log')
        arq = open(caminho, 'a', encoding='utf-8', buffering=1)
    except OSError:
        return None
    arq.write('\n=== início %s · pid %s · python %s ===\n' % (_carimbo(), os.getpid(), sys.version.split()[0]))
    try:
        faulthandler.enable(file=arq, all_threads=True)
    except Exception:
        pass
    sys.stderr = _Tee(sys.__stderr__, arq)
    anterior = sys.excepthook

    def ao_quebrar(tipo, valor, tb):
        arq.write('--- %s exceção não tratada (queda) ---\n' % _carimbo())
        anterior(tipo, valor, tb)          # imprime o traceback no stderr = console + arquivo

    sys.excepthook = ao_quebrar
    anterior_thread = threading.excepthook

    def na_thread(args):
        if args.exc_type is not SystemExit:
            arq.write('--- %s exceção na thread %s ---\n' % (_carimbo(), getattr(args.thread, 'name', '?')))
        anterior_thread(args)

    threading.excepthook = na_thread
    atexit.register(lambda: arq.write('=== saída normal %s ===\n' % _carimbo()))
    return arq


def _quedas_recentes(horas=24, agora_local=None, caminho=None):
    """Quedas anotadas pelo supervisor (logs/supervisor.log) nas últimas N horas + a última."""
    agora_local = agora_local or datetime.datetime.now()
    limite = agora_local - datetime.timedelta(hours=horas)
    n, ultima = 0, None
    try:
        with open(caminho or os.path.join(LOG_DIR, 'supervisor.log'), encoding='utf-8', errors='replace') as f:
            for linha in f:
                m = _QUEDA.search(linha) if 'caiu' in linha else None
                if not m:
                    continue
                d, mes, ano, h, mi, s = (int(x) for x in m.groups())
                try:
                    quando = datetime.datetime(ano, mes, d, h, mi, s)
                except ValueError:
                    continue
                if limite <= quando <= agora_local:
                    n += 1
                if ultima is None or quando > ultima:
                    ultima = quando
    except OSError:
        pass
    return {'quedas_24h': n, 'ultima_queda': ultima.strftime('%d/%m %H:%M') if ultima else None}


def _ext_expected():
    result = {}
    for kind, folder in (('player', 'extensao'), ('mae', 'extensao_agente')):
        try:
            with open(os.path.join(BASE, folder, 'manifest.json'), encoding='utf-8') as handle:
                result[kind] = json.load(handle).get('version')
        except (OSError, ValueError):
            result[kind] = None
    return result


def _ping(d):
    """O recibo do ping carrega a versao empacotada: a extensao passa a saber que esta velha."""
    result = db.set_ping(d)
    if isinstance(result, dict) and result.get('tipo') in ('player', 'mae'):
        result['esperada'] = _ext_expected().get(result['tipo'])
    return result


# O painel consulta /api/estado a cada 2,5 s e remontar tudo custa ~28 ms sob o lock global, que
# cresce com o histórico da mãe. A revisão do banco identifica o conteúdo; o balde de tempo existe
# porque parte do estado depende do RELÓGIO (instalação viva = ping nos últimos 180 s), e sem ele
# o cache congelaria "extensão conectada" depois que os pings parassem.
_ESTADO_BALDE = 30
_estado_cache = {'chave': None, 'valor': None, 'construindo': False, 'revisoes': None}
_estado_lock = threading.Lock()


def _estado_cacheado():
    """Estado do painel com stale-while-revalidate.

    - Escrita (revisao de DADOS mudou): remonta NA HORA — nunca esconde uma mudanca.
    - Virada do balde de tempo / telemetria (pings): devolve o valor anterior NA HORA
      e reconstroi em segundo plano; o proximo poll ja pega o novo. Antes, quem pegava
      a virada do balde esperava tudo e o painel ficava em "conectando…" (parecia
      servidor caido).
    - Cache vazio (boot): build em thread, resposta em no maximo 8s.
    """
    revisoes = db.revisoes()
    chave = (revisoes, int(time.time()) // _ESTADO_BALDE, tuple(sorted(_ext_expected().items())))
    anterior = None
    mudou_dado = False
    with _estado_lock:
        if _estado_cache['chave'] == chave:
            return _estado_cache['valor']
        anterior = _estado_cache['valor']
        guardadas = _estado_cache.get('revisoes')
        mudou_dado = anterior is not None and guardadas is not None and guardadas[0] != revisoes[0]
        if not mudou_dado and not _estado_cache.get('construindo'):
            _estado_cache['construindo'] = True
            threading.Thread(target=_reconstruir_estado, args=(chave, revisoes), daemon=True,
                             name='estado-refresh' if anterior is not None else 'estado-cold').start()
    if mudou_dado:
        # Dado financeiro mudou: leitura imediata, mesmo custando a remontagem.
        return _reconstruir_estado(chave, revisoes)
    if anterior is not None:
        return anterior
    # Cache vazio: espera no maximo 8s pelo build em andamento; senao devolve
    # um payload minimo (o painel tenta de novo no proximo poll e ja pega cheio).
    fim = time.time() + 8
    while time.time() < fim:
        with _estado_lock:
            if _estado_cache['valor'] is not None and _estado_cache['chave'] == chave:
                return _estado_cache['valor']
            if not _estado_cache.get('construindo'):
                break
        time.sleep(0.25)
    return {'inicializando': True, 'ext_esperada': _ext_expected(), 'debug': _debug_status(),
            'servidor': dict({'iniciado_em': SERVIDOR_INICIO}, **_quedas_recentes())}


def _reconstruir_estado(chave, revisoes=None):
    try:
        result = db.estado_snapshot()
        result['ext_esperada'] = _ext_expected()
        result['debug'] = _debug_status()
        result['servidor'] = dict({'iniciado_em': SERVIDOR_INICIO}, **_quedas_recentes())
        with _estado_lock:
            _estado_cache['chave'], _estado_cache['valor'] = chave, result
            _estado_cache['revisoes'] = revisoes if revisoes is not None else chave[0]
        return result
    finally:
        with _estado_lock:
            _estado_cache['construindo'] = False


_encc_cache = {'ts': 0.0, 'valor': None, 'construindo': False}


def _encerradas_cacheado():
    """Lista de casas encerradas com cache curto + stale-while-revalidate."""
    agora = time.time()
    anterior = None
    with _estado_lock:
        if _encc_cache['valor'] is not None and agora - _encc_cache['ts'] < _ESTADO_BALDE:
            return _encc_cache['valor']
        anterior = _encc_cache['valor']
        if anterior is not None and not _encc_cache.get('construindo'):
            _encc_cache['construindo'] = True

            def _bg():
                try:
                    valor = {'casas': db.encerradas_lista()}
                    with _estado_lock:
                        _encc_cache['ts'], _encc_cache['valor'] = time.time(), valor
                finally:
                    with _estado_lock:
                        _encc_cache['construindo'] = False
            threading.Thread(target=_bg, daemon=True, name='encerradas-refresh').start()
    if anterior is not None:
        return anterior
    valor = {'casas': db.encerradas_lista()}
    with _estado_lock:
        _encc_cache['ts'], _encc_cache['valor'] = time.time(), valor
    return valor


def _debug_status():
    return {'ok': True, 'ativo': False, 'captura_bruta': False, 'capturas': 0,
            'motivo': 'diagnóstico bruto desativado; somente registros técnicos sanitizados',
            'consulta_ativa_validada': False, 'cobertura': 'parcial'}


def _autospin_jogos(pid=None):
    """Lista jogos de um provedor (do cache de catalogos). Sem pid, usa PG."""
    if pid is None:
        # Retrocompatibilidade: PG do cache; se nao houver cache, cai no jogospg.json estatico
        catalogos = motor_autospin.listar_catalogos()
        if any(c['pid'] == motor_autospin.PROVEDOR_GIRAVEL for c in catalogos):
            jogos = motor_autospin.jogos_catalogo(motor_autospin.PROVEDOR_GIRAVEL)
            return {'jogos': [j['nome'] for j in jogos], 'total': len(jogos), 'pid': motor_autospin.PROVEDOR_GIRAVEL}
        import json
        jogos_path = os.path.join(BASE, 'autospin', 'jogospg.json')
        if os.path.exists(jogos_path):
            try:
                with open(jogos_path, 'r', encoding='utf-8', errors='replace') as f:
                    raw = f.read()
                while raw.startswith('#'):
                    nl = raw.find('\n')
                    if nl < 0:
                        break
                    raw = raw[nl+1:]
                data = json.loads(raw)
                jogos = data.get('data', {}).get('g1', [])
                nomes = []
                for j in jogos:
                    if isinstance(j, dict):
                        n = j.get('name') or j.get('g1')
                        if n:
                            nomes.append(str(n))
                    elif isinstance(j, str):
                        nomes.append(j)
                nomes = sorted(set(nomes))
                return {'jogos': nomes, 'total': len(nomes)}
            except Exception as e:
                return {'jogos': [], 'total': 0, 'erro': str(e)}
        return {'jogos': [], 'total': 0, 'erro': 'jogospg.json nao encontrado'}
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return {'jogos': [], 'total': 0, 'erro': 'pid invalido'}
    jogos = motor_autospin.jogos_catalogo(pid)
    return {'jogos': [j['nome'] for j in jogos], 'completos': jogos, 'total': len(jogos), 'pid': pid}


def _autospin_sincronizar():
    """A demonstração não solicita nem sincroniza sessões autenticadas."""
    return {'status': 'erro', 'motivo': 'Sessões reais indisponíveis na demonstração.', 'ts': 0}


def _autospin_ping():
    return {'ts': 0}


def _autospin_iniciar(data):
    """A edição de portfólio aceita apenas simulação explícita."""
    if not isinstance(data, dict) or data.get("dry_run") is not True:
        raise Invalido("A demonstração permite somente o Modo Teste, sem contas reais.")
    config = {
        'game': data.get('game', ''),
        'provedor': int(data.get('provedor', 200) or 200),
        'bet_max': data.get('bet_max'),
        'max_spin': int(data.get('max_spin', 0) or 0),
        'set_spins': int(data.get('set_spins', 0) or 0),
        'auto_roll': bool(data.get('auto_roll', False)),
        'max_roll': data.get('max_roll'),
        'meta': float(data.get('meta', 0) or 0),
        'pg_trava': bool(data.get('pg_trava', False)),
        'zerar_saldo': bool(data.get('zerar_saldo', False)),
        'zerar_saldo_total': bool(data.get('zerar_saldo_total', False)),
        'gem_trava': data.get('gem_trava'),
        'coletar_bonus': bool(data.get('coletar_bonus', False)),
        'comprar_bonus': int(data.get('comprar_bonus', 0) or 0),
        'max_game': int(data.get('max_game', 0) or 0),
        'no_proxy': bool(data.get('no_proxy', False)),
        'proxy_sempre': bool(data.get('proxy_sempre', True)),
        'modo_rapido': bool(data.get('modo_rapido', False)),
        'turbo': bool(data.get('turbo', True)),
        'stealth': bool(data.get('stealth', True)),
        'stealth_impersonate': str(data.get('stealth_impersonate') or 'chrome142'),
        'parar_ao_finalizar': int(data.get('parar_ao_finalizar', 0) or 0),
        'loop': bool(data.get('loop', False)),
        # Flags avancadas (T3)
        'bet_percent': data.get('bet_percent', 0),
        'saldo_limite': data.get('saldo_limite', 0),
        'abrir_jogos': data.get('abrir_jogos', -1),
        'gem_hp': data.get('gem_hp', 0),
        'bau': bool(data.get('bau', False)),
        'account_id': str(data.get('account_id') or ''),
        'bonus_dias': data.get('bonus_dias', 0),
        'sem_extrato': bool(data.get('sem_extrato', False)),
        'roll_teto_lote': data.get('roll_teto_lote', 0),
        # Lancamento em ondas (rate-limit) + modo teste sem rede
        'onda_tamanho': data.get('onda_tamanho', 0),
        'onda_intervalo': data.get('onda_intervalo', 10),
        'dry_run': bool(data.get('dry_run', False)),
    }
    # Filtra bet_max se não for numérico
    if config['bet_max'] is not None:
        try:
            config['bet_max'] = float(config['bet_max'])
        except (ValueError, TypeError):
            config['bet_max'] = None
    # Filtra max_roll se não for numérico
    if config['max_roll'] is not None:
        try:
            config['max_roll'] = float(config['max_roll'])
        except (ValueError, TypeError):
            config['max_roll'] = None

    # Flags avancadas (T3): conversoes tolerantes a vazio/invalido.
    for chave in ('bet_percent', 'saldo_limite', 'gem_hp', 'roll_teto_lote'):
        try:
            config[chave] = float(config.get(chave) or 0)
        except (ValueError, TypeError):
            config[chave] = 0.0
    try:
        config['abrir_jogos'] = int(config.get('abrir_jogos')) if config.get('abrir_jogos') is not None else -1
    except (ValueError, TypeError):
        config['abrir_jogos'] = -1
    try:
        config['bonus_dias'] = int(config.get('bonus_dias') or 0)
    except (ValueError, TypeError):
        config['bonus_dias'] = 0
    try:
        config['onda_tamanho'] = max(0, int(config.get('onda_tamanho') or 0))
    except (ValueError, TypeError):
        config['onda_tamanho'] = 0
    try:
        config['onda_intervalo'] = float(config.get('onda_intervalo') or 10)
    except (ValueError, TypeError):
        config['onda_intervalo'] = 10.0

    # Comando digitado vence o Auto Roll: com giros exatos ou teto de roll definidos,
    # o Auto Roll e desligado (senao o bot ignoraria os spins e tiraria os giros do
    # saldo, podendo nem chegar ao roll pedido).
    if config['auto_roll'] and (config['set_spins'] > 0 or (config['max_roll'] or 0) > 0):
        config['auto_roll'] = False

    casas = data.get('casas')  # lista ou None
    contas = data.get('contas')  # lista ou None
    pares = data.get('pares')  # lista de {'casa','conta'} ou None (seleção exata)
    ativas = data.get('ativas', True)  # default: só contas ativas
    # Mix "dividir em jogos": normaliza até 4 grupos (jogo/provedor/bet/giros/roll).
    grupos = []
    for g in (data.get('mix') or [])[:4]:
        if not isinstance(g, dict):
            continue
        jogo = str(g.get('game') or '').strip()
        if not jogo:
            continue
        item = {'game': jogo}
        try:
            item['provedor'] = int(g.get('provedor') or config.get('provedor') or 200)
        except (TypeError, ValueError):
            item['provedor'] = 200
        for chave, cast in (('bet_max', float), ('max_roll', float), ('set_spins', int)):
            valor = g.get(chave)
            if valor is None or valor == '':
                continue
            try:
                item[chave] = cast(valor)
            except (TypeError, ValueError):
                pass
        grupos.append(item)
    grupos = grupos if len(grupos) >= 2 else None
    job_ids, pulados = motor_autospin.iniciar_jobs(config, casas=casas, contas=contas,
                                                   ativas=ativas, pares=pares, grupos=grupos)
    return {'jobs': job_ids, 'total': len(job_ids), 'pulados': pulados, 'status': 'iniciado'}


class Handler(SimpleHTTPRequestHandler):
    server_version = 'AgentumLocal/1'
    sys_version = ''

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE, **kwargs)

    # Extensoes so alcancam as rotas de captura e de configuracao de LEITURA. Restaurar, limpar,
    # exportar e administrar ciclo/foco exigem o painel: qualquer extensao instalada (com
    # <all_urls>) consegue falar com 127.0.0.1, e AGENTUM_EXTENSION_IDS nunca e definido pelos
    # lancadores — a allowlist por id continua valendo como camada extra quando configurada.
    EXTENSAO_ROTAS = {'/api/operation': {'POST'}, '/api/pedido': {'POST'}, '/api/pendente': {'POST'},
                      '/api/conta': {'POST'}, '/api/agente': {'POST'}, '/api/ping': {'POST'},
                      '/api/jogo': {'POST'}, '/api/dominios_casa': {'POST'},
                      '/api/foco': {'GET'}, '/api/encerradas': {'GET'}, '/api/periodo': {'GET'},
                      '/api/varrer_saque': {'GET'}, '/api/abrir_jogo': {'GET'},
                      '/api/autospin/ping': {'GET'},
                      '/api/giro_amostra': {'POST'}}   # Rollover (TESTE, 1.71): amostra dos campos da rodada

    @classmethod
    def _rota_de_extensao(cls, method, path):
        metodos = cls.EXTENSAO_ROTAS.get(path.split('?', 1)[0])
        return bool(metodos) and (method == 'OPTIONS' or method in metodos)

    def _authorization(self):
        self._allowed_origin = None
        self._negado = None
        try:
            if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                return False
            hosts = self.headers.get_all('Host', [])
            origins = self.headers.get_all('Origin', [])
            if len(hosts) != 1 or len(origins) > 1:
                return False
            port = self.server.server_port
            allowed_hosts = {'localhost:' + str(port), '127.0.0.1:' + str(port), '[::1]:' + str(port)}
            if port == 80:
                allowed_hosts.update(('localhost', '127.0.0.1', '[::1]'))
            if hosts[0].lower() not in allowed_hosts:
                return False
            origin = origins[0] if origins else None
            extension = origin is not None and re.fullmatch(r'chrome-extension://[a-p]{32}', origin) is not None
            if origin is not None:
                if not extension and origin not in {'http://' + host for host in allowed_hosts}:
                    return False
                if extension:
                    allowed_ids = os.environ.get('AGENTUM_EXTENSION_IDS', '').split(',')
                    if allowed_ids != [''] and origin[19:] not in allowed_ids:
                        return False
                    if not self._rota_de_extensao(self.command, self.path):
                        self._negado = 'rota indisponível para extensão'
                        return False
                self._allowed_origin = origin
            fetch_site = self.headers.get('Sec-Fetch-Site', '').lower()
            if fetch_site == 'cross-site' and not extension:
                return False
            # Clientes nativos sem Origin podem usar token opcional; consumidores browser locais
            # são autorizados pelo par Host/Origin validado. Nunca se devolve o token.
            token = os.environ.get('AGENTUM_API_TOKEN')
            if token and not origin and self.path.startswith('/api/'):
                supplied = self.headers.get('Authorization', '')
                if not secrets.compare_digest(supplied, 'Bearer ' + token):
                    return False
            return True
        except (ValueError, AttributeError):
            return False

    def _drenar(self):
        """Consome o corpo antes de recusar: responder sem ler faz o cliente levar RST no meio do
        envio (ConnectionAborted) em vez de ver o 403. Limitado a MAX_BODY para não virar sorvedouro."""
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not lengths[0].isdigit():
            return
        size = int(lengths[0])
        if size <= 0 or size > MAX_BODY:
            return
        try:
            self.rfile.read(size)
        except OSError:
            pass

    def _guard(self):
        if self._authorization():
            return True
        self._drenar()
        self._json({'status': 'erro', 'motivo': getattr(self, '_negado', None) or 'acesso local não autorizado'}, 403)
        return False

    def _cors(self):
        origin = getattr(self, '_allowed_origin', None)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD')

    def _json(self, obj, code=200):
        if code == 200 and isinstance(obj, dict) and obj.get('status') == 'erro':
            code = 409 if obj.get('codigo') == 'conflito' else 400
        body = serializar(obj).encode('utf-8')
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self._cors()
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # Cliente cancelou (aba recarregou/fechou durante a resposta): nao e
            # falha do servidor — nao vira incidente 500 nem polui o log.
            pass

    def _read(self):
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not lengths[0].isdigit() or self.headers.get('Transfer-Encoding'):
            raise Invalido('Content-Length obrigatório e único')
        size = int(lengths[0])
        if size > MAX_BODY or size < 2:
            raise Invalido('tamanho do corpo inválido')
        if self.headers.get_content_type() != 'application/json':
            raise Invalido('Content-Type deve ser application/json')
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise Invalido('corpo incompleto')
        try:
            def unique(pairs):
                out = {}
                for key, value in pairs:
                    if key in out:
                        raise ValueError('campo duplicado')
                    out[key] = value
                return out
            value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            return objeto(value)
        except (ValueError, UnicodeError, RecursionError):
            raise Invalido('JSON inválido') from None

    def do_OPTIONS(self):
        if not self._guard():
            return
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def _capa(self, gid):
        # Serve a capa do jogo do cache local; na 1a vez busca no CDN da casa e guarda. id -> so
        # digitos, URL montada de base fixa: nao da pra desviar o fetch (sem SSRF). Falhou -> 404, e
        # o painel cai na ficha com emoji (nada quebra).
        gid = re.sub(r'\D', '', gid or '')[:9]
        if not gid:
            return self._json({'status': 'erro', 'motivo': 'id inválido'}, 400)
        try:
            os.makedirs(CAPA_DIR, exist_ok=True)
            fp = os.path.join(CAPA_DIR, gid + '.avif')
            if not (os.path.exists(fp) and os.path.getsize(fp) > 0):
                req = urllib.request.Request(CAPA_BASE + gid + '/default.avif', headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    dados = resp.read()
                if not dados:
                    raise ValueError('vazio')
                tmp = fp + '.tmp'
                with open(tmp, 'wb') as f:
                    f.write(dados)
                os.replace(tmp, fp)
            with open(fp, 'rb') as f:
                dados = f.read()
        except Exception:
            return self._json({'status': 'erro', 'motivo': 'capa indisponível'}, 404)
        self.send_response(200)
        self.send_header('Content-Type', 'image/avif')
        self.send_header('Content-Length', str(len(dados)))
        self.send_header('Cache-Control', 'public, max-age=604800')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(dados)
        return None

    def do_GET(self):
        if not self._guard():
            return
        path = urlsplit(self.path).path
        if not path.startswith('/api/'):
            if _bloqueado(path) or _bloqueado_real(self.translate_path(path)):
                return self._json({'status': 'erro', 'motivo': 'acesso negado'}, 403)
            return super().do_HEAD() if self.command == 'HEAD' else super().do_GET()
        try:
            if path == '/api/capa':
                return self._capa(parse_qs(urlsplit(self.path).query).get('id', [''])[0])
            if path == '/api/estado':
                result = _estado_cacheado()
                result['cobertura_backup'] = {'completa': False, 'banco_negocio': True, 'filas_externas': False, 'navegador': False}
                return self._json(result)
            reads = {
                '/api/versao': lambda: {'versao': db.versao()}, '/api/resumo': db.resumo,
                '/api/operacoes': lambda: {'operacoes': db.operacoes()}, '/api/contas': lambda: {'contas': db.contas_lista()},
                '/api/painel': lambda: db.painel_estado(),
                '/api/painel/historico': lambda: {'metas': db.painel_metas_historico()},
                '/api/jogos': lambda: {'jogos': db.jogos_ranking()}, '/api/pedidos': lambda: {'pedidos': db.pedidos_lista(True)},
                '/api/foco': lambda: {'casas': db.foco_lista()}, '/api/encerradas': _encerradas_cacheado,
                '/api/periodo': lambda: {'periodo': db.periodo_ciclo()}, '/api/diagnostico': db.diagnostico,
                '/api/backup': db.exportar, '/api/debug/status': _debug_status, '/api/cronograma': db.cronograma,
                '/api/rollover/amostras': lambda: {'amostras': __import__('dados_rollover').giros_amostra()},
                '/api/autospin/sessoes': lambda: {'contas': []},
                '/api/autospin/status': motor_autospin.todos_status,
                '/api/autospin/resumo': motor_autospin.resumo_execucao,
                '/api/autospin/historico': lambda: motor_autospin.historico_resumo(),
                '/api/autospin/proxies/saude': motor_autospin.proxies_saude,
                '/api/autospin/proxies/score': motor_autospin.score_proxies_ativo,
                '/api/autospin/jogos': _autospin_jogos,
                '/api/autospin/catalogos': lambda: {'catalogos': motor_autospin.listar_catalogos(),
                                                    'giravel': motor_autospin.PROVEDOR_GIRAVEL},
                '/api/autospin/ping': _autospin_ping,
            }
            if path in reads:
                if path == '/api/autospin/jogos':
                    # pid opcional: /api/autospin/jogos?pid=13
                    params = parse_qs(urlsplit(self.path).query)
                    return self._json(_autospin_jogos((params.get('pid') or [None])[0]))
                if path == '/api/autospin/historico':
                    # filtros opcionais: ?casa=p2-climatepg&dias=7
                    params = parse_qs(urlsplit(self.path).query)
                    casa = (params.get('casa') or [None])[0] or None
                    try:
                        dias = int((params.get('dias') or ['0'])[0] or 0)
                    except ValueError:
                        dias = 0
                    return self._json(motor_autospin.historico_resumo(casa=casa, dias=dias))
                return self._json(reads[path]())
            if path == '/api/autospin/jogos/busca':
                params = parse_qs(urlsplit(self.path).query)
                nome = (params.get('nome') or [''])[0]
                return self._json({'resultados': motor_autospin.buscar_jogo(nome)})
            if path.startswith('/api/autospin/job/') and path.endswith('/log'):
                # Log maior de UM job, sob demanda (o card expandido pede "carregar mais").
                jid = unquote(path[len('/api/autospin/job/'):-len('/log')])
                params = parse_qs(urlsplit(self.path).query)
                try:
                    tail = int((params.get('tail') or ['400'])[0])
                except (ValueError, TypeError):
                    tail = 400
                dados = motor_autospin.log_job(jid, tail)
                if dados is None:
                    return self._json({'status': 'erro', 'motivo': 'job nao encontrado'}, 404)
                return self._json(dados)
            if path == '/api/abrir_jogo':
                return self._json(db.abrir_jogo())
            if path == '/api/varrer_saque':
                return self._json(db.varredura_atual())
            if path == '/api/restore/status':
                params = parse_qs(urlsplit(self.path).query)
                return self._json(db.restore_status((params.get('id') or [''])[0]))
            if path == '/api/sessao':
                return self._json({'status': 'erro', 'motivo': 'rota de sessão descontinuada'}, 410)
            return self._json({'status': 'erro', 'motivo': 'rota desconhecida'}, 404)
        except Invalido as exc:
            return self._json({'status': 'erro', 'motivo': str(exc)}, 400)
        except Exception:
            return self._failure()

    def do_POST(self):
        if not self._guard():
            return
        path = urlsplit(self.path).path
        try:
            data = self._read()
            if path == '/api/operation':
                result = db.add_operacao(data)
                _log_op(data, result)
                return self._json(result)
            import dados_identidade
            routes = {
                '/api/casas/nome': dados_identidade.rename,
                '/api/casas/previa': dados_identidade.prepare,
                '/api/casas/associar': dados_identidade.associate,
                '/api/casas/desfazer': dados_identidade.undo,
                '/api/pedido': db.add_pedido, '/api/pendente': db.add_pendente,
                '/api/pendente/remover': db.del_pendente, '/api/ajuste': db.set_ajuste, '/api/extras': db.set_extras, '/api/meta_casa': db.set_meta_casa,
                '/api/dispensar': db.set_dispensado,
                '/api/agente': db.set_agente, '/api/ping': _ping, '/api/conta': db.set_conta,
                '/api/jogo': db.set_jogo, '/api/painel': db.set_painel,
                # Rollover (TESTE): módulo separado, sem efeito em ciclo/resultado
                '/api/giro_amostra': lambda d: __import__('dados_rollover').add_giro_amostra(d),
                '/api/rollover/amostras/limpar': lambda d: __import__('dados_rollover').limpar_amostras(),
                '/api/jogos_cat': db.set_jogos_cat, '/api/ciclo/fechar': db.fechar_ciclo,
                '/api/restore': db.importar, '/api/restore/validar': db.validar_restore,
                '/api/operacao/excluir': db.del_operacao, '/api/operacao/restaurar': db.restaurar_descartado,
                '/api/cronograma': db.set_cronograma,
                '/api/periodo': db.set_periodo,
                '/api/foco': lambda d: db.set_foco(d.get('casas')),
                '/api/encerrar': lambda d: db.set_encerrada(d.get('casa'), d.get('on', True)),
                '/api/game': lambda d: db.add_jogos(d.get('casa'), d.get('conta'), d.get('records')),
                '/api/agente/limpar': lambda d: db.limpar_agente(), '/api/contas/limpar': lambda d: db.limpar_contas(),
                '/api/agente/remover': lambda d: db.remover_agente_casa(d.get('casa')),
                '/api/ciclo/novo': db.novo_ciclo_pedido,
                '/api/operacoes/limpar': lambda d: db.limpar_operacoes(d.get('escopo', 'operacoes')),
                '/api/varrer_saque': db.solicitar_varredura,
                '/api/abrir_jogo': db.solicitar_jogo,
                '/api/dominios_casa': db.registrar_dominios,
                '/api/autospin/iniciar': _autospin_iniciar,
                '/api/autospin/parar': lambda d: {'parados': motor_autospin.parar_todos()},
                '/api/autospin/limpar': lambda d: {'limpos': motor_autospin.limpar_finalizados()},
                '/api/autospin/sincronizar': lambda d: _autospin_sincronizar(),
                '/api/autospin/catalogos/atualizar': lambda d: motor_autospin.atualizar_catalogos(d.get('host')),
                '/api/autospin/proxies/testar': lambda d: motor_autospin.testar_proxies(
                    (d or {}).get('amostra') or None),
                '/api/autospin/historico/limpar': lambda d: motor_autospin.limpar_historico(),
                '/api/autospin/proxies/score/limpar': lambda d: motor_autospin.limpar_score_proxies(),
            }
            if path in routes:
                return self._json(routes[path](data))
            if path.startswith('/api/debug'):
                return self._json({'status': 'erro', 'motivo': 'captura bruta desativada'}, 410)
            return self._json({'status': 'erro', 'motivo': 'rota desconhecida'}, 404)
        except Invalido as exc:
            return self._json({'status': 'erro', 'motivo': str(exc)}, 400)
        except Exception:
            return self._failure()

    def _failure(self):
        incident = secrets.token_hex(8)
        kind, _, trace = sys.exc_info()
        frames = [{'arquivo': os.path.basename(f.filename), 'linha': f.lineno, 'funcao': f.name}
                  for f in traceback.extract_tb(trace)[-6:]] if trace else []
        _log_technical({'ts': agora(), 'evento': 'falha_interna', 'incidente': incident,
                        'classe': kind.__name__ if kind else 'indisponivel', 'quadros': frames})
        return self._json({'status': 'erro', 'motivo': 'falha interna; evento não confirmado', 'incidente': incident}, 500)

    def list_directory(self, path):
        self._json({'status': 'erro', 'motivo': 'listagem desativada'}, 403)
        return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        super().end_headers()

    def log_message(self, *args):
        pass


# A edição de demonstração não inicia nem consulta servidores de sessão.


def _watchdog_jobs_travados():
    """A cada 2 min, para jobs cujo log nao avanca (bot pendurado)."""
    while True:
        try:
            motor_autospin.verificar_jobs_travados()
        except Exception:
            pass
        time.sleep(120)


def _copia_diaria():
    """Ponto de restauração local sem depender de o operador lembrar de exportar.

    Só cria se não houver cópia com menos de 24 h. Reaproveita _preserve_original (snapshot
    consistente em WAL, integrity_check e retenção), então nunca acumula sem limite. Falha aqui
    jamais derruba o servidor: é conveniência, não caminho crítico.
    """
    import dados_backup
    while True:
        try:
            pasta = os.path.join(os.path.dirname(os.path.abspath(db.DB_PATH)), '_backups')
            recentes = []
            if os.path.isdir(pasta):
                limite = time.time() - 86400
                recentes = [n for n in os.listdir(pasta)
                            if n.startswith('antes-restore-') and os.path.getmtime(os.path.join(pasta, n)) > limite]
            if not recentes:
                dados_backup._preserve_original()
        except Exception:
            pass
        time.sleep(3600)


FAXINA_INTERVALO = 600   # 10 min


def _faxina_uma_vez():
    """Manutenção que antes só rodava no boot (db.init): com o servidor de pé por dias, pedidos
    expirados ficavam no banco e perfis mortos se acumulavam (882 em 23/09). Nunca derruba o servidor."""
    feito = {}
    for nome, rotina in (('pedidos_expirados', db.expirar_pedidos), ('instalacoes_podadas', db.limpar_instalacoes)):
        try:
            feito[nome] = rotina()
        except Exception as exc:
            feito[nome] = 'erro: ' + type(exc).__name__
    if any(v for v in feito.values()):
        _log_technical(dict({'ts': agora(), 'evento': 'faxina'}, **feito))
    return feito


def _faxina_periodica():
    while True:
        time.sleep(FAXINA_INTERVALO)
        _faxina_uma_vez()


class ServidorAgentum(ThreadingHTTPServer):
    """ThreadingHTTPServer que nao imprime traceback de cliente que cancelou.

    Abortos de conexao (WinError 10053/10054) sao rotina quando a aba recarrega
    ou uma extensao cancela a requisicao — nao sao falha do servidor.
    """
    daemon_threads = True
    request_queue_size = 64  # aguenta rajadas de polls/abas sem recusar conexao

    def handle_error(self, request, client_address):
        tipo = sys.exc_info()[0]
        if tipo in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


def main():
    global SERVIDOR_INICIO
    _preparar_diagnostico_de_queda()
    SERVIDOR_INICIO = agora()
    db.init()
    print('NexAcc Demo — http://127.0.0.1:%d' % PORT)
    # Nenhuma retenção/migração destrutiva de capturas, jogos ou logs financeiros no boot.
    # Jobs de Auto Spin sobrevivem ao reinicio: relê o registro em disco e reconecta
    # aos processos que continuam vivos (logs retomam de onde pararam).
    try:
        restaurados = motor_autospin.restaurar_jobs()
        if restaurados:
            print(f'Auto Spin: {restaurados} job(s) restaurado(s) do registro em disco')
        # Logs antigos (>30 dias) vao para logs/autospin/arquivo/AAAA-MM (move, nunca apaga).
        try:
            arquivados = motor_autospin.arquivar_logs_antigos()
            if arquivados:
                print(f'Auto Spin: {arquivados} log(s) antigo(s) arquivado(s)')
        except Exception:
            pass
    except Exception as exc:
        print(f'Auto Spin: falha ao restaurar jobs ({type(exc).__name__})')
    threading.Thread(target=_copia_diaria, daemon=True).start()
    threading.Thread(target=_faxina_periodica, name='faxina', daemon=True).start()
    threading.Thread(target=_watchdog_jobs_travados, name='watchdog-travados', daemon=True).start()
    threading.Thread(target=_estado_cacheado, name='estado-warm', daemon=True).start()
    with ServidorAgentum(('127.0.0.1', PORT), Handler) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
