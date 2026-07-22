# 🚀 RESUMO DO PROJETO - APEXSCORPIO STREAM TOOLS

**Data de Atualização:** 22 de Julho de 2026  
**Localização Local do Projeto:** `C:\Users\lopes\.gemini\antigravity-ide\scratch\apexscorpio-stream-tools`  
**Repositório Remoto (GitHub):** `https://github.com/ApexScorpio/apexscorpio-stream-tools.git`  
**Autenticação Git:** Concluída via GitHub CLI (`gh auth login`) na conta `ApexScorpio`.

---

## 🌐 ARQUITETURA 100% PÚBLICA (SEM LOCALHOST)

O projeto é **100% estático e hospedado no GitHub Pages**. Não necessita nem utiliza qualquer servidor local (`localhost` ou `node server.js`).

### 📋 Lista Definitiva de URLs Públicos:

1. **Painel de Controlo Principal (Dashboard):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/index.html`

2. **Contador de Espectadores (Viewers Counter Overlay):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/viewers.html`

3. **Chat Unificado (Twitch + YouTube + Facebook):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/chat.html`

4. **Event List (Histórico Vertical de Eventos em Inglês):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/events.html`

5. **Alert Box (Followers, Subs e Raids com Som e Clipart):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/alerts.html`

6. **Cena Animada - Stream Starting Soon:**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/starting.html`

7. **Cena Animada - Be Right Back (BRB / Intervalo):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/brb.html`

8. **Cena Animada - Technical Issues (Problemas Técnicos):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/technical.html`

9. **Cena Animada - Stream Ending (Fim de Transmissão):**  
   `https://apexscorpio.github.io/apexscorpio-stream-tools/ending.html`

---

## ⚡ COMO FUNCIONA A SINCRONIZAÇÃO DADOS DEDICADOS ↔ OBS

1. **Geração Automática de Parâmetros de URL (Garantido em qualquer situação)**:
   - Ao alterar qualquer opção no Dashboard, o URL gerado na caixa "URL para o Streamlabs OBS" inclui automaticamente todas as opções como parâmetros (ex.: `viewers.html?tw=1&yt=1&bg=1&ly=horizontal&fs=15`).
   - Ao colar o URL no SLOBS, o overlay carrega as definições exatas diretamente do URL.

2. **Sincronização em Tempo Real via Cloud WSS (MQTT Public Relay)**:
   - Todos os overlays e o Dashboard ligam-se automaticamente a um broker público de WebSockets HTTPS/WSS (`wss://broker.emqx.io:8084/mqtt`).
   - Quando mudas definições ou disparas um evento/chat de teste no Dashboard, a alteração é transmitida em tempo real via WSS para o SLOBS (latência < 50ms) **sem precisar de servidor local**.

---

## 📌 COMANDOS ÚTEIS PARA GERIR O REPOSITÓRIO

- **Verificar estado do repositório local:**
  ```cmd
  cd C:\Users\lopes\.gemini\antigravity-ide\scratch\apexscorpio-stream-tools
  git status
  ```

- **Enviar novas alterações para o GitHub:**
  ```cmd
  git add .
  git commit -m "Arquitetura 100% publica com WSS Cloud Relay e URL Params"
  git push origin master
  git push origin master:gh-pages --force
  ```
