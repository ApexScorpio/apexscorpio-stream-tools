const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const TwitchService = require('./services/twitch');
const YoutubeService = require('./services/youtube');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_FILE = path.join(__dirname, 'config.json');

// Permanent GitHub Pages / Cloud domain URL for Apex Scorpio Stream Tools
let publicBaseUrl = process.env.PUBLIC_URL || 'https://apexscorpio.github.io/apexscorpio-stream-tools';

// Global state for multi-platform stream status (Twitch, YouTube, Facebook)
const streamState = {
  twitch: { isLive: false, viewers: 0 },
  youtube: { isLive: false, viewers: 0, videoId: null },
  facebook: { isLive: false, viewers: 0 },
  totalViewers: 0
};

// Global state for expanded overlay customization options across all sources
let overlayConfig = {
  viewers: {
    showTwitch: true,
    showYoutube: true,
    showFacebook: true,
    showTotal: true,
    showBg: true,
    layout: 'horizontal',
    fontSize: 15
  },
  chat: {
    showTwitch: true,
    showYoutube: true,
    showFacebook: true,
    fadeSeconds: 0,        // 0 = permanent
    showBg: true,          // full chat viewport background
    displayMode: 'pill',   // 'pill' or 'compact'
    fontSize: 14,
    showBadges: true,
    maxMessages: 50
  },
  events: {
    showTwitch: true,
    showYoutube: true,
    showFacebook: true,
    showBg: true,
    maxItems: 8,
    showLogos: true
  },
  alerts: {
    showTwitch: true,
    showYoutube: true,
    showFacebook: true,
    playSound: true,
    durationSeconds: 5
  },
  starting: {
    timerMinutes: 5
  }
};

// Load saved config if exists
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    overlayConfig = { ...overlayConfig, ...saved };
    console.log('[Config] Loaded saved overlay settings from config.json');
  } catch (e) {
    console.error('[Config Error]', e.message);
  }
}

function saveConfigToFile() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(overlayConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[Config Save Error]', e.message);
  }
}

function broadcastStatus() {
  streamState.totalViewers = streamState.twitch.viewers + streamState.youtube.viewers + streamState.facebook.viewers;
  io.emit('status_update', streamState);
}

function broadcastConfig() {
  saveConfigToFile();
  io.emit('config_update', overlayConfig);
}

// Global state for recent events ticker
const recentEvents = {
  lastFollower: '@GamerGurl_99 (Twitch)',
  lastSubscriber: '@ApexFanatic (YouTube)',
  lastRaid: '@StreamMaster (25 espectadores)'
};

function handleChatMessage(msg) {
  console.log(`[Unified Chat] [${msg.platform.toUpperCase()}] ${msg.username}: ${msg.message}`);
  io.emit('chat_message', msg);
}

function handleStatusUpdate(update) {
  if (update.platform === 'twitch') {
    streamState.twitch.isLive = update.isLive;
    streamState.twitch.viewers = update.viewers;
  } else if (update.platform === 'youtube') {
    streamState.youtube.isLive = update.isLive;
    streamState.youtube.viewers = update.viewers;
    streamState.youtube.videoId = update.videoId || null;
  } else if (update.platform === 'facebook') {
    streamState.facebook.isLive = update.isLive;
    streamState.facebook.viewers = update.viewers;
  }
  broadcastStatus();
}

// Initialize platform services
const twitchService = new TwitchService('apexscorpio', handleChatMessage, handleStatusUpdate);
const youtubeService = new YoutubeService('apexscorpio', handleChatMessage, handleStatusUpdate);

twitchService.start();
youtubeService.start();

// Socket connections
io.on('connection', (socket) => {
  console.log(`[Socket] Overlay client connected (${socket.id})`);
  
  socket.emit('status_update', streamState);
  socket.emit('config_update', overlayConfig);
  socket.emit('events_update', recentEvents);

  socket.on('update_config', (newConfig) => {
    overlayConfig = { ...overlayConfig, ...newConfig };
    broadcastConfig();
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected (${socket.id})`);
  });
});

app.get('/api/status', (req, res) => res.json(streamState));
app.get('/api/config', (req, res) => res.json(overlayConfig));

app.get('/api/public-url', (req, res) => {
  const host = req.get('host');
  let detectedUrl = publicBaseUrl;
  if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
    detectedUrl = `https://${host}`;
  }
  res.json({ publicBaseUrl: detectedUrl });
});

app.post('/api/public-url', (req, res) => {
  if (req.body.publicBaseUrl) {
    publicBaseUrl = req.body.publicBaseUrl;
  }
  res.json({ success: true, publicBaseUrl });
});

app.post('/api/config', (req, res) => {
  overlayConfig = { ...overlayConfig, ...req.body };
  broadcastConfig();
  res.json({ success: true, overlayConfig });
});

app.post('/api/trigger-alert', (req, res) => {
  const { type, username, platform, viewers } = req.body;
  const eventPayload = {
    id: `event-${Date.now()}`,
    type: type || 'follower',
    username: username || 'NovoSeguidor_42',
    platform: platform || 'twitch',
    viewers: viewers || 12,
    timestamp: new Date().toISOString()
  };

  const platName = eventPayload.platform.toUpperCase();
  if (eventPayload.type === 'follower') {
    recentEvents.lastFollower = `@${eventPayload.username} (${platName})`;
  } else if (eventPayload.type === 'subscriber') {
    recentEvents.lastSubscriber = `@${eventPayload.username} (${platName})`;
  } else if (eventPayload.type === 'raid') {
    recentEvents.lastRaid = `@${eventPayload.username} (${eventPayload.viewers} espectadores)`;
  }

  io.emit('new_event', eventPayload);
  io.emit('events_update', recentEvents);
  res.json({ success: true, eventPayload, recentEvents });
});

app.post('/api/test-message', (req, res) => {
  const { platform, username, message } = req.body;
  const plat = platform || 'twitch';
  const colors = { twitch: '#9146FF', youtube: '#E8181F', facebook: '#1877F2' };
  
  const testMsg = {
    id: `test-${Date.now()}`,
    platform: plat,
    username: username || (plat === 'youtube' ? 'GamerYT_88' : (plat === 'facebook' ? 'ScorpioFB_10' : 'TwitchGamer_99')),
    userColor: colors[plat] || '#E8181F',
    message: message || `Olá @apexscorpio! Mensagem de teste em direto do ${plat.toUpperCase()}! 🔥`,
    badges: { broadcaster: false, mod: Math.random() > 0.5, subscriber: true },
    timestamp: new Date().toISOString()
  };
  
  handleChatMessage(testMsg);
  res.json({ success: true, messageSent: testMsg });
});

app.post('/api/simulate-counts', (req, res) => {
  const { twitchViewers, youtubeViewers, facebookViewers, twitchLive, youtubeLive, facebookLive } = req.body;
  if (twitchViewers !== undefined) streamState.twitch.viewers = Number(twitchViewers);
  if (youtubeViewers !== undefined) streamState.youtube.viewers = Number(youtubeViewers);
  if (facebookViewers !== undefined) streamState.facebook.viewers = Number(facebookViewers);
  
  if (twitchLive !== undefined) streamState.twitch.isLive = Boolean(twitchLive);
  if (youtubeLive !== undefined) streamState.youtube.isLive = Boolean(youtubeLive);
  if (facebookLive !== undefined) streamState.facebook.isLive = Boolean(facebookLive);

  broadcastStatus();
  res.json({ success: true, streamState });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 ApexScorpio Streamlabs Overlay Suite is LIVE!`);
  console.log(`👉 GitHub Pages Base URL: ${publicBaseUrl}`);
  console.log(`=======================================================`);
});
