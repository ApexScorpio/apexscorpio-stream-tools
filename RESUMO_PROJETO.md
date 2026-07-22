# 🚀 RESUMO DO PROJETO - APEXSCORPIO STREAM TOOLS

## 🌟 Regra de Ouro (Zero Localhost / 100% Público & HTTPS)
- **TODOS** os overlays e o Dashboard funcionam **100% online e estáticos no GitHub Pages**: `https://apexscorpio.github.io/apexscorpio-stream-tools/`
- **Sincronização Cloud sem Backend Local**: Os overlays em Browser Source no Streamlabs OBS comunicam via canal público WSS MQTT (`wss://broker.emqx.io:8084/mqtt`), BroadcastChannel e LocalStorage.
- **URLs Fixos no Streamlabs OBS**:
  - Central: `https://apexscorpio.github.io/apexscorpio-stream-tools/index.html`
  - Viewers: `https://apexscorpio.github.io/apexscorpio-stream-tools/viewers.html`
  - Chat: `https://apexscorpio.github.io/apexscorpio-stream-tools/chat.html`
  - Event List: `https://apexscorpio.github.io/apexscorpio-stream-tools/events.html`
  - Alert Box: `https://apexscorpio.github.io/apexscorpio-stream-tools/alerts.html`

## 🚀 Funcionalidade de Testes Temporários e Auto-Reversão (8 Segundos):
- **Testes Temporários em TODOS os Overlays**:
  1. **📊 Contador de Viewers**: Clica em "Simular Live" -> Conta 50 Twitch / 120 YT / 35 FB durante **8 segundos** com temporizador visual no botão, revertendo automaticamente para os valores reais da live.
  2. **💬 Chat Unificado**: Clica num botão de Chat de Teste -> Mensagem de teste é exibida e **desaparece automaticamente após 8 segundos**.
  3. **📋 Event List**: Clica num evento de teste -> Entrada de teste surge com logótipo SVG e **desaparece automaticamente após 8 segundos**.
  4. **🔔 Alert Box**: Alerta surge no ecrã com som e clipart do Brandkit e desaparece após a duração definida (5s).
- **Botões Dedicados de Limpeza (🛑 Terminar / Limpar Teste)**:
  - Permitem ao utilizador interromper instantaneamente qualquer teste sem ter de esperar pelos 8 segundos.
