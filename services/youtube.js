const axios = require('axios');
const cheerio = require('cheerio');

class YoutubeService {
  constructor(channelHandle, onChatMessage, onStatusUpdate) {
    this.channelHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
    this.onChatMessage = onChatMessage;
    this.onStatusUpdate = onStatusUpdate;

    this.activeVideoId = null;
    this.isLive = false;
    this.viewers = 0;
    
    this.pollInterval = null;
    this.chatContinuation = null;
    this.chatPollInterval = null;
    this.seenMessageIds = new Set();
  }

  start() {
    console.log(`[YouTube] Starting service for channel: ${this.channelHandle}`);
    this.checkStatus();
    this.pollInterval = setInterval(() => this.checkStatus(), 15000);
  }

  async checkStatus() {
    try {
      // 1. Fetch channel live URL: https://www.youtube.com/@apexscorpio/live
      const targetUrl = `https://www.youtube.com/${this.channelHandle}/live`;
      const response = await axios.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9,pt-PT;q=0.8'
        },
        timeout: 10000
      });

      const html = response.data;

      // Extract canonical video ID
      const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})">/);
      const videoId = canonicalMatch ? canonicalMatch[1] : null;

      // Check if video is TRULY live right now (not upcoming, scheduled, or past replay)
      const isUpcoming = html.includes('"isUpcoming":true');
      const isLiveNow = html.includes('"isLiveNow":true') || 
                        html.includes('"status":"LIVE"') || 
                        html.includes('watching now') || 
                        html.includes('a assistir') || 
                        html.includes('espectadores');
                        
      const isLiveMatch = !isUpcoming && isLiveNow && (html.includes('"isLive":true') || html.includes('"isLiveContent":true'));

      if (videoId && isLiveMatch) {
        this.isLive = true;
        
        if (this.activeVideoId !== videoId) {
          console.log(`[YouTube] Live stream detected! Video ID: ${videoId}`);
          this.activeVideoId = videoId;
          this.seenMessageIds.clear();
          this.startChatPolling();
        }

        // Extract viewer count from ytInitialData
        let count = 0;
        const viewerPatterns = [
          /"viewCount":\s*\{\s*"runs":\s*\[\s*\{\s*"text":\s*"([\d,\.\s]+)"/,
          /"shortViewCount":\s*\{\s*"runs":\s*\[\s*\{\s*"text":\s*"([\d,\.\s]+)"/,
          /"videoDetails":\s*\{[^}]*"viewCount":\s*"(\d+)"/,
          /([\d,\.]+)\s*(?:watching now|spectators|a assistir)/i
        ];

        for (const pattern of viewerPatterns) {
          const match = html.match(pattern);
          if (match && match[1]) {
            const rawStr = match[1].replace(/[^\d]/g, '');
            if (rawStr) {
              count = parseInt(rawStr, 10);
              break;
            }
          }
        }

        this.viewers = count;
      } else {
        // Fallback search check if /live redirect wasn't caught
        if (this.isLive) {
          console.log('[YouTube] Stream appears to have ended.');
        }
        this.isLive = false;
        this.viewers = 0;
        this.activeVideoId = null;
        this.stopChatPolling();
      }

      if (this.onStatusUpdate) {
        this.onStatusUpdate({
          platform: 'youtube',
          isLive: this.isLive,
          viewers: this.viewers,
          videoId: this.activeVideoId
        });
      }
    } catch (err) {
      console.error('[YouTube Status Check Error]', err.message);
    }
  }

  async startChatPolling() {
    this.stopChatPolling();
    if (!this.activeVideoId) return;

    console.log(`[YouTube Chat] Initializing chat listener for video ${this.activeVideoId}...`);
    this.chatPollInterval = setInterval(() => this.pollChatMessages(), 4000);
  }

  async pollChatMessages() {
    if (!this.activeVideoId || !this.isLive) return;

    try {
      // Fetch live chat iframe HTML to parse latest messages
      const chatUrl = `https://www.youtube.com/live_chat?v=${this.activeVideoId}&embed_domain=localhost`;
      const response = await axios.get(chatUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 5000
      });

      const html = response.data;
      
      // Extract ytInitialData from chat iframe
      const ytDataMatch = html.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});<\/script>/s) ||
                          html.match(/var ytInitialData\s*=\s*(\{.*?\});/s);

      if (ytDataMatch && ytDataMatch[1]) {
        const ytData = JSON.parse(ytDataMatch[1]);
        const actions = ytData.contents?.liveChatRenderer?.actions || [];

        for (const action of actions) {
          const item = action.addChatItemAction?.item?.liveChatTextMessageRenderer;
          if (!item) continue;

          const msgId = item.id;
          if (this.seenMessageIds.has(msgId)) continue;
          this.seenMessageIds.add(msgId);

          // Maintain set size
          if (this.seenMessageIds.size > 200) {
            const first = this.seenMessageIds.values().next().value;
            this.seenMessageIds.delete(first);
          }

          const username = item.authorName?.simpleText || 'YouTube Viewer';
          const userColor = '#FF0000'; // Default YouTube red accent

          // Extract message text
          let messageText = '';
          if (item.message?.runs) {
            messageText = item.message.runs.map(r => r.text || '').join('');
          } else if (item.message?.simpleText) {
            messageText = item.message.simpleText;
          }

          if (messageText && this.onChatMessage) {
            this.onChatMessage({
              id: msgId,
              platform: 'youtube',
              username: username,
              userColor: userColor,
              message: messageText,
              badges: {
                broadcaster: item.authorBadges?.some(b => b.liveChatAuthorBadgeRenderer?.tooltip?.includes('Owner') || b.liveChatAuthorBadgeRenderer?.tooltip?.includes('Proprietário')),
                mod: item.authorBadges?.some(b => b.liveChatAuthorBadgeRenderer?.tooltip?.includes('Moderator') || b.liveChatAuthorBadgeRenderer?.tooltip?.includes('Moderador')),
                subscriber: item.authorBadges?.some(b => b.liveChatAuthorBadgeRenderer?.tooltip?.includes('Member') || b.liveChatAuthorBadgeRenderer?.tooltip?.includes('Membro'))
              },
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch (err) {
      // Silently handle temporary chat fetch glitches
    }
  }

  stopChatPolling() {
    if (this.chatPollInterval) {
      clearInterval(this.chatPollInterval);
      this.chatPollInterval = null;
    }
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.stopChatPolling();
  }
}

module.exports = YoutubeService;
