# ApexScorpio Stream Tools — Regras do Projeto

## ⚠️ REGRA CRÍTICA — SEM LOCALHOST (GOLDEN RULE)
- **NUNCA** usar `localhost`, `127.0.0.1`, `node server.js` ou qualquer servidor local neste projeto.
- Todos os URLs das sources, overlays e links devem ser **exclusivamente públicos** via GitHub Pages:
  - Base: `https://apexscorpio.github.io/apexscorpio-stream-tools/`
- O projeto corre **100% estático no GitHub Pages**. Não há backend local.
- Qualquer referência a `http://localhost:3000`, `node server.js` ou `/api/...` foi totalmente removida.

## Arquitetura de Comunicação Dashboard ↔ SLOBS
1. **Parâmetros de URL (Garantia Absoluta)**:
   - Todas as definições alteradas no Dashboard são codificadas no URL da fonte (ex.: `viewers.html?tw=1&yt=1&bg=1&ly=horizontal`).
   - Ao colar o URL no SLOBS como Browser Source, o overlay lê os parâmetros diretamente no arranque (`URLSearchParams`).

2. **Sincronização Cloud WSS em Tempo Real**:
   - Comunicação remota instantânea entre o Dashboard (Chrome) e o SLOBS via broker público MQTT/WSS (`wss://broker.emqx.io:8084/mqtt`).
   - Não requer instalação, nem servidores locais, nem portas abertas. Funciona 100% via HTTPS/WSS público.

3. **Fallbacks Locais**:
   - `BroadcastChannel('apex_scorpio_stream_tools')` e `localStorage` funcionam se o Dashboard for aberto no próprio SLOBS.

## Deduplicação de Eventos
- Todos os overlays (chat.html, events.html, alerts.html, viewers.html) usam um Set `recentIds` para evitar processar o mesmo evento mais de uma vez.
