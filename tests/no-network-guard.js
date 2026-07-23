const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const ERROR_MESSAGE = 'NETWORK ACCESS BLOCKED DURING TESTS';

function blockFunction() {
  throw new Error(ERROR_MESSAGE);
}

// Intercetar e bloquear APIs de rede globais e módulos core
globalThis.fetch = blockFunction;

http.request = blockFunction;
http.get = blockFunction;

https.request = blockFunction;
https.get = blockFunction;

net.connect = blockFunction;
net.createConnection = blockFunction;

tls.connect = blockFunction;
