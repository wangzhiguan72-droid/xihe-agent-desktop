'use strict';
// Uses the real server, agent and durable job runner against the authorized
// provider. No live calls occur unless --live is explicitly supplied.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), net = require('net');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
async function freePort() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
async function main() {
  if (!process.argv.includes('--live')) { console.log('Plan only: real server/job_start/job_wait/restart/resume; at most 8 model calls, 1024 output tokens per call. Add --live only with authorization.'); return; }
  const providers = require('../core/providers');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/settings.json'), 'utf8'));
  const pk = 'wanzhao-gpt', model = 'gpt-6-astra', provider = providers.resolveProvider(pk, config), key = providers.keyFor(pk, ROOT);
  if (!provider || !key) throw new Error('Selected model channel unavailable');
  const address = new URL(provider.base); if (address.username || address.password || address.search) throw new Error('Secret-bearing provider URL is not copied');
  const nonce = crypto.randomBytes(5).toString('hex'), pid = 'cache_scheduler_20261109_' + nonce;
  const audit = path.join(ROOT, 'audit', 'cache-scheduler-live-2026-11-09-' + nonce), app = path.join(audit, 'runtime', 'app');
  const project = path.resolve(ROOT, '..', 'workspace', 'projects', pid);
  fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(project, { recursive: true });
  for (const name of ['core', 'ui', 'contest_packages']) fs.cpSync(path.join(ROOT, name), path.join(app, name), { recursive: true,
    filter: file => !file.startsWith(path.join(ROOT, 'core', 'data')) });
  fs.cpSync(path.join(ROOT, 'skills', 'contest-modeling-generic'), path.join(app, 'skills', 'contest-modeling-generic'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(app, 'package.json'));
  const settings = { default_model: pk + ':' + model, default_mode: 'free', daily_budget: config.daily_budget,
    max_output_tokens: 1024, ctx_limit: 65536, kb_roots: [], prices: config.prices || {},
    custom_providers: [{ id: pk, name: 'Authorized live channel', base: provider.base, kind: provider.kind, models: [model] }],
    provider_models: { [pk]: [model] }, model_reasoning: { [pk + ':' + model]: 'low' }, decision_judge: { enabled: false } };
  write(path.join(app, 'config', 'settings.json'), settings);
  const ledgerFile = path.join(ROOT, 'data', 'ledger.json');
  const external = require('../core/external'), initialLedger = external.loadLedger(ROOT); external.saveLedger(app, initialLedger);
  write(path.join(project, 'project.json'), { id: pid, title: '真实调度缓存实践', createdAt: Date.now() });
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(project, 'data'), { recursive: true });
  fs.writeFileSync(path.join(project, 'data', 'input.csv'), 'value\n' + Array.from({ length: 128 }, (_, i) => i + 1).join('\n') + '\n');
  fs.writeFileSync(path.join(project, 'scripts', 'background.py'), [
    'import csv,json,time', 'from pathlib import Path',
    'with open("data/input.csv", encoding="utf-8") as f: values=[int(r["value"]) for r in csv.DictReader(f)]',
    'time.sleep(12)', 'out=Path("outputs");out.mkdir(exist_ok=True)',
    'count=Path("execution-count.txt");count.write_text(str(int(count.read_text())+1) if count.exists() else "1")',
    'result={"count":len(values),"sum":sum(values),"mean":sum(values)/len(values),"min":min(values),"max":max(values)}',
    '(out/"summary.json").write_text(json.dumps(result),encoding="utf-8")', 'print(json.dumps(result))',
  ].join('\n'));
  let server, token, port = await freePort(), sid = null, serverLog = '';
  const timeline = [], record = (stage, more = {}) => { timeline.push({ t: Date.now(), stage, ...more }); write(path.join(audit, 'timeline.json'), timeline); console.log(JSON.stringify({ stage, ...more })); };
  const clean = value => String(value).replaceAll(key, '[REDACTED]');
  const api = async (route, body) => { const r = await fetch('http://127.0.0.1:' + port + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json(); if (!r.ok) throw new Error('Local API status ' + r.status + ' for ' + route); return data; };
  const start = async () => {
    server = spawn(process.execPath, ['--require', path.join(ROOT, 'scripts/cache_scheduler_bootstrap.js'), 'core/server.js'], {
      cwd: app, windowsHide: true, env: { ...process.env, XIHE_PORT: String(port), XIHE_LIVE_SOURCE: ROOT,
        XIHE_LIVE_AUDIT: audit, XIHE_LIVE_PROVIDER: pk, XIHE_LIVE_MODEL: model,
        OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', NODE_OPTIONS: '--max-old-space-size=256' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', b => { serverLog += clean(b); }); server.stderr.on('data', b => { serverLog += clean(b); });
    for (let i = 0; i < 200; i++) {
      if (server.exitCode != null) throw new Error('Controlled server exited before startup');
      try { if ((await fetch('http://127.0.0.1:' + port + '/api/health')).ok) break; } catch {}
      await pause(100);
    }
    const html = await (await fetch('http://127.0.0.1:' + port + '/')).text(); token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(html)?.[1];
    if (!token) throw new Error('Local authentication token unavailable'); record('server_started');
  };
  const stop = async () => { if (server && server.exitCode == null) { const ended = new Promise(r => server.once('exit', r)); server.kill(); await ended; } server = null; record('server_stopped'); };
  const chat = async text => { const r = await fetch('http://127.0.0.1:' + port + '/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, body: JSON.stringify({ id: sid, text }) });
    if (!r.ok) throw new Error('Chat API rejected ' + r.status);
    const stream = clean(await r.text()); fs.appendFileSync(path.join(audit, 'events.sse'), stream + '\n'); return stream; };
  const info = { audit, project_id: pid, workspace: project, app, source_provider: pk, model, limits: { calls: 8, output_each: 1024, input: 250000 }, initial_day_costs: initialLedger.costs || {} };
  write(path.join(audit, 'run.json'), info);
  try {
    await start();
    await api('/api/project/new', { id: pid, title: '真实调度缓存实践', dir: project });
    const created = await api('/api/session/new', { mode: 'free', project_id: pid, title: '真实调度：后台计算、恢复与缓存核验' }); sid = created.id; info.session_id = sid; write(path.join(audit, 'run.json'), info);
    await api('/api/session/model', { id: sid, model: pk + ':' + model }); record('session_created', { session_id: sid, project_id: pid });
    const stream = await chat('这是已授权的普通小任务，不是赛事全流程。当前项目已提供 data/input.csv 和可信脚本 scripts/background.py。按顺序执行：①用 job_start 提交 command="python scripts/background.py"，retryable=false，max_attempts=1；②取得job_id后下一步用job_wait等待，禁止轮询；③自动恢复后读取 outputs/summary.json 和后台日志核对，写 findings/result.md，简短说明核验结果即结束。不调用子代理，不改脚本和输入，不做论文，不新增其它后台任务。');
    record('initial_turn_finished', { waiting_jobs: /waiting_jobs/.test(stream) });
    let current = await api('/api/session/open', { id: sid });
    if (current.status === 'waiting_jobs') { await stop(); await pause(1200); await start(); record('restart_recovery_requested'); }
    const startWait = Date.now();
    while (Date.now() - startWait < 240000) {
      current = await api('/api/session/open', { id: sid });
      const jobs = await api('/api/jobs?session_id=' + sid);
      if (current.last_error || current.pendingQuestion || ['needs_review', 'failed'].includes(current.job_wait?.status)) { record('needs_review', { reason: current.last_error?.reason || current.job_wait?.error || 'question' }); break; }
      if (current.status === 'idle' && jobs.jobs.some(j => j.status === 'succeeded') && fs.existsSync(path.join(project, 'findings/result.md'))) { record('task_complete', { job_status: jobs.jobs[0].status }); break; }
      await pause(1000);
    }
    const requests = JSON.parse(fs.readFileSync(path.join(audit, 'requests.json'), 'utf8'));
    if (current.status === 'idle' && !current.last_error && requests.length <= 6 && fs.existsSync(path.join(project, 'findings/result.md'))) {
      await chat('不要重新运行或提交作业。只读取 findings/result.md 与 outputs/summary.json 核对一致性，核验后简短回复并结束。'); record('followup_finished');
    }
    current = await api('/api/session/open', { id: sid }); const jobs = await api('/api/jobs?session_id=' + sid);
    const diagnostics = await api('/api/session/cache-diagnostics?session_id=' + sid);
    write(path.join(audit, 'session.json'), current); write(path.join(audit, 'jobs.json'), jobs); write(path.join(audit, 'diagnostics.json'), diagnostics);
    info.finished = Date.now(); info.status = current.status; info.job_wait = current.job_wait?.status || null;
    info.execution_count = fs.existsSync(path.join(project, 'execution-count.txt')) ? Number(fs.readFileSync(path.join(project, 'execution-count.txt'), 'utf8')) : 0;
    info.report_exists = fs.existsSync(path.join(project, 'findings/result.md')); write(path.join(audit, 'run.json'), info);
    record('finished', { status: info.status, executions: info.execution_count, report: info.report_exists });
    info.verified = current.status === 'idle' && !current.last_error && info.execution_count === 1 && info.report_exists
      && jobs.jobs.length === 1 && jobs.jobs[0].status === 'succeeded' && jobs.jobs[0].attempts === 1;
    write(path.join(audit, 'run.json'), info);
    if (!info.verified) process.exitCode = 1;
  } finally {
    await stop(); fs.writeFileSync(path.join(audit, 'server.log'), clean(serverLog));
    info.closed = Date.now(); write(path.join(audit, 'run.json'), info);
  }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: error.name || 'Error', detail: String(error.message || error).slice(0, 160) })); process.exitCode = 1; });
