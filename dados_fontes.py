"""Fontes da mãe não se misturam; telemetria não é evidência financeira."""
import datetime as dt
import json
import re
import db
from dados_validacao import (Conflito, Invalido, agora, booleano, identidade,
    instante, numero, objeto, serializar, texto)


def _period(value, source=None):
    value = texto(value, 'periodo')
    if value == 'acumulado' and source in ('total', 'info'):
        return value
    if value != 'desconhecido' and not re.fullmatch(r'(?:hoje|ontem|semana|ultima)@\d{4}-\d{2}-\d{2}|mes@\d{4}-\d{2}', value):
        raise Invalido('periodo inválido')
    if value != 'desconhecido':
        instante(value.split('@')[1] + ('-01' if value.startswith('mes@') else ''), 'periodo')
    return value


def _members(value):
    if not isinstance(value, list) or len(value) > 100000:
        raise Invalido('membros deve ser lista')
    members = {}
    for m in value:
        objeto(m)
        account = identidade(m.get('conta'), 'conta')
        row = {'conta': account}
        if 'nome' in m:
            row['nome'] = texto(m['nome'], 'nome', vazio=True) if m['nome'] is not None else None
        for field in ('deposito', 'aposta'):
            row[field] = numero(m.get(field), field, nulo=True)
        for field, alias in (('is_dep', 'isDep'), ('online', 'online')):
            val = m.get(alias, m.get(field))
            row[field] = booleano(val, field, nulo=True)
        if account in members and members[account] != row:
            raise Conflito('membro repetido com valores divergentes')
        members[account] = row
    return list(members.values())


# --- calibracao timeEnum -> rotulo, por casa -------------------------------------------------
# A casa manda no corpo da requisicao o numero do periodo (timeEnum); o rotulo vem da aba ativa
# lida no DOM, que ja se provou errado (a pagina abre em 'esta semana' e o clique em 'Este Mes'
# nem sempre pega; o bundle da casa define TODAY=0..THIS_WEEK=2..THIS_MONTH=4, e existe variante
# 1-based). Nao ha mapa fixo: cada casa ensina o seu, e so vale com >=3 observacoes concordantes.
CALIBRACAO_CHAVE = 'periodo_enum_calibracao'
JANELA_CHAVE = 'periodo_enum_janela'
ROTULOS_PERIODO = ('hoje', 'ontem', 'semana', 'ultima', 'mes')
CALIBRACAO_MINIMO, CALIBRACAO_FRACAO = 3, 0.75
# Prova direta: o directReportV5 devolve startTime/endTime — a janela que a casa REALMENTE usou.
# Medido em 08/09: enum 2 cobriu UM dia (00:00 as 23:59 em UTC-3), nao o mes. Isso vale mais que o
# rotulo lido da aba: e o unico sinal que nao depende de o clique ter pego. O tamanho sozinho nao
# decide — "este mes" no dia 8 tambem cobre 8 dias. Quem decide e o par (inicio, fim) comparado ao
# dia da leitura, no fuso da propria casa, deduzido da meia-noite que ela usou.


def _fuso_da_janela(inicio, fim):
    """Segundos entre a meia-noite local da casa e a UTC; None se inicio/fim nao fecham um dia."""
    desloc = inicio % 86400
    return desloc if (fim + 1) % 86400 == desloc else None


def _rotulos_da_janela(inicio, fim, referencia):
    """Rotulos que a janela medida admite. Lista vazia = nenhum serve (ex.: 90 dias, que a casa
    tambem oferece e o painel nao tem onde guardar). None = janela ilegivel, ninguem e acusado."""
    desloc = _fuso_da_janela(inicio, fim)
    if desloc is None:
        return None
    primeiro, ultimo, hoje = ((t - desloc) // 86400 for t in (inicio, fim, referencia))
    dias = ultimo - primeiro + 1
    if not 1 <= dias <= 400 or ultimo > hoje:
        return None
    fuso = dt.timezone(dt.timedelta(seconds=-desloc if desloc <= 43200 else 86400 - desloc))
    abriu = dt.datetime.fromtimestamp(inicio, fuso)
    # a semana pode comecar no domingo ou na segunda conforme a casa; aceitamos as duas
    comeca_semana = abriu.isoweekday() in (7, 1)
    saida = []
    if dias == 1 and ultimo == hoje:
        saida.append('hoje')
    if dias == 1 and ultimo == hoje - 1:
        saida.append('ontem')
    if dias <= 7 and ultimo == hoje and comeca_semana:
        saida.append('semana')      # "esta semana" e parcial: do inicio da semana ate hoje
    if dias == 7 and ultimo < hoje and comeca_semana:
        saida.append('ultima')
    if dias <= 31 and ultimo == hoje and abriu.day == 1:
        saida.append('mes')         # "este mes" e parcial: do dia 1 ate hoje
    return saida


def _janelas(c):
    try:
        j = json.loads(db._get_control(c, JANELA_CHAVE, '{}'))
    except ValueError:
        j = {}
    return j if isinstance(j, dict) else {}


def registrar_janela(c, house, enum, inicio, fim, rotulos):
    """Guarda a ultima janela que a casa usou para aquele enum e o que ela admite."""
    janelas = _janelas(c)
    janelas.setdefault(house, {})[str(enum)] = {
        'inicio': int(inicio), 'fim': int(fim),
        'dias': round((fim + 1 - inicio) / 86400.0, 2), 'rotulos': list(rotulos)}
    c.execute("INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
              (JANELA_CHAVE, serializar(janelas)))


def validar_janelas(obj):
    """Usado pelo backup: {casa: {enum: {inicio, fim, dias, rotulos}}}."""
    objeto(obj)
    for house, enums in obj.items():
        identidade(house, 'casa')
        objeto(enums)
        for enum, medida in enums.items():
            if not str(enum).lstrip('-').isdigit():
                raise Invalido('enum de janela inválido')
            objeto(medida)
            if set(medida) - {'dias', 'inicio', 'fim', 'rotulos'}:
                raise Invalido('janela com campo desconhecido')
            numero(medida.get('dias'), 'dias')
            inicio = numero(medida.get('inicio'), 'inicio', inteiro=True)
            fim = numero(medida.get('fim'), 'fim', inteiro=True)
            if fim <= inicio:
                raise Invalido('janela com fim antes do início')
            rotulos = medida.get('rotulos')
            if not isinstance(rotulos, list) or any(r not in ROTULOS_PERIODO for r in rotulos):
                raise Invalido('rótulo de janela inválido')


def _calibracao(c):
    try:
        cal = json.loads(db._get_control(c, CALIBRACAO_CHAVE, '{}'))
    except ValueError:
        cal = {}
    return cal if isinstance(cal, dict) else {}


def _aprender(c, cal, house, label, enum):
    por = cal.setdefault(house, {}).setdefault(label, {})
    por[str(enum)] = int(por.get(str(enum), 0)) + 1
    c.execute("INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
              (CALIBRACAO_CHAVE, serializar(cal)))


def _dominante(contagens):
    total = sum(int(v) for v in contagens.values())
    if total < CALIBRACAO_MINIMO:
        return None
    chave, n = max(contagens.items(), key=lambda kv: int(kv[1]))
    return chave if int(n) >= CALIBRACAO_FRACAO * total else None


def _enum_calibrado(cal, house, label):
    d = _dominante(cal.get(house, {}).get(label, {}))
    return int(d) if d is not None else None


def _rotulo_calibrado(cal, house, enum):
    melhor, melhor_n = None, 0
    for label, contagens in cal.get(house, {}).items():
        d = _dominante(contagens)
        if d is not None and int(d) == enum and int(contagens[d]) > melhor_n:
            melhor, melhor_n = label, int(contagens[d])
    return melhor


def validar_calibracao(obj):
    """Usado pelo backup: a chave de controles precisa ter a forma {casa: {rotulo: {enum: n}}}."""
    objeto(obj)
    for house, labels in obj.items():
        identidade(house, 'casa')
        objeto(labels)
        for label, contagens in labels.items():
            if label not in ROTULOS_PERIODO:
                raise Invalido('rótulo de calibração inválido')
            objeto(contagens)
            for enum, n in contagens.items():
                if not str(enum).lstrip('-').isdigit() or type(n) is not int or n < 0:
                    raise Invalido('calibração de período inválida')


def calibracao_snapshot(c):
    cal, janelas = _calibracao(c), _janelas(c)
    casas = set(cal) | set(janelas)
    return {house: {
        'por_rotulo': {label: {'enum_calibrado': _enum_calibrado(cal, house, label), 'contagens': cont}
                       for label, cont in cal.get(house, {}).items()},
        # o que a casa mediu: enum -> dias cobertos e rotulos compativeis com esse tamanho
        'janelas': janelas.get(house, {})}
        for house in casas}


@db._api
def set_agente(d):
    objeto(d)
    house = identidade(d.get('casa'), 'casa')
    kind = d.get('tipo')
    if kind not in ('agente_total', 'agente_membros', 'agente_info'):
        raise Invalido('tipo de agente inválido')
    source = d.get('fonte', {'agente_total': 'periodo', 'agente_membros': 'membros', 'agente_info': 'info'}[kind])
    if source not in ('periodo', 'total', 'membros', 'info'):
        raise Invalido('fonte inválida')
    period = _period(d.get('periodo', 'desconhecido'), source)
    observed = booleano(d.get('periodo_observado', False), 'periodo_observado')
    if not observed and period != 'acumulado':
        period = 'desconhecido'
    received = instante(d.get('recebido_em', agora()), 'recebido_em')
    unit = d.get('unidade_contador', 'desconhecida')
    if unit not in ('contas', 'pessoas', 'depositos', 'desconhecida'):
        raise Invalido('unidade_contador inválida')
    mother = identidade(d.get('conta_mae', ''), 'conta_mae', vazio=True)
    enum = numero(d.get('periodo_enum'), 'periodo_enum', nulo=True, inteiro=True) if 'periodo_enum' in d else None
    inicio = numero(d.get('janela_inicio'), 'janela_inicio', nulo=True, inteiro=True) if 'janela_inicio' in d else None
    fim = numero(d.get('janela_fim'), 'janela_fim', nulo=True, inteiro=True) if 'janela_fim' in d else None
    if (inicio is None) != (fim is None):
        raise Invalido('janela precisa de início e fim')
    if inicio is not None and fim <= inicio:
        raise Invalido('janela com fim antes do início')
    medidos = None
    if inicio is not None:
        medidos = _rotulos_da_janela(inicio, fim, dt.datetime.fromisoformat(received.replace('Z', '+00:00')).timestamp())
    conflict, aprender, gravar_janela = None, None, None
    with db._lock, db._c() as c:
        # A janela que a casa devolveu e prova direta do que aquele enum significa; o voto de
        # rotulo (frágil, depende do clique ter pego) so entra quando ela nao veio.
        if enum is not None and medidos is not None:
            gravar_janela = (enum, inicio, fim, medidos)
        if enum is not None and observed and period not in ('acumulado', 'desconhecido'):
            label = period.split('@')[0]
            cal = _calibracao(c)
            conhecidos = medidos if medidos is not None else (_janelas(c).get(house, {}).get(str(enum)) or {}).get('rotulos')
            if conhecidos is not None:
                if label in conhecidos:
                    aprender = (cal, label, enum)
                else:
                    conflict = {'enum': enum, 'rotulo_lido': label, 'rotulos_da_janela': conhecidos, 'prova': 'janela'}
                    observed, period = False, 'desconhecido'
            else:
                # Quando o enum contradiz o que esta casa ja ensinou, o rotulo lido NAO vale: a
                # leitura fica 'desconhecido' com o conflito registrado, em vez de gravar semana como mes.
                esperado, rotulo_do_enum = _enum_calibrado(cal, house, label), _rotulo_calibrado(cal, house, enum)
                if (esperado is not None and esperado != enum) or (rotulo_do_enum is not None and rotulo_do_enum != label):
                    conflict = {'enum': enum, 'rotulo_lido': label, 'enum_calibrado': esperado,
                                'rotulo_calibrado': rotulo_do_enum, 'prova': 'calibracao'}
                    observed, period = False, 'desconhecido'
                else:
                    aprender = (cal, label, enum)
        scope = (house, source, period, kind, mother)
        def apply():
            old = c.execute('SELECT * FROM agente_fontes WHERE casa=? AND fonte=? AND periodo=? AND tipo=? AND conta_mae=?', scope).fetchone()
            payload = json.loads(old['dados']) if old else {}
            if old and received < old['recebido_em'] and kind != 'agente_membros':
                return {'status': 'duplicado', 'casa': house, 'tipo': kind}
            payload.update(fonte=source, periodo=period, periodo_observado=observed, unidade_contador=unit)
            if enum is not None:
                payload['periodo_enum'] = enum
            if inicio is not None:
                payload['janela_inicio'], payload['janela_fim'] = inicio, fim
            if gravar_janela:
                registrar_janela(c, house, *gravar_janela)
            if conflict:
                payload['periodo_conflito'] = conflict
            else:
                payload.pop('periodo_conflito', None)
            # aprender aqui, dentro do apply: um reenvio com o mesmo event_id e respondido pelo
            # recibo sem passar por aqui, entao a mesma observacao nao conta duas vezes
            if aprender:
                _aprender(c, aprender[0], house, aprender[1], aprender[2])
            for field in ('conta_mae', 'conta_mae_nome'):
                if field in d and d[field] is not None:
                    payload[field] = identidade(d[field], field)
            if kind == 'agente_total':
                for field in ('deposito', 'contas', 'primeiro_deposito', 'saque', 'aposta'):
                    if field in d:
                        payload[field] = numero(d[field], field, nulo=True, inteiro=field == 'contas')
            elif kind == 'agente_info':
                payload['membros_qtd'] = numero(d.get('membros_qtd'), 'membros_qtd', nulo=True, inteiro=True)
            else:
                members = _members(d.get('membros'))
                collection = texto(d.get('coleta_id', 'legado-' + received), 'coleta_id')
                page = numero(d.get('pagina'), 'pagina', inteiro=True, nulo=True, minimo=1)
                total = numero(d.get('total_paginas'), 'total_paginas', inteiro=True, nulo=True, minimo=1)
                complete = booleano(d.get('lista_completa', False), 'lista_completa')
                more = booleano(d.get('mais'), 'mais', nulo=True)
                if page is not None and total is not None and page > total:
                    raise Invalido('pagina maior que total_paginas')
                if complete and (page is None or total is None or more is True):
                    raise Invalido('lista completa requer páginas explícitas e fim confirmado')
                previous = c.execute('SELECT * FROM agente_paginas WHERE casa=? AND fonte=? AND periodo=? AND coleta_id=? AND pagina=? AND conta_mae=?',
                                     (house, source, period, collection, page or 0, mother)).fetchone()
                if previous and received < previous['recebido_em']:
                    return {'status': 'duplicado', 'casa': house, 'tipo': kind}
                c.execute('''INSERT INTO agente_paginas VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(casa,fonte,periodo,coleta_id,pagina,conta_mae)
                    DO UPDATE SET total_paginas=excluded.total_paginas,lista_completa=excluded.lista_completa,
                    membros=excluded.membros,recebido_em=excluded.recebido_em''',
                    (house, source, period, collection, page or 0, total, int(complete), serializar(members), received, mother))
                pages = list(c.execute('SELECT * FROM agente_paginas WHERE casa=? AND fonte=? AND periodo=? AND coleta_id=? AND conta_mae=? ORDER BY pagina',
                                      (house, source, period, collection, mother)))
                totals = {r['total_paginas'] for r in pages if r['total_paginas'] is not None}
                if len(totals) > 1:
                    raise Conflito('total_paginas mudou na mesma coleta')
                expected = next(iter(totals)) if totals else None
                finished = expected is not None and {r['pagina'] for r in pages} == set(range(1, expected+1)) and any(r['lista_completa'] for r in pages)
                if finished:
                    combined = _members([m for p in pages for m in json.loads(p['membros'])])
                    latest = max(p['recebido_em'] for p in pages)
                    current = c.execute('SELECT recebido_em FROM agente_listas WHERE casa=? AND fonte=? AND periodo=? AND conta_mae=?', (house, source, period, mother)).fetchone()
                    if not current or latest >= current['recebido_em']:
                        c.execute('''INSERT INTO agente_listas VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(casa,fonte,periodo,conta_mae) DO UPDATE SET
                            coleta_id=excluded.coleta_id,membros=excluded.membros,total_paginas=excluded.total_paginas,recebido_em=excluded.recebido_em''',
                            (house, source, period, collection, serializar(combined), expected, latest, mother))
                payload.update(coleta_id=collection, pagina=page, total_paginas=total, lista_completa=finished,
                               mais=more, membros_recebidos=len(members), paginas_recebidas=len(pages))
            c.execute('''INSERT INTO agente_fontes VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(casa,fonte,periodo,tipo,conta_mae)
                DO UPDATE SET dados=excluded.dados,recebido_em=excluded.recebido_em,unidade_contador=excluded.unidade_contador''',
                (house, source, period, kind, serializar(payload), received, unit, mother))
            c.execute('INSERT OR IGNORE INTO agente(casa) VALUES(?)', (house,))
            return {'status': 'ok', 'casa': house, 'tipo': kind, 'fonte': source, 'periodo': period,
                    'lista_completa': payload.get('lista_completa', False)}
        return db._receipt(c, d, 'agente', apply)


def agente_lista():
    with db._lock, db._c() as c:
        houses = [dict(r) for r in c.execute('SELECT * FROM agente ORDER BY casa')]
        for house in houses:
            sources = []
            for r in c.execute('SELECT * FROM agente_fontes WHERE casa=? ORDER BY recebido_em DESC,fonte,periodo,tipo', (house['casa'],)):
                row = dict(r)
                row['dados'] = json.loads(row['dados'])
                sources.append(row)
            lists = []
            for r in c.execute('SELECT * FROM agente_listas WHERE casa=? ORDER BY recebido_em DESC,fonte,periodo', (house['casa'],)):
                row = dict(r)
                row['membros'] = json.loads(row['membros'])
                row['lista_completa'] = True
                lists.append(row)
            # Compatibilidade: uma projeção única, sem completar campos usando outro endpoint.
            active_mother = next((s['conta_mae'] for s in sources if s['conta_mae']), '')
            current_sources = [s for s in sources if s['conta_mae'] == active_mother]
            periods = [s for s in current_sources if s['tipo'] == 'agente_total' and s['fonte'] == 'periodo']
            totals = [s for s in current_sources if s['tipo'] == 'agente_total' and s['fonte'] == 'total']
            selected = (periods or totals or [None])[0]
            house.update(fontes=sources, listas=lists, periodo='desconhecido', fonte='legado', unidade_contador='desconhecida', lista_completa=False)
            if sources:
                for field in ('deposito_total', 'contas', 'primeiro_deposito', 'saque_total', 'aposta_total', 'membros_qtd'):
                    house[field] = None
                house['conta_mae'] = active_mother or None
            partial_groups = {}
            for page in c.execute('SELECT * FROM agente_paginas WHERE casa=? ORDER BY recebido_em,pagina', (house['casa'],)):
                key = (page['fonte'], page['periodo'], page['coleta_id'], page['conta_mae'])
                group = partial_groups.setdefault(key, {'casa': house['casa'], 'fonte': key[0], 'periodo': key[1],
                    'coleta_id': key[2], 'conta_mae': key[3], 'total_paginas': page['total_paginas'], 'paginas_recebidas': [],
                    'lista_completa': False, 'recebido_em': page['recebido_em'], '_membros': {}, 'conflitos': False})
                group['paginas_recebidas'].append(page['pagina'] or None)
                group['recebido_em'] = max(group['recebido_em'], page['recebido_em'])
                for member in json.loads(page['membros']):
                    account = member['conta']
                    if account in group['_membros'] and group['_membros'][account] != member:
                        group['conflitos'] = True
                    group['_membros'][account] = member
            partials = []
            for group in partial_groups.values():
                if any(r['fonte'] == group['fonte'] and r['periodo'] == group['periodo'] and r['coleta_id'] == group['coleta_id'] and r['conta_mae'] == group['conta_mae'] for r in lists):
                    continue
                group['membros'] = list(group.pop('_membros').values())
                group['membros_recebidos'] = len(group['membros'])
                partials.append(group)
            partials.sort(key=lambda r: r['recebido_em'], reverse=True)
            # Uma coleta por fonte/período; as páginas históricas continuam no backup.
            latest_partials = {}
            for p in partials:
                latest_partials.setdefault((p['fonte'], p['periodo'], p['conta_mae']), p)
            house['listas_parciais'] = list(latest_partials.values())
            if selected:
                data = selected['dados']
                for field, key in (('deposito_total','deposito'), ('contas','contas'), ('primeiro_deposito','primeiro_deposito'),
                                   ('saque_total','saque'), ('aposta_total','aposta')):
                    house[field] = data.get(key)
                house.update(fonte=selected['fonte'], periodo=selected['periodo'], unidade_contador=selected['unidade_contador'],
                             atualizado_em=selected['recebido_em'], periodo_observado=data['periodo_observado'])
                for field in ('conta_mae', 'conta_mae_nome'):
                    house[field] = data.get(field)
            matching = [r for r in lists if r['periodo'] == house['periodo'] and r['conta_mae'] == active_mother]
            if matching:
                house['membros'] = matching[0]['membros']
                house['lista_completa'] = True
                house['coleta_id'] = matching[0]['coleta_id']
                house['total_paginas'] = matching[0]['total_paginas']
                house['membros_fonte'] = matching[0]['fonte']
                house['membros_periodo'] = matching[0]['periodo']
            elif not sources:
                house['membros'] = [dict(r) for r in c.execute('SELECT * FROM agente_membros WHERE casa=? ORDER BY conta', (house['casa'],))]
            else:
                partial_matching = [r for r in house['listas_parciais'] if r['conta_mae'] == active_mother and (r['periodo'] == house['periodo'] or selected is None)]
                partial = partial_matching[0] if partial_matching else None
                house['membros'] = partial['membros'] if partial else []
                if partial:
                    house['membros_fonte'], house['membros_periodo'] = partial['fonte'], partial['periodo']
                    house['coleta_id'], house['total_paginas'] = partial['coleta_id'], partial['total_paginas']
            house['membros_recebidos'] = len(house['membros'])
        return houses


@db._api
def set_ping(d):
    objeto(d)
    version = texto(d.get('versao', d.get('version', '?')), 'versao')
    kind = d.get('tipo', 'mae' if version.startswith('mae-') else 'player')
    if kind not in ('player', 'mae'):
        raise Invalido('tipo de instalação inválido')
    if version.startswith('mae-'):
        version = version[4:]
    install = texto(d.get('instalacao_id', 'legado-' + kind), 'instalacao_id')
    queue = numero(d.get('fila'), 'fila', inteiro=True, nulo=True)
    pending = numero(d.get('pendentes'), 'pendentes', inteiro=True, nulo=True)
    last = instante(d.get('ultimo_evento'), 'ultimo_evento', nulo=True)
    state = texto(d.get('estado', 'desconhecido'), 'estado')
    slots = d.get('slots', [])
    if not isinstance(slots, list) or len(slots) > 1000:
        raise Invalido('slots deve ser lista')
    safe = []
    for slot in slots:
        objeto(slot)
        row = {}
        for field in ('tab_id', 'frame_id', 'geracao', 'casa', 'conta', 'estado', 'slot_id', 'host', 'casa_normalizada',
                      'versao_pagina'):   # versao do codigo injetado na aba; o worker pode ser mais novo que ela
            if field in slot and slot[field] is not None:
                row[field] = identidade(slot[field], field, vazio=True)
        for field in ('fila', 'pendentes'):
            if field in slot:
                row[field] = numero(slot[field], field, inteiro=True, nulo=True)
        for field in ('ultimo_evento', 'ultima_resposta', 'ultima_confirmacao', 'diagnosticado_em'):
            if field in slot:
                row[field] = instante(slot[field], field, nulo=True)
        for field in ('host','casa_normalizada'):
            if field in row:
                from dados_identidade import hostname
                row[field]=hostname(row[field])
        safe.append(row)
    with db._lock, db._c() as c:
        c.execute('''INSERT INTO instalacoes VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(instalacao_id,tipo)
            DO UPDATE SET versao=excluded.versao,fila=excluded.fila,pendentes=excluded.pendentes,
            ultimo_evento=excluded.ultimo_evento,estado=excluded.estado,ultimo_ping=excluded.ultimo_ping,slots=excluded.slots''',
            (install, kind, version, queue, pending, last, state, agora(), serializar(safe)))
        # 'tipo' volta no recibo para o servidor dizer qual versao ele empacotou (a extensao nao
        # sabe se esta velha; so o painel sabia, e so quando estava aberto)
        return {'ok': True, 'status': 'ok', 'instalacao_id': install, 'tipo': kind, 'ext_version': version}
