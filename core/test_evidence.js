// 证据链 v2 集成回归（审计 case-A 同方法论：真实 runTurn + 全桩注入，零 API 零费用）
// 断言的是「修复后」行为（审计的 check_agent_evidence.js 断言的是旧 bug，是缺陷演示）。
// 运行：node core/test_evidence.js
'use strict';
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const core = path.resolve(__dirname);
let queue = [], called = [], events = [];
function stub(name, exports) {
  const filename = require.resolve(path.join(core, name));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
let lastMessages = []; // 最近一次请求的消息（"注入类"修复要靠它断言，如自动复盘提示）
stub('providers', {
  chatStream: async (opts) => {
    if (opts && opts.messages) lastMessages = opts.messages;
    if (!queue.length) throw Object.assign(new Error('mock queue exhausted'), { status: 400 });
    return queue.shift();
  },
  keyFor: () => 'offline-placeholder', providerForModel: () => 'deepseek',
  resolveProvider: () => ({ name: 'offline', kind: 'openai' }), PROVIDERS: {},
});
stub('tools', {
  toOpenAITools: () => [], toAnthropicTools: () => [], READ_ONLY: [], TOOLS: [{ name: 'python_run' }],
  cap: x => typeof x === 'string' ? x : JSON.stringify(x),
  executeTool: (ctx, name, args) => toolsHook(ctx, name, args), // 动态分发：测试内可替换行为
});
let toolsHook = async (ctx, name, args) => { called.push({ name, args }); return { ok: true, data: 'hello' }; };
stub('skills', { loadSkill: () => { throw new Error('offline'); } });
stub('pricing', { costOf: () => 0 });
stub('external', { dayKey: () => 'offline', saveLedger: () => { throw new Error('must not persist'); } });

const { runTurn } = require(path.join(core, 'agent'));
const deps = {
  emit: e => events.push(e), stopper: { stop: false }, settings: {}, ledger: {},
  appDir: __dirname, sandbox: { root: __dirname }, abort: new AbortController(), children: new Set(), persist: () => {},
};
function session(id) {
  return { id, mode: 'math', model: 'offline', system_provider: 'deepseek', system: 'offline',
    messages: [], memory: [], usage: {}, runs: [], compute_runs: 0, unverifiedNumeric: true, decisions: [], data_epoch: 0 };
}
function tc(id, name, args) { return { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function run(s, responses, input) { queue = responses; called = []; events = []; await runTurn(s, deps, { text: input }); }

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', String(e.message).slice(0, 160)); } };
const os = require('os');
const stampRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-ev-')); // 沙箱根指向夹具：可实测代码改写→epoch
// 本套件此前从不清理它——TEMP 下的 xihe-ev-* 有 118 个，几乎全部出自这一行，是残留的大头。
// 挂 exit 而非照抄别处的"末尾 rmSync"：末尾那条走正常路径，而 process.exit(1) 的失败分支和
// 文件尾的顶层 catch 都够不着它，失败恰恰是夹具最容易被留下的场合。
process.on('exit', () => { try { fs.rmSync(stampRoot, { recursive: true, force: true }); } catch {} });
fs.writeFileSync(path.join(stampRoot, 'model.py'), 'x = 1\n');
const deps2 = { ...deps, sandbox: { root: stampRoot } };

(async () => {
  // 1) print("hello") 不能放行虚构 999（质询两次→持久化标注未验证）
  const a = session('unrelated');
  const claim = { content: '计算结果：最优烘干时间为 999 小时。' };
  await run(a, [tc('a', 'python_run', { code: 'print("hello")' }), claim, claim, claim]);
  t('P1a print(hello)后虚构999保持未验证', () => {
    assert.equal(a.compute_runs, 1);
    assert.equal(a.unverifiedNumeric, true, '虚构数值竟然被放行');
    assert.ok(events.some(e => e.t === 'warn' && /证据门禁/.test(e.msg)), '应有未验证告警');
  });
  t('P1a 质询消息已注入', () => {
    assert.ok(a.messages.some(m => m.role === 'user' && /证据门禁/.test(String(m.content)) && /999/.test(String(m.content))));
  });
  t('P1a 会话已留痕实际解析模型（模型胶囊显示用）', () => {
    assert.equal(a.resolved_model, 'offline');
    assert.equal(a.resolved_role, null); // 显式模型会话无角色标签
  });

  // 2) 证据绑数据版本非 LLM 名称（复审核心更正）：同 epoch 的旧运行（哪怕由 GLM 执行）
  //    可为 DeepSeek 会话的主张背书——数学输入没变，计算结果不因换审阅模型失效
  const b = session('cross-llm');
  b.runs = [{ run_id: 'run1', ok: true, tool: 'python_run', model: 'glm:glm-5.3', epoch: 0, out: '结果 57.169494 小时' }];
  b.evidenceChallenges = 0;
  await run(b, [{ content: '最优烘干时间为 57.17 小时。' }]);
  t('P1b 换审阅模型不使可信计算失效（证据绑epoch非LLM）', () => {
    assert.equal(b.unverifiedNumeric, false, '同数据版本的有效证据竟然被换模型失效');
    assert.equal(called.length, 0);
  });

  // 2b) python 运行期改写求解脚本（算法级）→ epoch 递增 → 旧证据过期（复审实测的缺口路径）
  // v2.3 改写：原内容带 def/import，rewrite 后 def 被删/改，结构指纹变 → 算算法级 → ++ epoch
  // （前版是简单 `x = 1` → `x = 2`，结构指纹都是空，被 P1-4 新规则判为"格式级"不 ++）
  fs.writeFileSync(path.join(stampRoot, 'model.py'), 'def calc(x):\n    return x * 2  # original\nimport math\n');
  const b2 = session('py-rewrite');
  b2.runs = [{ run_id: 'run1', ok: true, tool: 'python_run', model: 'deepseek:deepseek-flash', epoch: 0, out: '结果 57.169494 小时' }];
  b2.evidenceChallenges = 2; // 跳过质询直接看标注路径
  let rewriteDone = false;
  const origHook = toolsHook;
  toolsHook = async (ctx, name, args) => {
    called.push({ name, args });
    if (name === 'python_run' && !rewriteDone) {
      rewriteDone = true;
      fs.writeFileSync(path.join(stampRoot, 'model.py'), 'def calc(x):\n    return x * 3  # new formula\nimport math\n');
      return { ok: true, data: 'rewritten model.py (def/expr changed)' };
    }
    return { ok: true, data: 'hello' };
  };
  const depsRewrite = { ...deps, sandbox: { root: stampRoot } };
  queue = [tc('w', 'python_run', { code: 'open("model.py","w").write("# only a comment changed")' }), { content: '最优烘干时间为 57.17 小时。' }];
  called = []; events = [];
  await runTurn(b2, depsRewrite, { text: '改参数重算' });
  toolsHook = origHook;
  t('P1b2 python改写脚本→epoch递增→旧证据过期（算法级变更）', () => {
    assert.ok((b2.data_epoch || 0) >= 1, '运行期改写（def/expr 变）竟然没触发 epoch');
    assert.equal(b2.unverifiedNumeric, true, '改写后的旧证据竟然仍放行');
  });

  // 2b-cosmetic) python 改注释/格式 → 结构指纹不变 → 不 ++ epoch（P1-4 新行为）
  // 旧版会把所有文本变化都 ++ epoch，导致改个注释就重算（华数杯 2026 教训）
  fs.writeFileSync(path.join(stampRoot, 'model_cosmetic.py'), 'def calc(x):\n    return x * 2  # original\nimport math\n');
  const b2c = session('py-cosmetic');
  b2c.runs = [{ run_id: 'run1', ok: true, tool: 'python_run', model: 'deepseek:deepseek-flash', epoch: 0, out: '结果 57.169494 小时' }];
  b2c.evidenceChallenges = 2;
  let cosmeticDone = false;
  toolsHook = async (ctx, name, args) => {
    called.push({ name, args });
    if (name === 'python_run' && !cosmeticDone) {
      cosmeticDone = true;
      // 只改注释，def/import 都不动 → 结构指纹不变 → 判为格式级 → 不 ++ epoch
      fs.writeFileSync(path.join(stampRoot, 'model_cosmetic.py'), 'def calc(x):\n    return x * 2  # only a comment changed (whitespace OK)\nimport math\n');
      return { ok: true, data: 'rewritten model_cosmetic.py (comment only)' };
    }
    return { ok: true, data: 'hello' };
  };
  queue = [tc('w', 'python_run', { code: 'open("model_cosmetic.py","w").write("# only a comment")' }), { content: '最优烘干时间为 57.17 小时。' }];
  called = []; events = [];
  await runTurn(b2c, depsRewrite, { text: '改个注释' });
  toolsHook = origHook;
  t('P1b2b python仅改注释→epoch不递增（格式级，软门禁触发 warn 不 ++）', () => {
    assert.equal((b2c.data_epoch || 0), 0, '仅改注释结构指纹不变时不应该 ++ epoch，但实际=' + b2c.data_epoch);
    // 软门禁应发 warn 提示
    const sawFmtWarn = events.some(e => e.t === 'warn' && /格式级/.test(String(e.msg || '')));
    assert.ok(sawFmtWarn, '改注释应触发 [格式级] warn，实际事件: ' + JSON.stringify(events.filter(x => x.t === 'warn').map(x => x.msg)));
  });

  // 3) 运行编号在 200 条截断后不重复（含旧会话无 run_seq 的迁移）
  const c = session('ids');
  c.runs = Array.from({ length: 200 }, (_, i) => ({ run_id: 'run' + (i + 1) })); // 旧格式：无 run_seq
  await run(c, [tc('c1', 'python_run', { code: 'print(1)' }), tc('c2', 'python_run', { code: 'print(2)' }), { content: '结束' }]);
  t('P2 运行编号截断后不重复（旧会话迁移）', () => {
    const ids = c.runs.map(r => r.run_id);
    assert.notEqual(ids.at(-1), ids.at(-2), '又出现重复编号');
    assert.equal(new Set(ids).size, ids.length, '记录里仍有重复');
    assert.ok(/^run20[12]$/.test(ids.at(-1)), '迁移起点不对: ' + ids.at(-1));
  });

  // 4) 模糊回复（继续）不记为方案确认：状态 ambiguous + 注入提示；不依赖选择的工作仍可执行
  const d = session('ambiguous');
  d.pendingQuestion = { question: '采用哪种干密度假设？', options: ['固定干质量', '经验密度直接代入'] };
  await run(d, [tc('d', 'python_run', { code: 'print("dependent work")' }), { content: '结束' }], '继续');
  t('P1c 模糊回复记为ambiguous（不阻塞不确认）', () => {
    assert.equal(d.decisions.length, 1);
    assert.equal(d.decisions[0].status, 'ambiguous', '「继续」竟然被当成方案确认');
    assert.ok(d.messages.some(m => m.role === 'user' && /决策记录/.test(String(m.content))), '缺少ambiguous注入提示');
    assert.equal(called.length, 1, '不依赖选择的工作应可执行');
    assert.equal(d.pendingQuestion, null);
  });

  // 5) 成功写文件后本轮继续（复审 P1-1：旧版失效检测块访问未定义变量 a，写完即崩）
  const e = session('fs-continue');
  e.evidenceChallenges = 2;
  queue = [tc('e1', 'fs_write', { path: 'solver.py', content: 'print(1)' }), { content: '文件已写好，本轮结束。' }];
  called = []; events = [];
  await runTurn(e, deps2, { text: '写求解脚本' });
  t('P1-1 成功写文件后本轮正常继续（不再 a is not defined）', () => {
    assert.ok(!events.some(ev => ev.t === 'error' && /a is not defined|内部错误/.test(ev.msg || '')), '写文件后竟然报错: ' + JSON.stringify(events.filter(x => x.t === 'error')));
    assert.equal(e.status, 'idle', '会话状态未回落');
    assert.equal(called.length, 1, 'fs_write 应执行一次');
  });

  // 6) python 改写 CSV 输入 → epoch 递增 → 旧证据过期（复审 P1-2 实测缺口）
  const f = session('csv-rewrite');
  f.runs = [{ run_id: 'run1', ok: true, tool: 'python_run', model: 'deepseek:deepseek-flash', epoch: 0, out: '结果 57.169494 小时' }];
  f.evidenceChallenges = 2;
  let csvDone = false;
  const hookCsv = toolsHook;
  toolsHook = async (ctx, name, args) => {
    called.push({ name, args });
    if (name === 'python_run' && !csvDone) {
      csvDone = true;
      fs.writeFileSync(path.join(stampRoot, 'input.csv'), 'v\n9\n');
      return { ok: true, data: 'cleaned input.csv' };
    }
    return { ok: true, data: 'hello' };
  };
  queue = [tc('f1', 'python_run', { code: 'clean csv' }), { content: '最优时间为 57.17 小时。' }];
  called = []; events = [];
  await runTurn(f, deps2, { text: '清洗数据' });
  toolsHook = hookCsv;
  t('P1-2 python改写CSV→epoch递增→旧证据过期', () => {
    assert.ok((f.data_epoch || 0) >= 1, 'CSV 改写竟然没触发 epoch（复审缺口未修复）');
    assert.equal(f.unverifiedNumeric, true, '改数据后的旧证据竟然仍放行');
  });

  // 7) 失败公式修订 → epoch 递增（复审 P1-3：失败重登也要作废旧证据）
  const g = session('formula-rev-fail');
  g.formulas = [{ name: 'D(C)', expression: 'old', state: 'tests_passed', at: 1 }];
  g.runs = [{ run_id: 'run1', ok: true, tool: 'python_run', model: 'm', epoch: 0, out: '结果 57.169494 小时' }];
  g.evidenceChallenges = 2;
  const hookForm = toolsHook;
  toolsHook = async (ctx, name, args) => {
    called.push({ name, args });
    if (name === 'formula_register') return { ok: false, error: '公式已登记（状态: tests_failed）…✗不一致…\n[公式已修订] 与已登记版本不同：此前基于旧公式的运行结果已全部标记过期，受影响结论需重算。' };
    return { ok: true, data: 'hello' };
  };
  queue = [tc('g1', 'formula_register', { name: 'D(C)', expression: 'bad' }), { content: '最优时间为 57.17 小时。' }];
  called = []; events = [];
  await runTurn(g, deps2, { text: '修订公式' });
  toolsHook = hookForm;
  t('P1-3 失败公式修订→epoch递增→旧证据过期', () => {
    assert.ok((g.data_epoch || 0) >= 1, '失败修订竟然没作废旧证据');
    assert.equal(g.unverifiedNumeric, true, '失败修订后旧证据竟然仍放行');
  });

  // 8) uses_formulas 依赖失败公式 → 执行层拒绝（复审 P1-3：阻止依赖失败公式的正式求解）
  const h = session('formula-dep-block');
  h.formulas = [{ name: 'D(C)', expression: 'bad', state: 'tests_failed', at: 1 }];
  const hookDep = toolsHook;
  let depExecuted = false;
  toolsHook = async (ctx, name, args) => { called.push({ name, args }); if (name === 'python_run') depExecuted = true; return { ok: true, data: 'should not run' }; };
  queue = [tc('h1', 'python_run', { code: 'solve', uses_formulas: ['D(C)'] }), { content: '结束' }];
  called = []; events = [];
  await runTurn(h, deps2, { text: '求解' });
  toolsHook = hookDep;
  t('P1-3 依赖tests_failed公式的求解被执行层拒绝', () => {
    assert.equal(depExecuted, false, '依赖失败公式的 python_run 竟然真的执行了');
    assert.ok(h.messages.some(m => m.role === 'tool' && /tests_failed.*拒绝执行正式求解|拒绝执行正式求解/.test(String(m.content))), '缺少拒绝提示');
  });

  // 9) 运行期间修改已存在输入 → unstable → 输出不构成证据（复审：先读旧参数算完再改参数，不能按新版认证）
  const k = session('unstable-midrun');
  k.evidenceChallenges = 2;
  fs.writeFileSync(path.join(stampRoot, 'input.csv'), 'v\n1\n'); // 已存在输入（轮开始快照会采到）
  const hookUn = toolsHook;
  toolsHook = async (ctx, name, args) => {
    called.push({ name, args });
    if (name === 'python_run') {
      fs.writeFileSync(path.join(stampRoot, 'input.csv'), 'v\n2\n'); // 运行中改写已存在输入
      return { ok: true, data: 'answer = 42.5 mm' };
    }
    return { ok: true, data: 'hello' };
  };
  queue = [tc('k1', 'python_run', { code: 'read csv; write csv; answer' }), { content: '计算答案为 42.5 毫米。' }];
  called = []; events = [];
  await runTurn(k, deps2, { text: '读取参数计算' });
  toolsHook = hookUn;
  t('P-new 运行中改写已存在输入→unstable→输出不作证据', () => {
    const lastRun = (k.runs || []).at(-1);
    assert.equal(lastRun && lastRun.unstable, true, '运行中改写输入竟然没标 unstable');
    assert.equal(k.unverifiedNumeric, true, 'unstable 运行的输出竟然仍验证了主张');
    assert.ok(events.some(e => e.t === 'warn' && /不稳定|修改了已存在的输入/.test(e.msg || '')), '缺少 unstable 告警');
  });

  // 9b) 运行中只覆盖产出型文件（result*.xlsx / findings/*.json）→ 不判 unstable、不 bump epoch
  //     华数杯 C 题实战事故：会话 88594ddd7ed6 全部 42 个 python_run 因产出覆盖被误标
  //     unstable，question_graph commit 门禁全拒，Q1-Q4 全卡 reviewing。产出覆盖 ≠ 输入污染。
  const k2 = session('productive-overwrite');
  k2.evidenceChallenges = 2;
  const epBefore = k2.data_epoch || 0;
  const hookP = toolsHook;
  toolsHook = async (ctx, name, args) => {
    called.push({ name, args });
    if (name === 'python_run') {
      fs.writeFileSync(path.join(stampRoot, 'result_k2.xlsx'), 'fake-xlsx-bytes'); // 已存在路径的产出覆盖场景
      fs.mkdirSync(path.join(stampRoot, 'findings'), { recursive: true });
      fs.writeFileSync(path.join(stampRoot, 'findings', 'k2.json'), '{"a":1}');
      return { ok: true, data: 'answer = 42.5 mm' };
    }
    return { ok: true, data: 'hello' };
  };
  // 预置已存在的产出文件——覆盖写（而非新增）才是事故现场形态
  fs.writeFileSync(path.join(stampRoot, 'result_k2.xlsx'), 'old-bytes');
  queue = [tc('k2', 'python_run', { code: 'compute; overwrite result_k2.xlsx; write findings/k2.json' }), { content: '计算结果为 42.5。' }];
  called = []; events = [];
  await runTurn(k2, deps2, { text: '重算并覆盖结果表' });
  toolsHook = hookP;
  t('P-new 运行中只覆盖产出文件→不判 unstable、不 bump epoch（华数杯 C 题事故修复）', () => {
    const lastRun = (k2.runs || []).at(-1);
    assert.equal(lastRun && lastRun.unstable, false, '产出覆盖竟然被误标 unstable');
    assert.equal(k2.data_epoch || 0, epBefore, '产出覆盖竟然 bump 了 data_epoch');
    assert.equal(k2.unverifiedNumeric, false, '有效运行的输出竟然未构成证据');
  });

  // 10) 契约修订 → epoch 递增 → 旧证据过期（华数杯教训：几何对象改了就重算）
  const m = session('contract-revise');
  m.runs = [{ run_id: 'run1', ok: true, tool: 'python_run', model: 'm', epoch: 0, out: '结果 57.169494 h' }];
  m.evidenceChallenges = 2;
  const hookC = toolsHook;
  toolsHook = async (ctx, name, args) => {
    called.push({ name, args });
    if (name === 'contract_register') return { ok: true, data: '题目契约已登记（共 3 项）\n[契约已修订] 有条款内容变化：受影响的运行结果已标记过期，需重算。' };
    return { ok: true, data: 'hello' };
  };
  queue = [tc('m1', 'contract_register', { items: [{ kind: 'boundary', key: 'wrap_rule', text: '越界实体只保留与立方体交集', source: '题目第2页' }] }), { content: '最优时间为 57.17 小时。' }];
  called = []; events = [];
  await runTurn(m, deps2, { text: '修正边界规则' });
  toolsHook = hookC;
  t('P-new 契约修订→epoch递增→旧证据过期', () => {
    assert.ok((m.data_epoch || 0) >= 1, '契约修订竟然没作废旧证据');
    assert.equal(m.unverifiedNumeric, true, '契约修订后旧证据竟然仍放行');
    assert.ok(events.some(e => e.t === 'warn' && /契约已修订/.test(e.msg || '')), '缺少契约修订告警');
  });

  // 11) 原地打转检测：连续纯读/失败零产出的迭代应先警告后停轮
  // 关键：每次 python_run 参数必须不同（否则 LOOP_HARD 3 次相同签名先 loop_stop，
  // 轮不到 stall_stop；这正好对应了真实场景：模型换个措辞重试就能绕过签名去重，
  // 但「零产出」是打转的本质特征，stall 检测才是抓这类循环的真正防线）
  const stallHook = async (ctx, name, args) => { called.push({ name, args }); return { ok: false, error: '模拟持续失败' }; };
  const s = session('stall-loop');
  const hookStall = toolsHook;
  toolsHook = stallHook;
  queue = []; for (let i = 0; i < 40; i++) queue.push(tc('k' + i, 'python_run', { code: 'fake_' + i }));
  queue.push({ content: '收尾' });
  events = []; called = [];
  await runTurn(s, deps, { text: '模拟打转' });
  toolsHook = hookStall;
  t('P1-4 原地打转：连续失败零产出迭代触发 stall_stop（绕过签名去重的真防线）', () => {
    // 多层防护协作：TOOL_FAIL_HARD=3 先禁用工具（防同一工具反复撞墙），
    // 但禁用后 iterProductive 仍 false，stall_iter 继续累加，到 STALL_HARD=35 真正停轮。
    // 因此 calledCount ≈ 3（禁用阈值），但 stall_stop 事件必须发出——这才是测试对象。
    assert.ok(events.some(e => e.t === 'warn' && /原地打转/.test(e.msg || '')), '缺打转告警');
    assert.ok(events.some(e => e.t === 'done' && e.reason === 'stall_stop'), '未以 stall_stop 收尾（reason=' + (events.find(e => e.t === 'done') || {}).reason + '）');
    const calledCount = called.filter(c => c.name === 'python_run').length;
    assert.ok(calledCount >= 1 && calledCount <= 5, '应该 1-5 次（TOOL_FAIL_HARD=3 禁用阈值），called=' + calledCount);
    const stallWarn = s.messages.find(m => /进展检查/.test(String(m.content || '')));
    assert.ok(stallWarn, '缺 STALL_WARN 阶段提示');
    const stallStop = s.messages.find(m => /硬停止.*原地打转/.test(String(m.content || '')));
    assert.ok(stallStop, '缺 stall 停轮消息');
    // 迭代循环跑了远大于 3 次（禁用后仍继续，只是不再调工具），证明 stall 才是真停轮点
    const assistantCount = s.messages.filter(m => m.role === 'assistant').length;
    assert.ok(assistantCount >= 35, 'stall 应该到 STALL_HARD 才停，assistant iter=' + assistantCount);
  });

  // 12) 协作模式：全自动模式下 ask_user 不暂停，自动选「（推荐）」项并留痕；人机协同模式照常暂停
  const au = session('auto-mode');
  au.collab_mode = 'auto';
  const askArgs = { question: '问题一选哪条路线？', options: ['A 线性规划', 'B 贪心启发式（推荐）', 'C 遗传算法', 'D 强化学习', '自定义'] };
  await run(au, [tc('q1', 'ask_user', askArgs), { content: '【全流程完成】' }], '开工');
  t('P-auto 全自动：ask_user 自动选推荐项且不暂停', () => {
    assert.notEqual(au.status, 'waiting_input', '全自动竟然停下等用户');
    assert.equal(au.pendingQuestion, null);
    const d = au.decisions[au.decisions.length - 1];
    assert.equal(d.status, 'auto'); assert.equal(d.chosen_option, 'B 贪心启发式（推荐）');
    assert.ok(events.some(e => e.t === 'auto_decision'), '缺 auto_decision 事件');
    assert.ok(au.messages.some(m => m.role === 'tool' && /已自动选定推荐项/.test(String(m.content))));
  });
  const co = session('collab-mode');
  await run(co, [tc('q2', 'ask_user', askArgs)], '开工');
  t('P-collab 人机协同：ask_user 照常暂停等用户', () => {
    assert.equal(co.status, 'waiting_input');
    assert.equal(co.pendingQuestion.options.length, 5);
  });
  // 全自动：模型没做完就收尾 → 引擎续推；完成标记出现即停
  const au2 = session('auto-continue');
  au2.collab_mode = 'auto';
  au2.question_graph = [{ id: 1, status: 'drafting' }];
  await run(au2, [{ content: '先到这里。' }, { content: '【全流程完成】' }], '开工');
  t('P-auto 全自动：未完成收尾被续推一次，完成标记后停止', () => {
    assert.ok(au2.messages.some(m => /自动续推 1\//.test(String(m.content))), '缺续推消息');
    assert.ok(!au2.messages.some(m => /自动续推 2\//.test(String(m.content))), '完成后仍在续推');
  });
  // 人机协同比赛会话：同样续推（只在决策卡处停）；非比赛会话不续推
  const cc = session('collab-contest');
  cc.contest = true; cc.question_graph = [{ id: 1, status: 'drafting' }];
  await run(cc, [{ content: '先到这里。' }, { content: '【全流程完成】' }], '开工');
  t('协同比赛会话：未完成收尾也续推', () => {
    assert.ok(cc.messages.some(m => /自动续推 1\//.test(String(m.content))));
  });
  const lp = session('contest-loop');
  lp.contest = true; lp.question_graph = [{ id: 1, status: 'committed' }];
  const same = () => tc('L' + Math.random(), 'python_run', { code: 'print(1)' });
  await run(lp, [same(), same(), same(), { content: '【全流程完成】' }], '开工');
  t('比赛会话遇重复调用：拦截后换路续推，不停轮', () => {
    assert.ok(!events.some(e => e.t === 'done' && e.reason === 'loop_stop'), '比赛会话竟然 loop_stop 停轮');
    assert.ok(lp.messages.some(m => /换一条不同的路径继续推进/.test(String(m.content))));
  });
  const plain = session('plain-math');
  plain.question_graph = [{ id: 1, status: 'drafting' }];
  await run(plain, [{ content: '摘要已润色。' }], '只润色摘要');
  t('普通数模会话：不续推', () => {
    assert.ok(!plain.messages.some(m => /自动续推/.test(String(m.content))));
    assert.equal(plain.status, 'idle');
  });
  const { autoPick } = require(path.join(core, 'agent'));
  t('autoPick 无推荐标记取第一项、无选项返回 null', () => {
    assert.equal(autoPick(['甲', '乙']), '甲'); assert.equal(autoPick([]), null);
  });

  // 12b) T-3 回归：commit 写入的 impacts 条目缺 downstream（存量会话）不得让 stateBlock 崩
  const { stateBlock } = require(path.join(core, 'agent'));
  t('T-3 stateBlock 容忍缺 downstream 的 impacts 条目', () => {
    const sb = session('impacts');
    sb.contract = [{ kind: 'entity', text: 'x', source: 'p1' }];
    sb.question_impacts = [{ at: Date.now(), problem_id: 2, event: 'commit_pardoned_unstable_marks' }];
    assert.doesNotThrow(() => stateBlock(sb, __dirname));
  });

  // 13) 流程图规格校验（真实模块，不经桩）
  const fc = require(path.join(core, 'flowchart'));
  t('flowchart 规格：字多/行多被拒，合规通过且 XML 已转义', () => {
    assert.ok(fc.validate({ title: 'x', rows: [{ stage: '分析', boxes: ['这是一个特别特别特别长的节点标题文字'] }] }).some(e => /超 12 字/.test(e)));
    assert.ok(fc.validate({ title: 'x', rows: Array.from({ length: 7 }, () => ({ stage: 'a', boxes: ['b'] })) }).some(e => /> 6/.test(e)));
    const ok = { title: '问题一', rows: [{ stage: '分析', boxes: ['输入\n目标', '模型<选择>'] }] };
    assert.deepEqual(fc.validate(ok), []);
    const xml = fc.toDrawio(ok);
    assert.ok(/<mxfile/.test(xml) && !/value="[^"]*<选择/.test(xml), 'XML 未转义');
  });

  // ---------- v2.5 自动复盘：失败信号 → 下一轮强制表态（不自动写经验库）----------
  {
    const origHook = toolsHook;
    // 一轮内两个工具各失败一次 → 轮末应留下 pending_reflection
    toolsHook = async (ctx, name) => ({ ok: false, error: `${name} 故意失败：夹具` });
    const s = session('reflect-signal');
    await run(s, [tc('t1', 'fs_read', { path: 'nope.txt' }), tc('t2', 'fs_grep', { pattern: 'x' }), { content: '两个工具都失败了，我换个做法。' }]);
    t('自动复盘：一轮内多工具失败 → 留下复盘标记', () => {
      assert.ok(s.pending_reflection, '未留下 pending_reflection');
      assert.ok(/工具反复失败/.test(s.pending_reflection.reasons.join('、')), '原因不对: ' + JSON.stringify(s.pending_reflection.reasons));
      assert.ok(s.pending_reflection.toolFails.length >= 2, '未收集失败明细');
    });
    // 下一轮开头注入一次复盘提示，带出失败明细，并且读走即清
    toolsHook = async (ctx, name, args) => { called.push({ name, args }); return { ok: true, data: 'hello' }; };
    await run(s, [{ content: '已记教训。' }]);
    t('自动复盘：下一轮注入一次并读走即清', () => {
      const joined = lastMessages.map(m => String(m.content || '')).join('\n');
      assert.ok(/系统·自动复盘/.test(joined), '未注入复盘提示');
      assert.ok(/fs_read/.test(joined), '未带出失败工具明细');
      assert.ok(/lesson_record/.test(joined), '未指向 lesson_record');
      assert.equal(s.pending_reflection, null, '读走即清失败（会反复唠叨）');
    });
    await run(s, [{ content: '继续。' }]);
    t('自动复盘：不重复注入（无标记时不再出现）', () => {
      const joined = lastMessages.map(m => String(m.content || '')).join('\n');
      assert.ok(!/系统·自动复盘/.test(joined), '没有标记却仍注入了复盘提示');
    });
    // 单次失败/正常轮次不该触发（防唠叨）
    toolsHook = async (ctx, name) => (name === 'fs_read' ? { ok: false, error: '一次失败' } : { ok: true, data: 'ok' });
    const s2 = session('reflect-nop');
    await run(s2, [tc('u1', 'fs_read', { path: 'nope.txt' }), { content: '读不到，改用 fs_ls。' }]);
    t('自动复盘：单次失败不留标记（不唠叨）', () => {
      assert.equal(s2.pending_reflection || null, null, '单次失败不该触发复盘');
    });
    toolsHook = origHook;
  }

  // ---------- v2.5 审批门禁：完全访问 / 请求审批 ----------
  {
    const origHook = toolsHook;
    const runWithApprover = async (s, responses, input, approver) => {
      queue = responses; called = []; events = [];
      const d = { ...deps2, requestApproval: approver };
      await runTurn(s, d, { text: input });
    };
    // 1) 请求审批 + 拒绝 → 工具不执行，模型收到"未批准"结果
    toolsHook = async (ctx, name, args) => { called.push({ name, args }); return { ok: true, data: 'should not run' }; };
    const s1 = session('approval-deny');
    s1.approval = 'ask';
    const asked = [];
    await runWithApprover(s1, [tc('a1', 'fs_write', { path: 'x.txt', content: 'y' }), { content: '好的，我换只读方式核对。' }],
      '写个文件', async (req) => { asked.push(req.tool); return 'deny'; });
    t('审批：拒绝后工具未执行且模型收到未批准提示', () => {
      assert.deepEqual(asked, ['fs_write'], '没有发起审批: ' + JSON.stringify(asked));
      assert.equal(called.length, 0, '被拒的工具竟然执行了: ' + JSON.stringify(called.map(c => c.name)));
      const joined = s1.messages.map(m => String(m.content || '')).join('\n');
      assert.ok(/未批准|拒绝了这次执行/.test(joined), '模型没收到未批准提示');
    });
    // 2) 批准 → 执行；且下一次同类调用不再问（会话级记住"总是允许"）
    const s2 = session('approval-allow');
    s2.approval = 'ask';
    let askCount = 0;
    await runWithApprover(s2, [tc('b1', 'fs_write', { path: 'a.txt', content: '1' }), tc('b2', 'fs_write', { path: 'b.txt', content: '2' }), { content: 'done' }],
      '写两个文件', async () => { askCount++; return 'allow_session'; });
    t('审批：选「本会话总是允许」后同类工具不再问', () => {
      assert.equal(askCount, 1, '应只问一次，实际 ' + askCount);
      assert.equal(called.length, 2, '两次写都应执行');
      assert.ok(s2.approval_allow && s2.approval_allow.fs_write, '未记住会话级授权');
    });
    // 3) 完全访问 → 不弹卡
    const s3 = session('approval-full');
    s3.approval = 'full';
    let ask3 = 0;
    await runWithApprover(s3, [tc('c1', 'fs_write', { path: 'c.txt', content: '1' }), { content: 'ok' }],
      '写文件', async () => { ask3++; return 'deny'; });
    t('审批：完全访问不弹卡', () => {
      assert.equal(ask3, 0, '完全访问竟然弹了卡');
      assert.equal(called.length, 1, '完全访问应直接执行');
    });
    // 4) 只读工具永不弹卡（否则读文件都要点一下）
    const s4 = session('approval-readonly');
    s4.approval = 'ask';
    let ask4 = 0;
    await runWithApprover(s4, [tc('d1', 'fs_read', { path: 'x' }), { content: 'ok' }],
      '读文件', async () => { ask4++; return 'deny'; });
    t('审批：只读工具不弹卡', () => {
      assert.equal(ask4, 0, '只读工具被拦了: ' + ask4);
      assert.equal(called.length, 1, '只读工具应执行');
    });
    // 5) 无审批通道（无头）→ 降级完全访问并明确告警，绝不静默卡死
    const s5 = session('approval-nohost');
    s5.approval = 'ask';
    called = []; events = []; queue = [tc('e1', 'fs_write', { path: 'e.txt', content: '1' }), { content: 'ok' }];
    await runTurn(s5, deps2, { text: '写文件' });
    t('审批：无头环境降级为完全访问并告警（不卡死）', () => {
      assert.equal(called.length, 1, '无头环境应降级执行，实际执行 ' + called.length);
      assert.ok(events.some(e => e.t === 'warn' && /没有审批通道/.test(e.msg)), '未告警');
    });
    toolsHook = origHook;
  }

  // 主张提取的两个静默缺陷（都只在数学模式证据门禁里显形，改错也不会让别的测试红）：
  // ① 标识符尾数误报：stateBlock 把 run_id 交给模型引用，而 NUM_TOKEN_RE 无左边界，
  //    「（见 run1）」的 1 被当成裸数字主张 → 模型永远满足不了，反复吃证据门禁挑战。
  // ② 关键词门假阴性：只有名词类关键词时「下降 12.4%」整句被丢，该数的证据核验整个绕过。
  // 两者方向相反（一个多报一个漏报），必须各钉一条。
  {
    const { extractClaimNumbers } = require(path.join(core, 'agent'));
    const toks = s => extractClaimNumbers(s).map(c => c.token);
    t('主张提取：run_id/fig 标识符尾数不算数值主张', () => {
      assert.deepEqual(toks('最优方案为 4 台机组，总成本 123.4 万元（见 run1）。'), ['4', '123.4']);
      assert.deepEqual(toks('最优结果见 x3 与 fig2。'), []);
      assert.deepEqual(toks('最优目标 optimal_z1 取得。'), []);
    });
    t('主张提取：CJK 紧邻与单位后缀不受标识符守卫影响', () => {
      assert.deepEqual(toks('最优成本下降12.4%。'), ['12.4']);
      assert.deepEqual(toks('最优总成本 3.2 万元。'), ['3.2']);
      assert.deepEqual(toks('最优模型的 p值 0.04。'), ['0.04']);
    });
    t('关键词门：变化/统计类结论句进核验（不再是假阴性）', () => {
      assert.deepEqual(toks('含储能后峰值净购电下降 12.4%。'), ['12.4']);
      assert.deepEqual(toks('成本标准差 3.2 万元。'), ['3.2']);
    });
  }

  console.log(`\n=== EVIDENCE ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
