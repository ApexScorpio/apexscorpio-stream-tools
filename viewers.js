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
  let lastYoutubeFetch=0;
  let lastFacebookUpdate=0;

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
      const enabled = { twitch: cfg.showTwitch, youtube: cfg.showYoutube, facebook: cfg.showFacebook };
      if (enabled[platform] === false) continue;
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
      if (current.isLive) {
        pills[platform].title = 'Live: ' + (current.viewers !== null ? current.viewers : '—') + ' espectadores';
        dots[platform].classList.add('online');
        animateCount(counts[platform], current.viewers !== null ? current.viewers : '—');
      } else {
        pills[platform].title = 'Canal offline';
        dots[platform].classList.remove('online');
        animateCount(counts[platform], 0);
      }
    }
    animateCount(counts.total, state.totalText || "0");
  }

  function readTwitchViewerState(data) {
    const user=data?.data?.user;
    if(data?.errors?.length || !user || !Object.hasOwn(user,'stream'))throw new Error('Estado Twitch indisponível');
    if(user.stream===null)return {isLive:false,viewers:null,status:'confirmed'};
    const stream=user.stream;
    if(!stream || stream.type!=='live')throw new Error('Resposta Twitch incompleta');
    const value=stream.viewersCount;
    const numeric=(typeof value==='number' || (typeof value==='string' && /^\d+$/.test(value)))?Number(value):null;
    const count=Number.isSafeInteger(numeric) && numeric>=0?numeric:null;
    return {isLive:true,viewers:count,status:count===null?'unknown':'confirmed'};
  }
  let twitchFetchInFlight=false;
  async function checkPublicTwitchLive() {
    if(isTestActive || twitchFetchInFlight)return;
    twitchFetchInFlight=true;
    const controller=typeof AbortController==='function'?new AbortController():null;
    const timeout=controller?setTimeout(()=>controller.abort(),8000):null;
    try {
      const response=await fetch('https://gql.twitch.tv/gql',{
        method:'POST',
        signal:controller?.signal,
        headers:{'Client-ID':'kimne78kx3ncx6brgo4mv6wki5h1ko','Content-Type':'application/json'},
        body:JSON.stringify({query:'query ChannelShell($login: String!) { user(login: $login) { stream { viewersCount type } } }',variables:{login:'apexscorpio'}})
      });
      if(!response.ok)throw new Error('Twitch HTTP '+response.status);
      realState.twitch=readTwitchViewerState(await response.json());
      lastTwitchFetch=Date.now();
      recalculateTotal();
      if(!isTestActive)renderStatus(realState);
    }catch(_){
      if(!lastTwitchFetch || Date.now()-lastTwitchFetch>30000){
        realState.twitch.status='stale';realState.twitch.viewers=null;
        recalculateTotal();
      }
      if(!isTestActive)renderStatus(realState);
    }finally{if(timeout!==null)clearTimeout(timeout);twitchFetchInFlight=false;}
  }

  let youtubeFetchInFlight=false;
  async function checkNetlifyYoutubeStatus() {
    if (isTestActive || youtubeFetchInFlight) return;
    youtubeFetchInFlight=true;
    try {
      let data=null;
      const bases=[YOUTUBE_BACKEND_BASE,'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app'];
      for(const base of [...new Set(bases)]) {
        try {
          const response=await fetch(base+'/youtube-status?cb='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(15000)});
          if(!response.ok)throw Error('YouTube HTTP '+response.status);
          const candidate=await response.json();
          if(candidate.error || typeof candidate.isLive!=='boolean')throw Error('Estado YouTube indisponível');
          data=candidate;break;
        }catch(_){}
      }
      if(!data)throw Error('Contagem YouTube indisponível');
        lastYoutubeFetch=Date.now();
        realState.youtube = {
          isLive: Boolean(data.isLive),
          viewers: data.isLive && data.viewers!==null && data.viewers!==undefined && data.viewers!=='' && Number.isSafeInteger(Number(data.viewers)) && Number(data.viewers)>=0 ? Number(data.viewers) : null,
          status:data.isLive && (data.viewers===null || data.viewers===undefined || data.viewers==='' || !Number.isSafeInteger(Number(data.viewers)) || Number(data.viewers)<0)?'unknown':'confirmed',
          videoId: data.videoId,
          confidence: data.confidence || "none",
          viewerState: data.viewerState || "unknown"
        };
        recalculateTotal();
        if (!isTestActive) renderStatus(realState);
    } catch (_) {if(!lastYoutubeFetch || Date.now()-lastYoutubeFetch>30000){realState.youtube.status='stale';realState.youtube.viewers=null;recalculateTotal();if(!isTestActive)renderStatus(realState);}}
    finally{youtubeFetchInFlight=false;}
  }

  let facebookFetchInFlight = false;
  async function checkFacebookStatus() {
    if (isTestActive || facebookFetchInFlight) return;
    facebookFetchInFlight = true;
    try {
      let data = null;
      const cloudflareBase = (window.APEX_BACKEND_URL || 'https://apexscorpio-stream-tools.scorpioapex.workers.dev').replace(/\/+$/, '');
      const endpoints = [
        cloudflareBase + '/overlay-config?overlay=facebook-status&cb=' + Date.now(),
        window.location.origin + '/api/facebook/status?cb=' + Date.now(),
        'http://localhost:3000/api/facebook/status?cb=' + Date.now()
      ];

      for (const endpoint of [...new Set(endpoints)]) {
        try {
          const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
          if (response.ok) {
            const raw = await response.json();
            const candidate = raw.config || raw;
            if (typeof candidate.isLive === 'boolean') {
              data = candidate;
              break;
            }
          }
        } catch (_) {}
      }

      if (!data) {
        let token = null;
        try { token = localStorage.getItem('apex_fb_token'); } catch (_) {}
        if (!token) {
          try {
            const res = await fetch('facebook_token.txt', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            if (res.ok) {
              const txt = (await res.text()).trim();
              if (txt && txt.startsWith('EA') && txt.length > 30) token = txt;
            }
          } catch (_) {}
        }
        if (token) {
          try {
            const res = await fetch('https://graph.facebook.com/v26.0/111315703596465/live_videos?fields=id,status,live_views&limit=5&access_token=' + token, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const body = await res.json();
              const live = body.data?.find(item => item.status === 'LIVE');
              if (live) {
                data = { isLive: true, viewers: live.live_views };
              } else {
                data = { isLive: false, viewers: null };
              }
            }
          } catch (_) {}
        }
      }

      if (data && typeof data.isLive === 'boolean') {
        lastFacebookUpdate = Date.now();
        const value = data.viewers;
        const valid = (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
        realState.facebook = {
          isLive: Boolean(data.isLive),
          viewers: valid ? Number(value) : (data.isLive ? 0 : null),
          status: 'confirmed'
        };
        recalculateTotal();
        if (!isTestActive) renderStatus(realState);
      }
    } catch (_) {
    } finally {
      facebookFetchInFlight = false;
    }
  }

  function resetToRealState() {
    isTestActive = false;
    if (testTimer) clearTimeout(testTimer);
    testTimer = null;
    checkPublicTwitchLive();
    checkNetlifyYoutubeStatus();
    checkFacebookStatus();
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
    if (type === 'facebook_status') {
      const incoming=payload?.payload || payload;
      if(!incoming || typeof incoming.isLive!=='boolean')return;
      const observedAt=Number(incoming.observedAt) || Date.now();
      if(!Number.isFinite(observedAt)||Date.now()-observedAt>60000||observedAt>Date.now()+5000)return;
      const value=incoming.viewers;
      const valid=(typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=0;
      realState.facebook={isLive:incoming.isLive,viewers:valid?Number(value):null,status:incoming.status==='confirmed'&&(!incoming.isLive||valid)?'confirmed':incoming.status==='unavailable'?'unavailable':'unknown'};
      lastFacebookUpdate=observedAt;recalculateTotal();if(!isTestActive)renderStatus(realState);return;
    }
    if (type === 'status_update') {
      const incoming = payload?.state || payload;
      if (incoming?.isTest) {
        isTestActive = true;
        if (testTimer) clearTimeout(testTimer);
        renderStatus(incoming);
        testTimer = setTimeout(resetToRealState, Number(incoming.testDuration || 8) * 1000);
      } else if (incoming && typeof incoming === 'object') {
        if (incoming.twitch && typeof incoming.twitch.isLive === 'boolean') {
          realState.twitch = {
            isLive: incoming.twitch.isLive,
            viewers: incoming.twitch.isLive ? Number(incoming.twitch.viewers || 0) : null,
            status: 'confirmed'
          };
          lastTwitchFetch = Date.now();
        }
        if (incoming.youtube && typeof incoming.youtube.isLive === 'boolean') {
          realState.youtube = {
            isLive: incoming.youtube.isLive,
            viewers: incoming.youtube.isLive ? Number(incoming.youtube.viewers || 0) : null,
            status: 'confirmed'
          };
          lastYoutubeFetch = Date.now();
        }
        if (incoming.facebook && typeof incoming.facebook.isLive === 'boolean') {
          realState.facebook = {
            isLive: incoming.facebook.isLive,
            viewers: incoming.facebook.isLive ? Number(incoming.facebook.viewers || 0) : null,
            status: 'confirmed'
          };
          lastFacebookUpdate = Date.now();
        }
        recalculateTotal();
        if (!isTestActive) renderStatus(realState);
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
    
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://broker.emqx.io:8084/mqtt'
  ];
  if (typeof mqtt !== 'undefined' && window.ApexOverlaySession) {
    MQTT_BROKERS.forEach(url => {
      try {
        const client = mqtt.connect(url, {
          reconnectPeriod: 5000,
          clientId: `scorpio_viewers_${Math.random().toString(16).slice(2, 8)}`,
          connectTimeout: 4000,
          keepalive: 30
        });
        client.on('connect', () => {
          client.subscribe((window.ApexOverlaySession.topic + '/cfg/#'));
          client.subscribe((window.ApexOverlaySession.topic + '/events/#'));
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
  checkFacebookStatus();
  setInterval(checkFacebookStatus, 5000);
  setInterval(()=>{if(lastFacebookUpdate && Date.now()-lastFacebookUpdate>60000){realState.facebook={isLive:realState.facebook.isLive,viewers:null,status:'stale'};recalculateTotal();if(!isTestActive)renderStatus(realState);}},5000);
  setInterval(checkPublicTwitchLive, 5000);
  setInterval(checkNetlifyYoutubeStatus, 15000);
  setInterval(()=>{
    if(isTestActive)return;
    const now=Date.now();
    for(const [platform,observedAt] of [['twitch',lastTwitchFetch],['youtube',lastYoutubeFetch]]) {
      if(observedAt && now-observedAt>60000){realState[platform].status='stale';realState[platform].viewers=null;}
    }
    recalculateTotal();renderStatus(realState);
  },5000);

  function applyYoutubeLiveState(ytState) {
    if(!ytState || typeof ytState.isLive!=='boolean')return;
    // Player heartbeats confirm liveness, not a fresh viewer count.
    // Counts come from our status request, with its independent expiry timer.
    if(lastYoutubeFetch && Date.now()-lastYoutubeFetch<=30000)return;
    const value=ytState.viewers;
    const observedAt=Number(ytState.viewersObservedAt);
    const fresh=!ytState.error && Number.isFinite(observedAt) && observedAt<=Date.now()+5000 && Date.now()-observedAt<=30000;
    const count=fresh && value!==null && value!==undefined && value!=='' && Number.isSafeInteger(Number(value)) && Number(value)>=0 ? Number(value) : null;
    realState.youtube={isLive:ytState.isLive,viewers:ytState.isLive?count:null,videoId:ytState.videoId || null,status:ytState.isLive && count===null?'unknown':'confirmed'};
    recalculateTotal();
    if(!isTestActive)renderStatus(realState);
  }
  if(window.YoutubeLive)window.YoutubeLive.subscribeState(applyYoutubeLiveState);
})();
