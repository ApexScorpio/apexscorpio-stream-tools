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
 * Função de parsing de espectadores em tempo real
 * Aceita unicamente textos que descrevam espectadores simultâneos em direto:
 * - "1 a ver agora" -> 1
 * - "12 a ver agora" -> 12
 * - "1 234 a ver agora" -> 1234
 * - "1 watching now" -> 1
 * - "1,234 watching now" -> 1234
 * - "1.234 a ver agora" -> 1234
 * Rejeita categoricamente total de visualizações ou contagens estáticas.
 */
function parseViewersText(text) {
  if (!text || typeof text !== 'string') return null;

  const normalized = text.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ').trim();

  // Verificar se contém estritamente palavras-chave de espectadores em direto
  const isLiveViewerText = /(?:a ver|watching|espectadores|viewers|espectadores ao vivo)/i.test(normalized);
  if (!isLiveViewerText) {
    return null; // Rejeita total de visualizações, views e vídeos normais
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

async function fetchInnerTubePlayer(videoId) {
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
    return res.data;
  } catch (err) {
    return null;
  }
}

async function fetchInnerTubeNext(videoId) {
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
    return res.data;
  } catch (err) {
    return null;
  }
}

async function fetchOEmbedMetadata(videoId) {
  try {
    const res = await axios.get(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`,
      { timeout: 4000 }
    );
    if (res.status === 200 && res.data) {
      return res.data; // Usado ESTRITAMENTE para metadados (título, autor, thumbnail)
    }
  } catch (err) {}
  return null;
}

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

  const candidateIds = new Set();
  const strategyErrors = [];
  let resolvedUrl = "https://www.youtube.com/c/apexscorpio/live";

  // FASE 3: Descoberta 100% Dinâmica do Video ID (SEM NENHUM ID FIXO EM CÓDIGO)
  try {
    const liveResp = await axios.get(resolvedUrl, {
      headers: HTTP_HEADERS,
      maxRedirects: 5,
      timeout: 5000,
      validateStatus: () => true
    });

    if (liveResp.request?.res?.responseUrl) {
      resolvedUrl = liveResp.request.res.responseUrl;
    }

    const html = typeof liveResp.data === 'string' ? liveResp.data : '';

    const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})">/) ||
                           html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);

    if (canonicalMatch && canonicalMatch[1]) {
      candidateIds.add(canonicalMatch[1]);
    }

    if (resolvedUrl.includes('watch?v=')) {
      const match = resolvedUrl.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (match) candidateIds.add(match[1]);
    }
  } catch (err) {
    strategyErrors.push(`Live URL resolution error: ${err.message}`);
  }

  let selectedVideoId = null;
  let selectedTitle = "";
  let selectedIsLive = false;
  let selectedViewers = null;
  let selectedLiveSignal = null;
  let selectedViewerSource = null;
  let selectedRawViewerText = null;

  // FASE 4: Confirmação Estrita do Estado LIVE (sem falsos positivos de oEmbed ou isLiveContent isolado)
  for (const vId of candidateIds) {
    try {
      const playerResp = await fetchInnerTubePlayer(vId);
      const oembedData = await fetchOEmbedMetadata(vId);

      const vDetails = playerResp?.videoDetails || {};
      const microformat = playerResp?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};

      let isCandidateLive = false;
      let liveSignal = null;

      // Sinais fortes permitidos para confirmar uma live atualmente ativa:
      if (microformat.isLiveNow === true) {
        isCandidateLive = true;
        liveSignal = "microformat.liveBroadcastDetails.isLiveNow";
      } else if (vDetails.isLive === true && playerResp?.playabilityStatus?.status === 'OK') {
        isCandidateLive = true;
        liveSignal = "videoDetails.isLive";
      }

      // IMPORTANTE: oEmbed e isLiveContent NUNCA podem definir isLive = true por si só!

      if (isCandidateLive) {
        selectedVideoId = vId;
        selectedTitle = vDetails.title || oembedData?.title || "";
        selectedIsLive = true;
        selectedLiveSignal = liveSignal;

        // FASE 5: Obtenção de leitores simultâneos reais via InnerTube Next
        const nextResp = await fetchInnerTubeNext(vId);
        if (nextResp) {
          try {
            const contents = nextResp.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
            for (const item of contents) {
              const primary = item.videoPrimaryInfoRenderer;
              if (primary && primary.viewCount?.videoViewCountRenderer) {
                const vvcr = primary.viewCount.videoViewCountRenderer;
                if (vvcr.viewCount?.runs) {
                  const runsText = vvcr.viewCount.runs.map(r => r.text || '').join('');
                  if (/(?:a ver|watching|espectadores|viewers)/i.test(runsText)) {
                    selectedRawViewerText = runsText;
                    selectedViewerSource = "nextResponse.videoPrimaryInfoRenderer.runs";
                  }
                } else if (vvcr.viewCount?.simpleText) {
                  const simpleTxt = vvcr.viewCount.simpleText;
                  if (/(?:a ver|watching|espectadores|viewers)/i.test(simpleTxt)) {
                    selectedRawViewerText = simpleTxt;
                    selectedViewerSource = "nextResponse.videoPrimaryInfoRenderer.simpleText";
                  }
                }
              }
            }
          } catch(e) {
            strategyErrors.push(`InnerTube Next parsing error: ${e.message}`);
          }
        }
        break; // Candidato live validado com sucesso!
      }
    } catch(e) {
      strategyErrors.push(`Candidate ${vId} check error: ${e.message}`);
    }
  }

  // Processar texto real de espectadores
  if (selectedIsLive && selectedRawViewerText) {
    selectedViewers = parseViewersText(selectedRawViewerText);
  }

  // FASE 5 REGRA FINAL: Se a contagem estiver indisponível ou for nula, devolve null (NUNCA INVENTA 1 OU 0)
  const responseObj = {
    isLive: selectedIsLive,
    videoId: selectedIsLive ? selectedVideoId : null,
    viewers: selectedIsLive ? selectedViewers : null,
    title: selectedTitle,
    source: "youtube-innertube-scrape",
    updatedAt: new Date().toISOString(),
    error: null,
    diagnostic: {
      version: "4.1",
      discoveryMethod: candidateIds.size > 0 ? "dynamic-live-url-resolution" : "no-candidates-found",
      liveSignal: selectedLiveSignal || "none",
      viewerSource: selectedViewerSource || "none",
      resolvedUrl: resolvedUrl,
      checkedIds: Array.from(candidateIds),
      viewerText: selectedRawViewerText || null,
      cached: false,
      strategyErrors: strategyErrors
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
