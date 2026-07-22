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
    const chId = await resolveChannelId();
    if (!chId) { isLive = false; viewers = 0; liveChatId = null; global.ytLiveState = { isLive, viewers, videoId: null, liveChatId: null }; return; }
    try {
      const s = await apiGet(`https://www.googleapis.com/youtube/v3/search?part=id&channelId=${chId}&eventType=live&type=video&key=${YT_API_KEY}`);
      if (!s?.items?.length) { isLive = false; viewers = 0; liveChatId = null; liveVideoId = null; global.ytLiveState = { isLive, viewers, videoId: null, liveChatId: null }; return; }
      liveVideoId = s.items[0].id.videoId;
      const v = await apiGet(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${liveVideoId}&key=${YT_API_KEY}`);
      const lsd = v?.items?.[0]?.liveStreamingDetails;
      if (lsd) { viewers = parseInt(lsd.concurrentViewers || '0', 10); liveChatId = lsd.activeLiveChatId || null; isLive = true; }
      else { isLive = false; viewers = 0; liveChatId = null; }
    } catch(e) {}
    global.ytLiveState = { isLive, viewers, videoId: liveVideoId, liveChatId };
  }

  const seenIds = new Set();

  async function pollChat(onMsg, onEvt) {
    if (!liveChatId) return;
    try {
      let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}&part=snippet,authorDetails&maxResults=200&key=${YT_API_KEY}`;
      if (chatPageToken) url += `&pageToken=${chatPageToken}`;
      const d = await apiGet(url);
      chatPageToken = d.nextPageToken || chatPageToken;
      const pollMs = d.pollingIntervalMillis || 5000;
      (d.items || []).forEach(item => {
        if (seenIds.has(item.id)) return;
        seenIds.add(item.id);
        const snip = item.snippet || {}, auth = item.authorDetails || {}, t = snip.type;
        if (t === 'textMessageEvent' && onMsg) onMsg({ id: item.id, platform: 'youtube', username: auth.displayName || 'Viewer', userColor: '#E8181F', message: snip.textMessageDetails?.messageText || '', badges: { broadcaster: !!auth.isChatOwner, mod: !!auth.isChatModerator, subscriber: !!auth.isChatSponsor }, isTest: false, timestamp: snip.publishedAt });
        if (t === 'superChatEvent' && onEvt) onEvt({ id: item.id, type: 'superchat', platform: 'youtube', username: auth.displayName || 'Viewer', amount: (snip.superChatDetails || {}).amountDisplayString || '', isTest: false, timestamp: snip.publishedAt });
        if ((t === 'newSponsorEvent' || t === 'memberMilestoneChatEvent') && onEvt) onEvt({ id: item.id, type: 'subscriber', platform: 'youtube', username: auth.displayName || 'Viewer', isTest: false, timestamp: snip.publishedAt });
      });
      if (chatPollTimer) clearTimeout(chatPollTimer);
      chatPollTimer = setTimeout(() => pollChat(onMsg, onEvt), pollMs);
    } catch(e) {
      if (chatPollTimer) clearTimeout(chatPollTimer);
      chatPollTimer = setTimeout(() => pollChat(onMsg, onEvt), 10000);
    }
  }

  global.YoutubeLive = {
    resolveLiveDetails,
    async startChat(onMsg, onEvt) {
      await resolveLiveDetails();
      if (!liveChatId) return;
      chatPageToken = null;
      pollChat(onMsg, onEvt);
    },
    stopChat() { if (chatPollTimer) clearTimeout(chatPollTimer); chatPollTimer = null; }
  };
})(window);
