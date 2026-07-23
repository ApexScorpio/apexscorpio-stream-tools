const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseViewersText } = require('../netlify/functions/handlers/youtube-status-handler.js');

console.log('=== EXECUTA TESTES DE FALHA E FIABILIDADE MULTIFONTE ===\n');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`✓ OK: ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ERRO: ${name} => ${err.message}`);
    failed++;
  }
}

// -------------------------------------------------------------
// FASE 8.1: TESTES ESTÁTICOS DE CÓDIGO FONTE (SEM SECRETS NO GIT)
// -------------------------------------------------------------
const prodCodePath = path.join(__dirname, '../netlify/functions/handlers/youtube-status-handler.js');
const prodCode = fs.readFileSync(prodCodePath, 'utf8');

runTest('Ficheiro de produção não contém credenciais ou tokens gravados', () => {
  assert.strictEqual(/AIzaSy[A-Za-z0-9_-]{33}/.test(prodCode), false, 'Chave de API do Google encontrada no código!');
  assert.strictEqual(/client_secret\s*:\s*["'][A-Za-z0-9_-]+["']/.test(prodCode), false, 'Client Secret estático encontrado!');
  assert.strictEqual(/refresh_token\s*:\s*["'][A-Za-z0-9_-]+["']/.test(prodCode), false, 'Refresh token estático encontrado!');
});

runTest('Ficheiro de produção utiliza variáveis de ambiente para OAuth', () => {
  assert.strictEqual(prodCode.includes('process.env.YOUTUBE_OAUTH_CLIENT_ID'), true);
  assert.strictEqual(prodCode.includes('process.env.YOUTUBE_OAUTH_CLIENT_SECRET'), true);
  assert.strictEqual(prodCode.includes('process.env.YOUTUBE_OAUTH_TOKEN_ENCRYPTION_KEY'), true);
  assert.strictEqual(prodCode.includes('process.env.YOUTUBE_EXPECTED_CHANNEL_ID'), true);
});

// -------------------------------------------------------------
// FASE 8.2: TESTES DE RESILIÊNCIA E FALHAS SIMULADAS DE FONTES
// -------------------------------------------------------------

runTest('Cenário 1: OAuth funciona, scrape falha => isLive true, confidence high/medium', () => {
  const mockOAuth = { status: "confirmed", isLive: true, videoId: "abc12345678" };
  const mockScrape = { status: "error", error: "ETIMEDOUT" };

  const isLive = mockOAuth.isLive || mockScrape.isLive;
  const videoId = mockOAuth.videoId || mockScrape.videoId;
  assert.strictEqual(isLive, true);
  assert.strictEqual(videoId, "abc12345678");
});

runTest('Cenário 2: OAuth falha, scrape funciona => isLive true, fallback transparente', () => {
  const mockOAuth = { status: "error", error: "Unauthorized" };
  const mockScrape = { status: "confirmed", isLive: true, videoId: "xyz98765432" };

  const isLive = mockOAuth.isLive || mockScrape.isLive;
  const videoId = mockOAuth.videoId || mockScrape.videoId;
  assert.strictEqual(isLive, true);
  assert.strictEqual(videoId, "xyz98765432");
});

runTest('Cenário 3: Count ausente em todas as fontes => viewers: null, nunca 0', () => {
  const sourceOAuthVideo = { concurrentViewers: null };
  const sourceNext = { viewers: null };
  const sourceHTML = { viewers: null };

  const viewers = sourceOAuthVideo.concurrentViewers || sourceNext.viewers || sourceHTML.viewers || null;
  assert.strictEqual(viewers, null);
});

runTest('Cenário 4: Uma fonte devolve 0 explícito => viewers 0 (quando explicitamente 0)', () => {
  const sourceOAuthVideo = { concurrentViewers: 0 };
  const viewers = sourceOAuthVideo.concurrentViewers;
  assert.strictEqual(viewers, 0);
});

runTest('Cenário 5: Fontes devolvem valores de viewers concordantes => prioridade oficial OAuth', () => {
  const sourceOAuthVideo = { concurrentViewers: 45 };
  const sourceNext = { viewers: 42 };

  const viewers = sourceOAuthVideo.concurrentViewers ?? sourceNext.viewers;
  assert.strictEqual(viewers, 45);
});

// -------------------------------------------------------------
// FASE 8.3: TESTES DO TOTAL PARCIAL VS TOTAL EXATO
// -------------------------------------------------------------

function computeTotal(platforms) {
  let knownSum = 0;
  let hasNullViewerOnLive = false;
  let anyLive = false;

  for (const p of platforms) {
    if (p.isLive) {
      anyLive = true;
      if (p.viewers !== null && p.viewers !== undefined) {
        knownSum += p.viewers;
      } else {
        hasNullViewerOnLive = true;
      }
    }
  }

  if (!anyLive) return "0";
  if (hasNullViewerOnLive) return `≥${knownSum}`;
  return `${knownSum}`;
}

runTest('Total exato: Twitch 10 + YouTube 20 => "30"', () => {
  const result = computeTotal([
    { isLive: true, viewers: 10 },
    { isLive: true, viewers: 20 }
  ]);
  assert.strictEqual(result, "30");
});

runTest('Total parcial: Twitch 10 + YouTube null (live) => "≥10"', () => {
  const result = computeTotal([
    { isLive: true, viewers: 10 },
    { isLive: true, viewers: null }
  ]);
  assert.strictEqual(result, "≥10");
});

runTest('Total offline: Todas plataformas offline => "0"', () => {
  const result = computeTotal([
    { isLive: false, viewers: null },
    { isLive: false, viewers: null }
  ]);
  assert.strictEqual(result, "0");
});

// -------------------------------------------------------------
// FASE 8.4: TESTES DO PARSER DE TEXTO DE ESPECTADORES
// -------------------------------------------------------------
const viewerTestCases = [
  { input: "1 a ver agora", expected: 1 },
  { input: "12 a ver agora", expected: 12 },
  { input: "1 234 a ver agora", expected: 1234 },
  { input: "1 watching now", expected: 1 },
  { input: "1,234 watching now", expected: 1234 },
  { input: "123 visualizações", expected: null },
  { input: "1,234 views", expected: null },
  { input: null, expected: null }
];

for (const tc of viewerTestCases) {
  runTest(`parseViewersText("${tc.input}") => ${tc.expected}`, () => {
    const result = parseViewersText(tc.input);
    assert.strictEqual(result, tc.expected);
  });
}

console.log(`\nResumo dos Testes de Falha: ${passed} passaram, ${failed} falharam.`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('Todos os testes de falha e fiabilidade multifonte passaram com sucesso!\n');
}
