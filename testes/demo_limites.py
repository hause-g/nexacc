"""Limites da demonstração. Não executa jobs, não abre navegador nem usa rede real."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import servidor
from dados_validacao import Invalido


class DemoLimits(unittest.TestCase):
    def test_real_jobs_and_ambiguous_flags_are_rejected_before_dispatch(self):
        with patch.object(servidor.motor_autospin, "iniciar_jobs") as dispatch:
            for value in ({}, None, [], {"dry_run": False}, {"dry_run": "true"}, {"dry_run": 1}):
                with self.subTest(value=value), self.assertRaises(Invalido):
                    servidor._autospin_iniciar(value)
            dispatch.assert_not_called()

    def test_session_sync_does_not_claim_success_or_use_network(self):
        with patch.object(servidor.urllib.request, "urlopen") as network, patch.object(servidor.subprocess, "Popen") as spawn:
            response = servidor._autospin_sincronizar()
            self.assertEqual(response["status"], "erro")
            self.assertEqual(response["ts"], 0)
            self.assertEqual(servidor._autospin_ping(), {"ts": 0})
            network.assert_not_called()
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
