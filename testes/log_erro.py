from pathlib import Path
import sys,tempfile,json
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import servidor
class Stub:
    def _json(self,value,code): return value,code
with tempfile.TemporaryDirectory(prefix='agentum-log-') as directory:
    previous=servidor.LOG_DIR;servidor.LOG_DIR=directory
    try:
        try:raise RuntimeError('senha_fixture_nunca_expor')
        except RuntimeError:response,code=servidor.Handler._failure(Stub())
        text=(Path(directory)/'tecnico-api.jsonl').read_text(encoding='utf-8')
        row=json.loads(text)
        assert code==500 and response['status']=='erro'
        assert 'senha_fixture_nunca_expor' not in text+json.dumps(response)
        assert row['classe']=='RuntimeError' and row['quadros'][-1]['arquivo']=='log_erro.py'
        assert row['quadros'][-1]['linha']>0
        print('Erros com localização do código e sem mensagem/dados sensíveis: aprovado.')
    finally:servidor.LOG_DIR=previous
