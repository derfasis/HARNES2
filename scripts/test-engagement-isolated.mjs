// This runner is not the production regression suite. Only for dependency-limited
// environments: replaces the unrelated optional opportunity modules with throwing
// test mocks, not Ajv validation, permissions, SQLite, the scheduler or delivery.
import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--test','tests/engagement.test.mjs','tests/engagement-ui.test.mjs'],{
  cwd:new URL('../',import.meta.url),stdio:'inherit',env:{...process.env,HARNES_ENGAGEMENT_ISOLATED:'1'}
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
