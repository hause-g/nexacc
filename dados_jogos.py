"""Captura legada de jogos preservada; lotes novos exigem idempotência."""
import db
from dados_validacao import Invalido, agora, identidade, numero, objeto, serializar, texto


@db._api
def add_jogos(casa, conta, records):
    house, account = identidade(casa, 'casa'), identidade(conta, 'conta')
    if not isinstance(records, list):
        raise Invalido('records deve ser lista')
    rows = []
    for r in records:
        objeto(r)
        rows.append((identidade(r.get('recordId'), 'recordId'), texto(r.get('jogo', '?'), 'jogo'),
            numero(r.get('apostado'), 'apostado', nulo=True), numero(r.get('ganho'), 'ganho', nulo=True),
            numero(r.get('ts'), 'ts', nulo=True, inteiro=True)))
    with db._lock, db._c() as c:
        count = 0
        for rid, game, bet, won, stamp in rows:
            count += c.execute('INSERT OR IGNORE INTO jogos(ciclo_id,record_id,casa,conta,jogo,apostado,ganho,ts,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
                (db._ciclo(c), rid, house, account, game, bet, won, stamp, agora())).rowcount
        return {'status': 'ok', 'novos': count}


@db._api
def set_jogos_cat(d):
    objeto(d)
    if not d.get('event_id'):
        raise Invalido('event_id obrigatório para lote de jogos')
    house, account = identidade(d.get('casa'), 'casa'), identidade(d.get('conta'), 'conta')
    cats = d.get('categorias')
    if not isinstance(cats, list):
        raise Invalido('categorias deve ser lista')
    rows = [(texto(objeto(cat).get('nome'), 'nome'), numero(cat.get('apostado'), 'apostado'),
             numero(cat.get('ganho'), 'ganho'), numero(cat.get('apostas'), 'apostas', inteiro=True)) for cat in cats]
    with db._lock, db._c() as c:
        def apply():
            for name, bet, won, count in rows:
                c.execute('''INSERT INTO jogos_cat VALUES(?,?,?,?,?,?,?) ON CONFLICT(casa,conta,categoria) DO UPDATE
                    SET apostado=COALESCE(apostado,0)+excluded.apostado,ganho=COALESCE(ganho,0)+excluded.ganho,
                    apostas=COALESCE(apostas,0)+excluded.apostas,atualizado_em=excluded.atualizado_em''',
                    (house, account, name, bet, won, count, agora()))
            return {'status': 'ok', 'n': len(rows)}
        return db._receipt(c, d, 'jogos_cat', apply)


# --- identidade dos jogos (descoberta) --------------------------------------------------------
# O lobby fica sempre na mesma URL (.../home/embedded); o jogo roda num iframe da PG Soft em
# m.<cdn>/<ID>/index.html?ot=<token efemero>. Ou seja: nao existe link por jogo para guardar — o
# botao tem que pedir o launch na aba logada. Aqui fica so a IDENTIDADE (id, slug, nome) que
# permite montar esse pedido. Nada de token, nada de valor.
JOGOS_CHAVE = 'jogos_identidade'
CAMPOS_JOGO = ('id_jogo', 'slug', 'nome', 'origem', 'visto_em', 'campos', 'campos_vistos', 'seletor', 'marca')


def _jogos(c):
    import json
    try:
        saved = json.loads(db._get_control(c, JOGOS_CHAVE, '{}'))
    except ValueError:
        saved = {}
    return saved if isinstance(saved, dict) else {}


def jogos_identidade_snapshot(c):
    return _jogos(c)


def validar_jogos_identidade(obj):
    """Usado pelo backup: {casa: {id_jogo: {slug, nome, origem, visto_em, campos}}}."""
    from dados_validacao import instante
    objeto(obj)
    for house, jogos in obj.items():
        identidade(house, 'casa')
        objeto(jogos)
        for gid, row in jogos.items():
            identidade(gid, 'id_jogo')
            objeto(row)
            if set(row) - set(CAMPOS_JOGO):
                raise Invalido('identidade de jogo com campo desconhecido')
            for campo in ('slug', 'nome', 'origem', 'seletor', 'marca'):
                if row.get(campo) is not None:
                    texto(row[campo], campo, vazio=True, limite=320)
            if row.get('visto_em') is not None:
                instante(row['visto_em'])
            if row.get('campos') is not None:
                objeto(row['campos'])
            vistos = row.get('campos_vistos')
            if vistos is not None:
                if not isinstance(vistos, list) or len(vistos) > 40:
                    raise Invalido('campos_vistos inválido')
                for nome_campo in vistos:
                    texto(nome_campo, 'campo_visto', limite=40)


# Lista POSITIVA: bloquear por nome erra sempre (sk, sign, pwd, secret, mima...). Só o que
# identifica o JOGO atravessa; o resto do corpo do launch morre aqui e já morreu na extensão.
CAMPOS_ACEITOS = ('gameid', 'gamecode', 'gamename', 'gametype', 'gamekind', 'platform', 'vendor', 'provider', 'slug',
                  'cid', 'exiturl', 'os_type', 'ostype', 'platfromid', 'platformid', 'time', 'language', 'currency')
LIMITE_CASAS, LIMITE_JOGOS = 64, 512


def _limpo(campos):
    """Guarda só o que identifica o jogo. Campo fora da lista é descartado, não recusado: um
    corpo com chave estranha não pode matar o evento inteiro (viraria descarte definitivo)."""
    objeto(campos)
    saida = {}
    for chave, valor in list(campos.items())[:40]:
        nome = str(chave)
        if len(nome) > 40 or nome.lower() not in CAMPOS_ACEITOS:
            continue
        if isinstance(valor, bool):
            saida[nome] = valor
        elif isinstance(valor, (int, float)) and -10 ** 12 < valor < 10 ** 12:
            saida[nome] = valor
        elif isinstance(valor, str) and len(valor) <= (200 if nome.lower() == 'exiturl' else 24):
            saida[nome] = valor
    return saida


@db._api
def set_jogo(d):
    objeto(d)
    house = identidade(d.get('casa'), 'casa')
    gid = identidade(d.get('id_jogo'), 'id_jogo')
    origem = texto(d.get('origem', 'desconhecida'), 'origem')
    if origem not in ('lancamento', 'frame', 'catalogo'):
        raise Invalido('origem de jogo inválida')
    novo = {'id_jogo': gid, 'origem': origem, 'visto_em': agora()}
    # seletor/marca: como era o alvo clicado quando o lobby abriu o jogo. E o que permite o botao
    # REPETIR o clique em vez de inventar uma chamada de API.
    # nome e slug sao rotulo (80); seletor e o caminho do elemento na tela e precisa de mais espaco
    for campo, corte in (('slug', 80), ('nome', 80), ('seletor', 320), ('marca', 80)):
        if d.get(campo) is not None:
            # truncar, não recusar: um valor longo não pode derrubar o evento em definitivo
            novo[campo] = texto(str(d[campo])[:corte], campo, vazio=True, limite=corte)
    if d.get('campos') is not None:
        novo['campos'] = _limpo(d['campos'])
    # Só os NOMES dos campos do corpo do launch, nunca os valores: é o que falta para montar o
    # pedido do botão sem nunca ver o conteúdo (que pode ser credencial).
    if isinstance(d.get('campos_vistos'), list):
        novo['campos_vistos'] = sorted({texto(str(k)[:40], 'campo_visto', vazio=True)
                                        for k in d['campos_vistos'][:40] if str(k).strip()})
    with db._lock, db._c() as c:
        def apply():
            jogos = _jogos(c)
            # teto ANTES do setdefault: senao a casa nova ja teria sido criada e o limite nunca pegaria
            if house not in jogos and len(jogos) >= LIMITE_CASAS:
                return {'status': 'duplicado', 'motivo': 'limite_de_casas'}
            da_casa = jogos.setdefault(house, {})
            if gid not in da_casa and len(da_casa) >= LIMITE_JOGOS:
                return {'status': 'duplicado', 'motivo': 'limite_de_jogos'}
            atual = dict(da_casa.get(gid) or {})
            # merge: o frame ensina o slug, o catalogo ensina o nome, o lancamento ensina os campos.
            # HIERARQUIA: o que o lancamento ensinou nao e sobrescrito por frame/catalogo — o botao
            # vai USAR esta linha para abrir jogo com dinheiro do operador, e qualquer pagina
            # `https://host/<digitos>/index.html` consegue emitir um evento de frame.
            vindo = {k: v for k, v in novo.items() if v not in (None, '')}
            if atual.get('origem') == 'lancamento' and origem != 'lancamento':
                vindo = {k: v for k, v in vindo.items() if k not in ('origem', 'campos') and k not in atual}
                vindo['visto_em'] = novo['visto_em']
            atual.update(vindo)
            jogos[house][gid] = atual
            c.execute("INSERT INTO controles VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor",
                      (JOGOS_CHAVE, serializar(jogos)))
            return {'status': 'ok', 'casa': house, 'id_jogo': gid, 'slug': atual.get('slug'), 'nome': atual.get('nome')}
        return db._receipt(c, d, 'jogo', apply)
