'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const publicDirectory = path.join(repo, 'public');
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

if (!fs.existsSync(publicDirectory)) {
  throw new Error(
    'O diretório public não foi encontrado.'
  );
}

fs.rmSync(outputDirectory, {
  recursive: true,
  force: true
});

fs.cpSync(
  publicDirectory,
  outputDirectory,
  {
    recursive: true,
    force: true
  }
);

for (const relativeFile of frontendFiles) {
  const source = path.join(repo, relativeFile);
  const destination = path.join(
    outputDirectory,
    relativeFile
  );

  if (!fs.existsSync(source)) {
    throw new Error(
      `Ficheiro de frontend ausente: ${relativeFile}`
    );
  }

  fs.mkdirSync(path.dirname(destination), {
    recursive: true
  });

  fs.copyFileSync(source, destination);
}

console.log(
  'Netlify publish preparado em dist com frontend v4.1.'
);
