const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  encryptRefreshToken
} = require('../netlify/functions/utils/oauth-helpers.js');

const {
  handler,
  resetCacheForTests
} = require(
  '../netlify/functions/handlers/youtube-chat-handler.js'
);

const ORIGINAL_ENV = { ...process.env };

function configureEnvironment() {
  process.env.YOUTUBE_OAUTH_CLIENT_ID =
    'client-test';

  process.env.YOUTUBE_OAUTH_CLIENT_SECRET =
    'secret-test';

  process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY =
    'encryption-test';

  process.env.YOUTUBE_EXPECTED_CHANNEL_ID =
    'UCF3aydfOlV88XVqW8vpdKEw';
}

function createStore() {
  const expectedHash = crypto
    .createHash('sha256')
    .update(process.env.YOUTUBE_EXPECTED_CHANNEL_ID)
    .digest('hex');

  const encrypted = encryptRefreshToken(
    'refresh-token-test',
    process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY
  );

  return {
    async get(key) {
      if (key === 'oauth-config') {
        return {
          setupComplete: true,
          activeTokenKey: 'token-v-test',
          expectedChannelIdHash: expectedHash
        };
      }

      if (key === 'token-v-test') {
        return encrypted;
      }

      return null;
    }
  };
}

function createAxios(options = {}) {
  const calls = [];

  return {
    calls,

    async post(url, body, config) {
      calls.push({
        method: 'post',
        url,
        body,
        config
      });

      return {
        data: {
          access_token: 'access-token-test'
        }
      };
    },

    async get(url, config) {
      calls.push({
        method: 'get',
        url,
        config
      });

      if (url.includes('/liveBroadcasts')) {
        return {
          data: {
            items: options.inactive
              ? []
              : [{
                  id: 'video-test',
                  snippet: {
                    liveChatId: 'chat-test'
                  },
                  status: {
                    lifeCycleStatus: 'live'
                  }
                }]
          }
        };
      }

      if (url.includes('/liveChat/messages')) {
        return {
          data: {
            items: [{
              id: 'message-test',
              snippet: {
                type: 'textMessageEvent',
                displayMessage: 'Olá'
              },
              authorDetails: {
                displayName: 'Viewer'
              }
            }],
            nextPageToken: 'next-test',
            pollingIntervalMillis: 3000
          }
        };
      }

      throw new Error('URL inesperado');
    }
  };
}

test.beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  configureEnvironment();
  resetCacheForTests();
});

test.after(() => {
  process.env = ORIGINAL_ENV;
});

test('1. Rejeita métodos diferentes de GET', async () => {
  const response = await handler({
    httpMethod: 'POST'
  });

  assert.equal(response.statusCode, 405);
});

test('2. Falha graciosamente sem configuração OAuth', async () => {
  delete process.env.YOUTUBE_OAUTH_CLIENT_ID;

  const response = await handler(
    {
      httpMethod: 'GET',
      queryStringParameters: {}
    },
    {},
    { secretsStore: createStore() },
    createAxios()
  );

  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(
    response.body,
    /refresh-token-test|access-token-test/
  );
});

test('3. Devolve estado inativo sem transmissão', async () => {
  const response = await handler(
    {
      httpMethod: 'GET',
      queryStringParameters: {}
    },
    {},
    { secretsStore: createStore() },
    createAxios({ inactive: true })
  );

  assert.equal(response.statusCode, 200);

  const body = JSON.parse(response.body);

  assert.equal(body.active, false);
  assert.equal(body.chatAvailable, false);
  assert.deepEqual(body.items, []);
});

test('4. Obtém mensagens com OAuth server-side', async () => {
  const axios = createAxios();

  const response = await handler(
    {
      httpMethod: 'GET',
      queryStringParameters: {}
    },
    {},
    { secretsStore: createStore() },
    axios
  );

  assert.equal(response.statusCode, 200);

  const body = JSON.parse(response.body);

  assert.equal(body.active, true);
  assert.equal(body.chatAvailable, true);
  assert.equal(body.items.length, 1);
  assert.equal(body.nextPageToken, 'next-test');

  const chatCall = axios.calls.find(
    call => call.url.includes('/liveChat/messages')
  );

  assert.ok(chatCall);
  assert.equal(
    chatCall.config.headers.Authorization,
    'Bearer access-token-test'
  );

  assert.doesNotMatch(
    response.body,
    /refresh-token-test|access-token-test|secret-test/
  );
});

test('5. Encaminha pageToken válido', async () => {
  const axios = createAxios();

  const response = await handler(
    {
      httpMethod: 'GET',
      queryStringParameters: {
        pageToken: 'page-token_123'
      }
    },
    {},
    { secretsStore: createStore() },
    axios
  );

  assert.equal(response.statusCode, 200);

  const chatCall = axios.calls.find(
    call => call.url.includes('/liveChat/messages')
  );

  assert.equal(
    chatCall.config.params.pageToken,
    'page-token_123'
  );
});


test('6. liveBroadcasts do chat não combina mine com broadcastStatus', async () => {
  const axios = createAxios();

  const response = await handler(
    {
      httpMethod: 'GET',
      queryStringParameters: {}
    },
    {},
    { secretsStore: createStore() },
    axios
  );

  assert.equal(response.statusCode, 200);

  const call = axios.calls.find(
    current =>
      current.url.includes('/liveBroadcasts')
  );

  assert.ok(call);
  assert.equal(call.config.params.mine, undefined);
  assert.equal(
    call.config.params.broadcastStatus,
    'active'
  );
  assert.equal(
    call.config.params.broadcastType,
    'all'
  );
});
