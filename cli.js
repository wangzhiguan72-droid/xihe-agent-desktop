// 羲和无头 CLI：node cli.js "任务" [--mode math|code|free] [--model deepseek-flash] [--max N]
// 无交互批任务用；ask_user 会暂停并提示换桌面端（CLI 不持久化会话，不能续接问答）
'use strict';
const path = require('path');
const { createSandbox } = require('./core/sandbox');
const { runTurn, buildSystem } = require('./core/agent');
const { loadLedger } = require('./core/external');
const { providerForModel } = require('./core/providers');

const APP_DIR = path.join(__dirname);
const WORKSPACE = require('./core/paths').WORKSPACE;

const args = process.argv.slice(2);
const task = args.find(a => !a.startsWith('--'));
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const mode = opt('mode', 'code');
const model = opt('model', null);
const hasFlag = (f) => args.includes('--' + f);

const settingsPath = path.join(APP_DIR, 'config', 'settings.json');
let cfg = {};
try { cfg = JSON.parse(require('fs').readFileSync(settingsPath, 'utf8')); } catch {}
const { DEFAULT_PRICES } = require('./core/pricing');
const settingsFull = { default_model: 'deepseek-flash', summarize_model: 'deepseek-flash', temperature: 0.6, daily_budget: 15, ctx_limit: 131072, reasoning_effort: 'on', efforts: { 'deepseek-flash': 'medium', 'deepseek-v4-pro': 'high' }, prices: { ...DEFAULT_PRICES, ...(cfg.prices || {}) }, vision_model: 'glm-5.3-flash', glm_base: 'https://open.bigmodel.cn/api/anthropic', chatgpt_quota: 30, ...cfg };

if (!task) { console.log('用法: node cli.js "任务描述" [--mode math|code|free] [--model deepseek-v4-pro]'); process.exit(0); }

const session = {
  id: 'cli', mode, model, title: task.slice(0, 24),
  system: buildSystem(mode, WORKSPACE, settingsFull, APP_DIR, providerForModel(model || settingsFull.default_model, settingsFull) || 'deepseek'),
  messages: [], todos: [], memory: [],
  usage: { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, calls: 0, cost: 0, vision_calls: 0 },
  pendingQuestion: null, status: 'running',
  decisions: [], runs: [], compute_runs: 0,
};
if (model) session.model = model;

const stopper = { stop: false };
const abort = new AbortController();
process.on('SIGINT', () => { stopper.stop = true; abort.abort(); });

const deps = {
  emit: (ev) => {
    switch (ev.t) {
      case 'delta': process.stdout.write(ev.s); break;
      case 'assistant_msg': console.log('\n——— 羲和 ———\n' + ev.content); break;
      case 'tool_start': console.log(`\n🛠 [${ev.name}] ${ev.args_preview.slice(0, 100).replace(/\s+/g, ' ')}`); break;
      case 'tool_end': console.log(`   ${ev.ok ? '✓' : '✗'} ${ev.ms}ms ${ev.result_preview.slice(0, 160).replace(/\s+/g, ' ')}`); break;
      case 'usage': { const u = ev.last; console.log(`   ₸ in=${u.prompt_tokens}(hit ${u.cache_hit_tokens}) out=${u.completion_tokens} 会话¥${session.usage.cost.toFixed(4)}`); break; }
      case 'warn': case 'compact': console.log('⚙ ' + ev.msg); break;
      case 'subagent': console.log(`🤖 子代理(${ev.profile}) ${ev.phase}`); break;
      case 'question': console.log(`\n❓ 提问: ${ev.question}\n   选项: ${(ev.options || []).join(' | ')}\n   （CLI 模式：本轮已暂停，请在桌面端回答，或重启 CLI 换一种问法）`); break;
      case 'error': console.error('\n[错误] ' + ev.msg); break;
      case 'done': console.log(`\n=== 结束(${ev.reason}) ===`); break;
    }
  },
  stopper, abort, settings: settingsFull, ledger: loadLedger(APP_DIR), appDir: APP_DIR,
  sandbox: createSandbox(APP_DIR),
  persist: () => {},
  children: new Set(),
};

runTurn(session, deps, { text: task }).then(() => {
  console.log(`\n总费用 ¥${session.usage.cost.toFixed(4)}，tokens in=${session.usage.prompt_tokens} out=${session.usage.completion_tokens} 缓存命中=${session.usage.cache_hit_tokens}`);
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
