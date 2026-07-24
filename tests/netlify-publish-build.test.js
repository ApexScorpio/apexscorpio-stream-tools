'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const outputDirectory = path.join(repo, 'dist');

const frontendFiles = [
  'alerts.html',
  'alerts.js',
  'chat.html',
  'events.html',
  'events.js',
  'viewers.html',
  'viewers.js',
  'youtube-live.js',
  'youtube-stats.html',
  'youtube-stats.js'
];

test(
  'build Netlify publica exatamente o frontend v4.2',
  () => {
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            repo,
            'scripts',
            'build-netlify-public.js'
          )
        ],
        {
          cwd: repo,
          encoding: 'utf8',
          windowsHide: true
        }
      );

      assert.equal(
        result.status,
        0,
        result.stderr || result.stdout
      );

      for (const relativeFile of frontendFiles) {
        const source = fs.readFileSync(
          path.join(repo, relativeFile),
          'utf8'
        );

        const published = fs.readFileSync(
          path.join(
            outputDirectory,
            relativeFile
          ),
          'utf8'
        );

        assert.equal(
          published,
          source,
          `${relativeFile} não corresponde à versão da raiz`
        );
      }

      const youtubeLive = fs.readFileSync(
        path.join(
          outputDirectory,
          'youtube-live.js'
        ),
        'utf8'
      );

      assert.match(
        youtubeLive,
        /APEX_YOUTUBE_BACKEND_URL/
      );

      assert.match(
        youtubeLive,
        /\/youtube-status/
      );

      assert.match(
        youtubeLive,
        /\/youtube-chat/
      );

      assert.doesNotMatch(
        youtubeLive,
        /AIzaSy[A-Za-z0-9_-]{20,}/
      );

      assert.doesNotMatch(
        youtubeLive,
        /googleapis\.com\/youtube\/v3/
      );

      for (
        const htmlFile of [
          'alerts.html',
          'chat.html',
          'events.html',
          'viewers.html'
        ]
      ) {
        const html = fs.readFileSync(
          path.join(
            outputDirectory,
            htmlFile
          ),
          'utf8'
        );

        assert.match(
          html,
          /youtube-live\.js\?v=4\.2/
        );
      }

      assert.equal(
        fs.existsSync(
          path.join(
            outputDirectory,
            'css',
            'style.css'
          )
        ),
        true,
        'Os assets existentes de public não foram copiados'
      );
    } finally {
      fs.rmSync(outputDirectory, {
        recursive: true,
        force: true
      });
    }
  }
);


test(
  'overlay de estatísticas do YouTube é publicado',
  () => {
    const html = fs.readFileSync(
      path.join(repo, 'youtube-stats.html'),
      'utf8'
    );

    const javascript = fs.readFileSync(
      path.join(repo, 'youtube-stats.js'),
      'utf8'
    );

    assert.match(html, /metric-subs/);
    assert.match(html, /metric-likes/);
    assert.match(html, /metric-channelviews/);
    assert.match(javascript, /\/youtube-status/);
    assert.match(
      javascript,
      /metrics\.subscribers/
    );
  }
);
