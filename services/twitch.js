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
      // Query Twitch public GQL endpoint for live metadata using ChannelShell query
      const gqlQuery = [
        {
          operationName: "ChannelShell",
          query: `query ChannelShell($login: String!) {
            user(login: $login) {
              id
              login
              displayName
              stream {
                id
                viewersCount
                type
              }
            }
          }`,
          variables: { login: this.channel }
        }
      ];

      const response = await axios.post('https://gql.twitch.tv/gql', gqlQuery, {
        headers: {
          'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', // Active Twitch web client ID
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      const user = response.data?.[0]?.data?.user;
      const stream = user?.stream;

      if (stream && stream.type === 'live') {
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
      console.error('[Twitch Status Check Error]', err.message);
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
