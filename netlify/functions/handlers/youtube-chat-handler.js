const crypto = require('crypto');

const {
  safeCompare,
  getBlobsStore,
  decryptRefreshToken
} = require('../utils/oauth-helpers.js');

const {
  fetchPublicLiveChat,
  resetPublicChatCache,
  validContinuation,
  validVideoId
} = require('./youtube-public-chat-fallback.js');

let runtimeAxios = null;

let cachedLiveChat = {
  liveChatId: null,
  videoId: null,
  expiresAt: 0
};

let oauthBlockedUntil = 0;

function setRuntimeAxios(axiosInstance) {
  if (
    !axiosInstance ||
    typeof axiosInstance.get !== 'function' ||
    typeof axiosInstance.post !== 'function'
  ) {
    throw new Error('axios runtime inválido');
  }

  runtimeAxios = axiosInstance;
}

function resetCacheForTests() {
  cachedLiveChat = {
    liveChatId: null,
    videoId: null,
    expiresAt: 0
  };

  oauthBlockedUntil = 0;
  resetPublicChatCache();
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':
        'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':
        'Content-Type',
      'Access-Control-Allow-Methods':
        'GET, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

function resolveCustomStore(customStores) {
  if (!customStores) return null;

  return (
    customStores.secretsStore ||
    customStores.oauthStore ||
    customStores
  );
}

function providerReason(error) {
  return (
    error?.response?.data
      ?.error?.errors?.[0]?.reason ||
    error?.response?.data
      ?.error?.status ||
    error?.code ||
    null
  );
}

function isQuotaOrPermissionError(error) {
  const status =
    Number(error?.response?.status || 0);

  const reason =
    String(providerReason(error) || '');

  return (
    status === 403 ||
    reason === 'quotaExceeded' ||
    reason === 'dailyLimitExceeded' ||
    reason === 'forbidden'
  );
}

async function getOAuthAccessToken(
  http,
  customSecretsStore = null
) {
  const clientId =
    process.env.YOUTUBE_OAUTH_CLIENT_ID;

  const clientSecret =
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET;

  const encryptionKey =
    process.env
      .YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY;

  const expectedChannelId =
    process.env.YOUTUBE_EXPECTED_CHANNEL_ID;

  if (
    !clientId ||
    !clientSecret ||
    !encryptionKey ||
    !expectedChannelId
  ) {
    return null;
  }

  const expectedHash = crypto
    .createHash('sha256')
    .update(expectedChannelId)
    .digest('hex');

  const store = getBlobsStore(
    'youtube-oauth-secrets',
    customSecretsStore
  );

  const config = await store.get(
    'oauth-config',
    { type: 'json' }
  );

  if (
    !config ||
    config.setupComplete !== true ||
    !config.activeTokenKey ||
    !config.expectedChannelIdHash ||
    !safeCompare(
      expectedHash,
      config.expectedChannelIdHash
    )
  ) {
    return null;
  }

  const encryptedToken = await store.get(
    config.activeTokenKey,
    { type: 'json' }
  );

  const refreshToken = decryptRefreshToken(
    encryptedToken,
    encryptionKey
  );

  if (!refreshToken) {
    return null;
  }

  const tokenResponse = await http.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    {
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      timeout: 5000
    }
  );

  return (
    tokenResponse?.data?.access_token ||
    null
  );
}

async function getCurrentLiveChat(
  http,
  accessToken
) {
  const now = Date.now();

  if (
    cachedLiveChat.liveChatId &&
    cachedLiveChat.expiresAt > now
  ) {
    return {
      active: true,
      videoId:
        cachedLiveChat.videoId,
      liveChatId:
        cachedLiveChat.liveChatId
    };
  }

  const response = await http.get(
    'https://www.googleapis.com/youtube/v3/liveBroadcasts',
    {
      params: {
        part: 'id,snippet,status',
        broadcastStatus: 'active',
        broadcastType: 'all',
        maxResults: 1
      },
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      },
      timeout: 5000
    }
  );

  const broadcast =
    response?.data?.items?.[0] || null;

  const liveChatId =
    broadcast?.snippet?.liveChatId ||
    null;

  if (!broadcast || !liveChatId) {
    cachedLiveChat = {
      liveChatId: null,
      videoId: null,
      expiresAt: 0
    };

    return {
      active: Boolean(broadcast),
      videoId: broadcast?.id || null,
      liveChatId: null
    };
  }

  cachedLiveChat = {
    liveChatId,
    videoId: broadcast.id || null,
    expiresAt: now + 30000
  };

  return {
    active: true,
    videoId: broadcast.id || null,
    liveChatId
  };
}

async function getOfficialMessages(
  http,
  accessToken,
  live,
  pageToken
) {
  const params = {
    liveChatId: live.liveChatId,
    part: 'id,snippet,authorDetails',
    maxResults: 200,
    hl: 'pt-PT'
  };

  if (pageToken) {
    params.pageToken = pageToken;
  }

  const messagesResponse = await http.get(
    'https://www.googleapis.com/youtube/v3/liveChat/messages',
    {
      params,
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      },
      timeout: 10000
    }
  );

  const data = messagesResponse?.data || {};

  return {
    active: true,
    videoId: live.videoId,
    liveChatId: live.liveChatId,
    chatAvailable: true,
    items:
      Array.isArray(data.items)
        ? data.items
        : [],
    nextPageToken:
      data.nextPageToken || null,
    pollingIntervalMillis:
      Number(
        data.pollingIntervalMillis ||
        5000
      ),
    offlineAt:
      data.offlineAt || null,
    source: 'youtube-data-api',
    oauthFallback: false
  };
}

exports.handler = async function(
  event,
  context,
  customStores = null,
  customAxios = null
) {
  if (event?.httpMethod === 'OPTIONS') {
    return jsonResponse(204, {});
  }

  if (event?.httpMethod !== 'GET') {
    return jsonResponse(405, {
      error: 'Método não permitido'
    });
  }

  const http =
    customAxios || runtimeAxios;

  if (!http) {
    return jsonResponse(503, {
      error:
        'Serviço HTTP indisponível'
    });
  }

  const pageToken =
    event?.queryStringParameters
      ?.pageToken || null;

  const requestedVideoId =
    event?.queryStringParameters
      ?.videoId || null;

  if (!validContinuation(pageToken)) {
    return jsonResponse(400, {
      error:
        'Page token inválido'
    });
  }

  if (
    requestedVideoId &&
    !validVideoId(requestedVideoId)
  ) {
    return jsonResponse(400, {
      error:
        'Video ID inválido'
    });
  }

  let oauthFailure =
    Date.now() < oauthBlockedUntil
      ? 'oauth_temporarily_blocked'
      : null;

  if (!oauthFailure) {
    try {
      const accessToken =
        await getOAuthAccessToken(
          http,
          resolveCustomStore(customStores)
        );

      if (accessToken) {
        const live =
          await getCurrentLiveChat(
            http,
            accessToken
          );

        if (
          live.active &&
          live.liveChatId
        ) {
          try {
            const official =
              await getOfficialMessages(
                http,
                accessToken,
                live,
                pageToken
              );

            return jsonResponse(
              200,
              official
            );
          } catch (error) {
            oauthFailure =
              providerReason(error) ||
              'official_chat_failed';

            if (
              isQuotaOrPermissionError(
                error
              )
            ) {
              oauthBlockedUntil =
                Date.now() +
                10 * 60 * 1000;
            }
          }
        } else if (!live.active) {
          return jsonResponse(200, {
            active: false,
            videoId: null,
            liveChatId: null,
            chatAvailable: false,
            items: [],
            nextPageToken: null,
            pollingIntervalMillis: 5000,
            source: 'youtube-data-api',
            oauthFallback: false
          });
        } else {
          oauthFailure =
            'official_live_chat_id_missing';
        }
      } else {
        oauthFailure =
          'oauth_unavailable';
      }
    } catch (error) {
      oauthFailure =
        providerReason(error) ||
        'oauth_request_failed';

      if (
        isQuotaOrPermissionError(error)
      ) {
        oauthBlockedUntil =
          Date.now() +
          10 * 60 * 1000;
      }
    }
  }

  try {
    const fallback =
      await fetchPublicLiveChat({
        http,
        videoId: requestedVideoId,
        pageToken,
        channelId:
          process.env
            .YOUTUBE_EXPECTED_CHANNEL_ID
      });

    return jsonResponse(200, {
      ...fallback,
      fallbackReason:
        oauthFailure ||
        'official_chat_unavailable'
    });
  } catch (error) {
    return jsonResponse(502, {
      active: false,
      videoId:
        requestedVideoId || null,
      liveChatId: null,
      chatAvailable: false,
      items: [],
      nextPageToken: null,
      pollingIntervalMillis: 5000,
      source: 'public-live-chat',
      oauthFallback: true,
      error:
        'Não foi possível obter o chat do YouTube',
      fallbackReason:
        oauthFailure ||
        'official_chat_unavailable',
      fallbackCode:
        error?.code || null
    });
  }
};

exports.setRuntimeAxios =
  setRuntimeAxios;

exports.resetCacheForTests =
  resetCacheForTests;

exports.getOAuthAccessToken =
  getOAuthAccessToken;