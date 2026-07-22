(function () {
  'use strict';

  const feed = document.getElementById('event-feed');
  const STORAGE_KEY = 'apex_event_history_v2';
  const LEGACY_STORAGE_KEY = 'apex_permanent_events';
  const MAX_STORED_EVENTS = 100;

  let cfg = {
    showTwitch: true,
    showYoutube: true,
    showFacebook: true,
    showBg: true,
    showLogos: true,
    maxItems: 8
  };
  let history = [];
  const seenDeliveries = new Set();

  const svgIcons = {
    twitch: '<svg width="15" height="15" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.571 4.714h1.715v5.143H11.571V4.714zm4.715 0H18v5.143h-1.714V4.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0H6zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714v9.429z"/></svg>',
    youtube: '<svg width="17" height="17" viewBox="0 0 24 24" fill="#E8181F"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    facebook: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>'
  };

  function parseBoolean(value) {
    return /^(1|true)$/i.test(String(value));
  }

  function loadConfig() {
    const params = new URLSearchParams(location.search);
    if (params.has('tw')) cfg.showTwitch = parseBoolean(params.get('tw'));
    if (params.has('yt')) cfg.showYoutube = parseBoolean(params.get('yt'));
    if (params.has('fb')) cfg.showFacebook = parseBoolean(params.get('fb'));
    if (params.has('logos')) cfg.showLogos = parseBoolean(params.get('logos'));
    if (params.has('bg')) cfg.showBg = parseBoolean(params.get('bg'));
    if (params.has('max')) cfg.maxItems = Math.max(1, Number(params.get('max')) || 8);
    try {
      const saved = localStorage.getItem('apex_cfg_events');
      if (saved && [...params.keys()].length === 0) cfg = { ...cfg, ...JSON.parse(saved) };
    } catch (_) {}
  }

  function normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const platform = String(raw.platform || 'twitch').toLowerCase();
    const type = String(raw.type || 'follower').toLowerCase();
    const username = String(raw.username || raw.user_name || raw.user_login || '').trim();
    if (!username) return null;
    const timestamp = raw.timestamp || raw.followed_at || raw.publishedAt || new Date().toISOString();
    const generatedId = [platform, type, username.toLowerCase(), timestamp].join('|');
    return {
      id: String(raw.id || generatedId),
      platform,
      type,
      username,
      timestamp,
      viewers: Number(raw.viewers || 0),
      giftCount: Number(raw.giftCount || raw.gift_count || 0),
      months: Number(raw.months || 0),
      amount: String(raw.amount || ''),
      message: String(raw.message || ''),
      source: String(raw.source || ''),
      isTest: Boolean(raw.isTest)
    };
  }

  function eventTime(event) {
    const timestamp = Date.parse(event.timestamp || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function eventKey(event) {
    return event.id || [event.platform, event.type, event.username.toLowerCase(), event.timestamp].join('|');
  }

  function platformAllowed(platform) {
    if (platform === 'twitch') return cfg.showTwitch;
    if (platform === 'youtube') return cfg.showYoutube;
    if (platform === 'facebook') return cfg.showFacebook;
    return true;
  }

  function loadHistory() {
    try {
      // Purge the old HTML store because it was seeded with fabricated users.
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(parsed)) history = parsed.map(normalizeEvent).filter(Boolean);
    } catch (_) {
      history = [];
    }
    dedupeAndSort();
  }

  function saveHistory() {
    const realEvents = history.filter(event => !event.isTest).slice(0, MAX_STORED_EVENTS);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(realEvents)); } catch (_) {}
  }

  function dedupeAndSort() {
    const map = new Map();
    for (const event of history) {
      const current = map.get(eventKey(event));
      if (!current || eventTime(event) > eventTime(current)) map.set(eventKey(event), event);
    }
    history = [...map.values()].sort((a, b) => eventTime(b) - eventTime(a)).slice(0, MAX_STORED_EVENTS);
  }

  function actionText(event) {
    const platform = { twitch: 'Twitch', youtube: 'YouTube', facebook: 'Facebook' }[event.platform] || event.platform;
    switch (event.type) {
      case 'subscriber': return `tornou-se subscritor/membro no ${platform}`;
      case 'gift_subscriber': return `ofereceu ${event.giftCount || ''} subscrições no ${platform}`.replace('  ', ' ');
      case 'membership': return event.months ? `celebrou ${event.months} meses como membro` : `partilhou uma mensagem de membro`;
      case 'raid': return `entrou em raid com ${event.viewers || 0} espectadores`;
      case 'donation': return `enviou ${event.amount || 'um apoio'} no ${platform}`;
      case 'cheer': return `enviou ${event.amount || 'Bits'} no ${platform}`;
      default: return `começou a seguir no ${platform}`;
    }
  }

  function eventEmoji(type) {
    return {
      follower: '🔔', subscriber: '⭐', gift_subscriber: '🎁', membership: '💎',
      raid: '🚀', donation: '💰', cheer: '💠'
    }[type] || '🔔';
  }

  function eventClass(type) {
    if (['subscriber', 'gift_subscriber', 'membership'].includes(type)) return 'subscriber';
    if (['donation', 'cheer'].includes(type)) return 'subscriber';
    if (type === 'raid') return 'raid';
    return 'follower';
  }

  function buildCard(event) {
    const card = document.createElement('div');
    card.className = `event-card ${eventClass(event.type)} platform-${event.platform} ${event.isTest ? 'is-test-msg' : ''}`;
    card.dataset.eventId = eventKey(event);

    const badge = document.createElement('div');
    badge.className = `platform-logo-badge ${event.platform}`;
    badge.style.display = cfg.showLogos ? 'flex' : 'none';
    badge.innerHTML = svgIcons[event.platform] || svgIcons.twitch;

    const info = document.createElement('div');
    info.className = 'event-info';
    const user = document.createElement('div');
    user.className = 'event-user';
    user.textContent = `@${event.username} ${eventEmoji(event.type)}`;
    const action = document.createElement('div');
    action.className = 'event-action';
    action.textContent = actionText(event);
    info.append(user, action);
    card.append(badge, info);
    return card;
  }

  function render() {
    feed.innerHTML = '';
    feed.classList.toggle('has-bg', Boolean(cfg.showBg));
    feed.classList.toggle('no-bg', !cfg.showBg);
    const visible = history.filter(event => platformAllowed(event.platform)).slice(0, Math.max(1, Number(cfg.maxItems) || 8));
    visible.forEach(event => feed.appendChild(buildCard(event)));
  }

  function addEvent(raw, persist = true) {
    const event = normalizeEvent(raw);
    if (!event) return;
    history.unshift(event);
    dedupeAndSort();
    if (persist && !event.isTest) saveHistory();
    render();
    if (event.isTest) {
      setTimeout(() => {
        history = history.filter(item => eventKey(item) !== eventKey(event));
        render();
      }, 8000);
    }
  }

  function mergeHistory(rawEvents) {
    if (!Array.isArray(rawEvents)) return;
    history.push(...rawEvents.map(normalizeEvent).filter(Boolean));
    dedupeAndSort();
    saveHistory();
    render();
  }

  function clearEvents(onlyTests) {
    history = onlyTests ? history.filter(event => !event.isTest) : [];
    if (!onlyTests) saveHistory();
    seenDeliveries.clear();
    render();
  }

  function duplicateDelivery(type, payload) {
    const event = normalizeEvent(payload?.event || payload);
    const key = `${type}|${event ? eventKey(event) : JSON.stringify(payload)}`;
    if (seenDeliveries.has(key)) return true;
    seenDeliveries.add(key);
    setTimeout(() => seenDeliveries.delete(key), 5000);
    return false;
  }

  function handleIncomingData(type, payload) {
    if (!type) return;
    const lower = String(type).toLowerCase();
    if (lower === 'clear_events' || lower === 'clear_all') {
      clearEvents(Boolean(payload?.onlyTests ?? true));
      return;
    }
    if (type === 'config_update') {
      const config = payload?.events || payload?.config || payload;
      if (config) {
        cfg = { ...cfg, ...config };
        render();
      }
      return;
    }
    if (type === 'event_history_sync') {
      mergeHistory(payload?.events || payload);
      return;
    }
    if (type === 'new_event' && payload) {
      if (duplicateDelivery(type, payload)) return;
      const event = payload.event || payload;
      addEvent(event, true);
    }
  }

  const bc = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('apex_scorpio_stream_tools')
    : null;
  if (bc) bc.onmessage = event => handleIncomingData(event.data?.type, event.data?.data || event.data?.payload);
  window.addEventListener('message', event => handleIncomingData(event.data?.type, event.data?.data || event.data));
  window.addEventListener('storage', event => {
    if (!event.key?.startsWith('apex_event_') || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue);
      handleIncomingData(event.key.replace('apex_event_', ''), parsed.payload);
    } catch (_) {}
  });

  const MQTT_BROKERS = [
    'wss://broker.emqx.io:443/mqtt',
    'wss://broker.hivemq.com:8000/mqtt',
    'wss://broker.emqx.io:8084/mqtt'
  ];
  if (typeof mqtt !== 'undefined') {
    MQTT_BROKERS.slice(0, 1).forEach(url => {
      try {
        const client = mqtt.connect(url, {
          reconnectPeriod: 30000,
          clientId: `scorpio_events_${Math.random().toString(16).slice(2, 8)}`,
          connectTimeout: 4000,
          keepalive: 30
        });
        client.on('connect', () => client.subscribe('apexscorpio/streamtools/v1/#'));
        client.on('message', (topic, message) => {
          try {
            const data = JSON.parse(message.toString());
            if (topic.includes('/cfg/events')) {
              cfg = { ...cfg, ...data };
              render();
            } else if (data?.type || data?.payload) {
              handleIncomingData(data.type || data.payload?.type, data.payload || data);
            }
          } catch (_) {}
        });
      } catch (_) {}
    });
  }

  loadConfig();
  loadHistory();
  render();

  if (window.YoutubeLive) {
    window.YoutubeLive.startChat(null, event => addEvent(event, true));
  }
})();
