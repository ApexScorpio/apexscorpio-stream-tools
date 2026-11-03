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
