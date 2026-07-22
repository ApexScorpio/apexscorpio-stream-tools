const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class StreamRelayer {
  constructor() {
    this.ffmpegProc = null;
    this.restreamKey = "re_6344942_f58550f8fef50c6e6ba1";
    this.facebookKey = "";
    this.isRelaying = false;
  }

  setKeys(restreamKey, facebookKey) {
    if (restreamKey) this.restreamKey = restreamKey;
    if (facebookKey) this.facebookKey = facebookKey;
  }

  startRelay(inputRtmpUrl) {
    if (this.isRelaying) return;

    const outputs = [];
    if (this.restreamKey) {
      outputs.push(`-c:v copy -c:a copy -f flv rtmp://live.restream.io/live/${this.restreamKey}`);
    }
    if (this.facebookKey) {
      outputs.push(`-c:v copy -c:a copy -f flv rtmps://live-api-s.facebook.com:443/rtmp/${this.facebookKey}`);
    }

    if (outputs.length === 0) {
      console.log('[StreamRelayer] No destination keys configured.');
      return;
    }

    console.log(`[StreamRelayer] Starting RTMP multi-stream relay to ${outputs.length} destinations...`);
    
    // Spawn FFmpeg to relay stream without re-encoding (0% CPU / direct packet copy)
    const args = ['-i', inputRtmpUrl, ...outputs.join(' ').split(' ')];

    try {
      this.ffmpegProc = spawn('ffmpeg', args);
      this.isRelaying = true;

      this.ffmpegProc.stderr.on('data', (data) => {
        // Log stream status silently
      });

      this.ffmpegProc.on('close', (code) => {
        console.log(`[StreamRelayer] Relay process ended (code ${code})`);
        this.isRelaying = false;
        this.ffmpegProc = null;
      });
    } catch (err) {
      console.error('[StreamRelayer Error]', err.message);
    }
  }

  stopRelay() {
    if (this.ffmpegProc) {
      console.log('[StreamRelayer] Stopping relay...');
      this.ffmpegProc.kill('SIGINT');
      this.ffmpegProc = null;
      this.isRelaying = false;
    }
  }
}

module.exports = new StreamRelayer();
