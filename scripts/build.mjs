// Syntax/asset validation only. Does not import app modules, create data, or run tests/models.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    if (entry.isSymbolicLink() || entry.name === '__pycache__') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file); else files.push(file);
  }
}
for (const dir of ['business','adapters','public','scripts','config','contracts','partner']) walk(path.join(root,dir));
let checked = 0;
for (const file of files) {
  if (/\.(js|mjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check',file], {stdio:'inherit',windowsHide:true});
    if (result.error || result.status !== 0) process.exit(1);
    checked++;
  } else if (file.endsWith('.json')) { JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); checked++; }
}
const python = path.join(root,'.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const pythonFiles = files.filter(f=>f.endsWith('.py'));
const compile = spawnSync(python,['-m','py_compile',...pythonFiles],{stdio:'inherit',windowsHide:true});
if (compile.error || compile.status !== 0) process.exit(1);
console.log(`Syntax compiled: ${checked} JavaScript/JSON files, ${pythonFiles.length} Python files. No tests or model calls run.`);
