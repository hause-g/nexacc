"""SQLite local; importar não abre banco. Escritas e snapshots são transacionais."""
import datetime as dt
import functools
import json
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from dados_validacao import (Conflito, Invalido, agora, booleano, centavos, contexto,
    dinheiro, hash_json, identidade, instante, numero, objeto, serializar, texto)
from dados_schema import BACKUP_TABLES, SCHEMA_VERSION, migrate

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'operacoes.db')
_lock = threading.RLock()
_local = threading.local()
_BACKUP_TABLES = list(BACKUP_TABLES)


@contextmanager
def _c():
    existing = getattr(_local, 'connection', None)
    if existing is not None:
        yield existing
        return
    c = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    c.row_factory = sqlite3.Row
    try:
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('BEGIN IMMEDIATE')
        _local.connection = c
        yield c
        c.commit()
    except BaseException:
        c.rollback()
        raise
    finally:
        _local.connection = None
        c.close()


def _api(fn):
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Conflito as exc:
            return {'status': 'erro', 'motivo': str(exc), 'codigo': 'conflito'}
        except Invalido as exc:
            return {'status': 'erro', 'motivo': str(exc), 'codigo': 'invalido'}
    return wrapped


def init():
    with _lock, _c() as c:
        migrate(c, agora(), uuid.uuid4().hex)
        if not _ciclo(c):
            c.execute('INSERT INTO ciclos(aberto,criado_em) VALUES(1,?)', (agora(),))
    try:
        limpar_instalacoes()   # poda perfis de navegador mortos (>7 dias) que incham o /api/estado
    except Exception:
        pass
    try:
        expirar_pedidos()      # encerra depositos que a casa expirou sem pagar (some da lista sozinho)
    except Exception:
        pass


def _ciclo(c):
    row = c.execute('SELECT id FROM ciclos WHERE aberto=1 ORDER BY id DESC LIMIT 1').fetchone()
    return row['id'] if row else None


def _versao(c):
    r = c.execute('SELECT epoch,valor FROM revisao WHERE id=1').fetchone()
    return r['epoch'] + ':' + str(r['valor'])


def versao():
    with _lock, _c() as c:
        return _versao(c)


def _expected(c, d):
    if 'expected_versao' in d and d['expected_versao'] != _versao(c):
        raise Conflito('dados mudaram; atualize antes de gravar')


def _identity(d, incomplete=False):
    return (identidade(d.get('casa', ''), 'casa', vazio=incomplete),
            identidade(d.get('conta', ''), 'conta', vazio=incomplete),
            identidade(d.get('numero_pedido'), 'numero_pedido'))


def _times(d):
    now = agora()
    return instante(d.get('data'), nulo=True), instante(d.get('observado_em', now), 'observado_em'), now


def _origin_cycle(c, d, key=None):
    if key:
        for table in ('pedidos', 'pendentes'):
            row = c.execute('SELECT ciclo_id FROM ' + table + ' WHERE casa=? AND conta=? AND numero_pedido=?', key).fetchone()
            if row:
                return row['ciclo_id'], 'pedido_original'
    stamp = instante(d.get('data'), nulo=True) or instante(d.get('observado_em'), nulo=True) or agora()
    cycles = list(c.execute('SELECT * FROM ciclos ORDER BY id'))
    for row in reversed(cycles):
        start, end = instante(row['criado_em'], nulo=True), instante(row['fechado_em'], nulo=True)
        if (start is None or stamp >= start) and (end is None or stamp < end):
            return row['id'], 'hora_oficial' if d.get('data') else 'hora_observada'
    if cycles:
        return cycles[0]['id'], 'anterior_ao_primeiro_ciclo'
    raise Conflito('nenhum ciclo disponível')


JANELA_GEMEO = 900  # 15 min: meio da faixa vazia entre o gemeo da casa (<=5 min) e o redeposito (>=1 h)
JANELA_VIVA = 180   # mesmo limiar do painel e do background para considerar uma instalacao ativa
JANELA_ENVIO_INSTALACOES = 3600  # 1 h: so as instalacoes deste periodo vao no /api/estado (o painel
                                 # so usa <3min); perfis mortos incham 1MB+ no polling de 2,5 s.
DIAS_PODA_INSTALACOES = 7        # perfis que nao pingam ha >7 dias sao apagados no start do servidor
PIX_NAO_PAGO_HORAS = 2           # PIX gerado ('identificado') sem virar deposito em 2 h = abandonado


def _recente(segundos=JANELA_VIVA):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=segundos)).isoformat().replace('+00:00', 'Z')


def _intervalo(a, b):
    """Segundos entre dois instantes ISO; None quando algum nao for legivel."""
    try:
        ta = dt.datetime.fromisoformat(str(a).replace('Z', '+00:00'))
        tb = dt.datetime.fromisoformat(str(b).replace('Z', '+00:00'))
    except (ValueError, TypeError, AttributeError):
        return None
    return abs((tb - ta).total_seconds())


def _receipt(c, d, route, execute):
    event_id = d.get('event_id')
    revision = numero(d.get('revision', 0), 'revision', inteiro=True)
    if event_id is not None:
        event_id = texto(event_id, 'event_id')
        fingerprint = hash_json(d)
        old = c.execute('SELECT * FROM recebimentos WHERE event_id=? AND revision=?', (event_id, revision)).fetchone()
        if old:
            if old['rota'] != route or old['payload_hash'] != fingerprint:
                raise Conflito('event_id/revision reutilizado com conteúdo diferente')
            return json.loads(old['resposta'])
    result = execute()
    if route in ('operation','pedido','agente','conta') and result.get('status') in ('ok','duplicado','enriquecido','promovido'):
        import dados_identidade
        dados_identidade.observe(c,d,'mae' if route=='agente' else 'player')
    if event_id is not None:
        result.update(event_id=event_id, revision=revision, ack={'event_id': event_id, 'revision': revision})
        c.execute('INSERT INTO recebimentos VALUES(?,?,?,?,?,?)',
                  (event_id, revision, route, fingerprint, serializar(result), agora()))
    return result


def _new_cycle(c):
    now = agora()
    c.execute('UPDATE ciclos SET aberto=0,fechado_em=? WHERE aberto=1', (now,))
    return c.execute('INSERT INTO ciclos(aberto,criado_em) VALUES(1,?)', (now,)).lastrowid


def _registrar_ciclo(c, de, para, origem):
    """Rastro de quem virou o ciclo. Sem isto, a acao mais destrutiva do painel nao deixava
    NENHUMA marca: descobrir quem fechou virava investigacao no banco."""
    try:
        historico = json.loads(_get_control(c, 'ciclos_historico', '[]'))
        if not isinstance(historico, list):
            historico = []
    except ValueError:
        historico = []
    historico.append({'de': de, 'para': para, 'quando': agora(), 'origem': origem})
    c.execute("INSERT INTO controles VALUES('ciclos_historico',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
              (serializar(historico[-50:]),))


def novo_ciclo(origem='interno'):
    with _lock, _c() as c:
        atual = _ciclo(c)
        novo = _new_cycle(c)
        _registrar_ciclo(c, atual, novo, origem)
        return novo


@_api
def novo_ciclo_pedido(d):
    """Virar o ciclo some com o dia inteiro da tela — quem decide isso e o operador, ninguem mais.
    Pela HTTP so acontece quando o pedido NOMEIA o ciclo que esta aberto agora e diz confirmado.
    Assim clique perdido, aba velha com JS antigo, requisicao reenviada e chamada de fora nao
    conseguem fechar operacao."""
    objeto(d)
    with _lock, _c() as c:
        atual = _ciclo(c)
    if numero(d.get('ciclo_id'), 'ciclo_id', inteiro=True, nulo=True) != atual:
        raise Conflito('o pedido não nomeia o ciclo aberto; nada foi fechado')
    if d.get('confirmado') is not True:
        raise Invalido('virar o ciclo exige confirmação explícita; nada foi fechado')
    return {'ok': True, 'status': 'ok', 'ciclo': novo_ciclo('painel')}


def _pedido_upsert(c, d):
    key = _identity(d, incomplete=True)
    kind, state = d.get('tipo'), d.get('estado')
    if kind not in ('deposito', 'saque'):
        raise Invalido('tipo inválido')
    if state not in ('identificado', 'processando', 'confirmado', 'falhou', 'verificar'):
        raise Invalido('estado inválido')
    value = dinheiro(d.get('valor'), 'valor', nulo=True)
    reason = texto(d.get('motivo', ''), 'motivo', vazio=True, limite=512)
    origin = texto(d.get('origem', ''), 'origem', vazio=True)
    official, observed, received = _times(d)
    rev = numero(d.get('revision', 0), 'revision', inteiro=True)
    ctx = serializar(contexto(d.get('contexto')))
    old = c.execute('SELECT * FROM pedidos WHERE casa=? AND conta=? AND numero_pedido=?', key).fetchone()
    operation = c.execute('SELECT * FROM operacoes WHERE casa=? AND conta=? AND numero_pedido=?', key).fetchone()
    cid, _ = _origin_cycle(c, d, key)
    conflict = 0
    if operation:
        cid = operation['ciclo_id']
        if operation['tipo'] != kind or value is not None and centavos(operation['valor']) != centavos(value):
            state, reason, conflict = 'verificar', 'evidência diverge da operação gravada', 1
        else:
            state, value = 'confirmado', operation['valor']
    if old:
        if old['tipo'] != kind:
            raise Conflito('tipo divergente para o mesmo pedido')
        cid = old['ciclo_id']
        if observed < old['observado_em'] or (observed == old['observado_em'] and rev < old['revision']):
            return {'status': 'duplicado', 'ciclo_id': cid, 'estado': old['estado']}
        # Decisao manual do painel (✓/✕) e definitiva enquanto nao existir operacao: um 'verificar'
        # tardio da extensao (a casa expirando o pedido gemeo) nao pode reabrir o que o operador
        # fechou. Dinheiro real continua vencendo: com operacao gravada, o bloco acima ja decidiu.
        if old['origem'] == 'painel' and old['estado'] in ('confirmado', 'falhou') and origin != 'painel' and not operation:
            return {'status': 'duplicado', 'ciclo_id': cid, 'estado': old['estado']}
        if old['estado'] in ('confirmado', 'falhou') and state not in ('confirmado', 'falhou', 'verificar'):
            return {'status': 'duplicado', 'ciclo_id': cid, 'estado': old['estado']}
        if old['estado'] in ('confirmado', 'falhou') and state in ('confirmado', 'falhou') and old['estado'] != state:
            state, reason, conflict = 'verificar', 'evidências finais divergentes', 1
        value = old['valor'] if value is None else value
        official = old['data'] if official is None else official
        rev = max(rev, old['revision'])
    c.execute('''INSERT INTO pedidos(casa,conta,numero_pedido,tipo,ciclo_id,valor,estado,motivo,
        origem,data,observado_em,recebido_em,revision,contexto,conflito) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(casa,conta,numero_pedido) DO UPDATE SET valor=excluded.valor,estado=excluded.estado,
        motivo=excluded.motivo,origem=excluded.origem,data=excluded.data,observado_em=excluded.observado_em,
        recebido_em=excluded.recebido_em,revision=excluded.revision,contexto=excluded.contexto,conflito=excluded.conflito''',
        (*key, kind, cid, value, state, reason, origin, official, observed, received, rev, ctx, conflict))
    c.execute('''INSERT INTO pedido_eventos(casa,conta,numero_pedido,ciclo_id,estado,motivo,
        observado_em,recebido_em,revision,valor,origem) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
        (*key, cid, state, reason, observed, received, rev, value, origin))
    return {'status': 'ok', 'ciclo_id': cid, 'estado': state}


@_api
def add_pedido(d):
    objeto(d)
    with _lock, _c() as c:
        return _receipt(c, d, 'pedido', lambda: _pedido_upsert(c, d))


def pedidos_lista(todos=False):
    with _lock, _c() as c:
        sql = 'SELECT * FROM pedidos'
        if not todos:
            sql += " WHERE estado NOT IN ('confirmado','falhou') OR conflito=1"
        out = [dict(r) for r in c.execute(sql + ' ORDER BY observado_em DESC,casa,conta,numero_pedido')]
        # A casa cria DOIS pedidos para o mesmo deposito. Reconhecer o par exige janela de tempo:
        # medido em 12/09 sobre 161 pares reais, gemeo da casa aparece em ate 5 min e redeposito
        # legitimo da mesma conta e valor so acontece 1 h depois — a faixa entre 5 min e 1 h e
        # VAZIA. JANELA_GEMEO fica no meio dela. Sem janela, um redeposito de valor repetido seria
        # escondido como sobra, que e pior do que mostrar sobra a mais.
        gravados = {}
        for r in c.execute("SELECT casa,conta,valor,numero_pedido,observado_em,recebido_em FROM operacoes WHERE tipo='deposito' ORDER BY id"):
            gravados.setdefault((r['casa'], r['conta'], centavos(r['valor'])), []).append(
                (r['numero_pedido'], r['observado_em'] or r['recebido_em']))
        abertos = {}
        for row in out:
            row['contexto'] = json.loads(row['contexto'] or '{}')
            if row['tipo'] != 'deposito' or row['estado'] not in ('processando', 'verificar') or row['valor'] is None:
                continue
            key = (row['casa'], row['conta'], centavos(row['valor']))
            # sobra_de: o par ja virou operacao no livro (qualquer ciclo), perto no tempo
            melhor = None
            for number, when in gravados.get(key, ()):
                if number == row['numero_pedido']:
                    continue
                gap = _intervalo(row['observado_em'], when)
                if gap is not None and gap <= JANELA_GEMEO and (melhor is None or gap < melhor[1]):
                    melhor = (number, gap)
            row['sobra_de'] = melhor[0] if melhor else None
            row['gemeo_de'] = None   # sempre presente no pedido aberto: o painel testa o campo
            abertos.setdefault(key, []).append(row)
        # gemeo_de: os DOIS pedidos ainda abertos (nenhum pago) — sem isto o painel mostrava a
        # mesma conta e o mesmo valor em duas linhas, parecendo deposito em dobro.
        for grupo in abertos.values():
            grupo.sort(key=lambda r: (r['observado_em'], r['numero_pedido']))
            first = grupo[0]
            for row in grupo[1:]:
                gap = _intervalo(first['observado_em'], row['observado_em'])
                if gap is not None and gap <= JANELA_GEMEO:
                    row['gemeo_de'] = first['numero_pedido']
        # "Primeiro visto": observado_em é RENOVADO a cada releitura (upsert), então a idade do pedido
        # zerava toda vez que o extrato era reaberto e o corte de 30 min do acompanhamento nunca chegava.
        # pedido_eventos guarda cada observação; a MENOR é quando ele apareceu — relógio estável.
        _anexar_primeiro_visto(c, out)
        return out


def _anexar_primeiro_visto(c, linhas, lote=400):
    primeiro, numeros = {}, sorted({r['numero_pedido'] for r in linhas if r.get('numero_pedido')})
    for i in range(0, len(numeros), lote):
        parte = numeros[i:i + lote]
        for e in c.execute('SELECT casa,conta,numero_pedido,MIN(observado_em) m FROM pedido_eventos WHERE numero_pedido IN (%s) '
                           'GROUP BY casa,conta,numero_pedido' % ','.join('?' * len(parte)), parte):
            primeiro[(e['casa'], e['conta'], e['numero_pedido'])] = e['m']
    for r in linhas:
        r['primeiro_em'] = primeiro.get((r['casa'], r['conta'], r['numero_pedido'])) or r['observado_em']


@_api
def add_pendente(d):
    objeto(d)
    key = _identity(d, incomplete=True)
    value = dinheiro(d.get('valor'), 'valor', nulo=True)
    with _lock, _c() as c:
        def apply():
            if c.execute('SELECT 1 FROM operacoes WHERE casa=? AND conta=? AND numero_pedido=?', key).fetchone():
                return {'status': 'duplicado'}
            cid, _ = _origin_cycle(c, d, key)
            c.execute('''INSERT INTO pendentes(casa,conta,numero_pedido,ciclo_id,valor,visto_em) VALUES(?,?,?,?,?,?)
                ON CONFLICT(casa,conta,numero_pedido) DO UPDATE SET valor=COALESCE(excluded.valor,pendentes.valor),visto_em=excluded.visto_em''',
                (*key, cid, value, agora()))
            return _pedido_upsert(c, dict(d, tipo='deposito', estado='processando', motivo=d.get('motivo', 'aguardando confirmação')))
        return _receipt(c, d, 'pendente', apply)


def pendentes_lista():
    with _lock, _c() as c:
        return [dict(r) for r in c.execute('SELECT * FROM pendentes ORDER BY visto_em DESC,casa,conta,numero_pedido')]


def _select_identity(c, table, value, cid=None):
    d = value if isinstance(value, dict) else {'numero_pedido': value}
    order = identidade(d.get('numero_pedido'), 'numero_pedido')
    sql, args = 'SELECT * FROM ' + table + ' WHERE numero_pedido=?', [order]
    for key in ('casa', 'conta'):
        if key in d:
            sql += ' AND ' + key + ' IS ?'
            args.append(d[key])
    if cid is not None:
        sql += ' AND ciclo_id=?'
        args.append(cid)
    rows = list(c.execute(sql, args))
    if len(rows) > 1:
        raise Conflito('pedido ambíguo; informe casa e conta')
    return rows[0] if rows else None


@_api
def del_pendente(value):
    with _lock, _c() as c:
        row = _select_identity(c, 'pendentes', value)
        if row:
            key = (row['casa'], row['conta'], row['numero_pedido'])
            c.execute('DELETE FROM pendentes WHERE casa IS ? AND conta IS ? AND numero_pedido=?', key)
            c.execute("UPDATE pedidos SET estado='falhou',motivo='encerrado manualmente',recebido_em=? WHERE casa IS ? AND conta IS ? AND numero_pedido=?", (agora(), *key))
        return {'status': 'ok', 'removidos': int(row is not None)}


@_api
def add_operacao(d):
    objeto(d)
    key = _identity(d)
    kind = d.get('tipo')
    if kind not in ('deposito', 'saque'):
        raise Invalido('tipo inválido')
    value = dinheiro(d.get('valor'), 'valor')
    if value <= 0:
        raise Invalido('operação requer valor positivo')
    if 'estado' in d and d['estado'] not in ('confirmado', 'concluido', 'sucesso'):
        raise Invalido('operação sem conclusão confirmada')
    official, observed, received = _times(d)
    origin = texto(d.get('origem', ''), 'origem', vazio=True)
    with _lock, _c() as c:
        def apply():
            cid, cycle_reason = _origin_cycle(c, d, key)
            # Depósito não traz hora oficial na confirmação; a CRIAÇÃO do PIX (paysubmit) traz, e fica no
            # pedido. A operação herda essa hora (o ciclo já vem do pedido via pedido_original).
            oficial, bruto = official, (str(d['data']) if d.get('data') is not None else None)
            if oficial is None:
                prow = c.execute('SELECT data FROM pedidos WHERE casa=? AND conta=? AND numero_pedido=?', key).fetchone()
                if prow and prow['data']:
                    oficial = prow['data']
            old = c.execute('SELECT * FROM operacoes WHERE casa=? AND conta=? AND numero_pedido=?', key).fetchone()
            if old:
                cid = old['ciclo_id']
                if old['tipo'] != kind or centavos(old['valor']) != centavos(value):
                    raise Conflito('valor/tipo divergente para o mesmo pedido')
                status = 'duplicado'
                if old['data'] is None and oficial is not None:
                    c.execute('UPDATE operacoes SET data=?,data_original=?,observado_em=?,recebido_em=? WHERE id=?',
                              (oficial, bruto, observed, received, old['id']))
                    status = 'enriquecido'
            else:
                if c.execute('SELECT 1 FROM descartados WHERE numero_pedido=? AND (casa IS NULL OR casa=?) AND (conta IS NULL OR conta=?)',
                             (key[2], key[0], key[1])).fetchone():
                    return {'status': 'descartado', 'ciclo_id': cid}
                c.execute('''INSERT INTO operacoes(ciclo_id,numero_pedido,tipo,valor,casa,conta,data,
                    origem,created_at,data_original,observado_em,recebido_em,ciclo_motivo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (cid, key[2], kind, value, key[0], key[1], oficial, origin, received,
                     bruto, observed, received, cycle_reason))
                status = 'ok'
            c.execute('DELETE FROM pendentes WHERE casa=? AND conta=? AND numero_pedido=?', key)
            pending = c.execute('SELECT * FROM pedidos WHERE casa=? AND conta=? AND numero_pedido=?', key).fetchone()
            if pending:
                _pedido_upsert(c, dict(d, estado='confirmado', motivo='operação financeira gravada', observado_em=max(observed, pending['observado_em'])))
            if status != 'duplicado':
                c.execute("INSERT INTO controles VALUES('last_op_ts',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (received,))
            return {'status': status, 'tipo': kind, 'valor': value, 'casa': key[0], 'conta': key[1], 'numero_pedido': key[2], 'ciclo_id': cid}
        return _receipt(c, d, 'operation', apply)


@_api
def set_ajuste(d):
    objeto(d)
    house = identidade(d.get('casa'), 'casa')
    with _lock, _c() as c:
        _expected(c, d)
        cid = _ciclo(c)
        if d.get('deposito') in (None, ''):
            c.execute('DELETE FROM ajustes WHERE ciclo_id=? AND casa=?', (cid, house))
            return {'status': 'removido'}
        dep = dinheiro(d['deposito'], 'deposito')
        count = numero(d.get('contas'), 'contas', inteiro=True, nulo=True)
        unit = d.get('unidade_contador', 'desconhecida')
        if unit not in ('contas', 'pessoas', 'depositos', 'desconhecida'):
            raise Invalido('unidade_contador inválida')
        c.execute('''INSERT INTO ajustes(ciclo_id,casa,deposito,contas,atualizado_em,unidade_contador,fonte,periodo)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(ciclo_id,casa) DO UPDATE SET deposito=excluded.deposito,
            contas=excluded.contas,atualizado_em=excluded.atualizado_em,unidade_contador=excluded.unidade_contador,
            fonte=excluded.fonte,periodo=excluded.periodo''',
            (cid, house, dep, count, agora(), unit, texto(d.get('fonte', 'manual'), 'fonte'), texto(d.get('periodo', 'ciclo'), 'periodo')))
        return {'status': 'ok', 'casa': house, 'deposito': dep, 'contas': count}


def ajustes_lista():
    with _lock, _c() as c:
        return [dict(r) for r in c.execute('SELECT * FROM ajustes WHERE ciclo_id=? ORDER BY casa', (_ciclo(c),))]


def _raw_summary(c, cid):
    groups = {}
    for r in c.execute('SELECT casa,conta,tipo,valor FROM operacoes WHERE ciclo_id=?', (cid,)):
        key = (r['casa'], r['conta'])
        row = groups.setdefault(key, {'casa': key[0], 'conta': key[1], 'qd': 0, 'td': 0, 'qs': 0, 'ts': 0})
        q, total = ('qs', 'ts') if r['tipo'] == 'saque' else ('qd', 'td')
        row[q] += 1
        row[total] += centavos(r['valor'] or 0)
    rows = []
    for r in groups.values():
        r['td'], r['ts'] = r['td'] / 100, r['ts'] / 100
        r['resultado'] = (centavos(r['ts']) - centavos(r['td'])) / 100
        rows.append(r)
    rows.sort(key=lambda r: (-r['resultado'], r['casa'] or '', r['conta'] or ''))
    dep, withdraw = sum(centavos(r['td']) for r in rows), sum(centavos(r['ts']) for r in rows)
    return {'ciclo_id': cid, 'qtd_depositos': sum(r['qd'] for r in rows), 'qtd_saques': sum(r['qs'] for r in rows),
            'total_depositos': dep / 100, 'total_saques': withdraw / 100, 'resultado': (withdraw - dep) / 100, 'contas': rows}


def _effective(c, cid, gerente=0, bau=0, saque_manual=0):
    houses = {}
    for r in _raw_summary(c, cid)['contas']:
        h = houses.setdefault(r['casa'] or '?', {'casa': r['casa'] or '?', 'deposito': 0, 'saque': 0,
            'contas': 0, 'depositos': 0, 'saques': 0, 'oficial': False, 'contas_completas': True})
        h['deposito'] += centavos(r['td'])
        h['saque'] += centavos(r['ts'])
        h['depositos'] += r['qd']
        h['saques'] += r['qs']
        if r['qd'] and r['conta']:
            h['contas'] += 1
        elif r['qd']:
            h['contas_completas'] = False
    ajustes = [dict(a) for a in c.execute('SELECT * FROM ajustes WHERE ciclo_id=?', (cid,))]
    # O "Usar depósito oficial" da Conta Mãe grava na chave da MÃE ('rolamento'), mas as operações estão
    # na chave da FILHA ('p1-rolamentopg'). Antes o ajuste virava uma casa a mais e SOMAVA: em 24/09 o
    # ciclo 20 foi a R$ 30.185 (15.159 da mãe + 15.026 capturados) e o Ao Vivo da operação nem via o
    # oficial. Agora o oficial substitui o depósito das filhas daquela mãe.
    orfaos = [a for a in ajustes if a['casa'] not in houses]
    mapa = _mapa_mae(__import__('dados_identidade').snapshot(c)) if orfaos else {}
    for a in orfaos:
        if a['deposito'] is None:
            continue
        filhas = [k for k in houses if k != a['casa'] and _filha_da_mae(k, a['casa'], mapa)]
        if len(filhas) == 1:
            a['casa'] = filhas[0]        # uma filha: o oficial entra nela (é o que o Ao Vivo mostra)
        else:
            for k in filhas:             # várias filhas numa mãe: o total da mãe cobre todas
                houses[k]['deposito'] = 0
                houses[k]['oficial'] = True
                houses[k]['contas_completas'] = False
    for a in ajustes:
        h = houses.setdefault(a['casa'], {'casa': a['casa'], 'deposito': 0, 'saque': 0, 'contas': 0,
            'depositos': 0, 'saques': 0, 'oficial': False, 'contas_completas': False})
        if a['deposito'] is not None:
            h['deposito'] = centavos(a['deposito'])
            h['oficial'] = True
            h['contas_completas'] = False
        if a['contas'] is not None and a['unidade_contador'] in ('contas', 'pessoas'):
            h['contas'] = a['contas']
            h['contas_completas'] = True
    dep = sum(h['deposito'] for h in houses.values())
    withdraw = sum(h['saque'] for h in houses.values()) + centavos(saque_manual)
    if withdraw < 0:
        raise Invalido('saque final não pode ser negativo')
    bonus = centavos(gerente) * 10 + centavos(bau) * 10
    complete = all(h['contas_completas'] for h in houses.values())
    count = sum(h['contas'] for h in houses.values()) if complete else None
    for h in houses.values():
        h['resultado'] = (h['saque'] - h['deposito']) / 100
        h['deposito'], h['saque'] = h['deposito'] / 100, h['saque'] / 100
        if not h['contas_completas']:
            h['contas'] = None
    return {'deposito': dep / 100, 'saque': withdraw / 100, 'contas': count,
            'gerente_bau': bonus / 100, 'resultado': (withdraw - dep + bonus) / 100,
            'saque_manual': saque_manual, 'por_casa': sorted(houses.values(), key=lambda h: h['casa']),
            'contas_completas': complete, 'ciclo_id': cid,
            'qtd_depositos': sum(h['depositos'] for h in houses.values()), 'qtd_saques': sum(h['saques'] for h in houses.values())}


def resumo():
    with _lock, _c() as c:
        result = _raw_summary(c, _ciclo(c))
        result['efetivo'] = _effective(c, _ciclo(c))
        return result


@_api
def fechar_ciclo(d):
    objeto(d)
    fid = texto(d.get('fechamento_id'), 'fechamento_id')
    cid = numero(d.get('ciclo_id'), 'ciclo_id', inteiro=True, minimo=1)
    metas = d.get('metas_ids')
    if not isinstance(metas, list) or len(metas) > 1000:
        raise Invalido('metas_ids deve ser lista')
    metas = [texto(v, 'meta_id') for v in metas]
    if len(set(metas)) != len(metas):
        raise Invalido('metas duplicadas')
    gerente, bau = dinheiro(d.get('gerente'), 'gerente'), dinheiro(d.get('bau'), 'bau')
    manual = dinheiro(d.get('saque_manual', 0), 'saque_manual', minimo=None)
    with _lock, _c() as c:
        old = c.execute('SELECT * FROM fechamentos WHERE fechamento_id=?', (fid,)).fetchone()
        if old:
            if (cid, serializar(metas), gerente, bau, manual) != (old['ciclo_id'], old['metas_ids'], old['gerente'], old['bau'], old['saque_manual']):
                raise Conflito('fechamento_id reutilizado com parâmetros diferentes')
            return json.loads(old['resposta'])
        if _ciclo(c) != cid:
            raise Conflito('ciclo já fechado ou diferente do atual')
        _expected(c, d)
        revision = _versao(c)
        summary = _effective(c, cid, gerente, bau, manual)
        new_cid = _new_cycle(c)
        # o fechamento tambem vira ciclo: sem esta linha o registro so pegava o "Zerar" e um
        # fechamento legitimo passava sem rastro — foi o que aconteceu no ciclo 13
        _registrar_ciclo(c, cid, new_cid, 'fechamento')
        result = {'status': 'ok', 'fechamento_id': fid, 'ciclo_id': cid, 'novo_ciclo_id': new_cid,
                  'resumo': summary, 'metas_ids': metas, 'versao': revision}
        c.execute('INSERT INTO fechamentos VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                  (fid, cid, new_cid, revision, serializar(metas), gerente, bau, manual, serializar(summary), serializar(result), agora()))
        return result


def operacoes(limit=200, ciclo_id=None):
    limit = numero(limit, 'limit', inteiro=True, minimo=1)
    with _lock, _c() as c:
        rows = [dict(r) for r in c.execute('SELECT * FROM operacoes WHERE ciclo_id=?', (ciclo_id or _ciclo(c),))]
        def order(row):
            stamp = instante(row['data'], nulo=True) or instante(row['created_at'], nulo=True) or ''
            ident = row['numero_pedido'] or ''
            return (stamp, (1, int(ident)) if ident.isdecimal() else (0, ident), row['id'])
        rows.sort(key=order, reverse=True)
        return rows[:min(limit, 10000)]


@_api
def del_operacao(value):
    with _lock, _c() as c:
        row = _select_identity(c, 'operacoes', value, _ciclo(c))
        if not row:
            return {'status': 'nao_encontrado', 'removidos': 0}
        c.execute('INSERT OR IGNORE INTO descartados(ciclo_id,casa,conta,numero_pedido,ts) VALUES(?,?,?,?,?)',
                  (row['ciclo_id'], row['casa'], row['conta'], row['numero_pedido'], agora()))
        c.execute('DELETE FROM operacoes WHERE id=?', (row['id'],))
        return {'status': 'ok', 'removidos': 1}


@_api
def restaurar_descartado(value):
    with _lock, _c() as c:
        row = _select_identity(c, 'descartados', value, _ciclo(c))
        if row:
            c.execute('DELETE FROM descartados WHERE ciclo_id=? AND casa IS ? AND conta IS ? AND numero_pedido=?',
                      (row['ciclo_id'], row['casa'], row['conta'], row['numero_pedido']))
        return {'status': 'ok'}


# "Limpar" das caixas de coisa ja resolvida (exclusoes do ciclo, associacoes de casa ja feitas).
# E uma MARCA D'AGUA, nao um delete: a lapide do descartado e o historico de identidade continuam
# inteiros — some da tela o que e anterior a marca, e o que acontecer depois volta a aparecer.
DISPENSAVEIS = ('descartados', 'identidades', 'vigia')


def _dispensados(c):
    try:
        saved = json.loads(_get_control(c, 'dispensados', '{}'))
    except ValueError:
        saved = {}
    if not isinstance(saved, dict):
        return {}
    return {k: v for k, v in saved.items() if k in DISPENSAVEIS and isinstance(v, str)}


@_api
def set_dispensado(d):
    objeto(d)
    tipo = texto(d.get('tipo'), 'tipo')
    if tipo not in DISPENSAVEIS:
        raise Invalido('tipo não pode ser dispensado')
    with _lock, _c() as c:
        atual = _dispensados(c)
        atual[tipo] = instante(d.get('ate', agora()), 'ate')
        c.execute("INSERT INTO controles VALUES('dispensados',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                  (serializar(atual),))
        return {'status': 'ok', 'dispensados': atual}


def descartados_lista():
    with _lock, _c() as c:
        return [dict(r) for r in c.execute('SELECT * FROM descartados WHERE ciclo_id=? ORDER BY ts DESC', (_ciclo(c),))]


@_api
def limpar_operacoes(escopo='operacoes'):
    if escopo not in ('operacoes', 'jogos', 'tudo'):
        raise Invalido('escopo inválido')
    with _lock, _c() as c:
        counts = {'operacoes': 0, 'jogos': 0}
        for table in counts:
            if escopo in (table, 'tudo'):
                counts[table] = c.execute('DELETE FROM ' + table + ' WHERE ciclo_id=?', (_ciclo(c),)).rowcount
        return {'status': 'ok', 'removidos': counts}


@_api
def set_conta(d):
    objeto(d)
    house, account = identidade(d.get('casa'), 'casa'), identidade(d.get('conta'), 'conta')
    vals = {}
    for field, column in (('status','status'), ('saldo','saldo'), ('bonus','bonus'), ('totalCharge','total_charge'), ('totalWithdraw','total_withdraw')):
        if field in d:
            vals[column] = numero(d[field], field, nulo=True, inteiro=field == 'status')
    with _lock, _c() as c:
        # Recibo com eco de event_id, como nas outras rotas de captura. A filha exige o eco
        # (background.js) e sem ele todo evento de conta falhava o ACK: em 12/09 havia 51 de 117
        # instalacoes presas em 'ack_event_id' com fila que nunca esvaziava.
        def apply():
            c.execute('INSERT OR IGNORE INTO contas(casa,conta) VALUES(?,?)', (house, account))
            vals['atualizado_em'] = agora()
            c.execute('UPDATE contas SET ' + ','.join(k+'=?' for k in vals) + ' WHERE casa=? AND conta=?', (*vals.values(), house, account))
            _permissoes(c, house, account, d)
            return {'status': 'ok'}
        return _receipt(c, d, 'conta', apply)


# --- permissoes da conta (descoberta) --------------------------------------------------------
# A casa manda, junto do login, um vetor userOptResult e um auditMode. O painel so usava
# user_status, que veio 1 em TODAS as 92 leituras arquivadas — enquanto o vetor varia entre contas
# ([1,0,1,0,1] em 54, [0,0,1,0,1] em 33, [1,0,0,0,1] em 5). Ou seja: "saque proibido" e "bau
# proibido" provavelmente moram nele, nao no status. Guardado aqui SEM interpretacao: sem uma
# conta que o operador saiba estar proibida, dizer qual posicao e qual seria chute.
PERMISSOES_CHAVE = 'contas_permissoes'
LIMITE_PERMISSOES = 400


def _permissoes(c, house, account, d):
    bruto = d.get('permissoes')
    auditoria = d.get('auditoria')
    sinais = d.get('sinais') if isinstance(d.get('sinais'), dict) else None
    erro = d.get('erro_login')
    if not isinstance(bruto, list) and auditoria is None and not sinais and erro is None:
        return
    linha = {'quando': agora()}
    # Conta que fica anormal FALHA o login: o user_status nunca e relido e o painel seguiria
    # mostrando o ultimo estado bom. Zero = login voltou a funcionar, entao o erro sai.
    if erro is not None:
        codigo = numero(erro, 'erro_login', inteiro=True, minimo=None)
        if codigo:
            linha['erro'] = codigo
            linha['erro_em'] = agora()
    if sinais:
        # so numero: o nome com cara de credencial ja caiu no classify e de novo no worker
        linha['sinais'] = {texto(k, 'sinal', limite=40): numero(v, 'sinal', inteiro=False, nulo=True, minimo=None)
                           for k, v in list(sinais.items())[:80]}
    if isinstance(bruto, list):
        linha['opt'] = [numero(x, 'permissao', inteiro=True, nulo=True, minimo=None) for x in bruto[:20]]
    if auditoria is not None:
        linha['audit'] = numero(auditoria, 'auditoria', inteiro=True, nulo=True, minimo=None)
    try:
        guardado = json.loads(_get_control(c, PERMISSOES_CHAVE, '{}'))
        if not isinstance(guardado, dict):
            guardado = {}
    except ValueError:
        guardado = {}
    chave = house + '|' + account
    if chave not in guardado and len(guardado) >= LIMITE_PERMISSOES:
        return
    # o login bom apaga o erro; o erro novo preserva o que ja se sabia da conta
    antigo = guardado.get(chave) or {}
    if 'erro' not in linha:
        guardado[chave] = dict(antigo, **linha)
        guardado[chave].pop('erro', None)
        guardado[chave].pop('erro_em', None)
    else:
        guardado[chave] = dict(antigo, **linha)
    c.execute("INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
              (PERMISSOES_CHAVE, serializar(guardado)))


def validar_permissoes(obj):
    objeto(obj)
    if len(obj) > LIMITE_PERMISSOES:
        raise Invalido('permissões demais')
    for chave, linha in obj.items():
        texto(chave, 'conta', limite=200)
        objeto(linha)
        if set(linha) - {'opt', 'audit', 'quando', 'sinais', 'erro', 'erro_em'}:
            raise Invalido('permissão com campo desconhecido')
        if linha.get('erro') is not None:
            numero(linha['erro'], 'erro', inteiro=True, minimo=None)
            instante(linha.get('erro_em'))
        if linha.get('sinais') is not None:
            objeto(linha['sinais'])
            if len(linha['sinais']) > 80:
                raise Invalido('sinais demais')
            for nome, valor in linha['sinais'].items():
                texto(nome, 'sinal', limite=40)
                numero(valor, 'sinal', nulo=True, minimo=None)
        instante(linha.get('quando'))
        if linha.get('opt') is not None:
            if not isinstance(linha['opt'], list) or len(linha['opt']) > 20:
                raise Invalido('vetor de permissões inválido')
            for x in linha['opt']:
                numero(x, 'permissao', inteiro=True, nulo=True, minimo=None)
        if linha.get('audit') is not None:
            numero(linha['audit'], 'auditoria', inteiro=True, minimo=None)


def _permissoes_cru(c):
    try:
        g = json.loads(_get_control(c, PERMISSOES_CHAVE, '{}'))
    except ValueError:
        g = {}
    return g if isinstance(g, dict) else {}


def contas_permissoes():
    with _lock, _c() as c:
        try:
            g = json.loads(_get_control(c, PERMISSOES_CHAVE, '{}'))
        except ValueError:
            g = {}
        return g if isinstance(g, dict) else {}


def contas_lista():
    with _lock, _c() as c:
        return [dict(r) for r in c.execute('SELECT casa,conta,status,saldo,bonus,total_charge,total_withdraw,atualizado_em FROM contas ORDER BY casa,conta')]


def get_sessao(casa, conta):
    return None


def limpar_contas():
    with _lock, _c() as c:
        return {'status': 'ok', 'removidos': c.execute('DELETE FROM contas').rowcount}


@_api
def set_foco(casas):
    if not isinstance(casas, list) or len(casas) > 1000:
        raise Invalido('casas deve ser lista')
    houses = sorted(set(identidade(h, 'casa') for h in casas))
    with _lock, _c() as c:
        c.execute('DELETE FROM foco')
        c.executemany('INSERT INTO foco VALUES(?,?)', [(h, agora()) for h in houses])
        return {'status': 'ok', 'foco': houses}


def foco_lista():
    with _lock, _c() as c:
        import dados_identidade
        return dados_identidade.expand(c,[r['casa'] for r in c.execute('SELECT casa FROM foco ORDER BY casa')])


@_api
def set_encerrada(casa, on=True):
    house, on = identidade(casa, 'casa'), booleano(on, 'on')
    with _lock, _c() as c:
        if on:
            c.execute('INSERT OR IGNORE INTO encerradas VALUES(?,?)', (house, agora()))
            c.execute('DELETE FROM foco WHERE casa=?', (house,))
        else:
            import dados_identidade
            for key in dados_identidade.expand(c,[house]):
                c.execute('DELETE FROM encerradas WHERE casa=?', (key,))
        return {'status': 'ok', 'casa': house, 'encerrada': on}


def encerradas_lista():
    with _lock, _c() as c:
        import dados_identidade
        return dados_identidade.expand(c,[r['casa'] for r in c.execute('SELECT casa FROM encerradas ORDER BY casa')])


def periodo_ciclo():
    with _lock, _c() as c:
        return _get_control(c, 'periodo', 'mes')


@_api
def set_periodo(d):
    objeto(d)
    period = d.get('periodo')
    if period not in ('hoje', 'ontem', 'mes', 'semana', 'ultima'):
        raise Invalido('período de navegação inválido')
    with _lock, _c() as c:
        _expected(c, d)
        c.execute("INSERT INTO controles VALUES('periodo',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (period,))
        return {'status': 'ok', 'periodo': period, 'versao': _versao(c)}


def _extras(c):
    """Valores que o operador digita e que ENTRAM no fechamento: gerente, BAU e saque conferido
    à mão. Viviam só no localStorage, então fechar o ciclo por outro navegador congelava um
    resultado diferente — dinheiro errado sem aviso. Guardados por ciclo; ciclo novo começa limpo."""
    cid = _ciclo(c)
    try:
        saved = json.loads(_get_control(c, 'extras', '{}'))
    except ValueError:
        saved = {}
    if not isinstance(saved, dict) or saved.get('ciclo_id') != cid:
        return {'ciclo_id': cid, 'gerente': None, 'bau': None, 'saque_manual': {}}
    manual = saved.get('saque_manual')
    return {'ciclo_id': cid, 'gerente': saved.get('gerente'), 'bau': saved.get('bau'),
            'saque_manual': manual if isinstance(manual, dict) else {}}


# --- estado do painel (metas, lucros, formularios, PIX, cronograma) --------------------------
# Tudo isso vivia SO no localStorage: limpar cache, trocar de navegador ou de PC levava junto a
# contabilidade, e a copia diaria do banco nao salvava nada. Agora o painel espelha o estado aqui,
# entao entra no banco, no backup e vale em qualquer navegador.
PAINEL_CHAVE, PAINEL_HISTORICO = 'painel_estado', 'painel_metas_historico'
PAINEL_LIMITE = 2 * 1024 * 1024        # 2 MB serializado
# casaChave (vínculo meta->casa gravado ao operar) e fechamentoParcial (ciclo em que a operação dela
# fechou) entraram no painel em 22/09 sem entrar aqui: TODA gravação do espelho passou a ser recusada
# ("meta com campo desconhecido") e a cópia do servidor parou em 24/09 13:34 sem ninguém ver.
CAMPOS_META = ('id', 'plataforma', 'inicio', 'fimManual', 'ok', 'depositantes', 'lucro',
               'fechamento_id', 'meta', 'obs', 'casaChave', 'fechamentoParcial')


def validar_metas(lista):
    """As metas sao dinheiro: validadas campo a campo, nao aceitas como bloco opaco."""
    if not isinstance(lista, list) or len(lista) > 500:
        raise Invalido('metas deve ser lista')
    saida, vistos = [], set()
    for m in lista:
        objeto(m)
        if set(m) - set(CAMPOS_META):
            raise Invalido('meta com campo desconhecido')
        mid = texto(m.get('id'), 'id', limite=64)
        if mid in vistos:
            raise Conflito('meta repetida')
        vistos.add(mid)
        linha = dict(m)
        linha['id'] = mid
        linha['plataforma'] = texto(m.get('plataforma') or '', 'plataforma', vazio=True, limite=120)
        linha['ok'] = booleano(m.get('ok', False), 'ok')
        linha['depositantes'] = numero(m.get('depositantes'), 'depositantes', inteiro=True, nulo=True)
        linha['lucro'] = dinheiro(m.get('lucro'), 'lucro', nulo=True, minimo=None)
        for campo in ('casaChave', 'fechamentoParcial'):
            if campo in m:
                valor = m[campo]
                linha[campo] = None if valor in (None, '') else texto(str(valor), campo, limite=120)
        for campo in ('inicio', 'fimManual'):
            valor = m.get(campo)
            if valor in (None, ''):
                linha[campo] = None
            elif not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(valor)):
                raise Invalido(campo + ' deve ser uma data AAAA-MM-DD')
        saida.append(linha)
    return saida


def _painel(c):
    try:
        guardado = json.loads(_get_control(c, PAINEL_CHAVE, '{}'))
    except ValueError:
        guardado = {}
    return guardado if isinstance(guardado, dict) else {}


def painel_estado():
    with _lock, _c() as c:
        return _painel(c)


def painel_metas_historico():
    with _lock, _c() as c:
        try:
            h = json.loads(_get_control(c, PAINEL_HISTORICO, '[]'))
        except ValueError:
            h = []
        return h if isinstance(h, list) else []


@_api
def set_painel(d):
    objeto(d)
    estado = objeto(d.get('estado'))
    metas = validar_metas(estado.get('operacoes')) if 'operacoes' in estado else None
    if metas is not None:
        estado = dict(estado, operacoes=metas)
    corpo = serializar(estado)
    if len(corpo.encode('utf-8')) > PAINEL_LIMITE:
        raise Invalido('estado do painel grande demais')
    with _lock, _c() as c:
        guardado = _painel(c)
        antigas = (guardado.get('estado') or {}).get('operacoes') or []
        # Guarda que importa: um navegador recem-aberto, sem nada, NAO apaga a contabilidade que ja
        # esta no servidor. Zerar de proposito continua possivel, mas tem de dizer que e de proposito.
        if antigas and metas is not None and not metas and d.get('confirmado') is not True:
            raise Conflito('apagar todas as metas exige confirmação explícita')
        revisao = int(guardado.get('revisao') or 0) + 1
        # Historico SO das metas (pequeno) e so quando elas mudam: e o unico undo de contabilidade
        # que existe. O resto do estado guarda apenas a versao atual.
        if metas is not None and serializar(antigas) != serializar(metas) and antigas:
            try:
                historico = json.loads(_get_control(c, PAINEL_HISTORICO, '[]'))
                if not isinstance(historico, list):
                    historico = []
            except ValueError:
                historico = []
            historico.append({'revisao': int(guardado.get('revisao') or 0),
                              'quando': guardado.get('atualizado_em') or agora(), 'metas': antigas})
            c.execute("INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                      (PAINEL_HISTORICO, serializar(historico[-20:])))
        c.execute("INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                  (PAINEL_CHAVE, serializar({'revisao': revisao, 'atualizado_em': agora(), 'estado': estado})))
        return {'status': 'ok', 'revisao': revisao, 'metas': len(metas) if metas is not None else None,
                'bytes': len(corpo.encode('utf-8'))}


def extras():
    with _lock, _c() as c:
        return _extras(c)


@_api
def set_extras(d):
    objeto(d)
    with _lock, _c() as c:
        _expected(c, d)
        atual = _extras(c)
        for campo in ('gerente', 'bau'):
            if campo in d:
                atual[campo] = None if d[campo] in (None, '') else dinheiro(d[campo], campo)
        if 'saque_manual' in d:
            entrada = d['saque_manual']
            objeto(entrada)
            manual = dict(atual['saque_manual'])
            for casa, valor in entrada.items():
                chave = identidade(casa, 'casa')
                if valor in (None, ''):
                    manual.pop(chave, None)
                else:
                    manual[chave] = dinheiro(valor, 'saque_manual', minimo=None)
            atual['saque_manual'] = manual
        c.execute("INSERT INTO controles VALUES('extras',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                  (serializar(atual),))
        return {'status': 'ok', **atual}


def _metas_casa(c):
    """Alvo de DEPOSITO por casa que o operador digita no card 'Meta por casa'. So o alvo (manual);
    o quanto ja entrou vem de resumo_efetivo.por_casa. Por ciclo — ciclo novo comeca limpo."""
    cid = _ciclo(c)
    try:
        saved = json.loads(_get_control(c, 'metas_por_casa', '{}'))
    except ValueError:
        saved = {}
    if not isinstance(saved, dict) or saved.get('ciclo_id') != cid:
        return {'ciclo_id': cid, 'alvos': {}}
    alvos = saved.get('alvos')
    return {'ciclo_id': cid, 'alvos': alvos if isinstance(alvos, dict) else {}}


def set_meta_casa(d):
    objeto(d)
    with _lock, _c() as c:
        _expected(c, d)
        atual = _metas_casa(c)
        alvos = dict(atual['alvos'])
        entrada = d.get('alvos', d)
        objeto(entrada)
        for casa, valor in entrada.items():
            if casa in ('ciclo_id', 'event_id', 'confirmado', 'expected_versao'):
                continue
            chave = identidade(casa, 'casa')
            if valor in (None, ''):
                alvos.pop(chave, None)
            else:
                alvos[chave] = dinheiro(valor, 'alvo', minimo=None)
        atual['alvos'] = alvos
        c.execute("INSERT INTO controles VALUES('metas_por_casa',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                  (serializar(atual),))
        return {'status': 'ok', **atual}


def _get_control(c, key, default=None):
    row = c.execute('SELECT valor FROM controles WHERE chave=?', (key,)).fetchone()
    return row['valor'] if row else default


@_api
def solicitar_varredura(d=None):
    """Conferencia de saques nas abas. O painel manda em QUAIS casas varrer (as da operacao ao vivo
    ATIVA); lista vazia = todas as abas logadas (comportamento antigo). So carimba o ts + as casas.
    Quem navega e cada aba filha, que IGNORA o comando quando a propria casa nao esta na lista — era
    por isso que o botao mexia em abas de outra operacao. Espelha solicitar_jogo."""
    alvo = (d or {}).get('casas', (d or {}).get('casa', '')) if isinstance(d, dict) else ''
    casas = [identidade(x, 'casa') for x in alvo] if isinstance(alvo, list) else (
        [identidade(alvo, 'casa')] if alvo else [])
    if len(casas) > 20:
        raise Invalido('casas demais no mesmo pedido')
    with _lock, _c() as c:
        stamp = max(int(dt.datetime.now(dt.timezone.utc).timestamp()*1000), int(_get_control(c, 'varrer_saque_ts', '0'))+1)
        c.execute("INSERT INTO controles VALUES('varrer_saque_ts',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (str(stamp),))
        c.execute("INSERT INTO controles VALUES('varrer_saque_casas',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (serializar(casas),))
        return {'status': 'ok', 'ts': stamp, 'casas': casas}


def varredura_atual():
    """{ts, casas} do ultimo pedido de varredura. As abas leem daqui via GET /api/varrer_saque."""
    with _lock, _c() as c:
        try:
            casas = json.loads(_get_control(c, 'varrer_saque_casas', '[]') or '[]')
        except Exception:
            casas = []
        return {'ts': int(_get_control(c, 'varrer_saque_ts', '0')),
                'casas': casas if isinstance(casas, list) else []}


@_api
def registrar_dominios(d):
    """A filha aprende do lobby TODOS os dominios de uma casa (bonito + cloudfront + ELB) e manda
    aqui. Guardamos como aliases (casa bonita -> lista de hosts) para a reconciliacao e a caixa
    'Casas sem nome' resolverem um hash de cloudfront para o nome certo. NAO re-chaveia historico:
    a chave da casa ja vem resolvida da extensao (#3-B); isto e so o mapa informativo."""
    objeto(d)
    casa = identidade(d.get('casa', ''), 'casa')
    if not casa:
        raise Invalido('casa ausente')
    brutos = d.get('dominios') or []
    if not isinstance(brutos, list):
        raise Invalido('dominios invalido')
    limpos = []
    for h in brutos[:40]:
        h = str(h or '').strip().lower()
        if h and re.match(r'^[a-z0-9.\-]{3,80}$', h) and h not in limpos:
            limpos.append(h)
    with _lock, _c() as c:
        try:
            mapa = json.loads(_get_control(c, 'casa_dominios', '{}') or '{}')
            if not isinstance(mapa, dict):
                mapa = {}
        except Exception:
            mapa = {}
        atual = mapa.get(casa) or []
        for h in limpos:
            if h not in atual:
                atual.append(h)
        mapa[casa] = atual[:60]
        c.execute("INSERT INTO controles VALUES('casa_dominios',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (serializar(mapa),))
        return {'status': 'ok', 'casa': casa, 'dominios': len(mapa[casa])}


@_api
def solicitar_jogo(d):
    """Pedido do painel para abrir um jogo. O servidor so CARIMBA o pedido; quem abre e a aba que
    ja esta logada, repetindo o clique que o operador deu uma vez. Nenhum token passa por aqui."""
    objeto(d)
    # O operador escolhe em QUAIS casas abrir: opera duas ao mesmo tempo e nem sempre quer as duas.
    alvo = d.get('casas', d.get('casa', ''))
    casas = [identidade(x, 'casa') for x in alvo] if isinstance(alvo, list) else (
        [identidade(alvo, 'casa')] if alvo else [])
    if len(casas) > 20:
        raise Invalido('casas demais no mesmo pedido')
    gid = identidade(d.get('id_jogo'), 'id_jogo')
    with _lock, _c() as c:
        anterior = json.loads(_get_control(c, 'abrir_jogo', '{}') or '{}')
        stamp = max(int(dt.datetime.now(dt.timezone.utc).timestamp()*1000), int(anterior.get('ts') or 0)+1)
        c.execute("INSERT INTO controles VALUES('abrir_jogo',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                  (serializar({'casas': casas, 'id_jogo': gid, 'ts': stamp}),))
        return {'status': 'ok', 'ts': stamp, 'casas': casas, 'id_jogo': gid}


def _molde_do_launch(tabela, casas, gid):
    """A FORMA do pedido de lancamento, aprendida uma vez e servida a todos os perfis. O que muda
    entre jogos e o gameid, e entre casas e o exitUrl — os dois a aba refaz sozinha. Por isso um
    molde de OUTRO jogo ou de OUTRA casa serve: sem isso o operador teria que abrir o jogo a mao
    em cada navegador, que e justamente o que o botao existe para evitar.
    Nenhum valor de sessao entra aqui: a lista positiva de dados_jogos ja filtrou na entrada."""
    def util(linha):
        campos = (linha or {}).get('campos') or {}
        return campos if len(campos) > 1 else None
    for casa in casas:                                   # 1. a casa pedida, o jogo pedido
        achado = util((tabela.get(casa) or {}).get(gid))
        if achado:
            return achado
    for casa in casas:                                   # 2. a casa pedida, qualquer jogo
        for linha in (tabela.get(casa) or {}).values():
            achado = util(linha)
            if achado:
                return achado
    for jogos in tabela.values():                        # 3. qualquer casa, qualquer jogo
        for linha in jogos.values():
            achado = util(linha)
            if achado:
                return achado
    return None   # null, nao {}: {} e verdadeiro em JS e passava por molde


def abrir_jogo():
    with _lock, _c() as c:
        pedido = json.loads(_get_control(c, 'abrir_jogo', '{}') or '{}')
    if not isinstance(pedido, dict) or not pedido.get('ts'):
        return {'ts': 0}
    import dados_jogos
    with _lock, _c() as c:
        tabela = dados_jogos.jogos_identidade_snapshot(c)
    casas = pedido.get('casas') or ([pedido['casa']] if pedido.get('casa') else [])
    gid = pedido.get('id_jogo', '')
    # a receita do clique vai junto, por casa: cada aba usa a que aprendeu na SUA casa
    receitas = {}
    for casa in casas or list(tabela):
        linha = (tabela.get(casa) or {}).get(gid) or {}
        if linha.get('seletor') or linha.get('marca'):
            receitas[casa] = {'seletor': linha.get('seletor', ''), 'marca': linha.get('marca', '')}
    qualquer = next(iter(receitas.values()), {'seletor': '', 'marca': ''})
    return {'ts': int(pedido['ts']), 'casas': casas, 'id_jogo': gid, 'receitas': receitas,
            'molde': _molde_do_launch(tabela, casas, gid),
            'seletor': qualquer['seletor'], 'marca': qualquer['marca']}


def cronograma():
    with _lock, _c() as c:
        return {'cronograma': json.loads(_get_control(c, 'cronograma', '{}')), 'versao': _versao(c)}


def validar_cronograma(rows):
    """'0'..'6' sao os ENCERRAMENTOS — e assim que o painel sempre leu ("quem encerra (meio-dia)",
    decide a Data Fim), e mudar isso quebraria a data de fim das metas. 'lancamentos' e 'horarios'
    entram ao lado: lancar e outro dia e outra hora que encerrar."""
    objeto(rows)
    if set(rows) - set('0123456') - {'lancamentos', 'horarios'}:
        raise Invalido('dia do cronograma inválido')
    clean = {}
    for day, houses in rows.items():
        if day == 'horarios':
            objeto(houses)
            if set(houses) - {'lancamento', 'encerramento'}:
                raise Invalido('horário do cronograma desconhecido')
            for chave, valor in houses.items():
                if not re.fullmatch(r'([01]\d|2[0-3]):[0-5]\d', str(valor)):
                    raise Invalido('horário deve ser HH:MM')
            clean[day] = dict(houses)
            continue
        if day == 'lancamentos':
            objeto(houses)
            if set(houses) - set('0123456'):
                raise Invalido('dia do cronograma inválido')
            clean[day] = {d: [texto(h, 'casa', limite=128) for h in lista]
                          for d, lista in houses.items()
                          if isinstance(lista, list) and len(lista) <= 1000}
            if len(clean[day]) != len(houses):
                raise Invalido('casas do cronograma devem ser lista')
            continue
        if not isinstance(houses, list) or len(houses) > 1000:
            raise Invalido('casas do cronograma devem ser lista')
        clean[day] = [texto(h, 'casa', limite=128) for h in houses]
    return clean


@_api
def set_cronograma(d):
    objeto(d)
    clean = validar_cronograma(d.get('cronograma'))
    with _lock, _c() as c:
        _expected(c, d)
        c.execute("INSERT INTO controles VALUES('cronograma',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (serializar(clean),))
        return {'status': 'ok', 'cronograma': clean, 'versao': _versao(c)}


def exportar():
    from dados_backup import exportar_banco
    with _lock, _c() as c:
        return exportar_banco(c, _versao(c))


@_api
def importar(snap):
    from dados_backup import restaurar_banco
    return restaurar_banco(snap)


@_api
def validar_restore(snap):
    from dados_backup import validar_banco
    objeto(snap)
    return validar_banco(snap.get('banco', snap))


def restore_status(restore_id):
    with _lock, _c() as c:
        row = c.execute('SELECT restore_id,estado,resposta,atualizado_em FROM restauracoes WHERE restore_id=?', (restore_id,)).fetchone()
        if not row:
            return {'status': 'nao_encontrado', 'restore_id': restore_id}
        result = dict(row)
        result['status'] = 'ok'
        result['resposta'] = json.loads(result['resposta']) if result['resposta'] else None
        return result


def set_agente(d):
    from dados_fontes import set_agente as apply
    return apply(d)


def agente_lista():
    from dados_fontes import agente_lista as read
    return read()


def limpar_agente():
    with _lock, _c() as c:
        for table in ('agente', 'agente_membros', 'agente_fontes', 'agente_paginas', 'agente_listas'):
            c.execute('DELETE FROM ' + table)
        return {'status': 'ok'}


def remover_agente_casa(casa):
    # Remove a leitura da mae de UMA casa/chave (ex.: 'assinar' = dominio antigo da p1 que ficou
    # como card velho), sem tocar nas outras. Cirurgico: so a linha 'casa' nas 5 tabelas.
    from dados_validacao import Invalido
    if not isinstance(casa, str) or not casa.strip():
        raise Invalido('casa obrigatoria para remover a leitura da mae')
    alvo = casa.strip()
    with _lock, _c() as c:
        total = 0
        for table in ('agente', 'agente_membros', 'agente_fontes', 'agente_paginas', 'agente_listas'):
            cur = c.execute('DELETE FROM ' + table + ' WHERE LOWER(casa)=LOWER(?)', (alvo,))
            if cur.rowcount and cur.rowcount > 0:
                total += cur.rowcount
        return {'status': 'ok', 'removidos': total, 'casa': alvo}


def set_ping(d):
    from dados_fontes import set_ping as apply
    return apply(d)


def instalacoes_lista():
    with _lock, _c() as c:
        rows = [dict(r) for r in c.execute('SELECT * FROM instalacoes ORDER BY tipo,instalacao_id')]
        for row in rows:
            row['slots'] = json.loads(row['slots'] or '[]')
        return rows


def limpar_instalacoes(dias=DIAS_PODA_INSTALACOES):
    """Apaga perfis de navegador que nao pingam ha >`dias` dias. So metadados de instalacao
    (versao, fila, slots) — nao mexe em operacoes/contas/dinheiro. Roda no start do servidor."""
    corte = _recente(dias * 86400)
    with _lock, _c() as c:
        return c.execute('DELETE FROM instalacoes WHERE COALESCE(ultimo_ping,\'\') < ?', (corte,)).rowcount


def expirar_pedidos(horas=1):
    """Encerra depositos que a casa EXPIROU sem pagar (estado 'verificar', conflito=0, SEM operacao
    gravada) e que ja passaram `horas`. Marca 'falhou' -> some da lista de aguardando e do /api/estado.
    So expiracao pura: 'verificar' com conflito=1 (evidencia diverge de operacao) NAO entra, e continua
    aparecendo para conferencia. A captura ainda vence: se o deposito entrar depois, _pedido_upsert
    sobrescreve para 'confirmado' e a operacao e gravada."""
    corte = _recente(int(horas * 3600))
    # Idade pelo PRIMEIRO visto (pedido_eventos): observado_em é renovado a cada releitura, e um
    # 'verificar' relido pelo extrato nunca "envelhecia" — ficava no banco e no /api/estado para sempre.
    primeiro = '''COALESCE((SELECT MIN(e.observado_em) FROM pedido_eventos e WHERE e.casa IS pedidos.casa
                            AND e.conta IS pedidos.conta AND e.numero_pedido=pedidos.numero_pedido), observado_em, '')'''
    sem_operacao = '''NOT EXISTS(SELECT 1 FROM operacoes o
                             WHERE o.casa IS pedidos.casa AND o.conta IS pedidos.conta AND o.numero_pedido=pedidos.numero_pedido)'''
    with _lock, _c() as c:
        n = c.execute('''UPDATE pedidos SET estado='falhou', motivo='expirado — casa encerrou sem pagar'
            WHERE tipo='deposito' AND estado='verificar' AND COALESCE(conflito,0)=0 AND ''' + primeiro
            + ' < ? AND ' + sem_operacao, (corte,)).rowcount
        # PIX gerado (paysubmit -> 'identificado') e nunca pago: boa parte dos PIX gerados não vira depósito;
        # sem isto cada um ficava aberto no banco e no /api/estado para sempre. A captura ainda vence.
        n += c.execute('''UPDATE pedidos SET estado='falhou', motivo='PIX gerado e não pago (expirou)'
            WHERE tipo='deposito' AND estado='identificado' AND ''' + primeiro
            + ' < ? AND ' + sem_operacao, (_recente(int(PIX_NAO_PAGO_HORAS * 3600)),)).rowcount
        return n


def captura_bloqueada():
    """Sinal ALTO quando o foco esta barrando TODAS as abas de agente abertas.

    O foco e uma lista de nomes; quando a casa troca de dominio o nome deixa de bater e o filtro
    passa a bloquear tudo. A aba avisa 'fora_do_foco', mas isso se perde no meio do painel — foi o
    que custou horas em 11/09/2026. Aqui o servidor agrega e diz sem rodeio: a captura esta parada
    por causa do filtro, e quais casas estao sendo barradas.
    As abas ja chegam filtradas pelos ultimos 180s (o background so envia slots recentes).
    """
    with _lock, _c() as c:
        return _captura_bloqueada(c)


def _captura_bloqueada(c):
    """Versao interna: recebe a conexao aberta (o /api/estado ja roda dentro do lock)."""
    import dados_identidade
    foco = dados_identidade.expand(c, [r['casa'] for r in c.execute('SELECT casa FROM foco')])
    if not foco:
        return {'bloqueado': False, 'motivo': '', 'casas_barradas': [], 'foco': []}
    vistas, barradas = set(), set()
    # So instalacao com ping recente conta. Uma linha antiga (mae reinstalada, perfil fechado)
    # guarda slots 'atualizado' para sempre e faria vistas != barradas — o alarme de foco calaria
    # justamente depois de reinstalar a extensao.
    for row in c.execute("SELECT slots FROM instalacoes WHERE tipo='mae' AND ultimo_ping>=?", (_recente(),)):
        try:
            slots = json.loads(row['slots'] or '[]')
        except ValueError:
            continue
        for s in slots if isinstance(slots, list) else []:
            casa = str((s or {}).get('casa_normalizada') or (s or {}).get('casa') or '').strip()
            if not casa:
                continue
            vistas.add(casa)
            if (s or {}).get('estado') == 'fora_do_foco':
                barradas.add(casa)
    bloqueado = bool(vistas) and vistas == barradas
    return {'bloqueado': bloqueado, 'motivo': 'foco' if bloqueado else '',
            'casas_barradas': sorted(barradas), 'foco': foco}


def add_jogos(casa, conta, records):
    from dados_jogos import add_jogos as apply
    return apply(casa, conta, records)


def set_jogos_cat(d):
    from dados_jogos import set_jogos_cat as apply
    return apply(d)


def set_jogo(d):
    from dados_jogos import set_jogo as apply
    return apply(d)


def jogos_ranking():
    with _lock, _c() as c:
        rows = [dict(r) for r in c.execute('''SELECT casa,conta,jogo,COUNT(*) rodadas,SUM(apostado) apostado,SUM(ganho) ganho
            FROM jogos WHERE ciclo_id=? GROUP BY casa,conta,jogo ORDER BY SUM(ganho)-SUM(apostado) DESC''', (_ciclo(c),))]
        for r in rows:
            r['lucro'] = (r['ganho'] or 0) - (r['apostado'] or 0)
        return rows


def jogos_cat_lista():
    with _lock, _c() as c:
        rows = [dict(r) for r in c.execute('SELECT * FROM jogos_cat ORDER BY casa,conta,categoria')]
        for r in rows:
            r['lucro'] = (r['ganho'] or 0) - (r['apostado'] or 0)
        return rows


def diagnostico():
    with _lock, _c() as c:
        raw = _raw_summary(c, _ciclo(c))
        origins = {r['origem'] or '?': {'q': r['q'], 'total': r['t']} for r in c.execute(
            'SELECT origem,COUNT(*) q,SUM(valor) t FROM operacoes WHERE ciclo_id=? GROUP BY origem', (_ciclo(c),))}
        suspicious = [dict(r) for r in c.execute("SELECT numero_pedido,casa,conta,tipo,valor,origem FROM operacoes WHERE ciclo_id=? AND (valor IS NULL OR valor<=0 OR conta IS NULL OR conta='') LIMIT 50", (_ciclo(c),))]
        return {'ciclo_id': _ciclo(c), 'total_operacoes': raw['qtd_depositos'] + raw['qtd_saques'],
            'contas_distintas': len(raw['contas']), 'por_origem': origins, 'suspeitos': suspicious,
            'schema_version': SCHEMA_VERSION, 'cobertura': 'parcial', 'consulta_ativa_validada': False}


def revisoes():
    """Par barato que identifica o estado (2 SELECTs), para não remontar o snapshot a cada poll."""
    with _lock, _c() as c:
        return _versao(c), c.execute('SELECT valor FROM telemetria_revisao WHERE id=1').fetchone()[0]


def estado_snapshot():
    """Mesma conexão, transação e revisão, inclusive nas funções aninhadas."""
    with _lock, _c() as c:
        import dados_identidade, dados_fontes
        identities = dados_identidade.snapshot(c)
        calibracao = dados_fontes.calibracao_snapshot(c)
        # Operacao capturada DEPOIS de o ciclo dela ter sido fechado (deposito confirmado as 23:03
        # de um ciclo fechado as 23:00, ou historico descoberto tarde): entra no livro do ciclo
        # certo, mas nao aparecia em lugar nenhum. So visibilidade — mover de ciclo e decisao manual.
        tardias = [dict(r) for r in c.execute('''SELECT o.id,o.casa,o.conta,o.numero_pedido,o.tipo,o.valor,o.ciclo_id,
            o.recebido_em,ci.fechado_em FROM operacoes o JOIN ciclos ci ON ci.id=o.ciclo_id
            WHERE ci.aberto=0 AND o.recebido_em>ci.fechado_em ORDER BY o.recebido_em DESC LIMIT 100''')]
        summary = resumo()
        state = {'versao': _versao(c), 'resumo': summary, 'resumo_efetivo': summary['efetivo'],
            # Ciclo INTEIRO (antes: 200). Ciclos reais passam disso (19: 318 ops; 16: 400) e a lista do Ao
            # Vivo cortava as mais antigas — não dava para ver nem excluir. Totais já vinham do efetivo.
            'ciclo_id': _ciclo(c), 'operacoes': operacoes(limit=10000), 'jogos': jogos_ranking(), 'jogos_cat': jogos_cat_lista(),
            'contas': contas_lista(), 'pendentes': pendentes_lista(), 'pedidos': pedidos_lista(), 'periodo_enum': calibracao, 'operacoes_tardias': tardias, 'extras': _extras(c), 'dispensados': _dispensados(c),
            'ciclos_historico': json.loads(_get_control(c, 'ciclos_historico', '[]') or '[]')[-8:],
            'jogos_identidade': __import__('dados_jogos').jogos_identidade_snapshot(c),
            'jogos_catalogo': json.loads(_get_control(c, 'jogos_catalogo', '[]') or '[]'),
            'metas_por_casa': _metas_casa(c),
            # so o erro entra no estado: os 37 sinais por conta pesariam numa consulta de 2,5 s
            'contas_erro': {k: {'erro': v['erro'], 'erro_em': v.get('erro_em')}
                            for k, v in _permissoes_cru(c).items() if v.get('erro')},
            'ajustes': ajustes_lista(), 'agente': agente_lista(), 'foco': foco_lista(), 'encerradas': encerradas_lista(),
            'descartados': descartados_lista(), 'instalacoes': instalacoes_lista(), 'periodo_ciclo': periodo_ciclo(),
            'captura_bloqueada': _captura_bloqueada(c),
            'varrer_saque_ts': int(_get_control(c, 'varrer_saque_ts', '0')), 'cronograma': cronograma()['cronograma'],
            'mapeamento_filha_mae': identities['mapeamento'], 'identidades': identities, 'capacidades': {'snapshot_atomico': True, 'consulta_ativa_validada': False,
                'restore_preflight': True, 'restore_idempotente': True, 'fechamento_idempotente': True}}
        state['telemetria_versao'] = c.execute('SELECT valor FROM telemetria_revisao WHERE id=1').fetchone()[0]
        last = _get_control(c, 'last_op_ts')
        state['last_op_ts'] = int(dt.datetime.fromisoformat(last.replace('Z', '+00:00')).timestamp()*1000) if last else 0
        corte = _recente()
        todas = state['instalacoes']   # lista completa: alimenta ext/fila/fila_offline abaixo
        for kind in ('player', 'mae'):
            installs = [i for i in todas if i['tipo'] == kind]
            latest = max(installs, key=lambda i: i['ultimo_ping'], default=None)
            state['ext_' + kind] = latest['versao'] if latest else None
            state['ext_' + kind + '_ts'] = int(dt.datetime.fromisoformat(latest['ultimo_ping'].replace('Z', '+00:00')).timestamp()*1000) if latest else 0
            # A fila mostrada e a das instalacoes VIVAS: perfil fechado ontem com 5 eventos na fila
            # deixava o painel acusando pendencia para sempre, sem nada para o operador fazer.
            state['fila_' + kind] = sum(i['fila'] or 0 for i in installs if (i['ultimo_ping'] or '') >= corte)
            # Fila OFFLINE só da versão ATUAL (a do perfil que pingou por último). Perfis de versões antigas
            # são órfãos de atualização — remover+carregar a extensão gera outro id e a fila velha fica
            # congelada no banco. Em 23/09 isso somava 103 "eventos presos" de 83 ids mortos (1.47/1.48/
            # 1.67): alarme falso. Ficam à parte em fila_<tipo>_orfa.
            atual = latest['versao'] if latest else None
            offline = [i for i in installs if (i['ultimo_ping'] or '') < corte]
            state['fila_' + kind + '_offline'] = sum(i['fila'] or 0 for i in offline if i['versao'] == atual)
            state['fila_' + kind + '_orfa'] = sum(i['fila'] or 0 for i in offline if i['versao'] != atual)
        state['ext_version'] = state['ext_player'] or state['ext_mae']
        # ENVIAR so as instalacoes recentes: o painel so usa <3min, e ext/fila/fila_offline ja foram
        # calculados da lista completa acima. Centenas de perfis mortos inchavam o /api/estado (1MB+
        # no polling de 2,5 s); agora vao so as vivas.
        envio = _recente(JANELA_ENVIO_INSTALACOES)
        state['instalacoes'] = [i for i in todas if (i['ultimo_ping'] or '') >= envio]
        state['divergencia_mae'] = _divergencia_mae(c, state['agente'], _mapa_mae(identities))
        state['filhas_da_mae'] = _filhas_da_mae(c, state['agente'], identities)
        return state


# O rótulo do período da mãe NÃO garante a janela. Pede-se à casa o dia de UTC-3 (dados_fontes), mas
# em 23/09 a rolamento, rotulada "hoje@2026-09-23", devolvia TUDO desde o começo da operação (22/09 23:31
# de Brasília): depósito R$ 7.040 = o capturado inteiro, e o saque seguia crescendo depois da
# meia-noite UTC (R$ 4.514 -> R$ 5.030 = todos os saques até 01:38Z). Não se escolhe janela no escuro:
# testam-se dia e mês, em UTC e Brasília, e a resposta diz qual bateu (ou mostra todas).
FUSOS_MAE = (('UTC', dt.timezone.utc), ('Brasília', dt.timezone(dt.timedelta(hours=-3))))
# Um depósito isolado vale R$ 45–190: tolerância maior que centavos esconderia um pedido inteiro.
TOLERANCIA_MAE = 0.5
# A leitura da mãe chega com minutos de atraso sobre a captura. Sobra das filhas coberta pelo que
# elas capturaram nos últimos 15 min antes da leitura é "aguardando a mãe", não divergência. (Na
# rolamento, 2 saques de 01:40Z seguiam fora da mãe às 02:04Z — fora da janela: aparecem, podem estar
# pendentes na casa.)
ATRASO_MAE_S = 15 * 60


def _janelas_da_leitura(periodo, lida_em):
    """[(nome, início, corte)] em UTC para a leitura da mãe; [] quando o rótulo não dá data (semana:
    a casa começa no domingo ou na segunda). Rótulo de dia testa o dia e o mês até ele; rótulo de mês
    testa o mês. Corte = o menor entre o fim da janela e o instante da leitura — o que a mãe ainda não
    tinha visto não pode ser cobrado dela."""
    if not isinstance(periodo, str) or '@' not in periodo:
        return []
    tipo, ref = periodo.split('@', 1)
    if tipo not in ('hoje', 'ontem', 'mes'):
        return []
    try:
        lida = dt.datetime.fromisoformat(str(lida_em).replace('Z', '+00:00'))
        dia = dt.datetime.fromisoformat(ref + ('-01' if tipo == 'mes' else ''))
    except ValueError:
        return []
    if lida.tzinfo is None:
        lida = lida.replace(tzinfo=dt.timezone.utc)
    formas = (('mês', True),) if tipo == 'mes' else (('dia', False), ('mês', True))
    saida = []
    for forma, mes in formas:
        for nome, fuso in FUSOS_MAE:
            ini = (dia.replace(day=1) if mes else dia).replace(tzinfo=fuso)
            fim = (ini + dt.timedelta(days=32)).replace(day=1) if mes else ini + dt.timedelta(days=1)
            if tipo != 'mes' and mes:
                fim = min(fim, dia.replace(tzinfo=fuso) + dt.timedelta(days=1))   # "mês até o dia do rótulo"
            if lida > ini:
                saida.append((forma + ' ' + nome, ini.astimezone(dt.timezone.utc), min(fim, lida).astimezone(dt.timezone.utc)))
    return saida


def _situacao(mae, filhas, recente=0.0):
    if mae is None:
        return None
    dif = round(filhas - mae, 2)
    if abs(dif) <= TOLERANCIA_MAE:
        return 'igual'
    if 0 < dif <= recente + TOLERANCIA_MAE:
        return 'aguardando_mae'
    return 'filha_maior' if dif > 0 else 'mae_maior'


def _filha_da_mae(casa, mae_casa, mapeamento):
    """Casa filha pertence à mãe pelo mapa de identidades ou, sem ele, pela chave derivada."""
    s = str(casa or '').lower()
    destino = mapeamento.get(casa) if isinstance(mapeamento.get(casa), str) else None
    if not destino:
        destino = s.split('-')[-1]
        destino = destino[:-2] if destino.endswith('pg') else destino
    return destino.lower() == mae_casa.lower() or s == mae_casa.lower()


def _mapa_mae(identities):
    """Filha -> mãe: o mapa de identidades + o NOME que o operador deu à mãe. Mãe de chave opaca
    (hostExemplo1, host cloudfront) que ele chamou de "11-gatinhopg" é a mãe da filha 11-gatinhopg —
    sem isso o card dizia "nenhuma filha", a D não comparava e forçar o oficial SOMAVA de novo.
    Só nome com hífen (domínio de lançamento) liga; "11"/"bolha" são apelidos da própria rede."""
    mapa = dict(identities.get('mapeamento') or {})
    for chave, nome in (identities.get('apelidos') or {}).items():
        n = str(nome or '').strip().lower()
        if '-' in n and n != str(chave).lower() and n not in mapa:
            mapa[n] = chave
    return mapa


def _filhas_da_mae(c, agente, identities):
    """Só MOSTRA qual filha pertence a cada mãe — não associa. Associar junta as chaves (e com elas
    metas/histórico), o que o operador não quer (24/09); ver o par basta. Motivos, do mais forte:
    associação já feita, mesmo domínio (mãe e filha no mesmo host), mesmo nome (p1-rolamentopg -> rolamento)."""
    mapeamento = identities.get('mapeamento') or {}
    filhas = [r['casa'] for r in c.execute("SELECT DISTINCT casa FROM operacoes WHERE casa IS NOT NULL AND casa<>''")]
    por_id = {h['id']: h for h in identities.get('casas') or []}
    dominio = {}
    for k in identities.get('candidatos') or []:
        a, b = por_id.get(k.get('origem')), por_id.get(k.get('destino'))
        if not a or not b or not k.get('hosts'):
            continue
        for x, y in ((a, b), (b, a)):
            for mae in x['chaves']:
                for filha in y['chaves']:
                    dominio[(mae.lower(), filha.lower())] = ', '.join(k['hosts'])
    saida = {}
    for house in agente or []:
        mae, lista = house['casa'], []
        for f in filhas:
            if f.lower() == mae.lower():
                continue
            if isinstance(mapeamento.get(f), str) and mapeamento[f].lower() == mae.lower():
                lista.append({'filha': f, 'motivo': 'associada'})
            elif str((identities.get('apelidos') or {}).get(mae) or '').strip().lower() == f.lower():
                lista.append({'filha': f, 'motivo': 'nome dado à mãe'})
            elif (mae.lower(), f.lower()) in dominio:
                lista.append({'filha': f, 'motivo': 'mesmo domínio ' + dominio[(mae.lower(), f.lower())]})
            elif _filha_da_mae(f, mae, {}):
                lista.append({'filha': f, 'motivo': 'mesmo nome'})
        saida[mae] = lista
    return saida


def _pedidos_abertos(c, mae_casa, mapeamento, ini, corte):
    """Pedidos das filhas desta mãe ainda sem desfecho na janela. Em 24/09 a rolamento tinha a mãe
    R$ 133 acima das filhas e a diferença era exatamente um depósito de R$ 133 parado em
    'processando' desde 23:48 da véspera: a casa pagou, a filha nunca viu a confirmação."""
    quando = 'substr(COALESCE(data,observado_em),1,19)'
    out = {'deposito': [], 'saque': []}
    for r in c.execute("SELECT casa,conta,numero_pedido,tipo,valor,estado,COALESCE(data,observado_em) quando FROM pedidos "
            "WHERE estado IN ('identificado','processando','verificar') AND tipo IN ('deposito','saque') AND valor>0 "
            'AND ' + quando + '>=? AND ' + quando + '<? ORDER BY quando',
            (ini.strftime('%Y-%m-%dT%H:%M:%S'), corte.strftime('%Y-%m-%dT%H:%M:%S'))):
        if _filha_da_mae(r['casa'], mae_casa, mapeamento):
            out[r['tipo']].append({k: r[k] for k in ('casa', 'conta', 'numero_pedido', 'valor', 'estado', 'quando')})
    return out


def _explica_diferenca(falta, abertos):
    """Pedidos abertos que somam EXATAMENTE a diferença: um só, ou todos juntos. Nada de combinar
    subconjuntos — com dezenas de pedidos de R$ 10–190 sempre haveria uma soma que "bate" por acaso."""
    if falta <= TOLERANCIA_MAE or not abertos:
        return None
    um = [p for p in abertos if abs(p['valor'] - falta) <= TOLERANCIA_MAE]
    if um:
        return um[:1]
    if abs(sum(p['valor'] for p in abertos) - falta) <= TOLERANCIA_MAE:
        return abertos
    return None


def _capturado_na_janela(c, mae_casa, mapeamento, ini, corte):
    recente_desde = (corte - dt.timedelta(seconds=ATRASO_MAE_S)).strftime('%Y-%m-%dT%H:%M:%S')
    out = {'deposito': 0.0, 'qtd_depositos': 0, 'saque': 0.0, 'qtd_saques': 0, 'filhas': set(), 'por_conta': {},
           'recente': {'deposito': 0.0, 'saque': 0.0}}
    quando = 'substr(COALESCE(data,observado_em),1,19)'
    for r in c.execute('SELECT casa,conta,tipo,COUNT(*) q,SUM(valor) t,SUM(CASE WHEN ' + quando + '>=? THEN valor ELSE 0 END) rec '
            'FROM operacoes WHERE ' + quando + '>=? AND ' + quando + '<? GROUP BY casa,conta,tipo',
            (recente_desde, ini.strftime('%Y-%m-%dT%H:%M:%S'), corte.strftime('%Y-%m-%dT%H:%M:%S'))):
        if not _filha_da_mae(r['casa'], mae_casa, mapeamento):
            continue
        if r['tipo'] not in ('deposito', 'saque'):
            continue
        out['filhas'].add(r['casa'])
        out[r['tipo']] += r['t'] or 0
        out['qtd_depositos' if r['tipo'] == 'deposito' else 'qtd_saques'] += r['q']
        out['recente'][r['tipo']] += r['rec'] or 0
        if r['tipo'] == 'deposito':
            out['por_conta'][str(r['conta'])] = out['por_conta'].get(str(r['conta']), 0) + (r['t'] or 0)
    return out


def _divergencia_mae(c, agente, mapeamento):
    """Automação D (23/09): depósito/saque que a MÃE informa × o que as FILHAS capturaram, na janela
    da leitura da mãe, cortada no instante da leitura. Só a leitura 'periodo' (totais do período)
    entra — 'acumulado'/'desconhecido' não têm data. Casa filha -> mãe pelo mapa de identidades e,
    sem ele, pela chave-mãe derivada (p2-exemplopg -> exemplo), como o "forçar oficial" do painel.
    Horário da operação: o oficial da casa (data) ou, sem ele, o primeiro visto (observado_em).
    'janela' = a janela em que o depósito bateu (preferindo a que também bate o saque); None =
    nenhuma bateu — a resposta traz todas as contas e não supõe a causa."""
    saida = []
    for house in agente or []:
        leituras = [s for s in house.get('fontes') or [] if s.get('tipo') == 'agente_total'
                    and s.get('fonte') == 'periodo' and isinstance((s.get('dados') or {}).get('deposito'), (int, float))]
        if not leituras:
            continue
        leitura = max(leituras, key=lambda s: s.get('recebido_em') or '')
        dados = leitura['dados']
        mae_dep = float(dados['deposito'])
        mae_saq = float(dados['saque']) if isinstance(dados.get('saque'), (int, float)) else None
        candidatas = []
        for nome, ini, corte in _janelas_da_leitura(leitura.get('periodo'), leitura.get('recebido_em')):
            cap = _capturado_na_janela(c, house['casa'], mapeamento, ini, corte)
            sit = {'deposito': _situacao(mae_dep, cap['deposito'], cap['recente']['deposito']),
                   'saque': _situacao(mae_saq, cap['saque'], cap['recente']['saque'])}
            candidatas.append((nome, ini, corte, cap, sit))
        if not candidatas:
            continue
        ok = ('igual', 'aguardando_mae', None)
        bate = [x for x in candidatas if x[4]['deposito'] in ok]
        dif_saque = lambda x: abs(x[3]['saque'] - mae_saq) if mae_saq is not None else 0
        # Depósito bateu em mais de uma janela: fica a de menor diferença no saque. Nenhuma bateu: a
        # de menor diferença de depósito vira referência (todas vão na resposta).
        nome, ini, corte, cap, sit = (min(bate, key=dif_saque) if bate
                                      else min(candidatas, key=lambda x: (abs(x[3]['deposito'] - mae_dep), dif_saque(x))))
        # A lista de afiliados tem período próprio (quase sempre "desconhecido"): confere-se conta a
        # conta em cada janela e fica a que mais contas confirmam — a prova vem das contas, não do rótulo.
        conferencias = [dict(_conferir_contas(house, leitura.get('conta_mae') or '', x[3]['por_conta']) or {}, janela=x[0])
                        for x in candidatas]
        contas = max(conferencias, key=lambda k: (k.get('iguais') or 0, -(k.get('qtd_diferentes') or 0)))
        contas = contas if 'iguais' in contas else None
        abertos = _pedidos_abertos(c, house['casa'], mapeamento, ini, corte)
        explicado = {'deposito': _explica_diferenca(mae_dep - cap['deposito'], abertos['deposito']),
                     'saque': None if mae_saq is None else _explica_diferenca(mae_saq - cap['saque'], abertos['saque'])}
        saida.append({'casa': house['casa'], 'conta_mae': leitura.get('conta_mae') or None, 'periodo': leitura['periodo'],
            'lida_em': leitura.get('recebido_em'), 'janela': nome if bate else None, 'janela_referencia': nome,
            'inicio': ini.isoformat().replace('+00:00', 'Z'), 'corte': corte.isoformat().replace('+00:00', 'Z'),
            'filhas': sorted(cap['filhas']), 'mae': {'deposito': mae_dep, 'saque': mae_saq},
            'capturado': {k: (round(cap[k], 2) if isinstance(cap[k], float) else cap[k]) for k in ('deposito', 'qtd_depositos', 'saque', 'qtd_saques')},
            'diferenca': {'deposito': round(cap['deposito'] - mae_dep, 2), 'saque': None if mae_saq is None else round(cap['saque'] - mae_saq, 2)},
            'situacao': sit,
            'outras_janelas': [{'janela': n, 'deposito': round(k['deposito'], 2), 'saque': round(k['saque'], 2)}
                               for n, _i, _c, k, _s in candidatas if n != nome],
            'contas': contas, 'pedidos_abertos': {t: v[:10] for t, v in abertos.items()}, 'explicado_por': explicado})
    return saida


def _conferir_contas(house, conta_mae, dep_conta, limite=30):
    """Conta a conta: a lista de afiliados mais recente da MESMA conta-mãe × o depósito capturado
    na janela. Não depende do rótulo do período do total — em 23/09 a modelo tinha o total "hoje"
    em R$ 2.005 e as 49 contas capturadas batiam uma a uma com a lista (R$ 4.240): o total é que
    era de outro período. 'sem_captura' = a mãe viu depósito numa conta que nenhuma filha capturou."""
    listas = [l for l in (house.get('listas') or []) + (house.get('listas_parciais') or [])
              if (l.get('conta_mae') or '') == conta_mae and l.get('membros')]
    if not listas:
        return None
    lista = max(listas, key=lambda l: l.get('recebido_em') or '')
    iguais, sem_captura, diferentes = 0, [], []
    for m in lista['membros']:
        valor = m.get('deposito')
        if not isinstance(valor, (int, float)) or valor <= 0:
            continue
        cap = dep_conta.get(str(m.get('conta')))
        if cap is None:
            sem_captura.append({'conta': m.get('conta'), 'nome': m.get('nome'), 'mae': valor})
        elif abs(cap - valor) < 0.01:
            iguais += 1
        else:
            diferentes.append({'conta': m.get('conta'), 'nome': m.get('nome'), 'mae': valor, 'capturado': round(cap, 2)})
    return {'lista_recebida_em': lista.get('recebido_em'), 'lista_periodo': lista.get('periodo'),
            'lista_completa': lista.get('lista_completa') is True, 'iguais': iguais,
            'qtd_sem_captura': len(sem_captura), 'sem_captura': sem_captura[:limite],
            'qtd_diferentes': len(diferentes), 'diferentes': diferentes[:limite]}
