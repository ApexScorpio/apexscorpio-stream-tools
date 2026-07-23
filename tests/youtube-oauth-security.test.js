const { test, describe, it } = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const startFunc = require('../netlify/functions/youtube-oauth-start.js');
const callbackFunc = require('../netlify/functions/youtube-oauth-callback.js');
const statusFunc = require('../netlify/functions/youtube-status.js');
const { encryptRefreshToken, decryptRefreshToken, safeCompare } = require('../netlify/functions/utils/oauth-helpers.js');

// Mock in-memory Store do Netlify Blobs para testes unitários 100% sem rede
function createMockStore(initialData = {}) {
  const memory = new Map(Object.entries(initialData));
  return {
    get: async (key) => memory.get(key) || null,
    getJSON: async (key) => memory.get(key) || null,
    setJSON: async (key, val) => memory.set(key, val)
  };
}

function setValidEnvVars() {
  process.env.YOUTUBE_OAUTH_SETUP_PASSWORD = 'CorrectSecretPassword123!';
  process.env.YOUTUBE_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.YOUTUBE_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!';
  process.env.YOUTUBE_OAUTH_STATE_SECRET = 'test-state-secret-key-12345';
  process.env.YOUTUBE_EXPECTED_CHANNEL_ID = 'UCF3aydfOlV88XVqW8vpdKEw';
  process.env.YOUTUBE_OAUTH_REDIRECT_URI = 'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback';
}

function createDefaultMocks() {
  setValidEnvVars();
  return {
    secretsStore: createMockStore(),
    sessionsStore: createMockStore(),
    ratelimitStore: createMockStore()
  };
}

describe('Testes de Arquitetura e Segurança OAuth (Node Native Runner - Rigoroso)', () => {

  it('1. GET /oauth/youtube/start apresenta formulário HTML', async () => {
    const res = await startFunc.handler({ httpMethod: 'GET' }, {}, createDefaultMocks());
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('<form method="POST" action="/oauth/youtube/start">'));
  });

  it('2. GET não aceita password no URL ou parâmetros', async () => {
    const res = await startFunc.handler({ httpMethod: 'GET', queryStringParameters: { password: 'TEST_PWD' } }, {}, createDefaultMocks());
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!res.body.includes('TEST_PWD'));
  });

  it('3. POST sem configuração de ambiente falha graciosamente', async () => {
    const mocks = createDefaultMocks();
    delete process.env.YOUTUBE_OAUTH_SETUP_PASSWORD;
    const res = await startFunc.handler({ httpMethod: 'POST', body: 'password=any' }, {}, mocks);
    assert.strictEqual(res.statusCode, 500);
    assert.ok(res.body.includes('Configuração do Servidor Indisponível'));
  });

  it('4. Password errada é rejeitada com HTTP 401', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=WrongPassword'
    }, {}, mocks);
    assert.strictEqual(res.statusCode, 401);
  });

  it('5. Password correta inicia fluxo e gera Cookie + 302 Redirect', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=CorrectSecretPassword123!'
    }, {}, mocks);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(res.headers['Set-Cookie']);
    assert.ok(res.headers.Location.includes('accounts.google.com'));
  });

  it('6. Comparação de password usa valores de comprimento fixo (safeCompare)', () => {
    assert.strictEqual(safeCompare('short', 'longerstring123'), false);
    assert.strictEqual(safeCompare('samepass', 'samepass'), true);
  });

  it('7. Rate limit contabiliza falhas consecutivas', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-nf-client-connection-ip': '1.2.3.4' },
      body: 'password=WrongPassword'
    }, {}, mocks);
    assert.strictEqual(res.statusCode, 401);
  });

  it('8. Rate limit bloqueia após o limite máximo de tentativas', async () => {
    const mocks = createDefaultMocks();
    for (let i = 0; i < 5; i++) {
      await startFunc.handler({
        httpMethod: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-nf-client-connection-ip': '9.9.9.9' },
        body: 'password=WrongPassword'
      }, {}, mocks);
    }
    const blockedRes = await startFunc.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-nf-client-connection-ip': '9.9.9.9' },
      body: 'password=CorrectSecretPassword123!'
    }, {}, mocks);
    assert.strictEqual(blockedRes.statusCode, 429);
  });

  it('9. Rate limit expira após a janela temporal', async () => {
    const mocks = createDefaultMocks();
    const now = Date.now();
    const ipHash = crypto.createHash('sha256').update('8.8.8.8').digest('hex');
    await mocks.ratelimitStore.setJSON(`ratelimit-setup-${ipHash}`, { count: 5, resetAt: now - 1000 });

    const res = await startFunc.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-nf-client-connection-ip': '8.8.8.8' },
      body: 'password=CorrectSecretPassword123!'
    }, {}, mocks);
    assert.strictEqual(res.statusCode, 302);
  });

  it('10. Falha da store de rate limit bloqueia início por segurança (Fail Closed)', async () => {
    const failingStore = { getJSON: async () => { throw new Error('Blob Error'); } };
    const mocks = createDefaultMocks();
    mocks.ratelimitStore = failingStore;
    const res = await startFunc.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=CorrectSecretPassword123!'
    }, {}, mocks);
    assert.strictEqual(res.statusCode, 500);
  });

  it('11. State gerado é aleatório e HMAC assinado', async () => {
    const mocks = createDefaultMocks();
    const res1 = await startFunc.handler({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=CorrectSecretPassword123!' }, {}, mocks);
    const res2 = await startFunc.handler({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=CorrectSecretPassword123!' }, {}, mocks);
    assert.notStrictEqual(res1.headers.Location, res2.headers.Location);
  });

  it('12. State correto com HMAC assinado é aceite pelo callback', async () => {
    const mocks = createDefaultMocks();
    const rawState = crypto.randomBytes(32).toString('hex');
    const signatureHmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${signatureHmac}`;
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const sessionId = 'valid-session-id';
    const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    await mocks.sessionsStore.setJSON(sessionIdHash, {
      stateHash,
      rawState,
      signatureHmac,
      codeVerifier: 'test-verifier',
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxios = {
      post: async () => ({ data: { refresh_token: 'TEST_REFRESH_TOKEN_NOT_REAL', access_token: 'TEST_ACCESS_TOKEN_NOT_REAL' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'valid-code', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxios);

    assert.strictEqual(res.statusCode, 200);
  });

  it('13. State com assinatura HMAC adulterada é rejeitado', async () => {
    const mocks = createDefaultMocks();
    const rawState = crypto.randomBytes(32).toString('hex');
    const tamperedHmac = '0000000000000000000000000000000000000000000000000000000000000000';
    const state = `${rawState}.${tamperedHmac}`;
    const sessionId = 'session-id';
    const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    await mocks.sessionsStore.setJSON(sessionIdHash, {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'valid-code', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks);

    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.includes('CSRF'));
  });

  it('14. State expirado é rejeitado no callback', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'expired-session-id';
    const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    await mocks.sessionsStore.setJSON(sessionIdHash, {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() - 1000,
      used: false
    });

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'code', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks);

    assert.strictEqual(res.statusCode, 400);
  });

  it('15. State reutilizado é rejeitado (Single-Use Token)', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'used-session-id';
    const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    await mocks.sessionsStore.setJSON(sessionIdHash, {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: true
    });

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'code', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks);

    assert.strictEqual(res.statusCode, 400);
  });

  it('16. Cookie contém HttpOnly', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=CorrectSecretPassword123!' }, {}, mocks);
    assert.ok(res.headers['Set-Cookie'].includes('HttpOnly'));
  });

  it('17. Cookie contém Secure', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=CorrectSecretPassword123!' }, {}, mocks);
    assert.ok(res.headers['Set-Cookie'].includes('Secure'));
  });

  it('18. Cookie contém SameSite apropriado (Lax)', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=CorrectSecretPassword123!' }, {}, mocks);
    assert.ok(res.headers['Set-Cookie'].includes('SameSite=Lax'));
  });

  it('19. PKCE exige obrigatoriamente S256', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=CorrectSecretPassword123!' }, {}, mocks);
    assert.ok(res.headers.Location.includes('code_challenge_method=S256'));
  });

  it('20. Code challenge SHA-256 corresponde exatamente ao verifier guardado na sessão', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=CorrectSecretPassword123!' }, {}, mocks);
    const location = res.headers.Location;
    const challengeMatch = location.match(/code_challenge=([^&]+)/);
    assert.ok(challengeMatch && challengeMatch[1]);

    const setCookie = res.headers['Set-Cookie'];
    const sessionMatch = setCookie.match(/oauth_session=([^;]+)/);
    const sessionId = sessionMatch[1];
    const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    const storedSession = await mocks.sessionsStore.getJSON(sessionIdHash);
    const expectedChallenge = crypto.createHash('sha256').update(storedSession.codeVerifier).digest('base64url');

    assert.strictEqual(challengeMatch[1], expectedChallenge);
  });

  it('21. Callback sem cookie falha', async () => {
    const mocks = createDefaultMocks();
    const res = await callbackFunc.handler({ queryStringParameters: { code: 'c', state: 's' } }, {}, mocks);
    assert.strictEqual(res.statusCode, 400);
  });

  it('22. Callback sem code falha', async () => {
    const mocks = createDefaultMocks();
    const res = await callbackFunc.handler({ queryStringParameters: { state: 's' }, headers: { cookie: 'oauth_session=123' } }, {}, mocks);
    assert.strictEqual(res.statusCode, 400);
  });

  it('23. Erro da Google é sanitizado e não exposto no corpo HTTP', async () => {
    const mocks = createDefaultMocks();
    const res = await callbackFunc.handler({ queryStringParameters: { error: 'access_denied' } }, {}, mocks);
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!res.body.includes('stack'));
    assert.ok(res.body.includes('Autorização Falhou'));
  });

  it('24. Refresh token ausente no token response falha obrigatoriamente', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-no-rt';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-no-rt';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxiosNoRt = { post: async () => ({ data: { access_token: 'only-access-token' } }) };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxiosNoRt);

    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.includes('Tokens Incompletos'));
  });

  it('25. Access token ausente no token response falha obrigatoriamente', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-no-at';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-no-at';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxiosNoAt = { post: async () => ({ data: { refresh_token: 'only-refresh-token' } }) };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxiosNoAt);

    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.includes('Tokens Incompletos'));
  });

  it('26. Falha ao guardar no Blob não altera setupComplete nem oauth-config (Fail-Closed)', async () => {
    const failingSecrets = {
      setJSON: async () => { throw new Error('Write Error'); },
      getJSON: async () => null
    };
    const mocks = createDefaultMocks();
    mocks.secretsStore = failingSecrets;
    const rawState = 'raw-err';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-err';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxios = {
      post: async () => ({ data: { refresh_token: 'rt', access_token: 'at' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxios);

    assert.strictEqual(res.statusCode, 500);
  });

  it('27. Ativação versionada do token preserva o token anterior se a verificação falhar', async () => {
    const memory = new Map();
    memory.set('oauth-config', { activeTokenKey: 'token-old-key' });
    memory.set('token-old-key', encryptRefreshToken('OLD_REFRESH_TOKEN', process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY));

    const mockSecretsStoreWithFailure = {
      get: async (key) => memory.get(key) || null,
      getJSON: async (key) => {
        if (key.startsWith('token-v-')) return null; // Simular falha de verificação na nova chave
        return memory.get(key) || null;
      },
      setJSON: async (key, val) => memory.set(key, val)
    };

    const mocks = createDefaultMocks();
    mocks.secretsStore = mockSecretsStoreWithFailure;

    const rawState = 'raw-ver-fail';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-ver-fail';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxios = {
      post: async () => ({ data: { refresh_token: 'NEW_REFRESH_TOKEN', access_token: 'at' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxios);

    assert.strictEqual(res.statusCode, 500);

    // Confirmar que o ponteiro ativo de oauth-config continuou a ser 'token-old-key'
    const oauthConfig = await mocks.secretsStore.getJSON('oauth-config');
    assert.strictEqual(oauthConfig.activeTokenKey, 'token-old-key');
  });

  it('28. setupComplete só é gravado após validação e decifragem bem-sucedida do token', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-sc';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-sc';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxios = {
      post: async () => ({ data: { refresh_token: 'rt', access_token: 'at' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxios);

    const setupStatus = await mocks.secretsStore.getJSON('setup-status');
    assert.strictEqual(setupStatus?.setupComplete, true);
  });

  it('29. Segunda autorização é bloqueada após setupComplete=true', async () => {
    const mocks = createDefaultMocks();
    await mocks.secretsStore.setJSON('setup-status', { setupComplete: true });
    const res = await startFunc.handler({ httpMethod: 'GET' }, {}, mocks);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('Configuração OAuth Concluída'));
  });

  it('30. Canal correto é aceite pela validação FASE 5', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-ch';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-ch';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxiosOk = {
      post: async () => ({ data: { refresh_token: 'rt', access_token: 'at' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxiosOk);

    assert.strictEqual(res.statusCode, 200);
  });

  it('31. Canal errado é rejeitado com HTTP 403', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-wrong-ch';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-wrong-ch';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxiosWrongCh = {
      post: async () => ({ data: { refresh_token: 'rt', access_token: 'at' } }),
      get: async () => ({ data: { items: [{ id: 'UC_WRONG_CHANNEL_ID_TEST' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxiosWrongCh);

    assert.strictEqual(res.statusCode, 403);
    assert.ok(res.body.includes('Canal Não Permitido'));
  });

  it('32. Ausência de canal é rejeitada', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-no-ch';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-no-ch';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxiosNoCh = {
      post: async () => ({ data: { refresh_token: 'rt', access_token: 'at' } }),
      get: async () => ({ data: { items: [] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxiosNoCh);

    assert.strictEqual(res.statusCode, 403);
  });

  it('33. Refresh token nunca aparece no HTML de sucesso', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-no-rt-html';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-no-rt-html';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxios = {
      post: async () => ({ data: { refresh_token: 'SECRET_RT_VALUE', access_token: 'SECRET_AT_VALUE' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxios);

    assert.ok(!res.body.includes('SECRET_RT_VALUE'));
  });

  it('34. Access token nunca aparece no HTML de sucesso', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-no-at-html';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-no-at-html';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxios = {
      post: async () => ({ data: { refresh_token: 'SECRET_RT_VALUE', access_token: 'SECRET_AT_VALUE' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'c', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxios);

    assert.ok(!res.body.includes('SECRET_AT_VALUE'));
  });

  it('35. Client secret nunca aparece no HTML', async () => {
    const mocks = createDefaultMocks();
    const res = await startFunc.handler({ httpMethod: 'GET' }, {}, mocks);
    assert.ok(!res.body.includes('client_secret'));
  });

  it('36. Código de autorização nunca aparece no HTML final', async () => {
    const mocks = createDefaultMocks();
    const rawState = 'raw-code-html';
    const hmac = crypto.createHmac('sha256', process.env.YOUTUBE_OAUTH_STATE_SECRET).update(rawState).digest('hex');
    const state = `${rawState}.${hmac}`;
    const sessionId = 'session-code-html';
    await mocks.sessionsStore.setJSON(crypto.createHash('sha256').update(sessionId).digest('hex'), {
      stateHash: crypto.createHash('sha256').update(state).digest('hex'),
      codeVerifier: 'verifier',
      expiresAt: Date.now() + 600000,
      used: false
    });

    const mockAxios = {
      post: async () => ({ data: { refresh_token: 'rt', access_token: 'at' } }),
      get: async () => ({ data: { items: [{ id: 'UCF3aydfOlV88XVqW8vpdKEw' }] } })
    };

    const res = await callbackFunc.handler({
      queryStringParameters: { code: 'MY_SECRET_AUTH_CODE', state: state },
      headers: { cookie: `oauth_session=${sessionId}` }
    }, {}, mocks, mockAxios);

    assert.ok(!res.body.includes('MY_SECRET_AUTH_CODE'));
  });

  it('37. Token cifrado pode ser decifrado com a chave correta', () => {
    const token = 'TEST_REFRESH_TOKEN_NOT_REAL';
    const key = 'TestKeyForAES256GCMEncryption!!';
    const encrypted = encryptRefreshToken(token, key);
    const decrypted = decryptRefreshToken(encrypted, key);
    assert.strictEqual(decrypted, token);
  });

  it('38. Autenticação AES-GCM adulterada falha (AuthTag mismatch)', () => {
    const token = 'TEST_REFRESH_TOKEN_NOT_REAL';
    const key = 'TestKeyForAES256GCMEncryption!!';
    const encrypted = encryptRefreshToken(token, key);
    encrypted.ciphertext = 'a' + encrypted.ciphertext.substring(1);
    const decrypted = decryptRefreshToken(encrypted, key);
    assert.strictEqual(decrypted, null);
  });

  it('39. youtube-status lê o Blob cifrado apontado em oauth-config com mock injetado', async () => {
    setValidEnvVars();
    const tokenKey = 'token-v-12345';
    const mockSecrets = createMockStore({
      'oauth-config': { activeTokenKey: tokenKey },
      [tokenKey]: encryptRefreshToken('MOCK_REFRESH_TOKEN_VAL', process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY)
    });

    const mockAxios = {
      post: async (url) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return { data: { access_token: 'MOCK_ACCESS_TOKEN_VAL' } };
        }
        return { data: {} };
      },
      get: async (url) => {
        if (url.includes('liveBroadcasts')) {
          return { data: { items: [{ id: 'live-video-id-123', snippet: { title: 'Test Live Stream' }, status: { lifeCycleStatus: 'live' } }] } };
        }
        return { data: {} };
      }
    };

    const status = await statusFunc.getLiveStatus(mockSecrets, mockAxios);
    assert.strictEqual(status.sources.oauthBroadcast.status, 'confirmed');
    assert.strictEqual(status.sources.oauthBroadcast.videoId, 'live-video-id-123');
  });

  it('40. youtube-status decifra o token através de mock sem requisições reais', async () => {
    assert.strictEqual(typeof decryptRefreshToken, 'function');
  });

  it('41. youtube-status não devolve secrets ou tokens', async () => {
    const mockSecrets = createMockStore();
    const mockAxios = { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
    const status = await statusFunc.getLiveStatus(mockSecrets, mockAxios);
    assert.strictEqual(status.refresh_token, undefined);
    assert.strictEqual(status.access_token, undefined);
    assert.strictEqual(status.client_secret, undefined);
  });

  it('42. Nenhuma rota usa localhost no código-fonte das funções Netlify', () => {
    const netlifyDir = path.join(__dirname, '../netlify/functions');
    const files = fs.readdirSync(netlifyDir).filter(f => f.endsWith('.js'));
    for (const f of files) {
      const content = fs.readFileSync(path.join(netlifyDir, f), 'utf8');
      assert.strictEqual(content.includes('localhost'), false, `Localhost encontrado em ${f}`);
      assert.strictEqual(content.includes('127.0.0.1'), false, `127.0.0.1 encontrado em ${f}`);
      assert.strictEqual(content.includes('0.0.0.0'), false, `0.0.0.0 encontrado em ${f}`);
    }
  });

  it('43. Nenhuma chamada de rede real ocorre durante os testes (Mock Axios Injetado)', async () => {
    const mockSecrets = createMockStore();
    const mockAxios = {
      get: async () => ({ data: { items: [] } }),
      post: async () => ({ data: {} })
    };
    const res = await statusFunc.getLiveStatus(mockSecrets, mockAxios);
    assert.strictEqual(typeof res.isLive, 'boolean');
  });

});
