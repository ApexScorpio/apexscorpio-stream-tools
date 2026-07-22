/**
 * ApexScorpio Twitch EventSub bridge.
 *
 * The dashboard owns the Twitch user token and relays notifications to the
 * public SLOBS sources through the existing broadcastEvent/MQTT bridge.
 * No token is ever sent to an overlay or to the MQTT brokers.
 */
(function (global) {
  'use strict';

  const CHANNEL_LOGIN = 'apexscorpio';
  const REDIRECT_URI = 'https://apexscorpio.github.io/apexscorpio-stream-tools/';
  const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
  const CLIENT_ID_KEY = 'apex_twitch_client_id';
  const TOKEN_KEY = 'apex_twitch_access_token';
  const OAUTH_STATE_KEY = 'apex_twitch_oauth_state';
  const REQUIRED_SCOPES = [
    'user:read:chat',
    'moderator:read:followers',
    'channel:read:subscriptions'
  ];

  let clientId = '';
  let accessToken = '';
  let authenticatedUser = null;
  let broadcaster = null;
  let activeSocket = null;
  let reconnectTimer = null;
  let stoppedByUser = false;
  let subscriptionSummary = { active: 0, total: 0 };
  const seenMessageIds = new Set();

  const $ = (id) => document.getElementById(id);

  function setStatus(text, state = 'idle') {
    const el = $('twitch-auth-status');
    if (!el) return;
    const colors = {
      idle: '#94A3B8',
      loading: '#F59E0B',
      success: '#10B981',
      warning: '#F59E0B',
      error: '#F87171'
    };
    el.style.color = colors[state] || colors.idle;
    el.textContent = text;
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
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Twitch API ${response.status}`);
    return data;
  }

  async function resolveBroadcaster() {
    const data = await helixGet(`/users?login=${encodeURIComponent(CHANNEL_LOGIN)}`);
    const user = data && data.data && data.data[0];
    if (!user) throw new Error('channel_not_found');
    return { id: user.id, login: user.login, name: user.display_name || user.login };
  }

  function subscriptionDefinitions(sessionId) {
    const common = { method: 'websocket', session_id: sessionId };
    return [
      {
        label: 'chat',
        type: 'channel.chat.message',
        version: '1',
        scope: 'user:read:chat',
        condition: { broadcaster_user_id: broadcaster.id, user_id: authenticatedUser.id },
        transport: common
      },
      {
        label: 'followers',
        type: 'channel.follow',
        version: '2',
        scope: 'moderator:read:followers',
        condition: { broadcaster_user_id: broadcaster.id, moderator_user_id: authenticatedUser.id },
        transport: common
      },
      {
        label: 'subs',
        type: 'channel.subscribe',
        version: '1',
        scope: 'channel:read:subscriptions',
        condition: { broadcaster_user_id: broadcaster.id },
        transport: common
      },
      {
        label: 'gift subs',
        type: 'channel.subscription.gift',
        version: '1',
        scope: 'channel:read:subscriptions',
        condition: { broadcaster_user_id: broadcaster.id },
        transport: common
      },
      {
        label: 'resubs',
        type: 'channel.subscription.message',
        version: '1',
        scope: 'channel:read:subscriptions',
        condition: { broadcaster_user_id: broadcaster.id },
        transport: common
      },
      {
        label: 'raids',
        type: 'channel.raid',
        version: '1',
        scope: null,
        condition: { to_broadcaster_user_id: broadcaster.id },
        transport: common
      }
    ];
  }

  async function createSubscription(definition) {
    const grantedScopes = new Set(authenticatedUser.scopes || []);
    if (definition.scope && !grantedScopes.has(definition.scope)) {
      return { ok: false, label: definition.label, reason: 'missing_scope' };
    }

    const body = {
      type: definition.type,
      version: definition.version,
      condition: definition.condition,
      transport: definition.transport
    };
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, label: definition.label, reason: data.message || `HTTP ${response.status}` };
    }
    return { ok: true, label: definition.label };
  }

  async function subscribeToEvents(sessionId) {
    const definitions = subscriptionDefinitions(sessionId);
    const results = await Promise.all(definitions.map(definition => createSubscription(definition)));
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
    const message = {
      id: event.message_id || metadata.message_id,
      platform: 'twitch',
      username: event.chatter_user_name || event.chatter_user_login || 'Twitch Viewer',
      userColor: event.color || '#9146FF',
      message: (event.message && event.message.text) || '',
      badges: {
        broadcaster: badgeNames.has('broadcaster'),
        mod: badgeNames.has('moderator'),
        subscriber: badgeNames.has('subscriber') || badgeNames.has('founder')
      },
      isTest: false,
      timestamp: metadata.message_timestamp || new Date().toISOString()
    };
    if (message.message && typeof global.broadcastEvent === 'function') {
      global.broadcastEvent('chat_message', message);
    }
  }

  function relayEvent(type, event, metadata) {
    let username = event.user_name || event.user_login || 'Twitch Viewer';
    let viewers = 0;

    if (type === 'channel.raid') {
      username = event.from_broadcaster_user_name || event.from_broadcaster_user_login || 'Twitch Raider';
      viewers = Number(event.viewers || 0);
    } else if (type === 'channel.subscription.gift') {
      username = event.is_anonymous ? 'Anonymous Gifter' : (event.user_name || event.user_login || 'Twitch Gifter');
    }

    const mappedType = type === 'channel.follow' ? 'follower'
      : type === 'channel.raid' ? 'raid'
      : 'subscriber';

    // Gift recipients also emit channel.subscribe; the gift notification is the
    // useful aggregate event, so skip the duplicate recipient alert.
    if (type === 'channel.subscribe' && event.is_gift) return;

    const payload = {
      id: metadata.message_id,
      type: mappedType,
      username,
      platform: 'twitch',
      viewers,
      giftCount: Number(event.total || 0),
      isTest: false,
      timestamp: metadata.message_timestamp || new Date().toISOString()
    };
    if (typeof global.broadcastEvent === 'function') {
      global.broadcastEvent('new_event', payload);
    }
  }

  function handleNotification(data) {
    const metadata = data.metadata || {};
    if (rememberMessage(metadata.message_id)) return;
    const event = (data.payload && data.payload.event) || {};
    const type = metadata.subscription_type || (data.payload && data.payload.subscription && data.payload.subscription.type) || '';
    if (type === 'channel.chat.message') relayChat(event, metadata);
    else if (type === 'channel.follow' || type === 'channel.subscribe' ||
      type === 'channel.subscription.gift' || type === 'channel.subscription.message' ||
      type === 'channel.raid') relayEvent(type, event, metadata);
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

    socket.addEventListener('message', async (message) => {
      let data;
      try { data = JSON.parse(message.data); } catch (_) { return; }
      const messageType = data && data.metadata && data.metadata.message_type;

      if (messageType === 'session_welcome') {
        const session = data.payload && data.payload.session;
        if (!session || !session.id) return;
        if (migrating) {
          activeSocket = socket;
          if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) previousSocket.close(1000, 'migrated');
          setStatus(`Twitch ligada: @${authenticatedUser.login} · chat + eventos ativos`, 'success');
          updateControls(true);
        } else {
          await subscribeToEvents(session.id);
        }
      } else if (messageType === 'notification') {
        handleNotification(data);
      } else if (messageType === 'session_reconnect') {
        const reconnectUrl = data.payload && data.payload.session && data.payload.session.reconnect_url;
        if (reconnectUrl) connectEventSub(reconnectUrl, true, socket);
      } else if (messageType === 'revocation') {
        setStatus('Uma permissão Twitch foi revogada. Volte a ligar.', 'warning');
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
      const message = error.message === 'client_mismatch'
        ? 'O Client ID não corresponde à autorização. Volte a ligar.'
        : 'A sessão Twitch expirou. Volte a ligar.';
      setStatus(message, 'warning');
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
    reconnectTimer = null;
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
