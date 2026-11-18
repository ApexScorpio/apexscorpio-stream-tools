const fs = require('fs');
const path = require('path');
const { createReader } = require('../facebook-live');

const TOKEN_PATHS = [
  path.join(__dirname, '..', 'facebook_token.txt'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mediamtx', 'facebook_token.txt')
];

class FacebookService {
  constructor(pageId = '111315703596465', onChatMessage, onStatusUpdate, onNewEvent) {
    this.pageId = pageId;
    this.onChatMessage = onChatMessage;
    this.onStatusUpdate = onStatusUpdate;
    this.onNewEvent = onNewEvent;

    this.token = null;
    this.reader = null;
    this.isLive = false;
    this.viewers = 0;
  }

  loadToken() {
    // 1. Check environment variable
    if (process.env.FACEBOOK_PAGE_TOKEN && process.env.FACEBOOK_PAGE_TOKEN.trim()) {
      return process.env.FACEBOOK_PAGE_TOKEN.trim();
    }

    // 2. Check token text files
    for (const p of TOKEN_PATHS) {
      try {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf8').trim();
          if (content && !content.startsWith('FB-') && content.length > 20) {
            return content;
          }
        }
      } catch (e) {}
    }

    return null;
  }

  start() {
    this.token = this.loadToken();

    this.reader = createReader({
      emit: (type, payload) => {
        if (type === 'chat_message' && this.onChatMessage) {
          this.onChatMessage(payload);
        } else if (type === 'facebook_status' && this.onStatusUpdate) {
          if (payload.status !== 'unavailable' || !this.isLive) {
            this.isLive = Boolean(payload.isLive);
          }
          if (payload.viewers !== null && payload.viewers !== undefined) {
            this.viewers = payload.viewers;
          }
          this.onStatusUpdate({
            platform: 'facebook',
            isLive: this.isLive,
            viewers: this.viewers,
            status: payload.status
          });
        } else if (type === 'new_event' && this.onNewEvent) {
          this.onNewEvent(payload);
        }
      },
      report: (msg) => {
        console.log(`[Facebook Live] ${msg}`);
      }
    });

    if (this.token) {
      console.log(`[Facebook] Iniciar leitura automatica para a pagina ${this.pageId}...`);
      try {
        this.reader.start(this.token);
      } catch (err) {
        console.error(`[Facebook Error] ${err.message}`);
      }
    } else {
      console.log(`[Facebook] Sem Page Access Token configurado. Para ativar leitura de chat/views em tempo real, insere o token no painel web ou em facebook_token.txt.`);
      if (this.onStatusUpdate) {
        this.onStatusUpdate({
          platform: 'facebook',
          isLive: false,
          viewers: 0
        });
      }
    }
  }

  setToken(newToken) {
    if (!newToken || !newToken.trim()) return;
    this.token = newToken.trim();

    // Persist to local token file
    try {
      fs.writeFileSync(TOKEN_PATHS[0], this.token, 'utf8');
      console.log(`[Facebook] Token guardado com sucesso em ${TOKEN_PATHS[0]}`);
    } catch (e) {
      console.error(`[Facebook Save Token Error] ${e.message}`);
    }

    if (this.reader) {
      this.reader.stop();
      this.reader.start(this.token);
    }
  }

  stop() {
    if (this.reader) {
      this.reader.stop();
    }
  }
}

module.exports = FacebookService;
