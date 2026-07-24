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
  'chat.html',
  'events.html',
  'viewers.html',
  'youtube-live.js'
];

test(
  'build Netlify publica exatamente o frontend v3.0',
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
          /youtube-live\.js\?v=3\.0/
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
