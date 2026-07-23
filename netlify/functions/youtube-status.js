const axios = require('axios');

// Cache em memória durante 12 segundos
let cachedResponse = null;
let lastFetchTimestamp = 0;
const CACHE_TTL_MS = 12000;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cookie': 'SOCS=CAESEwgDEgk1ODE3OTM1MjEaAmVuIAEaBgiA_L2bBg',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

/**
 * Função de parsing de espectadores em tempo real.
 * Aceita ESTRITAMENTE palavras-chave de espectadores em direto.
 * Rejeita total de visualizações, reproduções ou views acumuladas.
 */
function parseViewersText(text) {
  if (!text || typeof text !== 'string') return null;

  const normalized = text.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ').trim();

  // Verificar presença estrita de identificadores de espectadores simultâneos
  const isLiveViewerText = /(?:a ver|watching|espectadores|viewers|espectadores ao vivo)/i.test(normalized);
  if (!isLiveViewerText) {
    return null; // Rejeita total de visualizações
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
 * Renovar Access Token do OAuth 2.0 usando Refresh Token
 */
async function getOAuthAccessToken() {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  try {
    const res = await axios.post(
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
async function fetchSourceOAuthBroadcast(accessToken) {
  const observedAt = new Date().toISOString();
  if (!accessToken) {
    return { status: "unknown", observedAt, error: "OAuth credentials or access_token not available" };
  }

  try {
    const res = await axios.get(
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
async function fetchSourceOAuthVideo(videoId, accessToken) {
  const observedAt = new Date().toISOString();
  if (!videoId || !accessToken) {
    return { status: "unknown", observedAt, error: "videoId or accessToken missing" };
  }

  try {
    const res = await axios.get(
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
async function fetchSourcePlayer(videoId) {
  const observedAt = new Date().toISOString();
  if (!videoId) return { status: "unknown", observedAt, error: "videoId missing" };

  try {
    const res = await axios.post(
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
        timeout: 5000
      }
    );

    const vDetails = res.data?.videoDetails || {};
    const microformat = res.data?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};

    const isLiveNow = microformat.isLiveNow === true;
    const isLive = vDetails.isLive === true && res.data?.playabilityStatus?.status === 'OK';

    return {
      status: "confirmed",
      observedAt,
      videoId: vDetails.videoId || videoId,
      title: vDetails.title || "",
      isLiveNow,
      isLive: isLiveNow || isLive
    };
  } catch (err) {
    return { status: "error", observedAt, error: err.message };
  }
}

/**
 * FONTE D: InnerTube /next (espectadores)
 */
async function fetchSourceNext(videoId) {
  const observedAt = new Date().toISOString();
  if (!videoId) return { status: "unknown", observedAt, error: "videoId missing" };

  try {
    const res = await axios.post(
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
        timeout: 5000
      }
    );

    let viewerText = null;
    let viewers = null;

    const contents = res.data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    for (const item of contents) {
      const primary = item.videoPrimaryInfoRenderer;
      if (primary && primary.viewCount?.videoViewCountRenderer) {
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

    if (viewerText) {
      viewers = parseViewersText(viewerText);
    }

    return {
      status: "confirmed",
      observedAt,
      videoId,
      viewerText,
      viewers
    };
  } catch (err) {
    return { status: "error", observedAt, error: err.message };
  }
}

/**
 * FONTE E: HTML Scraping Público (/c/apexscorpio/live)
 */
async function fetchSourceHTML() {
  const observedAt = new Date().toISOString();
  let resolvedUrl = "https://www.youtube.com/c/apexscorpio/live";
  try {
    const res = await axios.get(resolvedUrl, {
      headers: HTTP_HEADERS,
      maxRedirects: 5,
      timeout: 5000,
      validateStatus: () => true
    });

    if (res.request?.res?.responseUrl) {
      resolvedUrl = res.request.res.responseUrl;
    }

    const html = typeof res.data === 'string' ? res.data : '';

    const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})">/) ||
                           html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);

    let videoId = canonicalMatch ? canonicalMatch[1] : null;
    if (!videoId && resolvedUrl.includes('watch?v=')) {
      const m = resolvedUrl.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m) videoId = m[1];
    }

    let viewerText = null;
    const viewerPatterns = [
      /"viewCount":\s*\{\s*"runs":\s*\[\s*\{\s*"text":\s*"([^"]+)"/,
      /"viewCount":\s*\{\s*"simpleText":\s*"([^"]+)"/,
      /([\d,\.\s\u00a0]+)\s*(?:a ver agora|watching now|espectadores ao vivo)/i
    ];
    for (const p of viewerPatterns) {
      const m = html.match(p);
      if (m && m[1] && /(?:a ver|watching|espectadores|viewers)/i.test(m[1])) {
        viewerText = m[1];
        break;
      }
    }

    const viewers = parseViewersText(viewerText);

    return {
      status: "confirmed",
      observedAt,
      resolvedUrl,
      videoId,
      viewerText,
      viewers
    };
  } catch (err) {
    return { status: "error", observedAt, resolvedUrl, error: err.message };
  }
}

/**
 * Função Principal de Agregação Multifonte e Consenso
 */
async function getLiveStatus() {
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

  // 1. Obter Access Token se credenciais OAuth estiverem configuradas
  const accessToken = await getOAuthAccessToken();

  // 2. Consultar Fontes em Paralelo
  const sourceHTML = await fetchSourceHTML();
  const sourceOAuthBroadcast = await fetchSourceOAuthBroadcast(accessToken);

  // Determinar candidato principal de videoId
  let targetVideoId = sourceOAuthBroadcast.videoId || sourceHTML.videoId || null;

  const [sourceOAuthVideo, sourcePlayer, sourceNext] = await Promise.all([
    fetchSourceOAuthVideo(targetVideoId, accessToken),
    fetchSourcePlayer(targetVideoId),
    fetchSourceNext(targetVideoId)
  ]);

  // 3. PRIORIDADE E CONSENSO PARA `videoId`
  let videoId = sourceOAuthBroadcast.videoId || sourceHTML.videoId || sourcePlayer.videoId || null;

  // 4. PRIORIDADE E CONSENSO PARA `isLive`
  let isLive = false;
  let liveSignalsCount = 0;

  if (sourceOAuthBroadcast.isLive) liveSignalsCount++;
  if (sourceOAuthVideo.isLive) liveSignalsCount++;
  if (sourcePlayer.isLive) liveSignalsCount++;

  if (sourceOAuthBroadcast.isLive || sourcePlayer.isLive || (sourceOAuthVideo.isLive && liveSignalsCount >= 1)) {
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

  let title = sourceOAuthBroadcast.title || sourceOAuthVideo.title || sourcePlayer.title || "";
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
      version: "5.0",
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
