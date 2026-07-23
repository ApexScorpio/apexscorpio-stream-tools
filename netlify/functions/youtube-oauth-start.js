exports.handler = async function(event, context) {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI || 'https://apexscorpio-youtube-scraper-6e2678f9.netlify.app/oauth/youtube/callback';
  
  if (!clientId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: "FALHOU",
        error: "YOUTUBE_OAUTH_CLIENT_ID não está configurado nas variáveis de ambiente do Netlify."
      })
    };
  }

  const scope = encodeURIComponent('https://www.googleapis.com/auth/youtube.readonly');
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&include_granted_scopes=true`;

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
      'Cache-Control': 'no-store'
    }
  };
};
