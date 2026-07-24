let runtimeAxios = null;

function setRuntimeAxios(axiosInstance) {
  if (
    !axiosInstance ||
    typeof axiosInstance.get !== 'function' ||
    typeof axiosInstance.post !== 'function'
  ) {
    throw new Error('axios runtime inválido');
  }

  runtimeAxios = axiosInstance;
}
const crypto = require('crypto');
const { safeCompare, getBlobsStore, encryptRefreshToken, decryptRefreshToken, parseCookieHeader } = require('../utils/oauth-helpers.js');

exports.handler = async function(event, context, customStores = null, customAxios = null) {
  const http = customAxios || runtimeAxios;

  const genericHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline';"
  };

  const expiredCookieHeader = 'oauth_session=; Path=/oauth/youtube; HttpOnly; Secure; Max-Age=0';

  // 1. Validar Variáveis de Ambiente Obrigatórias (SEM FALLBACKS)
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const encryptionKey = process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY;
  const stateSecret = process.env.YOUTUBE_OAUTH_STATE_SECRET;
  const expectedChannelId = process.env.YOUTUBE_EXPECTED_CHANNEL_ID;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI;

  const allowedRedirectUris = new Set([
    'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback',
    'https://oauthfix--apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback'
  ]);

  if (!clientId || !clientSecret || !encryptionKey || !stateSecret || !expectedChannelId || !redirectUri || !allowedRedirectUris.has(redirectUri)) {
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

  if (event.httpMethod === 'GET' && event.queryStringParameters?.diagnostic === 'safe') {
    let diagnostic = null;

    try {
      diagnostic = await secretsStore.get('oauth-last-safe-diagnostic-v2', { type: 'json' });
    } catch (_secretsDiagnosticReadError) {
      // Tentar a store de sessões como redundância.
    }

    if (!diagnostic) {
      try {
        diagnostic = await sessionsStore.get('oauth-last-safe-diagnostic-v2', { type: 'json' });
      } catch (_sessionsDiagnosticReadError) {
        // A resposta abaixo continuará em estado pendente.
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      },
      body: JSON.stringify(
        diagnostic || {
          status: 'pending',
          stage: null,
          httpStatus: null,
          code: null,
          detail: 'Ainda não existe um diagnóstico para a tentativa atual.',
          updatedAt: null
        },
        null,
        2
      )
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
    session = await sessionsStore.get(sessionIdHash, { type: 'json' });
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
        'Set-Cookie': expiredCookieHeader
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
        'Set-Cookie': expiredCookieHeader
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
        'Set-Cookie': expiredCookieHeader
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
        'Set-Cookie': expiredCookieHeader
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

  // Executar trocas e gravações terminais garantindo eliminação final da sessão
  let processingStage = 'token_exchange';

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

    processingStage = 'token_response_validation';

    const refreshToken = tokenResp.data?.refresh_token;
    const accessToken = tokenResp.data?.access_token;

    if (!refreshToken || !accessToken) {
      return {
        statusCode: 400,
        headers: {
          ...genericHeaders,
          'Set-Cookie': expiredCookieHeader
        },
        body: `<h2>Tokens Incompletos</h2><p>A resposta de autorização não incluiu o refresh token e o access token simultaneamente. Repita o processo com consentimento.</p>`
      };
    }

    processingStage = 'youtube_channel_lookup';

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
          'Set-Cookie': expiredCookieHeader
        },
        body: `<h2>Canal Não Permitido</h2><p>A conta Google autorizada não pertence ao canal permitido para este serviço.</p>`
      };
    }

    processingStage = 'token_encryption';

    const randomTokenKey = `token-v-${crypto.randomBytes(8).toString('hex')}`;
    const encryptedPayload = encryptRefreshToken(refreshToken, encryptionKey);

    processingStage = 'blob_token_write';
    await secretsStore.setJSON(randomTokenKey, encryptedPayload);

    processingStage = 'blob_token_readback';
    const verifiedBlob = await secretsStore.get(randomTokenKey, { type: 'json' });
    if (!verifiedBlob || !verifiedBlob.iv || !verifiedBlob.ciphertext || !verifiedBlob.authTag) {
      throw new Error('Falha na leitura de verificação do Blob cifrado');
    }

    processingStage = 'blob_token_decrypt_verify';
    const decryptedVerificationToken = decryptRefreshToken(verifiedBlob, encryptionKey);
    if (!decryptedVerificationToken || !safeCompare(decryptedVerificationToken, refreshToken)) {
      throw new Error('Falha na verificação de decifragem do token gravado');
    }

    processingStage = 'blob_config_write';
    const expectedChannelIdHash = crypto.createHash('sha256').update(expectedChannelId).digest('hex');
    await secretsStore.setJSON('oauth-config', {
      version: '1.0',
      setupComplete: true,
      activeTokenKey: randomTokenKey,
      expectedChannelIdHash: expectedChannelIdHash,
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      updatedAt: new Date().toISOString()
    });

    return {
      statusCode: 200,
      headers: {
        ...genericHeaders,
        'Set-Cookie': expiredCookieHeader
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
    const responseStatus = Number(err?.response?.status || 0) || null;
    const responseData = err?.response?.data;

    const providerCode =
      typeof responseData?.error === 'string'
        ? responseData.error
        : typeof responseData?.error?.status === 'string'
          ? responseData.error.status
          : typeof responseData?.error?.errors?.[0]?.reason === 'string'
            ? responseData.error.errors[0].reason
            : null;

    const providerDescription =
      typeof responseData?.error_description === 'string'
        ? responseData.error_description
        : typeof responseData?.error?.message === 'string'
          ? responseData.error.message
          : typeof err?.message === 'string'
            ? err.message
            : 'erro desconhecido';

    const internalCode =
      typeof err?.code === 'string'
        ? err.code
        : null;

    const safeDetail = String(providerDescription)
      .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED]')
      .replace(/1\/\/[A-Za-z0-9._-]+/g, '[REDACTED]')
      .replace(/[A-Za-z0-9._-]{48,}/g, '[REDACTED]')
      .slice(0, 500);

    const diagnostic = {
      status: 'error',
      stage: processingStage,
      httpStatus: responseStatus,
      code: providerCode || internalCode,
      detail: safeDetail,
      updatedAt: new Date().toISOString()
    };

    let diagnosticStored = false;

    try {
      await secretsStore.setJSON('oauth-last-safe-diagnostic-v2', diagnostic);
      diagnosticStored = true;
    } catch (_secretsDiagnosticWriteError) {
      // Usar a store temporária como redundância.
    }

    if (!diagnosticStored) {
      try {
        await sessionsStore.setJSON('oauth-last-safe-diagnostic-v2', diagnostic);
        diagnosticStored = true;
      } catch (diagnosticStoreError) {
        diagnostic.diagnosticStore = typeof diagnosticStoreError?.message === 'string'
          ? diagnosticStoreError.message.slice(0, 250)
          : 'falha desconhecida';
      }
    }

    console.error(
      '[youtube-oauth-callback-safe-diagnostic-v2]',
      JSON.stringify(diagnostic)
    );

    return {
      statusCode: 500,
      headers: {
        ...genericHeaders,
        'Set-Cookie': expiredCookieHeader
      },
      body: `<h2>Erro no Processamento</h2><p>Não foi possível concluir a troca de token com a Google. Tente novamente mais tarde.</p>`
    };
  } finally {
    try {
      await sessionsStore.delete(sessionIdHash);
    } catch (_deleteErr) {
      // Ignorar erro de deleção de sessão caso já tenha sido limpa
    }
  }
};

exports.setRuntimeAxios = setRuntimeAxios;
