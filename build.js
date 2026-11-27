// Gera dist/CamWatch.exe (executável único, com o painel embutido).
// Uso: node build.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = __dirname, dist = path.join(root, 'dist'), exe = path.join(dist, 'CamWatch.exe');
fs.mkdirSync(dist, { recursive: true });
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: root, stdio: 'inherit' });
fs.copyFileSync(process.execPath, exe);
execFileSync('npx', ['--yes', 'postject', exe, 'NODE_SEA_BLOB', 'sea-prep.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { cwd: root, stdio: 'inherit', shell: true });
fs.rmSync(path.join(root, 'sea-prep.blob'), { force: true });
console.log('Pronto:', exe);
