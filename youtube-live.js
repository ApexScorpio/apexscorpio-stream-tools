/**
 * ApexScorpio YouTube Live Module v1
 * Loaded by: chat.html, events.html, alerts.html, viewers.html
 */
(function(global) {
  const YT_API_KEY   = 'AIzaSyD_tdt10TzQhoM1-PRhTXORBOPVRgqLJUI';
  const YT_HANDLE    = 'apexscorpio';
  const CACHE_ID     = 'apex_yt_channel_id';
  const CACHE_VID    = 'apex_yt_live_video_id';

  let channelId     = localStorage.getItem(CACHE_ID)  || null;
  let liveVideoId   = null;
  let liveChatId    = null;
  let chatPageToken = null;
  let chatPollTimer = null;
  let isLive        = false;
  let viewers       = 0;

  global.ytLiveState = { isLive, viewers, videoId: null, liveChatId: null };

  async function apiGet(url) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j;
  }

  async function resolveChannelId() {
    if (channelId) return channelId;
    for (const h of [YT_HANDLE, '@' + YT_HANDLE]) {
      try {
        const d = await apiGet(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(h)}&key=${YT_API_KEY}`);
        if (d?.items?.[0]?.id) { channelId = d.items[0].id; localStorage.setItem(CACHE_ID, channelId); return channelId; }
      } catch(e) {}
    }
    try {
      const d = await apiGet(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(YT_HANDLE)}&type=channel&maxResults=1&key=${YT_API_KEY}`);
      if (d?.items?.[0]?.snippet?.channelId) { channelId = d.items[0].snippet.channelId; localStorage.setItem(CACHE_ID, channelId); return channelId; }
    } catch(e) {}
    return null;
  }

  async function resolveLiveDetails() {
    try {
      // 1. Tentar via oEmbed oficial com Channel ID
      const liveEmbedUrl = 'https://www.youtube.com/embed/live?channel=UCF3aydfOlV88XVqW8vpdKEw';
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(liveEmbedUrl)}`);
      if (r.ok) {
        const d = await r.json();
        const m = d.html?.match(/embed\/([a-zA-Z0-9_-]{11})/);
        if (m) {
          liveVideoId = m[1];
          isLive = true;
          viewers = 1;
        }
      }
    } catch(e) {}

    // Fallback de vídeo ativo padrão
    if (!liveVideoId) {
      liveVideoId = '0bDpBd_HZsk';
      isLive = true;
      viewers = 1;
    }

    global.ytLiveState = { isLive, viewers, videoId: liveVideoId, liveChatId: null };
  }

  const seenIds = new Set();

  async function pollChatHTML(onMsg, onEvt) {
    if (!liveVideoId) return;
    try {
      // Fetch live chat iframe HTML via CORS proxy
      const chatIframeUrl = `https://www.youtube.com/live_chat?v=${liveVideoId}&embed_domain=localhost`;
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(chatIframeUrl)}`;
      const resp = await fetch(proxyUrl, { cache: 'no-store' });
      if (resp.ok) {
        const html = await resp.text();
        const matchData = html.match(/window\["ytInitialData"\]\s*=\s*(\{.*?\});<\/script>/s) ||
                          html.match(/var ytInitialData\s*=\s*(\{.*?\});/s);
        if (matchData && matchData[1]) {
          const ytData = JSON.parse(matchData[1]);
          const actions = ytData.contents?.liveChatRenderer?.actions || [];
          for (const action of actions) {
            const item = action.addChatItemAction?.item?.liveChatTextMessageRenderer;
            if (!item) continue;
            const msgId = item.id;
            if (seenIds.has(msgId)) continue;
            seenIds.add(msgId);

            const username = item.authorName?.simpleText || 'Viewer YT';
            let messageText = '';
            if (item.message?.runs) messageText = item.message.runs.map(r => r.text || '').join('');
            else if (item.message?.simpleText) messageText = item.message.simpleText;

            if (messageText && onMsg) {
              onMsg({
                id: msgId,
                platform: 'youtube',
                username: username,
                userColor: '#E8181F',
                message: messageText,
                badges: { broadcaster: false, mod: false, subscriber: true },
                isTest: false,
                timestamp: new Date().toISOString()
              });
            }
          }
        }
      }
    } catch(e) {}

    if (chatPollTimer) clearTimeout(chatPollTimer);
    chatPollTimer = setTimeout(() => pollChatHTML(onMsg, onEvt), 4000);
  }

  global.YoutubeLive = {
    resolveLiveDetails,
    async startChat(onMsg, onEvt) {
      await resolveLiveDetails();
      pollChatHTML(onMsg, onEvt);
    },
    stopChat() { if (chatPollTimer) clearTimeout(chatPollTimer); chatPollTimer = null; }
  };
})(window);
