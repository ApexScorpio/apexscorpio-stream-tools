const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

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

// Global state for stream status
const streamState = {
  twitch: { isLive: false, viewers: 0 },
  youtube: { isLive: false, viewers: 0, videoId: null },
  totalViewers: 0
};

// Global state for overlay customization
let overlayConfig = {
  chat: {
    fadeSeconds: 0,        // 0 = permanent, >0 = fade out after X seconds
    showBg: true,          // dark glass background
    fontSize: 14,          // px font size
    showBadges: true,      // Twitch/YouTube badges
    maxMessages: 30
  },
  viewers: {
    showTwitch: true,      // toggle Twitch badge
    showYoutube: true,     // toggle YouTube badge
    showTotal: true,       // toggle Total badge
    showBg: true,          // dark glass background
    layout: 'horizontal'   // 'horizontal' or 'vertical'
  }
};

// Calculate and broadcast status update
function broadcastStatus() {
  streamState.totalViewers = streamState.twitch.viewers + streamState.youtube.viewers;
  io.emit('status_update', streamState);
}

// Broadcast configuration updates to connected overlays
function broadcastConfig() {
  io.emit('config_update', overlayConfig);
}

// Handle chat message ingestion
function handleChatMessage(msg) {
  console.log(`[Unified Chat] [${msg.platform.toUpperCase()}] ${msg.username}: ${msg.message}`);
  io.emit('chat_message', msg);
}

// Handle status updates from platform services
function handleStatusUpdate(update) {
  if (update.platform === 'twitch') {
    streamState.twitch.isLive = update.isLive;
    streamState.twitch.viewers = update.viewers;
  } else if (update.platform === 'youtube') {
    streamState.youtube.isLive = update.isLive;
    streamState.youtube.viewers = update.viewers;
    streamState.youtube.videoId = update.videoId || null;
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
  
  // Send initial states upon connection
  socket.emit('status_update', streamState);
  socket.emit('config_update', overlayConfig);

  // Listen for config changes from dashboard
  socket.on('update_config', (newConfig) => {
    overlayConfig = { ...overlayConfig, ...newConfig };
    broadcastConfig();
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected (${socket.id})`);
  });
});

// REST API Endpoints for Dashboard & Manual Controls
app.get('/api/status', (req, res) => {
  res.json(streamState);
});

app.get('/api/config', (req, res) => {
  res.json(overlayConfig);
});

app.post('/api/config', (req, res) => {
  overlayConfig = { ...overlayConfig, ...req.body };
  broadcastConfig();
  res.json({ success: true, overlayConfig });
});

// Test endpoint to trigger fake chat messages for testing in Streamlabs
app.post('/api/test-message', (req, res) => {
  const { platform, username, message } = req.body;
  const testMsg = {
    id: `test-${Date.now()}`,
    platform: platform || 'twitch',
    username: username || (platform === 'youtube' ? 'YouTubeFan_99' : 'TwitchGamer_42'),
    userColor: platform === 'youtube' ? '#FF0000' : '#9146FF',
    message: message || `Olá @apexscorpio! A testar o chat unificado vindo do ${platform || 'twitch'}! 🔥`,
    badges: { broadcaster: false, mod: Math.random() > 0.5, subscriber: true },
    timestamp: new Date().toISOString()
  };
  handleChatMessage(testMsg);
  res.json({ success: true, messageSent: testMsg });
});

// Endpoint to simulate viewer counts for testing overlay visual effects
app.post('/api/simulate-counts', (req, res) => {
  const { twitchViewers, youtubeViewers, twitchLive, youtubeLive } = req.body;
  if (twitchViewers !== undefined) streamState.twitch.viewers = Number(twitchViewers);
  if (youtubeViewers !== undefined) streamState.youtube.viewers = Number(youtubeViewers);
  if (twitchLive !== undefined) streamState.twitch.isLive = Boolean(twitchLive);
  if (youtubeLive !== undefined) streamState.youtube.isLive = Boolean(youtubeLive);

  broadcastStatus();
  res.json({ success: true, streamState });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 ApexScorpio Streamlabs Overlay Suite is LIVE!`);
  console.log(`👉 Dashboard / Config:  http://localhost:${PORT}`);
  console.log(`👉 Viewer Counter URL: http://localhost:${PORT}/viewers.html`);
  console.log(`👉 Unified Chat URL:   http://localhost:${PORT}/chat.html`);
  console.log(`=======================================================`);
});
