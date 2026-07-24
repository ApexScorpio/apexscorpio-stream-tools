const crypto = require('crypto');

const PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_LENGTH = 16384;

const PAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language':
    'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Cookie:
    'SOCS=CAESEwgDEgk1ODE3OTM1MjEaAmVuIAEaBgiA_L2bBg'
};

const pageCache = new Map();

function resetPublicChatCache() {
  pageCache.clear();
}

function validVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(value || ''));
}

function validContinuation(value) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return true;
  }

  const text = String(value);

  return (
    text.length <= MAX_TOKEN_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(text)
  );
}

function clampPolling(value) {
  const parsed = Number(value || 5000);

  if (!Number.isFinite(parsed)) {
    return 5000;
  }

  return Math.max(
    1000,
    Math.min(15000, Math.floor(parsed))
  );
}

function textFromRuns(value) {
  if (!value) return '';

  if (typeof value.simpleText === 'string') {
    return value.simpleText;
  }

  if (!Array.isArray(value.runs)) {
    return '';
  }

  return value.runs.map(run => {
    if (typeof run?.text === 'string') {
      return run.text;
    }

    const emoji = run?.emoji;

    if (!emoji) return '';

    if (
      Array.isArray(emoji.shortcuts) &&
      emoji.shortcuts[0]
    ) {
      return emoji.shortcuts[0];
    }

    return emoji.emojiId || '';
  }).join('');
}

function extractBalancedObject(text, markerIndex) {
  const start = text.indexOf('{', markerIndex);

  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        inString = false;
        quote = '';
      }

      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        const raw = text.slice(start, index + 1);

        try {
          return JSON.parse(raw);
        } catch (_) {
          return null;
        }
      }
    }
  }

  return null;
}

function parseYtConfig(html) {
  const merged = {};
  let cursor = 0;

  while (cursor < html.length) {
    const marker = html.indexOf('ytcfg.set(', cursor);

    if (marker < 0) break;

    const parsed = extractBalancedObject(
      html,
      marker + 'ytcfg.set('.length
    );

    if (parsed && typeof parsed === 'object') {
      Object.assign(merged, parsed);
    }

    cursor = marker + 10;
  }

  return merged;
}

function parseInitialData(html) {
  const markers = [
    'var ytInitialData =',
    'window["ytInitialData"] =',
    "window['ytInitialData'] =",
    'ytInitialData ='
  ];

  for (const marker of markers) {
    const position = html.indexOf(marker);

    if (position < 0) continue;

    const parsed = extractBalancedObject(
      html,
      position + marker.length
    );

    if (parsed) return parsed;
  }

  return null;
}

function continuationFromList(list) {
  if (!Array.isArray(list)) return null;

  for (const item of list) {
    const candidates = [
      item?.invalidationContinuationData,
      item?.timedContinuationData,
      item?.reloadContinuationData,
      item?.liveChatReplayContinuationData,
      item?.playerSeekContinuationData
    ];

    for (const current of candidates) {
      const token = current?.continuation;

      if (token && validContinuation(token)) {
        return {
          token,
          timeoutMs:
            Number(current.timeoutMs || 5000)
        };
      }
    }
  }

  return null;
}

function findContinuation(node, depth = 0) {
  if (
    !node ||
    typeof node !== 'object' ||
    depth > 14
  ) {
    return null;
  }

  if (Array.isArray(node.continuations)) {
    const direct = continuationFromList(
      node.continuations
    );

    if (direct) return direct;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findContinuation(
        item,
        depth + 1
      );

      if (found) return found;
    }

    return null;
  }

  for (const value of Object.values(node)) {
    const found = findContinuation(
      value,
      depth + 1
    );

    if (found) return found;
  }

  return null;
}

function rendererId(renderer, prefix) {
  if (renderer?.id) {
    return String(renderer.id);
  }

  const source = JSON.stringify(renderer || {});

  return (
    prefix +
    '-' +
    crypto
      .createHash('sha256')
      .update(source)
      .digest('hex')
      .slice(0, 24)
  );
}

function publishedAt(renderer) {
  const usec = Number(renderer?.timestampUsec || 0);

  if (Number.isFinite(usec) && usec > 0) {
    return new Date(
      Math.floor(usec / 1000)
    ).toISOString();
  }

  return new Date().toISOString();
}

function authorDetails(renderer) {
  const badges = Array.isArray(renderer?.authorBadges)
    ? renderer.authorBadges
    : [];

  let owner = false;
  let moderator = false;
  let sponsor = false;

  for (const badge of badges) {
    const metadata =
      badge?.liveChatAuthorBadgeRenderer || {};

    const iconType =
      metadata?.icon?.iconType || '';

    if (
      iconType === 'OWNER' ||
      iconType === 'VERIFIED'
    ) {
      owner = owner || iconType === 'OWNER';
    }

    if (iconType === 'MODERATOR') {
      moderator = true;
    }

    if (
      metadata.customThumbnail ||
      /member|membro|sponsor/i.test(
        textFromRuns(metadata.tooltip)
      )
    ) {
      sponsor = true;
    }
  }

  const thumbnails =
    renderer?.authorPhoto?.thumbnails || [];

  return {
    displayName:
      textFromRuns(renderer?.authorName) ||
      'Viewer YouTube',
    profileImageUrl:
      thumbnails[thumbnails.length - 1]?.url ||
      thumbnails[0]?.url ||
      '',
    isChatOwner: owner,
    isChatModerator: moderator,
    isChatSponsor: sponsor
  };
}

function baseItem(renderer, prefix) {
  return {
    id: rendererId(renderer, prefix),
    authorDetails: authorDetails(renderer)
  };
}

function textMessageItem(renderer) {
  const message =
    textFromRuns(renderer?.message);

  if (!message) return null;

  return {
    ...baseItem(renderer, 'yt-public-text'),
    snippet: {
      type: 'textMessageEvent',
      displayMessage: message,
      textMessageDetails: {
        messageText: message
      },
      publishedAt: publishedAt(renderer)
    }
  };
}

function paidMessageItem(renderer) {
  const amount =
    textFromRuns(renderer?.purchaseAmountText);

  const message =
    textFromRuns(renderer?.message);

  return {
    ...baseItem(renderer, 'yt-public-paid'),
    snippet: {
      type: 'superChatEvent',
      displayMessage:
        [amount, message]
          .filter(Boolean)
          .join(' · '),
      superChatDetails: {
        amountDisplayString: amount,
        userComment: message
      },
      publishedAt: publishedAt(renderer)
    }
  };
}

function paidStickerItem(renderer) {
  const amount =
    textFromRuns(renderer?.purchaseAmountText);

  const altText =
    renderer?.sticker?.accessibility
      ?.accessibilityData?.label ||
    'Super Sticker';

  return {
    ...baseItem(renderer, 'yt-public-sticker'),
    snippet: {
      type: 'superStickerEvent',
      displayMessage:
        [amount, altText]
          .filter(Boolean)
          .join(' · '),
      superStickerDetails: {
        amountDisplayString: amount,
        superStickerMetadata: {
          altText
        }
      },
      publishedAt: publishedAt(renderer)
    }
  };
}

function membershipItem(renderer) {
  const header =
    textFromRuns(renderer?.headerPrimaryText) ||
    textFromRuns(renderer?.headerSubtext);

  const message =
    textFromRuns(renderer?.message);

  const displayMessage =
    [header, message]
      .filter(Boolean)
      .join(' · ') ||
    'Novo membro';

  return {
    ...baseItem(renderer, 'yt-public-member'),
    snippet: {
      type: message
        ? 'memberMilestoneChatEvent'
        : 'newSponsorEvent',
      displayMessage,
      memberMilestoneChatDetails: {
        memberMonth: 0,
        userComment: message
      },
      newSponsorDetails: {
        memberLevelName: header
      },
      publishedAt: publishedAt(renderer)
    }
  };
}

function giftingPurchaseItem(renderer) {
  const text = [
    textFromRuns(renderer?.header),
    textFromRuns(renderer?.subtext)
  ].filter(Boolean).join(' · ');

  const countMatch =
    text.match(/\b(\d+)\b/);

  return {
    ...baseItem(renderer, 'yt-public-gift-buy'),
    snippet: {
      type: 'membershipGiftingEvent',
      displayMessage:
        text || 'Ofereceu memberships',
      membershipGiftingDetails: {
        giftMembershipsCount:
          Number(countMatch?.[1] || 0)
      },
      publishedAt: publishedAt(renderer)
    }
  };
}

function giftingReceivedItem(renderer) {
  const text = [
    textFromRuns(renderer?.header),
    textFromRuns(renderer?.subtext)
  ].filter(Boolean).join(' · ');

  return {
    ...baseItem(renderer, 'yt-public-gift-receive'),
    snippet: {
      type: 'giftMembershipReceivedEvent',
      displayMessage:
        text || 'Recebeu uma membership',
      giftMembershipReceivedDetails: {
        memberLevelName:
          textFromRuns(renderer?.subtext)
      },
      publishedAt: publishedAt(renderer)
    }
  };
}

function itemFromContainer(container) {
  if (!container || typeof container !== 'object') {
    return null;
  }

  if (container.liveChatTextMessageRenderer) {
    return textMessageItem(
      container.liveChatTextMessageRenderer
    );
  }

  if (container.liveChatPaidMessageRenderer) {
    return paidMessageItem(
      container.liveChatPaidMessageRenderer
    );
  }

  if (container.liveChatPaidStickerRenderer) {
    return paidStickerItem(
      container.liveChatPaidStickerRenderer
    );
  }

  if (container.liveChatMembershipItemRenderer) {
    return membershipItem(
      container.liveChatMembershipItemRenderer
    );
  }

  if (
    container
      .liveChatSponsorshipsGiftPurchaseAnnouncementRenderer
  ) {
    return giftingPurchaseItem(
      container
        .liveChatSponsorshipsGiftPurchaseAnnouncementRenderer
    );
  }

  if (
    container
      .liveChatSponsorshipsGiftRedemptionAnnouncementRenderer
  ) {
    return giftingReceivedItem(
      container
        .liveChatSponsorshipsGiftRedemptionAnnouncementRenderer
    );
  }

  return null;
}

function actionItem(action) {
  const containers = [
    action?.addChatItemAction?.item,
    action?.replaceChatItemAction?.replacementItem,
    action?.addLiveChatTickerItemAction?.item
  ];

  for (const container of containers) {
    const item = itemFromContainer(container);

    if (item) return item;
  }

  return null;
}

function actionsFromResponse(data) {
  const direct =
    data?.continuationContents
      ?.liveChatContinuation
      ?.actions;

  if (Array.isArray(direct)) {
    return direct;
  }

  const endpoints =
    data?.onResponseReceivedEndpoints;

  if (!Array.isArray(endpoints)) {
    return [];
  }

  const actions = [];

  for (const endpoint of endpoints) {
    const continuationItems =
      endpoint?.appendContinuationItemsAction
        ?.continuationItems;

    if (Array.isArray(continuationItems)) {
      actions.push(...continuationItems);
    }
  }

  return actions;
}

function itemsFromResponse(data) {
  const result = [];
  const seen = new Set();

  for (const action of actionsFromResponse(data)) {
    const item = actionItem(action);

    if (!item || seen.has(item.id)) {
      continue;
    }

    seen.add(item.id);
    result.push(item);
  }

  return result;
}

function finalResponseUrl(response) {
  return (
    response?.request?.res?.responseUrl ||
    response?.request?._redirectable?._currentUrl ||
    response?.config?.url ||
    ''
  );
}

async function discoverVideoId(
  http,
  channelId
) {
  if (!channelId) return null;

  const response = await http.get(
    `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`,
    {
      headers: PAGE_HEADERS,
      timeout: 8000,
      maxRedirects: 5,
      responseType: 'text'
    }
  );

  const finalUrl = finalResponseUrl(response);

  try {
    const parsed = new URL(finalUrl);
    const candidate = parsed.searchParams.get('v');

    if (validVideoId(candidate)) {
      return candidate;
    }
  } catch (_) {}

  const html = String(response?.data || '');

  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*[?&]v=([A-Za-z0-9_-]{11})/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["'][^"']*[?&]v=([A-Za-z0-9_-]{11})/i,
    /"videoId":"([A-Za-z0-9_-]{11})"/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (validVideoId(match?.[1])) {
      return match[1];
    }
  }

  return null;
}

async function readPageConfig(
  http,
  videoId,
  force = false
) {
  const cached = pageCache.get(videoId);

  if (
    !force &&
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return cached;
  }

  const pageUrl =
    'https://www.youtube.com/live_chat' +
    `?is_popout=1&v=${encodeURIComponent(videoId)}` +
    '&hl=pt-PT';

  const response = await http.get(
    pageUrl,
    {
      headers: PAGE_HEADERS,
      timeout: 10000,
      responseType: 'text'
    }
  );

  const html = String(response?.data || '');

  const config = parseYtConfig(html);
  const initialData = parseInitialData(html);
  const initialContinuation =
    findContinuation(initialData);

  const apiKey =
    config.INNERTUBE_API_KEY || null;

  const clientVersion =
    config.INNERTUBE_CLIENT_VERSION || null;

  const clientNameId =
    Number(
      config.INNERTUBE_CONTEXT_CLIENT_NAME ||
      1
    );

  const visitorData =
    config.VISITOR_DATA ||
    config.INNERTUBE_CONTEXT
      ?.client?.visitorData ||
    null;

  if (
    !apiKey ||
    !clientVersion ||
    !initialContinuation?.token
  ) {
    const error = new Error(
      'Não foi possível obter a continuação pública do chat'
    );

    error.code = 'PUBLIC_CHAT_BOOTSTRAP_FAILED';
    throw error;
  }

  const result = {
    videoId,
    apiKey,
    clientVersion,
    clientNameId,
    visitorData,
    initialContinuation:
      initialContinuation.token,
    initialTimeoutMs:
      initialContinuation.timeoutMs,
    expiresAt:
      Date.now() + PAGE_CACHE_TTL_MS
  };

  pageCache.set(videoId, result);

  return result;
}

async function requestContinuation(
  http,
  page,
  continuation
) {
  const url =
    'https://www.youtube.com/youtubei/v1/' +
    'live_chat/get_live_chat' +
    `?key=${encodeURIComponent(page.apiKey)}` +
    '&prettyPrint=false';

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.youtube.com',
    Referer:
      'https://www.youtube.com/live_chat' +
      `?is_popout=1&v=${encodeURIComponent(page.videoId)}`,
    'User-Agent': PAGE_HEADERS['User-Agent'],
    'Accept-Language':
      PAGE_HEADERS['Accept-Language'],
    'X-YouTube-Client-Name':
      String(page.clientNameId || 1),
    'X-YouTube-Client-Version':
      page.clientVersion
  };

  if (page.visitorData) {
    headers['X-Goog-Visitor-Id'] =
      page.visitorData;
  }

  const response = await http.post(
    url,
    {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion:
            page.clientVersion,
          hl: 'pt-PT',
          gl: 'PT',
          visitorData:
            page.visitorData || undefined
        }
      },
      continuation
    },
    {
      headers,
      timeout: 12000
    }
  );

  return response?.data || {};
}

async function fetchPublicLiveChat({
  http,
  videoId = null,
  pageToken = null,
  channelId = null
}) {
  if (
    !http ||
    typeof http.get !== 'function' ||
    typeof http.post !== 'function'
  ) {
    throw new Error(
      'Cliente HTTP público inválido'
    );
  }

  if (!validContinuation(pageToken)) {
    const error = new Error(
      'Continuação pública inválida'
    );

    error.code = 'INVALID_PUBLIC_CONTINUATION';
    throw error;
  }

  let resolvedVideoId =
    validVideoId(videoId)
      ? videoId
      : null;

  if (!resolvedVideoId) {
    resolvedVideoId =
      await discoverVideoId(
        http,
        channelId
      );
  }

  if (!validVideoId(resolvedVideoId)) {
    return {
      active: false,
      videoId: null,
      liveChatId: null,
      chatAvailable: false,
      items: [],
      nextPageToken: null,
      pollingIntervalMillis: 5000,
      source: 'public-live-chat',
      oauthFallback: true
    };
  }

  let page = await readPageConfig(
    http,
    resolvedVideoId
  );

  let continuation =
    pageToken ||
    page.initialContinuation;

  let data;

  try {
    data = await requestContinuation(
      http,
      page,
      continuation
    );
  } catch (error) {
    if (!pageToken) throw error;

    page = await readPageConfig(
      http,
      resolvedVideoId,
      true
    );

    continuation =
      page.initialContinuation;

    data = await requestContinuation(
      http,
      page,
      continuation
    );
  }

  const nextContinuation =
    findContinuation(data);

  const items =
    itemsFromResponse(data);

  const nextPageToken =
    nextContinuation?.token ||
    continuation;

  return {
    active: true,
    videoId: resolvedVideoId,
    liveChatId:
      `public:${resolvedVideoId}`,
    chatAvailable: true,
    items,
    nextPageToken,
    pollingIntervalMillis:
      clampPolling(
        nextContinuation?.timeoutMs ||
        page.initialTimeoutMs ||
        5000
      ),
    source: 'public-live-chat',
    oauthFallback: true
  };
}

module.exports = {
  fetchPublicLiveChat,
  resetPublicChatCache,
  validContinuation,
  validVideoId,
  textFromRuns,
  parseYtConfig,
  parseInitialData,
  findContinuation,
  itemsFromResponse
};