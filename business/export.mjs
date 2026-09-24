import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { TABLES, hash } from './store.mjs';
import { now } from './errors.mjs';
import { sweepDiscovery } from './discovery.mjs';

export function exportPartner(store) {
  const assets = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir,entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (/\.(json|md)$/.test(entry.name)) {
        const content = fs.readFileSync(file,'utf8'); assets.push({ path: path.relative(ROOT,file).replaceAll('\\','/'), content, sha256: hash(content) });
      }
    }
  };
  walk(path.join(ROOT,'partner'));
  return store.transaction(() => {
    for(const partner of store.all('SELECT id FROM partners'))sweepDiscovery({store,config:{partnerId:partner.id}});
    const tables = Object.fromEntries(TABLES.map(table => [table, store.all(`SELECT * FROM ${table}`)]));
    return { format: 'digital-ai-partner', schema_version: 1, exported_at: now(),
      migrations: store.all('SELECT * FROM schema_migrations ORDER BY version'),
      tables, assets, tables_sha256: hash(JSON.stringify(tables)),
      excluded: ['secrets', 'runtime caches', 'virtual environment', 'upstream checkout', 'browser sessions'] };
  });
}
