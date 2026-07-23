# Handoff — Migração OAuth YouTube para Modern Netlify Functions

Última atualização UTC: 2026-07-23T19:10:47Z

## Como retomar numa nova conversa

Ler este ficheiro na branch:

fix/migrate-oauth-to-modern-netlify-functions

Depois ler:

artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v3/summary.json

artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v3/probes.json

## Objetivo final

Colocar o OAuth oficial do YouTube totalmente funcional na Netlify, com:

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
- Head antes deste passo: 0189996970e06ac848839bdb46da02a06c1bb993
- Relatório mais recente: artifacts/antigravity/manual-modern-functions-migration/preview-modern-runtime-v3

## Estado atual

- Testes: exit code 0
- Sintaxe: exit code 0
- Deploy preview: exit code 0
- Deploy ID: 6a62674acaef50147cb8c7e9
- Deploy URL: https://6a62674acaef50147cb8c7e9--apexscorpio-youtube-scraper-6e2678f9.netlify.app
- Netlify Blobs no runtime moderno: confirmado no preview v2
- Gate das três Functions modernas: NÃO APROVADO
- Erro atual:

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
- Migração dos handlers para pasta interna.
- connectLambda removido.
- 60/60 testes aprovados anteriormente.
- Netlify Blobs CRUD confirmado no runtime moderno.
- Imports estáticos aplicados para inclusão dos handlers no bundle.

## O que falta fazer

1. Ler preview-modern-runtime-v3/summary.json e probes.json.
2. Corrigir o erro indicado no último preview.
3. Repetir o deploy preview.
4. Não fazer merge nem deploy de produção antes do gate ficar aprovado.
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
- 2026-07-23T19:10:47Z: preview v3 executado; testes=0; sintaxe=0; deploy=0; gate=NÃO APROVADO; deployId=6a62674acaef50147cb8c7e9.
