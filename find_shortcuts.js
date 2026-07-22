const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const recentDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Recent');
const files = fs.readdirSync(recentDir).filter(f => f.toLowerCase().includes('apex'));

console.log('Found recent Apex shortcut files:', files);

for (const file of files) {
  const fullPath = path.join(recentDir, file);
  try {
    const psCmd = `powershell -Command "(New-Object -ComObject WScript.Shell).CreateShortcut('${fullPath.replace(/'/g, "''")}').TargetPath"`;
    const target = execSync(psCmd, { encoding: 'utf8' }).trim();
    console.log(`LINK: ${file} => TARGET: ${target}`);
  } catch (e) {
    console.error(`Error reading ${file}:`, e.message);
  }
}
