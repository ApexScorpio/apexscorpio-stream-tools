/**
 * ApexScorpio YouTube Live Module v3.0
 *
 * Sticky live detection:
 * - the official YouTube iframe player is authoritative for online/offline;
 * - API errors, 429s and stale cached sources can never cancel a detected live;
 * - offline requires three continuous minutes without a player live signal;
 * - live_stream is accepted only as an online signal, never as an API video ID;
 * - real video discovery avoids search.list and preserves daily quota.
 */
(function (global) {
  'use strict';

  const BACKEND_BASE_URL = String(
    global.APEX_YOUTUBE_BACKEND_URL ||
    'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app'
  ).replace(/\/+$/, '');
  const STATUS_ENDPOINT = '/youtube-status';
  const CHAT_ENDPOINT = '/youtube-chat';
  const CHANNEL_ID = 'UCF3aydfOlV88XVqW8vpdKEw';
  const CHANNEL_HANDLE = '@apexscorpio';

  // v2.9 uses isolated keys so an older cached source cannot overwrite its state.
  const STATE_KEY = 'apex_yt_live_state_v9_sticky';
  const VIDEO_KEY = 'apex_yt_live_video_id_v9_sticky';
  const PLAYER_LOCK_KEY = 'apex_yt_player_lock_v9_sticky';
  const PLAYER_SIGNAL_KEY = 'apex_yt_player_signal_v9';
  const API_BLOCKED_UNTIL_KEY = 'apex_yt_api_blocked_until_v9';
  const API_BACKOFF_KEY = 'apex_yt_api_backoff_v9';
  const STATE_LEADER_KEY = 'apex_yt_state_leader_v9';
  const CHAT_LEADER_KEY = 'apex_yt_chat_leader_v9';
  const BUS_KEY = 'apex_yt_bus_v9';
  const CHANNEL_NAME = 'apex_youtube_live_bus_v9';

  const LEADER_TTL_MS = 20000;
  const LEADER_HEARTBEAT_MS = 5000;
  const PLAYER_PROBE_MS = 5000;
  const OEMBED_PROBE_MS = 5 * 60 * 1000;
  const DETAILS_POLL_MS = 15000;
  const DISCOVERY_POLL_MS = 5 * 60 * 1000;
  const QUOTA_RETRY_MS = 10 * 60 * 1000;
  const PLAYER_OFFLINE_AFTER_MS = 3 * 60 * 1000;
  const PLAYER_MISS_LIMIT = 36;
  const PLAYER_LOCK_MAX_AGE_MS = 10 * 60 * 1000;
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
  let discoveryInFlight = false;
  let discoveryTimer = null;
  let lastApiError = null;
  let lastPlayerErrorCode = null;
  let lastPlayerErrorAt = 0;
  let lastPlayerSignalAt = Number(safeGet(PLAYER_SIGNAL_KEY) || 0);
  let activeVideoId = safeGet(VIDEO_KEY) || null;
  let activeChatId = null;
  let liveChatPageToken = null;
  let lastPlayerVideoAt = 0;
  let consecutivePlayerMisses = 0;
  let state = loadState();
  let playerLock = loadPlayerLock();

  activeVideoId = normalizeVideoId(activeVideoId || state.videoId);
  if (!activeVideoId) safeRemove(VIDEO_KEY);
  if (state.isLive && !state.videoId) {
    lastPlayerSignalAt = Math.max(lastPlayerSignalAt, Number(state.updatedAt || 0));
  }
  if (playerLock && Date.now() - playerLock.seenAt < PLAYER_LOCK_MAX_AGE_MS) {
    activeVideoId = playerLock.videoId;
    lastPlayerVideoAt = playerLock.seenAt;
    state = {
      ...state,
      isLive: true,
      videoId: playerLock.videoId,
      viewers: state.videoId === playerLock.videoId ? state.viewers : 0,
      updatedAt: Date.now(),
      error: null,
      source: 'sticky-player-lock'
    };
    safeSet(STATE_KEY, JSON.stringify(state));
    safeSet(VIDEO_KEY, playerLock.videoId);
  }

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

  function normalizeVideoId(value) {
    const id = String(value || '').trim();
    if (!id || id === 'live_stream') return null;
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }

  function normalizeViewers(value, fallback = null) {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }

    return Math.floor(parsed);
  }

  function savePlayerSignal() {
    lastPlayerSignalAt = Date.now();
    safeSet(PLAYER_SIGNAL_KEY, String(lastPlayerSignalAt));
  }

  function clearPlayerSignal() {
    lastPlayerSignalAt = 0;
    safeRemove(PLAYER_SIGNAL_KEY);
  }

  function hasRecentPlayerSignal() {
    const storedAt = Math.max(
      lastPlayerSignalAt,
      Number(safeGet(PLAYER_SIGNAL_KEY) || 0)
    );
    return storedAt > 0 && Date.now() - storedAt < PLAYER_OFFLINE_AFTER_MS;
  }

  function loadPlayerLock() {
    try {
      const parsed = JSON.parse(safeGet(PLAYER_LOCK_KEY) || 'null');
      const videoId = normalizeVideoId(parsed?.videoId);
      if (!videoId) return null;
      return {
        videoId,
        seenAt: Number(parsed.seenAt || 0)
      };
    } catch (_) {
      return null;
    }
  }

  function savePlayerLock(videoId) {
    videoId = normalizeVideoId(videoId);
    if (!videoId) return;
    playerLock = { videoId, seenAt: Date.now() };
    lastPlayerVideoAt = playerLock.seenAt;
    safeSet(PLAYER_LOCK_KEY, JSON.stringify(playerLock));
  }

  function clearPlayerLock() {
    playerLock = null;
    safeRemove(PLAYER_LOCK_KEY);
  }

  function hasRecentPlayerLock() {
    const lock = playerLock || loadPlayerLock();
    return Boolean(
      lock && Date.now() - Number(lock.seenAt || 0) < PLAYER_OFFLINE_AFTER_MS
    );
  }

  function loadState() {
    try {
      const parsed = JSON.parse(safeGet(STATE_KEY) || 'null');
      if (parsed && typeof parsed === 'object') {
        const videoId = normalizeVideoId(parsed.videoId);
        return {
          isLive: Boolean(parsed.isLive),
          viewers: normalizeViewers(parsed.viewers, null),
          videoId,
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
      viewers: null,
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

      // A positive player detection is authoritative. Ignore any offline packet
      // while the sticky player lock is still recent.
      if (!incoming.isLive && (hasRecentPlayerLock() || hasRecentPlayerSignal())) return;

      state = {
        isLive: Boolean(incoming.isLive),
        viewers: normalizeViewers(incoming.viewers, null),
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
    const videoId = normalizeVideoId(next.videoId);
    state = {
      isLive: Boolean(next.isLive),
      viewers: normalizeViewers(next.viewers, null),
      videoId,
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
    videoId = normalizeVideoId(videoId);
    if (!videoId) return;

    savePlayerLock(videoId);
    consecutivePlayerMisses = 0;
    const sameVideo = state.videoId === videoId;

    publishState({
      isLive: true,
      viewers: sameVideo ? state.viewers : null,
      videoId,
      liveChatId: sameVideo ? state.liveChatId : null,
      title: sameVideo ? state.title : '',
      error: null,
      source
    });

    scheduleDetails(0);
    ensureChatElection();
  }

  function publishPlayerSignalLive() {
    savePlayerSignal();
    consecutivePlayerMisses = 0;

    if (!state.isLive || (!state.videoId && state.source !== 'iframe-player-signal')) {
      publishState({
        isLive: true,
        viewers: normalizeViewers(state.viewers, null),
        videoId: state.videoId || null,
        liveChatId: state.liveChatId || null,
        title: state.title || '',
        error: lastApiError
          ? 'Backend YouTube indisponÃ­vel; live confirmada pelo player'
          : state.error,
        source: state.videoId ? state.source : 'iframe-player-signal'
      });
    }

    if (state.videoId) scheduleDetails(0);
    else scheduleDiscovery(0);
  }

  function publishConfirmedLive(video, source) {
    const details = video?.liveStreamingDetails || {};
    savePlayerLock(video.id);
    consecutivePlayerMisses = 0;

    publishState({
      isLive: true,
      viewers: details.concurrentViewers == null
        ? normalizeViewers(state.viewers, null)
        : normalizeViewers(details.concurrentViewers, null),
      videoId: video.id,
      liveChatId: details.activeLiveChatId || null,
      title: video?.snippet?.title || state.title || '',
      error: null,
      source
    });

    scheduleDetails(DETAILS_POLL_MS);
    ensureChatElection();
  }

  function publishOfflineFromPlayer(error = null) {
    // No API response can call this. Offline is accepted only after the player
    // has continuously failed to return a video ID for the configured window.
    if (hasRecentPlayerLock() || hasRecentPlayerSignal()) return false;
    if (consecutivePlayerMisses < PLAYER_MISS_LIMIT) return false;

    clearPlayerLock();
    clearPlayerSignal();
    consecutivePlayerMisses = 0;
    publishState({
      isLive: false,
      viewers: 0,
      videoId: null,
      liveChatId: null,
      title: '',
      error,
      source: 'player-missing'
    });
    return true;
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

  async function backendGet(endpoint, params = {}) {
    const blockedUntil = currentApiBlock();

    if (Date.now() < blockedUntil) {
      const error = new Error(
        'YouTube backend temporariamente limitado'
      );

      error.status = 429;
      error.reason = 'localRateLimit';
      throw error;
    }

    const url = new URL(
      BACKEND_BASE_URL + endpoint
    );

    for (const [key, value] of Object.entries(params || {})) {
      if (
        value !== null &&
        value !== undefined &&
        value !== ''
      ) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url.toString(), {
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    });

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      const reason =
        data?.reason ||
        data?.error?.errors?.[0]?.reason ||
        data?.error ||
        null;

      const error = new Error(
        typeof data?.error === 'string'
          ? data.error
          : 'YouTube backend ' + response.status
      );

      error.status = response.status;
      error.reason = reason;

      lastApiError = {
        status: response.status,
        reason,
        message: error.message,
        at: Date.now()
      };

      if (
        response.status === 429 ||
        reason === 'rateLimitExceeded'
      ) {
        registerApiRateLimit();
      }

      throw error;
    }

    registerApiSuccess();
    lastApiError = null;

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
    if (!stateLeader) return;

    detailsTimer = setTimeout(
      refreshVideoDetails,
      Math.max(0, delay)
    );
  }

  async function refreshVideoDetails() {
    if (!stateLeader || detailsInFlight) return;

    if (!apiAvailable()) {
      scheduleDetails(
        Math.max(
          5000,
          currentApiBlock() - Date.now()
        )
      );

      return;
    }

    detailsInFlight = true;

    try {
      const data = await backendGet(
        STATUS_ENDPOINT
      );

      if (!stateLeader) return;

      const backendVideoId =
        normalizeVideoId(data?.videoId);

      if (data?.isLive === true) {
        const sameVideo = Boolean(
          backendVideoId &&
          state.videoId === backendVideoId
        );

        const backendViewers =
          normalizeViewers(
            data?.viewers,
            sameVideo
              ? normalizeViewers(state.viewers, null)
              : null
          );

        if (backendVideoId) {
          savePlayerLock(backendVideoId);
          savePlayerSignal();
          consecutivePlayerMisses = 0;
        }

        publishState({
          isLive: true,
          viewers: backendViewers,
          videoId:
            backendVideoId ||
            state.videoId ||
            null,
          liveChatId:
            data?.liveChatId ||
            state.liveChatId ||
            null,
          title:
            data?.title ||
            state.title ||
            '',
          error: data?.error || null,
          source:
            'backend:' +
            (data?.source || 'youtube-status')
        });

        ensureChatElection();
      } else if (
        state.isLive &&
        (
          hasRecentPlayerLock() ||
          hasRecentPlayerSignal()
        )
      ) {
        publishState({
          ...state,
          isLive: true,
          error:
            'Backend sem live; confirmaÃ§Ã£o local ainda ativa',
          source:
            state.source ||
            'iframe-fallback'
        });
      }

      scheduleDetails(DETAILS_POLL_MS);
    } catch (error) {
      if (!stateLeader) return;

      publishState({
        ...state,
        error:
          'Backend OAuth temporariamente indisponÃ­vel; ' +
          'iframe e oEmbed continuam ativos',
        source:
          state.source ||
          'iframe-fallback'
      });

      scheduleDetails(10000);
    } finally {
      detailsInFlight = false;
    }
  }

  function readPlayerSignal() {
    if (!playerReady || !player) {
      return {
        rawVideoId: null,
        playerState: null,
        placeholderLive: false
      };
    }

    let rawVideoId = null;
    let playerState = null;

    try {
      const data = player.getVideoData ? player.getVideoData() : null;
      rawVideoId = String(data?.video_id || '').trim() || null;
    } catch (_) {}

    try {
      playerState = Number(player.getPlayerState ? player.getPlayerState() : NaN);
      if (!Number.isFinite(playerState)) playerState = null;
    } catch (_) {}

    const recentError = lastPlayerErrorAt > 0 &&
      Date.now() - lastPlayerErrorAt < 60000;

    return {
      rawVideoId,
      playerState,
      placeholderLive:
        rawVideoId === 'live_stream' &&
        !recentError &&
        playerState !== 0
    };
  }

  function extractPlayerVideoId() {
    if (!playerReady || !player) return null;

    const candidates = [];

    try {
      const data = player.getVideoData ? player.getVideoData() : null;
      candidates.push(data?.video_id);
    } catch (_) {}

    try {
      const videoUrl = player.getVideoUrl ? player.getVideoUrl() : '';
      if (videoUrl) {
        const parsed = new URL(videoUrl, global.location.href);
        candidates.push(parsed.searchParams.get('v'));
        const pathMatch = parsed.pathname.match(/\/(?:embed|live)\/([a-zA-Z0-9_-]{11})/);
        if (pathMatch?.[1]) candidates.push(pathMatch[1]);
      }
    } catch (_) {}

    try {
      const playlist = player.getPlaylist ? player.getPlaylist() : null;
      if (Array.isArray(playlist)) candidates.push(...playlist);
    } catch (_) {}

    for (const candidate of candidates) {
      const videoId = normalizeVideoId(candidate);
      if (videoId) return videoId;
    }

    return null;
  }

  function probePlayer() {
    if (!stateLeader) return;

    const signal = readPlayerSignal();
    const videoId = extractPlayerVideoId();

    if (videoId) {
      consecutivePlayerMisses = 0;
      activeVideoId = videoId;
      savePlayerLock(videoId);
      savePlayerSignal();

      // Avoid rebroadcasting the same live every five seconds. A state update is
      // only needed when the video changes, the state was offline, or the prior
      // source was not the player.
      if (!state.isLive || state.videoId !== videoId || state.source !== 'iframe-player') {
        publishProvisionalLive(videoId, 'iframe-player');
      } else {
        scheduleDetails(0);
      }
    } else if (signal.placeholderLive) {
      publishPlayerSignalLive();
    } else if (playerReady) {
      consecutivePlayerMisses += 1;
      const lastPositiveSignal = Math.max(
        Number(lastPlayerVideoAt || 0),
        Number(playerLock?.seenAt || 0),
        Number(lastPlayerSignalAt || 0)
      );
      const age = Date.now() - lastPositiveSignal;

      if (state.isLive && age >= PLAYER_OFFLINE_AFTER_MS) {
        publishOfflineFromPlayer(lastPlayerErrorCode
          ? `YouTube player error ${lastPlayerErrorCode}`
          : null);
      }
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
      `&enablejsapi=1&origin=${origin}&playsinline=1&controls=0&mute=1&autoplay=1`;

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
            lastPlayerErrorCode = null;
            lastPlayerErrorAt = 0;
            try {
              if (player.mute) player.mute();
              if (player.playVideo) player.playVideo();
            } catch (_) {}
            probePlayer();
            setTimeout(probePlayer, 1000);
          },
          onStateChange(event) {
            if ([1, 2, 3, 5].includes(Number(event?.data))) {
              lastPlayerErrorCode = null;
              lastPlayerErrorAt = 0;
            }
            probePlayer();
          },
          onError(event) {
            playerReady = true;
            lastPlayerErrorCode = Number(event?.data || 0) || null;
            lastPlayerErrorAt = Date.now();
            schedulePlayerProbe(PLAYER_PROBE_MS);
          }
        }
      });
    } catch (_) {
      playerInitStarted = false;
      schedulePlayerProbe(PLAYER_PROBE_MS);
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

  function scheduleDiscovery(delay) {
    if (discoveryTimer) clearTimeout(discoveryTimer);
    if (!stateLeader || !state.isLive || state.videoId) return;
    discoveryTimer = setTimeout(discoverLiveFromChannel, Math.max(0, delay));
  }

  async function discoverLiveFromChannel() {
    if (
      !stateLeader ||
      discoveryInFlight
    ) {
      return;
    }

    discoveryInFlight = true;

    try {
      await refreshVideoDetails();

      if (
        stateLeader &&
        state.isLive &&
        !state.videoId
      ) {
        const videoId =
          await discoverFromOEmbed();

        if (videoId) {
          publishProvisionalLive(
            videoId,
            'oembed-fallback'
          );
        }
      }
    } finally {
      discoveryInFlight = false;

      if (
        stateLeader &&
        state.isLive &&
        !state.videoId
      ) {
        scheduleDiscovery(
          DISCOVERY_POLL_MS
        );
      }
    }
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
    } else if (state.isLive && !state.videoId) {
      scheduleDiscovery(0);
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
    scheduleDetails(0);
    scheduleOEmbedProbe(0);

    if (
      state.isLive &&
      !state.videoId
    ) {
      scheduleDiscovery(0);
    }
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
    for (const timer of [playerProbeTimer, oembedTimer, detailsTimer, discoveryTimer]) {
      if (timer) clearTimeout(timer);
    }
    playerProbeTimer = oembedTimer = detailsTimer = discoveryTimer = null;
  }

  function becomeStateLeader() {
    if (stateLeader) return;

    stateLeader = true;

    activeVideoId = normalizeVideoId(
      safeGet(VIDEO_KEY) ||
      state.videoId
    );

    if (!activeVideoId) {
      safeRemove(VIDEO_KEY);
    }

    loadIframeApi();
    schedulePlayerProbe(1000);
    scheduleDetails(0);
    scheduleOEmbedProbe(1000);

    if (
      state.isLive &&
      !activeVideoId
    ) {
      scheduleDiscovery(1000);
    }
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

  function scheduleChatPoll(delay) {
    if (chatTimer) clearTimeout(chatTimer);

    if (
      !chatLeader ||
      !hasChatDemand()
    ) {
      chatTimer = null;
      return;
    }

    chatTimer = setTimeout(() => {
      chatTimer = null;
      pollChat();
    }, Math.max(0, delay));
  }

  function startChatForCurrentState() {
    if (
      !chatLeader ||
      !hasChatDemand()
    ) {
      return;
    }

    scheduleChatPoll(0);
  }

  async function pollChat() {
    if (
      !chatLeader ||
      !hasChatDemand()
    ) {
      return;
    }

    try {
      const params = {};

      if (liveChatPageToken) {
        params.pageToken =
          liveChatPageToken;
      }

      const data = await backendGet(
        CHAT_ENDPOINT,
        params
      );

      if (!chatLeader) return;

      activeChatId =
        data?.liveChatId ||
        null;

      if (data?.chatAvailable !== true) {
        liveChatPageToken = null;
        scheduleChatPoll(
          Number(
            data?.pollingIntervalMillis ||
            5000
          )
        );

        return;
      }

      liveChatPageToken =
        data?.nextPageToken ||
        null;

      for (const item of data?.items || []) {
        if (
          !item?.id ||
          seenApiItemIds.has(item.id)
        ) {
          continue;
        }

        seenApiItemIds.add(item.id);

        setTimeout(
          () => seenApiItemIds.delete(item.id),
          30 * 60 * 1000
        );

        const message =
          messageFromItem(item);

        if (message) {
          broadcast('chat', message);
        }

        const event =
          eventFromItem(item);

        if (event) {
          broadcast('event', event);
        }
      }

      const delay = Math.min(
        MAX_CHAT_POLL_MS,
        Math.max(
          MIN_CHAT_POLL_MS,
          Number(
            data?.pollingIntervalMillis ||
            5000
          )
        )
      );

      scheduleChatPoll(delay);
    } catch (error) {
      if (!chatLeader) return;

      activeChatId = null;

      if (
        error.status === 429 ||
        error.reason === 'rateLimitExceeded' ||
        error.reason === 'localRateLimit'
      ) {
        scheduleChatPoll(
          Math.max(
            5000,
            currentApiBlock() - Date.now()
          )
        );
      } else {
        scheduleChatPoll(10000);
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
        version: '3.0',
        instanceId,
        stateLeader,
        chatLeader,
        playerReady,
        playerSignal: readPlayerSignal(),
        playerVideoId: extractPlayerVideoId(),
        lastPlayerErrorCode,
        lastPlayerErrorAt,
        lastPlayerSignalAt,
        discoveryInFlight,
        consecutivePlayerMisses,
        lastPlayerVideoAt,
        playerLock,
        activeVideoId,
        activeChatId,
        apiBlockedUntil: currentApiBlock(),
        lastApiError,
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
    version: '3.0'
  };

  start();
})(window);
