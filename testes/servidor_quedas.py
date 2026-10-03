"""Diagnóstico de queda do servidor: o motivo fica gravado e as quedas do supervisor são contadas.
Tudo em pastas temporárias; nada toca no servidor real nem no banco."""
import datetime
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import servidor


class QuedasTests(unittest.TestCase):
    def test_conta_quedas_das_ultimas_24h_no_formato_do_supervisor(self):
        with tempfile.TemporaryDirectory(prefix='agentum-quedas-') as tmp:
            log = os.path.join(tmp, 'supervisor.log')
            with open(log, 'w', encoding='utf-8') as f:
                f.write('[20/09/2026 11:24:46,69] servidor caiu; religando em 3s \n')   # > 24h
                f.write('[21/09/2026  0:05:20,28] servidor caiu; religando em 3s \n')  # hora com espaço
                f.write('[21/09/2026 23:27:50,17] servidor caiu; religando em 3s \n')
                f.write('[21/09/2026 23:38:30,73] servidor caiu; religando em 3s \n')
                f.write('linha sem data\n[21/09/2026 23:40:00,00] outra coisa\n')
            agora = datetime.datetime(2026, 9, 22, 0, 0, 0)   # janela 21/09 00:00 → 22/09 00:00
            r = servidor._quedas_recentes(agora_local=agora, caminho=log)
            self.assertEqual(r['quedas_24h'], 3)
            self.assertEqual(r['ultima_queda'], '21/09 23:38')
            vazio = servidor._quedas_recentes(caminho=os.path.join(tmp, 'nao-existe.log'))
            self.assertEqual(vazio, {'quedas_24h': 0, 'ultima_queda': None})

    def _rodar(self, corpo, log):
        codigo = textwrap.dedent('''
            import sys; sys.path.insert(0, {app!r})
            import servidor
            servidor._preparar_diagnostico_de_queda({log!r})
        ''').format(app=str(APP), log=log) + textwrap.dedent(corpo)
        return subprocess.run([sys.executable, '-c', codigo], capture_output=True, text=True, timeout=60)

    def test_queda_por_excecao_grava_inicio_e_traceback(self):
        with tempfile.TemporaryDirectory(prefix='agentum-erro-') as tmp:
            log = os.path.join(tmp, 'logs', 'servidor-erro.log')
            r = self._rodar('raise RuntimeError("boom de teste")', log)
            self.assertNotEqual(r.returncode, 0)
            texto = Path(log).read_text(encoding='utf-8')
            self.assertIn('=== início', texto)
            self.assertIn('exceção não tratada (queda)', texto)
            self.assertIn('RuntimeError: boom de teste', texto)
            self.assertIn('RuntimeError: boom de teste', r.stderr, 'o console continua vendo o erro')

    def test_saida_normal_fica_marcada(self):
        with tempfile.TemporaryDirectory(prefix='agentum-erro-') as tmp:
            log = os.path.join(tmp, 'logs', 'servidor-erro.log')
            r = self._rodar('print("ok")', log)
            self.assertEqual(r.returncode, 0)
            texto = Path(log).read_text(encoding='utf-8')
            self.assertIn('=== início', texto)
            self.assertIn('=== saída normal', texto)

    def test_excecao_em_thread_tambem_e_gravada(self):
        with tempfile.TemporaryDirectory(prefix='agentum-erro-') as tmp:
            log = os.path.join(tmp, 'logs', 'servidor-erro.log')
            self._rodar('''
                import threading
                t = threading.Thread(target=lambda: 1/0, name="faxina"); t.start(); t.join()
            ''', log)
            texto = Path(log).read_text(encoding='utf-8')
            self.assertIn('exceção na thread faxina', texto)
            self.assertIn('ZeroDivisionError', texto)


class FaxinaTests(unittest.TestCase):
    def test_faxina_roda_as_duas_rotinas_e_registra(self):
        from unittest.mock import patch
        with patch.object(servidor.db, 'expirar_pedidos', return_value=3) as exp, \
             patch.object(servidor.db, 'limpar_instalacoes', return_value=5) as poda, \
             patch.object(servidor, '_log_technical') as log:
            self.assertEqual(servidor._faxina_uma_vez(), {'pedidos_expirados': 3, 'instalacoes_podadas': 5})
        exp.assert_called_once(); poda.assert_called_once()
        self.assertEqual(log.call_args[0][0]['evento'], 'faxina')

    def test_falha_numa_rotina_nao_derruba_nem_pula_a_outra(self):
        from unittest.mock import patch
        with patch.object(servidor.db, 'expirar_pedidos', side_effect=RuntimeError('banco ocupado')), \
             patch.object(servidor.db, 'limpar_instalacoes', return_value=0) as poda, \
             patch.object(servidor, '_log_technical'):
            r = servidor._faxina_uma_vez()
        self.assertEqual(r['pedidos_expirados'], 'erro: RuntimeError')
        self.assertEqual(r['instalacoes_podadas'], 0)
        poda.assert_called_once()

    def test_sem_nada_a_fazer_nao_polui_o_log(self):
        from unittest.mock import patch
        with patch.object(servidor.db, 'expirar_pedidos', return_value=0), \
             patch.object(servidor.db, 'limpar_instalacoes', return_value=0), \
             patch.object(servidor, '_log_technical') as log:
            servidor._faxina_uma_vez()
        log.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
