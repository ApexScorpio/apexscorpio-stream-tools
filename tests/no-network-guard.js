const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

// Guard de Rede Real: Bloqueia qualquer ligação de rede externa real durante os testes
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
const originalNetConnect = net.connect;
const originalTlsConnect = tls.connect;

function isAllowedHost(host) {
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return false;
}

http.request = function(...args) {
  let host = '';
  if (typeof args[0] === 'string') {
    try { host = new URL(args[0]).hostname; } catch(e) {}
  } else if (args[0] && typeof args[0] === 'object') {
    host = args[0].hostname || args[0].host || '';
  }
  if (!isAllowedHost(host)) {
    throw new Error(`REAL EXTERNAL NETWORK CONNECTION BLOCKED BY NETWORK GUARD: http://${host}`);
  }
  return originalHttpRequest.apply(this, args);
};

https.request = function(...args) {
  let host = '';
  if (typeof args[0] === 'string') {
    try { host = new URL(args[0]).hostname; } catch(e) {}
  } else if (args[0] && typeof args[0] === 'object') {
    host = args[0].hostname || args[0].host || '';
  }
  if (!isAllowedHost(host)) {
    throw new Error(`REAL EXTERNAL NETWORK CONNECTION BLOCKED BY NETWORK GUARD: https://${host}`);
  }
  return originalHttpsRequest.apply(this, args);
};

net.connect = function(...args) {
  let host = '';
  if (typeof args[0] === 'object') {
    host = args[0].host || args[0].hostname || '';
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  if (host && !isAllowedHost(host)) {
    throw new Error(`REAL EXTERNAL SOCKET CONNECTION BLOCKED BY NETWORK GUARD: net://${host}`);
  }
  return originalNetConnect.apply(this, args);
};

tls.connect = function(...args) {
  let host = '';
  if (typeof args[0] === 'object') {
    host = args[0].host || args[0].servername || '';
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  if (host && !isAllowedHost(host)) {
    throw new Error(`REAL EXTERNAL TLS CONNECTION BLOCKED BY NETWORK GUARD: tls://${host}`);
  }
  return originalTlsConnect.apply(this, args);
};

console.log('[Network Guard Loaded] Chamadas de rede externa real estão estritamente bloqueadas durante os testes.');
