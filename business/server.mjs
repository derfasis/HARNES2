import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { loadConfig, validateAllowedSourceRefs, validateTelegramSources, validateBrowserSources, ROOT, DATA, readJson, runtimeReadiness } from './config.mjs';
import { Store } from './store.mjs';
import { BusinessService } from './service.mjs';
import { invalidateRevokedDiscoverySources } from './discovery.mjs';
import { HermesAdapter } from './runtime.mjs';
import { Scheduler } from './scheduler.mjs';
import { TelegramChannel } from './channels/telegram.mjs';
import { MtprotoTelegramChannel } from './channels/telegram-mtproto.mjs';
import { BrowserSourceReader, browserPolicy } from './sources/browser-readonly.mjs';
import { toolDefinitions, callTool } from './tools.mjs';
import { exportPartner } from './export.mjs';
import { listCandidates } from './executive-donors.mjs';
import { AppError, ensure, requiredText } from './errors.mjs';

const publicFiles = new Map([['/', ['index.html','text/html; charset=utf-8']], ['/app.js',['app.js','text/javascript; charset=utf-8']], ['/research.js',['research.js','text/javascript; charset=utf-8']], ['/styles.css',['styles.css','text/css; charset=utf-8']], ['/favicon.svg',['favicon.svg','image/svg+xml']]]);
const validateCommand = new Ajv().compile(readJson(path.join(ROOT,'contracts/command.schema.json')));
const tokenEquals = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function readBody(req) {
  ensure(req.headers['content-type']?.split(';')[0] === 'application/json', 'Ожидается application/json', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; ensure(size <= 128 * 1024, 'Запрос слишком большой', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('Некорректный JSON'); }
}
const REASON_STATES_QUERY = new Set(['limit','cursor']);
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Only the two agreed query options exist. An unknown or repeated option is refused rather than
// ignored, so a dashboard can never believe it filtered something the server simply dropped.
function discoveryReasonStatesQuery(url, service) {
  const options = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    ensure(REASON_STATES_QUERY.has(name) && values.length === 1, 'Неизвестный параметр запроса', 400);
    if (name === 'limit') {
      ensure(/^[0-9]{1,3}$/.test(values[0]), 'Некорректный limit', 400);
      options.limit = Number(values[0]);
      ensure(options.limit >= 1 && options.limit <= 100, 'Некорректный limit', 400);
    } else {
      ensure(CURSOR_ID.test(values[0]), 'Некорректный cursor', 400);
      options.cursor = values[0];
    }
  }
  return service.discoveryReasonStates(options, { kind: 'operator' });
}
// One reader, used by both Discovery reads, so a duplicated or unknown option is refused
// identically instead of being ignored by one surface and rejected by the other.
const discoveryQueryOptions = url => {
  const options = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    ensure(REASON_STATES_QUERY.has(name) && values.length === 1, 'Неизвестный параметр запроса', 400);
    if (name === 'limit') {
      ensure(/^[0-9]{1,3}$/.test(values[0]), 'Некорректный limit', 400);
      options.limit = Number(values[0]);
      ensure(options.limit >= 1 && options.limit <= 100, 'Некорректный limit', 400);
    } else { ensure(CURSOR_ID.test(values[0]), 'Некорректный cursor', 400); options.cursor = values[0]; }
  }
  return options;
};
export async function start({ config = loadConfig(), directory = DATA } = {}) {
  ensure(config.server.host === '127.0.0.1', 'Only loopback dashboard binding is supported', 409);
  validateAllowedSourceRefs(config);
  validateTelegramSources(config);
  // Browser sources are validated here for the same reason the other two are: `start({ config })`
  // accepts a hand-built config, and only `loadConfig()` would have checked this list. Without
  // this call an invalid browser policy — one off the allowlist, or one whose reading interval
  // cannot honour its own freshness budget — reached the reader and only refused at the first
  // poll, which is a running service that looks configured and is not. Refuse before the port is
  // taken, the store is opened, and any reader exists.
  validateBrowserSources(config);
  const store = new Store(directory), service = new BusinessService(store,config);
  ensure(service.partner(), 'partnerId не совпадает с профилем', 500);
  const operatorToken = randomBytes(32).toString('hex'), mcpToken = randomBytes(32).toString('hex'), runTokens = new Map();
  const telegram = config.telegram.transport === 'mtproto' ? new MtprotoTelegramChannel(service) : new TelegramChannel(service);
  const runtime = new HermesAdapter(service,runTokens);
  // The scheduler polls whatever readers exist, and they arrive from two places on two timelines:
  // browser readers are built here, Telegram readers only once the channel has connected. The list
  // is composed rather than assigned, because assigning would drop the browser readers the moment
  // Telegram reported in — the same shape of bug as an empty reader list, only harder to notice,
  // because the source is simply never read and nothing anywhere says so.
  const browserReaders = (config.opportunity?.browserSources ?? [])
    .map((source) => ({ sourceId: source.sourceId,
      transport: new BrowserSourceReader(browserPolicy(service, source.sourceId)) }));
  let telegramReaders = [];
  const composeReaders = () => { scheduler.sourceReaders = [...telegramReaders, ...browserReaders]; };
  const scheduler = new Scheduler(service,runtime,telegram,[]);
  telegram.onSourcesReady = readers => { telegramReaders = readers ?? []; composeReaders(); };
  composeReaders();
  let shuttingDown = false;
  const server = http.createServer(async (req,res) => {
    const send = (code,value) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      ensure(!shuttingDown, 'Приложение завершает работу', 503);
      const hosts = [`127.0.0.1:${config.server.port}`,`localhost:${config.server.port}`];
      ensure(hosts.includes(req.headers.host), 'Недопустимый Host', 403);
      ensure(!req.headers.origin || hosts.map(h => `http://${h}`).includes(req.headers.origin), 'Недопустимый Origin', 403);
      ensure(!['cross-site'].includes(req.headers['sec-fetch-site']), 'Запрос с другого сайта запрещён', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && publicFiles.has(url.pathname)) {
        const [file,mime] = publicFiles.get(url.pathname); res.writeHead(200,{'Content-Type':mime}); return res.end(fs.readFileSync(path.join(ROOT,'public',file)));
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(200,{status:'running',version:'0.1.0',runtime_ready:runtimeReadiness(config).ready});
      if (req.method === 'GET' && url.pathname === '/api/session') return send(200,{token:operatorToken});
      if (url.pathname.startsWith('/internal/')) {
        const bearer = req.headers.authorization?.replace(/^Bearer /,'');
        const scope = tokenEquals(bearer,mcpToken) ? {kind:'agent',conversationId:null} : runTokens.get(bearer);
        ensure(scope && (!scope.expiresAt || scope.expiresAt > Date.now()), 'Недействительный токен инструмента', 403);
        if (req.method === 'GET' && url.pathname === '/internal/tools') return send(200,{tools:toolDefinitions(scope)});
        if (req.method === 'POST' && url.pathname === '/internal/tools/call') {
          const body = await readBody(req);
          requiredText(body.request_id,'request_id',150); requiredText(body.name,'name',100);
          return send(200,await callTool(service,scope,body.name,body.arguments ?? {},body.request_id));
        }
        return send(404,{error:'not found'});
      }
      ensure(tokenEquals(req.headers['x-partner-token'],operatorToken), 'Перезагрузите страницу для обновления сессии', 403);
      if (req.method === 'GET' && url.pathname.startsWith('/api/executive/')) {
        if (url.pathname === '/api/executive/candidates') {
          ensure([...url.searchParams.keys()].every(k => ['limit','cursor'].includes(k))
            && [...url.searchParams.keys()].every(k => url.searchParams.getAll(k).length === 1), 'Invalid candidate query', 400);
          return send(200, listCandidates(service, { limit: Number(url.searchParams.get('limit') ?? 20), cursor: url.searchParams.get('cursor') ?? '0' }));
        }
        if (url.pathname === '/api/executive/intents') {
          ensure([...url.searchParams.keys()].every(k => ['limit','cursor','thread_id'].includes(k))
            && [...url.searchParams.keys()].every(k => url.searchParams.getAll(k).length === 1), 'Invalid executive query', 400);
          return send(200, service.executive.list({ limit: Number(url.searchParams.get('limit') ?? 20),
            cursor: url.searchParams.get('cursor') ?? '', thread_id: url.searchParams.get('thread_id') }));
        }
        const match = /^\/api\/executive\/intents\/([^/]+)$/.exec(url.pathname);
        if (match) { ensure([...url.searchParams].length === 0, 'Invalid executive query', 400); return send(200, service.executive.detail(decodeURIComponent(match[1]))); }
        return send(404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/continuity/')) {
        if (url.pathname === '/api/continuity/threads') {
          ensure([...url.searchParams.keys()].every(k => ['limit','cursor'].includes(k))
            && [...url.searchParams.keys()].every(k => url.searchParams.getAll(k).length === 1), 'Invalid continuity query', 400);
          return send(200, service.continuity.list({ limit: Number(url.searchParams.get('limit') ?? 20), cursor: url.searchParams.get('cursor') ?? '' }));
        }
        if (url.pathname.startsWith('/api/continuity/turns/')) return send(200, service.continuity.turn(decodeURIComponent(url.pathname.split('/').at(-1))));
        if (url.pathname.startsWith('/api/continuity/threads/')) return send(200, service.continuity.detail(decodeURIComponent(url.pathname.split('/').at(-1))));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200,{...service.snapshot(),
        runtime:runtimeReadiness(config), scheduler:scheduler.status(), telegram:telegram.readiness(),
        capabilities:readJson(path.join(ROOT,'partner/capabilities.json')),
        knowledge:fs.readdirSync(path.join(ROOT,'partner/knowledge')).filter(f=>f.endsWith('.json')).map(f=>readJson(path.join(ROOT,'partner/knowledge',f))),
        configuration:{opportunity_automatic:config.opportunity.automatic===true,runtime_enabled:config.runtime.enabled,provider:config.runtime.provider,model:config.runtime.model,base_url:config.runtime.baseUrl, max_runs_per_day:config.runtime.maxRunsPerDay,daily_budget_usd:config.runtime.dailyBudgetUsd,timezone:config.scheduler.timezone},
        release:{version:'0.1.0-engagement-v1',tests:'see_docs_PERSISTENT_ENGAGEMENT_VALIDATION',model_validation:'controlled_disposable_smoke_pass'} });
      if (url.pathname.startsWith('/api/discovery/')) {
        // Drain the body before refusing, so the client sees 405 instead of a reset connection.
        if (req.method !== 'GET') { for await (const _ of req) { /* discard */ } return send(405,{error:'Метод не поддерживается',code:'method_not_allowed'}); }
        if (url.pathname === '/api/discovery/reason-states') return send(200,discoveryReasonStatesQuery(url,service));
        if (url.pathname === '/api/discovery/decisions') return send(200,service.discoveryDecisionQueue(discoveryQueryOptions(url), { kind: 'operator' }));
        return send(200,service.discoveryPresentationDetail(decodeURIComponent(url.pathname.split('/').at(-1)), { kind: 'operator' }));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/opportunity-captures/')) return send(200,service.opportunityCapture(decodeURIComponent(url.pathname.split('/').at(-1))));
      if (req.method === 'GET' && url.pathname === '/api/opportunities') return send(200,service.opportunityReviews({
        status:url.searchParams.get('status') ?? 'pending', limit:Number(url.searchParams.get('limit') ?? 50), offset:Number(url.searchParams.get('offset') ?? 0) }));
      if (req.method === 'GET' && url.pathname.startsWith('/api/opportunities/')) return send(200,service.opportunityDetail(decodeURIComponent(url.pathname.split('/').at(-1))));
      if (req.method === 'GET' && url.pathname.startsWith('/api/decisions/')) return send(200,service.engagement.episode(decodeURIComponent(url.pathname.split('/').at(-1))));
      if (req.method === 'GET' && url.pathname.startsWith('/api/conversations/')) return send(200,service.detail(decodeURIComponent(url.pathname.split('/').at(-1))));
      if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
        const run = store.get('SELECT * FROM runs WHERE id=? AND partner_id=?', url.pathname.split('/').at(-1),config.partnerId); ensure(run,'Запуск не найден',404);
        return send(200,{...run,context:JSON.parse(run.context_json),result:run.result_json ? JSON.parse(run.result_json) : null,tools:store.all('SELECT * FROM tool_calls WHERE run_id=? ORDER BY created_at',run.id)});
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        res.setHeader('Content-Disposition','attachment; filename="digital-ai-partner.json"'); return send(200,await service.exclusive(()=>exportPartner(store)));
      }
      if (req.method === 'POST' && url.pathname === '/api/commands') {
        const body = await readBody(req); ensure(validateCommand(body),'Неверная форма команды');
        const result = await service.command(body.action,body.payload,body.request_id);
        if (['person.stop','conversation.takeover','task.cancel'].includes(body.action)) {
          for (const run of store.all("SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.status='running' AND t.status='cancelled'")) scheduler.cancel(run.id);
        }
        return send(200,result);
      }
      if (req.method === 'POST' && url.pathname === '/api/deliver') {
        const body = await readBody(req); return send(200,await telegram.sendApproved(requiredText(body.draft_id,'draft_id',100)));
      }
      if (req.method === 'POST' && url.pathname === '/api/scheduler/wake') {
        const ready = runtimeReadiness(config); ensure(ready.ready,`Модель не подключена: ${ready.missing.join(', ')}`,409);
        // Both loops. A wake that only ran the source pass left the operator's "run it now" doing
        // nothing an operator could see, because the disposition they asked for comes from the
        // head, not the eyes.
        void scheduler.tick().catch(()=>{}); void scheduler.reasonTick().catch(()=>{}); return send(202,{accepted:true});
      }
      return send(404,{error:'not found'});
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      send(error instanceof AppError ? error.status : 500,{error:error instanceof AppError ? error.message : 'Операция не завершена. Проверьте журнал приложения.',code:error.code ?? 'internal_error'});
      if (!(error instanceof AppError)) console.error(`[business] ${error.name}: ${error.code ?? 'operation_failed'}`);
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  try { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.server.port,config.server.host,resolve);}); }
  catch (error) {store.close();throw error;}
  // Recovery occurs only after acquiring this server port; a duplicate launch cannot interrupt the live instance.
  store.recover();
  invalidateRevokedDiscoverySources(service);
  try { service.continuity.reconcile(); }
  catch { scheduler.continuityState = { disposition: 'reconciliation_failed' }; }
  try { service.executive.reconcile(); }
  catch { scheduler.executiveState = { disposition: 'reconciliation_failed' }; }
  fs.mkdirSync(path.join(directory,'runtime'),{recursive:true});
  fs.writeFileSync(path.join(directory,'runtime/mcp-connection.json'),JSON.stringify({url:`http://127.0.0.1:${config.server.port}`,token:mcpToken}),{mode:0o600});
  fs.writeFileSync(path.join(directory,'runtime/service.json'),JSON.stringify({pid:process.pid,port:config.server.port,started_at:new Date().toISOString()}));
  scheduler.start(); telegram.start();
  console.log(`Digital AI Partner: http://127.0.0.1:${config.server.port}`);
  console.log(`Hermes ${runtimeReadiness(config).ready ? 'enabled' : 'waiting for model configuration'}; Telegram ${config.telegram.enabled ? 'enabled' : 'disabled'}.`);
  const close = async () => {
    if (shuttingDown) return; shuttingDown=true; scheduler.stop();
    server.closeIdleConnections(); const closed = new Promise(resolve=>server.close(resolve));
    // The in-flight tick keeps running after stop(), and it is that tick that polls the readers.
    // Draining it before Telegram goes away is what keeps a reader from being released underneath
    // a read that is still using it.
    //
    // `reasonBusy` belongs in this wait for the same reason. Reasoning now runs on its own loop,
    // so a shutdown that drained only `busy` would close the store while a completion transaction
    // was still writing its receipt — the database disappearing from under a worker that is
    // committing to it, which is how a run ends as `interrupted` with the receipt half-written.
    // Both loops are drained here, and the store is closed after both are quiet.
    while (scheduler.busy || scheduler.reasonBusy || telegram.polling) await new Promise(resolve=>setTimeout(resolve,50));
    await closed; await telegram.stop(); store.close();
  };
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>close().then(()=>process.exit(0)));
  // The scheduler and the channel are returned so the wiring itself can be tested: a test that
  // copies this composition is a copy, and a copy stays green when the original is rewired.
  return {server,store,service,scheduler,telegram,close};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start().catch(error=>{console.error(`Startup failed: ${error.message}`);process.exitCode=1;});
