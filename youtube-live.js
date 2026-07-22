/**
 * ApexScorpio YouTube Live Module v2.5
 *
 * Goals:
 * - Detect a new live immediately, including when YouTube changes the video ID.
 * - Keep a confirmed live online through temporary API/network failures.
 * - Use separate state and chat leaders to reduce duplicate API traffic.
 * - Poll search.list sparingly; use fast oEmbed retries and periodic playlist fallback.
 */
(function (global) {
  'use strict';

  const API_KEY = global.APEX_YOUTUBE_API_KEY || 'AIzaSyD_tdt10TzQhoM1-PRhTXORBOPVRgqLJUI';
  const CHANNEL_ID = 'UCF3aydfOlV88XVqW8vpdKEw';
  const CHANNEL_HANDLE = '@apexscorpio';
  const UPLOADS_PLAYLIST_ID = CHANNEL_ID.replace(/^UC/, 'UU');

  // Persistent state keys. Do not version these again.
  const STATE_KEY = 'apex_yt_live_state';
  const VIDEO_KEY = 'apex_yt_live_video_id';
  const LAST_SEARCH_KEY = 'apex_yt_last_search';
  const LAST_PLAYLIST_KEY = 'apex_yt_last_playlist';

  // Coordination keys isolated from older cached versions.
  const STATE_LEADER_KEY = 'apex_yt_state_leader2';
  const CHAT_LEADER_KEY = 'apex_yt_chat_leader2';
  const BUS_KEY = 'apex_yt_bus2';
  const CHANNEL_NAME = 'apex_youtube_live_bus2';

  const LEADER_TTL_MS = 20000;
  const LEADER_HEARTBEAT_MS = 5000;
  const LIVE_POLL_MS = 15000;
  const FAST_DISCOVERY_MS = 10000;
  const PLAYLIST_DISCOVERY_MS = 60000;
  const SEARCH_DISCOVERY_MS = 15 * 60 * 1000;
  const LIVE_ERROR_GRACE_MS = 60000;
  const MIN_CHAT_POLL_MS = 1000;
  const MAX_CHAT_POLL_MS = 15000;

  const instanceId = `yt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const bus = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

  const messageHandlers = new Set();
  const eventHandlers = new Set();
  const stateHandlers = new Set();
  const seenEnvelopeIds = new Set();
  const seenChatIds = new Set();
  const seenApiItemIds = new Set();

  let started = false;
  let stateLeader = false;
  let chatLeader = false;
  let stateLeaderTimer = null;
  let chatLeaderTimer = null;
  let stateTimer = null;
  let chatTimer = null;
  let activeVideoId = safeGet(VIDEO_KEY) || null;
  let activeChatId = null;
  let liveChatPageToken = null;
  let lastPositiveLiveAt = 0;
  let state = loadState();

  if (!activeVideoId && state.videoId) activeVideoId = state.videoId;
  if (state.isLive) lastPositiveLiveAt = Number(state.updatedAt || Date.now());

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function loadState() {
    try {
      const parsed = JSON.parse(safeGet(STATE_KEY) || 'null');
      if (parsed && typeof parsed === 'object') {
        return {
          isLive: Boolean(parsed.isLive),
          viewers: Math.max(0, Number(parsed.viewers || 0)),
          videoId: parsed.videoId || null,
          liveChatId: parsed.liveChatId || null,
          title: parsed.title || '',
          updatedAt: Number(parsed.updatedAt || 0),
          error: parsed.error || null,
          source: parsed.source || null
        };
      }
    } catch (_) {}

    return {
      isLive: false,
      viewers: 0,
      videoId: null,
      liveChatId: null,
      title: '',
      updatedAt: 0,
      error: null,
      source: null
    };
  }

  function publicState() {
    return { ...state };
  }

  function remember(set, id, ttlMs) {
    if (!id) return false;
    if (set.has(id)) return true;
    set.add(id);
    setTimeout(() => set.delete(id), ttlMs);
    return false;
  }

  function envelope(kind, payload) {
    return {
      id: `${instanceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: instanceId,
      kind,
      payload,
      timestamp: Date.now()
    };
  }

  function broadcast(kind, payload) {
    const packet = envelope(kind, payload);
    handleEnvelope(packet);
    if (bus) {
      try { bus.postMessage(packet); } catch (_) {}
    }
    safeSet(BUS_KEY, JSON.stringify(packet));
  }

  function applyIncomingState(payload) {
    const incomingUpdatedAt = Number(payload?.updatedAt || 0);
    if (state.updatedAt && incomingUpdatedAt && incomingUpdatedAt < state.updatedAt) return;

    state = {
      isLive: Boolean(payload?.isLive),
      viewers: Math.max(0, Number(payload?.viewers || 0)),
      videoId: payload?.videoId || null,
      liveChatId: payload?.liveChatId || null,
      title: payload?.title || '',
      updatedAt: incomingUpdatedAt || Date.now(),
      error: payload?.error || null,
      source: payload?.source || null
    };

    if (state.videoId) {
      activeVideoId = state.videoId;
      safeSet(VIDEO_KEY, state.videoId);
    }

    global.ytLiveState = publicState();
    stateHandlers.forEach(handler => {
      try { handler(publicState()); } catch (_) {}
    });

    if (messageHandlers.size || eventHandlers.size) ensureChatElection();
  }

  function handleEnvelope(packet) {
    if (!packet?.id || remember(seenEnvelopeIds, packet.id, 120000)) return;

    if (packet.kind === 'state' && packet.payload) {
      applyIncomingState(packet.payload);
      return;
    }

    if (packet.kind === 'chat' && packet.payload) {
      if (remember(seenChatIds, packet.payload.id, 10 * 60 * 1000)) return;
      messageHandlers.forEach(handler => {
        try { handler(packet.payload); } catch (_) {}
      });
      return;
    }

    if (packet.kind === 'event' && packet.payload) {
      const eventKey = `evt:${packet.payload.id}`;
      if (remember(seenChatIds, eventKey, 10 * 60 * 1000)) return;
      eventHandlers.forEach(handler => {
        try { handler(packet.payload); } catch (_) {}
      });
      return;
    }

    if (packet.kind === 'refresh' && stateLeader) {
      if (activeVideoId || state.videoId) refreshKnownVideo();
      else discoverLive(true);
    }
  }

  if (bus) bus.addEventListener('message', event => handleEnvelope(event.data));

  global.addEventListener('storage', event => {
    if (event.key !== BUS_KEY || !event.newValue) return;
    try { handleEnvelope(JSON.parse(event.newValue)); } catch (_) {}
  });

  async function apiGet(path, params) {
    const query = new URLSearchParams(params || {});
    query.set('key', API_KEY);

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/${path}?${query.toString()}`,
      { cache: 'no-store' }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      const error = new Error(data?.error?.message || `YouTube API ${response.status}`);
      error.status = response.status;
      error.reason = data?.error?.errors?.[0]?.reason || null;
      throw error;
    }

    return data;
  }

  function publishState(next) {
    state = {
      isLive: Boolean(next.isLive),
      viewers: Math.max(0, Number(next.viewers || 0)),
      videoId: next.videoId || null,
      liveChatId: next.liveChatId || null,
      title: next.title || '',
      updatedAt: Date.now(),
      error: next.error || null,
      source: next.source || null
    };

    global.ytLiveState = publicState();
    safeSet(STATE_KEY, JSON.stringify(state));

    if (state.videoId) {
      activeVideoId = state.videoId;
      safeSet(VIDEO_KEY, state.videoId);
    } else {
      safeRemove(VIDEO_KEY);
    }

    broadcast('state', state);
  }

  function publishLive(video, source) {
    const details = video?.liveStreamingDetails || {};
    const concurrent = details.concurrentViewers;
    lastPositiveLiveAt = Date.now();

    publishState({
      isLive: true,
      viewers: concurrent == null ? Number(state.viewers || 0) : Number(concurrent || 0),
      videoId: video.id,
      liveChatId: details.activeLiveChatId || null,
      title: video?.snippet?.title || state.title || '',
      error: null,
      source
    });

    scheduleState(LIVE_POLL_MS);
    ensureChatElection();
  }

  function publishOffline(error = null, source = null) {
    activeVideoId = null;
    activeChatId = null;
    liveChatPageToken = null;
    safeRemove(VIDEO_KEY);

    publishState({
      isLive: false,
      viewers: 0,
      videoId: null,
      liveChatId: null,
      title: '',
      error,
      source
    });

    scheduleState(FAST_DISCOVERY_MS);
  }

  function holdLiveOnFailure(error) {
    if (!state.isLive || !state.videoId) return false;
    const age = Date.now() - Number(lastPositiveLiveAt || state.updatedAt || 0);
    if (age > LIVE_ERROR_GRACE_MS) return false;

    publishState({
      ...state,
      isLive: true,
      videoId: state.videoId,
      error: error || null,
      source: state.source || 'cached-live'
    });
    scheduleState(FAST_DISCOVERY_MS);
    return true;
  }

  function isLiveVideo(video) {
    const details = video?.liveStreamingDetails;
    const content = video?.snippet?.liveBroadcastContent || 'none';
    if (!video || !details || details.actualEndTime) return false;
    return content === 'live' || Boolean(details.actualStartTime);
  }

  async function fetchVideo(videoId) {
    if (!videoId) return null;
    const data = await apiGet('videos', {
      part: 'snippet,liveStreamingDetails',
      id: videoId,
      maxResults: '1'
    });
    return data?.items?.[0] || null;
  }

  async function refreshKnownVideo() {
    if (!stateLeader) return;

    const videoId = activeVideoId || state.videoId;
    if (!videoId) {
      discoverLive(true);
      return;
    }

    try {
      const video = await fetchVideo(videoId);
      if (!stateLeader) return;

      if (isLiveVideo(video)) {
        activeVideoId = video.id;
        publishLive(video, 'known-video');
        return;
      }

      // The known broadcast ended, disappeared, or YouTube changed the video ID.
      // Do not wait 15 minutes: immediately discover the replacement live.
      activeVideoId = null;
      safeRemove(VIDEO_KEY);
      await discoverLive(true);
    } catch (error) {
      if (!stateLeader) return;
      if (!holdLiveOnFailure(error.message)) {
        await discoverLive(false, error.message);
      }
    }
  }

  async function discoverFromSearch() {
    const data = await apiGet('search', {
      part: 'snippet',
      channelId: CHANNEL_ID,
      eventType: 'live',
      type: 'video',
      maxResults: '5'
    });
    return (data?.items || [])
      .map(item => item?.id?.videoId)
      .filter(Boolean);
  }

  async function discoverFromPlaylist() {
    const playlist = await apiGet('playlistItems', {
      part: 'contentDetails,snippet',
      playlistId: UPLOADS_PLAYLIST_ID,
      maxResults: '15'
    });

    return [...new Set((playlist?.items || [])
      .map(item => item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId)
      .filter(Boolean))];
  }

  async function discoverFromOEmbed() {
    const candidates = [
      `https://www.youtube.com/channel/${CHANNEL_ID}/live`,
      `https://www.youtube.com/${CHANNEL_HANDLE}/live`
    ];

    for (const liveUrl of candidates) {
      try {
        const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(liveUrl)}`;
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json();
        const html = String(data?.html || '');
        const match = html.match(/youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/);
        if (match?.[1]) return [match[1]];
      } catch (_) {}
    }

    return [];
  }

  async function firstConfirmedLive(ids, source) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return null;

    const data = await apiGet('videos', {
      part: 'snippet,liveStreamingDetails',
      id: unique.slice(0, 50).join(','),
      maxResults: String(Math.min(unique.length, 50))
    });

    const live = (data?.items || []).find(isLiveVideo) || null;
    if (live) publishLive(live, source);
    return live;
  }

  function due(key, interval, force) {
    if (force) return true;
    const last = Number(safeGet(key) || 0);
    return !last || Date.now() - last >= interval;
  }

  async function discoverLive(forceSearch = false, inheritedError = null) {
    if (!stateLeader) return;

    let lastError = inheritedError || null;

    // Fast no-search discovery. This is safe to retry frequently.
    try {
      const oembedIds = await discoverFromOEmbed();
      if (!stateLeader) return;
      const live = await firstConfirmedLive(oembedIds, 'oembed');
      if (live) return;
    } catch (error) {
      lastError = error.message;
    }

    // Playlist fallback once per minute.
    if (due(LAST_PLAYLIST_KEY, PLAYLIST_DISCOVERY_MS, forceSearch)) {
      safeSet(LAST_PLAYLIST_KEY, String(Date.now()));
      try {
        const playlistIds = await discoverFromPlaylist();
        if (!stateLeader) return;
        const live = await firstConfirmedLive(playlistIds, 'uploads-playlist');
        if (live) return;
      } catch (error) {
        lastError = error.message;
      }
    }

    // Authoritative search on initial load, after an ended video, or every 15 min.
    if (due(LAST_SEARCH_KEY, SEARCH_DISCOVERY_MS, forceSearch)) {
      safeSet(LAST_SEARCH_KEY, String(Date.now()));
      try {
        const searchIds = await discoverFromSearch();
        if (!stateLeader) return;
        const live = await firstConfirmedLive(searchIds, 'search');
        if (live) return;
      } catch (error) {
        lastError = error.message;
      }
    }

    if (state.isLive && state.videoId && holdLiveOnFailure(lastError)) return;

    publishOffline(lastError, 'discovery');
  }

  function readLock(key) {
    try { return JSON.parse(safeGet(key) || 'null'); } catch (_) { return null; }
  }

  function writeLock(key) {
    const lock = { owner: instanceId, expiresAt: Date.now() + LEADER_TTL_MS };
    safeSet(key, JSON.stringify(lock));
    return readLock(key)?.owner === instanceId;
  }

  function releaseLock(key) {
    const lock = readLock(key);
    if (lock?.owner === instanceId) safeRemove(key);
  }

  function scheduleState(delay) {
    if (stateTimer) clearTimeout(stateTimer);
    if (!stateLeader) return;
    stateTimer = setTimeout(() => {
      if (activeVideoId || state.videoId) refreshKnownVideo();
      else discoverLive(false);
    }, delay);
  }

  function stopStateLeaderWork() {
    stateLeader = false;
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = null;
  }

  function becomeStateLeader() {
    if (stateLeader) return;
    stateLeader = true;
    activeVideoId = safeGet(VIDEO_KEY) || state.videoId || null;

    // Every fresh leader performs an authoritative discovery if no live ID is
    // known. This removes the previous 15-minute startup delay.
    if (activeVideoId) refreshKnownVideo();
    else discoverLive(true);
  }

  function electStateLeader() {
    const lock = readLock(STATE_LEADER_KEY);
    const now = Date.now();

    if (!lock || Number(lock.expiresAt || 0) <= now || lock.owner === instanceId) {
      if (writeLock(STATE_LEADER_KEY)) becomeStateLeader();
      else stopStateLeaderWork();
    } else if (stateLeader) {
      stopStateLeaderWork();
    }
  }

  function authorDetails(item) {
    const author = item?.authorDetails || {};
    return {
      username: author.displayName || 'Viewer YouTube',
      avatarUrl: author.profileImageUrl || '',
      badges: {
        broadcaster: Boolean(author.isChatOwner),
        mod: Boolean(author.isChatModerator),
        subscriber: Boolean(author.isChatSponsor)
      }
    };
  }

  function messageFromItem(item) {
    const snippet = item?.snippet || {};
    const author = authorDetails(item);
    const type = snippet.type || '';
    let text = snippet.displayMessage || snippet.textMessageDetails?.messageText || '';

    if (type === 'superChatEvent') {
      const paid = snippet.superChatDetails || {};
      text = [paid.amountDisplayString, paid.userComment || text].filter(Boolean).join(' · ');
    } else if (type === 'superStickerEvent') {
      const paid = snippet.superStickerDetails || {};
      text = [paid.amountDisplayString, paid.superStickerMetadata?.altText || text].filter(Boolean).join(' · ');
    } else if (type === 'memberMilestoneChatEvent') {
      const milestone = snippet.memberMilestoneChatDetails || {};
      text = [
        milestone.memberMonth ? `${milestone.memberMonth} meses como membro` : 'Mensagem de membro',
        milestone.userComment || text
      ].filter(Boolean).join(' · ');
    }

    if (!text) return null;

    return {
      id: item.id,
      platform: 'youtube',
      username: author.username,
      avatarUrl: author.avatarUrl,
      userColor: '#E8181F',
      message: text,
      badges: author.badges,
      isTest: false,
      timestamp: snippet.publishedAt || new Date().toISOString()
    };
  }

  function eventFromItem(item) {
    const snippet = item?.snippet || {};
    const author = authorDetails(item);
    const base = {
      id: item.id,
      platform: 'youtube',
      username: author.username,
      isTest: false,
      timestamp: snippet.publishedAt || new Date().toISOString()
    };

    if (snippet.type === 'newSponsorEvent') {
      return {
        ...base,
        type: 'subscriber',
        memberLevel: snippet.newSponsorDetails?.memberLevelName || ''
      };
    }

    if (snippet.type === 'membershipGiftingEvent') {
      return {
        ...base,
        type: 'gift_subscriber',
        giftCount: Number(snippet.membershipGiftingDetails?.giftMembershipsCount || 0)
      };
    }

    if (snippet.type === 'memberMilestoneChatEvent') {
      return {
        ...base,
        type: 'membership',
        months: Number(snippet.memberMilestoneChatDetails?.memberMonth || 0),
        message: snippet.memberMilestoneChatDetails?.userComment || ''
      };
    }

    if (snippet.type === 'superChatEvent') {
      const details = snippet.superChatDetails || {};
      return {
        ...base,
        type: 'donation',
        amount: details.amountDisplayString || '',
        amountMicros: Number(details.amountMicros || 0),
        currency: details.currency || '',
        message: details.userComment || ''
      };
    }

    if (snippet.type === 'superStickerEvent') {
      const details = snippet.superStickerDetails || {};
      return {
        ...base,
        type: 'donation',
        amount: details.amountDisplayString || '',
        amountMicros: Number(details.amountMicros || 0),
        currency: details.currency || '',
        message: details.superStickerMetadata?.altText || 'Super Sticker'
      };
    }

    return null;
  }

  function hasChatDemand() {
    return messageHandlers.size > 0 || eventHandlers.size > 0;
  }

  function stopChatLeaderWork() {
    chatLeader = false;
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = null;
    activeChatId = null;
    liveChatPageToken = null;
  }

  function becomeChatLeader() {
    if (chatLeader || !hasChatDemand()) return;
    chatLeader = true;
    startChatForCurrentState();
  }

  function electChatLeader() {
    if (!hasChatDemand()) {
      if (chatLeader) {
        releaseLock(CHAT_LEADER_KEY);
        stopChatLeaderWork();
      }
      return;
    }

    const lock = readLock(CHAT_LEADER_KEY);
    const now = Date.now();

    if (!lock || Number(lock.expiresAt || 0) <= now || lock.owner === instanceId) {
      if (writeLock(CHAT_LEADER_KEY)) becomeChatLeader();
      else stopChatLeaderWork();
    } else if (chatLeader) {
      stopChatLeaderWork();
    }
  }

  function ensureChatElection() {
    if (!hasChatDemand()) return;
    if (!chatLeaderTimer) {
      electChatLeader();
      chatLeaderTimer = setInterval(electChatLeader, LEADER_HEARTBEAT_MS);
    }
    if (chatLeader) startChatForCurrentState();
  }

  function startChatForCurrentState() {
    if (!chatLeader || !hasChatDemand()) return;
    const chatId = state.isLive ? state.liveChatId : null;

    if (!chatId) {
      if (chatTimer) clearTimeout(chatTimer);
      chatTimer = setTimeout(startChatForCurrentState, 5000);
      return;
    }

    if (activeChatId !== chatId) {
      activeChatId = chatId;
      liveChatPageToken = null;
      seenApiItemIds.clear();
    }

    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = setTimeout(pollChat, 0);
  }

  async function pollChat() {
    if (!chatLeader || !hasChatDemand() || !activeChatId) return;

    try {
      const params = {
        liveChatId: activeChatId,
        part: 'id,snippet,authorDetails',
        maxResults: '200',
        hl: 'pt-PT'
      };
      if (liveChatPageToken) params.pageToken = liveChatPageToken;

      const data = await apiGet('liveChat/messages', params);
      if (!chatLeader) return;

      liveChatPageToken = data.nextPageToken || liveChatPageToken;

      for (const item of data.items || []) {
        if (!item?.id || seenApiItemIds.has(item.id)) continue;
        seenApiItemIds.add(item.id);
        setTimeout(() => seenApiItemIds.delete(item.id), 30 * 60 * 1000);

        const message = messageFromItem(item);
        if (message) broadcast('chat', message);

        const event = eventFromItem(item);
        if (event) broadcast('event', event);
      }

      const delay = Math.min(
        MAX_CHAT_POLL_MS,
        Math.max(MIN_CHAT_POLL_MS, Number(data.pollingIntervalMillis || 5000))
      );
      chatTimer = setTimeout(pollChat, delay);
    } catch (error) {
      const ended = ['liveChatEnded', 'liveChatNotFound'].includes(error.reason);
      if (ended) {
        activeChatId = null;
        liveChatPageToken = null;
        chatTimer = setTimeout(startChatForCurrentState, 5000);
      } else {
        chatTimer = setTimeout(pollChat, 15000);
      }
    }
  }

  function start() {
    if (started) return;
    started = true;
    global.ytLiveState = publicState();

    electStateLeader();
    stateLeaderTimer = setInterval(electStateLeader, LEADER_HEARTBEAT_MS);

    global.addEventListener('beforeunload', () => {
      if (stateLeaderTimer) clearInterval(stateLeaderTimer);
      if (chatLeaderTimer) clearInterval(chatLeaderTimer);
      releaseLock(STATE_LEADER_KEY);
      releaseLock(CHAT_LEADER_KEY);
    });
  }

  global.YoutubeLive = {
    startChat(onMessage, onEvent) {
      if (typeof onMessage === 'function') messageHandlers.add(onMessage);
      if (typeof onEvent === 'function') eventHandlers.add(onEvent);
      start();
      ensureChatElection();

      return () => {
        if (typeof onMessage === 'function') messageHandlers.delete(onMessage);
        if (typeof onEvent === 'function') eventHandlers.delete(onEvent);
        electChatLeader();
      };
    },

    subscribeState(handler) {
      if (typeof handler !== 'function') return () => {};
      stateHandlers.add(handler);
      try { handler(publicState()); } catch (_) {}
      start();
      return () => stateHandlers.delete(handler);
    },

    resolveLiveDetails() {
      start();
      if (stateLeader) {
        const task = activeVideoId || state.videoId
          ? refreshKnownVideo()
          : discoverLive(true);
        return Promise.resolve(task).then(() => publicState());
      }
      broadcast('refresh', { requestedBy: instanceId });
      return Promise.resolve(publicState());
    },

    refresh() {
      start();
      if (stateLeader) {
        if (activeVideoId || state.videoId) refreshKnownVideo();
        else discoverLive(true);
      } else {
        broadcast('refresh', { requestedBy: instanceId });
      }
    },

    getState: publicState,

    debug() {
      return {
        version: '2.5',
        instanceId,
        stateLeader,
        chatLeader,
        activeVideoId,
        activeChatId,
        state: publicState()
      };
    },

    stopChat() {
      messageHandlers.clear();
      eventHandlers.clear();
      if (chatLeader) releaseLock(CHAT_LEADER_KEY);
      stopChatLeaderWork();
    },

    channelId: CHANNEL_ID,
    channelHandle: CHANNEL_HANDLE,
    version: '2.5'
  };

  start();
})(window);
