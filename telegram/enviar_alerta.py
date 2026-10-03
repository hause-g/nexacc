# -*- coding: utf-8 -*-
"""Alerta local do cronograma. Não imprime token, mensagem ou resposta bruta em caso de erro.

A tarefa do Windows roda a cada 15 min com --agendado: só envia depois do horário do painel
(Ajustes › Alerta diário) e uma vez por dia. Assim PC desligado ou na bateria ao meio-dia não perde
o dia — manda assim que voltar. Sem --agendado (teste manual) envia na hora.
"""
import datetime
import hashlib
import html
import json
import os
from pathlib import Path
import re
import socket
import sys
import sqlite3
from contextlib import closing
import urllib.error
import urllib.parse
import urllib.request

PASTA=Path(__file__).resolve().parent
DIAS=['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado']
MESES=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro']
HORA=re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')

def carregar(nome):
    with open(PASTA/nome,encoding='utf-8-sig') as f:return json.load(f)

def _controle(chave):
    database=PASTA.parent/'operacoes.db'
    if not database.exists():return None
    try:
        with closing(sqlite3.connect('file:'+database.as_posix()+'?mode=ro',uri=True)) as connection:
            row=connection.execute('SELECT valor FROM controles WHERE chave=?',(chave,)).fetchone()
    except sqlite3.OperationalError:
        return None # Banco anterior à migração: arquivo legado permanece como reserva.
    return None if row is None else json.loads(row[0])

def cronograma():
    value=_controle('cronograma')
    if value is not None:
        if isinstance(value,dict):return value
        raise ValueError('Cronograma persistido inválido')
    return carregar('cronograma.json')

def horario(cfg):
    """O horário vem do painel (Ajustes › Alerta diário); hora_envio do config.json é a reserva."""
    painel=_controle('painel_estado')
    try:value=str(painel['estado']['config']['horaAlerta']).strip()
    except (TypeError,KeyError):value=''
    if HORA.fullmatch(value):return value
    value=str(cfg.get('hora_envio','12:00')).strip()
    if not HORA.fullmatch(value):raise ValueError('Horário inválido; use HH:MM.')
    return value

def casas(lista):
    if lista is None:return []
    if not isinstance(lista,list) or any(not isinstance(p,str) for p in lista):raise ValueError('Cronograma inválido.')
    return [p for p in lista if p.strip()]

def mensagem(schedule,today):
    """Mesmo texto do botão Testar notificação do painel: quem lança e quem encerra hoje."""
    day=today.isoweekday()%7
    lanc=schedule.get('lancamentos') or {}
    if not isinstance(lanc,dict):raise ValueError('Cronograma inválido.')
    horas=schedule.get('horarios') if isinstance(schedule.get('horarios'),dict) else {}
    lanca,encerra=casas(lanc.get(str(day))),casas(schedule.get(str(day)))
    partes=['⏰ <b>Cronograma de hoje</b>\n📅 '+DIAS[day]+', '+today.strftime('%d/%m')]
    if lanca:partes.append('🚀 <b>Lançam ('+html.escape(horas.get('lancamento','16:00'))+')</b>\n'+'\n'.join('• '+html.escape(p) for p in lanca))
    if encerra:partes.append('🏁 <b>Encerram ('+html.escape(horas.get('encerramento','12:00'))+')</b>\n'+'\n'.join('• '+html.escape(p) for p in encerra))
    if not lanca and not encerra:partes.append('Nenhuma casa lança ou encerra hoje.')
    if today.day==1:
        # Dia 1: as metas do mês que acabou são arquivadas pelo mês em que começaram (painel).
        anterior=(today.replace(day=1)-datetime.timedelta(days=1))
        partes.append('📦 <b>Dia de fechar o mês</b>\nArquive as metas concluídas de '+MESES[anterior.month-1]+': aba Metas › Fechar mês.')
    return '\n\n'.join(partes)

def main():
    cfg=carregar('config.json')
    if '--horario' in sys.argv:
        print(horario(cfg));return 0
    now=datetime.datetime.now()
    if '--agendado' in sys.argv and now.strftime('%H:%M')<horario(cfg):
        return 0
    token=os.environ.get('AGENTUM_TELEGRAM_TOKEN',cfg.get('token','')).strip()
    chat=str(os.environ.get('AGENTUM_TELEGRAM_CHAT_ID',cfg.get('chat_id',''))).strip()
    if not token or not chat:
        print('[ERRO] Configure token e destinatário do Telegram.');return 1
    today=now.date()
    try:message=mensagem(cronograma(),today)
    except ValueError:
        print('[ERRO] Cronograma inválido.');return 1
    datekey=today.isoformat()+'-'+hashlib.sha256(chat.encode()).hexdigest()[:12]
    ledger=PASTA/'_envios';ledger.mkdir(exist_ok=True)
    marker=ledger/(datekey+'.json')
    try:
        fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    except FileExistsError:
        print('[INFO] Alerta já enviado ou em verificação para este dia.');return 0
    with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump({'estado':'em_envio','data':today.isoformat()},f)
    body=urllib.parse.urlencode({'chat_id':chat,'text':message,'parse_mode':'HTML','disable_web_page_preview':'true'}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage',data=body),timeout=20) as r:
            answer=json.loads(r.read().decode())
        if answer.get('ok') is not True:
            # Rejeição explícita: nada enviado; permitir nova tentativa após corrigir configuração.
            marker.unlink();print('[ERRO] O Telegram recusou o envio. Verifique a configuração.');return 1
        temp=marker.with_suffix('.tmp');temp.write_text(json.dumps({'estado':'enviado','data':today.isoformat()}),encoding='utf-8');os.replace(temp,marker)
        print('[OK] Alerta enviado.');return 0
    except urllib.error.HTTPError:
        marker.unlink();print('[ERRO] O Telegram recusou o envio. Verifique a configuração.');return 1
    except urllib.error.URLError as e:
        if not isinstance(e.reason,(socket.timeout,TimeoutError)):
            # Sem rede/DNS: a conexão nem abriu, nada foi entregue. Tenta de novo na próxima rodada.
            marker.unlink();print('[ERRO] Sem conexão com o Telegram; nova tentativa em 15 min.');return 1
        return _incerto(marker,today)
    except Exception:
        return _incerto(marker,today)

def _incerto(marker,today):
    # Timeout pode ter ocorrido após entrega. Preservar marcador evita duplicar silenciosamente.
    marker.write_text(json.dumps({'estado':'confirmacao_indisponivel','data':today.isoformat()}),encoding='utf-8')
    print('[ERRO] Não foi possível confirmar a entrega. Confira o Telegram antes de repetir.');return 1

if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,ValueError,TypeError):print('[ERRO] Não foi possível ler a configuração local.');sys.exit(1)
