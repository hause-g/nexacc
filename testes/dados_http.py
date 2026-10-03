"""API real em porta efêmera, arquivos/banco/logs exclusivamente temporários."""
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import db
import servidor
from http.server import ThreadingHTTPServer


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agentum-http-')
        self.previous = db.DB_PATH, servidor.BASE, servidor.LOG_DIR
        db.DB_PATH = os.path.join(self.temp.name, 'data.sqlite3')
        servidor.BASE = self.temp.name
        servidor.LOG_DIR = os.path.join(self.temp.name, 'logs')
        db.init()
        Path(self.temp.name,'index.html').write_text('<!doctype html><title>fixture</title>',encoding='utf-8')
        Path(self.temp.name,'seed.js').write_text('sensitive fixture',encoding='utf-8')
        Path(self.temp.name,'assets').mkdir()
        Path(self.temp.name,'assets','public.js').write_text('let fixture=true',encoding='utf-8')
        self.server = ThreadingHTTPServer(('127.0.0.1',0),servidor.Handler)
        self.assertNotEqual(self.server.server_port,8765)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        db.DB_PATH, servidor.BASE, servidor.LOG_DIR = self.previous
        self.temp.cleanup()

    def request(self, method='GET', path='/api/estado', data=None, headers=None, raw=None):
        conn = http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        req_headers = dict(headers or {})
        body = raw
        if data is not None:
            body = json.dumps(data).encode()
            req_headers.setdefault('Content-Type','application/json')
        try:
            conn.request(method,path,body=body,headers=req_headers)
            response = conn.getresponse()
            content = response.read()
            parsed = json.loads(content) if content and response.getheader('Content-Type','').startswith('application/json') else content
            return response.status, dict(response.getheaders()), parsed
        finally:
            conn.close()

    def test_origin_host_extensions_and_no_wildcard(self):
        origin = 'http://localhost:'+str(self.server.server_port)
        code, headers, result = self.request(headers={'Origin':origin})
        self.assertEqual(code,200)
        self.assertEqual(headers['Access-Control-Allow-Origin'],origin)
        self.assertNotEqual(headers['Access-Control-Allow-Origin'],'*')
        ext = 'chrome-extension://'+'a'*32
        # origem de extensao valida: CORS ecoado numa rota que a extensao realmente usa (a mae le /api/foco)
        code, headers, _ = self.request(path='/api/foco',headers={'Origin':ext,'Sec-Fetch-Site':'cross-site'})
        self.assertEqual(code,200)
        self.assertEqual(headers['Access-Control-Allow-Origin'],ext)
        # ... mas o estado completo (operacoes, contas) nao e rota de extensao
        self.assertEqual(self.request(headers={'Origin':ext,'Sec-Fetch-Site':'cross-site'})[0],403)
        for headers in ({'Origin':'https://evil.example'}, {'Origin':'null'}, {'Origin':origin+'.evil.example'},
                        {'Origin':'chrome-extension://invalid'}, {'Host':'evil.example'},
                        {'Host':'localhost:1'}, {'Sec-Fetch-Site':'cross-site'}):
            code, response_headers, _ = self.request(headers=headers)
            self.assertEqual(code,403,headers)
            self.assertNotIn('Access-Control-Allow-Origin',response_headers)

    def test_evil_origin_cannot_mutate_and_preflight_rejects(self):
        for method in ('POST','OPTIONS'):
            code, _, _ = self.request(method,'/api/ciclo/novo',data={},headers={'Origin':'https://evil.example'})
            self.assertEqual(code,403)
        with db._c() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM ciclos').fetchone()[0],1)
        code, headers, _ = self.request('OPTIONS','/api/operation',headers={'Origin':'chrome-extension://'+'b'*32})
        self.assertEqual(code,204)
        self.assertIn('POST',headers['Access-Control-Allow-Methods'])

    def test_extension_origin_limited_to_capture_routes(self):
        ext = {'Origin':'chrome-extension://'+'a'*32,'Sec-Fetch-Site':'cross-site'}
        painel = {'Origin':'http://127.0.0.1:'+str(self.server.server_port)}
        # captura e leitura de configuracao continuam passando para a extensao
        op = {'casa':'fixture','conta':'a','numero_pedido':'ext-1','tipo':'deposito','valor':5}
        self.assertEqual(self.request('POST','/api/operation',op,headers=ext)[0],200)
        for path in ('/api/foco','/api/encerradas','/api/periodo','/api/varrer_saque'):
            self.assertEqual(self.request('GET',path,headers=ext)[0],200,path)
        self.assertEqual(self.request('OPTIONS','/api/agente',headers=ext)[0],204)
        # administracao e exportacao sao negadas a qualquer extensao, mesmo bem formada
        for method,path,data in (('POST','/api/restore',{'validar':True,'banco':{}}),('POST','/api/operacoes/limpar',{}),
                                 ('GET','/api/backup',None),('POST','/api/foco',{'casas':[]}),('POST','/api/ciclo/novo',{}),
                                 ('POST','/api/varrer_saque',{}),('GET','/api/estado',None)):
            code, _, body = self.request(method,path,data,headers=ext)
            self.assertEqual(code,403,(method,path))
            self.assertEqual(body['motivo'],'rota indisponível para extensão')
        with db._c() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM ciclos').fetchone()[0],1)
        # o painel segue com acesso total
        self.assertEqual(self.request('GET','/api/backup',headers=painel)[0],200)
        self.assertEqual(self.request('POST','/api/foco',{'casas':[]},headers=painel)[0],200)

    def test_estado_cache_serves_repeats_but_never_hides_a_change(self):
        painel = {'Origin':'http://127.0.0.1:'+str(self.server.server_port)}
        chamadas = []
        real = db.estado_snapshot
        def contando():
            chamadas.append(1); return real()
        with patch.object(db, 'estado_snapshot', contando):
            servidor._estado_cache['chave'] = None
            primeiro = self.request(headers=painel)[2]
            repetido = self.request(headers=painel)[2]
            self.assertEqual(len(chamadas), 1, 'poll repetido nao remonta o estado')
            self.assertEqual(primeiro['versao'], repetido['versao'])
            # qualquer escrita muda a revisao e o cache tem que soltar o dado novo
            op = {'casa':'fixture','conta':'a','numero_pedido':'cache-1','tipo':'deposito','valor':7}
            self.assertEqual(self.request('POST','/api/operation',op,headers=painel)[0],200)
            depois = self.request(headers=painel)[2]
            self.assertEqual(len(chamadas), 2, 'apos escrita o estado e remontado')
            self.assertNotEqual(depois['versao'], primeiro['versao'])
            self.assertEqual(depois['resumo']['total_depositos'], 7)
            # O estado depende do RELOGIO (instalacao 'viva' = ping nos ultimos 180 s), entao a
            # chave carrega um balde de tempo: sem ele o cache congelaria 'extensao conectada'
            # depois que os pings parassem. Aqui: a chave usa o balde atual e, ao mudar, relê.
            revisao, balde, esperada = servidor._estado_cache['chave']
            self.assertEqual(balde, int(time.time()) // servidor._ESTADO_BALDE, 'a chave usa o balde atual')
            servidor._estado_cache['chave'] = (revisao, balde - 1, esperada)
            self.request(headers=painel)
            # SWR: a virada do balde devolve o valor anterior e revalida em segundo plano.
            for _ in range(60):
                if len(chamadas) >= 3:
                    break
                time.sleep(0.05)
            self.assertEqual(len(chamadas), 3, 'balde vencido relê o estado (revalidação em segundo plano)')

    def test_no_session_static_sensitive_or_head_bypass(self):
        for path in ('/seed.js','/db.py','/data.sqlite3','/telegram/config.json','/logs/ops.jsonl','/controle-servidor.ps1',
                     '/shared/cryptolib.js','/build/build.js','/testes/fixture.js','/documentacao/index.html',
                     '/db%2epy','/assets/../db.py','/assets/public.js::$DATA','/assets/public.js%20',
                     '/OPERAC~1.DB-', '/assets/'):
            for method in ('GET','HEAD'):
                self.assertEqual(self.request(method,path)[0],403,(method,path))
        self.assertEqual(self.request(path='/api/sessao?casa=fixture&conta=fixture')[0],410)
        self.assertEqual(self.request(path='/')[0],200)
        self.assertEqual(self.request(path='/assets/public.js')[0],200)

    def test_http_ack_and_business_errors(self):
        event = {'casa':'fixture','conta':'account','numero_pedido':'request-1','tipo':'deposito','valor':12.34,'event_id':'event-1','revision':2}
        code, _, first = self.request('POST','/api/operation',event)
        self.assertEqual(code,200)
        self.assertEqual(first['ack'],{'event_id':'event-1','revision':2})
        self.assertEqual(self.request('POST','/api/operation',event)[2],first)
        self.assertEqual(self.request('POST','/api/operation',dict(event,valor=3))[0],409)
        self.assertEqual(self.request('POST','/api/operation',dict(event,valor=None))[0],400)

    def test_http_conta_echoes_ack_like_other_capture_routes(self):
        # A filha exige ack.event_id em TODA rota de captura (background.js); /api/conta nao ecoava e
        # a fila ficava presa em 'ack_event_id'. O recibo tambem precisa passar na validacao de backup.
        event = {'casa':'fixture','conta':'account','saldo':10.5,'event_id':'conta-1','revision':1}
        code, _, first = self.request('POST','/api/conta',event)
        self.assertEqual(code,200)
        self.assertEqual(first['ack'],{'event_id':'conta-1','revision':1})
        self.assertEqual(self.request('POST','/api/conta',event)[2],first)
        self.assertEqual(self.request('POST','/api/conta',dict(event,saldo=99))[0],409)
        db.init()
        self.assertNotEqual(db.validar_restore(db.exportar()).get('status'),'erro')

    def test_pedido_pending_persistent_route_and_slots(self):
        d = {'casa':'fixture','conta':'account','numero_pedido':'pedido-1','tipo':'saque','valor':None,
             'estado':'processando','motivo':'aguardando','observado_em':'2026-09-10T12:00:00Z','event_id':'pedido-event'}
        self.assertEqual(self.request('POST','/api/pedido',d)[0],200)
        ping = {'instalacao_id':'install-1','tipo':'player','versao':'1.24','fila':0,'pendentes':1,
                'slots':[{'tab_id':2,'frame_id':0,'conta':'account','casa':'fixture','geracao':'generation',
                          'estado':'observado','ultimo_evento':None,'senha':'fixture-secret','url':'https://secret.invalid'}]}
        # o recibo diz qual versao o servidor empacotou: a extensao velha passa a saber sozinha,
        # sem depender de alguem estar com o painel aberto
        import os as _os
        pasta = _os.path.join(servidor.BASE,'extensao')
        _os.makedirs(pasta, exist_ok=True)
        with open(_os.path.join(pasta,'manifest.json'),'w',encoding='utf-8') as fh:
            fh.write('{"version": "9.99"}')
        codigo, _, recibo = self.request('POST','/api/ping',ping)
        self.assertEqual((codigo, recibo['esperada']),(200,'9.99'))
        db.init()
        state = self.request()[2]
        self.assertEqual(state['pedidos'][0]['numero_pedido'],'pedido-1')
        self.assertIsNone(state['pedidos'][0]['valor'])
        self.assertEqual(state['resumo']['total_saques'],0)
        self.assertEqual(state['instalacoes'][0]['fila'],0)
        self.assertNotIn('senha',state['instalacoes'][0]['slots'][0])
        self.assertNotIn('url',state['instalacoes'][0]['slots'][0])

    def test_strict_json_body_no_nan_duplicate_or_simple_forms(self):
        for raw in (b'{}broken',b'{"x":NaN}',b'{"tipo":"a","tipo":"b"}',b'[]'):
            self.assertEqual(self.request('POST','/api/operation',raw=raw,headers={'Content-Type':'application/json'})[0],400)
        self.assertEqual(self.request('POST','/api/ciclo/novo',raw=b'{}',headers={'Content-Type':'text/plain'})[0],400)

    def test_full_restore_preflight_status_and_idempotence_http(self):
        snapshot = self.request(path='/api/backup')[2]
        before = db.versao()
        for path, data in (('/api/restore/validar',{'banco':snapshot}),('/api/restore',{'banco':snapshot,'validar':True})):
            code, _, result = self.request('POST',path,data)
            self.assertEqual(code,200,result)
            self.assertTrue(result['valido'])
            self.assertEqual(db.versao(),before)
        self.assertEqual(self.request('POST','/api/restore',{'confirmar':True,'banco':{}})[0],400)
        request = {'confirmar':True,'restore_id':'restore-http','banco':snapshot}
        code, _, result = self.request('POST','/api/restore',request)
        self.assertEqual(code,200,result)
        self.assertEqual(self.request('POST','/api/restore',request)[2],result)
        status = self.request(path='/api/restore/status?id=restore-http')[2]
        self.assertEqual(status['estado'],'concluido')
        self.assertEqual(status['resposta'],result)

    def test_cronograma_periodo_and_debug_coverage(self):
        self.assertEqual(self.request('POST','/api/cronograma',{'cronograma':{'0':['fixture']}})[0],200)
        self.assertEqual(self.request(path='/api/cronograma')[2]['cronograma'],{'0':['fixture']})
        self.assertEqual(self.request('POST','/api/periodo',{'periodo':'ontem'})[0],200)
        self.assertEqual(self.request(path='/api/periodo')[2]['periodo'],'ontem')
        status = self.request(path='/api/debug/status')[2]
        self.assertFalse(status['ativo'])
        self.assertFalse(status['captura_bruta'])
        self.assertEqual(self.request('POST','/api/debug',{'senha':'fixture-secret'})[0],410)
        self.assertFalse(Path(self.temp.name,'capturas').exists())
        self.assertFalse(self.request()[2]['cobertura_backup']['completa'])

    def test_logs_are_bounded_redacted_complete_lines_and_preserve_history(self):
        Path(servidor.LOG_DIR).mkdir()
        old = Path(servidor.LOG_DIR,'ops-2020.jsonl')
        old.write_text('historical fixture',encoding='utf-8')
        with patch.object(servidor,'LOG_MAX_BYTES',1024):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda i: servidor._log_op({'tipo':'deposito','conta':'fixture-secret','valor':999,'sessao':'fixture-token'}, {'status':'ok'}), range(300)))
        files = list(Path(servidor.LOG_DIR).glob('tecnico-api*.jsonl'))
        self.assertLessEqual(len(files),servidor.LOG_FILES)
        for file in files:
            self.assertLessEqual(file.stat().st_size,1024)
            for line in file.read_text(encoding='utf-8').splitlines():
                self.assertEqual(json.loads(line)['status'],'ok')
                self.assertNotIn('fixture-secret',line)
                self.assertNotIn('fixture-token',line)
                self.assertNotIn('valor',json.loads(line))
        self.assertEqual(servidor._purge_antigos(),0)
        self.assertEqual(old.read_text(encoding='utf-8'),'historical fixture')


if __name__ == '__main__':
    unittest.main(verbosity=2)
