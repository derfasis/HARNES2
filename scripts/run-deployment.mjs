#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDeployment, prepareDeployment } from '../business/deployment.mjs';

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function main(args = process.argv.slice(2)) {
  if (args.length === 2 && args[0] === '--inspect') {
    const inspected = inspectDeployment(path.resolve(args[1]));
    console.log(JSON.stringify({ status: 'verified', identity: inspected.identity }));
    return inspected;
  }
  const profileFile = args.length === 1 ? args[0] : null;
  if (!profileFile) throw Object.assign(new Error('DEPLOYMENT_PROFILE_REQUIRED'), { code: 'DEPLOYMENT_PROFILE_REQUIRED' });
  const prepared = await prepareDeployment(path.resolve(profileFile));
  console.log(JSON.stringify({ status: 'prepared', identity: prepared.identity }));
  const { start } = await import('../business/server.mjs');
  return start({ config: prepared.config, directory: prepared.directory, deployment: prepared });
}

if (invoked) main().catch(error => {
  const code = /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'DEPLOYMENT_START_FAILED';
  console.error(`Deployment start failed: ${code}`);
  process.exitCode = 1;
});

export { main };
