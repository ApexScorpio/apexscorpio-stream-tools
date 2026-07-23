const crypto = require('crypto');
const { safeCompare, getBlobsStore, checkRateLimit, recordFailedAttempt } = require('./utils/oauth-helpers.js');

exports.handler = async function(event, context, customStores = null) {
  let secretsStore, sessionsStore, ratelimitStore;

  try {
    secretsStore = getBlobsStore('youtube-oauth-secrets', customStores?.secretsStore);
    sessionsStore = getBlobsStore('youtube-oauth-sessions', customStores?.sessionsStore);
    ratelimitStore = getBlobsStore('youtube-oauth-sessions', customStores?.ratelimitStore || customStores?.sessionsStore);
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: `<h2>Erro de Armazenamento Backend</h2><p>O serviço Netlify Blobs não está disponível.</p>`
    };
  }

  // 1. Verificar se a configuração já foi concluída
  try {
    const setupStatus = await secretsStore.getJSON('setup-status');
    if (setupStatus && setupStatus.setupComplete === true) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        },
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
  } catch (err) {}

  // 2. Método GET -> Apresentar Formulário de Autenticação Administrativa
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      },
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

  // 3. Método POST -> Autenticar, Rate Limiting e Iniciar OAuth com PKCE + State
  if (event.httpMethod === 'POST') {
    const clientIp = event.headers?.['x-nf-client-connection-ip'] || event.headers?.['client-ip'] || event.headers?.['x-forwarded-for'] || 'unknown-client';

    // Rate Limiting Check
    const rateCheck = await checkRateLimit(clientIp, ratelimitStore);
    if (!rateCheck.allowed) {
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `<h2>Muitas Tentativas Falhadas</h2><p>O limite de tentativas de autenticação foi atingido. Tente novamente mais tarde.</p>`
      };
    }

    const setupPassword = process.env.YOUTUBE_OAUTH_SETUP_PASSWORD;
    const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
    const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI || 'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback';
    const stateSecret = process.env.YOUTUBE_OAUTH_STATE_SECRET || 'default-state-secret-key';

    if (!setupPassword || !clientId) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `<h2>Configuração Pendente</h2><p>As variáveis de ambiente YOUTUBE_OAUTH_SETUP_PASSWORD ou YOUTUBE_OAUTH_CLIENT_ID não estão configuradas no Netlify.</p>`
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

    // Comparar password usando crypto.timingSafeEqual com hashes SHA-256
    if (!safeCompare(providedPassword, setupPassword)) {
      await recordFailedAttempt(clientIp, ratelimitStore);
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        body: `<h2>Autenticação Falhou</h2><p>Credenciais administrativas incorretas. Tente novamente.</p>`
      };
    }

    // 4. Gerar Sessão Temporária, State Assinado e PKCE (S256)
    const rawState = crypto.randomBytes(32).toString('hex');
    const stateHmac = crypto.createHmac('sha256', stateSecret).update(rawState).digest('hex');
    const state = `${rawState}.${stateHmac}`;
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const sessionId = crypto.randomBytes(32).toString('hex');
    const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // Expira em 10 minutos

    // Guardar sessão no Netlify Blobs (Store: youtube-oauth-sessions)
    await sessionsStore.setJSON(sessionIdHash, {
      stateHash,
      codeVerifier,
      createdAt: new Date().toISOString(),
      expiresAt,
      used: false
    });

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

  return { statusCode: 405, body: 'Método Não Permitido' };
};
