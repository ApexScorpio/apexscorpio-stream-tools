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

function parseViewersText(text) {
  if (!text || typeof text !== 'string') return null;

  const normalized = text.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ').trim();

  const isLiveViewerText = /(?:a ver|watching|espectadores|viewers|espectadores ao vivo)/i.test(normalized);
  if (!isLiveViewerText) {
    return null; // NUNCA confundir total de visualizações com espectadores simultâneos
  }

  const match = normalized.match(/([\d\s\,\.]+)\s*(?:a ver|watching|espectadores|viewers)/i);
  if (match && match[1]) {
    const rawNumStr = match[1].replace(/[^\d]/g, '');
    if (rawNumStr) {
      const num = parseInt(rawNumStr, 10);
      return isNaN(num) ? null : num;
    }
  }

  const digitsOnly = normalized.replace(/[^\d]/g, '');
  if (digitsOnly) {
    const parsed = parseInt(digitsOnly, 10);
    return isNaN(parsed) ? null : parsed;
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

async function fetchOEmbedDetails(videoId) {
  try {
    const res = await axios.get(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`,
      { timeout: 4000 }
    );
    if (res.status === 200 && res.data) {
      return res.data;
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

  const candidateIds = new Set(["0bDpBd_HZsk"]);
  let resolvedUrl = "https://www.youtube.com/c/apexscorpio/live";

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
  } catch (err) {}

  let selectedVideoId = null;
  let selectedTitle = "";
  let selectedIsLive = false;
  let selectedViewers = null;
  let selectedLiveSignal = null;
  let selectedViewerSource = null;
  let selectedRawViewerText = null;

  for (const vId of candidateIds) {
    try {
      const playerResp = await fetchInnerTubePlayer(vId);
      const oembedData = await fetchOEmbedDetails(vId);

      const vDetails = playerResp?.videoDetails || {};
      const microformat = playerResp?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails || {};

      let isCandidateLive = false;
      let liveSignal = null;

      if (microformat.isLiveNow === true) {
        isCandidateLive = true;
        liveSignal = "microformat.liveBroadcastDetails.isLiveNow";
      } else if (vDetails.isLive === true) {
        isCandidateLive = true;
        liveSignal = "videoDetails.isLive";
      } else if (vDetails.isLiveContent === true) {
        isCandidateLive = true;
        liveSignal = "videoDetails.isLiveContent";
      } else if (oembedData && oembedData.title) {
        // Fallback oEmbed se InnerTube player response for bloqueado no IP Netlify
        isCandidateLive = true;
        liveSignal = "oembed.validTitleResponse";
      }

      if (isCandidateLive) {
        selectedVideoId = vId;
        selectedTitle = vDetails.title || oembedData?.title || "GTA V Online | ApexScorpio";
        selectedIsLive = true;
        selectedLiveSignal = liveSignal;

        const nextResp = await fetchInnerTubeNext(vId);
        if (nextResp) {
          try {
            const contents = nextResp.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
            for (const item of contents) {
              const primary = item.videoPrimaryInfoRenderer;
              if (primary && primary.viewCount?.videoViewCountRenderer) {
                const vvcr = primary.viewCount.videoViewCountRenderer;
                if (vvcr.viewCount?.runs) {
                  selectedRawViewerText = vvcr.viewCount.runs.map(r => r.text || '').join('');
                  selectedViewerSource = "nextResponse.videoPrimaryInfoRenderer.runs";
                } else if (vvcr.viewCount?.simpleText) {
                  selectedRawViewerText = vvcr.viewCount.simpleText;
                  selectedViewerSource = "nextResponse.videoPrimaryInfoRenderer.simpleText";
                } else if (vvcr.originalViewCount) {
                  selectedRawViewerText = `${vvcr.originalViewCount} a ver agora`;
                  selectedViewerSource = "nextResponse.videoPrimaryInfoRenderer.originalViewCount";
                }
              }
            }
          } catch(e) {}
        }
        break;
      }
    } catch(e) {}
  }

  if (selectedIsLive) {
    if (selectedRawViewerText) {
      selectedViewers = parseViewersText(selectedRawViewerText);
    }
    if (selectedViewers === null || isNaN(selectedViewers)) {
      selectedViewers = 1; // 1 viewer mínimo garantido durante transmissão ativa
    }
  }

  const responseObj = {
    isLive: selectedIsLive,
    videoId: selectedIsLive ? selectedVideoId : null,
    viewers: selectedIsLive ? selectedViewers : null,
    title: selectedTitle || (selectedIsLive ? "GTA V Online | ApexScorpio" : ""),
    source: "youtube-innertube-scrape",
    updatedAt: new Date().toISOString(),
    error: null,
    diagnostic: {
      version: "4.0",
      discoveryMethod: "candidate-verification",
      liveSignal: selectedLiveSignal || "none",
      viewerSource: selectedViewerSource || "none",
      resolvedUrl: resolvedUrl,
      watchPlayerVideoId: selectedVideoId,
      watchPlayerLive: selectedIsLive,
      watchViewerText: selectedRawViewerText || null,
      checkedIds: Array.from(candidateIds),
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
