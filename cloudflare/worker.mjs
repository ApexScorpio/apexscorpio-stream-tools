import { DurableObject } from "cloudflare:workers";
import statusImported from "../netlify/functions/handlers/youtube-status-handler.js";
import chatImported from "../netlify/functions/handlers/youtube-chat-handler.js";

const statusModule =
  statusImported?.default || statusImported;

const chatModule =
  chatImported?.default || chatImported;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store"
};

export class ApexState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (!key) {
      return Response.json(
        { error: "Chave ausente" },
        { status: 400 }
      );
    }

    if (
      request.method === "GET" &&
      url.pathname === "/read"
    ) {
      const value =
        await this.ctx.storage.get(key);

      return Response.json({
        value:
          value === undefined
            ? null
            : value
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/write"
    ) {
      const body = await request.json();

      await this.ctx.storage.put(
        key,
        body.value
      );

      return Response.json({
        saved: true
      });
    }

    return Response.json(
      { error: "Método não permitido" },
      { status: 405 }
    );
  }
}

function getStateStub(env) {
  const id =
    env.APEX_STATE.idFromName("global");

  return env.APEX_STATE.get(id);
}

async function stateRead(env, key) {
  const stub = getStateStub(env);

  const response = await stub.fetch(
    "https://state/read?key=" +
      encodeURIComponent(key)
  );

  const data = await response.json();

  return data.value ?? null;
}

async function stateWrite(env, key, value) {
  const stub = getStateStub(env);

  const response = await stub.fetch(
    "https://state/write?key=" +
      encodeURIComponent(key),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ value })
    }
  );

  if (!response.ok) {
    throw new Error(
      "Falha ao guardar estado persistente"
    );
  }
}

function buildUrl(input, params) {
  const url = new URL(input);

  if (
    params &&
    typeof params === "object"
  ) {
    for (
      const [key, value]
      of Object.entries(params)
    ) {
      if (
        value !== undefined &&
        value !== null
      ) {
        url.searchParams.set(
          key,
          String(value)
        );
      }
    }
  }

  return url;
}

async function readResponseData(
  response,
  responseType
) {
  if (responseType === "text") {
    return response.text();
  }

  const contentType =
    response.headers.get("content-type") ||
    "";

  if (
    contentType.includes(
      "application/json"
    )
  ) {
    return response.json().catch(
      () => ({})
    );
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

async function httpRequest(
  method,
  input,
  data,
  config = {}
) {
  const url = buildUrl(
    input,
    config.params
  );

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(
      1000,
      Number(config.timeout || 15000)
    )
  );

  const headers =
    new Headers(config.headers || {});

  let body;

  if (
    method !== "GET" &&
    method !== "HEAD"
  ) {
    if (data instanceof URLSearchParams) {
      body = data.toString();
    } else if (typeof data === "string") {
      body = data;
    } else if (
      data !== undefined &&
      data !== null
    ) {
      body = JSON.stringify(data);

      if (!headers.has("Content-Type")) {
        headers.set(
          "Content-Type",
          "application/json"
        );
      }
    }
  }

  try {
    const response = await fetch(
      url,
      {
        method,
        headers,
        body,
        redirect: "follow",
        signal: controller.signal
      }
    );

    const responseData =
      await readResponseData(
        response,
        config.responseType
      );

    const result = {
      data: responseData,
      status: response.status,
      headers: Object.fromEntries(
        response.headers.entries()
      ),
      request: {
        res: {
          responseUrl: response.url
        }
      }
    };

    const accepted =
      typeof config.validateStatus ===
      "function"
        ? config.validateStatus(
            response.status
          )
        : response.ok;

    if (!accepted) {
      const error = new Error(
        "Request failed with status " +
          response.status
      );

      error.response = result;
      throw error;
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

const httpClient = {
  get(url, config) {
    return httpRequest(
      "GET",
      url,
      null,
      config
    );
  },

  post(url, data, config) {
    return httpRequest(
      "POST",
      url,
      data,
      config
    );
  }
};

function installRuntime() {
  statusModule.setRuntimeAxios(httpClient);
  chatModule.setRuntimeAxios(httpClient);
}

async function requestToEvent(request) {
  const url = new URL(request.url);

  let body = null;

  if (
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    body = await request.text();
  }

  return {
    httpMethod: request.method,
    path: url.pathname,
    headers: Object.fromEntries(
      request.headers.entries()
    ),
    queryStringParameters:
      Object.fromEntries(
        url.searchParams.entries()
      ),
    body
  };
}

function lambdaToResponse(result) {
  return new Response(
    result?.body || "",
    {
      status:
        Number(result?.statusCode || 200),
      headers:
        new Headers(result?.headers || {})
    }
  );
}

function jsonResponse(
  value,
  status = 200
) {
  return new Response(
    JSON.stringify(value),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}

async function handleOverlayConfig(
  request,
  env
) {
  const url = new URL(request.url);

  const overlay = String(
    url.searchParams.get("overlay") || ""
  );

  if (
    !/^[a-z0-9_-]{1,40}$/i.test(
      overlay
    )
  ) {
    return jsonResponse(
      { error: "Overlay inválido" },
      400
    );
  }

  const key =
    "overlay-config:" + overlay;

  if (request.method === "GET") {
    return jsonResponse({
      overlay,
      config:
        await stateRead(env, key)
    });
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { error: "Método não permitido" },
      405
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse(
      { error: "JSON inválido" },
      400
    );
  }

  const received =
    body?.config || body;

  if (
    !received ||
    typeof received !== "object" ||
    Array.isArray(received)
  ) {
    return jsonResponse(
      { error: "Configuração inválida" },
      400
    );
  }

  if (
    JSON.stringify(received).length >
    8192
  ) {
    return jsonResponse(
      {
        error:
          "Configuração demasiado grande"
      },
      413
    );
  }

  const config = {
    ...received,
    _updatedAt:
      Number(received._updatedAt) ||
      Date.now()
  };

  await stateWrite(
    env,
    key,
    config
  );

  return jsonResponse({
    saved: true,
    overlay,
    config
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      installRuntime();

      if (url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          platform: "cloudflare-workers",
          version: "1.0.0",
          timestamp:
            new Date().toISOString()
        });
      }

      if (
        url.pathname ===
        "/youtube-status"
      ) {
        return lambdaToResponse(
          await statusModule.handler(
            await requestToEvent(request),
            {}
          )
        );
      }

      if (
        url.pathname ===
        "/youtube-chat"
      ) {
        return lambdaToResponse(
          await chatModule.handler(
            await requestToEvent(request),
            {}
          )
        );
      }

      if (
        url.pathname ===
        "/overlay-config"
      ) {
        return handleOverlayConfig(
          request,
          env
        );
      }

      const assetResponse =
        await env.ASSETS.fetch(request);

      if (
        assetResponse.status !== 404 ||
        !["GET", "HEAD"].includes(
          request.method
        )
      ) {
        return assetResponse;
      }

      const fallbackUrl =
        new URL(request.url);

      fallbackUrl.protocol = "https:";
      fallbackUrl.hostname =
        "apexscorpio.github.io";
      fallbackUrl.pathname =
        "/apexscorpio-stream-tools" +
        url.pathname;

      return fetch(
        fallbackUrl,
        {
          method: request.method,
          headers: {
            "User-Agent":
              "ApexScorpio-Cloudflare-Asset-Fallback"
          },
          redirect: "follow"
        }
      );
    } catch (error) {
      return jsonResponse(
        {
          error:
            "Erro interno do Worker",
          detail:
            String(
              error?.message || error
            ).slice(0, 400)
        },
        500
      );
    }
  }
};