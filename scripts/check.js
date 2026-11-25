// Syntax-checks every .js file under api/ and scripts/, plus middleware.js.
//
//   npm run check
//
// It walks the folders, so a new file is covered the day it is added — there is no list to
// keep up to date. Nothing is executed: each file is only parsed (`node --check`).
// middleware.js is an ES module (Vercel's edge runtime wants `export`) inside a CommonJS
// package, so it is parsed as a module; everything else is CommonJS.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const FOLDERS = ['api', 'scripts'];
const MODULES = ['middleware.js'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const commonjs = FOLDERS.flatMap(f => walk(path.join(root, f))).sort();
const modules = MODULES.map(f => path.join(root, f)).filter(f => fs.existsSync(f));

let failed = 0;
const report = (file, res) => {
  if (res.status === 0) return;
  failed++;
  console.error(`✗ ${path.relative(root, file)}\n${String(res.stderr || res.stdout || '').trim()}\n`);
};
for (const file of commonjs) report(file, spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }));
// A module is checked from stdin: on Node 18/20 a .js file in a CommonJS package is always
// parsed as CommonJS, whatever it contains.
for (const file of modules) {
  report(file, spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(file, 'utf8'), encoding: 'utf8' }));
}

const total = commonjs.length + modules.length;
if (failed) { console.error(`${failed} of ${total} files failed the syntax check.`); process.exit(1); }
console.log(`OK — ${total} files parse.`);
