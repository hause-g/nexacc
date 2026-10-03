"""Rollover (TESTE, 25/09/2026) — módulo separado de propósito, para mexer sem tocar no resto.

Etapa 1 (medição): a filha 1.71 manda os campos das primeiras rodadas de cada jogo aberto. Serve só
para confirmar, com giro REAL, quais campos trazem a aposta e o saldo antes de confiar um freio neles.
Nada aqui é dinheiro nem entra em ciclo/resultado: fica numa lista curta em `controles`.
"""
import json
import re
import db
from dados_validacao import Invalido, agora, objeto, serializar, texto

CHAVE_AMOSTRAS = 'rollover_amostras_giro'
MAX_AMOSTRAS = 60
_CHAVE = re.compile(r'^[A-Za-z0-9_]{1,24}$')
_SEGREDO = re.compile(r'token|atk|session|key|auth|senha|password|cpf|phone|mail|sign', re.I)


def _chaves(valor):
    if not isinstance(valor, list):
        return []
    return [k for k in valor if isinstance(k, str) and _CHAVE.match(k) and not _SEGREDO.search(k)][:60]


def add_giro_amostra(d):
    objeto(d)
    numeros = {}
    for k, v in list((d.get('numeros') or {}).items())[:40] if isinstance(d.get('numeros'), dict) else []:
        if isinstance(k, str) and _CHAVE.match(k) and not _SEGREDO.search(k) \
                and isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e12:
            numeros[k] = v
    amostra = {
        'recebido_em': agora(),
        'casa': texto(d.get('casa') or '', 'casa', vazio=True, limite=80),
        'conta': texto(str(d.get('conta') or ''), 'conta', vazio=True, limite=40),
        'slug': texto(d.get('slug') or '', 'slug', vazio=True, limite=40),
        'formato': texto(d.get('formato') or '', 'formato', vazio=True, limite=12),
        'caminho': texto(d.get('caminho') or '', 'caminho', vazio=True, limite=8),
        'tamanho': int(d.get('tamanho') or 0) if isinstance(d.get('tamanho'), (int, float)) else 0,
        'chaves_topo': _chaves(d.get('chaves_topo')),
        'chaves': _chaves(d.get('chaves')),
        'numeros': numeros,
        'versao': texto(d.get('versao') or '', 'versao', vazio=True, limite=12),
        # 1.72: transporte da resposta (a gem-saviour vinha binária e a 1.71 lia "vazio")
        'via': texto(d.get('via') or '', 'via', vazio=True, limite=8),
        'tipo_resposta': texto(d.get('tipo_resposta') or '', 'tipo_resposta', vazio=True, limite=16),
        'content_type': texto(d.get('content_type') or '', 'content_type', vazio=True, limite=40),
        'bytes': int(d['bytes']) if isinstance(d.get('bytes'), (int, float)) and not isinstance(d.get('bytes'), bool) else 0,
        'inicio_hex': d['inicio_hex'] if isinstance(d.get('inicio_hex'), str) and re.fullmatch(r'[0-9a-f]{0,16}', d['inicio_hex']) else '',
        'doc': texto(d.get('doc') or '', 'doc', vazio=True, limite=8),
        'n': int(d['n']) if isinstance(d.get('n'), int) and not isinstance(d.get('n'), bool) else 0,
        'numero_grande': 1 if d.get('numero_grande') else 0,   # 1.73: havia inteiro gigante (id) na resposta
    }
    if not amostra['slug']:
        raise Invalido('amostra de giro sem jogo')
    with db._lock, db._c() as c:
        lista = giros_amostra_c(c)
        lista.append(amostra)
        c.execute("INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                  (CHAVE_AMOSTRAS, serializar(lista[-MAX_AMOSTRAS:])))
    return {'status': 'ok'}


def giros_amostra_c(c):
    try:
        lista = json.loads(db._get_control(c, CHAVE_AMOSTRAS, '[]'))
    except ValueError:
        lista = []
    return lista if isinstance(lista, list) else []


def giros_amostra():
    with db._lock, db._c() as c:
        return list(reversed(giros_amostra_c(c)))


def limpar_amostras():
    with db._lock, db._c() as c:
        c.execute('DELETE FROM controles WHERE chave=?', (CHAVE_AMOSTRAS,))
    return {'status': 'ok'}
