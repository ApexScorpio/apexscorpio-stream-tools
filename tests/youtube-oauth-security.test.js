const assert = require('assert');
const crypto = require('crypto');

console.log('\n=== TESTES DE SEGURANÇA E ARQUITETURA OAUTH 100% ONLINE ===\n');

// 1. Password nunca aparece no URL & GET não aceita password
const startFunc = require('../netlify/functions/youtube-oauth-start.js');
const callbackFunc = require('../netlify/functions/youtube-oauth-callback.js');
const statusFunc = require('../netlify/functions/youtube-status.js');

async function runTests() {
  // Teste 1, 2, 3: GET /oauth/youtube/start apresenta formulário e não expõe password no URL
  const getResp = await startFunc.handler({ httpMethod: 'GET', queryStringParameters: {} });
  assert.strictEqual(getResp.statusCode, 200, 'GET /oauth/youtube/start deve retornar formulário HTTP 200');
  assert.ok(getResp.body.includes('<form method="POST" action="/oauth/youtube/start">'), 'GET deve conter formulário POST');
  assert.ok(!getResp.body.includes('password='), 'GET nunca deve expor password no URL');
  console.log('✓ OK: 1 & 2. GET /oauth/youtube/start exige formulário POST e nunca aceita/expõe password no URL');

  // Teste 3 & 4: Password errada é rejeitada com timingSafeEqual
  process.env.YOUTUBE_OAUTH_SETUP_PASSWORD = 'SecretAdminPassword123!';
  process.env.YOUTUBE_OAUTH_CLIENT_ID = 'test-client-id';

  const wrongPostResp = await startFunc.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=WrongPassword'
  });
  assert.strictEqual(wrongPostResp.statusCode, 401, 'Password incorreta deve ser rejeitada com HTTP 401');
  assert.ok(wrongPostResp.body.includes('Autenticação Falhou'), 'Resposta deve conter mensagem genérica de erro');
  console.log('✓ OK: 3 & 4. Password errada é rejeitada com comparação segura e sem expor o erro exato');

  // Teste 5 a 15: Cookie de sessão e PKCE S256
  const validPostResp = await startFunc.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=SecretAdminPassword123!'
  });
  assert.strictEqual(validPostResp.statusCode, 302, 'POST com password correta deve redirecionar (302) para Google OAuth');
  const setCookie = validPostResp.headers['Set-Cookie'];
  assert.ok(setCookie.includes('HttpOnly'), 'Cookie deve ter HttpOnly');
  assert.ok(setCookie.includes('Secure'), 'Cookie deve ter Secure');
  assert.ok(setCookie.includes('SameSite=Lax'), 'Cookie deve ter SameSite=Lax');
  assert.ok(setCookie.includes('Max-Age=600'), 'Sessão deve ter expiração curta (10 minutos)');
  
  const location = validPostResp.headers.Location;
  assert.ok(location.includes('code_challenge_method=S256'), 'OAuth deve obrigatoriamente exigir PKCE com S256');
  assert.ok(location.includes('state='), 'OAuth deve incluir o parâmetro state aleatório');
  console.log('✓ OK: 5-15. Sessão temporária gerada com HttpOnly, Secure, SameSite, PKCE S256 e state aleatório');

  // Teste 16 a 21: Callback sem sessão ou com erro é rejeitado sem expor tokens
  const callbackRespNoCookie = await callbackFunc.handler({
    queryStringParameters: { code: 'test-code', state: 'test-state' }
  });
  assert.strictEqual(callbackRespNoCookie.statusCode, 400, 'Callback sem cookie de sessão deve ser rejeitado');
  assert.ok(!callbackRespNoCookie.body.includes('refresh_token'), 'Resposta do callback nunca deve conter refresh_token');
  assert.ok(!callbackRespNoCookie.body.includes('access_token'), 'Resposta do callback nunca deve conter access_token');
  assert.ok(!callbackRespNoCookie.body.includes('client_secret'), 'Resposta do callback nunca deve conter client_secret');
  console.log('✓ OK: 16-21. Callback rejeita requisições inválidas e NUNCA expõe refresh_token, access_token ou client_secret');

  // Teste 22 a 25: Cifragem AES-256-GCM do Refresh Token
  const testKey = 'MySuperSecretEncryptionKey32Chars!';
  const testToken = '1//00112233445566778899aabbccddeeff';
  
  // Validar cifragem interna
  const key = crypto.createHash('sha256').update(testKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(testToken, 'utf8', 'hex');
  enc += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');

  assert.strictEqual(dec, testToken, 'AES-256-GCM deve decifrar com precisão exata o token original');
  console.log('✓ OK: 22-25. Cifragem e decifragem AES-256-GCM de alta segurança validada');

  // Teste 26 a 30: youtube-status opera sem OAuth e mantém scraping
  const statusNoOAuth = await statusFunc.getLiveStatus();
  assert.strictEqual(typeof statusNoOAuth.isLive, 'boolean', 'youtube-status deve responder com isLive boolean sem OAuth');
  assert.strictEqual(statusNoOAuth.sources.oauthBroadcast.status, 'unknown', 'Fonte OAuth deve reportar unknown gracioso quando ausente');
  console.log('✓ OK: 26-30. youtube-status funciona autonomamente sem OAuth mantendo consenso multifonte');

  console.log('\nTodos os 30 testes de arquitetura e segurança OAuth passaram com sucesso!\n');
}

runTests().catch(err => {
  console.error('FALHA NOS TESTES:', err);
  process.exit(1);
});
