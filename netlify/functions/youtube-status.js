const axios = require('axios');
const { getBlobsStore, decryptRefreshToken } = require('./utils/oauth-helpers.js');

// Cache em memória durante 12 segundos
let cachedResponse = null;
let lastFetchTimestamp = 0;
const CACHE_TTL_MS = 12000;

/**
 * Função utilitária para resetar a cache em memória durante os testes
 */
function resetCacheForTests() {
  cachedResponse = null;
  lastFetchTimestamp = 0;
}

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cookie': 'SOCS=CAESEwgDEgk1ODE3OTM1MjEaAmVuIAEaBgiA_L2bBg',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

/**
 * Função de parsing de espectadores em tempo real.
 */
function parseViewersText(text) {
  if (!text || typeof text !== 'string') return null;

  const normalized = text.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ').trim();

  const isLiveViewerText = /(?:a ver|watching|espectadores|viewers|espectadores ao vivo)/i.test(normalized);
  if (!isLiveViewerText) {
    return null;
  }

  const match = normalized.match(/([\d\s\,\.]+)\s*(?:a ver|watching|espectadores|viewers)/i);
  if (match && match[1]) {
    const rawNumStr = match[1].replace(/[^\d]/g, '');
    if (rawNumStr) {
      const num = parseInt(rawNumStr, 10);
      return isNaN(num) ? null : num;
    }
  }

  return null;
}

/**
 * Obter Access Token do OAuth 2.0:
 * Origem exclusiva: Netlify Blobs → 'oauth-config' → validação expectedChannelIdHash → AES-256-GCM
 * Não utiliza YOUTUBE_OAUTH_REFRESH_TOKEN como fallback (proibido por design de segurança).
 * Valida expectedChannelIdHash antes de usar o token ativo.
 */
async function getOAuthAccessToken(customSecretsStore = null, customAxios = null) {
  const http = customAxios || axios;
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const encryptionKey = process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY;
  const expectedChannelId = process.env.YOUTUBE_EXPECTED_CHANNEL_ID;

  if (!clientId || !clientSecret || !encryptionKey || !expectedChannelId) {
    return null;
  }

  // Calcular SHA-256 do expectedChannelId local (usado para validar o hash armazenado)
  const localChannelIdHash = require('crypto').createHash('sha256').update(expectedChannelId).digest('hex');

  let refreshToken = null;

  // Procurar no Netlify Blobs a chave ativa indicada em oauth-config (SEM FALLBACKS)
  try {
    const secretsStore = getBlobsStore('youtube-oauth-secrets', customSecretsStore);
    const oauthConfig = await secretsStore.getJSON('oauth-config');

    if (oauthConfig && oauthConfig.setupComplete === true && oauthConfig.activeTokenKey) {
      // Validar que o expectedChannelIdHash gravado corresponde ao canal configurado localmente
      if (!oauthConfig.expectedChannelIdHash) {
        // Hash ausente na configuração — fail-closed
        return null;
      }
      const { safeCompare: sc } = require('./utils/oauth-helpers.js');
      if (!sc(localChannelIdHash, oauthConfig.expectedChannelIdHash)) {
        // Hash diverge — token de outro canal — fail-closed sem expor hashes ou IDs
        return null;
      }

      const encryptedBlob = await secretsStore.getJSON(oauthConfig.activeTokenKey);
      if (encryptedBlob) {
        refreshToken = decryptRefreshToken(encryptedBlob, encryptionKey);
      }
    }
  } catch (err) {
    // Blobs indisponível ou falha na decifragem — fail-closed
    return null;
  }

  if (!refreshToken) {
    return null;
  }

  try {
    const res = await http.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 4000
      }
    );
    return res.data?.access_token || null;
  } catch (err) {
    return null;
  }
}

/**
 * FONTE A: OAuth liveBroadcasts.list
 */
async function fetchSourceOAuthBroadcast(accessToken, customAxios = null) {
  const http = customAxios || axios;
  const observedAt = new Date().toISOString();
  if (!accessToken) {
    return { status: "unknown", observedAt, error: "OAuth credentials or access_token not available" };
  }

  try {
    const res = await http.get(
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,snippet,status&mine=true&broadcastStatus=active&broadcastType=all',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000
      }
    );

    const item = res.data?.items?.[0];
    if (item) {
      return {
        status: "confirmed",
        observedAt,
        videoId: item.id,
        title: item.snippet?.title || "",
        lifeCycleStatus: item.status?.lifeCycleStatus || "live",
        liveChatId: item.snippet?.liveChatId || null,
        isLive: true
      };
    } else {
      return {
        status: "confirmed",
        observedAt,
        isLive: false,
        videoId: null
      };
    }
  } catch (err) {
    return { status: "error", observedAt, error: err.message };
  }
}

/**
 * FONTE B: OAuth / API videos.list (liveStreamingDetails)
 */
async function fetchSourceOAuthVideo(videoId, accessToken, customAxios = null) {
  const http = customAxios || axios;
  const observedAt = new Date().toISOString();
  if (!videoId || !accessToken) {
    return { status: "unknown", observedAt, error: "videoId or accessToken missing" };
  }

  try {
    const res = await http.get(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails,status&id=${encodeURIComponent(videoId)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000
      }
    );

    const item = res.data?.items?.[0];
    if (item) {
      const lsd = item.liveStreamingDetails || {};
      let viewers = null;
      if (lsd.concurrentViewers !== undefined && lsd.concurrentViewers !== null) {
        const parsed = parseInt(lsd.concurrentViewers, 10);
        viewers = isNaN(parsed) ? null : parsed;
      }

      return {
        status: "confirmed",
        observedAt,
        videoId: item.id,
        title: item.snippet?.title || "",
        liveChatId: lsd.activeLiveChatId || null,
        concurrentViewers: viewers,
        actualStartTime: lsd.actualStartTime || null,
        actualEndTime: lsd.actualEndTime || null,
        isLive: !lsd.actualEndTime && Boolean(lsd.actualStartTime)
      };
    }

    return { status: "unknown", observedAt, error: "Video item not found in videos.list" };
  } catch (err) {
    return { status: "error", observedAt, error: err.message };
  }
}

/**
 * FONTE C: InnerTube /player
 */
async function fetchSourcePlayer(videoId, customAxios = null) {
  const http = customAxios || axios;
  const observedAt = new Date().toISOString();
  if (!videoId) return { status: "unknown", observedAt, error: "videoId missing" };

  try {
    const res = await http.post(
      'https://www.youtube.com/youtubei/v1/player',
      {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20260722.00.00',
            hl: 'pt-PT',
            gl: 'PT'
          }
        },
        videoId: videoId
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 4000
      }
    );

    const vDetails = res.data?.videoDetails || {};
    const microformat = res.data?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};

    const isLiveNow = microformat.isLiveNow === true;
    const isLive = isLiveNow || vDetails.isLive === true;

    return {
      status: "confirmed",
      observedAt,
      videoId: vDetails.videoId || videoId,
      title: vDetails.title || "",
      isLiveNow,
      isLive: isLive,
      playabilityStatus: res.data?.playabilityStatus?.status || "UNKNOWN"
    };
  } catch (err) {
    return { status: "error", observedAt, error: err.message };
  }
}

/**
 * FONTE D: InnerTube /next (espectadores em tempo real)
 */
async function fetchSourceNext(videoId, customAxios = null) {
  const http = customAxios || axios;
  const observedAt = new Date().toISOString();
  if (!videoId) return { status: "unknown", observedAt, error: "videoId missing" };

  try {
    const res = await http.post(
      'https://www.youtube.com/youtubei/v1/next',
      {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20260722.00.00',
            hl: 'pt-PT',
            gl: 'PT'
          }
        },
        videoId: videoId
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 4000
      }
    );

    let viewerText = null;
    let title = "";
    let viewers = null;

    const contents = res.data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    for (const item of contents) {
      const primary = item.videoPrimaryInfoRenderer;
      if (primary) {
        if (primary.title?.runs) {
          title = primary.title.runs.map(r => r.text || '').join('');
        }
        if (primary.viewCount?.videoViewCountRenderer) {
          const vvcr = primary.viewCount.videoViewCountRenderer;
          if (vvcr.viewCount?.runs) {
            const txt = vvcr.viewCount.runs.map(r => r.text || '').join('');
            if (/(?:a ver|watching|espectadores|viewers)/i.test(txt)) {
              viewerText = txt;
            }
          } else if (vvcr.viewCount?.simpleText) {
            const txt = vvcr.viewCount.simpleText;
            if (/(?:a ver|watching|espectadores|viewers)/i.test(txt)) {
              viewerText = txt;
            }
          }
        }
      }
    }

    if (viewerText) {
      viewers = parseViewersText(viewerText);
    }

    return {
      status: "confirmed",
      observedAt,
      videoId,
      title,
      viewerText,
      viewers,
      isLive: viewers !== null
    };
  } catch (err) {
    return { status: "error", observedAt, error: err.message };
  }
}

/**
 * FONTE E: Descoberta Dinâmica de Candidatos e HTML Scraping
 */
async function fetchSourceHTML(customAxios = null) {
  const http = customAxios || axios;
  const observedAt = new Date().toISOString();
  const candidateIds = new Set();
  const discoveryUrls = [
    'https://www.youtube.com/@apexscorpio/streams',
    'https://www.youtube.com/c/apexscorpio/streams',
    'https://www.youtube.com/@apexscorpio/live',
    'https://www.youtube.com/c/apexscorpio/live',
    'https://www.youtube.com/@apexscorpio'
  ];

  let resolvedUrl = discoveryUrls[0];

  for (const u of discoveryUrls) {
    try {
      const res = await http.get(u, {
        headers: HTTP_HEADERS,
        maxRedirects: 5,
        timeout: 4000,
        validateStatus: () => true
      });

      if (res.request?.res?.responseUrl) {
        resolvedUrl = res.request.res.responseUrl;
      }

      const html = typeof res.data === 'string' ? res.data : '';
      const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(m => m[1]);
      for (const id of matches) {
        candidateIds.add(id);
      }
    } catch (err) {}
  }

  const topCandidates = Array.from(candidateIds).slice(0, 5);

  let liveVideoId = null;
  let liveTitle = "";
  let liveViewers = null;
  let liveViewerText = null;

  for (const vId of topCandidates) {
    const [playerResp, nextResp] = await Promise.all([
      fetchSourcePlayer(vId, http),
      fetchSourceNext(vId, http)
    ]);

    const isCandidateLive = (playerResp && playerResp.isLive) || (nextResp && nextResp.isLive);

    if (isCandidateLive) {
      liveVideoId = vId;
      liveTitle = playerResp?.title || nextResp?.title || "";
      if (nextResp && nextResp.viewers !== null) {
        liveViewers = nextResp.viewers;
        liveViewerText = nextResp.viewerText;
      }
      break;
    }
  }

  return {
    status: "confirmed",
    observedAt,
    resolvedUrl,
    checkedIdsCount: candidateIds.size,
    checkedIds: topCandidates,
    videoId: liveVideoId,
    title: liveTitle,
    viewerText: liveViewerText,
    viewers: liveViewers,
    isLive: Boolean(liveVideoId)
  };
}

/**
 * Função Principal de Agregação Multifonte e Consenso
 */
async function getLiveStatus(customSecretsStore = null, customAxios = null) {
  const http = customAxios || axios;
  const now = Date.now();
  if (cachedResponse && (now - lastFetchTimestamp < CACHE_TTL_MS)) {
    return {
      ...cachedResponse,
      diagnostic: {
        ...cachedResponse.diagnostic,
        cached: true
      }
    };
  }

  // 1. Obter Access Token se OAuth estiver ativo
  const accessToken = await getOAuthAccessToken(customSecretsStore, http);

  // 2. Consultar Fontes em Paralelo
  const sourceHTML = await fetchSourceHTML(http);
  const sourceOAuthBroadcast = await fetchSourceOAuthBroadcast(accessToken, http);

  // Determinar candidato principal de videoId
  let targetVideoId = sourceOAuthBroadcast.videoId || sourceHTML.videoId || null;

  const [sourceOAuthVideo, sourcePlayer, sourceNext] = await Promise.all([
    fetchSourceOAuthVideo(targetVideoId, accessToken, http),
    fetchSourcePlayer(targetVideoId, http),
    fetchSourceNext(targetVideoId, http)
  ]);

  // 3. PRIORIDADE E CONSENSO PARA `videoId`
  let videoId = sourceOAuthBroadcast.videoId || sourceHTML.videoId || sourcePlayer.videoId || null;

  // 4. PRIORIDADE E CONSENSO PARA `isLive`
  let isLive = false;
  let liveSignalsCount = 0;

  if (sourceOAuthBroadcast.isLive) liveSignalsCount++;
  if (sourceOAuthVideo.isLive) liveSignalsCount++;
  if (sourcePlayer.isLive) liveSignalsCount++;
  if (sourceNext.isLive) liveSignalsCount++;
  if (sourceHTML.isLive) liveSignalsCount++;

  if (sourceOAuthBroadcast.isLive || sourcePlayer.isLive || sourceNext.isLive || sourceHTML.isLive || (sourceOAuthVideo.isLive && liveSignalsCount >= 1)) {
    isLive = true;
  }

  // 5. PRIORIDADE E CONSENSO PARA `viewers`
  let viewers = null;
  let viewerState = "unknown";
  let validViewerSourcesCount = 0;

  if (isLive) {
    if (sourceOAuthVideo.concurrentViewers !== null && sourceOAuthVideo.concurrentViewers !== undefined) {
      viewers = sourceOAuthVideo.concurrentViewers;
      viewerState = "confirmed";
      validViewerSourcesCount++;
    } else if (sourceNext.viewers !== null && sourceNext.viewers !== undefined) {
      viewers = sourceNext.viewers;
      viewerState = "confirmed";
      validViewerSourcesCount++;
    } else if (sourceHTML.viewers !== null && sourceHTML.viewers !== undefined) {
      viewers = sourceHTML.viewers;
      viewerState = "confirmed";
      validViewerSourcesCount++;
    } else {
      viewers = null;
      viewerState = "unknown";
    }
  } else {
    viewers = null;
    viewerState = "confirmed"; // Offline confirmado
  }

  // 6. AVALIAÇÃO DE CONFIANÇA (`confidence`)
  let confidence = "none";
  if (isLive) {
    if (liveSignalsCount >= 2 || (sourceOAuthBroadcast.isLive && validViewerSourcesCount >= 1)) {
      confidence = "high";
    } else if (liveSignalsCount === 1 || validViewerSourcesCount === 1) {
      confidence = "medium";
    } else {
      confidence = "low";
    }
  } else {
    confidence = (sourceOAuthBroadcast.status === "confirmed" || sourcePlayer.status === "confirmed") ? "high" : "medium";
  }

  let title = sourceOAuthBroadcast.title || sourceOAuthVideo.title || sourcePlayer.title || sourceNext.title || sourceHTML.title || "";
  let liveChatId = sourceOAuthBroadcast.liveChatId || sourceOAuthVideo.liveChatId || null;

  const responseObj = {
    isLive: isLive,
    videoId: isLive ? videoId : null,
    viewers: isLive ? viewers : null,
    viewerState: viewerState,
    title: title,
    liveChatId: isLive ? liveChatId : null,
    confidence: confidence,
    source: "youtube-multisource-consensus",
    updatedAt: new Date().toISOString(),
    error: null,
    sources: {
      oauthBroadcast: sourceOAuthBroadcast,
      oauthVideo: sourceOAuthVideo,
      player: sourcePlayer,
      next: sourceNext,
      html: sourceHTML
    },
    diagnostic: {
      version: "6.0",
      liveSignalsCount: liveSignalsCount,
      validViewerSourcesCount: validViewerSourcesCount,
      cached: false
    }
  };

  cachedResponse = responseObj;
  lastFetchTimestamp = now;
  return responseObj;
}

exports.handler = async function(event, context) {
  const result = await getLiveStatus();
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'public, max-age=10, s-maxage=15'
    },
    body: JSON.stringify(result, null, 2)
  };
};

exports.parseViewersText = parseViewersText;
exports.getLiveStatus = getLiveStatus;
exports.resetCacheForTests = resetCacheForTests;
