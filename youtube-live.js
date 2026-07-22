/**
 * ApexScorpio YouTube Live Module v2.4
 *
 * Uses the official YouTube Data / Live Streaming API only.
 * - search.list discovers the active live once and cached IDs survive updates
 * - videos.list reads the official live state, concurrent viewers and chat ID
 * - a confirmed live stays online until actualEndTime is returned twice
 * - liveChatMessages.list reads chat, memberships and paid messages
 *
 * Multiple overlays coordinate through BroadcastChannel/localStorage so that,
 * in the normal OBS browser profile, only one tab spends API quota.
 */
(function (global) {
  'use strict';

  const API_KEY = global.APEX_YOUTUBE_API_KEY || 'AIzaSyD_tdt10TzQhoM1-PRhTXORBOPVRgqLJUI';
  const CHANNEL_ID = 'UCF3aydfOlV88XVqW8vpdKEw';
  const CHANNEL_HANDLE = '@apexscorpio';
  const UPLOADS_PLAYLIST_ID = CHANNEL_ID.replace(/^UC/, 'UU');

  // Stable keys: never version these again. Versioned keys caused a confirmed
  // broadcast ID to be forgotten every time the module was updated.
  const STATE_KEY = 'apex_yt_live_state';
  const VIDEO_KEY = 'apex_yt_live_video_id';
  const LEADER_KEY = 'apex_yt_live_leader';
  const BUS_KEY = 'apex_yt_live_bus';
  const LAST_SEARCH_KEY = 'apex_yt_last_search';
  const LEGACY_STATE_KEYS = [
    'apex_yt_live_state_v5', 'apex_yt_live_state_v4',
    'apex_yt_live_state_v3', 'apex_yt_live_state_v2'
  ];
  const LEGACY_VIDEO_KEYS = [
    'apex_yt_live_video_id_v5', 'apex_yt_live_video_id_v4',
    'apex_yt_live_video_id_v3', 'apex_yt_live_video_id_v2'
  ];

  const LEADER_TTL_MS = 30000;
  const LEADER_HEARTBEAT_MS = 5000;
  const VIDEO_POLL_MS = 5000;
  const OFFLINE_RETRY_MS = 5000;
  const END_CONFIRMATIONS_REQUIRED = 2;
  // search.list has a separate 100-call daily allowance. One search every
  // 15 minutes stays within that limit even if the dashboard remains open 24/7.
  const OFFLINE_DISCOVERY_MS = 15 * 60 * 1000;
  const MIN_SEARCH_GAP_MS = 60 * 1000;
  const MIN_CHAT_POLL_MS = 1000;
  const MAX_CHAT_POLL_MS = 15000;

  const instanceId = `yt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('apex_youtube_live')
    : null;

  const messageHandlers = new Set();
  const eventHandlers = new Set();
  const stateHandlers = new Set();
  const seenEnvelopeIds = new Set();
  const seenChatIds = new Set();
  const seenApiItemIds = new Set();

  let started = false;
  let isLeader = false;
  let leaderTimer = null;
  let videoTimer = null;
  let discoveryTimer = null;
  let chatTimer = null;
  let liveChatPageToken = null;
  let activeChatId = null;
  let state = loadState();
  let activeVideoId = safeGet(VIDEO_KEY) || state.videoId || loadLegacyVideoId() || null;
  let consecutiveEndChecks = 0;

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function normalizeStoredState(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      isLive: Boolean(parsed.isLive),
      viewers: Number(parsed.viewers || 0),
      videoId: parsed.videoId || null,
      liveChatId: parsed.liveChatId || null,
      title: parsed.title || '',
      updatedAt: Number(parsed.updatedAt || 0),
      error: parsed.error || null
    };
  }

  function loadLegacyVideoId() {
    for (const key of LEGACY_VIDEO_KEYS) {
      const value = safeGet(key);
      if (value) return value;
    }
    return null;
  }

  function loadState() {
    const candidates = [];
    for (const key of [STATE_KEY, ...LEGACY_STATE_KEYS]) {
      try {
        const normalized = normalizeStoredState(JSON.parse(safeGet(key) || 'null'));
        if (normalized) candidates.push(normalized);
      } catch (_) {}
    }

    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    // Prefer a positively confirmed live with a video ID, even when a newer
    // broken version wrote an offline state afterwards. The ID is validated
    // against videos.list before it is shown as online.
    const chosen = candidates.find(item => item.isLive && item.videoId)
      || candidates.find(item => item.videoId)
      || candidates[0]
      || {
        isLive: false, viewers: 0, videoId: null, liveChatId: null,
        title: '', updatedAt: 0, error: null
      };

    const migratedVideoId = chosen.videoId || loadLegacyVideoId();
    const migrated = { ...chosen, videoId: migratedVideoId || null };
    safeSet(STATE_KEY, JSON.stringify(migrated));
    if (migrated.videoId) safeSet(VIDEO_KEY, migrated.videoId);
    // Migration is one-time. Keeping the old keys would allow a stale live
    // state to win again on a future page load.
    for (const key of [...LEGACY_STATE_KEYS, ...LEGACY_VIDEO_KEYS]) safeRemove(key);
    return migrated;
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

  function makeEnvelope(kind, payload) {
    return {
      id: `${instanceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: instanceId,
      kind,
      payload,
      timestamp: Date.now()
    };
  }

  function broadcast(kind, payload) {
    const envelope = makeEnvelope(kind, payload);
    handleEnvelope(envelope);
    if (channel) {
      try { channel.postMessage(envelope); } catch (_) {}
    }
    safeSet(BUS_KEY, JSON.stringify(envelope));
  }

  function handleEnvelope(envelope) {
    if (!envelope || !envelope.id || remember(seenEnvelopeIds, envelope.id, 120000)) return;
    const payload = envelope.payload;

    if (envelope.kind === 'state' && payload) {
      const incomingUpdatedAt = Number(payload.updatedAt || 0);
      if (state.updatedAt && incomingUpdatedAt && incomingUpdatedAt < state.updatedAt) return;
      state = {
        isLive: Boolean(payload.isLive),
        viewers: Number(payload.viewers || 0),
        videoId: payload.videoId || null,
        liveChatId: payload.liveChatId || null,
        title: payload.title || '',
        updatedAt: Number(payload.updatedAt || Date.now()),
        error: payload.error || null
      };
      global.ytLiveState = publicState();
      stateHandlers.forEach(handler => {
        try { handler(publicState()); } catch (_) {}
      });
      return;
    }

    if (envelope.kind === 'chat' && payload) {
      if (remember(seenChatIds, payload.id, 10 * 60 * 1000)) return;
      messageHandlers.forEach(handler => {
        try { handler(payload); } catch (_) {}
      });
      return;
    }

    if (envelope.kind === 'event' && payload) {
      if (remember(seenChatIds, `evt:${payload.id}`, 10 * 60 * 1000)) return;
      eventHandlers.forEach(handler => {
        try { handler(payload); } catch (_) {}
      });
      return;
    }

    if (envelope.kind === 'refresh' && isLeader) {
      if (activeVideoId || state.isLive) refreshVideoDetails();
      else discoverLive(true);
    }
  }

  if (channel) channel.addEventListener('message', event => handleEnvelope(event.data));

  global.addEventListener('storage', event => {
    if (event.key !== BUS_KEY || !event.newValue) return;
    try { handleEnvelope(JSON.parse(event.newValue)); } catch (_) {}
  });

  async function apiGet(path, params) {
    const query = new URLSearchParams(params || {});
    query.set('key', API_KEY);
    const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${query.toString()}`, {
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      const message = data?.error?.message || `YouTube API ${response.status}`;
      const error = new Error(message);
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
      error: next.error || null
    };
    global.ytLiveState = publicState();
    safeSet(STATE_KEY, JSON.stringify(state));
    if (state.videoId) safeSet(VIDEO_KEY, state.videoId);
    else safeRemove(VIDEO_KEY);
    broadcast('state', state);
  }


  function hasActiveLeadership() {
    const lock = readLeader();
    return Boolean(
      isLeader && lock && lock.owner === instanceId && Number(lock.expiresAt || 0) > Date.now()
    );
  }

  function recordConfirmedLive() {
    consecutiveEndChecks = 0;
  }

  function holdKnownLive(error = null) {
    if (!state.isLive) return false;
    activeVideoId = activeVideoId || state.videoId || null;
    publishState({
      ...state,
      isLive: true,
      videoId: activeVideoId || state.videoId,
      error
    });
    if (activeVideoId) scheduleVideoPoll(OFFLINE_RETRY_MS);
    else scheduleDiscovery(OFFLINE_RETRY_MS);
    return true;
  }

  function publishConfirmedOffline(discoveryDelay = OFFLINE_DISCOVERY_MS) {
    consecutiveEndChecks = 0;
    activeVideoId = null;
    stopChatPolling();
    publishState({ isLive: false, viewers: 0, videoId: null, liveChatId: null, title: '', error: null });
    scheduleDiscovery(discoveryDelay);
  }

  function scheduleVideoPoll(delay = VIDEO_POLL_MS) {
    if (videoTimer) clearTimeout(videoTimer);
    if (!isLeader) return;
    videoTimer = setTimeout(refreshVideoDetails, delay);
  }

  function scheduleDiscovery(delay = OFFLINE_DISCOVERY_MS) {
    if (discoveryTimer) clearTimeout(discoveryTimer);
    if (!isLeader) return;
    discoveryTimer = setTimeout(() => discoverLive(false), delay);
  }

  function stopChatPolling() {
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = null;
    liveChatPageToken = null;
    activeChatId = null;
  }

  async function refreshVideoDetails() {
    if (!activeVideoId || !hasActiveLeadership()) {
      if (state.isLive && !activeVideoId) scheduleDiscovery(OFFLINE_RETRY_MS);
      return;
    }

    try {
      const requestedVideoId = activeVideoId;
      const data = await apiGet('videos', {
        part: 'snippet,liveStreamingDetails',
        id: requestedVideoId,
        maxResults: '1'
      });
      if (!hasActiveLeadership() || activeVideoId !== requestedVideoId) return;

      const video = data?.items?.[0] || null;
      const details = video?.liveStreamingDetails || null;
      const liveContent = video?.snippet?.liveBroadcastContent || 'none';
      const hasExplicitEnd = Boolean(details?.actualEndTime);
      const isActuallyLive = Boolean(
        video && details && !hasExplicitEnd &&
        (liveContent === 'live' || details.actualStartTime)
      );

      if (hasExplicitEnd) {
        consecutiveEndChecks += 1;
        if (consecutiveEndChecks < END_CONFIRMATIONS_REQUIRED && holdKnownLive(null)) return;
        publishConfirmedOffline(OFFLINE_DISCOVERY_MS);
        return;
      }

      // Missing/partial API data must never cancel a live session that was
      // already positively confirmed. Only actualEndTime may do that.
      if (!isActuallyLive) {
        consecutiveEndChecks = 0;
        if (holdKnownLive(null)) return;

        activeVideoId = null;
        safeRemove(VIDEO_KEY);
        scheduleDiscovery(OFFLINE_DISCOVERY_MS);
        return;
      }

      recordConfirmedLive();
      const liveChatId = details.activeLiveChatId || null;
      publishState({
        isLive: true,
        viewers: Number(details.concurrentViewers || 0),
        videoId: activeVideoId,
        liveChatId,
        title: video?.snippet?.title || ''
      });

      if (liveChatId) startChatPolling(liveChatId);
      else stopChatPolling();
      scheduleVideoPoll(VIDEO_POLL_MS);
    } catch (error) {
      if (!hasActiveLeadership()) return;
      if (!holdKnownLive(error.message)) {
        publishState({ ...state, error: error.message });
        scheduleDiscovery(OFFLINE_DISCOVERY_MS);
      }
    }
  }

  async function discoverFromSearch() {
    const data = await apiGet('search', {
      part: 'snippet',
      channelId: CHANNEL_ID,
      eventType: 'live',
      type: 'video',
      maxResults: '1'
    });
    return data?.items?.[0]?.id?.videoId || null;
  }

  async function discoverFromUploadsPlaylist() {
    const playlist = await apiGet('playlistItems', {
      part: 'contentDetails,snippet',
      playlistId: UPLOADS_PLAYLIST_ID,
      maxResults: '10'
    });

    const ids = [...new Set((playlist?.items || [])
      .map(item => item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId)
      .filter(Boolean))];
    if (!ids.length) return null;

    const videos = await apiGet('videos', {
      part: 'snippet,liveStreamingDetails',
      id: ids.join(','),
      maxResults: String(ids.length)
    });

    const live = (videos?.items || []).find(video => {
      const details = video?.liveStreamingDetails;
      const content = video?.snippet?.liveBroadcastContent || 'none';
      return Boolean(details && !details.actualEndTime &&
        (content === 'live' || details.actualStartTime));
    });
    return live?.id || null;
  }

  async function discoverFromOEmbed() {
    try {
      const liveUrl = `https://www.youtube.com/${CHANNEL_HANDLE}/live`;
      const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(liveUrl)}`, {
        cache: 'no-store'
      });
      if (!response.ok) return null;
      const data = await response.json();
      const match = String(data?.html || '').match(/youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/);
      return match?.[1] || null;
    } catch (_) {
      return null;
    }
  }

  async function discoverLive(force) {
    if (!hasActiveLeadership()) return;

    // Once a broadcast has been confirmed, discovery is no longer allowed to
    // overwrite it. The known video is authoritative until YouTube supplies
    // actualEndTime for that exact video.
    if (state.isLive && (activeVideoId || state.videoId)) {
      activeVideoId = activeVideoId || state.videoId;
      refreshVideoDetails();
      return;
    }

    const now = Date.now();
    const lastSearchAt = Number(safeGet(LAST_SEARCH_KEY) || 0);
    if (!force && lastSearchAt && now - lastSearchAt < MIN_SEARCH_GAP_MS) {
      scheduleDiscovery(Math.max(1000, MIN_SEARCH_GAP_MS - (now - lastSearchAt)));
      return;
    }

    safeSet(LAST_SEARCH_KEY, String(now));
    let searchError = null;
    try {
      // Official and authoritative discovery path. It is called sparingly;
      // once a video is found, only the cheap videos.list poll is used.
      let videoId = null;
      try {
        videoId = await discoverFromSearch();
      } catch (error) {
        searchError = error;
      }

      // Best-effort fallbacks are retained, but they are not authoritative.
      if (!videoId) videoId = await discoverFromOEmbed();
      if (!videoId) videoId = await discoverFromUploadsPlaylist();
      if (!hasActiveLeadership()) return;

      if (videoId) {
        activeVideoId = videoId;
        safeSet(VIDEO_KEY, videoId);
        liveChatPageToken = null;
        await refreshVideoDetails();
      } else {
        publishState({
          isLive: false, viewers: 0, videoId: null, liveChatId: null,
          title: '', error: searchError?.message || null
        });
        scheduleDiscovery(OFFLINE_DISCOVERY_MS);
      }
    } catch (error) {
      if (!hasActiveLeadership()) return;
      console.warn('[YouTube Live] discovery failed:', error);
      publishState({ ...state, error: error.message });
      scheduleDiscovery(OFFLINE_DISCOVERY_MS);
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

  function startChatPolling(liveChatId) {
    if (!isLeader || !liveChatId) return;
    if (activeChatId === liveChatId && chatTimer) return;
    if (activeChatId !== liveChatId) {
      activeChatId = liveChatId;
      liveChatPageToken = null;
      seenApiItemIds.clear();
    }
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = setTimeout(pollChat, 0);
  }

  async function pollChat() {
    if (!activeChatId || !hasActiveLeadership()) return;
    try {
      const params = {
        liveChatId: activeChatId,
        part: 'id,snippet,authorDetails',
        maxResults: '200',
        hl: 'pt-PT'
      };
      if (liveChatPageToken) params.pageToken = liveChatPageToken;
      const data = await apiGet('liveChat/messages', params);
      if (!hasActiveLeadership()) return;
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
      const ended = error.reason === 'liveChatEnded' || error.reason === 'liveChatNotFound';
      if (ended) {
        stopChatPolling();
        scheduleVideoPoll(0);
      } else {
        chatTimer = setTimeout(pollChat, 15000);
      }
    }
  }

  function readLeader() {
    try { return JSON.parse(safeGet(LEADER_KEY) || 'null'); } catch (_) { return null; }
  }

  function writeLeader() {
    const lock = { owner: instanceId, expiresAt: Date.now() + LEADER_TTL_MS };
    safeSet(LEADER_KEY, JSON.stringify(lock));
    return readLeader()?.owner === instanceId;
  }

  function stopLeaderWork() {
    isLeader = false;
    if (videoTimer) clearTimeout(videoTimer);
    if (discoveryTimer) clearTimeout(discoveryTimer);
    if (chatTimer) clearTimeout(chatTimer);
    videoTimer = discoveryTimer = chatTimer = null;
  }

  function beginLeaderWork() {
    if (isLeader) return;
    isLeader = true;
    activeVideoId = safeGet(VIDEO_KEY) || state.videoId || loadLegacyVideoId() || null;
    if (activeVideoId) {
      safeSet(VIDEO_KEY, activeVideoId);
      refreshVideoDetails();
    } else {
      discoverLive(false);
    }
  }

  function electLeader() {
    const lock = readLeader();
    const now = Date.now();
    if (!lock || lock.expiresAt <= now || lock.owner === instanceId) {
      if (writeLeader()) beginLeaderWork();
      else stopLeaderWork();
    } else if (lock.owner !== instanceId && isLeader) {
      stopLeaderWork();
    }

    if (!isLeader && state.updatedAt && Date.now() - state.updatedAt > 30000) {
      state = loadState();
      global.ytLiveState = publicState();
    }
  }

  function start() {
    if (started) return;
    started = true;
    global.ytLiveState = publicState();
    electLeader();
    leaderTimer = setInterval(electLeader, LEADER_HEARTBEAT_MS);
    global.addEventListener('beforeunload', () => {
      if (leaderTimer) clearInterval(leaderTimer);
      const lock = readLeader();
      if (lock?.owner === instanceId) safeRemove(LEADER_KEY);
    });
  }

  global.YoutubeLive = {
    startChat(onMsg, onEvt) {
      if (typeof onMsg === 'function') messageHandlers.add(onMsg);
      if (typeof onEvt === 'function') eventHandlers.add(onEvt);
      start();
      return () => {
        if (typeof onMsg === 'function') messageHandlers.delete(onMsg);
        if (typeof onEvt === 'function') eventHandlers.delete(onEvt);
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
      if (isLeader) {
        const task = (activeVideoId || state.isLive)
          ? refreshVideoDetails()
          : discoverLive(true);
        return Promise.resolve(task).then(() => publicState());
      }
      broadcast('refresh', { requestedBy: instanceId });
      return Promise.resolve(publicState());
    },
    refresh() {
      start();
      if (isLeader) {
        if (activeVideoId || state.isLive) refreshVideoDetails();
        else discoverLive(true);
      } else {
        broadcast('refresh', { requestedBy: instanceId });
      }
    },
    getState: publicState,
    stopChat() {
      messageHandlers.clear();
      eventHandlers.clear();
    },
    channelId: CHANNEL_ID,
    channelHandle: CHANNEL_HANDLE,
    version: '2.4'
  };

  start();
})(window);
