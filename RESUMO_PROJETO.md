# 🚀 RESUMO DO PROJETO - APEXSCORPIO STREAM TOOLS

**Data de Atualização:** 22 de Julho de 2026  
**Localização Local do Projeto:** `C:\Users\lopes\.gemini\antigravity-ide\scratch\apexscorpio-stream-tools`  
**Repositório Remoto (GitHub):** `https://github.com/ApexScorpio/apexscorpio-stream-tools.git`  
**Autenticação Git:** Concluída via GitHub CLI (`gh auth login`) na conta `ApexScorpio`.

---

## 🌐 ARQUITETURA 100% PÚBLICA & URLS LIMPOS (SEM LOCALHOST)

O projeto é **100% estático e hospedado no GitHub Pages**. Não necessita nem utiliza qualquer servidor local (`localhost` ou `node server.js`).

### 📋 Lista Definitiva de URLs Públicos e Limpos (Sem Parâmetros Exigidos):

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

1. **URLs Limpos e Fixos**:
   - Os URLs usados no SLOBS são sempre limpos (ex: `viewers.html`, `chat.html`), sem necessidade de parâmetros gigantes.

2. **Sincronização Cloud WSS com Mensagens Retidas (MQTT Retain)**:
   - Ao alterar qualquer opção no Dashboard (no Chrome), a configuração é publicada com **retenção** no servidor público Cloud WSS (`wss://broker.emqx.io:8084/mqtt`).
   - Quando o SLOBS abre ou reinicia qualquer fonte, liga-se ao servidor WSS e recebe imediatamente a última configuração guardada.
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
  git commit -m "Clean URLs with WSS MQTT Retained Config Cloud Sync"
  git push origin master
  git push origin master:gh-pages --force
  ```
