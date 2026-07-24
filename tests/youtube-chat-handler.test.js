const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  encryptRefreshToken
} = require(
  '../netlify/functions/utils/oauth-helpers.js'
);

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
    .update(
      process.env.YOUTUBE_EXPECTED_CHANNEL_ID
    )
    .digest('hex');

  const encrypted = encryptRefreshToken(
    'refresh-token-test',
    process.env
      .YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY
  );

  return {
    async get(key) {
      if (key === 'oauth-config') {
        return {
          setupComplete: true,
          activeTokenKey:
            'token-v-test',
          expectedChannelIdHash:
            expectedHash
        };
      }

      if (key === 'token-v-test') {
        return encrypted;
      }

      return null;
    }
  };
}

function publicChatHtml() {
  const config = {
    INNERTUBE_API_KEY:
      'public-api-key-test',
    INNERTUBE_CLIENT_VERSION:
      '2.20260722.00.00',
    INNERTUBE_CONTEXT_CLIENT_NAME:
      1,
    VISITOR_DATA:
      'visitor-test'
  };

  const initialData = {
    continuationContents: {
      liveChatContinuation: {
        continuations: [{
          invalidationContinuationData: {
            continuation:
              'public-continuation-initial',
            timeoutMs: 1000
          }
        }]
      }
    }
  };

  return (
    '<script>ytcfg.set(' +
    JSON.stringify(config) +
    ');</script>' +
    '<script>var ytInitialData = ' +
    JSON.stringify(initialData) +
    ';</script>'
  );
}

function publicChatResponse() {
  return {
    continuationContents: {
      liveChatContinuation: {
        actions: [{
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id:
                  'public-message-test',
                timestampUsec:
                  '1784900000000000',
                authorName: {
                  simpleText:
                    'Viewer Público'
                },
                authorPhoto: {
                  thumbnails: [{
                    url:
                      'https://example.test/avatar.jpg'
                  }]
                },
                message: {
                  runs: [{
                    text:
                      'Olá pelo fallback'
                  }]
                }
              }
            }
          }
        }],
        continuations: [{
          timedContinuationData: {
            continuation:
              'public-continuation-next',
            timeoutMs: 2500
          }
        }]
      }
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

      if (
        url.includes(
          'oauth2.googleapis.com/token'
        )
      ) {
        return {
          data: {
            access_token:
              'access-token-test'
          }
        };
      }

      if (
        url.includes(
          '/live_chat/get_live_chat'
        )
      ) {
        return {
          data: publicChatResponse()
        };
      }

      throw new Error(
        'POST inesperado: ' + url
      );
    },

    async get(url, config) {
      calls.push({
        method: 'get',
        url,
        config
      });

      if (
        url.includes('/liveBroadcasts')
      ) {
        if (options.quotaExceeded) {
          const error = new Error(
            'Quota exceeded'
          );

          error.response = {
            status: 403,
            data: {
              error: {
                errors: [{
                  reason:
                    'quotaExceeded'
                }]
              }
            }
          };

          throw error;
        }

        return {
          data: {
            items: options.inactive
              ? []
              : [{
                  id:
                    'video-test1',
                  snippet: {
                    liveChatId:
                      'chat-test'
                  },
                  status: {
                    lifeCycleStatus:
                      'live'
                  }
                }]
          }
        };
      }

      if (
        url.includes(
          '/liveChat/messages'
        )
      ) {
        return {
          data: {
            items: [{
              id:
                'message-test',
              snippet: {
                type:
                  'textMessageEvent',
                displayMessage:
                  'Olá'
              },
              authorDetails: {
                displayName:
                  'Viewer'
              }
            }],
            nextPageToken:
              'next-test',
            pollingIntervalMillis:
              3000
          }
        };
      }

      if (
        url.includes(
          'youtube.com/live_chat'
        )
      ) {
        return {
          data: publicChatHtml(),
          config: {
            url
          }
        };
      }

      throw new Error(
        'GET inesperado: ' + url
      );
    }
  };
}

test.beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV
  };

  configureEnvironment();
  resetCacheForTests();
});

test.after(() => {
  process.env = ORIGINAL_ENV;
});

test(
  '1. Rejeita métodos diferentes de GET',
  async () => {
    const response = await handler({
      httpMethod: 'POST'
    });

    assert.equal(
      response.statusCode,
      405
    );
  }
);

test(
  '2. Usa fallback público sem configuração OAuth',
  async () => {
    delete process.env
      .YOUTUBE_OAUTH_CLIENT_ID;

    const response = await handler(
      {
        httpMethod: 'GET',
        queryStringParameters: {
          videoId: 'P11xnU5iwc4'
        }
      },
      {},
      {
        secretsStore: createStore()
      },
      createAxios()
    );

    assert.equal(
      response.statusCode,
      200
    );

    const body = JSON.parse(
      response.body
    );

    assert.equal(
      body.chatAvailable,
      true
    );

    assert.equal(
      body.source,
      'public-live-chat'
    );

    assert.equal(
      body.items[0]
        .snippet.displayMessage,
      'Olá pelo fallback'
    );
  }
);

test(
  '3. Devolve estado inativo sem transmissão',
  async () => {
    const response = await handler(
      {
        httpMethod: 'GET',
        queryStringParameters: {}
      },
      {},
      {
        secretsStore: createStore()
      },
      createAxios({
        inactive: true
      })
    );

    assert.equal(
      response.statusCode,
      200
    );

    const body = JSON.parse(
      response.body
    );

    assert.equal(
      body.active,
      false
    );

    assert.equal(
      body.chatAvailable,
      false
    );

    assert.deepEqual(
      body.items,
      []
    );
  }
);

test(
  '4. Obtém mensagens com OAuth server-side',
  async () => {
    const axios = createAxios();

    const response = await handler(
      {
        httpMethod: 'GET',
        queryStringParameters: {}
      },
      {},
      {
        secretsStore: createStore()
      },
      axios
    );

    assert.equal(
      response.statusCode,
      200
    );

    const body = JSON.parse(
      response.body
    );

    assert.equal(
      body.active,
      true
    );

    assert.equal(
      body.chatAvailable,
      true
    );

    assert.equal(
      body.source,
      'youtube-data-api'
    );

    assert.equal(
      body.items.length,
      1
    );

    assert.equal(
      body.nextPageToken,
      'next-test'
    );

    const chatCall =
      axios.calls.find(
        call =>
          call.url.includes(
            '/liveChat/messages'
          )
      );

    assert.ok(chatCall);

    assert.equal(
      chatCall.config
        .headers.Authorization,
      'Bearer access-token-test'
    );

    assert.doesNotMatch(
      response.body,
      /refresh-token-test|access-token-test|secret-test/
    );
  }
);

test(
  '5. Encaminha pageToken válido no OAuth',
  async () => {
    const axios = createAxios();

    const response = await handler(
      {
        httpMethod: 'GET',
        queryStringParameters: {
          pageToken:
            'page-token_123'
        }
      },
      {},
      {
        secretsStore: createStore()
      },
      axios
    );

    assert.equal(
      response.statusCode,
      200
    );

    const chatCall =
      axios.calls.find(
        call =>
          call.url.includes(
            '/liveChat/messages'
          )
      );

    assert.equal(
      chatCall.config.params.pageToken,
      'page-token_123'
    );
  }
);

test(
  '6. liveBroadcasts não combina mine com broadcastStatus',
  async () => {
    const axios = createAxios();

    const response = await handler(
      {
        httpMethod: 'GET',
        queryStringParameters: {}
      },
      {},
      {
        secretsStore: createStore()
      },
      axios
    );

    assert.equal(
      response.statusCode,
      200
    );

    const call =
      axios.calls.find(
        current =>
          current.url.includes(
            '/liveBroadcasts'
          )
      );

    assert.ok(call);

    assert.equal(
      call.config.params.mine,
      undefined
    );

    assert.equal(
      call.config.params
        .broadcastStatus,
      'active'
    );

    assert.equal(
      call.config.params
        .broadcastType,
      'all'
    );
  }
);

test(
  '7. Quota OAuth esgotada ativa fallback público',
  async () => {
    const axios = createAxios({
      quotaExceeded: true
    });

    const response = await handler(
      {
        httpMethod: 'GET',
        queryStringParameters: {
          videoId: 'P11xnU5iwc4'
        }
      },
      {},
      {
        secretsStore: createStore()
      },
      axios
    );

    assert.equal(
      response.statusCode,
      200
    );

    const body = JSON.parse(
      response.body
    );

    assert.equal(
      body.source,
      'public-live-chat'
    );

    assert.equal(
      body.oauthFallback,
      true
    );

    assert.equal(
      body.chatAvailable,
      true
    );

    assert.equal(
      body.fallbackReason,
      'quotaExceeded'
    );

    assert.equal(
      body.items[0].authorDetails
        .displayName,
      'Viewer Público'
    );

    const publicCall =
      axios.calls.find(
        call =>
          call.url.includes(
            '/live_chat/get_live_chat'
          )
      );

    assert.ok(publicCall);
  }
);