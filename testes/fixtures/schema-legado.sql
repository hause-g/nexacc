
            CREATE TABLE IF NOT EXISTS ciclos(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              aberto INTEGER DEFAULT 1,
              criado_em TEXT DEFAULT (datetime('now','localtime')),
              fechado_em TEXT
            );
            CREATE TABLE IF NOT EXISTS operacoes(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ciclo_id INTEGER,
              numero_pedido TEXT UNIQUE,
              tipo TEXT, valor REAL, casa TEXT, conta TEXT,
              data TEXT, origem TEXT,
              created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS jogos(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ciclo_id INTEGER,
              record_id TEXT UNIQUE,
              casa TEXT, conta TEXT, jogo TEXT,
              apostado REAL DEFAULT 0, ganho REAL DEFAULT 0, ts INTEGER,
              created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS jogos_cat(
              casa TEXT, conta TEXT, categoria TEXT,
              apostado REAL DEFAULT 0, ganho REAL DEFAULT 0, apostas INTEGER DEFAULT 0,
              atualizado_em TEXT DEFAULT (datetime('now','localtime')),
              PRIMARY KEY (casa, conta, categoria)
            );
            CREATE TABLE IF NOT EXISTS contas(
              casa TEXT, conta TEXT,
              status INTEGER, saldo REAL, bonus REAL,
              total_charge REAL, total_withdraw REAL,
              host TEXT, sessao TEXT,
              atualizado_em TEXT DEFAULT (datetime('now','localtime')),
              PRIMARY KEY (casa, conta)
            );
            CREATE TABLE IF NOT EXISTS pendentes(
              numero_pedido TEXT PRIMARY KEY,
              ciclo_id INTEGER, conta TEXT, casa TEXT, valor REAL,
              visto_em TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS ajustes(
              ciclo_id INTEGER, casa TEXT,
              deposito REAL, contas INTEGER,
              atualizado_em TEXT DEFAULT (datetime('now','localtime')),
              PRIMARY KEY (ciclo_id, casa)
            );
            CREATE TABLE IF NOT EXISTS agente(
              casa TEXT PRIMARY KEY, conta_mae TEXT,
              deposito_total REAL, contas INTEGER, primeiro_deposito REAL,
              saque_total REAL, aposta_total REAL, membros_qtd INTEGER,
              atualizado_em TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS agente_membros(
              casa TEXT, conta TEXT, nome TEXT, deposito REAL, aposta REAL, is_dep INTEGER, online INTEGER,
              atualizado_em TEXT DEFAULT (datetime('now','localtime')),
              PRIMARY KEY (casa, conta)
            );
            CREATE TABLE IF NOT EXISTS foco(
              casa TEXT PRIMARY KEY,
              atualizado_em TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS descartados(
              ciclo_id INTEGER, numero_pedido TEXT,
              ts TEXT DEFAULT (datetime('now','localtime')),
              PRIMARY KEY (ciclo_id, numero_pedido)
            );
            CREATE TABLE IF NOT EXISTS encerradas(
              casa TEXT PRIMARY KEY,
              atualizado_em TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE INDEX IF NOT EXISTS idx_op_ciclo ON operacoes(ciclo_id);
            CREATE INDEX IF NOT EXISTS idx_jg_ciclo ON jogos(ciclo_id);
