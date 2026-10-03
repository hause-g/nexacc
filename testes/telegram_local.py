"""Regressões de alerta com rede substituída; nenhuma mensagem real é enviada."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('alerta',Path(__file__).resolve().parents[1]/'telegram'/'enviar_alerta.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);folder=root/'telegram';folder.mkdir();mod.PASTA=folder
    (folder/'config.json').write_text(json.dumps({'token':'TEST-ONLY','chat_id':'TEST-ONLY','hora_envio':'14:25'}))
    (folder/'cronograma.json').write_text(json.dumps({'0':['legado']}))
    assert mod.horario({'hora_envio':'14:25'})=='14:25'
    try:mod.horario({'hora_envio':'29:00'});raise AssertionError('aceitou hora inválida')
    except ValueError:pass
    assert mod.cronograma()=={'0':['legado']}
    with contextlib.closing(sqlite3.connect(root/'operacoes.db')) as db:
        db.execute('CREATE TABLE controles(chave TEXT PRIMARY KEY,valor TEXT)')
        db.execute('INSERT INTO controles VALUES(?,?)',('cronograma',json.dumps({'0':['atualizado']})))
        db.commit()
    assert mod.cronograma()=={'0':['atualizado']}
    class Reply:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def read(self):return b'{"ok":true}'
    with patch.object(mod.urllib.request,'urlopen',return_value=Reply()) as send,contextlib.redirect_stdout(io.StringIO()),patch.dict(mod.os.environ,{},clear=True):
        assert mod.main()==0;assert mod.main()==0;assert send.call_count==1
    for p in (folder/'_envios').iterdir():p.unlink()
    with patch.object(mod.urllib.request,'urlopen',side_effect=TimeoutError('url com segredo não deve aparecer')),contextlib.redirect_stdout(io.StringIO()) as output,patch.dict(mod.os.environ,{},clear=True):
        assert mod.main()==1;assert mod.main()==0
        assert 'segredo' not in output.getvalue()
    assert json.loads(next((folder/'_envios').iterdir()).read_text())['estado']=='confirmacao_indisponivel'
    # 27/09: mensagem traz quem lança e quem encerra; horário vem do painel; --agendado espera o horário
    import datetime
    domingo=datetime.date(2026,9,27)
    texto=mod.mensagem({'0':['P2'],'lancamentos':{'0':['EXEMPLO <x>']}},domingo)
    assert 'Lançam (16:00)' in texto and '• EXEMPLO &lt;x&gt;' in texto and 'Encerram (12:00)' in texto and '• P2' in texto
    assert 'Nenhuma casa' in mod.mensagem({'1':['P2']},domingo)
    assert 'fechar o mês' not in texto
    assert 'Arquive as metas concluídas de setembro' in mod.mensagem({},datetime.date(2026,10,1))
    with contextlib.closing(sqlite3.connect(root/'operacoes.db')) as db:
        db.execute('INSERT INTO controles VALUES(?,?)',('painel_estado',json.dumps({'estado':{'config':{'horaAlerta':'23:59'}}})))
        db.commit()
    assert mod.horario({'hora_envio':'14:25'})=='23:59'
    for p in (folder/'_envios').iterdir():p.unlink()
    class Cedo(datetime.datetime):
        @classmethod
        def now(cls,tz=None):return cls(2026,9,27,10,0)
    with patch.object(mod.datetime,'datetime',Cedo),patch.object(mod.sys,'argv',['x','--agendado']),patch.object(mod.urllib.request,'urlopen') as send,patch.dict(mod.os.environ,{},clear=True):
        assert mod.main()==0;assert send.call_count==0
    import urllib.error
    with patch.object(mod.urllib.request,'urlopen',side_effect=urllib.error.URLError(OSError('sem rede'))),contextlib.redirect_stdout(io.StringIO()),patch.dict(mod.os.environ,{},clear=True),patch.object(mod.sys,'argv',['x']):
        assert mod.main()==1
    assert not list((folder/'_envios').iterdir()), 'sem rede deve liberar nova tentativa'
print('Telegram: cronograma canônico, horário, deduplicação e timeout aprovados (sem rede real).')
