const axios = require('axios');
const crypto = require('crypto');
const { safeCompare, getBlobsStore, encryptRefreshToken, decryptRefreshToken, parseCookieHeader } = require('./utils/oauth-helpers.js');

exports.handler = async function(event, context, customStores = null, customAxios = null) {
  const http = customAxios || axios;

  const genericHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline';"
  };

  // 1. Validar Variáveis de Ambiente Obrigatórias (SEM FALLBACKS)
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const encryptionKey = process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY;
  const stateSecret = process.env.YOUTUBE_OAUTH_STATE_SECRET;
  const expectedChannelId = process.env.YOUTUBE_EXPECTED_CHANNEL_ID;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI;

  const expectedRedirectUri = 'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback';

  if (!clientId || !clientSecret || !encryptionKey || !stateSecret || !expectedChannelId || !redirectUri || redirectUri !== expectedRedirectUri) {
    return {
      statusCode: 500,
      headers: genericHeaders,
      body: `<h2>Configuração do Servidor Incompleta</h2><p>As variáveis de autorização necessárias não se encontram totalmente configuradas.</p>`
    };
  }

  // 2. Conectar às Stores do Netlify Blobs (Fail-Closed)
  let secretsStore, sessionsStore;
  try {
    secretsStore = getBlobsStore('youtube-oauth-secrets', customStores?.secretsStore);
    sessionsStore = getBlobsStore('youtube-oauth-sessions', customStores?.sessionsStore);
  } catch (err) {
    return {
      statusCode: 500,
      headers: genericHeaders,
      body: `<h2>Serviço Indisponível</h2><p>O serviço de armazenamento backend não está acessível no momento.</p>`
    };
  }

  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  const error = event.queryStringParameters?.error;

  const cookieHeader = event.headers?.cookie || event.headers?.Cookie;
  const sessionId = parseCookieHeader(cookieHeader, 'oauth_session');

  // 3. Tratar Erro de Autorização ou Ausência de Parâmetros
  if (error || !code || !state || !sessionId) {
    return {
      statusCode: 400,
      headers: genericHeaders,
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

  // 4. Validar Sessão Temporária no Netlify Blobs
  const sessionIdHash = crypto.createHash('sha256').update(sessionId).digest('hex');
  let session;
  try {
    session = await sessionsStore.getJSON(sessionIdHash);
  } catch (err) {
    return {
      statusCode: 500,
      headers: genericHeaders,
      body: `<h2>Serviço Indisponível</h2><p>Falha ao verificar a sessão de autorização no servidor.</p>`
    };
  }

  if (!session || session.used === true || Date.now() > session.expiresAt) {
    return {
      statusCode: 400,
      headers: {
        ...genericHeaders,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Sessão Inválida ou Reutilizada</h2><p>Por motivos de segurança, esta sessão de autorização expirou ou já foi utilizada.</p>`
    };
  }

  // 5. Validar Realmente o HMAC do State (Seção 2)
  const stateParts = state.split('.');
  if (stateParts.length !== 2) {
    return {
      statusCode: 400,
      headers: {
        ...genericHeaders,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Falha de Validação CSRF</h2><p>O formato do parâmetro state recebido é inválido.</p>`
    };
  }

  const [rawState, signatureHmac] = stateParts;
  const expectedHmac = crypto.createHmac('sha256', stateSecret).update(rawState).digest('hex');

  if (!safeCompare(signatureHmac, expectedHmac)) {
    return {
      statusCode: 400,
      headers: {
        ...genericHeaders,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Falha de Validação CSRF</h2><p>A assinatura HMAC do parâmetro state é inválida.</p>`
    };
  }

  const incomingStateHash = crypto.createHash('sha256').update(state).digest('hex');
  if (!safeCompare(incomingStateHash, session.stateHash)) {
    return {
      statusCode: 400,
      headers: {
        ...genericHeaders,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Falha de Validação CSRF</h2><p>O parâmetro state recebido não corresponde à sessão original.</p>`
    };
  }

  // Marca sessão como utilizada imediatamente (Single-Use Token)
  try {
    await sessionsStore.setJSON(sessionIdHash, { ...session, used: true });
  } catch (err) {
    return {
      statusCode: 500,
      headers: genericHeaders,
      body: `<h2>Serviço Indisponível</h2><p>Falha ao atualizar a sessão de autorização.</p>`
    };
  }

  // 6. Trocar Code por Tokens (Servidor a Servidor)
  try {
    const tokenResp = await http.post(
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
    const accessToken = tokenResp.data?.access_token;

    // Seção 3: Exigir AMBOS os tokens (access_token E refresh_token)
    if (!refreshToken || !accessToken) {
      return {
        statusCode: 400,
        headers: {
          ...genericHeaders,
          'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
        },
        body: `<h2>Tokens Incompletos</h2><p>A resposta de autorização não incluiu o refresh token e o access token simultaneamente. Repita o processo com consentimento.</p>`
      };
    }

    // Seção 3: Validar Canal Autorizado via API do YouTube
    const channelResp = await http.get(
      'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000
      }
    );
    const authorizedChannelId = channelResp.data?.items?.[0]?.id || null;

    if (!authorizedChannelId || !safeCompare(authorizedChannelId, expectedChannelId)) {
      return {
        statusCode: 403,
        headers: {
          ...genericHeaders,
          'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
        },
        body: `<h2>Canal Não Permitido</h2><p>A conta Google autorizada não pertence ao canal permitido para este serviço.</p>`
      };
    }

    // Seção 4: Ativação Segura do Novo Token (Versionada + Verificada)
    const randomTokenKey = `token-v-${crypto.randomBytes(8).toString('hex')}`;
    const encryptedPayload = encryptRefreshToken(refreshToken, encryptionKey);

    // 1. Guardar token cifrado na chave versionada aleatória
    await secretsStore.setJSON(randomTokenKey, encryptedPayload);

    // 2. Leitura de Verificação da chave versionada
    const verifiedBlob = await secretsStore.getJSON(randomTokenKey);
    if (!verifiedBlob || !verifiedBlob.iv || !verifiedBlob.ciphertext || !verifiedBlob.authTag) {
      throw new Error('Falha na leitura de verificação do Blob cifrado');
    }

    // 3. Decifrar com a função real de produção para validar integridade
    const decryptedVerificationToken = decryptRefreshToken(verifiedBlob, encryptionKey);
    if (!decryptedVerificationToken || !safeCompare(decryptedVerificationToken, refreshToken)) {
      throw new Error('Falha na verificação de decifragem do token gravado');
    }

    // 4. Apenas após verificação total concluída com sucesso, atualizar o ponteiro fixo 'oauth-config'
    await secretsStore.setJSON('oauth-config', {
      activeTokenKey: randomTokenKey,
      updatedAt: new Date().toISOString()
    });

    await secretsStore.setJSON('setup-status', {
      setupComplete: true,
      updatedAt: new Date().toISOString()
    });

    // Apagar cookie de sessão temporário
    return {
      statusCode: 200,
      headers: {
        ...genericHeaders,
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
            <p>As credenciais de acesso foram armazenadas e ativadas de forma segura e cifrada no servidor backend.</p>
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
        ...genericHeaders,
        'Set-Cookie': 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0'
      },
      body: `<h2>Erro no Processamento</h2><p>Não foi possível concluir a troca de token com a Google. Tente novamente mais tarde.</p>`
    };
  }
};
