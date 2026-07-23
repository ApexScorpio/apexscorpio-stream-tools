const axios = require('axios');

exports.handler = async function(event, context) {
  const code = event.queryStringParameters?.code;
  const error = event.queryStringParameters?.error;

  if (error) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<h2>[FALHOU] Autorização Recusada</h2><p>${error}</p>`
    };
  }

  if (!code) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<h2>[FALHOU] Código de autorização ausente.</h2>`
    };
  }

  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI || 'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback';

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<h2>[FALHOU] Variáveis de ambiente YOUTUBE_OAUTH_CLIENT_ID ou YOUTUBE_OAUTH_CLIENT_SECRET em falta no Netlify.</h2>`
    };
  }

  try {
    const tokenResp = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const refreshToken = tokenResp.data?.refresh_token;

    const htmlBody = `
      <!DOCTYPE html>
      <html lang="pt">
      <head><meta charset="UTF-8"><title>YouTube OAuth - Configuração de Sucesso</title>
      <style>body{font-family:sans-serif;padding:2rem;background:#111;color:#eee;} .card{background:#222;padding:1.5rem;border-radius:8px;} code{background:#333;padding:0.2rem 0.4rem;border-radius:4px;color:#0f0;}</style>
      </head>
      <body>
        <div class="card">
          <h2>[CONFIRMADO] Autenticação OAuth do YouTube Concluída com Sucesso!</h2>
          <p>O <code>refresh_token</code> foi obtido. Adiciona esta variável no Netlify:</p>
          <p><strong>Nome da Variável:</strong> <code>YOUTUBE_OAUTH_REFRESH_TOKEN</code></p>
          ${refreshToken ? `<p><strong>Valor do Refresh Token:</strong> <code>${refreshToken}</code></p>` : `<p><em>Nota: Se o refresh_token não apareceu, aceda a /oauth/youtube/start para forçar o ecrã de consentimento.</em></p>`}
          <p>Após definir a variável no Netlify, a API oficial do YouTube (Fonte A & B) funcionará com renovação automática sem expirar.</p>
        </div>
      </body>
      </html>
    `;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: htmlBody
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<h2>[FALHOU] Erro na troca de token</h2><p>${err.response?.data?.error_description || err.message}</p>`
    };
  }
};
