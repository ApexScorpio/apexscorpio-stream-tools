(function (global) {
  'use strict';

  const BACKEND_BASE_URL = String(
    global.APEX_BACKEND_URL ||
    global.APEX_YOUTUBE_BACKEND_URL ||
    'https://apexscorpio-stream-tools.scorpioapex.workers.dev'
  ).replace(/\/+$/, '');

  const session=global.ApexOverlaySession;
  if(!session)return;
  const ENDPOINT = BACKEND_BASE_URL + '/overlay-config';
  const namespace=global.crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.key)).then(hash=>Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('').slice(0,32));
  async function privateOverlayName(name){return (await namespace)+'-'+name;}

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
          encodeURIComponent(await privateOverlayName(overlayName)),
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

  async function load(overlayName) {
    if (!validOverlayName(overlayName)) {
      return null;
    }

    try {
      const response = await fetch(
        ENDPOINT +
          '?overlay=' +
          encodeURIComponent(await privateOverlayName(overlayName)) +
          '&cb=' +
          Date.now(),
        {
          cache: 'no-store'
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      return (
        data &&
        data.config &&
        typeof data.config === 'object'
      )
        ? data.config
        : null;
    } catch (_) {
      return null;
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
            encodeURIComponent(await privateOverlayName(overlayName)) +
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
    load,
    start
  };

  const inferredOverlay = inferOverlayName();

  if (inferredOverlay) {
    start(inferredOverlay, 2000);
  }
})(window);