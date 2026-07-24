(function () {
  'use strict';

  const YOUTUBE_BACKEND_BASE = String(
    window.APEX_YOUTUBE_BACKEND_URL ||
    window.location.origin
  ).replace(/\/+$/, '');

  const root =
    document.getElementById('youtube-stats');

  const elements = {
    live:
      document.getElementById('metric-live'),
    views:
      document.getElementById('metric-views'),
    likes:
      document.getElementById('metric-likes'),
    subs:
      document.getElementById('metric-subs'),
    channelviews:
      document.getElementById('metric-channelviews'),
    videos:
      document.getElementById('metric-videos'),
    dot:
      document.getElementById('live-dot')
  };

  const params =
    new URLSearchParams(location.search);

  const layout =
    params.get('layout') === 'vertical'
      ? 'vertical'
      : 'horizontal';

  const show = new Set(
    String(
      params.get('show') ||
      'live,views,likes,subs,channelviews,videos'
    )
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );

  const showBackground =
    !params.has('bg') ||
    /^(1|true)$/i.test(params.get('bg'));

  const fontSize =
    Math.max(
      10,
      Math.min(
        50,
        Number(params.get('fs') || 16)
      )
    );

  root.classList.remove(
    'horizontal',
    'vertical',
    'has-bg'
  );

  root.classList.add(layout);

  if (showBackground) {
    root.classList.add('has-bg');
  }

  document
    .querySelectorAll('[data-metric]')
    .forEach(element => {
      element.style.display =
        show.has(element.dataset.metric)
          ? 'flex'
          : 'none';
    });

  document
    .querySelectorAll('.metric-value')
    .forEach(element => {
      element.style.fontSize =
        fontSize + 'px';
    });

  function format(value) {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      return '—';
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      return '—';
    }

    return Math.max(
      0,
      Math.floor(parsed)
    ).toLocaleString('pt-PT');
  }

  function render(data) {
    const metrics = data?.metrics || {};
    const isLive = data?.isLive === true;

    elements.dot.classList.toggle(
      'online',
      isLive
    );

    elements.live.textContent =
      isLive
        ? format(metrics.concurrentViewers)
        : '0';

    elements.views.textContent =
      isLive
        ? format(metrics.liveViews)
        : '—';

    elements.likes.textContent =
      isLive
        ? format(metrics.likes)
        : '—';

    elements.subs.textContent =
      format(metrics.subscribers);

    elements.channelviews.textContent =
      format(metrics.channelViews);

    elements.videos.textContent =
      format(metrics.channelVideos);
  }

  async function refresh() {
    try {
      const response = await fetch(
        YOUTUBE_BACKEND_BASE + '/youtube-status?cb=' + Date.now(),
        {
          cache: 'no-store',
          headers: {
            Accept: 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error(
          'YouTube status ' + response.status
        );
      }

      render(await response.json());
    } catch (_) {
      elements.dot.classList.remove('online');
    }
  }

  refresh();
  setInterval(refresh, 15000);
})();
