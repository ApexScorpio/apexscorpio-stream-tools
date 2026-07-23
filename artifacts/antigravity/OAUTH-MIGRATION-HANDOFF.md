# Handoff — Migração OAuth YouTube para Modern Netlify Functions

Última atualização UTC: 2026-07-23T20:16:41Z

## Como retomar numa nova conversa

Ler este ficheiro na branch:

fix/migrate-oauth-to-modern-netlify-functions

Depois ler:

artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v6-inline-dependencies/summary.json

artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v6-inline-dependencies/probes.json

artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v6-inline-dependencies/tests.txt

## Objetivo final

Colocar o OAuth oficial do YouTube totalmente funcional na Netlify:

- Modern Netlify Functions.
- Netlify Blobs sem tokens ou site IDs manuais.
- Refresh token cifrado.
- Uma única autorização administrativa.
- Sem localhost ou ficheiros .env locais.
- Sem credenciais no GitHub.
- /youtube-status com OAuth e fallback multifonte.
- Viewers desconhecidos representados por null ou —.
- Rotação das credenciais expostas apenas depois da confirmação funcional.

## Projeto

- Repositório: ApexScorpio/apexscorpio-stream-tools
- Branch: fix/migrate-oauth-to-modern-netlify-functions
- Base master: 962fe9f295788786981a8b784dc3d1883f557ed9
- Netlify Project ID: 76ea2513-2651-4965-8241-a40070af3502
- Produção: https://apexscorpio-youtube-scraper-6e2678f9.netlify.app
- Head antes deste passo: d2610a6180e0c88e914b429a79fa2d890403f783
- Relatório mais recente: artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v6-inline-dependencies

## Estado atual

- Testes: exit code 0
- Deploy preview: exit code 0
- Deploy ID: 6a6276bd8868869463abcda4
- Deploy URL: https://6a6276bd8868869463abcda4--apexscorpio-youtube-scraper-6e2678f9.netlify.app
- Netlify Blobs no runtime moderno: confirmado
- Bundler: esbuild
- Dependências incorporadas no bundle: @netlify/blobs e axios
- Gate das Functions modernas: NÃO APROVADO
- Progresso atual: 98,9%
- Erro operacional:

### Probes

- youtube-status-direct: HTTP 502
- youtube-status-redirect: HTTP 502
- oauth-start-direct: HTTP 502
- oauth-start-redirect: HTTP 502
- oauth-callback-direct: HTTP 502
- oauth-callback-redirect: HTTP 502

## Trabalho concluído

- OAuth protegido por palavra-passe e rate limit.
- State HMAC e PKCE S256.
- Cookie HttpOnly, Secure e SameSite.
- Refresh token cifrado com AES-256-GCM.
- Validação do canal esperado.
- Ativação versionada token-v-*.
- Segunda autorização bloqueada.
- Network guard nos testes.
- connectLambda removido.
- 60/60 testes aprovados anteriormente.
- Netlify Blobs CRUD confirmado no runtime moderno.
- Handlers locais incluídos no bundle através de imports estáticos.
- Empacotamento esbuild ativado.
- axios e @netlify/blobs configurados como módulos externos.
- Leituras Blobs migradas de getJSON para get com type json.

## O que falta fazer

1. Ler summary.json, probes.json e tests.txt deste relatório.
2. Corrigir o erro exato indicado.
3. Repetir o deploy preview.
4. Não fazer merge nem deploy de produção antes do gate aprovado.
5. Depois: merge, produção, autorização OAuth e validação dos Blobs.
6. Rodar credenciais apenas depois dos 100% funcionais.

## Regras de segurança

- Nunca imprimir tokens ou credenciais.
- Nunca usar tokens ou site IDs manuais dentro das Functions.
- Nunca iniciar a autorização Google automaticamente.
- Nunca fazer deploy de produção antes do preview aprovado.
- Atualizar este ficheiro em todos os passos.
- Cada passo deve produzir relatório, commit e confirmação do SHA remoto.

## Log cronológico

- 2026-07-23: OAuth seguro integrado em master.
- 2026-07-23: produção continuava com HTTP 500 no início OAuth.
- 2026-07-23: iniciada migração para Modern Netlify Functions.
- 2026-07-23: connectLambda removido.
- 2026-07-23: testes atualizados para handlers internos.
- 2026-07-23: caminho interno do oauth-helpers corrigido.
- 2026-07-23: 60/60 testes aprovados.
- 2026-07-23: preview v1 falhou devido a getJSON e wrappers.
- 2026-07-23: preview v2 confirmou Blobs CRUD.
- 2026-07-23: preview v2 revelou handlers ausentes do bundle por createRequire.
- 2026-07-23: preview v3 incluiu os handlers, mas faltavam axios e @netlify/blobs no artefacto.
- 2026-07-23T19:28:13Z: preview v4 executado; testes=1; sintaxe=0; deploy=-1; gate=NÃO APROVADO; deployId=.
- 2026-07-23T19:40:05Z: mock do teste 27 corrigido para store.get com type json; testes=1; deploy não executado; relatório=artifacts/antigravity/manual-modern-functions-migration/test-27-mock-recovery.
- 2026-07-23T19:53:20Z: verificação do upload v5-final=NÃO APROVADA; SHA local/remoto iguais=True; summary remoto=False; probes remotos=False; correção AES=False; relatório=artifacts/antigravity/manual-modern-functions-migration/remote-state-verification.

- 2026-07-23T20:04:44Z: correção AES-GCM aplicada; testes=0; deploy=0; gate=NÃO APROVADO; deployId=6a6273f1508e4303f204d30f; relatório=artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v5-final.

- 2026-07-23T20:16:41Z: external_node_modules removido para permitir incorporação de axios e @netlify/blobs pelo esbuild; testes=0; deploy=0; gate=NÃO APROVADO; deployId=6a6276bd8868869463abcda4; relatório=artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v6-inline-dependencies.
