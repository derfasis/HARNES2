// Import to a new staging directory only; never replace the active partner database.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson } from '../business/config.mjs';
import { Store, TABLES, hash } from '../business/store.mjs';

const [source,destinationArg] = process.argv.slice(2);
if (!source || !destinationArg) throw new Error('Usage: npm run import -- export.json exports/restore-new');
const bundle = readJson(path.resolve(source)), destination = path.resolve(destinationArg);
const relative = path.relative(ROOT,destination);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Choose a new staging directory inside this project.');
if (fs.existsSync(destination)) throw new Error('Destination already exists. Choose a NEW directory.');
if (bundle.format !== 'digital-ai-partner' || bundle.schema_version !== 1 || !bundle.tables) throw new Error('Unsupported bundle');
if (Object.keys(bundle.tables).sort().join('|') !== [...TABLES].sort().join('|')) throw new Error('Bundle table list differs from this release');
if (hash(JSON.stringify(bundle.tables)) !== bundle.tables_sha256) throw new Error('Table checksum mismatch');
const migrations = fs.readdirSync(path.join(ROOT,'business/migrations')).filter(f=>f.endsWith('.sql')).sort();
if (!Array.isArray(bundle.migrations) || bundle.migrations.length !== migrations.length) throw new Error('Migration version differs');
for (const migration of bundle.migrations) {
  if (!migrations.includes(migration.version) || hash(fs.readFileSync(path.join(ROOT,'business/migrations',migration.version),'utf8')) !== migration.checksum) throw new Error('Migration checksum differs');
}
if (!Array.isArray(bundle.assets)) throw new Error('Missing partner assets');
const assetPaths = new Set();
for (const asset of bundle.assets) {
  if (typeof asset.path !== 'string' || !/^partner\/[a-zA-Z0-9_./-]+\.(md|json)$/.test(asset.path) || asset.path.split('/').some(x=>!x || x === '.' || x === '..') || assetPaths.has(asset.path)) throw new Error('Invalid or duplicate asset path');
  if (typeof asset.content !== 'string' || hash(asset.content) !== asset.sha256) throw new Error('Asset checksum mismatch');
  if (asset.path.endsWith('.json')) JSON.parse(asset.content);
  assetPaths.add(asset.path);
}
if (!assetPaths.has('partner/profile.json')) throw new Error('Missing partner profile');
for (const table of TABLES) if (!Array.isArray(bundle.tables[table])) throw new Error(`Invalid rows for ${table}`);
const store = new Store(path.join(destination,'data'));
try {
  store.transaction(()=>{
    for (const table of [...TABLES].reverse()) store.run(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      const columns = store.all(`PRAGMA table_info(${table})`).map(c=>c.name);
      const statement = store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
      for (const row of bundle.tables[table]) {
        if (!row || typeof row !== 'object' || Object.keys(row).sort().join('|') !== [...columns].sort().join('|')) throw new Error(`Unexpected columns in ${table}`);
        statement.run(...columns.map(c=>row[c]));
      }
    }
    if (store.all('PRAGMA foreign_key_check').length) throw new Error('Imported references are inconsistent');
  });
  for (const asset of bundle.assets) {
    const file = path.join(destination,asset.path);
    fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,asset.content,{flag:'wx'});
  }
  // Preserve the original interrupted/sending state until the next service startup recovers it.
  fs.writeFileSync(path.join(destination,'RESTORE-INFO.json'),JSON.stringify({source:path.resolve(source),exported_at:bundle.exported_at,created_at:new Date().toISOString(),status:'staged_not_activated'},null,2));
  console.log(`Restored to ${destination}. Active data was not changed. Follow README.md to activate after stopping the service.`);
} finally { store.close(); }
