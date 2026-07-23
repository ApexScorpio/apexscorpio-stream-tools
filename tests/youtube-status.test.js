const assert = require('assert');
const { parseViewersText } = require('../netlify/functions/youtube-status');

console.log('=== EXECUTA TESTES AUTOMÁTICOS DO YOUTUBE STATUS PARSER ===\n');

const testCases = [
  { input: "1 a ver agora", expected: 1 },
  { input: "12 a ver agora", expected: 12 },
  { input: "1 234 a ver agora", expected: 1234 },
  { input: "1\u00a0234 a ver agora", expected: 1234 }, // Espaço não separável
  { input: "1 watching now", expected: 1 },
  { input: "1,234 watching now", expected: 1234 },
  { input: "1.234 a ver agora", expected: 1234 },
  { input: "50 espectadores ao vivo", expected: 50 },
  { input: "100 viewers", expected: 100 },
  // Casos que NÃO devem ser confundidos com espectadores em direto:
  { input: "123 visualizações", expected: null },
  { input: "1,234 views", expected: null },
  { input: "Subscrever canal", expected: null },
  { input: null, expected: null },
  { input: undefined, expected: null }
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const result = parseViewersText(tc.input);
  try {
    assert.strictEqual(result, tc.expected, `Falhou para input: "${tc.input}"`);
    console.log(`✓ OK: "${tc.input}" => ${result}`);
    passed++;
  } catch (err) {
    console.error(`✗ ERRO: "${tc.input}" => Esperado: ${tc.expected}, Obtido: ${result}`);
    failed++;
  }
}

console.log(`\nResumo dos Testes: ${passed} passaram, ${failed} falharam.`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('Todos os testes unitários passaram com sucesso!\n');
}
