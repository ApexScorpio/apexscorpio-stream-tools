const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'youtube-live.js'),
  'utf8'
);

test('1. Frontend nÃ£o contÃ©m uma API key pÃºblica', () => {
  assert.doesNotMatch(source, /AIzaSy[A-Za-z0-9_-]+/);
  assert.doesNotMatch(source, /APEX_YOUTUBE_API_KEY/);
});

test('2. Frontend nÃ£o chama diretamente googleapis', () => {
  assert.doesNotMatch(
    source,
    /googleapis\.com\/youtube\/v3/i
  );
});

test('3. Estado principal vem de /youtube-status', () => {
  assert.match(source, /STATUS_ENDPOINT\s*=\s*['"]\/youtube-status['"]/);
  assert.match(source, /backendGet\(\s*STATUS_ENDPOINT/);
});

test('4. Chat principal vem de /youtube-chat', () => {
  assert.match(source, /CHAT_ENDPOINT\s*=\s*['"]\/youtube-chat['"]/);
  assert.match(source, /backendGet\(\s*CHAT_ENDPOINT/);
});

test('5. Iframe continua como redundÃ¢ncia', () => {
  assert.match(source, /youtube\.com\/iframe_api/);
  assert.match(source, /embed\/live_stream/);
  assert.match(source, /iframe-fallback/);
});

test('6. oEmbed continua como redundÃ¢ncia', () => {
  assert.match(source, /youtube\.com\/oembed/);
  assert.match(source, /oembed-fallback/);
});

test('7. API e redundÃ¢ncias arrancam em paralelo', () => {
  const start = source.slice(
    source.indexOf('function becomeStateLeader'),
    source.indexOf('function electStateLeader')
  );

  assert.match(start, /scheduleDetails\(0\)/);
  assert.match(start, /schedulePlayerProbe\(1000\)/);
  assert.match(start, /scheduleOEmbedProbe\(1000\)/);
});

test('8. Eventos oficiais continuam suportados', () => {
  for (const type of [
    'newSponsorEvent',
    'membershipGiftingEvent',
    'giftMembershipReceivedEvent',
    'memberMilestoneChatEvent',
    'superChatEvent',
    'superStickerEvent',
    'giftEvent'
  ]) {
    assert.ok(source.includes(type), type);
  }
});

test('9. Viewers desconhecidos nÃ£o sÃ£o inventados como zero', () => {
  assert.match(source, /function normalizeViewers/);
  assert.match(
    source,
    /viewers:\s*sameVideo\s*\?\s*state\.viewers\s*:\s*null/
  );
  assert.match(
    source,
    /isLive:\s*false,\s*\n\s*viewers:\s*null/
  );
});

test('10. Todos os HTML usam youtube-live.js v4.0', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '*.html'],
    {
      cwd: root,
      encoding: 'utf8'
    }
  )
    .split(/\r?\n/)
    .filter(Boolean);

  for (const file of files) {
    const html = fs.readFileSync(
      path.join(root, file),
      'utf8'
    );

    if (!html.includes('youtube-live.js')) {
      continue;
    }

    assert.match(
      html,
      /youtube-live\.js\?v=4\.0/,
      file
    );
  }
});


test('11. Backend YouTube usa o domínio atual', () => {
  assert.match(
    source,
    /global\.location\.origin/
  );

  assert.doesNotMatch(
    source,
    /apexscorpio-youtube-scraper-6e2678f9\.netlify\.app/
  );
});
