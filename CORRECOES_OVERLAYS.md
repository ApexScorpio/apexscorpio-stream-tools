# Correções de fiabilidade e emparelhamento

- Mensagens de chat são conteúdo: a palavra clear já não executa comandos.
- Erros HTTP/GraphQL da Twitch conservam o último estado válido e passam a indisponível quando expiram.
- Facebook mostra dados indisponíveis: não existe leitor real de chat/viewers Facebook nesta versão.
- O indicador do relay acompanha ligações e desconexões.
- O painel cria uma chave aleatória de 256 bits. Os URLs copiados incluem a chave no fragmento; volta a colá-los nas Browser Sources do Slobs. Não partilhar esses URLs.
- Mensagens MQTT usam AES-GCM com IV aleatório. Mensagens públicas, adulteradas ou de outra chave são descartadas.
- Configurações cloud usam um identificador privado derivado da chave; já não usam nomes públicos partilhados. O Worker existente suporta estes identificadores, sem servidor local.
- Abrir o painel noutro navegador exige os URLs com a mesma chave para controlar as mesmas sources. Não existem segredos fixos no frontend.

## Restream e Facebook

Existe código legado em services/relayer.js para encaminhar uma entrada de vídeo para Restream e Facebook. Não está ligado ao painel online, e não é executado pelo GitHub Pages. O encaminhamento de vídeo necessita de um serviço de relay/encoder independente; os overlays continuam sem servidor local. Nenhuma transmissão foi iniciada nestas correções.

A antiga chave Restream embutida foi retirada. Como esteve publicada no histórico, deve ser renovada na conta Restream antes de reutilizar esse relay.

## Validação

Suite existente e seis testes de regressão offline para limpeza de chat, erros Twitch, emparelhamento, encriptação, configurações privadas e carregamento das sources. As contagens reais exigem uma live para validação final.

## 2026-11-25 — YouTube bloqueado em offline por snapshot antigo
- A fonte /overlay-config devolvia offline de 22/11 enquanto /youtube-status identificava a live atual. viewers.js aceitava o primeiro booleano sem validar a data.
- Consultar /youtube-status primeiro; snapshots guardados só como último recurso público. Aceitar apenas observações com data válida, até 60 segundos de idade e sem retroceder relativamente ao estado já observado.
- Mensagens do painel sem data ou mais antigas não substituem a leitura atual. Sem confirmação, mostrar estado indisponível em vez de afirmar offline. Zero espectadores continua a ser uma live online.
- Atualizada versão do script para 5.3 nos dois HTML. Suite viewer-freshness integrada no comando test, com casos de snapshot antigo, indisponibilidade, fallback, zero e fim confirmado da live.
- Verificação real antes de publicação: navegador com código corrigido e backend público mostrou YouTube online, 1 espectador. 21 testes de fiabilidade e frescura passaram.
- A suite completa tem falhas preexistentes fora desta alteração: youtube-live-backend exige v4.6 mas os HTML atuais usam v4.7. Sem alterações às sessões ou autenticação.
