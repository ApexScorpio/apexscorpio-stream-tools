(function () {
  'use strict';

  const bar = document.getElementById('viewers-bar');
  const pills = {
    twitch: document.getElementById('pill-twitch'),
    youtube: document.getElementById('pill-youtube'),
    facebook: document.getElementById('pill-facebook'),
    total: document.getElementById('pill-total')
  };
  const counts = {
    twitch: document.getElementById('count-twitch'),
    youtube: document.getElementById('count-youtube'),
    facebook: document.getElementById('count-facebook'),
    total: document.getElementById('count-total')
  };
  const dots = {
    twitch: document.getElementById('dot-twitch'),
    youtube: document.getElementById('dot-youtube'),
    facebook: document.getElementById('dot-facebook')
  };

  let cfg = {
    showTwitch: true,
    showYoutube: true,
    showFacebook: true,
    showTotal: true,
    showBg: true,
    layout: 'horizontal',
    fontSize: 15
  };
  let realState = {
    twitch: { isLive: false, viewers: 0 },
    youtube: { isLive: false, viewers: 0 },
    facebook: { isLive: false, viewers: 0 },
    totalViewers: 0
  };
  let isTestActive = false;
  let testTimer = null;

  function loadSavedConfig() {
    const params = new URLSearchParams(location.search);
    if (params.has('tw')) cfg.showTwitch = /^(1|true)$/i.test(params.get('tw'));
    if (params.has('yt')) cfg.showYoutube = /^(1|true)$/i.test(params.get('yt'));
    if (params.has('fb')) cfg.showFacebook = /^(1|true)$/i.test(params.get('fb'));
    if (params.has('tot')) cfg.showTotal = /^(1|true)$/i.test(params.get('tot'));
    if (params.has('bg')) cfg.showBg = /^(1|true)$/i.test(params.get('bg'));
    if (params.has('layout')) cfg.layout = params.get('layout');
    if (params.has('fs')) cfg.fontSize = Number(params.get('fs')) || 15;
    try {
      const saved = localStorage.getItem('apex_cfg_viewers');
      if (saved && [...params.keys()].length === 0) cfg = { ...cfg, ...JSON.parse(saved) };
    } catch (_) {}
  }

  function applyConfig() {
    pills.twitch.style.display = cfg.showTwitch ? 'inline-flex' : 'none';
    pills.youtube.style.display = cfg.showYoutube ? 'inline-flex' : 'none';
    pills.facebook.style.display = cfg.showFacebook ? 'inline-flex' : 'none';
    pills.total.style.display = cfg.showTotal ? 'inline-flex' : 'none';
    bar.className = 'viewer-counter-container';
    bar.classList.add(cfg.layout === 'vertical' ? 'layout-vertical' : 'layout-horizontal');
    bar.classList.add(cfg.showBg ? 'has-bg' : 'no-bg');
    document.querySelectorAll('.count-number').forEach(el => {
      el.style.fontSize = `${Number(cfg.fontSize) || 15}px`;
    });
  }

  function recalculateTotal() {
    realState.totalViewers = ['twitch', 'youtube', 'facebook']
      .reduce((sum, platform) => sum + Number(realState[platform]?.viewers || 0), 0);
  }

  function animateCount(element, value) {
    const formatted = Math.max(0, Number(value || 0)).toLocaleString('pt-PT');
    if (element.innerText === formatted) return;
    element.innerText = formatted;
    element.classList.remove('bump');
    void element.offsetWidth;
    element.classList.add('bump');
  }

  function renderStatus(state) {
    for (const platform of ['twitch', 'youtube', 'facebook']) {
      const current = state[platform] || { isLive: false, viewers: 0 };
      animateCount(counts[platform], current.viewers);
      dots[platform].classList.toggle('online', Boolean(current.isLive));
    }
    animateCount(counts.total, state.totalViewers || 0);
  }

  async function checkPublicTwitchLive() {
    if (isTestActive) return;
    try {
      const response = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: 'query ChannelShell($login: String!) { user(login: $login) { stream { viewersCount type } } }',
          variables: { login: 'apexscorpio' }
        })
      });
      const data = await response.json();
      const stream = data?.data?.user?.stream;
      realState.twitch = stream && stream.type === 'live'
        ? { isLive: true, viewers: Number(stream.viewersCount || 0) }
        : { isLive: false, viewers: 0 };
      recalculateTotal();
      if (!isTestActive) renderStatus(realState);
    } catch (_) {
      if (!isTestActive) renderStatus(realState);
    }
  }

  function resetToRealState() {
    isTestActive = false;
    if (testTimer) clearTimeout(testTimer);
    testTimer = null;
    checkPublicTwitchLive();
    if (window.YoutubeLive) window.YoutubeLive.refresh();
  }

  function handleIncomingData(type, payload) {
    if (!type) return;
    if (type === 'config_update') {
      const config = payload?.viewers || payload?.config || payload;
      if (config) {
        cfg = { ...cfg, ...config };
        applyConfig();
      }
      return;
    }
    if (['clear_viewers', 'reset_viewers', 'clear'].includes(type)) {
      resetToRealState();
      return;
    }
    if (type === 'status_update') {
      const incoming = payload?.state || payload;
      if (incoming?.isTest) {
        isTestActive = true;
        if (testTimer) clearTimeout(testTimer);
        renderStatus(incoming);
        testTimer = setTimeout(resetToRealState, Number(incoming.testDuration || 8) * 1000);
      } else {
        resetToRealState();
      }
    }
  }

  const bc = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('apex_scorpio_stream_tools')
    : null;
  if (bc) bc.onmessage = event => handleIncomingData(event.data?.type, event.data?.data);
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
    MQTT_BROKERS.forEach(url => {
      try {
        const client = mqtt.connect(url, {
          clientId: `scorpio_viewers_${Math.random().toString(16).slice(2, 8)}`,
          connectTimeout: 4000,
          keepalive: 30
        });
        client.on('connect', () => {
          client.subscribe('apexscorpio/streamtools/v1/cfg/#');
          client.subscribe('apexscorpio/streamtools/v1/events/#');
        });
        client.on('message', (topic, message) => {
          try {
            const data = JSON.parse(message.toString());
            if (topic.includes('/cfg/viewers')) {
              cfg = { ...cfg, ...data };
              applyConfig();
            } else if (topic.includes('clear')) {
              resetToRealState();
            } else if (data?.type || data?.payload) {
              handleIncomingData(data.type || data.payload?.type, data.payload || data);
            }
          } catch (_) {}
        });
      } catch (_) {}
    });
  }

  loadSavedConfig();
  applyConfig();
  renderStatus(realState);
  checkPublicTwitchLive();
  setInterval(checkPublicTwitchLive, 5000);

  if (window.YoutubeLive) {
    window.YoutubeLive.subscribeState(ytState => {
      realState.youtube = {
        isLive: Boolean(ytState.isLive),
        viewers: Number(ytState.viewers || 0)
      };
      recalculateTotal();
      if (!isTestActive) renderStatus(realState);
    });
  }
})();
