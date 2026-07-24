'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const dist = path.join(repo, 'dist');

const maximumBytes =
  25 * 1024 * 1024;

function walk(directory) {
  const result = [];

  for (
    const entry
    of fs.readdirSync(
      directory,
      { withFileTypes: true }
    )
  ) {
    const absolute =
      path.join(directory, entry.name);

    if (entry.isDirectory()) {
      result.push(...walk(absolute));
    } else {
      result.push(absolute);
    }
  }

  return result;
}

if (!fs.existsSync(dist)) {
  throw new Error(
    'O diretório dist ainda não existe.'
  );
}

const oversized = walk(dist)
  .map(absolute => ({
    absolute,
    relative: path
      .relative(dist, absolute)
      .replace(/\\/g, '/'),
    bytes: fs.statSync(absolute).size
  }))
  .filter(file =>
    file.bytes > maximumBytes
  )
  .sort((a, b) =>
    b.bytes - a.bytes
  );

const ignorePath =
  path.join(dist, '.assetsignore');

const ignoreLines = oversized.map(
  file => file.relative
);

fs.writeFileSync(
  ignorePath,
  ignoreLines.length
    ? ignoreLines.join('\n') + '\n'
    : '',
  'utf8'
);

console.log('');
console.log(
  'Ficheiros superiores a 25 MiB excluídos do Cloudflare:'
);

if (oversized.length === 0) {
  console.log('  Nenhum.');
} else {
  for (const file of oversized) {
    console.log(
      '  ' +
      (
        file.bytes /
        1024 /
        1024
      ).toFixed(2) +
      ' MiB | ' +
      file.relative
    );
  }
}

console.log('');
console.log(
  '.assetsignore criado em: ' +
  ignorePath
);