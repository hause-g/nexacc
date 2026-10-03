# Arquitetura da NexAcc

Documentação da edição de demonstração e estudo. Os nomes internos `Agentum` e `agentum` foram preservados em módulos e identificadores; a identidade pública é NexAcc.

## Visão geral

```text
Páginas sintéticas do ambiente de testes
  filhateste.invalid + maeteste.invalid
  extensao/ + extensao_agente/ (Chromium MV3)
      página → content script → service worker
                                |
                       fila persistida + recibo
                                |
                                v
API HTTP local — servidor.py — 127.0.0.1:8765
      |
      +-- SQLite — db.py e dados_*.py
      +-- Interface — index.html e assets/
      +-- PWA — manifesto e service worker
      +-- Componentes internos preservados

Integrações opcionais presentes no código
      +-- Telegram — envio/consulta pela internet
      +-- CDN de imagens — requisição externa e cache local
```

## Camadas e dependências

- `servidor.py`: requisições HTTP, validação de origem e caminho, arquivos estáticos e API com bind de loopback.
- `db.py` e `dados_*.py`: persistência SQLite, contratos, migrações, identificação de eventos e backups.
- `index.html` e `assets/`: interface em HTML, CSS e JavaScript, organizada em módulos próprios.
- `extensao/` e `extensao_agente/`: eventos de fixtures. Os manifests restringem o alcance a `http://filhateste.invalid/*` e `http://maeteste.invalid/*`; o backend permitido é `http://127.0.0.1:8765`. O exportador de sessões não faz parte desta edição. Um namespace próprio de armazenamento evita importar filas anteriores.
- `shared/`: utilitários JavaScript. Rotinas criptográficas de exemplo não são uma biblioteca de segurança auditada.
- `testes/` e `run_tests.py`: testes Python/Node e executor que registra o resultado dos processos.
- `telegram/`: integração externa opcional. O token é uma credencial privada, mesmo quando guardado localmente.
- `motor_autospin.py` e `autospin/`: componentes históricos preservados. A API de início exige `dry_run: true`, a listagem de sessões reais devolve uma lista vazia e a sincronização externa é recusada. O supervisor de serviço externo foi retirado. Esta edição não documenta operação de contas nem automação de apostas.

O servidor utiliza biblioteca padrão, como `http.server` e `sqlite3`, mas **tem dependência externa**: `servidor.py` importa `motor_autospin.py`, que importa `requests` em nível global. O requisito está em `requirements.txt`.

Os testes de navegador dependem de Playwright e de um navegador instalado por ele. Node.js sozinho não supre essa dependência.

## Persistência e entrega

As operações de banco usam transações com `BEGIN IMMEDIATE`, commit e rollback. O modo WAL é configurado na conexão.

Eventos podem carregar `event_id` e `revision`. O servidor registra o recibo, compara o hash do conteúdo e pode devolver a resposta anterior para uma repetição. A extensão verifica a correspondência do recibo antes de considerar a entrega confirmada.

A fila usa armazenamento local da extensão. As escritas são serializadas e há novas tentativas após falhas, com atraso crescente. Esses mecanismos buscam reduzir duplicações e permitir recuperação; não garantem ausência de perda de dados.

## Interface, cache e backups

O manifesto descreve a apresentação PWA. O service worker mantém recursos da interface e exclui as rotas `/api/` do cache. O funcionamento completo ainda depende do servidor e dos dados locais.

A exportação de banco inclui hashes e contagens por tabela. O manifesto indica sua cobertura: um snapshot SQLite não representa, sozinho, o estado de todos os navegadores e filas. A restauração precisa de testes próprios.

## Comunicação e privacidade

O processo principal atende em loopback. Os dados principais ficam em SQLite e no armazenamento do navegador. Recursos opcionais acessam a internet: Telegram transmite mensagens e o servidor pode buscar imagens em CDN. A afirmação “nenhum dado sai da máquina” não se aplica ao conjunto do código.

Nesta edição, as extensões se limitam aos hosts reservados de fixtures e o exportador de sessões foi excluído. Os parsers ainda podem manipular campos de token sintéticos; isso não equivale a uma política geral de ausência de leitura de tokens. Use as extensões somente no ambiente de testes isolado.

Credenciais, bancos, capturas, backups e logs devem permanecer fora do repositório. Controles de origem, caminho e validação são mecanismos implementados, não uma certificação de segurança.

## Estado da validação

O executor `run_tests.py` seleciona atualmente 47 arquivos elegíveis, incluindo os dois novos arquivos de verificação da demonstração. Isso não prova que todos passam nem equivale ao número de casos de teste.

Na verificação parcial de 02/10/2026 passaram 54 casos Node (`demo_privacidade`, `captura_worker`, `captura_integracao`, `captura_browser`, `captura_parser`), 4 testes Python (`demo_limites`, `interface_backup_contract`) e 28 verificações de `mae_confiabilidade.js`. O arquivo `captura_browser.test.cjs` usa uma VM simulada, não um navegador real. A suíte completa, os testes em navegador real e a execução em Windows não foram verificados nesta revisão.

Há testes com banco temporário e testes de interface com API simulada. Relatórios de novas execuções devem registrar ambiente, comando, resultados e limitações.
