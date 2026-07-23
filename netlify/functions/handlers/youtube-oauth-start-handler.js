const crypto = require('crypto');
const { safeCompare, getBlobsStore, checkRateLimit, recordFailedAttempt } = require('../utils/oauth-helpers.js');

exports.handler = async function(event, context, customStores = null) {
  const genericHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff'
  };

  // 1. Validar Variáveis de Ambiente Obrigatórias (SEM FALLBACKS)
  const setupPassword = process.env.YOUTUBE_OAUTH_SETUP_PASSWORD;
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const stateSecret = process.env.YOUTUBE_OAUTH_STATE_SECRET;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI;

  const expectedRedirectUri = 'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback';

  if (!setupPassword || !clientId || !stateSecret || !redirectUri || redirectUri !== expectedRedirectUri) {
    return {
      statusCode: 500,
      headers: genericHeaders,
      body: `<h2>Configuração do Servidor Indisponível</h2><p>O serviço de autorização não se encontra totalmente configurado.</p>`
    };
  }

  // 2. Conectar às Stores do Netlify Blobs (Fail-Closed)
  let secretsStore, sessionsStore, ratelimitStore;
  try {
    secretsStore = getBlobsStore('youtube-oauth-secrets', customStores?.secretsStore);
    sessionsStore = getBlobsStore('youtube-oauth-sessions', customStores?.sessionsStore);
    ratelimitStore = getBlobsStore('youtube-oauth-sessions', customStores?.ratelimitStore || customStores?.sessionsStore);
  } catch (err) {
    return {
      statusCode: 500,
      headers: genericHeaders,
      body: `<h2>Serviço Indisponível</h2><p>O serviço de armazenamento backend não está acessível no momento.</p>`
    };
  }

  // 3. Verificar se a configuração já foi concluída (Consultar exclusivamente oauth-config)
  try {
    const oauthConfig = await secretsStore.getJSON('oauth-config');
    if (oauthConfig && oauthConfig.setupComplete === true) {
      return {
        statusCode: 200,
        headers: genericHeaders,
        body: `
          <!DOCTYPE html>
          <html lang="pt">
          <head><meta charset="UTF-8"><title>OAuth Concluído</title>
          <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;} .card{background:#1e293b;padding:2rem;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);max-width:450px;text-align:center;border:1px solid #334155;} h2{color:#38bdf8;margin-top:0;} p{color:#94a3b8;}</style>
          </head>
          <body>
            <div class="card">
              <h2>Configuração OAuth Concluída</h2>
              <p>A autorização do YouTube já se encontra ativa no servidor backend.</p>
              <p>Novas tentativas de início estão bloqueadas por segurança.</p>
            </div>
          </body>
          </html>
        `
      };
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: genericHeaders,
      body: `<h2>Serviço Indisponível</h2><p>Falha ao verificar a configuração no armazenamento backend.</p>`
    };
  }

  // 4. Método GET -> Apresentar Formulário de Autenticação Administrativa
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: genericHeaders,
      body: `
        <!DOCTYPE html>
        <html lang="pt">
        <head><meta charset="UTF-8"><title>Início de Configuração OAuth</title>
        <style>
          body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
          .card{background:#1e293b;padding:2rem;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.5);width:100%;max-width:400px;border:1px solid #334155;}
          h2{color:#f43f5e;margin-top:0;font-size:1.4rem;}
          p{color:#94a3b8;font-size:0.9rem;}
          label{display:block;margin-top:1rem;color:#cbd5e1;font-size:0.85rem;font-weight:bold;}
          input[type="password"]{width:100%;padding:0.75rem;margin-top:0.4rem;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#fff;box-sizing:border-box;}
          button{width:100%;padding:0.75rem;margin-top:1.5rem;border-radius:6px;border:none;background:#2563eb;color:#fff;font-weight:bold;cursor:pointer;}
          button:hover{background:#1d4ed8;}
        </style>
        </head>
        <body>
          <div class="card">
            <h2>Autenticação de Configuração</h2>
            <p>Insira a palavra-passe administrativa para iniciar a autorização oficial no Google Cloud.</p>
            <form method="POST" action="/oauth/youtube/start">
              <label for="password">Palavra-passe de Setup:</label>
              <input type="password" id="password" name="password" required autocomplete="current-password" />
              <button type="submit">Autenticar e Iniciar OAuth</button>
            </form>
          </div>
        </body>
        </html>
      `
    };
  }

  // 5. Método POST -> Rate Limiting, Autenticação e Início de Fluxo OAuth
  if (event.httpMethod === 'POST') {
    const clientIp = event.headers?.['x-nf-client-connection-ip'] || event.headers?.['client-ip'] || event.headers?.['x-forwarded-for'] || 'unknown-client';

    // Rate Limiting Check (Fail-Closed)
    let rateCheck;
    try {
      rateCheck = await checkRateLimit(clientIp, ratelimitStore);
    } catch (err) {
      return {
        statusCode: 500,
        headers: genericHeaders,
        body: `<h2>Serviço Indisponível</h2><p>Não foi possível verificar os limites de tentativa no servidor.</p>`
      };
    }

    if (!rateCheck.allowed) {
      return {
        statusCode: 429,
        headers: genericHeaders,
        body: `<h2>Muitas Tentativas Falhadas</h2><p>O limite de tentativas de autenticação foi atingido. Tente novamente mais tarde.</p>`
      };
    }

    // Extrair password do formulário ou body
    let providedPassword = '';
    if (event.body) {
      if (event.headers && (event.headers['content-type']?.includes('application/x-www-form-urlencoded') || event.headers['Content-Type']?.includes('application/x-www-form-urlencoded'))) {
        const params = new URLSearchParams(event.body);
        providedPassword = params.get('password') || '';
      } else {
        try {
          const json = JSON.parse(event.body);
          providedPassword = json.password || '';
        } catch(e) {
          const params = new URLSearchParams(event.body);
          providedPassword = params.get('password') || '';
        }
      }
    }

    // Comparar password usando safeCompare
    if (!safeCompare(providedPassword, setupPassword)) {
      try {
        await recordFailedAttempt(clientIp, ratelimitStore);
      } catch (err) {
        return {
          statusCode: 500,
          headers: genericHeaders,
          body: `<h2>Serviço Indisponível</h2><p>Falha ao registar a tentativa no servidor backend.</p>`
        };
      }

      return {
        statusCode: 401,
        headers: genericHeaders,
        body: `<h2>Autenticação Falhou</h2><p>Credenciais administrativas incorretas. Tente novamente.</p>`
      };
    }

    // 6. Gerar Sessão, State Assinado com HMAC-SHA-256 e PKCE (S256)
    const rawState = crypto.randomBytes(32).toString('hex');
    const signatureHmac = crypto.createHmac('sha256', stateSecret).update(rawState).digest('hex');
    const state = `${rawState}.${signatureHmac}`;
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const sessionId = crypto.randomBytes(32).toString('hex');
    const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 minutos

    // Guardar sessão no Netlify Blobs (Fail-Closed)
    try {
      await sessionsStore.setJSON(sessionIdHash, {
        stateHash,
        rawState,
        signatureHmac,
        codeVerifier,
        createdAt: new Date().toISOString(),
        expiresAt,
        used: false
      });
    } catch (err) {
      return {
        statusCode: 500,
        headers: genericHeaders,
        body: `<h2>Serviço Indisponível</h2><p>Falha ao criar a sessão de autorização no servidor.</p>`
      };
    }

    const scope = encodeURIComponent('https://www.googleapis.com/auth/youtube.readonly');
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&include_granted_scopes=true&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

    const cookieHeader = `oauth_session=${sessionId}; Path=/oauth/youtube; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;

    return {
      statusCode: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': cookieHeader,
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache'
      }
    };
  }

  return { statusCode: 405, headers: genericHeaders, body: 'Método Não Permitido' };
};
