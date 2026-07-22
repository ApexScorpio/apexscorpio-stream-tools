/**
 * ApexScorpio YouTube Live Module v2.6
 *
 * Live discovery no longer depends on search.list.
 * The official YouTube iframe player detects the current channel live video.
 * Data API calls are used only for viewer count/chat metadata and back off on 429.
 */
(function (global) {
  'use strict';

  const API_KEY = global.APEX_YOUTUBE_API_KEY || 'AIzaSyD_tdt10TzQhoM1-PRhTXORBOPVRgqLJUI';
  const CHANNEL_ID = 'UCF3aydfOlV88XVqW8vpdKEw';
  const CHANNEL_HANDLE = '@apexscorpio';

  const STATE_KEY = 'apex_yt_live_state';
  const VIDEO_KEY = 'apex_yt_live_video_id';
  const API_BLOCKED_UNTIL_KEY = 'apex_yt_api_blocked_until';
  const API_BACKOFF_KEY = 'apex_yt_api_backoff';
  const STATE_LEADER_KEY = 'apex_yt_state_leader3';
  const CHAT_LEADER_KEY = 'apex_yt_chat_leader3';
  const BUS_KEY = 'apex_yt_bus3';
  const CHANNEL_NAME = 'apex_youtube_live_bus3';

  const LEADER_TTL_MS = 20000;
  const LEADER_HEARTBEAT_MS = 5000;
  const PLAYER_PROBE_MS = 10000;
  const OEMBED_PROBE_MS = 30000;
  const DETAILS_POLL_MS = 15000;
  const LIVE_PROBE_GRACE_MS = 90000;
  const MIN_API_BACKOFF_MS = 60000;
  const MAX_API_BACKOFF_MS = 15 * 60 * 1000;
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
  let playerProbeTimer = null;
  let oembedTimer = null;
  let detailsTimer = null;
  let chatTimer = null;
  let player = null;
  let playerReady = false;
  let playerInitStarted = false;
  let detailsInFlight = false;
  let activeVideoId = safeGet(VIDEO_KEY) || null;
  let activeChatId = null;
  let liveChatPageToken = null;
  let lastPlayerVideoAt = 0;
  let consecutiveEndedChecks = 0;
  let state = loadState();

  if (!activeVideoId && state.videoId) activeVideoId = state.videoId;

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

  function createEnvelope(kind, payload) {
    return {
      id: `${instanceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: instanceId,
      kind,
      payload,
      timestamp: Date.now()
    };
  }

  function broadcast(kind, payload) {
    const packet = createEnvelope(kind, payload);
    handleEnvelope(packet);

    if (bus) {
      try { bus.postMessage(packet); } catch (_) {}
    }

    safeSet(BUS_KEY, JSON.stringify(packet));
  }

  function handleEnvelope(packet) {
    if (!packet?.id || remember(seenEnvelopeIds, packet.id, 120000)) return;

    if (packet.kind === 'state' && packet.payload) {
      const incoming = packet.payload;
      const incomingUpdatedAt = Number(incoming.updatedAt || 0);
      if (state.updatedAt && incomingUpdatedAt && incomingUpdatedAt < state.updatedAt) return;

      state = {
        isLive: Boolean(incoming.isLive),
        viewers: Math.max(0, Number(incoming.viewers || 0)),
        videoId: incoming.videoId || null,
        liveChatId: incoming.liveChatId || null,
        title: incoming.title || '',
        updatedAt: incomingUpdatedAt || Date.now(),
        error: incoming.error || null,
        source: incoming.source || null
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
      if (remember(seenChatIds, `event:${packet.payload.id}`, 10 * 60 * 1000)) return;
      eventHandlers.forEach(handler => {
        try { handler(packet.payload); } catch (_) {}
      });
      return;
    }

    if (packet.kind === 'refresh' && stateLeader) {
      forceProbe();
    }
  }

  if (bus) bus.addEventListener('message', event => handleEnvelope(event.data));

  global.addEventListener('storage', event => {
    if (event.key !== BUS_KEY || !event.newValue) return;
    try { handleEnvelope(JSON.parse(event.newValue)); } catch (_) {}
  });

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
      activeVideoId = null;
      safeRemove(VIDEO_KEY);
    }

    broadcast('state', state);
  }

  function publishProvisionalLive(videoId, source) {
    if (!videoId) return;

    lastPlayerVideoAt = Date.now();
    consecutiveEndedChecks = 0;
    const sameVideo = state.videoId === videoId;

    publishState({
      isLive: true,
      viewers: sameVideo ? state.viewers : 0,
      videoId,
      liveChatId: sameVideo ? state.liveChatId : null,
      title: sameVideo ? state.title : '',
      error: null,
      source
    });

    scheduleDetails(0);
    ensureChatElection();
  }

  function publishConfirmedLive(video, source) {
    const details = video?.liveStreamingDetails || {};
    lastPlayerVideoAt = Date.now();
    consecutiveEndedChecks = 0;

    publishState({
      isLive: true,
      viewers: details.concurrentViewers == null
        ? Number(state.viewers || 0)
        : Number(details.concurrentViewers || 0),
      videoId: video.id,
      liveChatId: details.activeLiveChatId || null,
      title: video?.snippet?.title || state.title || '',
      error: null,
      source
    });

    scheduleDetails(DETAILS_POLL_MS);
    ensureChatElection();
  }

  function publishOffline(error = null, source = null) {
    consecutiveEndedChecks = 0;
    publishState({
      isLive: false,
      viewers: 0,
      videoId: null,
      liveChatId: null,
      title: '',
      error,
      source
    });
  }

  function currentApiBlock() {
    return Math.max(0, Number(safeGet(API_BLOCKED_UNTIL_KEY) || 0));
  }

  function registerApiRateLimit() {
    const previous = Math.max(
      MIN_API_BACKOFF_MS,
      Number(safeGet(API_BACKOFF_KEY) || MIN_API_BACKOFF_MS)
    );
    const next = Math.min(MAX_API_BACKOFF_MS, previous * 2);
    safeSet(API_BACKOFF_KEY, String(next));
    safeSet(API_BLOCKED_UNTIL_KEY, String(Date.now() + previous));
    return previous;
  }

  function registerApiSuccess() {
    safeSet(API_BACKOFF_KEY, String(MIN_API_BACKOFF_MS));
    safeRemove(API_BLOCKED_UNTIL_KEY);
  }

  function apiAvailable() {
    return Date.now() >= currentApiBlock();
  }

  async function apiGet(path, params) {
    const blockedUntil = currentApiBlock();
    if (Date.now() < blockedUntil) {
      const error = new Error('YouTube API temporarily rate-limited');
      error.status = 429;
      error.reason = 'localRateLimit';
      throw error;
    }

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

      if (response.status === 429 || error.reason === 'rateLimitExceeded') {
        registerApiRateLimit();
      }

      throw error;
    }

    registerApiSuccess();
    return data;
  }

  function isLiveVideo(video) {
    const details = video?.liveStreamingDetails;
    const content = video?.snippet?.liveBroadcastContent || 'none';
    if (!video || !details || details.actualEndTime) return false;
    return content === 'live' || Boolean(details.actualStartTime);
  }

  function scheduleDetails(delay) {
    if (detailsTimer) clearTimeout(detailsTimer);
    if (!stateLeader || !state.videoId) return;
    detailsTimer = setTimeout(refreshVideoDetails, Math.max(0, delay));
  }

  async function refreshVideoDetails() {
    if (!stateLeader || detailsInFlight || !state.videoId) return;

    if (!apiAvailable()) {
      // The player already proved the live exists. Keep it online while the
      // Data API is rate-limited and retry after the shared backoff expires.
      scheduleDetails(Math.max(5000, currentApiBlock() - Date.now()));
      return;
    }

    detailsInFlight = true;
    const requestedId = state.videoId;

    try {
      const data = await apiGet('videos', {
        part: 'snippet,liveStreamingDetails',
        id: requestedId,
        maxResults: '1'
      });

      if (!stateLeader || state.videoId !== requestedId) return;
      const video = data?.items?.[0] || null;

      if (isLiveVideo(video)) {
        publishConfirmedLive(video, 'videos-list');
        return;
      }

      const explicitlyEnded = Boolean(video?.liveStreamingDetails?.actualEndTime);
      const playerStillSeesVideo =
        activeVideoId === requestedId &&
        Date.now() - lastPlayerVideoAt < LIVE_PROBE_GRACE_MS;

      if (playerStillSeesVideo) {
        publishProvisionalLive(requestedId, 'iframe-player');
        return;
      }

      if (explicitlyEnded) {
        consecutiveEndedChecks += 1;
        if (consecutiveEndedChecks >= 2) {
          publishOffline(null, 'ended-video');
        } else {
          scheduleDetails(10000);
        }
        return;
      }

      scheduleDetails(30000);
    } catch (error) {
      if (!stateLeader) return;

      if (error.status === 429 || error.reason === 'rateLimitExceeded' || error.reason === 'localRateLimit') {
        publishState({
          ...state,
          isLive: Boolean(state.videoId),
          error: 'YouTube API rate-limited; live detected by player',
          source: state.source || 'iframe-player'
        });
        scheduleDetails(Math.max(5000, currentApiBlock() - Date.now()));
      } else {
        publishState({ ...state, error: error.message });
        scheduleDetails(30000);
      }
    } finally {
      detailsInFlight = false;
    }
  }

  function extractPlayerVideoId() {
    if (!playerReady || !player) return null;

    try {
      const data = player.getVideoData ? player.getVideoData() : null;
      const id = data?.video_id || null;
      return /^[a-zA-Z0-9_-]{11}$/.test(String(id || '')) ? id : null;
    } catch (_) {
      return null;
    }
  }

  function probePlayer() {
    if (!stateLeader) return;

    const videoId = extractPlayerVideoId();
    if (videoId) {
      activeVideoId = videoId;
      publishProvisionalLive(videoId, 'iframe-player');
    }

    schedulePlayerProbe(PLAYER_PROBE_MS);
  }

  function schedulePlayerProbe(delay) {
    if (playerProbeTimer) clearTimeout(playerProbeTimer);
    if (!stateLeader) return;
    playerProbeTimer = setTimeout(probePlayer, delay);
  }

  function createHiddenPlayerIframe() {
    const existing = document.getElementById('apex-youtube-live-probe');
    if (existing) return existing;

    const iframe = document.createElement('iframe');
    iframe.id = 'apex-youtube-live-probe';
    iframe.title = 'YouTube live detection';
    iframe.width = '1';
    iframe.height = '1';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed!important;left:-9999px!important;top:-9999px!important;' +
      'width:1px!important;height:1px!important;opacity:0!important;' +
      'pointer-events:none!important;border:0!important;';

    const origin = encodeURIComponent(global.location.origin);
    iframe.src =
      `https://www.youtube.com/embed/live_stream?channel=${CHANNEL_ID}` +
      `&enablejsapi=1&origin=${origin}&playsinline=1&controls=0&mute=1`;

    (document.body || document.documentElement).appendChild(iframe);
    return iframe;
  }

  function initializeIframePlayer() {
    if (!stateLeader || playerInitStarted || !global.YT?.Player) return;
    playerInitStarted = true;

    const iframe = createHiddenPlayerIframe();

    try {
      player = new global.YT.Player(iframe, {
        events: {
          onReady() {
            playerReady = true;
            probePlayer();
          },
          onStateChange() {
            probePlayer();
          },
          onError() {
            playerReady = true;
            scheduleOEmbedProbe(0);
            schedulePlayerProbe(PLAYER_PROBE_MS);
          }
        }
      });
    } catch (_) {
      playerInitStarted = false;
      scheduleOEmbedProbe(0);
    }
  }

  function loadIframeApi() {
    if (!stateLeader) return;

    if (global.YT?.Player) {
      initializeIframePlayer();
      return;
    }

    const previousReady = global.onYouTubeIframeAPIReady;
    global.onYouTubeIframeAPIReady = function () {
      if (typeof previousReady === 'function') {
        try { previousReady(); } catch (_) {}
      }
      initializeIframePlayer();
    };

    if (!document.querySelector('script[data-apex-youtube-iframe-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.apexYoutubeIframeApi = '1';
      (document.head || document.documentElement).appendChild(script);
    }

    createHiddenPlayerIframe();
  }

  async function discoverFromOEmbed() {
    const liveUrls = [
      `https://www.youtube.com/channel/${CHANNEL_ID}/live`,
      `https://www.youtube.com/${CHANNEL_HANDLE}/live`
    ];

    for (const liveUrl of liveUrls) {
      try {
        const endpoint =
          `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(liveUrl)}`;
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) continue;

        const data = await response.json();
        const match = String(data?.html || '').match(
          /youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]{11})/
        );

        if (match?.[1]) return match[1];
      } catch (_) {}
    }

    return null;
  }

  async function probeOEmbed() {
    if (!stateLeader) return;

    const videoId = await discoverFromOEmbed();
    if (!stateLeader) return;

    if (videoId) {
      activeVideoId = videoId;
      publishProvisionalLive(videoId, 'oembed');
    }

    scheduleOEmbedProbe(OEMBED_PROBE_MS);
  }

  function scheduleOEmbedProbe(delay) {
    if (oembedTimer) clearTimeout(oembedTimer);
    if (!stateLeader) return;
    oembedTimer = setTimeout(probeOEmbed, Math.max(0, delay));
  }

  function forceProbe() {
    if (!stateLeader) return;
    probePlayer();
    scheduleOEmbedProbe(0);
    if (state.videoId) scheduleDetails(0);
  }

  function readLock(key) {
    try { return JSON.parse(safeGet(key) || 'null'); } catch (_) { return null; }
  }

  function writeLock(key) {
    const lock = {
      owner: instanceId,
      expiresAt: Date.now() + LEADER_TTL_MS
    };
    safeSet(key, JSON.stringify(lock));
    return readLock(key)?.owner === instanceId;
  }

  function releaseLock(key) {
    const lock = readLock(key);
    if (lock?.owner === instanceId) safeRemove(key);
  }

  function stopStateLeaderWork() {
    stateLeader = false;
    for (const timer of [playerProbeTimer, oembedTimer, detailsTimer]) {
      if (timer) clearTimeout(timer);
    }
    playerProbeTimer = oembedTimer = detailsTimer = null;
  }

  function becomeStateLeader() {
    if (stateLeader) return;
    stateLeader = true;
    activeVideoId = safeGet(VIDEO_KEY) || state.videoId || null;
    loadIframeApi();
    scheduleOEmbedProbe(0);
    schedulePlayerProbe(1000);
    if (activeVideoId) scheduleDetails(0);
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
      text = [paid.amountDisplayString, paid.superStickerMetadata?.altText || text]
        .filter(Boolean).join(' · ');
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
    if (!chatId || !apiAvailable()) {
      if (chatTimer) clearTimeout(chatTimer);
      const delay = !apiAvailable()
        ? Math.max(5000, currentApiBlock() - Date.now())
        : 5000;
      chatTimer = setTimeout(startChatForCurrentState, delay);
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
      } else if (error.status === 429 || error.reason === 'rateLimitExceeded' || error.reason === 'localRateLimit') {
        chatTimer = setTimeout(
          startChatForCurrentState,
          Math.max(5000, currentApiBlock() - Date.now())
        );
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
        forceProbe();
      } else {
        broadcast('refresh', { requestedBy: instanceId });
      }
      return Promise.resolve(publicState());
    },

    refresh() {
      start();
      if (stateLeader) forceProbe();
      else broadcast('refresh', { requestedBy: instanceId });
    },

    getState: publicState,

    debug() {
      return {
        version: '2.6',
        instanceId,
        stateLeader,
        chatLeader,
        playerReady,
        playerVideoId: extractPlayerVideoId(),
        activeVideoId,
        activeChatId,
        apiBlockedUntil: currentApiBlock(),
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
    version: '2.6'
  };

  start();
})(window);
