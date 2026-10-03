"""Migrações transacionais, versionadas e sem limpeza automática de negócio."""
SCHEMA_VERSION = 5

SCHEMA = {
    'ciclos': '''id INTEGER PRIMARY KEY AUTOINCREMENT, aberto INTEGER DEFAULT 1,
        criado_em TEXT, fechado_em TEXT''',
    'operacoes': '''id INTEGER PRIMARY KEY AUTOINCREMENT, ciclo_id INTEGER,
        numero_pedido TEXT, tipo TEXT, valor REAL, casa TEXT, conta TEXT,
        data TEXT, origem TEXT, created_at TEXT, data_original TEXT,
        observado_em TEXT, recebido_em TEXT, ciclo_motivo TEXT,
        UNIQUE(casa,conta,numero_pedido)''',
    'jogos': '''id INTEGER PRIMARY KEY AUTOINCREMENT, ciclo_id INTEGER, record_id TEXT,
        casa TEXT, conta TEXT, jogo TEXT, apostado REAL DEFAULT 0, ganho REAL DEFAULT 0,
        ts INTEGER, created_at TEXT, UNIQUE(casa,conta,record_id)''',
    'jogos_cat': '''casa TEXT, conta TEXT, categoria TEXT, apostado REAL DEFAULT 0,
        ganho REAL DEFAULT 0, apostas INTEGER DEFAULT 0, atualizado_em TEXT,
        PRIMARY KEY(casa,conta,categoria)''',
    'contas': '''casa TEXT, conta TEXT, status INTEGER, saldo REAL, bonus REAL,
        total_charge REAL,total_withdraw REAL,host TEXT,sessao TEXT,atualizado_em TEXT,
        PRIMARY KEY(casa,conta)''',
    'pendentes': '''numero_pedido TEXT, ciclo_id INTEGER, conta TEXT,casa TEXT,valor REAL,
        visto_em TEXT,PRIMARY KEY(casa,conta,numero_pedido)''',
    'ajustes': '''ciclo_id INTEGER,casa TEXT,deposito REAL,contas INTEGER,atualizado_em TEXT,
        unidade_contador TEXT,fonte TEXT,periodo TEXT,PRIMARY KEY(ciclo_id,casa)''',
    'agente': '''casa TEXT PRIMARY KEY,conta_mae TEXT,deposito_total REAL,contas INTEGER,
        primeiro_deposito REAL,saque_total REAL,aposta_total REAL,membros_qtd INTEGER,
        atualizado_em TEXT,conta_mae_nome TEXT''',
    'agente_membros': '''casa TEXT,conta TEXT,nome TEXT,deposito REAL,aposta REAL,
        is_dep INTEGER,online INTEGER,atualizado_em TEXT,PRIMARY KEY(casa,conta)''',
    'foco': 'casa TEXT PRIMARY KEY,atualizado_em TEXT',
    'descartados': '''ciclo_id INTEGER,numero_pedido TEXT,ts TEXT,casa TEXT,conta TEXT,
        PRIMARY KEY(ciclo_id,casa,conta,numero_pedido)''',
    'encerradas': 'casa TEXT PRIMARY KEY,atualizado_em TEXT',
    'pedidos': '''casa TEXT NOT NULL,conta TEXT NOT NULL,numero_pedido TEXT NOT NULL,
        tipo TEXT NOT NULL,ciclo_id INTEGER NOT NULL,valor REAL,estado TEXT NOT NULL,
        motivo TEXT,origem TEXT,data TEXT,observado_em TEXT NOT NULL,recebido_em TEXT NOT NULL,
        revision INTEGER NOT NULL,contexto TEXT,conflito INTEGER DEFAULT 0,
        PRIMARY KEY(casa,conta,numero_pedido)''',
    'pedido_eventos': '''id INTEGER PRIMARY KEY AUTOINCREMENT,casa TEXT,conta TEXT,
        numero_pedido TEXT,ciclo_id INTEGER,estado TEXT,motivo TEXT,observado_em TEXT,
        recebido_em TEXT,revision INTEGER,valor REAL,origem TEXT''',
    'fechamentos': '''fechamento_id TEXT PRIMARY KEY,ciclo_id INTEGER NOT NULL UNIQUE,
        novo_ciclo_id INTEGER NOT NULL,versao TEXT NOT NULL,metas_ids TEXT NOT NULL,
        gerente REAL NOT NULL,bau REAL NOT NULL,saque_manual REAL NOT NULL,
        resumo TEXT NOT NULL,resposta TEXT NOT NULL,criado_em TEXT NOT NULL''',
    'recebimentos': '''event_id TEXT NOT NULL,revision INTEGER NOT NULL,rota TEXT NOT NULL,
        payload_hash TEXT NOT NULL,resposta TEXT NOT NULL,recebido_em TEXT NOT NULL,
        PRIMARY KEY(event_id,revision)''',
    'instalacoes': '''instalacao_id TEXT NOT NULL,tipo TEXT NOT NULL,versao TEXT,fila INTEGER,
        pendentes INTEGER,ultimo_evento TEXT,estado TEXT,ultimo_ping TEXT NOT NULL,
        slots TEXT,PRIMARY KEY(instalacao_id,tipo)''',
    'agente_fontes': '''casa TEXT NOT NULL,fonte TEXT NOT NULL,periodo TEXT NOT NULL,
        tipo TEXT NOT NULL,dados TEXT NOT NULL,recebido_em TEXT NOT NULL,
        unidade_contador TEXT NOT NULL,conta_mae TEXT NOT NULL DEFAULT '',PRIMARY KEY(casa,fonte,periodo,tipo,conta_mae)''',
    'agente_paginas': '''casa TEXT NOT NULL,fonte TEXT NOT NULL,periodo TEXT NOT NULL,
        coleta_id TEXT NOT NULL,pagina INTEGER NOT NULL,total_paginas INTEGER,
        lista_completa INTEGER NOT NULL,membros TEXT NOT NULL,recebido_em TEXT NOT NULL,
        conta_mae TEXT NOT NULL DEFAULT '',PRIMARY KEY(casa,fonte,periodo,coleta_id,pagina,conta_mae)''',
    'agente_listas': '''casa TEXT NOT NULL,fonte TEXT NOT NULL,periodo TEXT NOT NULL,
        coleta_id TEXT NOT NULL,membros TEXT NOT NULL,total_paginas INTEGER NOT NULL,
        recebido_em TEXT NOT NULL,conta_mae TEXT NOT NULL DEFAULT '',PRIMARY KEY(casa,fonte,periodo,conta_mae)''',
    'controles': 'chave TEXT PRIMARY KEY,valor TEXT NOT NULL',
}
BACKUP_TABLES = tuple(SCHEMA)


def create_tables(c):
    for table, columns in SCHEMA.items():
        c.execute('CREATE TABLE IF NOT EXISTS "' + table + '" (' + columns + ')')


def _columns(c, table):
    return [r['name'] for r in c.execute('PRAGMA table_info("' + table + '")')]


def _rebuild(c, table):
    # COPY integral, sem OR IGNORE, GROUP BY ou normalização destrutiva.
    old = _columns(c, table)
    sequence = None
    if 'AUTOINCREMENT' in SCHEMA[table]:
        row = c.execute('SELECT seq FROM sqlite_sequence WHERE name=?', (table,)).fetchone()
        sequence = row[0] if row else None
    c.execute('ALTER TABLE "' + table + '" RENAME TO "__migration_' + table + '"')
    c.execute('CREATE TABLE "' + table + '" (' + SCHEMA[table] + ')')
    common = [col for col in old if col in _columns(c, table)]
    cols = ','.join('"' + col + '"' for col in common)
    c.execute('INSERT INTO "' + table + '" (' + cols + ') SELECT ' + cols + ' FROM "__migration_' + table + '"')
    c.execute('DROP TABLE "__migration_' + table + '"')
    if sequence is not None:
        c.execute('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?', (sequence, table))


def migrate(c, now, epoch):
    c.execute('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,aplicado_em TEXT NOT NULL)')
    c.execute('''CREATE TABLE IF NOT EXISTS restauracoes(restore_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,
        estado TEXT NOT NULL,resposta TEXT,backup_local TEXT,atualizado_em TEXT NOT NULL)''')
    version = c.execute('PRAGMA user_version').fetchone()[0]
    if version > SCHEMA_VERSION:
        raise ValueError('banco de versão mais recente')
    if version < 1:
        create_tables(c)
        for table in ('operacoes', 'jogos', 'pendentes', 'descartados'):
            _rebuild(c, table)
        for table, additions in {
            'contas': {'host': 'TEXT', 'sessao': 'TEXT'},
            'agente': {'conta_mae_nome': 'TEXT'},
            'agente_membros': {'nome': 'TEXT'},
            'ajustes': {'unidade_contador': 'TEXT', 'fonte': 'TEXT', 'periodo': 'TEXT'},
        }.items():
            existing = _columns(c, table)
            for col, kind in additions.items():
                if col not in existing:
                    c.execute('ALTER TABLE "' + table + '" ADD COLUMN ' + col + ' ' + kind)
        c.execute('INSERT INTO schema_migrations VALUES(1,?)', (now,))
    if version < 2:
        create_tables(c)
        c.execute('CREATE TABLE IF NOT EXISTS revisao(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,valor INTEGER NOT NULL)')
        c.execute('INSERT OR IGNORE INTO revisao VALUES(1,?,0)', (epoch,))
        c.execute('INSERT INTO schema_migrations VALUES(2,?)', (now,))
    if version < 3:
        for table in BACKUP_TABLES:
            for action in ('INSERT', 'UPDATE', 'DELETE'):
                name = 'rev_' + table + '_' + action.lower()
                c.execute('CREATE TRIGGER IF NOT EXISTS ' + name + ' AFTER ' + action + ' ON "' + table + '" BEGIN UPDATE revisao SET valor=valor+1 WHERE id=1; END')
        c.execute('CREATE INDEX IF NOT EXISTS idx_op_ciclo ON operacoes(ciclo_id)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_jg_ciclo ON jogos(ciclo_id)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_pedidos_ciclo ON pedidos(ciclo_id)')
        c.execute('INSERT INTO schema_migrations VALUES(3,?)', (now,))
    if version < 4:
        c.execute('CREATE TABLE IF NOT EXISTS telemetria_revisao(id INTEGER PRIMARY KEY CHECK(id=1),valor INTEGER NOT NULL)')
        c.execute('INSERT OR IGNORE INTO telemetria_revisao VALUES(1,0)')
        for table in ('instalacoes', 'recebimentos'):
            for action in ('INSERT', 'UPDATE', 'DELETE'):
                name = 'rev_' + table + '_' + action.lower()
                c.execute('DROP TRIGGER IF EXISTS ' + name)
                if table == 'instalacoes':
                    c.execute('CREATE TRIGGER ' + name + ' AFTER ' + action + ' ON instalacoes BEGIN UPDATE telemetria_revisao SET valor=valor+1 WHERE id=1; END')
        c.execute('INSERT INTO schema_migrations VALUES(4,?)', (now,))
    if version < 5:
        for table in ('agente_fontes', 'agente_paginas', 'agente_listas'):
            for action in ('INSERT', 'UPDATE', 'DELETE'):
                c.execute('DROP TRIGGER IF EXISTS rev_' + table + '_' + action.lower())
            _rebuild(c, table)
            for action in ('INSERT', 'UPDATE', 'DELETE'):
                name = 'rev_' + table + '_' + action.lower()
                c.execute('CREATE TRIGGER ' + name + ' AFTER ' + action + ' ON ' + table + ' BEGIN UPDATE revisao SET valor=valor+1 WHERE id=1; END')
        c.execute('INSERT INTO schema_migrations VALUES(5,?)', (now,))
    # Índice idempotente, sem subir SCHEMA_VERSION (não muda dados nem o formato do backup): o "primeiro
    # visto" de cada pedido (MIN de pedido_eventos) varria a tabela inteira — ~445 ms no pior caso com o
    # lock do banco preso, e a tabela cresce ~1 mil eventos/dia.
    c.execute('CREATE INDEX IF NOT EXISTS idx_pedev_numero ON pedido_eventos(numero_pedido)')
    c.execute('PRAGMA user_version=' + str(SCHEMA_VERSION))
