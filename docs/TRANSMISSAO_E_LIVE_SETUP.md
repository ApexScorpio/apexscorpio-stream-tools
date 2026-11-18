# Configuração Definitiva de Transmissão (Streamlabs, Relay, Restream, Facebook Live & Meta API)

Este documento descreve toda a arquitetura de transmissão e leitura em tempo real da live para a página **ApexScorpio**. Contém todas as chaves fixas, endpoints da API da Meta e o funcionamento do relay para consulta rápida quando estiveres no Desktop PC ou no portátil.

---

## 1. Visão Geral da Arquitetura

```
+-------------------------------------------------------------+
| Streamlabs OBS (LegionLPX ou Desktop PC)                    |
| - Destino RTMP: rtmp://127.0.0.1:1935/apex                  |
| - Chave de Stream: apex                                     |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
| ApexStreamRelay (Porta 17354) + MediaMTX (Porta 1935)       |
| Divide a stream de vídeo em 2 destinos paralelos (-c copy): |
|                                                             |
| 1. Restream (YouTube + Twitch)                              |
|    rtmp://live.restream.io/live/re_6344942_f58550f8fef50c6e |
|                                                             |
| 2. Facebook Live Ingest (Chave Persistente)                 |
|    rtmps://live-api-s.facebook.com:443/rtmp/FB-...          |
+-------------------------------------------------------------+
                               |
                               v (Live no ar na Meta)
+-------------------------------------------------------------+
| Sincronizador Automático de Live (tools/apex-stream-sync)    |
| - Porta: 17355                                              |
| - Consumo: 0% CPU (chamadas diretas via Meta Graph API)     |
| - Consulta https://graph.facebook.com/v27.0/                |
|   * Espetadores em direto (live_views)                      |
|   * Comentários em tempo real (/comments)                   |
|   * Reações em tempo real (/reactions)                      |
| - Cifra em AES-256-GCM e envia por MQTT                     |
|   (broker.emqx.io / broker.hivemq.com)                      |
| - Overlays do Streamlabs atualizam instantaneamente         |
| - Atualiza data/config.json com o link para partilhas       |
+-------------------------------------------------------------+
```

---

## 2. Chaves de Transmissão e Destinos (Broadcasting Ingest)

### A. Facebook Live (Chave Persistente - NUNCA MUDA)
- **Página**: ApexScorpio (`111315703596465`)
- **URL do Servidor**: `rtmps://live-api-s.facebook.com:443/rtmp/`
- **Chave Persistente Oficial**:
  ```text
  FB-1542526624352799-0-Ab5P5BUpGcq4zW3pejAQuDU9
  ```
- **Configuração no Facebook**: [Live Producer](https://www.facebook.com/Apexscorpio/live_producer) -> *Software de transmissão* -> *Definições avançadas* -> **"Chave de transmissão persistente" = ATIVADA**.
- **Ficheiro de Credenciais Local**: Gravado de forma segura no Windows DPAPI em `AppData\Local\ApexStreamRelay\credentials.dpapi`.

### B. Restream (YouTube + Twitch)
- **URL do Servidor**: `rtmp://live.restream.io/live/`
- **URL Completa com Chave**:
  ```text
  rtmp://live.restream.io/live/re_6344942_f58550f8fef50c6e6ba1
  ```

### C. Configuração no Streamlabs OBS
- No Streamlabs, em **Definições -> Transmissão**:
  - **Tipo de Stream**: Servidor de Streaming Personalizado (Custom Streaming Server)
  - **URL / Servidor**: `rtmp://127.0.0.1:1935/apex` (ou `rtmp://127.0.0.1:1935`)
  - **Chave de Stream**: `apex`
  - *(O Streamlabs não precisa de ter qualquer conta do Facebook ligada por OAuth; o envio é gerido localmente pelo relay sem expiração)*.

---

## 3. API Direta da Meta (Views, Chat e Eventos)

Criada no **Meta for Developers** para acesso direto sem intermediários e sem consumo de CPU.

- **Nome da Aplicação**: `Apex Scorpio Stream Hub`
- **ID da Aplicação (App ID)**: `1167406615816401`
- **ID da Página (Page ID)**: `111315703596465` (`ApexScorpio`)
- **Page Access Token (Permanente - `expires_at: 0`)**:
  ```text
  EAAQlwAik6NEBTHzty9XfmGAS8CNqKsNZAmANOZBIozOspyjNK3zbLoZC8c2SDHE6oHnZCQZAKS20HFWhRSMxFJ26KcCvIAHsqavAQDeKLl3m7Ib2XPgwlVoB1ZBhdG45d5gSlFmkPWhq3X3Bn92lcfFpyewz3ibLQlRhjjdZA88OmbGAeSXrpYXom2bGZCYiCGc3J9wZD
  ```
- **Permissões Concedidas**:
  - `pages_show_list`
  - `business_management`
  - `pages_read_engagement`
  - `pages_read_user_content`
  - `pages_manage_posts`
- **Endpoints Utilizados**:
  - **Deteção de Live / Espetadores**:
    `GET https://graph.facebook.com/v27.0/111315703596465/live_videos?fields=id,status,live_views,permalink_url`
  - **Comentários do Chat**:
    `GET https://graph.facebook.com/v27.0/{live_video_id}/comments?fields=id,from,message,created_time&order=reverse_chronological`
  - **Reações / Eventos**:
    `GET https://graph.facebook.com/v27.0/{live_video_id}/reactions?fields=id,name,type`

---

## 4. Sincronizador de Overlays (`tools/apex-stream-sync.cjs`)

O script `tools/apex-stream-sync.cjs` substitui a antiga recolha baseada em navegador Chromium headless por pedidos assíncronos leves à API da Meta.

- **Porta de Controlo / Lock**: `17355` (garante apenas uma instância ativa no PC).
- **Chave de Cifra AES-256-GCM das Overlays**:
  ```text
  3e19fffe64e19853612d0d34192f5603813a671e95d053e4613ae53bc4207f00
  ```
- **Brokers MQTT**:
  - `mqtt://broker.emqx.io:1883`
  - `mqtt://broker.hivemq.com:1883`
- **Tópicos MQTT Publicados**:
  - `apexscorpio/streamtools/v2/encrypted/events/facebook_status` (Live on/off e contagem de espetadores)
  - `apexscorpio/streamtools/v2/encrypted/events/chat_message` (Mensagens de chat)
  - `apexscorpio/streamtools/v2/encrypted/events/new_event` (Reações e eventos)
- **Notificação Cloudflare**: Atualiza automaticamente o worker `https://apexscorpio-stream-tools.scorpioapex.workers.dev/overlay-config?overlay=facebook-status`.
- **Notificação do Publicador**: Atualiza `platforms.facebook.link` nos ficheiros `config.json` e notifica `http://127.0.0.1:17353/api/config`.

---

## 5. Como Iniciar a Transmissão

1. **Abrir a Aplicação**:
   - Executar o atalho ou `pwsh -File iniciar-app.ps1`.
   - O Publicador (`http://127.0.0.1:17353`) e o Sincronizador (`tools/apex-stream-sync.cjs`) arrancam automaticamente.
2. **No Painel do Publicador**:
   - Clicar em **"Ir para ao vivo em todo o lado"**.
   - O painel arma o relay e inicia o Streamlabs OBS.
   - O vídeo começa a ser enviado para o Restream e para o Facebook em simultâneo.
   - Assim que o direto entra na página, as tuas overlays recebem os números de visualizadores e os comentários do chat sem atraso.
