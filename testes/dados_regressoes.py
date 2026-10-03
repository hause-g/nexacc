"""Executa funções reais somente em SQLite temporário. Nunca importa a produção."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import db
import dados_backup
from dados_validacao import agora, hash_json, serializar


def operation(order='order-1', house='fixture-a', account='account-1', kind='deposito', value=10, **extra):
    return dict(numero_pedido=order, casa=house, conta=account, tipo=kind, valor=value, origem='fixture', **extra)


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agentum-dados-')
        self.old_path = db.DB_PATH
        db.DB_PATH = os.path.join(self.temp.name, 'isolated.sqlite3')
        db.init()

    def tearDown(self):
        db.DB_PATH = self.old_path
        self.temp.cleanup()

    def table(self, table):
        with db._lock, db._c() as c:
            return [dict(r) for r in c.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]

    def all_business(self):
        return {table: self.table(table) for table in db._BACKUP_TABLES}

    def close(self, fid='close-1', **kwargs):
        with db._c() as c:
            cid = db._ciclo(c)
        req = dict(fechamento_id=fid, ciclo_id=cid, metas_ids=['existing-1', 'existing-2'], gerente=1, bau=2)
        req.update(kwargs)
        return req, db.fechar_ciclo(req)

    def test_identity_never_merges_account_value_or_other_houses(self):
        for d in (operation('10000000000000000001'), operation('10000000000000000002'),
                  operation('10000000000000000001', house='fixture-b'), operation('10000000000000000001', account='account-2'),
                  operation('deposito-tela-synthetic')):
            self.assertEqual(db.add_operacao(d)['status'], 'ok')
        self.assertEqual(db.resumo()['total_depositos'], 50)
        self.assertEqual(db.add_operacao(operation('10000000000000000001'))['status'], 'duplicado')
        self.assertEqual(len(self.table('operacoes')), 5)

    def test_distinct_pending_same_value_preserved_and_exact_confirm(self):
        for order in ('pending-a', 'pending-b'):
            self.assertEqual(db.add_pendente(operation(order))['status'], 'ok')
        self.assertEqual(len(db.pendentes_lista()), 2)
        db.add_operacao(operation('pending-a'))
        self.assertEqual([p['numero_pedido'] for p in db.pendentes_lista()], ['pending-b'])
        self.assertEqual(db.pedidos_lista()[0]['numero_pedido'], 'pending-b')

    def test_conflict_does_not_remove_pending_or_ack(self):
        db.add_operacao(operation())
        before = self.all_business()
        result = db.add_operacao(operation(value=99, event_id='collision'))
        self.assertEqual(result['codigo'], 'conflito')
        self.assertEqual(self.all_business(), before)

    def test_receipt_returns_exact_response_after_restart(self):
        d = operation(event_id='event-1', revision=8)
        first = db.add_operacao(d)
        db.init()
        self.assertEqual(db.add_operacao(d), first)
        self.assertEqual(first['ack'], {'event_id': 'event-1', 'revision': 8})
        self.assertEqual(len(self.table('operacoes')), 1)
        self.assertEqual(db.add_operacao(dict(d, valor=20))['codigo'], 'conflito')

    def test_pending_keeps_original_cycle_after_close(self):
        db.add_pendente(operation('pending'))
        original = db.pendentes_lista()[0]['ciclo_id']
        request, result = self.close()
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(db.pendentes_lista()[0]['ciclo_id'], original)
        ack = db.add_operacao(operation('pending'))
        self.assertEqual(ack['ciclo_id'], original)
        self.assertEqual(db.resumo()['total_depositos'], 0)
        self.assertEqual(db.fechar_ciclo(request), result)

    def test_official_time_normalization_and_late_cycle(self):
        with db._c() as c:
            c.execute("UPDATE ciclos SET criado_em='2026-01-01T00:00:00Z',aberto=0,fechado_em='2026-02-01T00:00:00Z'")
            c.execute("INSERT INTO ciclos(aberto,criado_em) VALUES(1,'2026-02-01T00:00:00Z')")
        first = db.add_operacao(operation('old-1', data='2026-01-31T20:00:00-03:00'))
        self.assertEqual(first['ciclo_id'], 1)
        self.assertEqual(self.table('operacoes')[0]['data'], '2026-01-31T23:00:00.000000Z')
        self.assertEqual(db.resumo()['total_depositos'], 0)
        self.assertEqual(db.add_operacao(operation('new-1', data='2026-02-01T00:00:00Z'))['ciclo_id'], 2)

    def test_long_order_ids_tie_break_exact(self):
        stamp = agora()
        for order in ('99999999999999999999', '100000000000000000000', '99999999999999999998'):
            db.add_operacao(operation(order, data=stamp))
        self.assertEqual(db.operacoes()[0]['numero_pedido'], '100000000000000000000')

    def test_validation_zero_null_and_bools(self):
        for value in (None, 0, True, float('nan'), float('inf'), '1,2', 'abc', -1, 1.001):
            self.assertEqual(db.add_operacao(operation(value=value))['status'], 'erro', repr(value))
        self.assertEqual(db.add_operacao(operation(account=1e20))['status'], 'erro')
        self.assertEqual(db.add_operacao(operation(order=10000000000000000000))['status'], 'erro')
        self.assertEqual(db.set_conta({'casa': 'fixture-a', 'conta': 'account-1', 'saldo': 0, 'bonus': None})['status'], 'ok')
        row = db.contas_lista()[0]
        self.assertEqual(row['saldo'], 0)
        self.assertIsNone(row['bonus'])
        self.assertEqual(db.set_conta({'casa': 'fixture-a', 'conta': 'account-1', 'saldo': True})['status'], 'erro')
        self.assertEqual(db.set_encerrada('fixture-a', '0')['encerrada'], False)

    def test_set_conta_receipt_echoes_event_id_and_keeps_backup_valid(self):
        first = db.set_conta({'casa':'fixture-a','conta':'account-1','saldo':5,'event_id':'conta-ev-1','revision':1})
        self.assertEqual(first['status'],'ok')
        self.assertEqual(first['ack'],{'event_id':'conta-ev-1','revision':1})
        # reenvio identico e idempotente: mesma resposta, sem erro
        self.assertEqual(db.set_conta({'casa':'fixture-a','conta':'account-1','saldo':5,'event_id':'conta-ev-1','revision':1}),first)
        # sem event_id o comportamento legado continua (sem ack, sem recibo)
        self.assertNotIn('ack',db.set_conta({'casa':'fixture-a','conta':'account-1','saldo':6}))
        # o recibo com rota 'conta' nao pode invalidar o backup (whitelist de dados_backup)
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'),'erro')

    def test_pedidos_lista_marks_twin_of_recorded_deposit_in_any_cycle(self):
        quando = '2026-09-10T12:00:00Z'
        op = {'casa':'fixture-s','conta':'c1','numero_pedido':'dep-A','tipo':'deposito','valor':84,'origem':'api','data':quando,'observado_em':quando}
        self.assertEqual(db.add_operacao(op)['status'],'ok')
        db.novo_ciclo()   # o deposito gravado fica num ciclo FECHADO; a sobra tem que ser reconhecida mesmo assim
        ped = {'casa':'fixture-s','conta':'c1','tipo':'deposito','estado':'processando','origem':'extrato','observado_em':'2026-09-10T12:02:00Z','revision':1}
        self.assertEqual(db.add_pedido(dict(ped, numero_pedido='dep-B', valor=84))['status'],'ok')
        self.assertEqual(db.add_pedido(dict(ped, numero_pedido='dep-C', valor=85))['status'],'ok')
        rows = {r['numero_pedido']: r for r in db.pedidos_lista()}
        self.assertEqual(rows['dep-B']['sobra_de'],'dep-A')
        self.assertIsNone(rows['dep-C']['sobra_de'])
        # o campo e so da API: o backup continua valido (le as tabelas, nao pedidos_lista)
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'),'erro')

    def test_twin_window_separates_house_pair_from_legitimate_redeposit(self):
        # Medido em 12/09 sobre 161 pares reais: gemeo da casa <=5 min, redeposito legitimo >=1 h.
        base = {'casa':'fixture-j','conta':'c1','tipo':'deposito','estado':'processando','origem':'extrato','valor':100,'revision':1}
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='par-1', observado_em='2026-09-11T10:00:00Z'))['status'],'ok')
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='par-2', observado_em='2026-09-11T10:00:12Z'))['status'],'ok')
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='outro', observado_em='2026-09-11T18:00:00Z'))['status'],'ok')
        rows = {r['numero_pedido']: r for r in db.pedidos_lista()}
        self.assertIsNone(rows['par-1']['gemeo_de'])
        self.assertEqual(rows['par-2']['gemeo_de'],'par-1', 'par criado pela casa em 12 s vira uma linha só')
        self.assertIsNone(rows['outro']['gemeo_de'], 'redepósito 8 h depois é depósito de verdade, não gêmeo')
        # a operacao gravada 8 h depois do pedido NAO pode transformar o pedido antigo em sobra
        tarde = '2026-09-11T18:01:00Z'
        self.assertEqual(db.add_operacao({'casa':'fixture-j','conta':'c1','numero_pedido':'op-tarde','tipo':'deposito',
                                          'valor':100,'origem':'api','data':tarde,'observado_em':tarde})['status'],'ok')
        rows = {r['numero_pedido']: r for r in db.pedidos_lista()}
        self.assertIsNone(rows['par-1']['sobra_de'], 'operação 8 h depois não esconde pedido pendente')
        self.assertEqual(rows['outro']['sobra_de'],'op-tarde', 'operação 1 min depois é o par do mesmo depósito')

    def test_manual_panel_decision_is_not_reopened_by_late_verificar(self):
        base = {'casa':'fixture-m','conta':'c1','numero_pedido':'gemeo-1','tipo':'deposito','valor':57}
        self.assertEqual(db.add_pedido(dict(base, estado='processando', origem='extrato', observado_em=agora(), revision=1))['status'],'ok')
        self.assertEqual(db.add_pedido(dict(base, estado='falhou', origem='painel', motivo='dispensado manualmente no painel', revision=2))['status'],'ok')
        # horas depois a casa expira o gemeo e a extensao manda 'verificar': nao reabre o que o operador fechou
        late = db.add_pedido(dict(base, estado='verificar', origem='extrato', observado_em=agora(), revision=3))
        self.assertEqual((late['status'], late['estado']), ('duplicado', 'falhou'))
        self.assertEqual(db.pedidos_lista(True)[0]['estado'],'falhou')
        # dinheiro real vence a decisao manual: a operacao entra no livro e a divergencia com o ✕ fica marcada
        self.assertEqual(db.add_operacao(dict(base, origem='api', data='2026-09-10T12:00:00Z'))['status'],'ok')
        self.assertEqual(db.resumo()['total_depositos'], 57)
        row = db.pedidos_lista(True)[0]
        self.assertEqual((row['estado'], row['conflito']), ('verificar', 1))

    def test_periodo_enum_is_stored_calibrated_and_contradiction_is_demoted(self):
        base = dict(casa='fixture-e', tipo='agente_total', fonte='periodo', conta_mae='777', deposito=10)
        for _ in range(3):
            r = db.set_agente(dict(base, periodo='mes@2026-09', periodo_observado=True, periodo_enum=4))
            self.assertEqual((r['status'], r['periodo']), ('ok', 'mes@2026-09'))
        casa = next(h for h in db.agente_lista() if h['casa'] == 'fixture-e')
        mes = next(f for f in casa['fontes'] if f['periodo'] == 'mes@2026-09')['dados']
        self.assertEqual((mes['periodo_enum'], mes['deposito']), (4, 10))
        # a aba dizia 'Este Mes', mas a casa pediu o enum 2 (a pagina abre em 'esta semana'):
        # nao vale como mes, nao sobrescreve o mes, e o conflito fica registrado
        r = db.set_agente(dict(base, periodo='mes@2026-09', periodo_observado=True, periodo_enum=2, deposito=99))
        self.assertEqual((r['status'], r['periodo']), ('ok', 'desconhecido'))
        casa = next(h for h in db.agente_lista() if h['casa'] == 'fixture-e')
        self.assertEqual(next(f for f in casa['fontes'] if f['periodo'] == 'mes@2026-09')['dados']['deposito'], 10)
        suspeita = next(f for f in casa['fontes'] if f['periodo'] == 'desconhecido')['dados']
        self.assertEqual((suspeita['periodo_conflito']['rotulo_lido'], suspeita['periodo_conflito']['enum_calibrado']), ('mes', 4))
        # a contradicao nao contamina a calibracao; exposicao no estado; backup segue valido
        snap = db.estado_snapshot()['periodo_enum']['fixture-e']['por_rotulo']['mes']
        self.assertEqual((snap['enum_calibrado'], snap['contagens']), (4, {'4': 3}))
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'), 'erro')
        # rotulo ainda nao calibrado com enum novo e aceito normalmente (nada para contradizer)
        r = db.set_agente(dict(base, periodo='semana@2026-09-12', periodo_observado=True, periodo_enum=2))
        self.assertEqual((r['status'], r['periodo']), ('ok', 'semana@2026-09-12'))

    def test_measured_window_overrides_the_tab_label(self):
        # Janela real capturada em 08/09/2026 (UTC-3): enum 2 cobriu 00:00 as 23:59 de UM dia.
        # A aba dizia "Este Mes" — o painel gravava mes@2026-09 com o dinheiro de um dia so.
        inicio, fim, quando = 1788836400, 1788922799, '2026-09-08T17:00:00Z'
        base = dict(casa='fixture-j', tipo='agente_membros', fonte='membros', conta_mae='777',
                    membros=[{'conta': '1', 'deposito': 10, 'aposta': 0}], coleta_id='c1',
                    pagina=1, total_paginas=1, mais=False, lista_completa=True,
                    recebido_em=quando, janela_inicio=inicio, janela_fim=fim, periodo_enum=2)
        r = db.set_agente(dict(base, periodo='mes@2026-09', periodo_observado=True))
        self.assertEqual((r['status'], r['periodo']), ('ok', 'desconhecido'))
        casa = next(h for h in db.agente_lista() if h['casa'] == 'fixture-j')
        suspeita = next(f for f in casa['fontes'] if f['periodo'] == 'desconhecido')['dados']
        self.assertEqual(suspeita['periodo_conflito'],
                         {'enum': 2, 'rotulo_lido': 'mes', 'rotulos_da_janela': ['hoje'], 'prova': 'janela'})
        self.assertEqual((suspeita['janela_inicio'], suspeita['janela_fim']), (inicio, fim))
        # a medida vale mesmo quando o rotulo estava errado: e a casa que ensina, nao a aba
        janela = db.estado_snapshot()['periodo_enum']['fixture-j']['janelas']['2']
        self.assertEqual((janela['dias'], janela['rotulos']), (1.0, ['hoje']))
        # com o rotulo certo a leitura passa, sem esperar as 3 observacoes do voto antigo
        r = db.set_agente(dict(base, periodo='hoje@2026-09-08', periodo_observado=True, coleta_id='c2'))
        self.assertEqual((r['status'], r['periodo']), ('ok', 'hoje@2026-09-08'))
        self.assertEqual(db.estado_snapshot()['periodo_enum']['fixture-j']['por_rotulo']['hoje']['contagens'], {'2': 1})
        # leitura seguinte sem janela (myPeriodDataV2 nao a devolve) usa a medida ja guardada
        r = db.set_agente(dict(casa='fixture-j', tipo='agente_total', fonte='periodo', conta_mae='777',
                               deposito=99, periodo='mes@2026-09', periodo_observado=True, periodo_enum=2))
        self.assertEqual((r['status'], r['periodo']), ('ok', 'desconhecido'))
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'), 'erro')

    def test_window_that_matches_no_label_is_refused_and_illegible_one_is_ignored(self):
        # "Ultimos 90 dias" existe na casa e o painel nao tem onde guardar: nao pode virar mes@.
        base = dict(casa='fixture-k', tipo='agente_membros', fonte='membros', conta_mae='777',
                    membros=[{'conta': '1', 'deposito': 10, 'aposta': 0}], coleta_id='c1',
                    pagina=1, total_paginas=1, mais=False, lista_completa=True,
                    recebido_em='2026-09-08T17:00:00Z', periodo='mes@2026-09', periodo_observado=True)
        r = db.set_agente(dict(base, periodo_enum=7, janela_inicio=1781146800, janela_fim=1788922799))
        self.assertEqual(r['periodo'], 'desconhecido')
        casa = next(h for h in db.agente_lista() if h['casa'] == 'fixture-k')
        self.assertEqual(next(f for f in casa['fontes'] if f['periodo'] == 'desconhecido')['dados']['periodo_conflito']['rotulos_da_janela'], [])
        # janela que nao fecha um dia inteiro e ilegivel: ninguem e acusado e nada e aprendido
        r = db.set_agente(dict(base, casa='fixture-l', periodo_enum=4, janela_inicio=1788836401, janela_fim=1788922799))
        self.assertEqual(r['periodo'], 'mes@2026-09')
        self.assertEqual(db.estado_snapshot()['periodo_enum'].get('fixture-l', {}).get('janelas'), {})
        recusas = [db.set_agente(dict(base, casa='fixture-m', periodo_enum=4, **{campo: 1788836400}))
                   for campo in ('janela_inicio', 'janela_fim')]
        recusas.append(db.set_agente(dict(base, casa='fixture-m', periodo_enum=4, janela_inicio=1788922799, janela_fim=1788836400)))
        self.assertEqual([r['codigo'] for r in recusas], ['invalido'] * 3)

    def test_dismissing_is_a_watermark_not_a_delete(self):
        # "Limpar" tira da tela o que ja foi resolvido; a lapide do descartado continua no banco,
        # entao a operacao excluida NAO volta ao livro, e exclusao nova volta a aparecer.
        op = {'casa':'fixture-d','conta':'c1','numero_pedido':'ex-1','tipo':'deposito','valor':30,'origem':'api','data':agora()}
        self.assertEqual(db.add_operacao(op)['status'],'ok')
        self.assertEqual(db.del_operacao('ex-1')['status'],'ok')
        antes = db.descartados_lista()
        self.assertEqual(len(antes),1)
        self.assertEqual(db.set_dispensado({'tipo':'descartados','ate':antes[0]['ts']})['status'],'ok')
        self.assertEqual(db.estado_snapshot()['dispensados']['descartados'],antes[0]['ts'])
        # a lista bruta e a lapide seguem intactas: reenviar a operacao continua sendo recusado
        self.assertEqual(len(db.descartados_lista()),1)
        self.assertEqual(db.add_operacao(op)['status'],'descartado')
        self.assertEqual(db.resumo()['total_depositos'],0)
        # exclusao posterior a marca continua aparecendo
        self.assertEqual(db.add_operacao(dict(op, numero_pedido='ex-2'))['status'],'ok')
        self.assertEqual(db.del_operacao('ex-2')['status'],'ok')
        nova = [d for d in db.descartados_lista() if d['ts'] > antes[0]['ts']]
        self.assertEqual([d['numero_pedido'] for d in nova],['ex-2'])
        self.assertEqual(db.set_dispensado({'tipo':'inventado'})['codigo'],'invalido')
        # o Vigia usa a mesma marca: limpar contas travadas nao apaga conta nenhuma
        self.assertEqual(db.set_dispensado({'tipo':'vigia'})['status'],'ok')
        self.assertIn('vigia', db.estado_snapshot()['dispensados'])
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'),'erro')

    def test_game_identity_merges_sources_and_never_stores_credentials(self):
        # O lobby nao tem URL por jogo: so a identidade (id/slug/nome) permite pedir o launch
        # depois. Token do launcher e HTML nunca entram.
        self.assertEqual(db.set_jogo({'casa':'fixture-g','id_jogo':'2','slug':'gem-saviour','origem':'frame'})['status'],'ok')
        self.assertEqual(db.set_jogo({'casa':'fixture-g','id_jogo':'2','nome':'Gem Saviour','origem':'catalogo'})['status'],'ok')
        db.set_jogo({'casa':'fixture-g','id_jogo':'2','origem':'lancamento',
                     'campos':{'gameId':'2','platform':'PG','token':'SESSAO-SECRETA','ot':'x','html':'<'*40}})
        jogo = db.estado_snapshot()['jogos_identidade']['fixture-g']['2']
        self.assertEqual((jogo['slug'], jogo['nome'], jogo['origem']), ('gem-saviour','Gem Saviour','lancamento'))
        self.assertEqual(jogo['campos'], {'gameId':'2','platform':'PG'})
        for proibido in ('token','ot','html'):
            self.assertNotIn(proibido, jogo['campos'])
        self.assertEqual(db.set_jogo({'casa':'fixture-g','id_jogo':'3','origem':'inventada'})['codigo'],'invalido')
        # A extensao manda event_id, o que grava um recibo com rota 'jogo'. O backup valida a rota
        # dos recibos por lista: sem 'jogo' nela, o banco inteiro parava de exportar — e os testes
        # nao pegavam porque chamavam set_jogo SEM event_id, que nao gera recibo.
        self.assertEqual(db.set_jogo({'casa':'fixture-g','id_jogo':'6','origem':'frame','event_id':'ev-jogo-1'})['status'],'ok')
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'),'erro','recibo de jogo não pode quebrar o backup')
        # o vetor de permissoes da conta viaja junto e tambem entra no backup
        self.assertEqual(db.set_conta({'casa':'fixture-g','conta':'c9','status':1,
                                       'permissoes':[1,0,1,0,1],'auditoria':1,'event_id':'ev-conta-1'})['status'],'ok')
        self.assertEqual(db.contas_permissoes()['fixture-g|c9']['opt'],[1,0,1,0,1])
        self.assertEqual(db.contas_permissoes()['fixture-g|c9']['audit'],1)
        # lista POSITIVA: bloquear por nome erra sempre. sk/vcode nao estao em nenhuma blocklist
        # plausivel e mesmo assim nao podem entrar.
        db.set_jogo({'casa':'fixture-g','id_jogo':'4','origem':'lancamento',
                     'campos':{'gameId':'4','sk':'a1b2c3d4e5f6g7h8','vcode':384512,'pwd':'x'}})
        self.assertEqual(db.estado_snapshot()['jogos_identidade']['fixture-g']['4']['campos'], {'gameId':'4'})
        # o botao vai abrir jogo com dinheiro do operador: qualquer pagina /<digitos>/index.html
        # emite evento de frame, entao frame NAO sobrescreve o que o lancamento ensinou
        db.set_jogo({'casa':'fixture-g','id_jogo':'4','origem':'frame','campos':{'gameId':'666'}})
        linha = db.estado_snapshot()['jogos_identidade']['fixture-g']['4']
        self.assertEqual((linha['campos'], linha['origem']), ({'gameId':'4'}, 'lancamento'))
        # nome longo trunca em vez de derrubar o evento (descarte definitivo apos 3 tentativas)
        self.assertEqual(db.set_jogo({'casa':'fixture-g','id_jogo':'5','origem':'catalogo','nome':'N'*200})['status'],'ok')
        self.assertEqual(len(db.estado_snapshot()['jogos_identidade']['fixture-g']['5']['nome']), 80)
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'),'erro')

    def test_launch_shape_is_shared_so_one_profile_teaches_all(self):
        # O molde do launch vivia SO no navegador que viu o lancamento. Com dezenas de perfis,
        # clicar na moeda em qualquer outro caia no plano B (procurar o jogo na tela) e nao abria
        # nada — 15 instalacoes reportaram exatamente isso. A FORMA do pedido nao e sessao (a
        # sessao esta no header token e na chave que cifra), entao vai ao servidor e serve a todos.
        corpo = {'cid': 'pg', 'exitUrl': 'https://www.p4-listrapg.com/home/embedded',
                 'gameid': 2000002, 'os_type': 1, 'platfromid': 7, 'time': 1789500000,
                 'token': 'SESSAO-SECRETA', 'withdrawPass': '1234'}
        db.set_jogo({'casa': 'fixture-p4', 'id_jogo': '2000002', 'origem': 'lancamento',
                     'campos': corpo, 'seletor': 'div > x', 'marca': 'Gem'})
        guardado = db.estado_snapshot()['jogos_identidade']['fixture-p4']['2000002']['campos']
        self.assertEqual(sorted(guardado), ['cid', 'exitUrl', 'gameid', 'os_type', 'platfromid', 'time'])
        for proibido in ('token', 'withdrawPass'):
            self.assertNotIn(proibido, guardado, 'lista positiva nao pode deixar sessao atravessar')
        self.assertGreater(len(guardado['exitUrl']), 24, 'exitUrl passa do corte antigo; os outros seguem curtos')
        # Outra casa e outro jogo: a forma e emprestada. O que muda entre jogos e o gameid e entre
        # casas e o exitUrl, e os dois a aba refaz sozinha com a sessao dela.
        db.solicitar_jogo({'casas': ['fixture-p2'], 'id_jogo': '2000126'})
        self.assertEqual(db.abrir_jogo()['molde'], guardado)
        # So o gameid nao e forma nenhuma: era o estado anterior e nao pode passar por molde.
        self.assertIsNone(db._molde_do_launch({'x': {'9': {'campos': {'gameid': 9}}}}, ['x'], '9'))
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'), 'erro')

    def test_cycle_never_turns_without_being_named_and_confirmed(self):
        # Virar o ciclo some com o dia inteiro da tela. So o operador decide isso: pela HTTP o
        # pedido tem de NOMEAR o ciclo aberto e dizer confirmado. Clique perdido, aba velha com
        # JS antigo e requisicao reenviada nao podem fechar operacao.
        aberto = db.estado_snapshot()['ciclo_id']
        db.add_operacao({'casa':'fixture-c','conta':'c1','numero_pedido':'antes-1','tipo':'deposito',
                         'valor':50,'origem':'api','data':agora()})
        for pedido in ({}, {'confirmado': True}, {'ciclo_id': aberto + 99, 'confirmado': True},
                       {'ciclo_id': aberto}, {'ciclo_id': aberto, 'confirmado': 'sim'}):
            self.assertEqual(db.novo_ciclo_pedido(pedido)['status'], 'erro', pedido)
            self.assertEqual(db.estado_snapshot()['ciclo_id'], aberto, 'ciclo virou sem confirmação')
        self.assertEqual(db.resumo()['total_depositos'], 50, 'nada saiu do livro')
        # nomeado e confirmado: vira, e deixa rastro de quem virou
        r = db.novo_ciclo_pedido({'ciclo_id': aberto, 'confirmado': True})
        self.assertEqual((r['status'], r['ciclo']), ('ok', aberto + 1))
        historico = db.estado_snapshot()['ciclos_historico']
        self.assertEqual((historico[-1]['de'], historico[-1]['para'], historico[-1]['origem']),
                         (aberto, aberto + 1, 'painel'))
        # fechar operacao TAMBEM vira ciclo: um fechamento legitimo nao pode passar sem rastro
        agora_aberto = db.estado_snapshot()['ciclo_id']
        f = db.fechar_ciclo({'fechamento_id': 'f-audit-1', 'ciclo_id': agora_aberto, 'metas_ids': [],
                             'gerente': 0, 'bau': 0, 'saque_manual': 0})
        self.assertEqual(f['status'], 'ok')
        ultimo = db.estado_snapshot()['ciclos_historico'][-1]
        self.assertEqual((ultimo['de'], ultimo['para'], ultimo['origem']),
                         (agora_aberto, f['novo_ciclo_id'], 'fechamento'))

    def test_panel_state_lives_on_the_server_with_meta_history(self):
        # Metas, lucros, formularios e PIX viviam so no localStorage: limpar cache ou trocar de
        # navegador levava a contabilidade junto, e a copia diaria do banco nao salvava nada disso.
        meta = {'id':'m1','plataforma':'KF exemplo1','inicio':'2026-09-10','fimManual':None,
                'ok':False,'depositantes':75,'lucro':None}
        estado = {'operacoes':[meta],'chavesPix':[{'apelido':'principal'}],'config':{'periodo':'mes'}}
        self.assertEqual(db.set_painel({'estado':estado})['revisao'], 1)
        self.assertEqual(db.painel_estado()['estado']['chavesPix'], [{'apelido':'principal'}])
        # mudar o lucro guarda o valor anterior: e o unico desfazer de contabilidade que existe
        self.assertEqual(db.set_painel({'estado':dict(estado, operacoes=[dict(meta, lucro=200)])})['revisao'], 2)
        historico = db.painel_metas_historico()
        self.assertEqual([(m['plataforma'], m['lucro']) for m in historico[-1]['metas']], [('KF exemplo1', None)])
        self.assertEqual(db.painel_estado()['estado']['operacoes'][0]['lucro'], 200)
        # navegador recem-aberto NAO apaga a contabilidade do servidor
        r = db.set_painel({'estado':{'operacoes':[]}})
        self.assertEqual((r['status'], r['codigo']), ('erro','conflito'))
        self.assertEqual(len(db.painel_estado()['estado']['operacoes']), 1)
        self.assertEqual(db.set_painel({'estado':{'operacoes':[]}, 'confirmado':True})['status'], 'ok')
        # meta e dinheiro: campo desconhecido e data torta sao recusados
        self.assertEqual(db.set_painel({'estado':{'operacoes':[dict(meta, senha='x')]}})['codigo'], 'invalido')
        self.assertEqual(db.set_painel({'estado':{'operacoes':[dict(meta, inicio='10/09/2026')]}})['codigo'], 'invalido')
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'), 'erro')

    def test_meta_por_casa_alvo_manual_persiste_e_nao_quebra_backup(self):
        # Alvo de deposito por casa (card Progresso): manual, por ciclo, no servidor. Como abrir_jogo e
        # jogos_catalogo, o controle TEM que estar na allowlist do backup — senao um alvo derruba o
        # /api/backup do banco inteiro. Regressao para nao repetir a armadilha.
        self.assertEqual(db.set_meta_casa({'alvos': {'fixture-mc': 2400, 'fixture-mc2': 1000}})['status'], 'ok')
        alvos = db.estado_snapshot()['metas_por_casa']['alvos']
        self.assertEqual(alvos.get('fixture-mc'), 2400)
        self.assertEqual(alvos.get('fixture-mc2'), 1000)
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'), 'erro', 'alvo por casa nao pode quebrar o backup')
        # valor vazio remove o alvo daquela casa
        db.set_meta_casa({'alvos': {'fixture-mc': ''}})
        self.assertNotIn('fixture-mc', db.estado_snapshot()['metas_por_casa']['alvos'])

    def test_open_game_is_a_stamped_request_carrying_the_learned_click(self):
        # O servidor so CARIMBA o pedido; quem abre e a aba ja logada, repetindo o clique que o
        # operador deu uma vez. Nenhum token passa pelo painel.
        self.assertEqual(db.abrir_jogo()['ts'], 0)
        db.set_jogo({'casa':'p4','id_jogo':'2000002','origem':'lancamento','campos':{'gameid':2000002},
                     'seletor':'div:nth-of-type(3) > img','marca':'2000002.png'})
        db.set_jogo({'casa':'p2','id_jogo':'2000002','origem':'lancamento','campos':{'gameid':2000002},
                     'seletor':'outro > img','marca':'p2-2000002.png'})
        # o operador escolhe as casas: opera duas ao mesmo tempo e nem sempre quer as duas
        r = db.solicitar_jogo({'casas':['p4','p2'],'id_jogo':'2000002'})
        self.assertEqual(r['status'], 'ok')
        pedido = db.abrir_jogo()
        self.assertEqual((pedido['casas'], pedido['id_jogo']), (['p4','p2'],'2000002'))
        self.assertEqual(pedido['ts'], r['ts'])
        # cada aba recebe a receita aprendida na SUA casa, nao a da outra
        self.assertEqual(pedido['receitas']['p4'], {'seletor':'div:nth-of-type(3) > img','marca':'2000002.png'})
        self.assertEqual(pedido['receitas']['p2'], {'seletor':'outro > img','marca':'p2-2000002.png'})
        self.assertEqual(db.solicitar_jogo({'casas':['p4'],'id_jogo':'2000002'})['casas'], ['p4'])
        self.assertEqual(list(db.abrir_jogo()['receitas']), ['p4'], 'casa nao escolhida nao recebe receita')
        # cada pedido novo tem carimbo maior: a aba usa isso para nao repetir o mesmo comando
        self.assertGreater(db.solicitar_jogo({'casa':'p4','id_jogo':'2000002'})['ts'], r['ts'])
        # jogo sem clique aprendido nao leva receita nenhuma: a aba avisa em vez de clicar no escuro
        db.set_jogo({'casa':'p4','id_jogo':'2000039','origem':'lancamento','campos':{'gameid':2000039}})
        db.solicitar_jogo({'casas':['p4'],'id_jogo':'2000039'})
        self.assertEqual(db.abrir_jogo()['receitas'], {})
        self.assertEqual(db.solicitar_jogo({'casas':['p4']})['codigo'], 'invalido')

    def test_first_seen_clock_survives_rereads(self):
        # observado_em é renovado a cada releitura; primeiro_em (MIN de pedido_eventos) não. Sem isso o
        # corte de 30 min do acompanhamento e a expiração do servidor nunca chegavam para pedido relido.
        import datetime as _dt
        agora_ = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0)
        iso = lambda seg: (agora_ - _dt.timedelta(seconds=seg)).strftime('%Y-%m-%dT%H:%M:%S.000000Z')
        ha2h, ha5m = iso(7200), iso(300)     # calculados UMA vez (formato normalizado de instante())
        base = {'casa':'fixture-pv','conta':'c1','tipo':'deposito','origem':'extrato','valor':70,'revision':1}
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='pv-1', estado='processando', observado_em=ha2h))['status'],'ok')
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='pv-1', estado='processando', observado_em=ha5m))['status'],'ok')
        row = {r['numero_pedido']: r for r in db.pedidos_lista()}['pv-1']
        self.assertEqual(row['observado_em'], ha5m, 'observado_em segue a última leitura')
        self.assertEqual(row['primeiro_em'], ha2h, 'primeiro_em não zera com a releitura')
        # 'verificar' (casa expirou) visto pela 1ª vez há 2 h e relido há 5 min: expira pela idade real
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='pv-2', estado='processando', observado_em=ha2h))['status'],'ok')
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='pv-2', estado='verificar', observado_em=ha5m))['status'],'ok')
        self.assertGreaterEqual(db.expirar_pedidos(horas=1), 1)
        self.assertNotIn('pv-2', {r['numero_pedido'] for r in db.pedidos_lista()}, 'verificar relido expira pelo primeiro visto')
        # 'verificar' novo (visto há 5 min só) NÃO expira
        self.assertEqual(db.add_pedido(dict(base, numero_pedido='pv-3', estado='verificar', observado_em=ha5m))['status'],'ok')
        db.expirar_pedidos(horas=1)
        self.assertIn('pv-3', {r['numero_pedido'] for r in db.pedidos_lista()})

    def test_pix_creation_time_decides_deposit_cycle_and_official_time(self):
        # A criação do PIX (paysubmit) vira pedido 'identificado' com a hora de criação. O depósito que
        # confirma DEPOIS da virada do ciclo tem que cair no ciclo em que foi CRIADO (pedido_original) e
        # herdar a hora oficial — antes 0% dos depósitos tinham hora e caíam no ciclo da observação.
        criado = agora()
        velho = db.estado_snapshot()['ciclo_id']
        pix = {'casa':'fixture-pix','conta':'c1','numero_pedido':'pix-1','tipo':'deposito','estado':'identificado',
               'valor':None,'data':criado,'observado_em':criado,'origem':'paysubmit','revision':1}
        self.assertEqual(db.add_pedido(pix)['status'],'ok')
        db.novo_ciclo()                                   # operador fecha o ciclo antes do PIX ser pago
        self.assertNotEqual(db.estado_snapshot()['ciclo_id'], velho)
        r = db.add_operacao({'casa':'fixture-pix','conta':'c1','numero_pedido':'pix-1','tipo':'deposito',
                             'valor':50,'origem':'api','observado_em':agora()})
        self.assertEqual((r['status'], r['ciclo_id']), ('ok', velho), 'depósito cai no ciclo da CRIAÇÃO')
        with db._c() as c:
            op = c.execute("SELECT data,ciclo_motivo FROM operacoes WHERE numero_pedido='pix-1'").fetchone()
            ped = c.execute("SELECT estado,data FROM pedidos WHERE numero_pedido='pix-1'").fetchone()
        self.assertEqual(op['data'], criado, 'operação herda a hora oficial da criação')
        self.assertEqual(op['ciclo_motivo'], 'pedido_original')
        self.assertEqual((ped['estado'], ped['data']), ('confirmado', criado), 'pedido confirma sem perder a hora')

    def test_unpaid_pix_expires_but_paid_or_recent_stays(self):
        import datetime as _dt
        agora_ = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0)
        iso = lambda seg: (agora_ - _dt.timedelta(seconds=seg)).strftime('%Y-%m-%dT%H:%M:%S.000000Z')
        base = {'casa':'fixture-pn','conta':'c1','tipo':'deposito','estado':'identificado','valor':None,'origem':'paysubmit','revision':1}
        for numero, idade in (('pn-velho', 3 * 3600), ('pn-novo', 600), ('pn-pago', 3 * 3600)):
            self.assertEqual(db.add_pedido(dict(base, numero_pedido=numero, data=iso(idade), observado_em=iso(idade)))['status'],'ok')
        self.assertEqual(db.add_operacao({'casa':'fixture-pn','conta':'c1','numero_pedido':'pn-pago','tipo':'deposito',
                                          'valor':30,'origem':'api'})['status'],'ok')
        db.expirar_pedidos()
        with db._c() as c:
            estados = {r['numero_pedido']: (r['estado'], r['motivo']) for r in c.execute(
                "SELECT numero_pedido,estado,motivo FROM pedidos WHERE casa='fixture-pn'")}
        self.assertEqual(estados['pn-velho'], ('falhou', 'PIX gerado e não pago (expirou)'))
        self.assertEqual(estados['pn-novo'][0], 'identificado', 'PIX gerado há 10 min continua aberto')
        self.assertEqual(estados['pn-pago'][0], 'confirmado', 'PIX que virou depósito nunca expira')
        with db._c() as c:
            self.assertTrue(c.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_pedev_numero'").fetchone())

    def test_snapshot_carries_the_whole_cycle_not_200(self):
        # Ciclos reais passam de 200 operações (19: 318; 16: 400) e a lista do Ao Vivo cortava as antigas.
        for i in range(205):
            self.assertEqual(db.add_operacao({'casa':'fixture-cheio','conta':'c%d' % i,'numero_pedido':'op-%d' % i,
                                              'tipo':'deposito','valor':10,'origem':'api'})['status'],'ok')
        self.assertEqual(len(db.estado_snapshot()['operacoes']), 205)
        self.assertEqual(db.diagnostico()['total_operacoes'], 205, 'conferência: servidor e lista batem')

    def test_scan_withdrawals_is_scoped_to_the_active_operation(self):
        # Bug: "Conferir nas abas" varria TODAS as abas logadas (mexia na operacao 2). Agora o painel
        # manda as casas da operacao ao vivo ATIVA e a aba filha ignora comando fora do escopo.
        self.assertEqual(db.varredura_atual()['casas'], [], 'sem pedido: escopo vazio = todas, como antes')
        r = db.solicitar_varredura({'casas': ['p2-exemplopg']})
        self.assertEqual(r['status'], 'ok')
        atual = db.varredura_atual()
        self.assertEqual(atual['casas'], ['p2-exemplopg'])
        self.assertEqual(atual['ts'], r['ts'], 'a aba le o mesmo ts que o painel carimbou')
        r2 = db.solicitar_varredura({'casas': []})
        self.assertEqual(db.varredura_atual()['casas'], [], 'lista vazia = todas (botao fora de operacao)')
        self.assertGreater(r2['ts'], r['ts'], 'cada pedido tem carimbo maior')
        self.assertEqual(db.solicitar_varredura({'casas': ['casa-%d' % i for i in range(21)]})['codigo'],
                         'invalido', 'guarda: nao aceita casas demais no mesmo pedido')

    def test_domains_alias_is_stored_and_merged(self):
        # #3-B alias: a filha manda os dominios da casa (bonito + cloudfront + ELB); guardamos como
        # aliases so pra reconciliacao / "Casas sem nome". NAO re-chaveia historico nenhum.
        r = db.registrar_dominios({'casa': 'p2-exemplopg',
            'dominios': ['p2-exemplopg.com', 'exemplopg.com', 'd1exemplo.cloudfront.net']})
        self.assertEqual((r['status'], r['dominios']), ('ok', 3))
        r2 = db.registrar_dominios({'casa': 'p2-exemplopg', 'dominios': ['exemplopg.com', 'novo-elb.amazonaws.com']})
        self.assertEqual(r2['dominios'], 4, 'merge idempotente: reenviar nao duplica, so acrescenta')
        self.assertEqual(db.registrar_dominios({'casa': '', 'dominios': ['x.com']})['codigo'], 'invalido')

    def test_late_operation_in_closed_cycle_is_exposed(self):
        antes = agora()                      # instante dentro do ciclo que vai fechar em seguida
        fechado = db.estado_snapshot()['ciclo_id']   # id relativo: outro teste pode ter virado ciclo
        db.novo_ciclo()                      # fecha o atual (fechado_em = agora) e abre o seguinte
        op = {'casa':'fixture-t','conta':'c1','numero_pedido':'tarde-1','tipo':'deposito','valor':40,'origem':'api','data':antes}
        self.assertEqual(db.add_operacao(op)['status'],'ok')
        tardias = db.estado_snapshot()['operacoes_tardias']
        self.assertEqual([(t['numero_pedido'], t['ciclo_id']) for t in tardias], [('tarde-1', fechado)])
        self.assertGreater(tardias[0]['recebido_em'], tardias[0]['fechado_em'])
        # operacao do ciclo aberto nao e "tardia"
        self.assertEqual(db.add_operacao(dict(op, numero_pedido='agora-1', data=agora()))['status'],'ok')
        self.assertEqual(len(db.estado_snapshot()['operacoes_tardias']), 1)

    def test_dead_installations_do_not_mute_focus_alarm_or_inflate_queue(self):
        import datetime as _dt
        velho = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=16)).isoformat().replace('+00:00', 'Z')
        def ping(inst, quando, casa, estado, fila=0):
            # grava pelo caminho real (set_ping) e depois envelhece o ultimo_ping quando preciso
            db.set_ping({'instalacao_id':inst,'tipo':'mae','versao':'1.27','fila':fila,'estado':'ativo',
                         'slots':[{'casa':casa,'estado':estado,'diagnosticado_em':quando}]})
            with db._lock, db._c() as c:
                c.execute('UPDATE instalacoes SET ultimo_ping=? WHERE instalacao_id=?', (quando, inst))
        db.set_foco(['nome-antigo'])
        ping('mae-viva', db.agora(), 'p2', 'fora_do_foco')
        ping('mae-morta', velho, 'p2', 'atualizado', fila=5)
        sinal = db.captura_bloqueada()
        self.assertTrue(sinal['bloqueado'], 'instalação morta com slot antigo não pode calar o alarme de foco')
        self.assertEqual(sinal['casas_barradas'], ['p2'])
        estado = db.estado_snapshot()
        self.assertEqual(estado['fila_mae'], 0, 'fila da instalação offline não conta como pendência ativa')
        self.assertEqual(estado['fila_mae_offline'], 5, 'mas continua visível em separado')
        db.set_foco([])

    def test_offline_queue_counts_only_current_version(self):
        # 23/09: fila_player_offline=103 vinha de 83 ids mortos de versões antigas (órfãos de reinstalação).
        import datetime as _dt
        velho = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=5)).isoformat().replace('+00:00', 'Z')
        def ping(inst, versao, fila, quando=None):
            db.set_ping({'instalacao_id':inst,'tipo':'player','versao':versao,'fila':fila,'estado':'ativo','slots':[]})
            if quando:
                with db._lock, db._c() as c:
                    c.execute('UPDATE instalacoes SET ultimo_ping=? WHERE instalacao_id=?', (quando, inst))
        ping('viva', '1.70', 0)
        ping('morta-atual', '1.70', 3, velho)
        ping('morta-velha', '1.67', 9, velho)
        estado = db.estado_snapshot()
        self.assertEqual(estado['fila_player_offline'], 3, 'só a fila parada na versão atual é pendência')
        self.assertEqual(estado['fila_player_orfa'], 9, 'versões antigas ficam à parte')

    def test_rollover_spin_samples_keep_only_numbers_and_never_secrets(self):
        # Rollover (teste, 25/09): amostras da rodada guardam só números/nomes de chave, nunca token.
        import dados_rollover
        dados_rollover.add_giro_amostra({'casa': '11-gatinhopg', 'conta': '123456789', 'slug': 'fortune-tiger',
            'formato': 'json', 'caminho': 'dt.si', 'tamanho': 900, 'chaves': ['tb', 'bl', 'atk', 'token'],
            'numeros': {'tb': 0.3, 'bl': 101.2, 'atk': 99, 'sessionid': 5, 'x' * 30: 1, 'flag': True}})
        [a] = dados_rollover.giros_amostra()
        self.assertEqual(a['numeros'], {'tb': 0.3, 'bl': 101.2})
        self.assertEqual(a['chaves'], ['tb', 'bl'])
        for _ in range(dados_rollover.MAX_AMOSTRAS + 5):
            dados_rollover.add_giro_amostra({'slug': 'fortune-ox', 'numeros': {'tb': 1}})
        self.assertEqual(len(dados_rollover.giros_amostra()), dados_rollover.MAX_AMOSTRAS, 'lista curta, não cresce')
        self.assertEqual(db.resumo()['efetivo']['deposito'], 0, 'amostra de giro não é dinheiro')
        dados_rollover.limpar_amostras()
        self.assertEqual(dados_rollover.giros_amostra(), [])

    def test_panel_mirror_accepts_fields_the_panel_writes_on_metas(self):
        # 24/09: casaChave/fechamentoParcial não estavam em CAMPOS_META e o espelho recusava TODA gravação
        # ("meta com campo desconhecido") — a cópia do servidor ficou parada sem aviso visível.
        meta = {'id': 'm1', 'plataforma': '11 GATINHOPG', 'inicio': '2026-09-24', 'fimManual': None, 'ok': True,
                'depositantes': 14, 'lucro': -120.5, 'casaChave': '11-gatinhopg', 'fechamentoParcial': 20}
        self.assertEqual(db.set_painel({'estado': {'operacoes': [meta]}}).get('status'), 'ok')
        salvo = db.painel_estado()['estado']['operacoes'][0]
        self.assertEqual((salvo['casaChave'], salvo['fechamentoParcial']), ('11-gatinhopg', '20'))
        recusa = db.set_painel({'estado': {'operacoes': [dict(meta, campoInventado=1)]}})
        self.assertEqual(recusa.get('status'), 'erro', 'campo que ninguém conhece continua recusado')

    def test_official_deposit_from_mother_key_replaces_child_not_adds(self):
        # 24/09: "Usar depósito oficial" gravou na chave da mãe ('rolamento'); as ops estão em
        # 'p1-rolamentopg'. O efetivo somava as duas (R$ 30.185) e o Ao Vivo não via o oficial.
        db.add_operacao(operation('b1', house='p1-rolamentopg', account='a1', value=100))
        db.add_operacao(operation('b2', house='p1-rolamentopg', account='a2', kind='saque', value=40))
        db.set_ajuste({'casa': 'rolamento', 'deposito': 130, 'fonte': 'periodo', 'periodo': 'hoje@2026-09-24'})
        ef = db.resumo()['efetivo']
        self.assertEqual(ef['deposito'], 130, 'o oficial substitui, não soma')
        self.assertEqual([(h['casa'], h['deposito'], h['oficial']) for h in ef['por_casa']], [('p1-rolamentopg', 130, True)])
        self.assertEqual(ef['resultado'], -90)
        # Remover o ajuste (pela chave da mãe, como o botão faz) volta ao capturado.
        db.set_ajuste({'casa': 'rolamento', 'deposito': ''})
        self.assertEqual(db.resumo()['efetivo']['deposito'], 100)
        # Duas filhas na mesma mãe: o total da mãe cobre as duas — uma vez só.
        db.add_operacao(operation('b3', house='p3-rolamentopg', account='a3', value=50))
        db.set_ajuste({'casa': 'rolamento', 'deposito': 170})
        ef = db.resumo()['efetivo']
        self.assertEqual(ef['deposito'], 170)
        self.assertEqual(ef['saque'], 40, 'saques das filhas continuam')
        # Card da mãe mostra a filha SEM associar: associada > mesmo domínio > mesmo nome.
        ids = {'mapeamento': {'a8': 'rolamento'}, 'casas': [{'id': 'm', 'chaves': ['rolamento']}, {'id': 'f', 'chaves': ['p1-rolamentopg']}],
               'candidatos': [{'origem': 'm', 'destino': 'f', 'hosts': ['p1-rolamentopg.com']}]}
        db.add_operacao(operation('b4', house='a8', account='a4', value=5))
        with db._lock, db._c() as c:
            vinc = db._filhas_da_mae(c, [{'casa': 'rolamento'}, {'casa': 'hummer'}], ids)
        self.assertEqual(sorted((v['filha'], v['motivo']) for v in vinc['rolamento']),
                         [('a8', 'associada'), ('p1-rolamentopg', 'mesmo domínio p1-rolamentopg.com'), ('p3-rolamentopg', 'mesmo nome')])
        self.assertEqual(vinc['hummer'], [])
        # Mãe de chave opaca com NOME dado pelo operador liga à filha desse nome (card, D e oficial).
        # Apelido sem hífen ("11" da rede) não liga nada.
        self.assertEqual(db._mapa_mae({'mapeamento': {}, 'apelidos': {'hostExemplo1': '11-gatinhopg', 'bolha': '11'}}),
                         {'11-gatinhopg': 'hostExemplo1'})
        with db._lock, db._c() as c:
            vinc = db._filhas_da_mae(c, [{'casa': 'hostExemplo1'}], {'apelidos': {'hostExemplo1': 'p1-rolamentopg'}})
        self.assertEqual(vinc['hostExemplo1'], [{'filha': 'p1-rolamentopg', 'motivo': 'nome dado à mãe'}])
        self.assertEqual(db.resumo()['efetivo']['deposito'], 175, 'mostrar o par não muda valores (a8 fica à parte: 170 + 5)')

    def test_mother_vs_children_divergence_tests_windows_and_accounts(self):
        # Automação D (23/09): o rótulo "hoje" da mãe não garante a janela — testam-se dia/mês em UTC e
        # Brasília, e a conferência por conta aponta a conta que a mãe viu e nenhuma filha capturou.
        db.add_operacao(operation('d1', house='p2-exemplopg', account='a1', value=100, data='2026-09-23T02:30:00Z'))
        db.add_operacao(operation('d2', house='p2-exemplopg', account='a1', value=50, data='2026-09-23T12:00:00Z'))
        db.add_operacao(operation('s1', house='p2-exemplopg', account='a1', kind='saque', value=30, data='2026-09-23T13:00:00Z'))
        db.add_operacao(operation('x1', house='x-outrapg', account='a1', value=999, data='2026-09-23T12:00:00Z'))
        def casa(dep, saq, lida='2026-09-23T14:00:00Z', periodo='hoje@2026-09-23'):
            return [{'casa': 'exemplo', 'fontes': [{'tipo': 'agente_total', 'fonte': 'periodo', 'periodo': periodo,
                     'recebido_em': lida, 'conta_mae': 'm1', 'dados': {'deposito': dep, 'saque': saq}}],
                     'listas': [], 'listas_parciais': [{'conta_mae': 'm1', 'recebido_em': lida, 'periodo': 'desconhecido',
                     'membros': [{'conta': 'a1', 'deposito': 150}, {'conta': 'a2', 'nome': 'fora', 'deposito': 80}]}]}]
        def rodar(agente):
            with db._lock, db._c() as c:
                return db._divergencia_mae(c, agente, {})
        # 150 = dia UTC (inclui 02:30Z, que em Brasília ainda é dia 22); outra casa nunca entra.
        [d] = rodar(casa(150, 30))
        self.assertEqual(d['janela'], 'dia UTC')
        self.assertEqual(d['situacao'], {'deposito': 'igual', 'saque': 'igual'})
        self.assertEqual(d['filhas'], ['p2-exemplopg'])
        brasilia = next(o for o in d['outras_janelas'] if o['janela'] == 'dia Brasília')
        self.assertEqual(brasilia['deposito'], 50, 'dia de Brasília começa 03:00Z')
        self.assertEqual((d['contas']['iguais'], d['contas']['qtd_sem_captura']), (1, 1))
        self.assertEqual(d['contas']['sem_captura'][0]['conta'], 'a2', 'a conta que a mãe viu e nenhuma filha capturou')
        # Mãe com R$ 50 a mais: nenhuma janela bate e a diferença aparece com sinal (sem tolerância de pedido inteiro).
        [d] = rodar(casa(200, 30))
        self.assertIsNone(d['janela'])
        self.assertEqual(d['situacao']['deposito'], 'mae_maior')
        self.assertEqual(d['diferenca']['deposito'], -50)
        self.assertIsNone(d['explicado_por']['deposito'], 'sem pedido aberto, nada explica')
        # 24/09 rolamento: a mãe R$ 133 acima = um depósito de R$ 133 parado em "processando" (a casa
        # pagou, a filha não viu). Pedido de valor que não bate NÃO vira explicação.
        with db._lock, db._c() as c:
            for num, valor in (('p-50', 50), ('p-17', 17)):
                c.execute("INSERT INTO pedidos(casa,conta,numero_pedido,tipo,ciclo_id,valor,estado,motivo,origem,data,observado_em,recebido_em,revision) "
                          "VALUES('p2-exemplopg','a3',?,'deposito',?,?,'processando','','fixture','2026-09-23T12:30:00Z','2026-09-23T12:30:00Z','2026-09-23T12:30:00Z',1)",
                          (num, db._ciclo(c), valor))
        [d] = rodar(casa(200, 30))
        self.assertEqual([p['numero_pedido'] for p in d['explicado_por']['deposito']], ['p-50'])
        self.assertEqual(len(d['pedidos_abertos']['deposito']), 2)
        [d] = rodar(casa(160, 30))
        self.assertIsNone(d['explicado_por']['deposito'], 'R$ 10 não é nenhum pedido nem a soma de todos')
        # Saque capturado 10 min antes da leitura que a mãe ainda não mostra: aguardando, não divergência.
        [d] = rodar(casa(150, 0, lida='2026-09-23T13:10:00Z'))
        self.assertEqual(d['situacao']['saque'], 'aguardando_mae')
        # O que a mãe não tinha visto na hora da leitura não é cobrado dela.
        [d] = rodar(casa(100, 0, lida='2026-09-23T03:00:00Z'))
        self.assertEqual(d['situacao'], {'deposito': 'igual', 'saque': 'igual'})
        # Semana não tem data de início certa: fica sem comparação em vez de chutar.
        self.assertEqual(rodar(casa(150, 30, periodo='semana@2026-09-23')), [])
        self.assertIn('divergencia_mae', db.estado_snapshot())

    def test_recovery_copies_are_retained_and_never_left_truncated(self):
        import sqlite3 as _sq
        db.set_conta({'casa':'fixture-b','conta':'c1','saldo':1})
        pasta = Path(db.DB_PATH).parent/'_backups'
        nome = dados_backup._preserve_original()
        c = _sq.connect(pasta/nome)
        try:
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(c.execute('SELECT COUNT(*) FROM contas').fetchone()[0],1)
        finally:
            c.close()
        # retencao: passando de RETENCAO_COPIAS, as mais antigas nao referenciadas saem
        nomes = [nome]+[dados_backup._preserve_original() for _ in range(dados_backup.RETENCAO_COPIAS+1)]
        restantes = sorted(p.name for p in pasta.glob('antes-restore-*.sqlite3'))
        self.assertLessEqual(len(restantes), dados_backup.RETENCAO_COPIAS)
        self.assertIn(nomes[-1], restantes, 'a cópia mais recente sempre fica')
        self.assertNotIn(nomes[0], restantes, 'a mais antiga não referenciada sai')
        # falha no meio nao pode deixar arquivo truncado servindo de ponto de restauracao
        antes = set(p.name for p in pasta.glob('antes-restore-*.sqlite3'))
        real, criadas = dados_backup.sqlite3.connect, []
        class FonteQuebrada:            # sqlite3.Connection e imutavel: simular pelo connect
            def __init__(self, conn): self._conn = conn
            def backup(self, *_): raise RuntimeError('disco cheio no meio da copia')
            def close(self): self._conn.close()
        def connect(*a, **k):
            conn = real(*a, **k); criadas.append(conn)
            return FonteQuebrada(conn) if len(criadas) == 1 else conn
        with patch.object(dados_backup.sqlite3, 'connect', connect):
            with self.assertRaises(RuntimeError):
                dados_backup._preserve_original()
        self.assertEqual(set(p.name for p in pasta.glob('antes-restore-*.sqlite3')), antes, 'órfão removido')

    def test_cycle_extras_live_on_the_server_and_reset_with_the_cycle(self):
        vazio = db.extras()
        self.assertEqual((vazio['gerente'], vazio['bau'], vazio['saque_manual']), (None, None, {}))
        self.assertEqual(db.set_extras({'gerente': 3, 'bau': 2})['status'], 'ok')
        self.assertEqual(db.set_extras({'saque_manual': {'p2': 2300, 'exemplo': 15}})['status'], 'ok')
        # escrita parcial nao apaga o que ja estava
        atual = db.set_extras({'bau': 5})
        self.assertEqual((atual['gerente'], atual['bau']), (3, 5))
        self.assertEqual(atual['saque_manual'], {'p2': 2300, 'exemplo': 15})
        # o snapshot leva os valores para QUALQUER navegador
        self.assertEqual(db.estado_snapshot()['extras']['saque_manual']['p2'], 2300)
        # valor vazio remove a casa; None limpa o campo
        self.assertEqual(db.set_extras({'saque_manual': {'exemplo': ''}})['saque_manual'], {'p2': 2300})
        self.assertIsNone(db.set_extras({'gerente': None})['gerente'])
        # ciclo novo comeca limpo, sem herdar conferencia manual do ciclo anterior
        db.novo_ciclo()
        novo = db.extras()
        self.assertEqual((novo['gerente'], novo['bau'], novo['saque_manual']), (None, None, {}))
        self.assertEqual(novo['ciclo_id'], db.estado_snapshot()['ciclo_id'])
        # entrada invalida e recusada e nao corrompe o que existe
        db.set_extras({'gerente': 1})
        self.assertEqual(db.set_extras({'gerente': 'muito'})['status'], 'erro')
        self.assertEqual(db.extras()['gerente'], 1)
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'), 'erro')

    def test_restore_accepts_older_schema_additively(self):
        from dados_schema import SCHEMA_VERSION
        from dados_validacao import hash_json as _hash
        db.add_operacao(operation())
        snapshot = db.exportar()
        antes = self.all_business()
        # Simula um backup de schema ANTERIOR: sem uma coluna criada depois e sem uma tabela nova.
        velho = copy.deepcopy(snapshot)
        velho['schema_version'] = SCHEMA_VERSION - 1
        for row in velho['tabelas']['operacoes']:
            row.pop('data_original', None)
        velho['tabelas'].pop('revisao', None)
        presentes = sorted(velho['tabelas'])
        velho['manifesto']['hashes'] = {t: _hash(velho['tabelas'][t]) for t in presentes}
        velho['manifesto']['contagens'] = {t: len(velho['tabelas'][t]) for t in presentes}
        self.assertEqual(db.validar_restore(velho).get('valido'), True, 'backup de schema anterior é aceito')
        r = db.importar({'confirmar': True, 'restore_id': 'antigo', 'banco': copy.deepcopy(velho)})
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(db.operacoes()[0]['numero_pedido'], antes['operacoes'][0]['numero_pedido'])
        with db._lock, db._c() as c:
            self.assertIsNone(c.execute('SELECT data_original FROM operacoes').fetchone()[0], 'coluna nova entra NULL')
        # schema MAIOR que o suportado continua recusado, e coluna desconhecida tambem
        futuro = copy.deepcopy(snapshot); futuro['schema_version'] = SCHEMA_VERSION + 1
        self.assertEqual(db.validar_restore(futuro).get('status'), 'erro')
        estranho = copy.deepcopy(velho)
        estranho['tabelas']['operacoes'][0]['coluna_que_nao_existe'] = 1
        estranho['manifesto']['hashes']['operacoes'] = _hash(estranho['tabelas']['operacoes'])
        self.assertEqual(db.validar_restore(estranho).get('status'), 'erro')
        # no schema ATUAL a exigencia continua exata: coluna faltando e erro
        incompleto = copy.deepcopy(snapshot)
        for row in incompleto['tabelas']['operacoes']:
            row.pop('data_original', None)
        incompleto['manifesto']['hashes']['operacoes'] = _hash(incompleto['tabelas']['operacoes'])
        self.assertEqual(db.validar_restore(incompleto).get('status'), 'erro')

    def test_daily_copy_only_runs_when_there_is_none_from_today(self):
        import servidor, time as _t
        pasta = Path(db.DB_PATH).parent/'_backups'
        chamadas = []
        real = dados_backup._preserve_original
        def contando():
            chamadas.append(1); return real()
        # sem copia nenhuma: cria uma
        with patch.object(dados_backup, '_preserve_original', contando), patch.object(servidor.time, 'sleep', side_effect=StopIteration):
            with self.assertRaises(StopIteration): servidor._copia_diaria()
        self.assertEqual(len(chamadas), 1)
        self.assertEqual(len(list(pasta.glob('antes-restore-*.sqlite3'))), 1)
        # com copia recente: nao cria outra
        with patch.object(dados_backup, '_preserve_original', contando), patch.object(servidor.time, 'sleep', side_effect=StopIteration):
            with self.assertRaises(StopIteration): servidor._copia_diaria()
        self.assertEqual(len(chamadas), 1, 'copia de menos de 24 h basta')
        # envelhecendo a copia, volta a criar
        for p in pasta.glob('antes-restore-*.sqlite3'):
            os.utime(p, (_t.time()-90000, _t.time()-90000))
        with patch.object(dados_backup, '_preserve_original', contando), patch.object(servidor.time, 'sleep', side_effect=StopIteration):
            with self.assertRaises(StopIteration): servidor._copia_diaria()
        self.assertEqual(len(chamadas), 2, 'passadas 24 h cria de novo')
        # falha na copia nao pode derrubar o servidor
        with patch.object(dados_backup, '_preserve_original', side_effect=RuntimeError('disco cheio')), \
             patch.object(servidor.time, 'sleep', side_effect=StopIteration):
            with self.assertRaises(StopIteration): servidor._copia_diaria()

    def test_pedido_does_not_create_financial_operation(self):
        d = dict(operation(), estado='confirmado', observado_em=agora(), revision=1)
        self.assertEqual(db.add_pedido(d)['status'], 'ok')
        self.assertEqual(db.resumo()['total_depositos'], 0)
        self.assertEqual(db.add_pedido(dict(d, estado='processando', revision=2))['status'], 'duplicado')
        self.assertEqual(db.pedidos_lista(True)[0]['estado'], 'confirmado')

    def test_unknown_value_stays_unknown(self):
        d = dict(operation(value=None), estado='identificado', observado_em=agora())
        db.add_pedido(d)
        self.assertIsNone(db.pedidos_lista()[0]['valor'])

    def test_close_effective_adjustments_raw_untouched_extras_and_manual(self):
        for d in (operation('a-1'), operation('a-2'), operation('b-1', house='fixture-b', value=40),
                  operation('s-1', kind='saque', value=100)):
            db.add_operacao(d)
        db.set_ajuste({'casa':'fixture-a', 'deposito':30, 'contas':1, 'unidade_contador':'contas'})
        raw = self.table('operacoes')
        request, result = self.close(saque_manual=-5)
        self.assertEqual(result['resumo']['deposito'], 70)
        self.assertEqual(result['resumo']['saque'], 95)
        self.assertEqual(result['resumo']['gerente_bau'], 30)
        self.assertEqual(result['resumo']['resultado'], 55)
        self.assertEqual(result['resumo']['contas'], 2)
        self.assertEqual(result['metas_ids'], ['existing-1','existing-2'])
        self.assertEqual(self.table('operacoes'), raw)
        db.add_operacao(operation('late', value=2, data=raw[0]['created_at']))
        self.assertEqual(db.fechar_ciclo(request), result)
        self.assertEqual(len(self.table('ciclos')), 2)
        self.assertEqual(db.fechar_ciclo(dict(request, bau=9))['codigo'], 'conflito')

    def test_unknown_counter_and_zero_official(self):
        db.add_operacao(operation())
        db.set_ajuste({'casa':'fixture-a','deposito':0,'contas':25})
        result = db.resumo()['efetivo']
        self.assertEqual(result['deposito'], 0)
        self.assertIsNone(result['contas'])
        db.set_ajuste({'casa':'fixture-a','deposito':0,'contas':0,'unidade_contador':'contas'})
        self.assertEqual(db.resumo()['efetivo']['contas'], 0)

    def test_close_validation_has_no_side_effect(self):
        before = self.all_business()
        _, result = self.close(saque_manual=-1)
        self.assertEqual(result['status'], 'erro')
        self.assertEqual(self.all_business(), before)
        _, result = self.close(gerente=True)
        self.assertEqual(result['status'], 'erro')

    def test_conflict_revision_and_ping_separation(self):
        revision = db.versao()
        db.set_ping({'instalacao_id':'install-a','tipo':'player','versao':'1.0','fila':0})
        db.set_ping({'instalacao_id':'install-b','tipo':'mae','versao':'1.0','fila':9})
        self.assertEqual(db.versao(), revision)
        self.assertEqual(len(db.instalacoes_lista()), 2)
        state = db.estado_snapshot()
        self.assertEqual(state['fila_mae'], 9)
        self.assertGreater(state['telemetria_versao'], 0)
        self.assertEqual(db.set_cronograma({'cronograma':{'0':['fixture-a']},'expected_versao':revision})['status'], 'ok')
        self.assertEqual(db.set_cronograma({'cronograma':{},'expected_versao':revision})['codigo'], 'conflito')

    def test_revision_tracks_same_length_updates(self):
        db.set_conta({'casa':'fixture-a','conta':'account-1','saldo':1})
        revision = db.versao()
        db.set_conta({'casa':'fixture-a','conta':'account-1','saldo':2})
        self.assertNotEqual(db.versao(), revision)

    def test_snapshot_concurrent_writer_exact_consistency(self):
        errors = []
        def writer():
            try:
                for i in range(100):
                    self.assertEqual(db.add_operacao(operation('thread-'+str(i)))['status'], 'ok')
            except BaseException as exc:
                errors.append(exc)
        thread = threading.Thread(target=writer)
        thread.start()
        for _ in range(100):
            state = db.estado_snapshot()
            self.assertEqual(state['resumo']['qtd_depositos'], len(state['operacoes']))
            self.assertEqual(state['resumo']['total_depositos'], sum(r['valor'] for r in state['operacoes']))
            self.assertEqual(state['resumo']['ciclo_id'], state['ciclo_id'])
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertFalse(errors)

    def test_connections_closed_after_failure_and_success(self):
        with db._c() as connection:
            connection.execute('SELECT 1')
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute('SELECT 1')
        try:
            with db._c() as failed:
                raise RuntimeError('fixture')
        except RuntimeError:
            pass
        with self.assertRaises(sqlite3.ProgrammingError):
            failed.execute('SELECT 1')

    def mother(self, **changes):
        d = {'tipo':'agente_total','casa':'fixture-a','fonte':'periodo','periodo':'mes@2026-09',
             'periodo_observado':True,'recebido_em':agora(),'deposito':100,'contas':25}
        d.update(changes)
        return db.set_agente(d)

    def test_mother_scope_no_total_overwrite_and_null_preserved(self):
        self.assertEqual(self.mother()['status'], 'ok')
        self.mother(fonte='total', deposito=900, saque=600)
        house = db.agente_lista()[0]
        self.assertEqual(house['deposito_total'], 100)
        self.assertIsNone(house['saque_total'])
        self.assertEqual(len(house['fontes']), 2)
        self.mother(deposito=0, contas=None, periodo='hoje@2026-09-10')
        house = db.agente_lista()[0]
        self.assertEqual(house['deposito_total'], 0)
        self.assertIsNone(house['contas'])

    def test_mother_pages_complete_empty_and_partial(self):
        self.mother()
        base = {'tipo':'agente_membros','casa':'fixture-a','fonte':'membros','periodo':'mes@2026-09',
                'periodo_observado':True,'coleta_id':'run-a','total_paginas':2,'lista_completa':False}
        a = {'conta':'account-1','deposito':10,'isDep':'0','online':'0'}
        b = {'conta':'account-2','deposito':20,'isDep':'1','online':'1'}
        self.assertEqual(db.set_agente(dict(base,pagina=2,membros=[b],lista_completa=True,mais=False))['status'], 'ok')
        self.assertEqual(len(db.agente_lista()[0]['membros']), 1)
        self.assertFalse(db.agente_lista()[0]['lista_completa'])
        self.assertEqual(db.set_agente(dict(base,pagina=1,membros=[a]))['status'], 'ok')
        house = db.agente_lista()[0]
        self.assertEqual(len(house['membros']), 2)
        self.assertFalse(house['membros'][0]['is_dep'])
        db.set_agente(dict(base,coleta_id='run-b',pagina=1,membros=[]))
        self.assertEqual(len(db.agente_lista()[0]['membros']), 2)
        db.set_agente(dict(base,coleta_id='run-c',pagina=1,total_paginas=1,lista_completa=True,mais=False,membros=[]))
        self.assertEqual(db.agente_lista()[0]['membros'], [])
        self.assertTrue(db.agente_lista()[0]['lista_completa'])

    def test_accumulated_scope_only_for_total_info_and_period_preference(self):
        self.assertEqual(self.mother(fonte='total',periodo='acumulado',periodo_observado=False)['status'], 'ok')
        self.assertEqual(db.agente_lista()[0]['periodo'], 'acumulado')
        self.assertEqual(self.mother(periodo='acumulado')['status'], 'erro')
        self.assertEqual(db.periodo_ciclo(), 'mes')
        self.assertEqual(db.set_periodo({'periodo':'hoje'})['status'], 'ok')
        self.assertEqual(db.periodo_ciclo(), 'hoje')

    def test_mother_identity_separates_sources_and_complete_lists(self):
        self.mother(conta_mae='mother-a', deposito=100)
        members = {'tipo':'agente_membros','casa':'fixture-a','fonte':'membros','periodo':'mes@2026-09',
                   'periodo_observado':True,'coleta_id':'same-run','pagina':1,'total_paginas':1,'lista_completa':True}
        db.set_agente(dict(members,conta_mae='mother-a',membros=[{'conta':'child-a','deposito':10}]))
        self.assertEqual(db.agente_lista()[0]['membros'][0]['conta'],'child-a')
        self.mother(conta_mae='mother-b',deposito=200)
        house = db.agente_lista()[0]
        self.assertEqual(house['conta_mae'],'mother-b')
        self.assertEqual(house['deposito_total'],200)
        self.assertEqual(house['membros'],[])
        db.set_agente(dict(members,conta_mae='mother-b',membros=[{'conta':'child-b','deposito':20}]))
        house = db.agente_lista()[0]
        self.assertEqual(house['membros'][0]['conta'],'child-b')
        self.assertEqual(len(house['listas']),2)
        self.assertEqual(len(self.table('agente_fontes')),4)

    def test_close_transaction_rolls_back_on_snapshot_insert_failure(self):
        db.add_operacao(operation())
        before = self.all_business()
        with db._c() as c:
            c.execute("CREATE TRIGGER fail_close BEFORE INSERT ON fechamentos BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.close()
        self.assertEqual(self.all_business(),before)

    def test_ambiguous_delete_requires_full_identity(self):
        db.add_operacao(operation())
        db.add_operacao(operation(house='fixture-b'))
        self.assertEqual(db.del_operacao('order-1')['codigo'],'conflito')
        self.assertEqual(len(self.table('operacoes')),2)
        self.assertEqual(db.del_operacao({'numero_pedido':'order-1','casa':'fixture-b','conta':'account-1'})['status'],'ok')
        self.assertEqual(len(self.table('operacoes')),1)

    def test_game_categories_no_cross_house_merge_or_boot_cleanup(self):
        with db._c() as c:
            c.execute("INSERT INTO jogos_cat VALUES('fixture-a','account-1','slot',1,2,1,'old')")
            c.execute("INSERT INTO jogos_cat VALUES('fixture-b','account-1','slot',3,4,1,'old')")
            c.execute("INSERT INTO jogos_cat VALUES(NULL,'account-1','slot',5,6,1,'old')")
        before = self.table('jogos_cat')
        db.init()
        self.assertEqual(self.table('jogos_cat'), before)
        self.assertEqual(len(db.jogos_cat_lista()), 3)

    def test_game_batch_requires_identity_and_is_idempotent(self):
        d = {'casa':'fixture-a','conta':'account-1','categorias':[{'nome':'slot','apostado':2,'ganho':3,'apostas':1}]}
        self.assertEqual(db.set_jogos_cat(d)['status'], 'erro')
        d['event_id'] = 'batch-1'
        db.set_jogos_cat(d)
        db.set_jogos_cat(d)
        self.assertEqual(db.jogos_cat_lista()[0]['apostas'], 1)

    def test_backup_restore_all_tables_and_idempotence(self):
        db.add_pendente(operation('pending'))
        db.add_pedido(dict(operation('withdraw',kind='saque',value=None),estado='processando'))
        db.add_operacao(operation(event_id='ack-1'))
        self.close()
        db.set_cronograma({'cronograma':{'0':['fixture-a']}})
        db.set_ping({'instalacao_id':'install-a','versao':'1','fila':2})
        snap = db.exportar()
        self.assertEqual(set(snap['tabelas']), set(db._BACKUP_TABLES))
        self.assertFalse(snap['manifesto']['cobertura']['completa'])
        before = db.versao()
        self.assertTrue(db.validar_restore({'banco':snap})['valido'])
        self.assertEqual(db.versao(), before)
        db.add_operacao(operation('after-backup'))
        request = {'confirmar':True, 'restore_id':'restore-1', 'banco':snap}
        result = db.importar(request)
        self.assertEqual(result['status'], 'ok', result)
        self.assertEqual(self.all_business(), snap['tabelas'])
        db.add_operacao(operation('after-restore'))
        after = self.all_business()
        self.assertEqual(db.importar(request), result)
        self.assertEqual(self.all_business(), after)
        self.assertEqual(db.restore_status('restore-1')['estado'], 'concluido')

    def test_backup_survives_real_javascript_json_roundtrip(self):
        db.add_operacao(operation(value=100.0))
        db.add_operacao(operation('withdraw',kind='saque',value=301.01))
        self.close()
        with db._c() as c:
            c.execute('INSERT INTO jogos_cat VALUES(?,?,?,?,?,?,?)',
                      ('fixture-a','account-1','tiny',1e-7,1.0000000000000001e18,1,agora()))
        snapshot = db.exportar()
        source = serializar(snapshot)
        proc = subprocess.run(['node','-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))));"],
                              input=source, text=True, encoding='utf-8', capture_output=True, check=True, timeout=15)
        self.assertNotEqual(source,proc.stdout)
        parsed = json.loads(proc.stdout)
        self.assertEqual(db.validar_restore({'banco':parsed})['status'],'ok')
        self.assertEqual(db.importar({'confirmar':True,'restore_id':'js-roundtrip','banco':parsed})['status'],'ok')
        self.assertEqual(hash_json(snapshot),hash_json(parsed))

    def test_invalid_backups_do_not_delete_or_preserve_side_effect(self):
        db.add_operacao(operation())
        snap = db.exportar()
        variants = [{}, {'_v':1,'tabelas':{}}, dict(snap,tabelas={})]
        bad = copy.deepcopy(snap)
        bad['tabelas']['pedidos'] = []
        del bad['tabelas']['pendentes']
        variants.append(bad)
        bad = copy.deepcopy(snap)
        bad['tabelas']['operacoes'][0]['valor'] = '0'
        bad['manifesto'].update(dados_backup._manifest(bad['tabelas']))
        variants.append(bad)
        before = self.all_business()
        for i, payload in enumerate(variants):
            result = db.importar({'confirmar':True,'restore_id':'bad-'+str(i),'banco':payload})
            self.assertEqual(result['status'], 'erro')
            self.assertEqual(self.all_business(), before)
        self.assertFalse(os.path.exists(os.path.join(self.temp.name, '_backups')))

    def test_valid_hash_cannot_hide_invalid_nested_backup_data(self):
        self.mother()
        db.set_ping({'tipo':'player','versao':'1','instalacao_id':'fixture-install'})
        self.close()
        original = db.exportar()
        before = self.all_business()
        for table, field, value in (('agente_fontes','dados','[]'),('instalacoes','slots','{}'),('fechamentos','resumo','{}')):
            snapshot = copy.deepcopy(original)
            snapshot['tabelas'][table][0][field] = value
            snapshot['manifesto'].update(dados_backup._manifest(snapshot['tabelas']))
            self.assertEqual(db.importar({'confirmar':True,'restore_id':'invalid-'+table,'banco':snapshot})['status'],'erro')
            self.assertEqual(self.all_business(),before)
        original['manifesto']['cobertura']['completa'] = True
        self.assertFalse(db.validar_restore({'banco':original})['cobertura']['completa'])

    def test_restore_rollback_after_delete_and_preserves_native_original(self):
        db.add_operacao(operation())
        snapshot = db.exportar()
        db.add_pendente(operation('survive'))
        with db._c() as c:
            c.execute("INSERT INTO contas(casa,conta,sessao) VALUES('fixture-a','account-1','fixture-secret-never-http')")
        before = self.all_business()
        def fail(c, snap):
            c.execute('DELETE FROM operacoes')
            c.execute('DELETE FROM pedidos')
            raise RuntimeError('interrupção simulada')
        with patch.object(dados_backup, '_restore_rows', fail):
            with self.assertRaises(RuntimeError):
                db.importar({'confirmar':True,'restore_id':'interrupted','banco':snapshot})
        self.assertEqual(self.all_business(), before)
        self.assertEqual(db.restore_status('interrupted')['estado'], 'falhou')
        files = list(Path(self.temp.name, '_backups').glob('*.sqlite3'))
        self.assertEqual(len(files), 1)
        c = sqlite3.connect(files[0])
        try:
            self.assertEqual(c.execute('SELECT sessao FROM contas').fetchone()[0], 'fixture-secret-never-http')
            self.assertEqual(c.execute('SELECT COUNT(*) FROM pendentes').fetchone()[0], 1)
        finally:
            c.close()
        self.assertNotIn('fixture-secret-never-http', serializar(db.exportar()))

    def test_migration_legacy_sql_preserves_every_existing_row_column(self):
        # Fixture contém apenas DDL, nenhum dado nem módulo externo ao pacote.
        ddl = (APP/'testes'/'fixtures'/'schema-legado.sql').read_text(encoding='utf-8')
        legacy_path = os.path.join(self.temp.name, 'legacy.sqlite3')
        c = sqlite3.connect(legacy_path)
        c.row_factory = sqlite3.Row
        try:
            c.executescript(ddl)
            c.execute("INSERT INTO ciclos(id,aberto,criado_em) VALUES(7,1,'2026-09-01 00:00:00')")
            c.execute("INSERT INTO operacoes(id,ciclo_id,numero_pedido,tipo,valor,casa,conta,data,origem,created_at) VALUES(88,7,'99999999999999999999','deposito',12.34,NULL,NULL,'2026-09-01 01:00:00','legacy','2026-09-01 01:00:01')")
            c.execute("INSERT INTO jogos VALUES(98,7,'round-1','fixture-a','account-1','slot',1,2,5,'old')")
            for house in ('fixture-a','fixture-b',None):
                c.execute('INSERT INTO jogos_cat VALUES(?,?,?,?,?,?,?)',(house,'account-1','slot',1,2,1,'old'))
            c.execute("INSERT INTO pendentes VALUES('pending-1',7,'account-1','fixture-a',0,'old')")
            c.execute("INSERT INTO contas VALUES('fixture-a','account-1',0,0,NULL,3,4,'legacy-host','fixture-secret','old')")
            c.execute("INSERT INTO ajustes VALUES(7,'fixture-a',0,25,'old')")
            c.execute("INSERT INTO agente VALUES('fixture-a','parent-1',10,2,NULL,3,4,8,'old')")
            c.execute("INSERT INTO agente_membros VALUES('fixture-a','account-1','fixture-name',10,20,0,0,'old')")
            c.execute("INSERT INTO foco VALUES('fixture-a','old')")
            c.execute("INSERT INTO encerradas VALUES('fixture-b','old')")
            c.execute("INSERT INTO descartados VALUES(7,'discarded-1','old')")
            c.execute("UPDATE sqlite_sequence SET seq=999 WHERE name='operacoes'")
            c.commit()
            tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            before = {t:[dict(r) for r in c.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in tables}
        finally:
            c.close()
        db.DB_PATH = legacy_path
        db.init()
        db.init()
        with db._c() as c:
            self.assertEqual(c.execute("SELECT seq FROM sqlite_sequence WHERE name='operacoes'").fetchone()[0],999)
        for table, rows in before.items():
            after = self.table(table)
            self.assertEqual(len(rows),len(after),table)
            for old, new in zip(rows, after):
                self.assertEqual(old, {k:new[k] for k in old}, table)


if __name__ == '__main__':
    unittest.main(verbosity=2)
