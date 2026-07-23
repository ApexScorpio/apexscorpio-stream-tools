/**
 * ApexScorpio Twitch EventSub bridge v2.
 *
 * The dashboard owns the Twitch OAuth token. Tokens stay in sessionStorage and
 * are never published to the overlays or public MQTT topics.
 */
(function (global) {
  'use strict';

  const CHANNEL_LOGIN = 'apexscorpio';
  const REDIRECT_URI = 'https://apexscorpio.github.io/apexscorpio-stream-tools/';
  const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
  const CLIENT_ID_KEY = 'apex_twitch_client_id';
  const TOKEN_KEY = 'apex_twitch_access_token';
  const OAUTH_STATE_KEY = 'apex_twitch_oauth_state';
  const HISTORY_SYNC_MS = 5 * 60 * 1000;
  const REQUIRED_SCOPES = [
    'user:read:chat',
    'moderator:read:followers',
    'channel:read:subscriptions',
    'bits:read'
  ];

  let clientId = '';
  let accessToken = '';
  let authenticatedUser = null;
  let broadcaster = null;
  let activeSocket = null;
  let reconnectTimer = null;
  let historyTimer = null;
  let stoppedByUser = false;
  let subscriptionSummary = { active: 0, total: 0 };
  const seenMessageIds = new Set();

  const $ = id => document.getElementById(id);

  function setStatus(text, state = 'idle') {
    const element = $('twitch-auth-status');
    if (!element) return;
    const colors = {
      idle: '#94A3B8', loading: '#F59E0B', success: '#10B981',
      warning: '#F59E0B', error: '#F87171'
    };
    element.style.color = colors[state] || colors.idle;
    element.textContent = text;
  }

  function updateControls(connected) {
    const loginButton = $('btn-twitch-login');
    const logoutButton = $('btn-twitch-logout');
    const clientInput = $('twitch-client-id');
    if (loginButton) {
      loginButton.style.display = connected ? 'none' : 'inline-flex';
      loginButton.textContent = clientId ? 'Ligar Twitch' : 'Configurar Twitch';
    }
    if (logoutButton) logoutButton.style.display = connected ? 'inline-flex' : 'none';
    if (clientInput) {
      clientInput.value = clientId;
      clientInput.style.display = connected ? 'none' : 'block';
    }
  }

  function randomState() {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return Array.from(values, value => value.toString(16).padStart(8, '0')).join('');
  }

  function cleanOAuthHash() {
    if (!global.location.hash) return;
    global.history.replaceState(null, document.title, global.location.pathname + global.location.search);
  }

  function readOAuthResponse() {
    const hash = new URLSearchParams(global.location.hash.replace(/^#/, ''));
    if (!hash.has('access_token') && !hash.has('error')) return;
    const returnedState = hash.get('state') || '';
    const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY) || '';
    sessionStorage.removeItem(OAUTH_STATE_KEY);

    if (hash.has('error')) {
      cleanOAuthHash();
      setStatus('Twitch não autorizada. Tente novamente.', 'error');
      return;
    }
    if (!expectedState || returnedState !== expectedState) {
      cleanOAuthHash();
      setStatus('A autenticação Twitch não pôde ser validada.', 'error');
      return;
    }
    accessToken = hash.get('access_token') || '';
    if (accessToken) sessionStorage.setItem(TOKEN_KEY, accessToken);
    cleanOAuthHash();
  }

  async function validateToken() {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${accessToken}` }
    });
    if (!response.ok) throw new Error('invalid_token');
    const data = await response.json();
    if (!data.client_id || !data.user_id) throw new Error('invalid_token');
    if (clientId && data.client_id !== clientId) throw new Error('client_mismatch');
    clientId = data.client_id;
    localStorage.setItem(CLIENT_ID_KEY, clientId);
    return {
      id: data.user_id,
      login: data.login || '',
      scopes: Array.isArray(data.scopes) ? data.scopes : []
    };
  }

  async function helixGet(path) {
    const response = await fetch(`https://api.twitch.tv/helix${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId
      },
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Twitch API ${response.status}`);
    return data;
  }

  async function resolveBroadcaster() {
    const data = await helixGet(`/users?login=${encodeURIComponent(CHANNEL_LOGIN)}`);
    const user = data?.data?.[0];
    if (!user) throw new Error('channel_not_found');
    return { id: user.id, login: user.login, name: user.display_name || user.login };
  }

  function grantedScopes() {
    return new Set(authenticatedUser?.scopes || []);
  }

  function subscriptionDefinitions(sessionId) {
    const transport = { method: 'websocket', session_id: sessionId };
    return [
      {
        label: 'chat', type: 'channel.chat.message', version: '1', scope: 'user:read:chat',
        condition: { broadcaster_user_id: broadcaster.id, user_id: authenticatedUser.id }, transport
      },
      {
        label: 'followers', type: 'channel.follow', version: '2', scope: 'moderator:read:followers',
        condition: { broadcaster_user_id: broadcaster.id, moderator_user_id: authenticatedUser.id }, transport
      },
      {
        label: 'subs', type: 'channel.subscribe', version: '1', scope: 'channel:read:subscriptions',
        condition: { broadcaster_user_id: broadcaster.id }, transport
      },
      {
        label: 'gift subs', type: 'channel.subscription.gift', version: '1', scope: 'channel:read:subscriptions',
        condition: { broadcaster_user_id: broadcaster.id }, transport
      },
      {
        label: 'resubs', type: 'channel.subscription.message', version: '1', scope: 'channel:read:subscriptions',
        condition: { broadcaster_user_id: broadcaster.id }, transport
      },
      {
        label: 'raids', type: 'channel.raid', version: '1', scope: null,
        condition: { to_broadcaster_user_id: broadcaster.id }, transport
      },
      {
        label: 'bits', type: 'channel.cheer', version: '1', scope: 'bits:read',
        condition: { broadcaster_user_id: broadcaster.id }, transport
      }
    ];
  }

  async function createSubscription(definition) {
    if (definition.scope && !grantedScopes().has(definition.scope)) {
      return { ok: false, label: definition.label, reason: 'missing_scope' };
    }
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: definition.type,
        version: definition.version,
        condition: definition.condition,
        transport: definition.transport
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, label: definition.label, reason: data.message || `HTTP ${response.status}` };
    return { ok: true, label: definition.label };
  }

  async function subscribeToEvents(sessionId) {
    const definitions = subscriptionDefinitions(sessionId);
    const results = [];
    // Twitch requires subscriptions soon after the welcome message. Requests are
    // parallel so all are created inside that window.
    results.push(...await Promise.all(definitions.map(createSubscription)));
    const active = results.filter(result => result.ok).length;
    subscriptionSummary = { active, total: definitions.length };

    if (active === definitions.length) {
      setStatus(`Twitch ligada: @${authenticatedUser.login} · chat + eventos ativos`, 'success');
    } else if (active > 0) {
      setStatus(`Twitch ligada: ${active}/${definitions.length} ligações ativas`, 'warning');
    } else {
      setStatus('Twitch ligada, mas sem permissões para chat/eventos.', 'error');
    }
    updateControls(true);
    results.filter(result => !result.ok).forEach(result => {
      console.warn(`[Twitch EventSub] ${result.label}: ${result.reason}`);
    });
  }

  function broadcast(type, payload) {
    if (typeof global.broadcastEvent === 'function') global.broadcastEvent(type, payload);
  }

  async function syncRecentFollowers() {
    if (!broadcaster || !authenticatedUser || !grantedScopes().has('moderator:read:followers')) return;
    try {
      const data = await helixGet(`/channels/followers?broadcaster_id=${encodeURIComponent(broadcaster.id)}&first=100`);
      const events = (data.data || []).map(follower => ({
        id: `tw-follow-${follower.user_id}-${follower.followed_at}`,
        type: 'follower',
        username: follower.user_name || follower.user_login || 'Twitch Viewer',
        platform: 'twitch',
        timestamp: follower.followed_at,
        source: 'twitch-followers-api',
        isTest: false
      }));
      broadcast('event_history_sync', {
        events,
        source: 'twitch-followers-api',
        generatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.warn('[Twitch EventSub] Não foi possível sincronizar seguidores recentes:', error.message);
    }
  }

  function scheduleHistorySync() {
    if (historyTimer) clearInterval(historyTimer);
    syncRecentFollowers();
    historyTimer = setInterval(syncRecentFollowers, HISTORY_SYNC_MS);
  }

  function rememberMessage(messageId) {
    if (!messageId) return false;
    if (seenMessageIds.has(messageId)) return true;
    seenMessageIds.add(messageId);
    setTimeout(() => seenMessageIds.delete(messageId), 120000);
    return false;
  }

  function relayChat(event, metadata) {
    const badges = Array.isArray(event.badges) ? event.badges : [];
    const badgeNames = new Set(badges.map(badge => badge.set_id));
    const payload = {
      id: event.message_id || metadata.message_id,
      platform: 'twitch',
      username: event.chatter_user_name || event.chatter_user_login || 'Twitch Viewer',
      userColor: event.color || '#9146FF',
      message: event.message?.text || '',
      badges: {
        broadcaster: badgeNames.has('broadcaster'),
        mod: badgeNames.has('moderator'),
        subscriber: badgeNames.has('subscriber') || badgeNames.has('founder')
      },
      isTest: false,
      timestamp: metadata.message_timestamp || new Date().toISOString()
    };
    if (payload.message) broadcast('chat_message', payload);
  }

  function relayEvent(type, event, metadata) {
    const base = {
      id: metadata.message_id,
      platform: 'twitch',
      isTest: false,
      timestamp: metadata.message_timestamp || new Date().toISOString()
    };
    let payload = null;

    if (type === 'channel.follow') {
      payload = { ...base, type: 'follower', username: event.user_name || event.user_login || 'Twitch Viewer' };
    } else if (type === 'channel.subscribe') {
      if (event.is_gift) return;
      payload = { ...base, type: 'subscriber', username: event.user_name || event.user_login || 'Twitch Viewer' };
    } else if (type === 'channel.subscription.gift') {
      payload = {
        ...base,
        type: 'gift_subscriber',
        username: event.is_anonymous ? 'Anonymous Gifter' : (event.user_name || event.user_login || 'Twitch Gifter'),
        giftCount: Number(event.total || 0)
      };
    } else if (type === 'channel.subscription.message') {
      payload = {
        ...base,
        type: 'membership',
        username: event.user_name || event.user_login || 'Twitch Subscriber',
        months: Number(event.cumulative_months || event.duration_months || 0),
        message: event.message?.text || ''
      };
    } else if (type === 'channel.raid') {
      payload = {
        ...base,
        type: 'raid',
        username: event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'Twitch Raider',
        viewers: Number(event.viewers || 0)
      };
    } else if (type === 'channel.cheer') {
      payload = {
        ...base,
        type: 'cheer',
        username: event.is_anonymous ? 'Anonymous Cheer' : (event.user_name || event.user_login || 'Twitch Viewer'),
        amount: `${Number(event.bits || 0)} Bits`,
        bits: Number(event.bits || 0),
        message: event.message || ''
      };
    }
    if (payload) broadcast('new_event', payload);
  }

  function handleNotification(data) {
    const metadata = data.metadata || {};
    if (rememberMessage(metadata.message_id)) return;
    const event = data.payload?.event || {};
    const type = metadata.subscription_type || data.payload?.subscription?.type || '';
    if (type === 'channel.chat.message') relayChat(event, metadata);
    else relayEvent(type, event, metadata);
  }

  function scheduleReconnect() {
    if (stoppedByUser || !accessToken) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    setStatus('Twitch a restabelecer ligação…', 'loading');
    reconnectTimer = setTimeout(() => connectEventSub(EVENTSUB_URL, false, null), 4000);
  }

  function connectEventSub(url = EVENTSUB_URL, migrating = false, previousSocket = null) {
    if (!accessToken || !authenticatedUser || !broadcaster) return;
    const socket = new WebSocket(url);
    if (!migrating) activeSocket = socket;

    socket.addEventListener('open', () => {
      setStatus('Twitch ligada; a ativar chat e eventos…', 'loading');
    });
    socket.addEventListener('message', async message => {
      let data;
      try { data = JSON.parse(message.data); } catch (_) { return; }
      const messageType = data?.metadata?.message_type;
      if (messageType === 'session_welcome') {
        const session = data.payload?.session;
        if (!session?.id) return;
        if (migrating) {
          activeSocket = socket;
          if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close(1000, 'migrated');
          setStatus(`Twitch ligada: @${authenticatedUser.login} · chat + eventos ativos`, 'success');
          updateControls(true);
        } else {
          await subscribeToEvents(session.id);
          scheduleHistorySync();
        }
      } else if (messageType === 'notification') {
        handleNotification(data);
      } else if (messageType === 'session_reconnect') {
        const reconnectUrl = data.payload?.session?.reconnect_url;
        if (reconnectUrl) connectEventSub(reconnectUrl, true, socket);
      } else if (messageType === 'revocation') {
        const revokedType = data.payload?.subscription?.type || 'evento';
        setStatus(`Permissão Twitch revogada: ${revokedType}. Volte a ligar.`, 'warning');
      }
    });
    socket.addEventListener('close', () => {
      if (socket === activeSocket && !migrating) scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (socket === activeSocket) setStatus('Falha temporária na ligação Twitch.', 'warning');
    });
  }

  async function startBridge() {
    if (!accessToken || !clientId) {
      updateControls(false);
      setStatus(clientId ? 'Twitch pronta para autenticar.' : 'Twitch não ligada · indique o Client ID uma vez.', 'idle');
      return;
    }
    try {
      setStatus('A validar a conta Twitch…', 'loading');
      authenticatedUser = await validateToken();
      broadcaster = await resolveBroadcaster();
      stoppedByUser = false;
      updateControls(true);
      connectEventSub();
    } catch (error) {
      console.warn('[Twitch EventSub] Authentication failed:', error.message);
      sessionStorage.removeItem(TOKEN_KEY);
      accessToken = '';
      authenticatedUser = null;
      broadcaster = null;
      updateControls(false);
      setStatus(error.message === 'client_mismatch'
        ? 'O Client ID não corresponde à autorização. Volte a ligar.'
        : 'A sessão Twitch expirou. Volte a ligar.', 'warning');
    }
  }

  global.twitchOAuthLogin = function twitchOAuthLogin() {
    const input = $('twitch-client-id');
    const enteredClientId = ((input && input.value) || clientId || '').trim();
    if (!/^[a-z0-9]{10,64}$/i.test(enteredClientId)) {
      setStatus('Cole primeiro o Client ID da aplicação Twitch.', 'error');
      if (input) input.focus();
      return;
    }
    clientId = enteredClientId;
    localStorage.setItem(CLIENT_ID_KEY, clientId);
    const state = randomState();
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
    const params = new URLSearchParams({
      response_type: 'token',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: REQUIRED_SCOPES.join(' '),
      state,
      force_verify: 'true'
    });
    global.location.assign(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  };

  global.twitchOAuthLogout = function twitchOAuthLogout() {
    stoppedByUser = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (historyTimer) clearInterval(historyTimer);
    reconnectTimer = historyTimer = null;
    if (activeSocket) {
      try { activeSocket.close(1000, 'user disconnected'); } catch (_) {}
    }
    activeSocket = null;
    accessToken = '';
    authenticatedUser = null;
    broadcaster = null;
    subscriptionSummary = { active: 0, total: 0 };
    sessionStorage.removeItem(TOKEN_KEY);
    updateControls(false);
    setStatus('Twitch desligada. O Client ID ficou guardado.', 'idle');
  };

  function init() {
    clientId = (localStorage.getItem(CLIENT_ID_KEY) || '').trim();
    accessToken = sessionStorage.getItem(TOKEN_KEY) || '';
    const input = $('twitch-client-id');
    if (input) {
      input.value = clientId;
      input.addEventListener('change', () => {
        const value = input.value.trim();
        if (value) localStorage.setItem(CLIENT_ID_KEY, value);
      });
    }
    readOAuthResponse();
    startBridge();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
