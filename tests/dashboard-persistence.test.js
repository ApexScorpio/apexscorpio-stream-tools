'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(
    path.join(root, relativePath),
    'utf8'
  );
}

for (
  const file
  of ['index.html', 'public/index.html']
) {
  test(
    file + ' restaura todas as opções',
    () => {
      const html = source(file);

      assert.match(
        html,
        /restoreAllControls\(\)/
      );

      assert.match(
        html,
        /restoreCloudControls\(\)/
      );

      assert.match(
        html,
        /id="chat-max-pills"/
      );

      assert.match(
        html,
        /maxMessages:\s*normalizeDashboardMaxPills/
      );

      assert.match(
        html,
        /chat\.html\?v=4\.5/
      );

      assert.match(
        html,
        /overlay-relay\.js\?v=1\.2/
      );
    }
  );
}

test(
  'relay consegue carregar configuração persistente',
  () => {
    const relay = source('overlay-relay.js');

    assert.match(
      relay,
      /async function load\(overlayName\)/
    );

    assert.match(
      relay,
      /save,\s*load,\s*start/
    );
  }
);

test(
  'chat aplica imediatamente o limite de pills',
  () => {
    const html = source('chat.html');

    assert.match(
      html,
      /function normalizeMaxMessages\(value\)/
    );

    assert.match(
      html,
      /chatContainer\.children\.length\s*>\s*cfg\.maxMessages/
    );

    assert.match(
      html,
      /overlay-relay\.js\?v=1\.2/
    );
  }
);