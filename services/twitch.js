const tmi = require('tmi.js');
const axios = require('axios');

class TwitchService {
  constructor(channelName, onChatMessage, onStatusUpdate) {
    this.channel = channelName.toLowerCase().replace('@', '');
    this.onChatMessage = onChatMessage;
    this.onStatusUpdate = onStatusUpdate;
    this.client = null;
    this.pollInterval = null;
    this.isLive = false;
    this.viewers = 0;
  }

  start() {
    console.log(`[Twitch] Starting service for channel: ${this.channel}`);

    // Initialize IRC chat client
    this.client = new tmi.Client({
      options: { debug: false },
      channels: [this.channel]
    });

    this.client.on('message', (target, tags, message, self) => {
      if (self) return;

      const chatPayload = {
        id: tags.id || `twitch-${Date.now()}-${Math.random()}`,
        platform: 'twitch',
        username: tags['display-name'] || tags.username,
        userColor: tags.color || '#9146FF',
        message: message,
        badges: {
          broadcaster: tags.badges && tags.badges.broadcaster === '1',
          subscriber: tags.badges && Boolean(tags.badges.subscriber),
          mod: tags.badges && tags.badges.moderator === '1',
        },
        timestamp: new Date().toISOString()
      };

      if (this.onChatMessage) {
        this.onChatMessage(chatPayload);
      }
    });

    this.client.connect().catch(err => {
      console.error('[Twitch Chat Error]', err.message);
    });

    // Start polling viewer count
    this.checkStatus();
    this.pollInterval = setInterval(() => this.checkStatus(), 20000);
  }

  async checkStatus() {
    try {
      // Query Twitch public GQL endpoint for live metadata
      const gqlQuery = [
        {
          operationName: "StreamMetadata",
          variables: { channelLogin: this.channel },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: "1c715dbd7342244de34714d07940a2d73c704a73f0598a76b069d2d46e2709e9"
            }
          }
        }
      ];

      const response = await axios.post('https://gql.twitch.tv/gql', gqlQuery, {
        headers: {
          'Client-ID': 'kimne78kx3ncx6br8ac4x563ca2409', // Twitch public web client ID
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      const user = response.data?.[0]?.data?.user;
      const stream = user?.stream;

      if (stream) {
        this.isLive = true;
        this.viewers = stream.viewersCount || 0;
      } else {
        this.isLive = false;
        this.viewers = 0;
      }

      if (this.onStatusUpdate) {
        this.onStatusUpdate({
          platform: 'twitch',
          isLive: this.isLive,
          viewers: this.viewers
        });
      }
    } catch (err) {
      // Fallback fallback: scrape public channel page if GQL fails
      try {
        const pageRes = await axios.get(`https://www.twitch.tv/${this.channel}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: 5000
        });
        const html = pageRes.data;
        const isLive = html.includes('"isLiveBroadcast":true');
        this.isLive = isLive;
        if (!isLive) this.viewers = 0;
        
        if (this.onStatusUpdate) {
          this.onStatusUpdate({
            platform: 'twitch',
            isLive: this.isLive,
            viewers: this.viewers
          });
        }
      } catch (fallbackErr) {
        console.error('[Twitch Status Error]', err.message);
      }
    }
  }

  stop() {
    if (this.client) {
      this.client.disconnect();
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }
}

module.exports = TwitchService;
