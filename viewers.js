/* ApexScorpio Viewers Counter Overlay v4.0 (Multi-Source Reliability) */
(function () {
  'use strict';

  const YOUTUBE_BACKEND_BASE = String(
    window.APEX_YOUTUBE_BACKEND_URL ||
    window.location.origin
  ).replace(/\/+$/, '');

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
    twitch: { isLive: false, viewers: null, status: "confirmed" },
    youtube: { isLive: false, viewers: null, status: "confirmed" },
    facebook: { isLive: false, viewers: null, status: "confirmed" },
    totalText: "0"
  };

  let isTestActive = false;
  let testTimer = null;
  let lastTwitchFetch = 0;

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
    let knownSum = 0;
    let hasNullViewerOnLive = false;
    let anyLive = false;

    for (const platform of ['twitch', 'youtube', 'facebook']) {
      const pState = realState[platform];
      if (pState && pState.isLive) {
        anyLive = true;
        if (pState.viewers !== null && pState.viewers !== undefined && !isNaN(pState.viewers)) {
          knownSum += Number(pState.viewers);
        } else {
          hasNullViewerOnLive = true;
        }
      }
    }

    if (!anyLive) {
      realState.totalText = "0";
    } else if (hasNullViewerOnLive) {
      realState.totalText = `≥${knownSum}`;
    } else {
      realState.totalText = `${knownSum}`;
    }
  }

  function animateCount(element, value) {
    if (value === null || value === undefined || value === '—') {
      element.innerText = '—';
      return;
    }
    const valueStr = String(value);
    if (valueStr.startsWith('≥')) {
      element.innerText = valueStr;
      return;
    }
    const formatted = Math.max(0, Number(value || 0)).toLocaleString('pt-PT');
    if (element.innerText === formatted) return;
    element.innerText = formatted;
    element.classList.remove('bump');
    void element.offsetWidth;
    element.classList.add('bump');
  }

  function renderStatus(state) {
    for (const platform of ['twitch', 'youtube', 'facebook']) {
      const current = state[platform] || { isLive: false, viewers: null };
      if (!current.isLive) {
        dots[platform].classList.remove('online');
        animateCount(counts[platform], 0);
      } else {
        dots[platform].classList.add('online');
        animateCount(counts[platform], current.viewers !== null ? current.viewers : '—');
      }
    }
    animateCount(counts.total, state.totalText || "0");
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
      if (stream && stream.type === 'live') {
        const rawCount = stream.viewersCount;
        const parsed = (rawCount !== null && rawCount !== undefined && !isNaN(rawCount)) ? Number(rawCount) : null;
        realState.twitch = {
          isLive: true,
          viewers: parsed,
          status: parsed !== null ? "confirmed" : "unknown"
        };
      } else {
        realState.twitch = { isLive: false, viewers: null, status: "confirmed" };
      }
      lastTwitchFetch = Date.now();
      recalculateTotal();
      if (!isTestActive) renderStatus(realState);
    } catch (_) {
      if (Date.now() - lastTwitchFetch > 30000) {
        realState.twitch.status = "stale";
        realState.twitch.viewers = null;
      }
      if (!isTestActive) renderStatus(realState);
    }
  }

  async function checkNetlifyYoutubeStatus() {
    if (isTestActive) return;
    try {
      const res = await fetch(YOUTUBE_BACKEND_BASE + '/youtube-status?cb=' + Date.now());
      if (res.ok) {
        const data = await res.json();
        realState.youtube = {
          isLive: Boolean(data.isLive),
          viewers: data.isLive ? (data.viewers !== null && data.viewers !== undefined ? Number(data.viewers) : null) : null,
          videoId: data.videoId,
          confidence: data.confidence || "none",
          viewerState: data.viewerState || "unknown"
        };
        recalculateTotal();
        if (!isTestActive) renderStatus(realState);
      }
    } catch (_) {}
  }

  function resetToRealState() {
    isTestActive = false;
    if (testTimer) clearTimeout(testTimer);
    testTimer = null;
    checkPublicTwitchLive();
    checkNetlifyYoutubeStatus();
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

  window.ApexYoutubeScrapeDebug = async function() {
    console.log('--- ApexScorpio Multi-Source Scrape Debug ---');
    try {
      const res = await fetch(YOUTUBE_BACKEND_BASE + '/youtube-status?cb=' + Date.now());
      const json = await res.json();
      console.log(JSON.stringify(json, null, 2));
      return json;
    } catch (err) {
      console.error('Debug fetch failed:', err);
      return err;
    }
  };

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
    MQTT_BROKERS.slice(0, 1).forEach(url => {
      try {
        const client = mqtt.connect(url, {
          reconnectPeriod: 0,
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
  checkNetlifyYoutubeStatus();
  setInterval(checkPublicTwitchLive, 5000);
  setInterval(checkNetlifyYoutubeStatus, 15000);

  if (window.YoutubeLive) {
    window.YoutubeLive.subscribeState(ytState => {
      if (ytState && ytState.isLive) {
        realState.youtube = {
          isLive: true,
          viewers: (ytState.viewers !== null && ytState.viewers !== undefined) ? Number(ytState.viewers) : realState.youtube.viewers,
          videoId: ytState.videoId || realState.youtube.videoId
        };
        recalculateTotal();
        if (!isTestActive) renderStatus(realState);
      }
    });
  }
})();
