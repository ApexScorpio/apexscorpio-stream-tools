const axios = require('axios');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

/**
 * Helper para obter Store Netlify Blobs com Fallback em memória para ambiente de testes
 */
function getBlobsStore(name) {
  try {
    return getStore(name);
  } catch (err) {
    return {
      get: async () => null,
      getJSON: async () => null,
      setJSON: async () => {}
    };
  }
}

/**
 * Função utilitária para comparação segura no tempo (Timing-Safe)
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Cifrar Refresh Token usando AES-256-GCM
 */
function encryptRefreshToken(token, secretKeyStr) {
  const key = crypto.createHash('sha256').update(secretKeyStr).digest(); // Chave de 32 bytes
  const iv = crypto.randomBytes(12); // IV de 12 bytes para AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    version: '1.0',
    iv: iv.toString('hex'),
    authTag: authTag,
    ciphertext: encrypted,
    createdAt: new Date().toISOString(),
    scope: 'https://www.googleapis.com/auth/youtube.readonly'
  };
}

/**
 * Extrair Cookie da Request Header
 */
function parseCookieHeader(cookieHeader, name) {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const [k, v] = c.trim().split('=');
    if (k === name) return v;
  }
  return null;
}

exports.handler = async function(event, context) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline';"
  };

  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  const error = event.queryStringParameters?.error;

  const cookieHeader = event.headers?.cookie || event.headers?.Cookie;
  const sessionId = parseCookieHeader(cookieHeader, 'oauth_session');

  // 1. Tratar erro de autorização ou ausência de parâmetros
  if (error || !code || !state || !sessionId) {
    return {
      statusCode: 400,
      headers,
      body: `
        <!DOCTYPE html>
        <html lang="pt">
        <head><meta charset="UTF-8"><title>Autorização Falhou</title>
        <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;} .card{background:#1e293b;padding:2rem;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);max-width:450px;text-align:center;border:1px solid #334155;} h2{color:#f43f5e;margin-top:0;} p{color:#94a3b8;}</style>
        </head>
        <body>
          <div class="card">
            <h2>Autorização Falhou ou Expirou</h2>
            <p>O pedido de autorização OAuth não pôde ser concluído por parâmetros inválidos ou sessão expirada.</p>
            <p>Pode fechar esta janela.</p>
          </div>
        </body>
        </html>
      `
    };
  }

  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI || 'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback';
  const encryptionKey = process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY;

  if (!clientId || !clientSecret || !encryptionKey) {
    return {
      statusCode: 500,
      headers,
      body: `<h2>Configuração do Servidor Incompleta</h2><p>As credenciais do Netlify não estão totalmente configuradas.</p>`
    };
  }

  // 2. Validar Sessão Temporária no Netlify Blobs
  const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  const sessionsStore = getBlobsStore('youtube-oauth-sessions');
  const session = await sessionsStore.getJSON(sessionIdHash);

  if (!session || session.used === true || Date.now() > session.expiresAt) {
    return {
      statusCode: 400,
      headers: {
        ...headers,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Sessão Inválida ou Reutilizada</h2><p>Por motivos de segurança, esta sessão de autorização expirou ou já foi utilizada.</p>`
    };
  }

  // 3. Validar Parâmetro State (Proteção CSRF)
  const incomingStateHash = crypto.createHash('sha256').update(state).digest('hex');
  if (!safeCompare(incomingStateHash, session.stateHash)) {
    return {
      statusCode: 400,
      headers: {
        ...headers,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Falha de Validação CSRF</h2><p>O parâmetro state recebido não corresponde à sessão original.</p>`
    };
  }

  // Marca sessão como utilizada imediatamente (Single Use)
  await sessionsStore.setJSON(sessionIdHash, { ...session, used: true });

  // 4. Trocar Code e Code Verifier por Tokens via Servidor (HTTPS POST)
  try {
    const tokenResp = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: session.codeVerifier
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 6000
      }
    );

    const refreshToken = tokenResp.data?.refresh_token;

    if (refreshToken) {
      // 5. Cifrar Refresh Token e Guardar no Netlify Blobs (Store: youtube-oauth-secrets)
      const encryptedPayload = encryptRefreshToken(refreshToken, encryptionKey);
      const secretsStore = getBlobsStore('youtube-oauth-secrets');

      await secretsStore.setJSON('primary-refresh-token', encryptedPayload);
      await secretsStore.setJSON('setup-status', {
        setupComplete: true,
        updatedAt: new Date().toISOString()
      });
    }

    // Apagar cookie de sessão temporário
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `
        <!DOCTYPE html>
        <html lang="pt">
        <head><meta charset="UTF-8"><title>Configuração Concluída</title>
        <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;} .card{background:#1e293b;padding:2rem;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);max-width:450px;text-align:center;border:1px solid #334155;} h2{color:#4ade80;margin-top:0;} p{color:#94a3b8;}</style>
        </head>
        <body>
          <div class="card">
            <h2>Configuração OAuth do YouTube Concluída com Sucesso!</h2>
            <p>As credenciais de acesso foram armazenadas de forma segura e cifrada no servidor backend.</p>
            <p>Pode fechar esta janela.</p>
          </div>
        </body>
        </html>
      `
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Erro no Processamento</h2><p>Não foi possível concluir a troca de token com a Google. Tente novamente mais tarde.</p>`
    };
  }
};
