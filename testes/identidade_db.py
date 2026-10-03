"""Identidades em banco temporário. Nenhuma operação ou associação real."""
import sys, tempfile, unittest, json, sqlite3, os, shutil
from contextlib import closing
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import db, dados_identidade as I

class Identities(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.old=db.DB_PATH;db.DB_PATH=str(Path(self.t.name)/'teste.db');db.init()
 def tearDown(self): db.DB_PATH=self.old;self.t.cleanup()
 def op(self,house='p2',order='21100000000000000001',value=10,**kw):
  return db.add_operacao(dict(casa=house,conta='123',numero_pedido=order,tipo='deposito',valor=value,origem='fixture',**kw))
 def mother(self,house='gaita',mother='777'):
  return db.set_agente(dict(casa=house,tipo='agente_info',fonte='info',conta_mae=mother,membros_qtd=1,host='p2-gaitapg.com'))
 def prepare(self):
  x=db.estado_snapshot()['identidades']['por_chave'];return I.prepare(dict(origem=x['p2'],destino=x['gaita']))
 def association(self):
  p=self.prepare();return I.associate({**p,'confirmado':True})
 def test_legacy_replay_metadata_not_new_finance(self):
  self.op();self.assertEqual(self.op(host='www.p2-gaitapg.com')['status'],'duplicado')
  x=db.estado_snapshot();self.assertEqual(x['resumo']['total_depositos'],10);self.assertEqual(len(x['operacoes']),1)
  self.assertEqual(x['identidades']['casas'][0]['origens'][0]['host'],'p2-gaitapg.com')
 def test_same_host_candidate_never_automerged(self):
  self.op(host='p2-gaitapg.com');self.mother();s=db.estado_snapshot()
  self.assertNotEqual(s['identidades']['por_chave']['p2'],s['identidades']['por_chave']['gaita'])
  self.assertEqual(len(s['identidades']['candidatos']),1);self.assertNotIn('p2',s['mapeamento_filha_mae'])
 def test_partial_host_overlap_same_network_not_proposed(self):
  # Mesma REDE (p1), plataformas DIFERENTES: um blob legado com vários domínios de lançamento e
  # uma casa com só um deles NÃO podem virar sugestão de junção (casinha != forno). Só domínio
  # em comum não basta — exige conjunto de domínios IDÊNTICO (mesma plataforma).
  self.op(house='p1',order='21100000000000000010',host='p1-fornopg.com')
  self.op(house='p1',order='21100000000000000011',host='p1-casinhapg.com')
  self.op(house='p1',order='21100000000000000012',host='p1-assinarpg.com')
  self.op(house='casinha',order='21100000000000000013',host='p1-casinhapg.com')
  s=db.estado_snapshot()['identidades']
  self.assertEqual([k for k in s['candidatos'] if k.get('hosts')],[],'overlap parcial de domínio da mesma rede não pode virar sugestão de junção')
 def test_same_mother_number_in_other_house_is_not_identity(self):
  self.mother('a');self.mother('b');s=db.estado_snapshot()['identidades'];self.assertEqual(len(set(s['por_chave'].values())),2)
 def test_associate_backup_undo_and_money_preserved(self):
  self.op(host='p2-gaitapg.com');self.mother();before=db.estado_snapshot()['operacoes'];db.set_foco(['gaita'])
  x=self.association();self.assertEqual(x['status'],'ok',x)
  backup=Path(self.t.name)/'_backups'/x['backup'];self.assertTrue(backup.exists())
  with closing(sqlite3.connect(backup)) as c:self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
  self.assertEqual(db.estado_snapshot()['mapeamento_filha_mae']['p2'],'gaita')
  self.assertEqual(db.foco_lista(),['gaita','p2']);self.assertEqual(db.estado_snapshot()['operacoes'],before)
  self.assertEqual(I.undo({'id':x['associacao_id']})['status'],'ok');self.assertEqual(db.foco_lista(),['gaita'])
  self.assertNotIn('p2',db.estado_snapshot()['mapeamento_filha_mae']);self.assertEqual(db.estado_snapshot()['operacoes'],before)
 def test_confirmation_and_stale_preview_required(self):
  self.op();self.mother();p=self.prepare();self.assertEqual(I.associate(p)['status'],'erro')
  self.op(order='new');self.assertEqual(I.associate({**p,'confirmado':True})['codigo'],'conflito')
  self.assertEqual(len(set(db.estado_snapshot()['identidades']['por_chave'].values())),2)
 def test_duplicate_real_order_across_keys_blocks_merge(self):
  self.op();self.op(house='gaita');self.mother();p=self.prepare();self.assertTrue(p['conflitos'])
  self.assertEqual(I.associate({**p,'confirmado':True})['status'],'erro');self.assertEqual(db.resumo()['total_depositos'],20)
 def test_closed_focus_contradiction_preserved(self):
  self.op();self.mother();db.set_encerrada('p2');db.set_foco(['gaita']);self.assertTrue(self.prepare()['conflitos'])
  self.assertEqual(db.encerradas_lista(),['p2']);self.assertEqual(db.foco_lista(),['gaita'])
 def test_labels_and_registry_in_valid_backup(self):
  self.op();I.rename({'chave':'p2','nome':'Casa de teste'})
  bank=db.exportar();result=db.validar_restore(bank)
  self.assertNotEqual(result.get('status'),'erro',result)
  self.assertEqual(db.estado_snapshot()['identidades']['apelidos']['p2'],'Casa de teste')
 def test_bad_host_ignored_without_rejecting_money(self):
  self.assertEqual(self.op(host='example.com/?token=SECRET')['status'],'ok')
  self.assertEqual(db.estado_snapshot()['identidades']['casas'][0]['origens'],[])
 def test_multiple_mothers_disable_global_mapping(self):
  self.op();self.mother();self.association();self.mother(mother='888')
  self.assertNotIn('p2',db.estado_snapshot()['mapeamento_filha_mae'])
 def test_pending_collision_reviewer_regression(self):
  self.op();self.mother()
  for house in ('p2','gaita'):
   self.assertEqual(db.add_pedido(dict(casa=house,conta='123',numero_pedido='pending',tipo='saque',valor=8,estado='processando'))['status'],'ok')
  self.assertTrue(self.prepare()['conflitos'])
 def test_confirmation_retry_does_not_create_second_backup(self):
  self.op();self.mother();p=self.prepare();a=I.associate({**p,'confirmado':True});b=I.associate({**p,'confirmado':True})
  self.assertEqual(a['status'],'ok');self.assertEqual(b['status'],'duplicado');self.assertEqual(a['associacao_id'],b['associacao_id'])
  self.assertEqual(len(list((Path(self.t.name)/'_backups').glob('*.sqlite3'))),1)
 def test_unrelated_new_key_does_not_stale_pair(self):
  self.op();self.mother();p=self.prepare();self.op(house='unrelated',order='unrelated')
  self.assertEqual(I.associate({**p,'confirmado':True})['status'],'ok')
 def test_ambiguous_legacy_key_not_comparable(self):
  self.op(host='a.example');self.op(order='second',host='b.example');self.mother();self.association()
  self.assertIn('p2',db.estado_snapshot()['identidades']['ambiguas']);self.assertNotIn('p2',db.estado_snapshot()['mapeamento_filha_mae'])
 def test_hostname_cross_runtime_parity(self):
  import subprocess
  samples=['WWW.P2-GAITAPG.COM','p2-gaitapg.com.','a.com..','exemplo.vip','exemplo1.vip','https://x.com/?token=no','a..com','user@a.com','a.com:80','a.com/path','éxample.com','xn--exmple-cua.com','']
  root=Path(__file__).resolve().parents[1]
  node=os.environ.get('AGENTUM_TEST_NODE') or shutil.which('node')
  self.assertIsNotNone(node,'Node necessário para testar paridade; configure AGENTUM_TEST_NODE')
  result=subprocess.check_output([node,'-e',"const h=require('./shared/origem.js').host;process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(h)))",json.dumps(samples)],cwd=root,text=True)
  self.assertEqual(json.loads(result),[I.hostname(x) for x in samples])

 # --- vinculo mae<->filha por conta compartilhada (12/09/2026) ---
 # A mae fica no host do relatorio e a filha no link com o nome, entao elas NUNCA compartilham
 # host e o sinal por host jamais as encontrava: p2 e d293m8n743s9cl ficavam como casas separadas
 # no painel. O que prova serem a mesma casa e a CONTA aparecer nos dois lados.
 def opc(self,house,account,order):
  return db.add_operacao(dict(casa=house,conta=account,numero_pedido=order,tipo='deposito',valor=10,origem='fixture'))
 def membros(self,house,accounts,mother='777'):
  return db.set_agente(dict(casa=house,tipo='agente_membros',fonte='membros',conta_mae=mother,
                            membros=[{'conta':a} for a in accounts],pagina=1,mais=False))
 def compartilhadas(self,s): return [k for k in s['candidatos'] if k.get('contas')]
 def test_shared_accounts_propose_mother_child_pair(self):
  for i,a in enumerate(('111','222','333')): self.opc('p2',a,'ordem%d'%i)
  self.membros('d293cloud',('111','222','333'))
  s=db.estado_snapshot()['identidades'];k=s['por_chave']
  self.assertNotEqual(k['p2'],k['d293cloud'])
  c=self.compartilhadas(s);self.assertEqual(len(c),1,c)
  self.assertEqual(c[0]['contas'],3);self.assertEqual(sorted(c[0]['chaves']),['d293cloud','p2'])
  # destino = a filha: o link com o nome legivel e o que sobrevive como nome da casa
  self.assertEqual(c[0]['destino'],k['p2']);self.assertEqual(c[0]['origem'],k['d293cloud'])
  self.assertEqual(c[0]['estado'],'requer_confirmacao')
 def test_shared_accounts_never_automerge(self):
  for i,a in enumerate(('111','222','333')): self.opc('p2',a,'ordem%d'%i)
  self.membros('d293cloud',('111','222','333'))
  s=db.estado_snapshot()
  self.assertNotIn('p2',s['mapeamento_filha_mae'])
  self.assertEqual(len(set(s['identidades']['por_chave'].values())),2)
 def test_single_shared_account_is_not_enough(self):
  self.opc('p2','111','ordem1');self.membros('d293cloud',('111',))
  self.assertEqual(self.compartilhadas(db.estado_snapshot()['identidades']),[])
 def test_ambiguous_shared_accounts_not_proposed(self):
  for i,a in enumerate(('111','222')): self.opc('p2',a,'ordem%d'%i)
  self.membros('maea',('111','222'));self.membros('maeb',('111','222'),mother='888')
  self.assertEqual(self.compartilhadas(db.estado_snapshot()['identidades']),[])

if __name__=='__main__':unittest.main()
