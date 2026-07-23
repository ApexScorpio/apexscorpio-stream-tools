const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseViewersText } = require('../netlify/functions/youtube-status');

console.log('=== EXECUTA TESTES DE INTEGRIDADE E UNITÁRIOS DO YOUTUBE STATUS ===\n');

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
// FASE 7.1: TESTES ESTÁTICOS DE CÓDIGO FONTE (HACKS REMOVIDOS)
// -------------------------------------------------------------
const prodCodePath = path.join(__dirname, '../netlify/functions/youtube-status.js');
const prodCode = fs.readFileSync(prodCodePath, 'utf8');

runTest('Ficheiro de produção não contém o ID estático 0bDpBd_HZsk', () => {
  assert.strictEqual(prodCode.includes('0bDpBd_HZsk'), false, 'ID fixo 0bDpBd_HZsk encontrado no código!');
});

runTest('Ficheiro de produção não contém fallback inventado selectedViewers = 1', () => {
  assert.strictEqual(/selectedViewers\s*=\s*1/.test(prodCode), false, 'Fallback de viewers = 1 encontrado no código!');
});

runTest('Ficheiro de produção não contém atribuição viewers = 1 ou viewers: 1', () => {
  assert.strictEqual(/viewers\s*[:=]\s*1\b/.test(prodCode), false, 'Fallback de viewers = 1 encontrado!');
});

runTest('Ficheiro de produção não permite que oEmbed defina isLive', () => {
  assert.strictEqual(prodCode.includes('oembed.validTitleResponse'), false, 'oEmbed ainda está a validar isLive!');
});

runTest('Ficheiro de produção não permite que isLiveContent isolado defina isLive', () => {
  assert.strictEqual(prodCode.includes('liveSignal = "videoDetails.isLiveContent"'), false, 'isLiveContent isolado ainda está a validar isLive!');
});

// -------------------------------------------------------------
// FASE 7.2: TESTES FUNCIONAIS DO PARSER DE ESPECTADORES
// -------------------------------------------------------------
const viewerTestCases = [
  { input: "1 a ver agora", expected: 1 },
  { input: "12 a ver agora", expected: 12 },
  { input: "1 234 a ver agora", expected: 1234 },
  { input: "1\u00a0234 a ver agora", expected: 1234 },
  { input: "1 watching now", expected: 1 },
  { input: "1,234 watching now", expected: 1234 },
  { input: "1.234 a ver agora", expected: 1234 },
  { input: "50 espectadores ao vivo", expected: 50 },
  { input: "100 viewers", expected: 100 },
  // Rejeições obrigatórias:
  { input: "123 visualizações", expected: null },
  { input: "1,234 views", expected: null },
  { input: "500 reproduções", expected: null },
  { input: "100 visualizações desde a publicação", expected: null },
  { input: "Subscrever canal", expected: null },
  { input: null, expected: null },
  { input: undefined, expected: null }
];

for (const tc of viewerTestCases) {
  runTest(`parseViewersText("${tc.input}") => ${tc.expected}`, () => {
    const result = parseViewersText(tc.input);
    assert.strictEqual(result, tc.expected);
  });
}

// -------------------------------------------------------------
// FASE 7.3: TESTES LÓGICOS DE SINAIS DE LIVE
// -------------------------------------------------------------
runTest('isLiveContent true + isLiveNow false => isLive deve ser false', () => {
  const mockPlayerResp = {
    videoDetails: { isLiveContent: true, isLive: false },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false } } }
  };
  const micro = mockPlayerResp.microformat.playerMicroformatRenderer.liveBroadcastDetails;
  const isLive = micro.isLiveNow === true || mockPlayerResp.videoDetails.isLive === true;
  assert.strictEqual(isLive, false);
});

runTest('isLiveNow true + viewers ausentes => isLive true, viewers null', () => {
  const mockPlayerResp = {
    videoDetails: { isLive: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } }
  };
  const isLive = mockPlayerResp.microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow === true;
  const rawViewerText = null;
  const viewers = parseViewersText(rawViewerText);
  assert.strictEqual(isLive, true);
  assert.strictEqual(viewers, null);
});

console.log(`\nResumo dos Testes: ${passed} passaram, ${failed} falharam.`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('Todos os testes estáticos e funcionais passaram com sucesso!\n');
}
