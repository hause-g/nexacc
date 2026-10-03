"""Backup verificável; preparação fora do banco destino e troca transacional."""
import json
import math
import os
import re
import sqlite3
import uuid
import db
from dados_schema import BACKUP_TABLES, SCHEMA, SCHEMA_VERSION, create_tables
from dados_validacao import (Conflito, Invalido, agora, booleano, centavos, contexto, dinheiro,
                            hash_json, identidade, instante, numero, objeto, serializar, texto)

FORMAT_VERSION = 2
JSON_COLUMNS = {
    'pedidos': ('contexto',), 'fechamentos': ('metas_ids', 'resumo', 'resposta'),
    'recebimentos': ('resposta',), 'instalacoes': ('slots',), 'agente_fontes': ('dados',),
    'agente_paginas': ('membros',), 'agente_listas': ('membros',),
}


def _validate_business_json(tables):
    from dados_fontes import _members, _period
    states = ('identificado', 'processando', 'confirmado', 'falhou', 'verificar')
    for row in tables['pedidos']:
        ctx = json.loads(row['contexto'] or '{}')
        objeto(ctx)
        if set(ctx) - {'instalacao_id', 'tab_id', 'frame_id', 'geracao'}:
            raise Invalido('contexto contém campo desconhecido')
        contexto(ctx)
    for row in tables['pedido_eventos']:
        if row['estado'] not in states:
            raise Invalido('estado do evento inválido')
        numero(row['revision'], 'revision', inteiro=True)
        dinheiro(row['valor'], 'valor', nulo=True)
        instante(row['observado_em'])
        instante(row['recebido_em'])
    for row in tables['instalacoes']:
        if row['tipo'] not in ('player', 'mae'):
            raise Invalido('tipo da instalação inválido')
        texto(row['instalacao_id'], 'instalacao_id')
        numero(row['fila'], 'fila', nulo=True, inteiro=True)
        numero(row['pendentes'], 'pendentes', nulo=True, inteiro=True)
        instante(row['ultimo_evento'], nulo=True)
        instante(row['ultimo_ping'])
        slots = json.loads(row['slots'] or '[]')
        if not isinstance(slots, list) or len(slots) > 1000:
            raise Invalido('slots inválidos no backup')
        for slot in slots:
            objeto(slot)
            if set(slot) - {'tab_id','frame_id','geracao','casa','conta','estado','slot_id',
                            'fila','pendentes','ultimo_evento','ultima_resposta','ultima_confirmacao','diagnosticado_em','host','casa_normalizada','versao_pagina'}:
                raise Invalido('campo desconhecido em slots')
            for key, value in slot.items():
                if key in ('fila','pendentes'):
                    numero(value,key,nulo=True,inteiro=True)
                elif key in ('ultimo_evento','ultima_resposta','ultima_confirmacao','diagnosticado_em'):
                    instante(value,key,nulo=True)
                elif value is not None:
                    identidade(value,key,vazio=True)
    for row in tables['agente_fontes']:
        if row['fonte'] not in ('periodo','total','membros','info') or row['tipo'] not in ('agente_total','agente_membros','agente_info'):
            raise Invalido('fonte da mãe inválida')
        _period(row['periodo'], row['fonte'])
        data = objeto(json.loads(row['dados']))
        if set(data) - {'fonte','periodo','periodo_observado','unidade_contador','conta_mae','conta_mae_nome',
                        'deposito','contas','primeiro_deposito','saque','aposta','membros_qtd','coleta_id',
                        'pagina','total_paginas','lista_completa','mais','membros_recebidos','paginas_recebidas',
                        'periodo_enum','periodo_conflito','janela_inicio','janela_fim'}:
            raise Invalido('campo desconhecido nos dados da mãe')
        if 'periodo_enum' in data:
            numero(data['periodo_enum'], 'periodo_enum', nulo=True, inteiro=True)
        if ('janela_inicio' in data) != ('janela_fim' in data):
            raise Invalido('janela da mãe incompleta')
        if 'janela_inicio' in data:
            if numero(data['janela_fim'], 'janela_fim', inteiro=True) <= numero(data['janela_inicio'], 'janela_inicio', inteiro=True):
                raise Invalido('janela da mãe com fim antes do início')
        if 'periodo_conflito' in data:
            objeto(data['periodo_conflito'])
        if any(data.get(key) != row[key] for key in ('fonte','periodo','unidade_contador')):
            raise Invalido('escopo da mãe inconsistente')
        booleano(data.get('periodo_observado'), 'periodo_observado')
        if row['unidade_contador'] not in ('contas','pessoas','depositos','desconhecida'):
            raise Invalido('unidade da mãe inválida')
        for key in ('deposito','saque','aposta','primeiro_deposito','contas','membros_qtd'):
            if key in data:
                numero(data[key], key, nulo=True, inteiro=key in ('contas','membros_qtd'))
        instante(row['recebido_em'])
    for table in ('agente_paginas','agente_listas'):
        for row in tables[table]:
            if row['fonte'] not in ('periodo','total','membros','info'):
                raise Invalido('fonte de lista inválida')
            _period(row['periodo'],row['fonte'])
            texto(row['coleta_id'],'coleta_id')
            _members(json.loads(row['membros']))
            instante(row['recebido_em'])
            total = numero(row['total_paginas'],'total_paginas',inteiro=True,nulo=table=='agente_paginas',minimo=1)
            if table == 'agente_paginas':
                page = numero(row['pagina'],'pagina',inteiro=True)
                if row['lista_completa'] not in (0,1) or total is not None and page > total:
                    raise Invalido('página inválida')
                if row['lista_completa'] and (page == 0 or total is None):
                    raise Invalido('fim de lista sem página explícita')
    for row in tables['recebimentos']:
        result = objeto(json.loads(row['resposta']))
        if (row['rota'] not in ('operation','pedido','pendente','agente','jogos_cat','conta','jogo')
            or not re.fullmatch('[a-f0-9]{64}',row['payload_hash'])
            or result.get('status') not in ('ok','duplicado','enriquecido','promovido','descartado')
            or result.get('event_id') != row['event_id'] or result.get('revision') != row['revision']):
            raise Invalido('recibo de evento inválido')
    for row in tables['fechamentos']:
        summary, metas = json.loads(row['resumo']), json.loads(row['metas_ids'])
        if not isinstance(metas,list) or len(metas) != len(set(texto(m,'meta') for m in metas)):
            raise Invalido('metas de fechamento inválidas')
        bonus = centavos(dinheiro(row['gerente'],'gerente'))*10 + centavos(dinheiro(row['bau'],'bau'))*10
        manual = centavos(dinheiro(row['saque_manual'],'saque_manual',minimo=None))
        dep = centavos(dinheiro(summary.get('deposito'),'deposito'))
        withdraw = centavos(dinheiro(summary.get('saque'),'saque'))
        result = centavos(dinheiro(summary.get('resultado'),'resultado',minimo=None))
        if centavos(dinheiro(summary.get('gerente_bau'),'gerente_bau')) != bonus or result != withdraw-dep+bonus:
            raise Invalido('valores congelados inconsistentes')
        if centavos(dinheiro(summary.get('saque_manual'),'saque_manual',minimo=None)) != manual:
            raise Invalido('saque manual congelado inconsistente')
        numero(summary.get('contas'),'contas',nulo=True,inteiro=True)
        houses = summary.get('por_casa')
        if not isinstance(houses,list):
            raise Invalido('casas de fechamento inválidas')
        sums = [0,0]
        for house in houses:
            objeto(house)
            texto(house.get('casa'),'casa')
            sums[0] += centavos(dinheiro(house.get('deposito'),'deposito'))
            sums[1] += centavos(dinheiro(house.get('saque'),'saque'))
            numero(house.get('contas'),'contas',nulo=True,inteiro=True)
        if sums[0] != dep or sums[1]+manual != withdraw:
            raise Invalido('totais por casa inconsistentes')


def _manifest(tables):
    return {'algoritmo': 'sha256-json-typed-ieee754-utf8-v2',
            'hashes': {t: hash_json(tables[t]) for t in BACKUP_TABLES},
            'contagens': {t: len(tables[t]) for t in BACKUP_TABLES}}


def exportar_banco(c, version):
    tables = {t: [dict(r) for r in c.execute('SELECT * FROM "' + t + '" ORDER BY rowid')] for t in BACKUP_TABLES}
    # Sessões legadas ficam preservadas na cópia SQLite local; nunca são servidas por HTTP.
    for row in tables['contas']:
        row['sessao'] = None
        row['host'] = None
    sequences = {r['name']: r['seq'] for r in c.execute('SELECT name,seq FROM sqlite_sequence') if r['name'] in BACKUP_TABLES}
    manifest = _manifest(tables)
    manifest['sequencias_hash'] = hash_json(sequences)
    manifest['versao'] = version
    manifest['criado_em'] = agora()
    manifest['cobertura'] = {'completa': False, 'banco_negocio': True, 'filas_externas': False,
        'navegador': False, 'instalacoes_necessarias': [r['instalacao_id'] for r in tables['instalacoes']],
        'motivo': 'snapshot do banco; filas das extensões e estado dos navegadores exigem coleta coordenada'}
    manifest['redacoes'] = ['contas.sessao', 'contas.host']
    result = {'_v': FORMAT_VERSION, 'schema_version': SCHEMA_VERSION, 'tabelas': tables,
              'sequencias': sequences, 'manifesto': manifest}
    # Não produzir exportação aparentemente válida se houve corrupção do armazenamento.
    validar_banco(result)
    return result


def _validate_cell(value, info, table):
    field, kind = info['name'], info['type']
    if value is None:
        if info['notnull']:
            raise Invalido(table + '.' + field + ' não pode ser nulo')
        return
    if isinstance(value, bool):
        raise Invalido(table + '.' + field + ' tipo inválido')
    if kind == 'TEXT':
        if not isinstance(value, str) or len(value) > 50000000:
            raise Invalido(table + '.' + field + ' texto inválido')
    elif kind == 'INTEGER':
        if type(value) is not int or abs(value) > 9223372036854775807:
            raise Invalido(table + '.' + field + ' inteiro inválido')
    elif kind == 'REAL':
        if type(value) not in (int, float) or not math.isfinite(value):
            raise Invalido(table + '.' + field + ' número inválido')
    else:
        raise Invalido('tipo de coluna desconhecido')
    if field in JSON_COLUMNS.get(table, ()):
        try:
            json.loads(value, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        except (ValueError, TypeError):
            raise Invalido(table + '.' + field + ' JSON inválido') from None


def _stage(snapshot):
    objeto(snapshot)
    # Aceita backup de schema ANTERIOR, de forma aditiva: exigir igualdade exata tornava todo JSON
    # exportado irrestaurável no primeiro bump de schema — justamente quando mais se precisa dele.
    # Tabela ou coluna que ainda não existia entra vazia/NULL; desconhecida continua recusada, e
    # coluna NOT NULL sem default faz o restore falhar em vez de inventar dado.
    version = snapshot.get('schema_version')
    if snapshot.get('_v') != FORMAT_VERSION or type(version) is not int or not 1 <= version <= SCHEMA_VERSION:
        raise Invalido('versão de backup incompatível; exporte um backup completo atualizado')
    tables = snapshot.get('tabelas')
    if not isinstance(tables, dict) or set(tables) - set(BACKUP_TABLES):
        raise Invalido('tabelas ausentes ou desconhecidas no backup')
    if version == SCHEMA_VERSION and set(tables) != set(BACKUP_TABLES):
        raise Invalido('tabelas ausentes ou desconhecidas no backup')
    manifest = snapshot.get('manifesto')
    if not isinstance(manifest, dict):
        raise Invalido('manifesto ausente')
    presentes = sorted(tables)
    for t in presentes:
        if not isinstance(tables[t], list) or len(tables[t]) > 2000000:
            raise Invalido('tabela inválida: ' + t)
    # Integridade conferida sobre o que o backup afirma conter (o manifesto antigo só tem as
    # tabelas da época); tabela nova entra vazia depois da conferência.
    if (manifest.get('algoritmo') != _manifest({t: tables[t] for t in presentes})['algoritmo']
            or manifest.get('hashes') != {t: hash_json(tables[t]) for t in presentes}
            or manifest.get('contagens') != {t: len(tables[t]) for t in presentes}):
        raise Invalido('integridade do backup inválida')
    for t in BACKUP_TABLES:
        tables.setdefault(t, [])
    sequences = snapshot.get('sequencias')
    if not isinstance(sequences, dict) or manifest.get('sequencias_hash') != hash_json(sequences):
        raise Invalido('sequências inválidas')
    for table, value in sequences.items():
        if table not in BACKUP_TABLES or 'AUTOINCREMENT' not in SCHEMA[table] or type(value) is not int or value < 0:
            raise Invalido('sequência desconhecida ou inválida')
    c = sqlite3.connect(':memory:')
    c.row_factory = sqlite3.Row
    try:
        create_tables(c)
        for table in BACKUP_TABLES:
            info = list(c.execute('PRAGMA table_info("' + table + '")'))
            columns = [i['name'] for i in info]
            tipos = {i['name']: i for i in info}
            for row in tables[table]:
                if not isinstance(row, dict) or set(row) - set(columns):
                    raise Invalido('colunas ausentes ou desconhecidas: ' + table)
                if version == SCHEMA_VERSION and set(row) != set(columns):
                    raise Invalido('colunas ausentes ou desconhecidas: ' + table)
                presentes_col = [name for name in columns if name in row]
                for name in presentes_col:
                    _validate_cell(row[name], tipos[name], table)
                # Só as colunas que o backup traz: as criadas depois ficam com o DEFAULT do schema.
                c.execute('INSERT INTO "' + table + '" (' + ','.join(presentes_col) + ') VALUES('
                          + ','.join('?' for _ in presentes_col) + ')', [row[name] for name in presentes_col])
        cycles = {r['id']: r for r in tables['ciclos']}
        if not cycles or sum(r['aberto'] == 1 for r in cycles.values()) != 1 or any(r['aberto'] not in (0, 1) for r in cycles.values()):
            raise Invalido('backup deve ter exatamente um ciclo aberto')
        for r in cycles.values():
            start, end = instante(r['criado_em'], nulo=True), instante(r['fechado_em'], nulo=True)
            if r['id'] < 1 or start is not None and end is not None and end < start:
                raise Invalido('ciclo inválido')
        for table in ('operacoes', 'jogos', 'pendentes', 'ajustes', 'descartados', 'pedidos', 'pedido_eventos', 'fechamentos'):
            for row in tables[table]:
                if row['ciclo_id'] not in cycles:
                    raise Invalido('referência de ciclo inválida: ' + table)
        for table in ('operacoes', 'pedidos'):
            for row in tables[table]:
                if row['tipo'] not in ('deposito', 'saque') or not row['numero_pedido']:
                    raise Invalido('operação/pedido inválido')
                if row['valor'] is not None and row['valor'] < 0:
                    raise Invalido('valor negativo no backup')
                for field in ('data', 'observado_em', 'recebido_em'):
                    instante(row.get(field), field, nulo=True)
        for row in tables['pedidos']:
            if row['estado'] not in ('identificado', 'processando', 'confirmado', 'falhou', 'verificar') or row['revision'] < 0:
                raise Invalido('estado/revisão do pedido inválido')
        for row in tables['fechamentos']:
            if row['novo_ciclo_id'] not in cycles or cycles[row['ciclo_id']]['aberto']:
                raise Invalido('ciclo de fechamento inválido')
            result, summary, metas = json.loads(row['resposta']), json.loads(row['resumo']), json.loads(row['metas_ids'])
            if (not isinstance(result, dict) or not isinstance(summary, dict) or not isinstance(metas, list)
                or result.get('fechamento_id') != row['fechamento_id'] or result.get('ciclo_id') != row['ciclo_id']
                or result.get('novo_ciclo_id') != row['novo_ciclo_id'] or result.get('resumo') != summary or result.get('metas_ids') != metas):
                raise Invalido('fechamento inconsistente')
        _validate_business_json(tables)
        for row in tables['contas']:
            if row['sessao'] is not None or row['host'] is not None:
                raise Invalido('backup HTTP não deve conter sessões/hosts legados')
        for row in tables['controles']:
            if row['chave'] == 'casas_identidade_v1':
                from dados_identidade import validate
                validate(json.loads(row['valor']))
            elif row['chave'] == 'cronograma':
                db.validar_cronograma(json.loads(row['valor']))
            elif row['chave'] == 'last_op_ts':
                instante(row['valor'])
            elif row['chave'] == 'varrer_saque_ts':
                if not row['valor'].isdecimal():
                    raise Invalido('controle de varredura inválido')
            elif row['chave'] == 'periodo':
                if row['valor'] not in ('hoje', 'ontem', 'mes', 'semana', 'ultima'):
                    raise Invalido('período inválido')
            elif row['chave'] == 'periodo_enum_calibracao':
                from dados_fontes import validar_calibracao
                validar_calibracao(json.loads(row['valor']))
            elif row['chave'] == 'periodo_enum_janela':
                from dados_fontes import validar_janelas
                validar_janelas(json.loads(row['valor']))
            elif row['chave'] == 'painel_estado':
                guardado = objeto(json.loads(row['valor']))
                if set(guardado) - {'revisao', 'atualizado_em', 'estado'}:
                    raise Invalido('estado do painel com campo desconhecido')
                numero(guardado.get('revisao'), 'revisao', inteiro=True)
                instante(guardado.get('atualizado_em'))
                metas = objeto(guardado.get('estado')).get('operacoes')
                if metas is not None:
                    db.validar_metas(metas)
            elif row['chave'] == 'painel_metas_historico':
                historico = json.loads(row['valor'])
                if not isinstance(historico, list) or len(historico) > 20:
                    raise Invalido('histórico de metas inválido')
                for item in historico:
                    objeto(item)
                    if set(item) - {'revisao', 'quando', 'metas'}:
                        raise Invalido('histórico de metas com campo desconhecido')
                    db.validar_metas(item.get('metas'))
            elif row['chave'] == 'contas_permissoes':
                db.validar_permissoes(json.loads(row['valor']))
            elif row['chave'] == 'ciclos_historico':
                historico = json.loads(row['valor'])
                if not isinstance(historico, list) or len(historico) > 50:
                    raise Invalido('histórico de ciclos inválido')
                for evento in historico:
                    objeto(evento)
                    if set(evento) - {'de', 'para', 'quando', 'origem'}:
                        raise Invalido('evento de ciclo com campo desconhecido')
                    numero(evento.get('de'), 'de', inteiro=True, nulo=True)
                    numero(evento.get('para'), 'para', inteiro=True)
                    instante(evento.get('quando'))
                    texto(evento.get('origem'), 'origem')
            elif row['chave'] == 'jogos_identidade':
                from dados_jogos import validar_jogos_identidade
                validar_jogos_identidade(json.loads(row['valor']))
            elif row['chave'] == 'dispensados':
                marcas = objeto(json.loads(row['valor']))
                if set(marcas) - set(db.DISPENSAVEIS):
                    raise Invalido('dispensa de tipo desconhecido')
                for quando in marcas.values():
                    instante(quando)
            elif row['chave'] == 'extras':
                extras = objeto(json.loads(row['valor']))
                if set(extras) - {'ciclo_id', 'gerente', 'bau', 'saque_manual'}:
                    raise Invalido('extras do ciclo com campo desconhecido')
                numero(extras.get('ciclo_id'), 'ciclo_id', inteiro=True)
                for campo in ('gerente', 'bau'):
                    dinheiro(extras.get(campo), campo, nulo=True)
                for casa, valor in objeto(extras.get('saque_manual') or {}).items():
                    identidade(casa, 'casa')
                    dinheiro(valor, 'saque_manual', minimo=None)
            elif row['chave'] == 'abrir_jogo':
                # O pedido do botao de jogo e um controle como outro qualquer. Fora desta lista,
                # UM clique na moeda derrubava o /api/backup do banco inteiro — e derrubou.
                alvo = objeto(json.loads(row['valor']))
                if set(alvo) - {'casas', 'id_jogo', 'ts'}:
                    raise Invalido('pedido de jogo com campo desconhecido')
                for casa in alvo.get('casas') or []:
                    identidade(casa, 'casa')
                identidade(alvo.get('id_jogo'), 'id_jogo')
                # carimbo em MILISSEGUNDOS: nao cabe no teto de numero(), igual varrer_saque_ts
                if not isinstance(alvo.get('ts'), int) or isinstance(alvo.get('ts'), bool) or alvo['ts'] < 0:
                    raise Invalido('carimbo do pedido de jogo inválido')
            elif row['chave'] == 'jogos_catalogo':
                # Catalogo de jogos (id + nome oficial) semeado do listPlatformGameV2. Controle como
                # outro qualquer — fora desta lista derrubaria o /api/backup, mesma armadilha do abrir_jogo.
                cat = json.loads(row['valor'])
                if not isinstance(cat, list) or len(cat) > 5000:
                    raise Invalido('catalogo de jogos inválido')
                for jg in cat:
                    objeto(jg)
                    if set(jg) - {'id', 'nome', 'destaque', 'provedor'}:
                        raise Invalido('jogo do catalogo com campo desconhecido')
                    identidade(jg.get('id'), 'id_jogo')
                    texto(jg.get('nome', ''), 'nome', vazio=True, limite=80)
            elif row['chave'] == 'metas_por_casa':
                # Alvo de deposito por casa (card Meta por casa). Controle como outro — fora desta
                # lista derrubaria o /api/backup, a mesma armadilha do abrir_jogo/jogos_catalogo.
                mc = objeto(json.loads(row['valor']))
                if set(mc) - {'ciclo_id', 'alvos'}:
                    raise Invalido('metas_por_casa com campo desconhecido')
                numero(mc.get('ciclo_id'), 'ciclo_id', inteiro=True, nulo=True)
                for casa, valor in objeto(mc.get('alvos') or {}).items():
                    identidade(casa, 'casa')
                    dinheiro(valor, 'alvo', minimo=None)
            else:
                raise Invalido('controle desconhecido')
        for table, value in sequences.items():
            maximum = c.execute('SELECT COALESCE(MAX(id),0) FROM "' + table + '"').fetchone()[0]
            if value < maximum:
                raise Invalido('sequência menor que os IDs existentes')
        if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise Invalido('backup sem integridade')
        return c
    except (sqlite3.Error, ValueError, TypeError, KeyError) as exc:
        c.close()
        if isinstance(exc, Invalido):
            raise
        raise Invalido('backup inválido; restauração não iniciada') from None


def validar_banco(snapshot):
    c = _stage(snapshot)
    try:
        return {'status': 'ok', 'valido': True, 'schema_version': SCHEMA_VERSION,
                'linhas': sum(len(rows) for rows in snapshot['tabelas'].values()),
                'cobertura': {'completa': False, 'banco_negocio': True, 'filas_externas': False, 'navegador': False,
                             'motivo': 'somente o banco de negócio foi validado; filas e navegadores não incluídos'}}
    finally:
        c.close()


RETENCAO_COPIAS = 5


def _reter(directory):
    """Mantém as cópias mais recentes e toda cópia citada em restauracoes. Nunca interrompe."""
    try:
        with db._lock, db._c() as c:
            usadas = {r['backup_local'] for r in c.execute(
                'SELECT backup_local FROM restauracoes WHERE backup_local IS NOT NULL')}
        arquivos = []
        for nome in os.listdir(directory):
            if nome.startswith('antes-restore-') and nome.endswith('.sqlite3'):
                caminho = os.path.join(directory, nome)
                arquivos.append((os.path.getmtime(caminho), nome, caminho))
        arquivos.sort(reverse=True)
        for _, nome, caminho in arquivos[RETENCAO_COPIAS:]:
            if nome not in usadas:
                os.remove(caminho)
    except (OSError, sqlite3.Error):
        return


def _preserve_original():
    directory = os.path.join(os.path.dirname(os.path.abspath(db.DB_PATH)), '_backups')
    os.makedirs(directory, exist_ok=True)
    name = 'antes-restore-' + uuid.uuid4().hex + '.sqlite3'
    path = os.path.join(directory, name)
    source = sqlite3.connect(db.DB_PATH, timeout=30)
    target = sqlite3.connect(path)
    try:
        source.backup(target)
        # A cópia é ponto de recuperação FIEL do banco vivo, inclusive contas.sessao — contrato
        # deliberado (ver exportar_banco: a sessão é redigida no JSON, nunca servida por HTTP, mas
        # preservada aqui) e coberto por test_restore_rollback_after_delete_and_preserves_native_original.
        # Não limpar aqui sem decisão explícita do dono dos dados.
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise Invalido('não foi possível preservar o banco anterior')
        target.commit()
    except BaseException:
        # Cópia truncada não pode ficar no diretório: seria oferecida como ponto de restauração.
        target.close()
        source.close()
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    target.close()
    source.close()
    _reter(directory)
    return name


def _restore_rows(c, snapshot):
    for table in reversed(BACKUP_TABLES):
        c.execute('DELETE FROM "' + table + '"')
    for table in BACKUP_TABLES:
        if 'AUTOINCREMENT' in SCHEMA[table]:
            c.execute('DELETE FROM sqlite_sequence WHERE name=?', (table,))
    for table in BACKUP_TABLES:
        info = list(c.execute('PRAGMA table_info("' + table + '")'))
        columns = [i['name'] for i in info]
        # Mesma regra aditiva de _stage (que ja validou tudo): backup de schema anterior nao traz as
        # colunas criadas depois, e elas assumem o DEFAULT. Agrupado por conjunto de colunas para
        # manter o executemany.
        grupos = {}
        for row in snapshot['tabelas'].get(table, []):
            presentes = tuple(name for name in columns if name in row)
            grupos.setdefault(presentes, []).append([row[name] for name in presentes])
        for presentes, linhas in grupos.items():
            c.executemany('INSERT INTO "' + table + '" (' + ','.join(presentes) + ') VALUES('
                          + ','.join('?' for _ in presentes) + ')', linhas)
    for table, value in snapshot['sequencias'].items():
        c.execute('DELETE FROM sqlite_sequence WHERE name=?', (table,))
        c.execute('INSERT INTO sqlite_sequence VALUES(?,?)', (table, value))
    c.execute('UPDATE revisao SET epoch=?,valor=valor+1 WHERE id=1', (uuid.uuid4().hex,))


def restaurar_banco(request):
    objeto(request)
    snapshot = request.get('banco', request)
    if request.get('validar') is True:
        return validar_banco(snapshot)
    if request.get('confirmar') is not True:
        raise Invalido('confirmação explícita obrigatória')
    restore_id = texto(request.get('restore_id'), 'restore_id')
    fingerprint = hash_json(snapshot)
    with db._lock:
        with db._c() as c:
            old = c.execute('SELECT * FROM restauracoes WHERE restore_id=?', (restore_id,)).fetchone()
            if old and old['payload_hash'] != fingerprint:
                raise Conflito('restore_id reutilizado com backup diferente')
            if old and old['estado'] == 'concluido':
                return json.loads(old['resposta'])
            db._expected(c, request)
        validation = validar_banco(snapshot)  # completo, antes de DELETE e da cópia de recuperação
        with db._c() as c:
            c.execute('''INSERT INTO restauracoes VALUES(?,?,?,?,?,?) ON CONFLICT(restore_id)
                DO UPDATE SET estado=excluded.estado,resposta=NULL,backup_local=excluded.backup_local,atualizado_em=excluded.atualizado_em''',
                (restore_id, fingerprint, 'preparado', None, None, agora()))
        try:
            with db._c() as c:
                db._expected(c, request)
                # BEGIN IMMEDIATE impede outro processo de escrever entre a cópia e os DELETE.
                backup = _preserve_original()
                c.execute('UPDATE restauracoes SET backup_local=? WHERE restore_id=?', (backup, restore_id))
                _restore_rows(c, snapshot)
                result = {'status': 'ok', 'restore_id': restore_id, 'estado': 'concluido', 'linhas': validation['linhas'],
                          'backup_anterior': backup, 'versao': db._versao(c), 'cobertura': validation['cobertura']}
                c.execute("UPDATE restauracoes SET estado='concluido',resposta=?,atualizado_em=? WHERE restore_id=?",
                          (serializar(result), agora(), restore_id))
                return result
        except BaseException:
            # A transação já desfez todos os DELETE/INSERT antes de registrar a falha.
            with db._c() as c:
                c.execute("UPDATE restauracoes SET estado='falhou',atualizado_em=? WHERE restore_id=?", (agora(), restore_id))
            raise
