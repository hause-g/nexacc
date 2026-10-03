"""Executa cada regressÃ£o isoladamente; interrompe a liberaÃ§Ã£o se qualquer processo falhar."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import json
import datetime
import time

BASE=Path(__file__).resolve().parent
def main():
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    node=shutil.which('node') or 'C:/Program Files/nodejs/node.exe'
    artifacts=Path(os.environ.get('AGENTUM_ARTIFACTS_DIR') or BASE/'validacoes').expanduser().resolve()
    out=artifacts/'validacoes'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f');out.mkdir(parents=True,exist_ok=False)
    logs=out/'saidas';logs.mkdir(exist_ok=True)
    # O ambiente do desenvolvedor nao pode mudar o resultado: AGENTUM_API_TOKEN/EXTENSION_IDS
    # ativam a guarda do servidor e reprovariam suites que sobem servidor em porta efemera.
    ambiente={k:v for k,v in os.environ.items() if not k.startswith('AGENTUM_')}
    failures=[];results=[]
    tests=sorted(p for p in (BASE/'testes').glob('*') if p.suffix in ('.js','.py','.cjs') and not p.name.startswith('_') and not p.name.endswith('_helpers.cjs'))
    for test in tests:
        interpreter=sys.executable if test.suffix=='.py' else node
        started=time.monotonic()
        try:
            command=[interpreter]+(['--test'] if test.name.endswith('.test.cjs') else [])+[str(test)]
            run=subprocess.run(command,cwd=BASE,env={**ambiente,'AGENTUM_TESTING':'1','AGENTUM_VALIDATION_DIR':str(out),'PYTHONDONTWRITEBYTECODE':'1','PYTHONIOENCODING':'utf-8','AGENTUM_TEST_PYTHON':sys.executable},capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=90)
            # Guardar SEMPRE a saida: reprovacao intermitente as 2h da manha so deixava
            # 'aprovado:false, codigo:1' e a causa se perdia ate a proxima repeticao.
            (logs/(test.stem+'.log')).write_text(run.stdout+run.stderr,encoding='utf-8',errors='replace')
            print(('PASS ' if run.returncode==0 else 'FAIL ')+test.name,flush=True)
            results.append({'teste':test.name,'aprovado':run.returncode==0,'codigo':run.returncode,'segundos':round(time.monotonic()-started,3),'saida':str(logs/(test.stem+'.log'))})
            if run.returncode: failures.append(test.name);print(run.stdout[-7000:]+run.stderr[-7000:],flush=True)
        except (OSError,subprocess.TimeoutExpired) as error:
            # No timeout o subprocess mata so o filho: um chrome.exe orfao segura a porta e faz a
            # proxima execucao reprovar por motivo alheio ao codigo. Guarda o que saiu ate ali.
            parcial=getattr(error,'stdout',None) or b'';parcial=parcial.decode('utf-8','replace') if isinstance(parcial,bytes) else str(parcial)
            (logs/(test.stem+'.log')).write_text(parcial+chr(10)+type(error).__name__,encoding='utf-8',errors='replace')
            failures.append(test.name);print('FAIL '+test.name+': '+type(error).__name__,flush=True)
            results.append({'teste':test.name,'aprovado':False,'erro':type(error).__name__,'saida':str(logs/(test.stem+'.log'))})
    print(f'{len(tests)-len(failures)}/{len(tests)} suites aprovadas.',flush=True)
    (out/'VALIDACAO.json').write_text(json.dumps({'executado_em':datetime.datetime.now().astimezone().isoformat(),'aprovadas':len(tests)-len(failures),'total':len(tests),'sucesso':not failures,'suites':results},ensure_ascii=False,indent=2),encoding='utf-8')
    print('Resultados: '+str(out/'VALIDACAO.json'),flush=True)
    return 1 if failures else 0
if __name__=='__main__':sys.exit(main())
