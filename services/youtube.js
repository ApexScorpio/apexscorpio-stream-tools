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
      let videoId = null;
      let isLive = false;
      let count = 0;

      // 1. Tentar primeiro com a API oficial do YouTube v3 (se tiver YOUTUBE_API_KEY no ambiente)
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        try {
          // Procurar live ativa no canal
          const searchRes = await axios.get(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${this.channelHandle.replace('@','')}&type=video&eventType=live&key=${apiKey}`);
          if (searchRes.data?.items?.length > 0) {
            videoId = searchRes.data.items[0].id.videoId;
            isLive = true;

            // Buscar viewers reais na API de estatísticas
            const statsRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`);
            const details = statsRes.data?.items?.[0]?.liveStreamingDetails;
            if (details && details.concurrentViewers) {
              count = parseInt(details.concurrentViewers, 10);
            }
          }
        } catch (apiErr) {
          console.error('[YouTube API Error - Falling back to Parallel DOM Scraping]', apiErr.message);
        }
      }

      // 2. Se a API não estiver disponível ou não retornar live, executar Processo Paralelo de Leitura DOM
      if (!isLive) {
        const targetUrl = `https://www.youtube.com/${this.channelHandle}/live`;
        const response = await axios.get(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9,pt-PT;q=0.8'
          },
          timeout: 10000
        });

        const html = response.data;
        const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})">/);
        videoId = canonicalMatch ? canonicalMatch[1] : null;

        const isUpcoming = html.includes('"isUpcoming":true');
        const isLiveNow = html.includes('"isLiveNow":true') || 
                          html.includes('"status":"LIVE"') || 
                          html.includes('watching now') || 
                          html.includes('a assistir') || 
                          html.includes('espectadores');
                          
        isLive = !isUpcoming && isLiveNow && (html.includes('"isLive":true') || html.includes('"isLiveContent":true'));

        if (videoId && isLive) {
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
        }
      }

      if (videoId && isLive) {
        this.isLive = true;
        this.viewers = count;
        
        if (this.activeVideoId !== videoId) {
          console.log(`[YouTube] Live stream detetada com sucesso! Video ID: ${videoId}`);
          this.activeVideoId = videoId;
          this.seenMessageIds.clear();
          this.startChatPolling();
        }
      } else {
        if (this.isLive) {
          console.log('[YouTube] Transmissão ao vivo terminada.');
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
