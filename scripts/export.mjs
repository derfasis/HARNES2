import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA, loadConfig } from '../business/config.mjs';
import { Store } from '../business/store.mjs';
import { exportPartner } from '../business/export.mjs';

if (!fs.existsSync(path.join(DATA,'partner.sqlite'))) throw new Error('Start the project once to initialize its database.');
const config = loadConfig(), url = `http://127.0.0.1:${config.server.port}`;
let bundle;
try {
  const session = await fetch(`${url}/api/session`, {signal:AbortSignal.timeout(3000)});
  if (!session.ok) throw new Error('Unexpected local service response');
  const {token} = await session.json();
  const response = await fetch(`${url}/api/export`, {headers:{'x-partner-token':token},signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Export request failed');
  bundle = await response.json();
} catch (error) {
  // Only use offline access when no process is listening; do not mask live export errors.
  if (error.cause?.code !== 'ECONNREFUSED') throw error;
  const store = new Store();
  try { bundle = exportPartner(store); } finally { store.close(); }
}
if (bundle.format !== 'digital-ai-partner') throw new Error('Unexpected export format');
const destination = path.resolve(process.argv[2] ?? path.join(ROOT,'exports',`partner-${new Date().toISOString().replace(/[:.]/g,'-')}.json`));
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,JSON.stringify(bundle,null,2),{encoding:'utf8',flag:'wx'});
console.log(`Export saved: ${destination}`);
