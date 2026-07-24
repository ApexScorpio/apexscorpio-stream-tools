(function (global) {
  'use strict';

  const ENDPOINT =
    global.location.origin + '/overlay-config';

  const activePollers = new Map();

  function validOverlayName(value) {
    return /^[a-z0-9_-]{1,40}$/i.test(
      String(value || '')
    );
  }

  async function save(overlayName, config) {
    if (
      !validOverlayName(overlayName) ||
      !config ||
      typeof config !== 'object'
    ) {
      return false;
    }

    try {
      const response = await fetch(
        ENDPOINT +
          '?overlay=' +
          encodeURIComponent(overlayName),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ config }),
          cache: 'no-store',
          keepalive: true
        }
      );

      return response.ok;
    } catch (_) {
      return false;
    }
  }

  function deliver(overlayName, config) {
    global.postMessage(
      {
        type: 'config_update',
        data: {
          [overlayName]: config
        }
      },
      '*'
    );
  }

  function start(overlayName, intervalMs) {
    if (
      !validOverlayName(overlayName) ||
      activePollers.has(overlayName)
    ) {
      return;
    }

    let lastUpdatedAt = 0;

    async function poll() {
      try {
        const response = await fetch(
          ENDPOINT +
            '?overlay=' +
            encodeURIComponent(overlayName) +
            '&cb=' +
            Date.now(),
          {
            cache: 'no-store'
          }
        );

        if (!response.ok) {
          return;
        }

        const data = await response.json();
        const config = data && data.config;

        if (
          !config ||
          typeof config !== 'object'
        ) {
          return;
        }

        const updatedAt =
          Number(config._updatedAt || 0);

        if (
          updatedAt > 0 &&
          updatedAt < lastUpdatedAt
        ) {
          return;
        }

        if (updatedAt > 0) {
          lastUpdatedAt = updatedAt;
        }

        deliver(overlayName, config);
      } catch (_) {}
    }

    poll();

    const timer = global.setInterval(
      poll,
      Math.max(
        1000,
        Number(intervalMs || 2000)
      )
    );

    activePollers.set(overlayName, timer);
  }

  function inferOverlayName() {
    const fileName = String(
      global.location.pathname
        .split('/')
        .pop() || ''
    )
      .replace(/\.html$/i, '')
      .toLowerCase();

    return [
      'viewers',
      'chat',
      'events',
      'alerts'
    ].includes(fileName)
      ? fileName
      : null;
  }

  global.ApexOverlayRelay = {
    save,
    start
  };

  const inferredOverlay = inferOverlayName();

  if (inferredOverlay) {
    start(inferredOverlay, 2000);
  }
})(window);