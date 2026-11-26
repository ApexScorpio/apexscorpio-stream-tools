# Histórico — YouTube Video Player

## 2026-11-26 — Fase 1
- Inspecionados README.md, RESUMO_PROJETO.md, wrangler.jsonc e scripts/build-netlify-public.js antes de desenvolver.
- Criada branch isolada feature/youtube-player-light; master e serviços ativos intocados.
- Leitor HTML sem dependências locais, um iframe, API oficial, eventos de fim e erro, lista JSON online e política de referer explícita.
- Vídeo de demonstração da documentação oficial do YouTube; substituir após teste.
- Sem polling, backend adicional ou pré-carregamento de leitores. Reprodução real, consumo e erro 153 no SLOBS ainda não validados.
- Gestão inicial via JSON versionado; painel de edição autenticado e publicação ficam dependentes do teste.

## 2026-11-26 — Fase 2
- Consultada documentação oficial IFrame API: cuePlaylist, getPlaylist, eventos CUED e ENDED.
- Adicionada rotação de playlists, seleção aleatória, histórico de reprodução por playlist e cache de IDs em memória; um único iframe.
- Criado video-manager.html, sem leitor incorporado, com geração de URL partilhável e exportação JSON. O painel não escreve no GitHub nem guarda configuração na cloud automaticamente.
- Mantida configuração JSON para URL fixo. Sem playlists reais fornecidas; vídeo de demonstração mantido.
- Alterações apenas na branch isolada. Publicação, teste real de reprodução, screenshots e medição de recursos pendentes.
