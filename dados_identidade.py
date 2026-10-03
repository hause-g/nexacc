"""Identidade explícita sobre chaves legadas. Nunca reescreve o livro financeiro.

Documento versionado em controles (já transacional e incluído no backup v2).
Assim backups existentes continuam compatíveis, sem reconstruir tabelas de dinheiro.
"""
import json
import re
import uuid
import db
from dados_validacao import Invalido, Conflito, agora, identidade, texto, hash_json, serializar, instante

KEY = 'casas_identidade_v1'


def hostname(value):
    value = str(value or '').strip().lower()
    if value.endswith('.'): value=value[:-1]
    if len(value) > 253 or not re.fullmatch(r'([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+', value):
        return ''
    return value.removeprefix('www.')


def validate(r):
    if not isinstance(r, dict) or set(r) != {'version', 'casas', 'chaves', 'origens', 'historico'} or r['version'] != 1:
        raise Invalido('registro de identidades inválido')
    if not all(isinstance(r[k], dict) for k in ('casas', 'chaves', 'origens')) or not isinstance(r['historico'], list):
        raise Invalido('estrutura de identidades inválida')
    for cid, info in r['casas'].items():
        try: uuid.UUID(cid)
        except (ValueError, TypeError): raise Invalido('identidade interna inválida')
        if not isinstance(info, dict) or set(info) != {'nome','personalizado'} or type(info['personalizado']) is not bool: raise Invalido('nome de identidade inválido')
        texto(info['nome'], 'nome', limite=100)
    for key, cid in r['chaves'].items():
        identidade(key, 'chave')
        if cid not in r['casas']: raise Invalido('referência de identidade ausente')
    for key, origins in r['origens'].items():
        if key not in r['chaves'] or not isinstance(origins, list) or len(origins) > 100: raise Invalido('origens inválidas')
        for origin in origins:
            if set(origin) != {'host', 'papel'} or hostname(origin['host']) != origin['host'] or origin['papel'] not in ('player','mae'):
                raise Invalido('origem inválida')
    for event in r['historico']:
        if not isinstance(event, dict) or set(event) != {'id','antes','depois','backup','quando','desfeito','token'}:
            raise Invalido('histórico de associação inválido')
        for k in ('antes','depois'):
            if not isinstance(event[k], dict) or any(x not in r['casas'] for x in event[k].values()):
                raise Invalido('histórico de associação inconsistente')
        if set(event['antes'])!=set(event['depois']) or not set(event['antes']).issubset(r['chaves']): raise Invalido('chaves do histórico inválidas')
        try: uuid.UUID(event['id'])
        except (ValueError,TypeError): raise Invalido('evento de associação inválido')
        if type(event['desfeito']) is not bool or not re.fullmatch(r'[a-f0-9]{64}',str(event['token'])): raise Invalido('confirmação inválida')
        if not re.fullmatch(r'antes-restore-[a-f0-9]{32}\.sqlite3',str(event['backup'])): raise Invalido('referência de backup inválida')
        instante(event['quando'])
    return r


def load(c):
    row = c.execute('SELECT valor FROM controles WHERE chave=?', (KEY,)).fetchone()
    return validate(json.loads(row[0])) if row else {'version':1,'casas':{},'chaves':{},'origens':{},'historico':[]}


def save(c, r):
    validate(r)
    c.execute('INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor', (KEY, serializar(r)))


def ensure(r, key):
    if not key or key in r['chaves']: return
    cid = str(uuid.uuid4())
    r['chaves'][key] = cid
    r['casas'][cid] = {'nome':str(key).upper()[:100], 'personalizado':False}
    r['origens'][key] = []


def seed(c):
    r = load(c);before = serializar(r)
    for table in ('operacoes','pedidos','agente','foco','encerradas'):
        for row in c.execute('SELECT DISTINCT casa FROM '+table+' WHERE casa IS NOT NULL AND casa<>\'\''):
            # Um UUID por chave existente. Não unir nomes ou números semelhantes.
            ensure(r,row[0])
    if serializar(r) != before: save(c,r)
    return r


def observe(c, d, role):
    key = d.get('casa')
    if not isinstance(key,str) or not key: return
    r=load(c);before=serializar(r);ensure(r,key)
    host=hostname(d.get('host'))
    origin={'host':host,'papel':role}
    if host and origin not in r['origens'][key] and len(r['origens'][key])<100: r['origens'][key].append(origin)
    if serializar(r)!=before: save(c,r)


def expand(c, keys):
    r=load(c);selected={r['chaves'].get(k,k) for k in keys}
    return sorted(set(keys)|{k for k,cid in r['chaves'].items() if cid in selected})


def snapshot(c):
    r=seed(c);houses=[]
    for cid,info in r['casas'].items():
        keys=sorted(k for k,v in r['chaves'].items() if v==cid)
        if keys: houses.append({'id':cid,'nome':info['nome'],'chaves':keys,'origens':[{**o,'chave':k} for k in keys for o in r['origens'].get(k,[])]})
    parent_keys={row['casa'] for row in c.execute('SELECT casa FROM agente')}
    parent_ids={}
    for row in c.execute("SELECT DISTINCT casa,conta_mae FROM agente_fontes WHERE conta_mae<>''"):
        parent_ids.setdefault(row['casa'],set()).add(row['conta_mae'])
    mapping={};ambiguous=[]
    for house in houses:
        parents=[k for k in house['chaves'] if k in parent_keys]
        if len(parents)==1 and len(parent_ids.get(parents[0],set()))==1:
            mapping.update({k:parents[0] for k in house['chaves']})
        elif parents: ambiguous.extend(house['chaves'])
        # A chave antiga pode ter sido compartilhada por domínios não relacionados.
        # Vários hosts na mesma chave exigem investigação, não uma prova por nome.
        if any(len({o['host'] for o in r['origens'].get(k,[])})>1 for k in house['chaves']):
            ambiguous.extend(house['chaves'])
            for k in house['chaves']: mapping.pop(k,None)
    candidates=[];pares=set()
    for i,a in enumerate(houses):
        ah={o['host'] for o in a['origens']}
        for b in houses[i+1:]:
            bh={o['host'] for o in b['origens']}
            # Só propor juntar quando as duas casas cobrem EXATAMENTE o(s) mesmo(s) domínio(s) de
            # lançamento — aí é a MESMA plataforma dividida em chaves (mãe e filha do mesmo domínio).
            # Overlap PARCIAL não vale: uma casa com {p1-casinhapg, p1-fornopg, p1-assinarpg} e
            # outra só {p1-casinhapg} são lançamentos DIFERENTES da mesma REDE (p1); juntar
            # misturaria plataformas distintas (casinha não é forno). Domínio em comum não basta.
            if ah and ah==bh:
                pares.add(frozenset((a['id'],b['id'])))
                candidates.append({'origem':a['id'],'destino':b['id'],'hosts':sorted(ah),'estado':'requer_confirmacao'})
    # Mae e filha ficam em dominios diferentes (a mae no host do relatorio, a filha no link com o
    # nome), entao nunca compartilham host e o sinal acima jamais as encontra. O vinculo real e a
    # CONTA: se quem opera na filha esta na lista de membros da mae, e a mesma casa. Continua sendo
    # apenas proposta — associar exige previa e confirmacao, como qualquer outra.
    casa_de={};por_filha={};por_mae={}
    for house in houses:
        for k in house['chaves']: casa_de[k]=house['id']
    # Os membros da mae ficam em tres lugares: agente_membros (legado), agente_listas (consolidada)
    # e agente_paginas (parcial). Ler so o legado deixaria de fora exatamente as casas novas.
    membros={}
    for row in c.execute('SELECT casa,conta FROM agente_membros'):
        if row['conta']: membros.setdefault(row['casa'],set()).add(str(row['conta']))
    for tabela in ('agente_listas','agente_paginas'):
        for row in c.execute('SELECT casa,membros FROM '+tabela):
            try: lista=json.loads(row['membros'] or '[]')
            except ValueError: continue
            for m in lista if isinstance(lista,list) else []:
                conta=str((m or {}).get('conta') or '') if isinstance(m,dict) else ''
                if conta: membros.setdefault(row['casa'],set()).add(conta)
    operou={}
    for row in c.execute("SELECT DISTINCT casa,conta FROM operacoes WHERE conta<>''"):
        operou.setdefault(row['casa'],set()).add(str(row['conta']))
    for filha,contas in operou.items():
        for mae,lista in membros.items():
            if mae==filha: continue
            n=len(contas&lista)
            if n<2: continue
            por_filha.setdefault(filha,[]).append((mae,n))
            por_mae.setdefault(mae,[]).append((filha,n))
    for filha,maes in por_filha.items():
        # So propor quando o par e mutuo e sem concorrente: duvida vira investigacao, nao palpite.
        if len(maes)!=1: continue
        mae,n=maes[0]
        if len(por_mae.get(mae,[]))!=1: continue
        origem,destino=casa_de.get(mae),casa_de.get(filha)
        if not origem or not destino or origem==destino: continue
        if frozenset((origem,destino)) in pares: continue
        pares.add(frozenset((origem,destino)))
        # destino = a filha: e o link com o nome legivel, entao a casa resultante ja nasce com o
        # nome bom. O apelido continua editavel depois.
        candidates.append({'origem':origem,'destino':destino,'contas':n,'chaves':[mae,filha],'estado':'requer_confirmacao'})
    return {'casas':houses,'por_chave':r['chaves'],'apelidos':{k:r['casas'][cid]['nome'] for k,cid in r['chaves'].items() if r['casas'][cid]['personalizado']},
            'candidatos':candidates,'ambiguas':sorted(set(ambiguous)),'mapeamento':mapping,
            'historico':[{'id':e['id'],'quando':e['quando'],'desfeito':e['desfeito'],'chaves':list(e['antes'])} for e in r['historico']]}


@db._api
def rename(d):
    name=texto(d.get('nome'),'nome',limite=100)
    with db._lock,db._c() as c:
        r=seed(c);cid=r['chaves'].get(d.get('chave'),d.get('id'))
        if cid not in r['casas']: raise Invalido('casa não identificada')
        r['casas'][cid].update(nome=name,personalizado=True);save(c,r)
        return {'status':'ok','id':cid,'nome':name}


def preview(c,d):
    r=seed(c);a,b=d.get('origem'),d.get('destino')
    if a==b or a not in r['casas'] or b not in r['casas']: raise Invalido('selecione duas identidades diferentes')
    ka=sorted(k for k,v in r['chaves'].items() if v==a);kb=sorted(k for k,v in r['chaves'].items() if v==b)
    if not ka or not kb: raise Conflito('associação já alterada')
    keys=ka+kb;placeholders=','.join('?' for _ in keys)
    rows=[dict(x) for x in c.execute('SELECT id,casa,conta,numero_pedido,tipo,valor,ciclo_id FROM operacoes WHERE casa IN ('+placeholders+') ORDER BY id',keys)]
    pending=[dict(x) for x in c.execute('SELECT casa,conta,numero_pedido,estado,valor FROM pedidos WHERE casa IN ('+placeholders+') ORDER BY casa,conta,numero_pedido',keys)]
    seen={};conflicts=[]
    for row in rows+pending:
        # IDs iguais em chaves diferentes devem ser conferidos; nunca somar ou deduplicar por palpite.
        k=(row['conta'],row['numero_pedido'])
        if k in seen and seen[k]!=row['casa']: conflicts.append('Pedido repetido entre origens: associação bloqueada para conferência.')
        seen[k]=row['casa']
    focus=[x[0] for x in c.execute('SELECT casa FROM foco')];closed=[x[0] for x in c.execute('SELECT casa FROM encerradas')]
    if set(keys)&set(focus) and set(keys)&set(closed): conflicts.append('Há casa em foco e casa encerrada. Resolva essa diferença antes de associar.')
    result={'origem':a,'destino':b,'chaves_origem':ka,'chaves_destino':kb,'operacoes':len(rows),'pedidos_acompanhados':len(pending),
            'origens_observadas':{k:r['origens'].get(k,[]) for k in keys},
            'depositos':sum(db.centavos(x['valor']) for x in rows if x['tipo']=='deposito')/100,
            'saques':sum(db.centavos(x['valor']) for x in rows if x['tipo']=='saque')/100,
            'foco_afetado':sorted(set(keys)&set(focus)),'encerradas_afetadas':sorted(set(keys)&set(closed)),
            'conflitos':sorted(set(conflicts)),'efeito':'Associa identidade e conferência. Mantém pedidos, valores e histórico financeiro sem reescrita.'}
    result['token']=hash_json({'preview':result,'rows':rows,'pedidos':pending,'chaves':{k:r['chaves'][k] for k in keys}})
    return result


@db._api
def prepare(d):
    with db._lock,db._c() as c: return {'status':'ok',**preview(c,d)}


@db._api
def associate(d):
    if d.get('confirmado') is not True: raise Invalido('confirmação da prévia obrigatória')
    with db._lock:
        # Nenhuma transação aberta enquanto SQLite faz o backup (inclusive WAL).
        with db._c() as c:
            r=load(c)
            prior=next((e for e in r['historico'] if e['token']==d.get('token') and not e['desfeito']),None)
            if prior:
                if any(r['chaves'].get(k)!=v for k,v in prior['depois'].items()): raise Conflito('associação alterada posteriormente')
                return {'status':'duplicado','associacao_id':prior['id'],'backup':prior['backup']}
            p=preview(c,d)
            if p['conflitos'] or p['token']!=d.get('token'): raise Conflito('prévia alterada ou com conflito; confira novamente')
        from dados_backup import _preserve_original
        backup=_preserve_original()
        with db._c() as c:
            p=preview(c,d)
            if p['token']!=d.get('token'): raise Conflito('dados mudaram durante o backup; confira novamente')
            r=load(c);before={k:r['chaves'][k] for k in p['chaves_origem']+p['chaves_destino']}
            for k in p['chaves_origem']: r['chaves'][k]=p['destino']
            event={'id':str(uuid.uuid4()),'antes':before,'depois':{k:r['chaves'][k] for k in before},'backup':backup,'quando':agora(),'desfeito':False,'token':p['token']}
            r['historico'].append(event);save(c,r)
            return {'status':'ok','associacao_id':event['id'],'backup':backup}


@db._api
def undo(d):
    with db._lock,db._c() as c:
        r=load(c);event=next((e for e in r['historico'] if e['id']==d.get('id')),None)
        if not event: raise Invalido('associação não encontrada')
        if event['desfeito']: return {'status':'duplicado'}
        affected=set(event['depois'].values())
        current={k:v for k,v in r['chaves'].items() if v in affected}
        if current!=event['depois']: raise Conflito('há associações posteriores; desfaça a mais recente primeiro')
        r['chaves'].update(event['antes']);event['desfeito']=True;save(c,r)
        return {'status':'ok'}
