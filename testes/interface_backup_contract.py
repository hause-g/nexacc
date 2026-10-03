"""Contratos reais autossuficientes; só bancos temporários, sem servidor ou dados reais."""
import json
import pathlib
import sys
import tempfile
import unittest

APP = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import db
from dados_backup import validar_banco


def fixture(financial=False):
    with tempfile.TemporaryDirectory(prefix='agentum-interface-') as temp:
        old_path = db.DB_PATH
        db.DB_PATH = str(pathlib.Path(temp) / 'isolado.sqlite3')
        try:
            db.init()
            if not financial:
                return db.exportar()
            for order, house, account, value, kind in [('D01','a','1',100,'deposito'), ('D02','a','1',50,'deposito'), ('D03','b','1',30,'deposito'), ('S01','a','1',301.01,'saque')]:
                result = db.add_operacao({'numero_pedido':order,'casa':house,'conta':account,'valor':value,'tipo':kind,'data':'2026-09-10T12:00:00Z','origem':'interface_teste'})
                assert result.get('status') != 'erro', result
            adjusted = db.set_ajuste({'casa':'a','deposito':170,'contas':25,'unidade_contador':'desconhecida'})
            assert adjusted['status'] == 'ok', adjusted
            common = {'casa':'a','conta_mae':'mae-teste-1','periodo_observado':True,'recebido_em':'2026-09-10T12:00:00Z'}
            members = [{'conta':str(i+1),'nome':'Nome de afiliado muito longo para validar alinhamento e quebra' if i == 0 else 'Conta '+str(i+1),'deposito':123456.78 if i == 0 else 100,'aposta':54321.09 if i == 0 else None} for i in range(20)]
            readings = [
                {'tipo':'agente_total','fonte':'periodo','periodo':'mes@2026-09','deposito':123456.78,'saque':301.01,'aposta':987654.32,'contas':25,'unidade_contador':'desconhecida'},
                {'tipo':'agente_total','fonte':'total','periodo':'acumulado','deposito':234567.89,'saque':65432.10,'contas':58},
                {'tipo':'agente_info','fonte':'info','periodo':'acumulado','membros_qtd':35},
                {'tipo':'agente_membros','fonte':'membros','periodo':'mes@2026-09','coleta_id':'lista-completa','pagina':1,'total_paginas':1,'lista_completa':True,'mais':False,'membros':members},
                {'tipo':'agente_membros','fonte':'membros','periodo':'mes@2026-09','coleta_id':'lista-parcial','pagina':1,'total_paginas':2,'lista_completa':False,'membros':members[:10],'recebido_em':'2026-09-10T13:00:00Z'},
            ]
            for reading in readings:
                result = db.set_agente(dict(common, **reading))
                assert result['status'] == 'ok', result
            snapshot = db.estado_snapshot()
            request = {'fechamento_id':'interface-teste-frozen','ciclo_id':snapshot['ciclo_id'],'expected_versao':snapshot['versao'],'metas_ids':['m1','m2'],'gerente':2,'bau':1,'saque_manual':-1.01}
            response = db.fechar_ciclo(request)
            assert response['status'] == 'ok', response
            assert response == db.fechar_ciclo(request)
            return {'snapshot':snapshot,'request':request,'response':response,'banco':db.exportar()}
        finally:
            db.DB_PATH = old_path


class InterfaceBackupContract(unittest.TestCase):
    def test_fresh_export_uses_real_bank_contract(self):
        result = validar_banco(fixture())
        self.assertEqual(result['status'], 'ok', result)
        self.assertTrue(result['valido'])
        self.assertFalse(result['cobertura']['completa'])

    def test_financial_and_post_close_export(self):
        data = fixture(True)
        self.assertIsNone(data['snapshot']['resumo_efetivo']['contas'])
        self.assertEqual(data['response']['resumo']['resultado'], 130)
        self.assertEqual(validar_banco(data['banco'])['status'], 'ok')


if __name__ == '__main__':
    if '--fixture' in sys.argv or '--finance-fixture' in sys.argv:
        print(json.dumps(fixture('--finance-fixture' in sys.argv), ensure_ascii=False))
    else:
        unittest.main()
