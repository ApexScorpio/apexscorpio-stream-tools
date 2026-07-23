const crypto = require('crypto');

const {
  safeCompare,
  getBlobsStore,
  decryptRefreshToken
} = require('../utils/oauth-helpers.js');

let runtimeAxios = null;

let cachedLiveChat = {
  liveChatId: null,
  videoId: null,
  expiresAt: 0
};

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
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
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

async function getOAuthAccessToken(
  http,
  customSecretsStore = null
) {
  const clientId =
    process.env.YOUTUBE_OAUTH_CLIENT_ID;

  const clientSecret =
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET;

  const encryptionKey =
    process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY;

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

  return tokenResponse?.data?.access_token || null;
}

async function getCurrentLiveChat(http, accessToken) {
  const now = Date.now();

  if (
    cachedLiveChat.liveChatId &&
    cachedLiveChat.expiresAt > now
  ) {
    return {
      active: true,
      videoId: cachedLiveChat.videoId,
      liveChatId: cachedLiveChat.liveChatId
    };
  }

  const response = await http.get(
    'https://www.googleapis.com/youtube/v3/liveBroadcasts',
    {
      params: {
        part: 'id,snippet,status',
        mine: 'true',
        broadcastStatus: 'active',
        broadcastType: 'all',
        maxResults: 1
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      timeout: 5000
    }
  );

  const broadcast = response?.data?.items?.[0] || null;
  const liveChatId = broadcast?.snippet?.liveChatId || null;

  if (!broadcast || !liveChatId) {
    resetCacheForTests();

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

function validPageToken(value) {
  if (value === undefined || value === null || value === '') {
    return true;
  }

  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    /^[A-Za-z0-9._~+/=-]+$/.test(value)
  );
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

  const http = customAxios || runtimeAxios;

  if (!http) {
    return jsonResponse(503, {
      error: 'Serviço OAuth indisponível'
    });
  }

  const pageToken =
    event?.queryStringParameters?.pageToken || null;

  if (!validPageToken(pageToken)) {
    return jsonResponse(400, {
      error: 'Page token inválido'
    });
  }

  try {
    const accessToken = await getOAuthAccessToken(
      http,
      resolveCustomStore(customStores)
    );

    if (!accessToken) {
      return jsonResponse(503, {
        active: false,
        chatAvailable: false,
        error: 'OAuth do YouTube ainda não está configurado'
      });
    }

    const live = await getCurrentLiveChat(
      http,
      accessToken
    );

    if (!live.active || !live.liveChatId) {
      return jsonResponse(200, {
        active: live.active,
        videoId: live.videoId,
        liveChatId: null,
        chatAvailable: false,
        items: [],
        nextPageToken: null,
        pollingIntervalMillis: 5000
      });
    }

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
          Authorization: `Bearer ${accessToken}`
        },
        timeout: 10000
      }
    );

    const data = messagesResponse?.data || {};

    return jsonResponse(200, {
      active: true,
      videoId: live.videoId,
      liveChatId: live.liveChatId,
      chatAvailable: true,
      items: Array.isArray(data.items)
        ? data.items
        : [],
      nextPageToken: data.nextPageToken || null,
      pollingIntervalMillis:
        Number(data.pollingIntervalMillis || 5000),
      offlineAt: data.offlineAt || null
    });
  } catch (error) {
    const reason =
      error?.response?.data?.error?.errors?.[0]?.reason ||
      null;

    if (
      reason === 'liveChatEnded' ||
      reason === 'liveChatNotFound'
    ) {
      resetCacheForTests();

      return jsonResponse(200, {
        active: false,
        chatAvailable: false,
        items: [],
        nextPageToken: null,
        pollingIntervalMillis: 5000
      });
    }

    return jsonResponse(502, {
      active: false,
      chatAvailable: false,
      error: 'Não foi possível obter o chat do YouTube'
    });
  }
};

exports.setRuntimeAxios = setRuntimeAxios;
exports.resetCacheForTests = resetCacheForTests;
exports.getOAuthAccessToken = getOAuthAccessToken;
