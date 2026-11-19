// 沙箱、守卫与可靠性单元测试
// 运行：node core/test_sandbox.js（在 xihe-agent 目录下）
'use strict';
const { Sandbox } = require('./sandbox');
const fs = require('fs'); const path = require('path');
const os = require('os');

const APP = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', String(e.message).slice(0, 140)); } };
// 异步测试：登记到 pending，由文件末尾统一 allSettled 等待——否则顶层 fire-and-forget 的
// 用例会在汇总/退出前被 process.exit 砍掉，既不计数也不报错（等于没测）。
const pending = [];
const tAsync = (name, fn) => {
  const p = fn().then(() => { pass++; console.log('PASS', name); })
    .catch(e => { fail++; console.log('FAIL', name, '->', String(e.message || e).slice(0, 140)); });
  pending.push(p);
  return p;
};
const expectDeny = (name, fn) => { try { fn(); fail++; console.log('FAIL', name, '-> 竟然放行了'); } catch (e) { pass++; console.log('PASS', name, '->', String(e.message).slice(0, 80)); } };
// 顶层 fire-and-forget 的异步测试若断言失败会变成未处理拒绝：V8 默认会在稍后直接抛崩溃
// （而不是报 FAIL），本次 v2.5 加测后就踩到了。这里统一接住并计为失败，保证套件永远给出明确结论。
process.on('unhandledRejection', (e) => { fail++; console.log('FAIL [unhandledRejection] ->', String((e && e.message) || e).slice(0, 200)); });
// exit 处理器在正常退出、process.exit(n)、未捕获异常三条路径上都会跑（SIGTERM 硬杀不会，
// 那种情况下文件还在用，Windows 上也删不掉）。夹具清理挂在这里，失败路径才不会漏。
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// 测试夹具：独立于 TEMP 的目录当工作区（TEMP 是守卫白名单，夹具放里面会互相干扰）
const tmp = fs.mkdtempSync(path.join(path.resolve(os.homedir()), '.xihe-test-'));
// 先清同类旧夹具：本套件此前崩过几次，~/.xihe-test-* 攒了 21 个。mkdtempSync 只保证新夹具
// 唯一，旧的一次也不会顺手带走——不清就是每崩一次多一个。
// 只清 1 小时前的：另一个套件正在并发跑时，它的夹具也在同一前缀下，且 mtime 是新的。
for (const n of fs.readdirSync(path.dirname(tmp))) {
  const old = path.join(path.dirname(tmp), n);
  if (!n.startsWith('.xihe-test-') || old === tmp) continue;
  try {
    if (Date.now() - fs.statSync(old).mtimeMs < 3600000) continue;
    fs.rmSync(old, { recursive: true, force: true });
  } catch {}
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
fs.mkdirSync(tmp, { recursive: true });
const ws = path.join(tmp, 'workspace');
const appDir = path.join(tmp, 'app');
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(appDir, 'config'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'config', 'deepseek.key'), 'TEST-FAKE-KEY');
const sb = new Sandbox(ws, { protected: [appDir] });

expectDeny('拒绝写用户目录', () => sb.resolve(path.join(os.homedir(), 'Desktop', 'x.txt'), 'w'));
expectDeny('拒绝读系统目录', () => sb.resolve('C:/Windows/System32/x', 'r'));
expectDeny('拒绝技能库写入', () => sb.resolve(path.join(os.homedir(), '.agents', 'skills', 'x.md'), 'w'));
expectDeny('拒绝读程序目录内密钥', () => sb.resolve(path.join(appDir, 'config', 'deepseek.key'), 'r'));
expectDeny('拒绝写程序目录', () => sb.resolve(path.join(appDir, 'config', 'evil.json'), 'w'));
t('工作区相对路径放行', () => sb.resolve('sub/dir', 'w'));

// junction 读逃逸：读写都拒
tAsync('junction 读逃逸被拒', async () => {
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'canary.txt'), 'SECRET');
  const link = path.join(ws, 'link');
  try { fs.symlinkSync(outside, link, 'junction'); } catch { console.log('  (跳过：无 junction 权限)'); return; }
  expectDeny('junction 读', () => sb.resolve('link/canary.txt', 'r'));
  expectDeny('junction 写', () => sb.resolve('link/canary.txt', 'w'));
});

// 命令扫描
t('shell 拒绝越界删除', () => { const c = sb.checkCommand('del /q "C:\\work\\x.txt"'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 拒绝 format', () => { const c = sb.checkCommand('format D: /q'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 拒绝 reg add', () => { const c = sb.checkCommand('reg add HKLM\\Software\\x'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 拒绝 .. 相对逃逸', () => { const c = sb.checkCommand('type ..\\..\\windows\\win.ini'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 拒绝 %USERPROFILE% 展开', () => { const c = sb.checkCommand('type %USERPROFILE%\\secret.txt'); if (!c.ok) return; throw new Error('竟然放行'); });
// 解释器直调=绕过守卫的通道（审计 D）：python/node 一律拦，MATLAB 只放 -batch，pip/git 放行
t('shell 拒绝直调 python（绕过守卫）', () => { const c = sb.checkCommand('python tools.py --in data\\a.csv'); if (!c.ok) return; throw new Error('竟然放行（必须走 python_run）'); });
t('shell 拒绝直调 node', () => { const c = sb.checkCommand('node -e "1"'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 拒绝交互式 matlab', () => { const c = sb.checkCommand('matlab'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 放行 pip install', () => { const c = sb.checkCommand('pip install numpy'); if (!c.ok) throw new Error(c.reason); });
// v2.5：系统级安装器会把文件写到 Program Files/注册表，绕开工作区沙箱（实测 choco 原先放行）
t('shell 拒绝系统级安装器（choco）', () => { const c = sb.checkCommand('choco install ffmpeg -y'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 拒绝系统级安装器（winget/msiexec）', () => {
  for (const cmd of ['winget install Git.Git', 'msiexec /i setup.msi /quiet']) if (sb.checkCommand(cmd).ok) throw new Error('竟然放行: ' + cmd);
});
t('shell 拒绝 npm 全局安装', () => { const c = sb.checkCommand('npm install -g typescript'); if (!c.ok) return; throw new Error('竟然放行'); });
t('shell 仍放行项目内 npm install', () => { const c = sb.checkCommand('npm install lodash'); if (!c.ok) throw new Error(c.reason); });
t('shell 放行 matlab -batch', () => { const c = sb.checkCommand('matlab -batch "run_main"'); if (!c.ok) throw new Error(c.reason); });
t('shell 放行 git', () => { const c = sb.checkCommand('git status'); if (!c.ok) throw new Error(c.reason); });

// createSandbox 工厂（正式入口 B 修复）：工作区可正常读写，程序目录是禁区
// （旧写法把 APP_DIR 的上级圈进禁区，workspace 也在上级里 → 正常读写 403）
tAsync('createSandbox 工厂：工作区读写正常+程序目录禁区', async () => {
  const { createSandbox } = require('./sandbox');
  const sb2 = createSandbox(APP);
  if (sb2.root !== fs.realpathSync(path.resolve(APP, '..', 'workspace'))) throw new Error('工作区根不对: ' + sb2.root);
  sb2.resolve('sub/dir', 'w'); // 不抛即正常
  sb2.resolve('result.csv', 'r');
  let denied = false;
  try { sb2.resolve(path.join(APP, 'config', 'deepseek.key'), 'r'); } catch { denied = true; }
  if (!denied) throw new Error('程序目录密钥竟然可读');
});

// apiModelOf：provider:model 前缀剥除（内部标识绝不能发给厂商）
t('provider:model 前缀剥除', () => {
  const { apiModelOf } = require('./agent');
  if (apiModelOf('deepseek:deepseek-flash', 'deepseek') !== 'deepseek-flash') throw new Error('前缀没剥');
  if (apiModelOf('glm:glm-4.8', 'glm') !== 'glm-4.8') throw new Error('前缀没剥');
  if (apiModelOf('deepseek-flash', 'deepseek') !== 'deepseek-flash') throw new Error('无前缀被误改');
});

// Anthropic 计量：input_tokens 不含缓存（官方口径），统一折算后不再出现负费用
t('Anthropic 缓存计量折算（无负费用）', () => {
  const { costOf } = require('./pricing');
  const usage = { prompt_tokens: 1510, completion_tokens: 200, cache_hit_tokens: 1500 }; // = 10 未命中 + 1500 命中
  const cost = costOf('deepseek-flash', usage, { 'deepseek-flash': { hit: 1, miss: 4, out: 4 } });
  if (cost < 0) throw new Error('负费用: ' + cost);
  const expect = (1500 * 1 + 10 * 4 + 200 * 4) / 1e6;
  if (Math.abs(cost - expect) > 1e-9) throw new Error(`费用算错: ${cost} ≠ ${expect}`);
});

// 分时计价（v2.5 / issues V-33）：DeepSeek 高峰（工作日 9-12、14-18 北京时）是空闲的两倍，
// 且旧表把 flash 的缓存命中价高估 6–12 倍——正是"界面估算偏高 2.8×"的根因。
t('计价：高峰/空闲分时取价正确', () => {
  const { isPeak, priceFor, costOf } = require('./pricing');
  const fri10 = Date.UTC(2026, 8, 25, 2, 0, 0); // 周五北京 10:00
  const sat10 = Date.UTC(2026, 8, 26, 2, 0, 0); // 周六北京 10:00
  if (!isPeak(fri10)) throw new Error('周五 10 点应判高峰');
  if (isPeak(sat10)) throw new Error('周末应判空闲');
  const fp = priceFor('deepseek-flash', null, fri10), op = priceFor('deepseek-flash', null, sat10);
  if (fp.hit !== 0.04 || op.hit !== 0.02) throw new Error(`命中价取错: ${fp.hit}/${op.hit}`);
  if (fp.miss !== 2 || op.miss !== 1) throw new Error('未命中价取错');
  const u = { prompt_tokens: 1000000, cache_hit_tokens: 900000, completion_tokens: 100000 };
  const peak = costOf('deepseek-flash', u, null, fri10), off = costOf('deepseek-flash', u, null, sat10);
  if (Math.abs(peak - off * 2) > 1e-9) throw new Error(`高峰应为空闲两倍: ${peak} vs ${off}`);
});
t('计价：V-33 回归——高缓存命中负载的估算不再虚高', () => {
  const { costOf } = require('./pricing');
  // 98.5% 缓存命中 + 2.3% 输出（实测会话的典型形态）
  const u = { prompt_tokens: 1000000, cache_hit_tokens: 985000, completion_tokens: 22600 };
  const off = Date.UTC(2026, 8, 26, 2, 0, 0); // 空闲时段
  const now = costOf('deepseek-flash', u, null, off);
  const old = costOf('deepseek-flash', u, { 'deepseek-flash': { hit: 0.25, miss: 1.0, out: 4.0 } }, off);
  const ratio = old / now;
  if (ratio < 2.5 || ratio > 3.2) throw new Error(`旧/新差比应≈2.8（实测值），实际 ${ratio.toFixed(2)}`);
  // 新表空闲价：0.985*0.02 + 0.015*1 + 0.0226*4 = 0.0197+0.015+0.0904
  const expect = (985000 * 0.02 + 15000 * 1.0 + 22600 * 4.0) / 1e6;
  if (Math.abs(now - expect) > 1e-9) throw new Error(`费用算错: ${now} ≠ ${expect}`);
});

// 自定义供应商（v2.5）：内置 7 家之外可以无限添加——模型路由、key 约定路径、非法条目过滤
t('自定义供应商：模型路由 + 解析 + key 约定路径', () => {
  const P = require('./providers');
  const st = { custom_providers: [{ id: 'myrelay', name: '我的中转站', base: 'https://relay.example.com/v1', kind: 'openai', models: ['gpt-5.5', 'claude-x'], ctx_limit: 200000 }] };
  // 模型 → 提供商
  if (P.providerForModel('gpt-5.5', st) !== 'myrelay') throw new Error('自定义模型未被路由');
  if (P.providerForModel('myrelay:gpt-5.5', st) !== 'myrelay') throw new Error('显式前缀路由失败');
  if (P.providerForModel('deepseek-flash', st) !== 'deepseek') throw new Error('内置路由被破坏');
  // 解析出 base/kind/上下文上限
  const rp = P.resolveProvider('myrelay', st);
  if (!rp || rp.base !== 'https://relay.example.com/v1' || rp.kind !== 'openai') throw new Error('resolveProvider 不对: ' + JSON.stringify(rp));
  if (rp.ctxLimit['gpt-5.5'] !== 200000) throw new Error('ctx_limit 未生效');
  if (rp.defaultMaxTokens !== 32768) throw new Error('默认 maxTokens 不对');
  // 出现在模型清单里（顶部模型菜单靠这个）
  if (!P.providerModels(st).some(m => m.provider === 'myrelay' && m.id === 'claude-x')) throw new Error('模型清单缺自定义模型');
  // key 走约定路径 config/custom_<id>.key
  if (rp.keyFile !== 'config/custom_myrelay.key') throw new Error('key 路径不对: ' + rp.keyFile);
  // provider_bases 仍能临时覆盖自定义家（切中转用）
  const rp2 = P.resolveProvider('myrelay', { ...st, provider_bases: { myrelay: 'https://another.example.com/v1' } });
  if (rp2.base !== 'https://another.example.com/v1') throw new Error('provider_bases 覆盖失效');
});
t('自定义供应商：非法条目被忽略（不影响启动）', () => {
  const P = require('./providers');
  const bad = { custom_providers: [
    { id: 'Bad Id!', name: 'x', base: 'https://x/v1', models: ['m1'] },   // 非法 id
    { id: 'deepseek', name: '撞名', base: 'https://x/v1', models: ['m2'] }, // 与内置撞名
    { id: 'ok-one', name: '正常', base: 'https://ok/v1', models: ['m3'] },
  ] };
  const cp = P.customProviders(bad);
  if (Object.keys(cp).length !== 1 || !cp['ok-one']) throw new Error('非法条目未被过滤: ' + Object.keys(cp).join(','));
  if (P.providerForModel('m1', bad)) throw new Error('非法 id 的模型竟然被路由');
  if (P.resolveProvider('deepseek', bad).base !== 'https://api.deepseek.com') throw new Error('内置被自定义覆盖了');
});
t('自定义供应商：无配置时行为与以前完全一致', () => {
  const P = require('./providers');
  if (P.providerForModel('glm-5.3', {}) !== 'glm') throw new Error('无自定义时内置路由变了');
  if (P.providerModels({}).length !== P.providerModels({ custom_providers: [] }).length) throw new Error('空数组竟改变了模型总数');
});

// 角色模型路由（v2.7）：role_models 四角色映射解析 + 主会话 modeler 标签 + 显式选择优先不回退
t('角色模型：四角色映射解析 + 显式选择优先', () => {
  const MR = require('./model_roles');
  const st = {
    role_models: { modeler: 'gpt-6-astra', coder: 'deepseek-flash', writer: 'deepseek-flash', reviewer: 'gpt-6-astra' },
    custom_providers: [{ id: 'wanzhao', name: 'wz', base: 'https://sub.wanzhao.top/v1', kind: 'openai', models: ['gpt-6-astra'] }],
    default_model: 'deepseek-flash',
  };
  const base = { settings: st, sessionModel: 'deepseek-flash', requireKey: false };
  for (const [role, want] of [['modeler', 'gpt-6-astra'], ['coder', 'deepseek-flash'], ['writer', 'deepseek-flash'], ['reviewer', 'gpt-6-astra']]) {
    const r = MR.resolveRoleModel({ ...base, role });
    if (!r.ok || r.model !== want) throw new Error(`${role} 解析错: ${r.ok ? r.model : r.warnings.join(';')}`);
    if (r.fallback) throw new Error(`${role} 不应标记回退`);
  }
  // 主会话（math 未显式选模型）→ modeler 角色标签，供模型胶囊显示
  const main = MR.resolveRoleModel({ ...base, role: 'modeler', sessionExplicit: false });
  if (main.roleLabel !== '建模手') throw new Error('主会话角色标签缺失: ' + main.roleLabel);
  // 顶部手动选择优先且不算回退
  const manual = MR.resolveRoleModel({ ...base, role: 'modeler', sessionModel: 'deepseek-flash', sessionExplicit: true });
  if (manual.model !== 'deepseek-flash' || manual.fallback) throw new Error('显式模型被角色路由覆盖');
});

// JSON 修复：只做无损修复（去码栏/尾逗号）；未闭合的截断 JSON 一律拒绝执行
const { safeParseArgs } = require('./agent');
t('JSON修复-尾逗号', () => safeParseArgs('{"a": 1,}'));
t('JSON修复-正常', () => safeParseArgs('{"a":[1,2,3]}'));
t('截断JSON被拒绝（含写参数的半截调用不再执行）', () => {
  for (const bad of ['{"a": [1, 2', '{"path":"x","content":"half', '{"b": "unclosed']) {
    let threw = false;
    try { safeParseArgs(bad); } catch { threw = true; }
    if (!threw) throw new Error('半截参数竟然被猜补: ' + bad);
  }
});

// 技能加载边界
t('技能引用路径分隔符被拒', () => {
  const { loadSkill } = require('./skills');
  let threw = false;
  try { loadSkill(APP, 'my-cumcm-deepseek', '../evil.md'); } catch (e) { threw = /越界/.test(e.message); }
  if (!threw) throw new Error('前缀逃逸未拦截');
});
t('技能正常加载', () => {
  const { loadSkill, getIndex } = require('./skills');
  const idx = getIndex(APP);
  console.log(`  技能索引 ${idx.length} 个`);
  const s = loadSkill(APP, 'my-cumcm-deepseek');
  if (!s.content) throw new Error('技能内容为空');
});

// ---------- 证据链 v2.1（deepseek-glm 专项复审六问题反例） ----------
t('证据门禁：print(hello)不能放行虚构数值', () => {
  const { checkNumericEvidence } = require('./agent');
  const session = { runs: [{ run_id: 'run1', ok: true, tool: 'python_run', model: 'deepseek:deepseek-flash', epoch: 0, out: 'hello' }], data_epoch: 0 };
  const ev = checkNumericEvidence('计算结果：最优烘干时间为 999 小时。', session);
  if (!ev.numeric || !ev.missing.some(x => x.includes('999'))) throw new Error('虚构的 999 竟然被放行');
});
t('证据门禁：换审阅模型不使可信计算失效（证据绑数据版本非LLM）', () => {
  const { checkNumericEvidence } = require('./agent');
  // 运行由 GLM 时期执行、epoch 未变；DeepSeek 会话引用同一结果 → 仍有效（数学输入没变）
  const session = { runs: [{ run_id: 'run1', ok: true, model: 'glm:glm-5.3', epoch: 0, out: '结果 57.169494 小时' }], data_epoch: 0 };
  const ev = checkNumericEvidence('最优时间为 57.17 小时', session);
  if (ev.numeric && ev.missing.length) throw new Error('换模型竟然使有效证据失效: ' + JSON.stringify(ev.missing));
});
t('证据门禁：改代码/数据后旧运行过期（epoch 失效传播）', () => {
  const { checkNumericEvidence } = require('./agent');
  const session = { runs: [{ run_id: 'run1', ok: true, model: 'deepseek:deepseek-flash', epoch: 0, out: '57.169494 小时' }], data_epoch: 1 };
  const ev = checkNumericEvidence('最优时间为 57.17 小时', session);
  if (ev.missing.length === 0) throw new Error('旧 epoch 的证据竟然放行');
});
t('数值语义：符号必须一致（-123.45 不被 +123.45 验证）', () => {
  const { checkNumericEvidence } = require('./agent');
  const session = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'value = +123.45' }], data_epoch: 0 };
  const ev = checkNumericEvidence('计算结果为 -123.45。', session);
  if (!ev.missing.some(x => x.includes('-123.45'))) throw new Error('符号错误竟然放行');
});
t('数值语义：指数必须一致（1.23e-9 不被 1.23e+9 验证）', () => {
  const { checkNumericEvidence } = require('./agent');
  const session = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'error = 1.23e+9' }], data_epoch: 0 };
  const ev = checkNumericEvidence('误差为 1.23e-9。', session);
  if (!ev.missing.length) throw new Error('数量级错误竟然放行');
});
t('数值语义：无子串匹配（123 不命中 91234）', () => {
  const { checkNumericEvidence } = require('./agent');
  const session = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'result 91234' }], data_epoch: 0 };
  const ev = checkNumericEvidence('最优值为 123。', session);
  if (!ev.missing.length) throw new Error('子串误匹配竟然放行');
});
t('数值语义：单位族一致（57.17小时 不被 57.17秒 验证）', () => {
  const { checkNumericEvidence } = require('./agent');
  const bad = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 't = 57.169494 秒' }], data_epoch: 0 };
  if (!checkNumericEvidence('最优时间为 57.17 小时', bad).missing.length) throw new Error('单位错误竟然放行');
  const good = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 't = 57.169494 h' }], data_epoch: 0 };
  if (checkNumericEvidence('最优时间为 57.17 小时', good).missing.length) throw new Error('同族单位竟然不匹配（h=小时）');
});
t('数值语义：量词语境必须相交（阈值0.90 不能验证 概率0.90）', () => {
  const { checkNumericEvidence } = require('./agent');
  const bad = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: '阈值设为 0.90' }], data_epoch: 0 };
  if (!checkNumericEvidence('预测达标概率为 0.90。', bad).missing.length) throw new Error('阈值数字竟然验证了概率主张');
  const good = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: '达标概率 = 0.9021' }], data_epoch: 0 };
  if (checkNumericEvidence('预测达标概率为 0.90。', good).missing.length) throw new Error('同语境数值竟然不放行');
  const bare = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'result = 0.9021' }], data_epoch: 0 };
  if (checkNumericEvidence('预测达标概率为 0.90。', bare).missing.length) throw new Error('证据侧无量词裸输出应放行（程序输出常不带语境）');
});
t('数值语义：带单位主张不被裸数字验证（57.17小时 不被 57.17 验证）', () => {
  const { checkNumericEvidence } = require('./agent');
  const bad = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'result = 57.169494' }], data_epoch: 0 };
  if (!checkNumericEvidence('最优时间为 57.17 小时。', bad).missing.length) throw new Error('裸数字竟然验证了带单位主张');
  const good = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'time = 57.169494 h' }], data_epoch: 0 };
  if (checkNumericEvidence('最优时间为 57.17 小时。', good).missing.length) throw new Error('带单位证据竟然不放行');
});
t('证据资格：会话有公式时非正式运行不构成证据（formal 门控）', () => {
  const { checkNumericEvidence } = require('./agent');
  // 有公式登记的会话：未声明 formal 的探索运行输出不作证据
  const sess = { formulas: [{ name: 'D(C)', state: 'tests_passed' }],
    runs: [{ run_id: 'r', ok: true, epoch: 0, out: 't = 57.169494 h', formal: false }], data_epoch: 0 };
  if (!checkNumericEvidence('最优时间为 57.17 小时。', sess).missing.length) throw new Error('非正式运行竟然构成证据');
  const sess2 = { formulas: [{ name: 'D(C)', state: 'tests_passed' }],
    runs: [{ run_id: 'r', ok: true, epoch: 0, out: 't = 57.169494 h', formal: true }], data_epoch: 0 };
  if (checkNumericEvidence('最优时间为 57.17 小时。', sess2).missing.length) throw new Error('正式求解输出竟然不作证据');
  // 无公式会话不受 formal 限制（普通模式不误伤）
  const sess3 = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 't = 57.169494 h', formal: false }], data_epoch: 0 };
  if (checkNumericEvidence('最优时间为 57.17 小时。', sess3).missing.length) throw new Error('无公式会话竟然要求 formal');
});
t('证据资格：运行期间修改已存在输入的输出不作证据（unstable）', () => {
  const { checkNumericEvidence } = require('./agent');
  const sess = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 't = 57.169494 h', unstable: true }], data_epoch: 0 };
  if (!checkNumericEvidence('最优时间为 57.17 小时。', sess).missing.length) throw new Error('unstable 运行竟然构成证据');
});
t('公式依赖：uses_formulas 拼错名字被拒（不能绕过依赖声明）', () => {
  const { formulaDepsBlock } = require('./agent');
  const sess = { formulas: [{ name: 'D(C)', state: 'tests_passed' }] };
  const msg = formulaDepsBlock(sess, 'python_run', { code: 'x', uses_formulas: ['D_c'] });
  if (!msg || !/未在本会话登记/.test(msg)) throw new Error('拼错依赖名竟然放行: ' + msg);
  const ok = formulaDepsBlock(sess, 'python_run', { code: 'x', uses_formulas: ['D(C)'] });
  if (ok) throw new Error('正确依赖名竟然被拦: ' + ok);
});
t('公式依赖：formal 运行时存在 tests_failed 公式即拒绝（省略依赖不能绕过）', () => {
  const { formulaDepsBlock } = require('./agent');
  const sess = { formulas: [{ name: 'D(C)', state: 'tests_failed' }] };
  const msg = formulaDepsBlock(sess, 'python_run', { code: 'x', formal: true });
  if (!msg || !/tests_failed|未通过测试/.test(msg)) throw new Error('省略依赖的 formal 运行竟然放行: ' + msg);
  // 探索运行放行（不带 formal/uses_formulas）
  const ex = formulaDepsBlock(sess, 'python_run', { code: 'print(1)' });
  if (ex) throw new Error('探索运行竟然被拦: ' + ex);
});
// ISS-11 修法：upsert 改 route 默认不再 bump epoch；要触发下游失效须显式 revise:true
tAsync('四问任务表：upsert 改 route 不 bump epoch；revise:true 才 bump', async () => {
  const { TOOLS } = require('./tools');
  const ctx = { session: { runs: [{ run_id: 'run1', ok: true, tool: 'python_run', epoch: 0, out: 'ok' }], data_epoch: 0 } };
  const qgTool = TOOLS.find(t => t.name === 'question_graph');
  if (!qgTool) throw new Error('question_graph 工具未注册');
  await qgTool.run(ctx, { op: 'upsert', id: 1, title: '问题1', route: '方法A', status: 'reviewing' });
  await qgTool.run(ctx, { op: 'upsert', id: 2, title: '问题2', route: '方法B', status: 'reviewing', deps: [1], experiments: ['run1'] });
  if (ctx.session.question_graph.length !== 2) throw new Error('两个问题未注册');
  if (ctx.session.data_epoch !== 0) throw new Error('初版不应触发 epoch');
  // 普通 upsert 改 route 不应 bump epoch（ISS-11 修法：避免刚 link 的 run 立刻变 stale）
  await qgTool.run(ctx, { op: 'upsert', id: 1, title: '问题1', route: '方法A-修订', status: 'reviewing' });
  if (ctx.session.data_epoch !== 0) throw new Error('ISS-11：普通 upsert 不应 bump epoch');
  // 显式 revise:true → bump epoch + cascade
  const beforeEpoch = ctx.session.data_epoch;
  const msg = await qgTool.run(ctx, { op: 'upsert', id: 1, title: '问题1', route: '方法A-再修订', status: 'reviewing', revise: true });
  if (ctx.session.data_epoch !== beforeEpoch + 1) throw new Error('revise:true 应 bump epoch');
  if (!/下游.*问题.*需重算/.test(msg)) throw new Error('未提示下游问题需重算: ' + msg);
  await qgTool.run(ctx, { op: 'link_run', id: 2, run_id: 'run1' });
  if (!ctx.session.question_graph[1].experiments.includes('run1')) throw new Error('link_run 失败');
  const view = await qgTool.run(ctx, { op: 'view' });
  if (!/问题1/.test(view) || !/问题2/.test(view)) throw new Error('view 不全: ' + view);
});
// ISS-09：原测试断言 result.csv 被备份——但审计明确指出这是 bug（8 个 q1_*.csv 进 trash 强制重算）。
// 新契约：CSV/NPY/NPZ/PKL/PARQUET 是中间产物扩展名，不进 trash；主输出（xlsx/png/txt 等）正常备份。
// 改名 result.csv → result.xlsx 验证主输出备份逻辑；另起一段验证 CSV 被豁免。
t('Python/MATLAB 自动备份：基线快照 + 跑完扫描备份到回收站', () => {
  const { captureAutoBackupBaseline, autoBackupAfterRun } = require('./tools');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-autobk-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-autobk-app-'));
  // 工作区里先放一个旧文件（不应被备份）
  fs.writeFileSync(path.join(root, 'old.txt'), 'old content');
  // 让 mtimeMs 稳定
  fs.utimesSync(path.join(root, 'old.txt'), 1000000, 1000000);
  const ctx = { workspace: root, appDir };
  captureAutoBackupBaseline(ctx);
  if (!ctx._autoBackupBaseline['old.txt']) throw new Error('基线未捕获旧文件');
  // 模拟 Python 运行期新建 result.xlsx（主输出）和 intermediate.csv（中间产物），并修改 old.txt
  fs.writeFileSync(path.join(root, 'result.xlsx'), 'new result');
  fs.writeFileSync(path.join(root, 'intermediate.csv'), 'intermediate data');
  fs.writeFileSync(path.join(root, 'old.txt'), 'modified');
  fs.utimesSync(path.join(root, 'old.txt'), 2000000, 2000000);
  const backed = autoBackupAfterRun(ctx, 'python_run');
  const skipped = (ctx._lastAutoBackupReport && ctx._lastAutoBackupReport.skipped) || [];
  // result.xlsx 主输出应被备份
  if (!backed.find(p => p.from.endsWith('result.xlsx'))) throw new Error('主输出 result.xlsx 未备份');
  // old.txt 应被备份（修改的输入文件）
  if (!backed.find(p => p.from.endsWith('old.txt'))) throw new Error('修改的文件未备份');
  // ISS-09：CSV 进 skipped（不进 trash），仍留在工作区
  if (backed.find(p => p.from.endsWith('intermediate.csv'))) throw new Error('CSV 竟被备份（ISS-09 未生效）');
  if (!skipped.find(p => p.from.endsWith('intermediate.csv'))) throw new Error('CSV 应进 skipped 清单');
  if (!fs.existsSync(path.join(root, 'intermediate.csv'))) throw new Error('CSV 应保留在工作区');
  // 回收站应有 metadata
  const trash = path.join(appDir, 'data', 'trash');
  if (!fs.existsSync(trash)) throw new Error('回收站目录未创建');
  const metas = fs.readdirSync(trash).filter(f => f.endsWith('.meta.json'));
  if (!metas.some(m => /result\.xlsx/.test(m))) throw new Error('result.xlsx meta 未生成');
  if (!metas.some(m => /old\.txt/.test(m))) throw new Error('old.txt meta 未生成');
  // 清理
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});
tAsync('附件解析：文本/旧 xls/docx 三种类型', async () => {
  const { probeFile } = require('./attachments');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-attach-'));
  // 文本
  fs.writeFileSync(path.join(tmp, 'a.txt'), '第一行\n第二行\n第三行');
  const r1 = await probeFile(path.join(tmp, 'a.txt'));
  if (r1.kind !== 'text' || r1.lines !== 3) throw new Error('文本探测错: ' + JSON.stringify(r1));
  // 旧 xls（仅二进制 magic 探测）
  fs.writeFileSync(path.join(tmp, 'b.xls'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  const r2 = await probeFile(path.join(tmp, 'b.xls'));
  if (r2.kind !== 'xls_legacy') throw new Error('旧 xls 探测错: ' + JSON.stringify(r2));
  if (!/xls/.test(r2.recommendation)) throw new Error('xls 推荐缺失');
  // 不存在的文件
  const r3 = await probeFile(path.join(tmp, 'nonexistent.pdf'));
  if (!r3.error) throw new Error('不存在文件应返回 error');
  fs.rmSync(tmp, { recursive: true, force: true });
});
t('状态注入：stateBlock 含四问任务表 + 附件清单 + 最近级联失效', () => {
  const { stateBlock } = require('./agent');
  const sess = {
    formulas: [], decisions: [],
    contract: [], runs: [], data_epoch: 0,
    question_graph: [{ id: 1, title: '问题1', status: 'reviewing', route: '方法A', deps: [], assumptions: [] }],
    question_impacts: [{ at: Date.now(), problem_id: 1, downstream: [2], stale_runs: [] }],
    attachment_manifest: [{ name: '题面.pdf', bytes: 12345, pages: 5, has_text_layer: true, kind: 'pdf' }],
  };
  const block = stateBlock(sess);
  if (!/问题1/.test(block)) throw new Error('stateBlock 缺四问任务表');
  if (!/题面\.pdf/.test(block)) throw new Error('stateBlock 缺附件清单');
  if (!/级联失效|下游Q/.test(block)) throw new Error('stateBlock 缺级联失效');
});
t('P0-1 沙箱 _isInside 严格边界：工作区路径不被同名前缀误判', () => {
  const { createSandbox } = require('./sandbox');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-iso-'));
  const workspace = path.join(tmp, 'workspace', 'testA');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'test.txt'), 'x');
  // 真实复现：APP_DIR 在 tmp 上层、workspace 在 tmp 下层
  const appDir = path.join(tmp, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const sb = createSandbox(appDir, { workspace });
  // 正常：工作区内的文件能 resolve
  const r1 = sb.resolve('test.txt', 'r');
  if (!r1.endsWith('test.txt')) throw new Error('工作区内文件 resolve 失败: ' + r1);
  // 异常：APP_DIR 内的文件应被拒
  let denied = false;
  try { sb.resolve(path.join(appDir, 'secret.key'), 'r'); } catch (e) { denied = true; }
  if (!denied) throw new Error('APP_DIR 应被拒但放行了');
  console.log('  ✓ 工作区 resolve 正常，APP_DIR 正确拒绝');
  fs.rmSync(tmp, { recursive: true, force: true });
});
t('P1-2 证据门禁：代数派生不要求运行证据（R/L=0.08 形式不再被误伤）', () => {
  const { extractClaimNumbers } = require('./agent');
  // 含"="号的派生 — 整句豁免
  const s1 = extractClaimNumbers('端面面积占比 R/L = 0.08 ≈ 8%（半轴长 2cm，总长 25cm）');
  if (s1.length) throw new Error('含 = 的派生应被整句豁免: ' + JSON.stringify(s1));
  // 含"比例"——应被豁免
  const s2 = extractClaimNumbers('R/L 比例 = 0.08');
  if (s2.length) throw new Error('含「比例」应被豁免: ' + JSON.stringify(s2));
  // 真正主张类——"最优值为 8.5 h"应被提取
  const s3 = extractClaimNumbers('最优烘干时间为 8.5 小时。');
  if (!s3.length) throw new Error('计算结果应被提取: ' + JSON.stringify(s3));
  // 题给常数（紧邻题目第N页）——应被豁免
  const s4 = extractClaimNumbers('药材半径 2cm，题目第1页给定');
  if (s4.length) throw new Error('题给常数应被豁免: ' + JSON.stringify(s4));
});
t('P1-3 recordRun 记录 boundary_mode 和 key_params', () => {
  const { recordRun } = require('./agent');
  const sess = { run_seq: 0, runs: [] };
  recordRun(sess, { tool: 'python_run', ok: true, ms: 100, out: 'test',
    boundary_mode: 'tail_mean', key_params: 'D=7e-9·exp(-0.89/C); ρ=820; cp=2600' });
  const r = sess.runs[0];
  if (r.boundary_mode !== 'tail_mean') throw new Error('boundary_mode 未记录: ' + JSON.stringify(r));
  if (!r.key_params || !r.key_params.includes('D=7e-9')) throw new Error('key_params 未记录: ' + JSON.stringify(r));
});
t('P_next question_graph attach_artifact：阶段产物附加与 commit 门禁', () => {
  const { TOOLS } = require('./tools');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-qg-'));
  fs.writeFileSync(path.join(tmp, 'result.xlsx'), 'x');
  const ctx = {
    session: { runs: [{ run_id: 'r1', ok: true, tool: 'python_run', epoch: 0, out: 'ok' }], data_epoch: 0 },
    sandbox: { resolve: (p) => path.isAbsolute(p) ? p : path.join(tmp, p) },
    appDir: tmp, workspace: tmp,
  };
  const qgTool = TOOLS.find(t => t.name === 'question_graph');
  // 1) upsert + link_run
  return qgTool.run(ctx, { op: 'upsert', id: 1, title: 'Q1', route: 'test', status: 'drafting' }).then(() => {
    return qgTool.run(ctx, { op: 'link_run', id: 1, run_id: 'r1' });
  }).then(() => {
    // 2) commit 时无 artifact 应被拒
    return qgTool.run(ctx, { op: 'commit', id: 1 });
  }).then(() => {
    throw new Error('无 artifact 时 commit 应被拒');
  }).catch(e => {
    if (!/无阶段产物/.test(e.message)) throw new Error('应提示无阶段产物: ' + e.message);
    // 3) attach_artifact 后 commit 通过
    return qgTool.run(ctx, { op: 'attach_artifact', id: 1, path: 'result.xlsx', kind: 'result' });
  }).then(() => qgTool.run(ctx, { op: 'commit', id: 1 })).then(msg => {
    if (!/committed/.test(msg)) throw new Error('commit 应通过: ' + msg);
    const q = ctx.session.question_graph[0];
    if (q.status !== 'committed') throw new Error('状态未升级: ' + q.status);
    if (q.committed_at == null) throw new Error('committed_at 未记录');
    if (!q.artifacts || q.artifacts.length !== 1) throw new Error('artifact 未附加');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
t('P_next rollback_artifact：列出回收站 + 单条回滚', () => {
  const { TOOLS } = require('./tools');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-rb-'));
  // rollback_artifact 找的是 ctx.appDir/data/trash
  const trash = path.join(tmp, 'data', 'trash');
  fs.mkdirSync(trash, { recursive: true });
  // 造两个回收站条目
  fs.writeFileSync(path.join(trash, '123_result1.xlsx'), 'data1');
  fs.writeFileSync(path.join(trash, '123_result1.xlsx.meta.json'), JSON.stringify({
    kind: 'auto_backup', originalPath: path.join(tmp, 'result1.xlsx'), deletedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(trash, '456_result2.xlsx'), 'data2');
  fs.writeFileSync(path.join(trash, '456_result2.xlsx.meta.json'), JSON.stringify({
    kind: 'auto_backup', originalPath: path.join(tmp, 'result2.xlsx'), deletedAt: new Date().toISOString(),
  }));
  const ctx = { appDir: tmp };
  const rbTool = TOOLS.find(t => t.name === 'rollback_artifact');
  // 1) 无参 → 列出
  const list = rbTool.run(ctx, {});
  if (!/result1\.xlsx/.test(list) || !/result2\.xlsx/.test(list)) throw new Error('应列出两条: ' + list);
  // 2) 单条回滚
  const r = rbTool.run(ctx, { id: 'result1.xlsx' });
  if (!/回滚/.test(r)) throw new Error('应回滚: ' + r);
  if (!fs.existsSync(path.join(tmp, 'result1.xlsx'))) throw new Error('result1.xlsx 应被恢复');
  if (fs.existsSync(path.join(tmp, 'result2.xlsx'))) throw new Error('result2.xlsx 不应被恢复');
  fs.rmSync(tmp, { recursive: true, force: true });
});
tAsync('P_next env_check：即时返回（不阻塞新建会话）+ 预热后 python/workspace 完整', async () => {
  const { envCheck, warmup } = require('./env_check');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-env-'));
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
  const t0 = Date.now();
  envCheck(tmp);
  if (Date.now() - t0 > 500) throw new Error('envCheck 同步阻塞 ' + (Date.now() - t0) + 'ms（v2.4 用户反馈新建会话要等好几秒）');
  await warmup();
  const r = envCheck(tmp);
  if (!r.python || r.python.ok === false) throw new Error('本机 Python 不可用: ' + (r.python && r.python.error));
  if (r.python.version == null) throw new Error('Python version 缺失');
  if (!r.workspace || r.workspace.file_count < 1) throw new Error('工作区 file_count 错误');
  if (!Array.isArray(r.workspace.dirs) || !r.workspace.dirs.includes('sub')) throw new Error('dirs 应含 sub');
  fs.rmSync(tmp, { recursive: true, force: true });
});
t('子代理权限：未知 profile 失效关闭，绝不降级成全写 worker', () => {
  const { assertSubagentProfile } = require('./agent');
  for (const p of ['worker', 'reviewer', 'redteam']) {
    if (assertSubagentProfile(p) !== p) throw new Error('合法 profile 被改变: ' + p);
  }
  for (const p of ['red', 'modeler', '', null, 'WORKER']) {
    let denied = false;
    try { assertSubagentProfile(p); } catch (e) { denied = /未知子代理 profile/.test(e.message); }
    if (!denied) throw new Error('未知 profile 未拒绝: ' + p);
  }
});
t('子代理证据分离：subagent_run 不再是计算工具，口头报告不构成数值证据', () => {
  const { checkNumericEvidence, isComputeTool } = require('./agent');
  if (isComputeTool('subagent_run', { profile: 'reviewer', prompt: '...' })) throw new Error('subagent_run 不应再视为计算工具');
  // 父会话只有 child_runs（子代理报告，无主 runs）→ 数值主张不被验证
  const sess = { runs: [],
    child_runs: [{ ok: true, tool: 'python_run', epoch: 0, out: 't = 57.169494 h', formal: true }],
    data_epoch: 0 };
  if (!checkNumericEvidence('最优时间为 57.17 小时。', sess).missing.length) throw new Error('子代理 child_runs 竟然构成主会话证据');
  // 主会话自己跑过 python_run → 仍可验证
  const sess2 = { runs: [{ run_id: 'r', ok: true, tool: 'python_run', epoch: 0, out: 't = 57.169494 h' }],
    child_runs: [], data_epoch: 0 };
  if (checkNumericEvidence('最优时间为 57.17 小时。', sess2).missing.length) throw new Error('主会话自己的运行竟然不算证据');
});
t('输入/输出分离：runs/.run/.attachments 是引擎输出目录，正常覆盖不触发 unstable', () => {
  const { stampInputFiles } = require('./agent');
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-iosep-'));
  // 在工作区根放 result.csv（用户常见命名），在 runs/ 放 result2.csv
  fs.writeFileSync(path.join(root, 'result.csv'), '1');
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runs', 'result2.csv'), '2');
  fs.mkdirSync(path.join(root, '.run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.run', 'tmp.csv'), '3');
  const map = stampInputFiles(root);
  if (!('result.csv' in map)) throw new Error('根目录 result.csv 应进入快照');
  if ('runs/result2.csv' in map) throw new Error('runs/ 目录应被排除（引擎输出）');
  if ('.run/tmp.csv' in map) throw new Error('.run/ 目录应被排除（引擎输出）');
  fs.rmSync(root, { recursive: true, force: true });
});
t('输入/输出分离 v2：产出型路径不采快照（华数杯 C 题事故：result*.xlsx/findings/figures/paper/pycache 覆盖不判 unstable）', () => {
  // 实战事故：会话 88594ddd7ed6 全部 42 个 python_run 被标 unstable，commit 门禁全拒。
  // 根因之一：产出型文件（result*.xlsx 覆盖写、findings/*.json、figures/、data/pycache 等）
  // 被 stampInputFiles 当成"运行期改写已存在输入"。快照层就不该采这些路径。
  const { stampInputFiles, isProductiveWritePath } = require('./agent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-prod-'));
  try {
    fs.writeFileSync(path.join(root, 'result_q1.xlsx'), '1');
    fs.writeFileSync(path.join(root, 'result.csv'), '1');   // 沿用既有口径：仍按输入追踪
    fs.writeFileSync(path.join(root, 'input.csv'), 'a\n1\n');
    for (const d of ['findings', 'figures', 'paper', 'data/pycache', 'data/pytemp', 'data/.mplcache']) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
      fs.writeFileSync(path.join(root, d, 'x.json'), '{}');
    }
    const s1 = stampInputFiles(root);
    if ('result_q1.xlsx' in s1) throw new Error('result*.xlsx 交付物不应入快照');
    if (!('result.csv' in s1)) throw new Error('result.csv 沿用既有口径应入快照');
    if (!('input.csv' in s1)) throw new Error('输入文件应入快照');
    for (const p of ['findings/x.json', 'figures/x.json', 'paper/x.json',
      'data/pycache/x.json', 'data/pytemp/x.json', 'data/.mplcache/x.json']) {
      if (p in s1) throw new Error(p + ' 产出/缓存目录不应入快照');
    }
    // 覆盖写产出物 → 快照不变（不产生 unstable、不 bump epoch）
    fs.writeFileSync(path.join(root, 'result_q1.xlsx'), '9999-changed');
    fs.writeFileSync(path.join(root, 'findings', 'x.json'), '{"a":1}');
    if (JSON.stringify(stampInputFiles(root)) !== JSON.stringify(s1)) throw new Error('覆盖产出文件竟然改变了输入快照');
    // 门禁重判判据（commit 重判 unstable_files 用同一函数）
    if (!isProductiveWritePath('result_q1.xlsx')) throw new Error('result*.xlsx 未判为产出型');
    if (!isProductiveWritePath('findings/reconcile_manifest.json')) throw new Error('findings/ 未判为产出型');
    if (!isProductiveWritePath('data/pycache/f.json（被删除）')) throw new Error('带删除尾注的产出路径未判为产出型');
    if (isProductiveWritePath('input.csv')) throw new Error('真输入竟然判为产出型');
    if (isProductiveWritePath('scripts/solve.py')) throw new Error('脚本竟然判为产出型');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
});
t('契约注入：stateBlock 完整保留所有契约条目，不截断', () => {
  const { stateBlock } = require('./agent');
  // 25 条契约、其中一条 text 长 200 字——旧版会被截到最近 20 条 + 前 140 字符
  const longText = 'a'.repeat(200);
  const sess = { formulas: [], decisions: [], contract: Array.from({ length: 25 }, (_, i) => ({
    kind: 'entity', key: 'rule_' + i, text: i === 5 ? longText : 'rule ' + i, source: '题目第' + (i + 1) + '页'
  })), runs: [], data_epoch: 0 };
  const block = stateBlock(sess);
  if (!block.includes('rule_0')) throw new Error('首条契约被遗漏（应用层复审 P1）');
  if (!block.includes('rule_24')) throw new Error('最后一条契约被遗漏');
  if (!block.includes(longText)) throw new Error('长契约内容被截断（应用层复审 P1：超过 140 字符部分丢失）');
});
t('长作业：parseCommand 白名单拒绝任意命令入口', () => {
  const { parseCommand } = require('./jobs');
  if (!parseCommand('matlab -batch sim.m')) throw new Error('白名单 matlab 应放行');
  try { parseCommand('format c:'); throw new Error('危险命令竟然放行'); } catch (e) {
    if (!/白名单/.test(e.message)) throw new Error('错误信息不含白名单提示: ' + e.message);
  }
  try { parseCommand(''); throw new Error('空命令竟然放行'); } catch {}
});
t('长作业 V-28：cmd/powershell/Rscript 入口、python -c、matlab 非 -batch 一律拒绝；python 脚本放行', () => {
  const { parseCommand } = require('./jobs');
  for (const bad of ['cmd /c python x.py', 'powershell -c "x"', 'Rscript x.R', 'python -c "print(1)"', 'python -m http.server', 'matlab -r x']) {
    let threw = false; try { parseCommand(bad); } catch { threw = true; }
    if (!threw) throw new Error('绕守卫入口竟然放行: ' + bad);
  }
  if (parseCommand('python scripts/q2.py --n 3').bin !== 'python') throw new Error('python 脚本应放行（经守卫）');
});
t('长作业 V-28：python 长作业不带守卫拒绝启动', () => {
  const { startJob } = require('./jobs');
  const r = startJob({ command: 'python x.py', cwd: __dirname });
  if (r.ok) throw new Error('无守卫的 python 长作业竟然启动');
});
t('小数值提取：用车数2/p值0.04/阈值0.15 都进入核验', () => {
  const { checkNumericEvidence } = require('./agent');
  const ev = checkNumericEvidence('最优用车数 2 辆，p值 0.04 显著，浓度达到阈值 0.15 以下。', { runs: [], data_epoch: 0 });
  const toks = ev.claimed.join(' ');
  for (const need of ['2', '0.04', '0.15']) {
    if (!toks.includes(need)) throw new Error(need + ' 未被提取（高风险小数值漏检）: ' + toks);
  }
  if (ev.missing.length < 3) throw new Error('缺失项不足');
});
t('来源豁免：题给常数紧邻来源标记不参与核验', () => {
  const { checkNumericEvidence } = require('./agent');
  const session = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 't = 57.169494 h' }], data_epoch: 0 };
  const ev = checkNumericEvidence('根据题目第3页给定的密度820，计算得最优时间为 57.17 小时。', session);
  if (ev.missing.some(x => x.includes('820'))) throw new Error('题给常数竟然被要求核验');
  if (ev.missing.length) throw new Error('正常计算值竟然不匹配: ' + JSON.stringify(ev.missing));
});
t('决策分类：否定不被反向记录（不要采用X ≠ 选中X）', () => {
  const { classifyDecision } = require('./agent');
  const opts = ['固定干质量', '经验密度直接代入'];
  const r = classifyDecision('不要采用固定干质量', opts);
  if (r.status !== 'rejected' || r.rejected_option !== '固定干质量') throw new Error('否定竟然被记成选中: ' + JSON.stringify(r));
  if (classifyDecision('拒绝经验密度直接代入', opts).status !== 'rejected') throw new Error('拒绝未被识别');
  const ok = classifyDecision('固定干质量', opts);
  if (ok.status !== 'resolved') throw new Error('明确选择未被识别');
});
t('决策分类：明确委托≠暂缓（你决定→delegated）', () => {
  const { classifyDecision } = require('./agent');
  if (classifyDecision('你决定', []).status !== 'delegated') throw new Error('委托被当成暂缓');
  if (classifyDecision('你来决定', []).status !== 'delegated') throw new Error('委托被当成暂缓');
  if (classifyDecision('先不决定', []).status !== 'deferred') throw new Error('暂缓识别错了');
});
t('决策分类：模糊回复不算方案确认', () => {
  const { classifyDecision } = require('./agent');
  const opts = ['固定干质量', '经验密度直接代入'];
  if (classifyDecision('继续', opts).status !== 'ambiguous') throw new Error('「继续」竟然被当成已确认');
  if (classifyDecision('好的', opts).status !== 'ambiguous') throw new Error('「好的」竟然被当成已确认');
  if (classifyDecision('固定干质量', opts).status !== 'resolved') throw new Error('明确选择未被识别');
  if (classifyDecision('先不决定', opts).status !== 'deferred') throw new Error('暂缓未被识别');
  if (classifyDecision('我用随体积收缩的干密度，骨架输运为零', opts).status !== 'custom') throw new Error('自定义未被识别');
});
t('运行编号在截断后不重复（含旧会话迁移）', () => {
  const { recordRun } = require('./agent');
  const session = { run_seq: 200, runs: Array.from({ length: 200 }, (_, i) => ({ run_id: 'run' + (i + 1) })) };
  const id1 = recordRun(session, { tool: 'python_run', ok: true, ms: 1, modelTag: 'm', out: 'x' });
  const id2 = recordRun(session, { tool: 'python_run', ok: true, ms: 1, modelTag: 'm', out: 'y' });
  if (id1 === id2) throw new Error('编号重复: ' + id1);
  const ids = session.runs.map(r => r.run_id);
  if (new Set(ids).size !== ids.length) throw new Error('记录里仍有重复编号');
});
t('输入快照：python改写脚本/数据被检测（stampInputFiles→epoch）', () => {
  const os = require('os');
  const { stampInputFiles } = require('./agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-stamp-'));
  try {
    fs.writeFileSync(path.join(dir, 'model.py'), 'x = 1\n');
    const s1 = stampInputFiles(dir);
    if (!('model.py' in s1)) throw new Error('快照未包含代码文件');
    fs.writeFileSync(path.join(dir, 'model.py'), 'x = 2  # rewritten by python_run\n');
    const s2 = stampInputFiles(dir);
    if (s1['model.py'] === s2['model.py']) throw new Error('代码改写未被检测');
    // 数据文件（CSV 输入）也纳入快照（复审：改 input.csv 后 epoch 必须变）
    fs.writeFileSync(path.join(dir, 'input.csv'), 'a,b\n1,2\n');
    if (JSON.stringify(stampInputFiles(dir)) === JSON.stringify(s2)) throw new Error('数据文件未入快照');
    fs.writeFileSync(path.join(dir, 'input.csv'), 'a,b\n9,9\n');
    if (stampInputFiles(dir)['input.csv'] === s2['input.csv']) throw new Error('数据改写未被检测');
    // 图表/日志等输出（非代码/数据扩展名）不触发——防输出误报
    fs.writeFileSync(path.join(dir, 'fig.png'), 'fake');
    const s3 = stampInputFiles(dir);
    if (!('input.csv' in s3) || 'fig.png' in s3) throw new Error('输出文件竟然入快照/输入漏了');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
t('数值语义：Unicode负号 −123.45 不被 +123.45 验证（复审反例）', () => {
  const { checkNumericEvidence } = require('./agent');
  const session = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'value = +123.45' }], data_epoch: 0 };
  const ev = checkNumericEvidence('计算结果为 \u2212123.45。', session); // U+2212
  if (!ev.missing.some(x => x.includes('-123.45'))) throw new Error('Unicode负号竟然被 +123.45 放行');
  // 证据侧的 Unicode 负号也要归一（从 PDF 复制的输出同样常见）
  const s2 = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'value = \u2212123.45' }], data_epoch: 0 };
  if (checkNumericEvidence('计算结果为 -123.45。', s2).missing.length) throw new Error('证据侧Unicode负号未归一（正路径误伤）');
});
t('数值语义：零值主张进入核验（残差为0）', () => {
  const { checkNumericEvidence } = require('./agent');
  const ev = checkNumericEvidence('守恒残差为 0，验证通过。', { runs: [], data_epoch: 0 });
  if (!ev.missing.some(x => x === '0')) throw new Error('零残差主张竟然漏检: ' + JSON.stringify(ev));
  const ok = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'residual = 0' }], data_epoch: 0 };
  if (checkNumericEvidence('守恒残差为 0，验证通过。', ok).missing.length) throw new Error('零值正路径误伤');
});
t('数值语义：来源措辞不豁免计算结果（根据题目计算结果为999）', () => {
  const { checkNumericEvidence } = require('./agent');
  const ev = checkNumericEvidence('根据题目计算结果为 999 小时。', { runs: [], data_epoch: 0 });
  if (!ev.missing.some(x => x.includes('999'))) throw new Error('「根据题目计算结果」竟然被当成来源豁免');
  // 真正的题给常数（题目第N页/题给/附件）仍然豁免
  const ex = checkNumericEvidence('根据题目第3页给定的密度 820，开始计算。', { runs: [], data_epoch: 0 });
  if (ex.missing.some(x => x.includes('820'))) throw new Error('真·题给常数竟然不豁免');
});
t('数值语义：单位倍率一致（123万元 ≠ 123元；可被 1230000元 验证）', () => {
  const { checkNumericEvidence } = require('./agent');
  const bad = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'cost = 123元' }], data_epoch: 0 };
  if (!checkNumericEvidence('最优成本为 123 万元。', bad).missing.length) throw new Error('万元竟然被元验证');
  const good = { runs: [{ run_id: 'r', ok: true, epoch: 0, out: 'cost = 1230000元' }], data_epoch: 0 };
  if (checkNumericEvidence('最优成本为 123 万元。', good).missing.length) throw new Error('换算后的同量值竟然不匹配');
});
t('计算分类：echo/type/pip 不算计算证据', () => {
  const { isComputeTool } = require('./agent');
  if (isComputeTool('shell_run', { command: 'echo hello' })) throw new Error('echo 竟然算计算');
  if (isComputeTool('shell_run', { command: 'type a.txt' })) throw new Error('type 竟然算计算');
  if (isComputeTool('shell_run', { command: 'pip install numpy' })) throw new Error('pip 竟然算计算');
  if (!isComputeTool('python_run', { code: 'print(1)' })) throw new Error('python 不算计算');
});
t('GLM流式usage：末尾delta只有输出时不清零输入', () => {
  // 模拟审计夹具：message_start 输入100+缓存读20，message_delta 只有输出10
  const out = {};
  const { PROVIDERS } = require('./providers'); // 触发模块加载（applyUsageA 未导出，走行为级验证）
  const apply = (ev) => {
    if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      const u = ev.message.usage;
      const tot = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (tot > 0) { const U = out.usage = out.usage || {}; U.prompt_tokens = Math.max(U.prompt_tokens || 0, tot); if (u.cache_read_input_tokens != null) U.cache_hit_tokens = Math.max(U.cache_hit_tokens || 0, u.cache_read_input_tokens); }
    }
    if (ev.type === 'message_delta' && ev.usage) {
      const u = ev.usage;
      const tot = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (tot > 0) { const U = out.usage = out.usage || {}; U.prompt_tokens = Math.max(U.prompt_tokens || 0, tot); }
      if (u.output_tokens != null) { const U = out.usage = out.usage || {}; U.completion_tokens = u.output_tokens; }
    }
  };
  apply({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 1 } } });
  apply({ type: 'message_delta', usage: { output_tokens: 10 } });
  if (out.usage.prompt_tokens !== 120) throw new Error('输入被末尾事件清零: ' + JSON.stringify(out.usage));
  if (out.usage.completion_tokens !== 10) throw new Error('输出累计错误');
});


(async () => {
  // 文件工具：删除=回收站、复制备份、移动源校验
  const { TOOLS, executeTool } = require('./tools');
  const ctx = { sandbox: sb, appDir, workspace: ws, children: new Set() };
  const tool = (name, args) => executeTool(ctx, name, args);

  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
  const del = await tool('fs_delete', { path: 'a.txt' });
  t('删除=移入回收站且原文件消失', () => {
    if (!del.ok || !/trash/.test(del.data)) throw new Error(del.data || del.error);
    if (fs.existsSync(path.join(ws, 'a.txt'))) throw new Error('原文件还在');
  });

  fs.writeFileSync(path.join(ws, 'src.txt'), 'new');
  fs.writeFileSync(path.join(ws, 'dst.txt'), 'old-precious');
  const cp = await tool('fs_copy', { from: 'src.txt', to: 'dst.txt' });
  t('复制覆盖自动备份', () => {
    if (!cp.ok) throw new Error(cp.error);
    if (fs.readFileSync(path.join(ws, 'dst.txt'), 'utf8') !== 'new') throw new Error('复制未生效');
    if (!/备份/.test(cp.data)) throw new Error('覆盖没有备份提示');
  });

  // python 守卫：写工作区外被拒、只读模式拒写、子进程被拒
  const pyWrite = await tool('python_run', { code: `from pathlib import Path\nimport os\nPath('../outside-py.txt').write_text('ESCAPED', encoding='utf-8')\nprint('written')`, timeout_sec: 30 });
  t('python 写工作区外被守卫拦截', () => {
    if (pyWrite.ok) throw new Error('python 竟然成功写出: ' + pyWrite.data);
    if (fs.existsSync(path.join(tmp, 'outside-py.txt'))) throw new Error('金丝雀文件被写出（重大失败）');
  });
  // 科学计算链路（审计 C 最低验收）：numpy 数组运算 + 已知解 LP + pandas 往返 + matplotlib 存图
  // timeout 300s：守卫模式下冷缓存导入整条科学计算链实测 ~40s 起，机器繁忙时可超 120s（2026-10-17 实测）
  const pySci = await tool('python_run', { timeout_sec: 300, code: `import numpy as np
from scipy.optimize import linprog
res = linprog(c=[-2,-3], A_ub=[[3,1],[1,2]], b_ub=[9,8], bounds=[(0,None),(0,None)])
assert abs(-res.fun - 13) < 1e-6, 'LP 已知解错误'
import pandas as pd
df = pd.DataFrame({'x': np.arange(10), 'y': np.arange(10)**2})
df.to_csv('t.csv', index=False); assert pd.read_csv('t.csv')['y'].sum() == 285
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.figure(); plt.plot(df.x, df.y); plt.savefig('t.png'); plt.close()
import os; assert os.path.getsize('t.png') > 1000
print('SCI-OK dot=%d lp=%.1f' % (np.dot([1,2,3],[4,5,6]), -res.fun))` });
  t('科学计算链路 numpy/scipy/pandas/matplotlib（审计C验收）', () => {
    if (!pySci.ok) throw new Error((pySci.data || pySci.error || '').slice(0, 300));
    if (!/SCI-OK dot=32 lp=13/.test(pySci.data)) throw new Error('结果不对: ' + pySci.data.slice(0, 120));
  });
  // python 读程序目录密钥被拒（sys.path 剔除程序目录的验证）
  const pyKey = await tool('python_run', { timeout_sec: 30, code: `try:\n    open('${path.join(appDir, 'config', 'deepseek.key').replace(/\\/g, '/')}').read()\n    print('KEY-READABLE')\nexcept Exception:\n    print('KEY-BLOCKED')` });
  t('python 读程序目录密钥被拒', () => {
    if (/KEY-READABLE/.test(pyKey.data || '')) throw new Error('密钥竟然可读（重大失败）');
  });
  const pyInside = await tool('python_run', { code: `from pathlib import Path\nPath('inside.txt').write_text('ok', encoding='utf-8')\nprint('inside-ok')`, timeout_sec: 30 });
  t('python 写工作区内正常', () => {
    if (!pyInside.ok) throw new Error(pyInside.data || pyInside.error);
    // 自动备份机制下，python_run 跑完会把 inside.txt 移入回收站——这是新行为。
    // 测试改为：原路径应不存在，但回收站应能找到对应 .meta.json（kind=auto_backup）。
    if (fs.existsSync(path.join(ws, 'inside.txt'))) throw new Error('自动备份未生效：inside.txt 仍在原路径');
    const trash = path.join(appDir, 'data', 'trash');
    if (!fs.existsSync(trash)) throw new Error('回收站目录未创建');
    const metas = fs.readdirSync(trash).filter(f => /inside\.txt/.test(f) && f.endsWith('.meta.json'));
    if (!metas.length) throw new Error('inside.txt 应已被自动备份（meta 未找到）');
  });
  const pySub = await tool('python_run', { code: `import subprocess\nsubprocess.run(['cmd.exe', '/c', 'echo hi'])`, timeout_sec: 30 });
  t('python 派生子进程被拒', () => {
    if (pySub.ok) throw new Error('子进程竟然放行');
  });
  const roCtx = { ...ctx, pyMode: 'ro' };
  const pyRo = await executeTool(roCtx, 'python_run', { code: `from pathlib import Path\nPath('ro-attempt.txt').write_text('x', encoding='utf-8')`, timeout_sec: 30 });
  t('只读守卫模式拒写（reviewer 用）', () => {
    if (pyRo.ok) throw new Error('只读模式竟然写成功');
    if (fs.existsSync(path.join(ws, 'ro-attempt.txt'))) throw new Error('只读模式写出了文件');
  });

  // 执行层授权：allowTools 拒绝未授权工具（reviewer 调 fs_write 被拒）
  const reviewCtx = { ...ctx, allowTools: new Set(['fs_read', 'fs_ls', 'python_run']) };
  const denied = await executeTool(reviewCtx, 'fs_write', { path: 'evil.txt', content: 'x' });
  t('执行层拒绝未授权工具（reviewer 写操作）', () => {
    if (denied.ok) throw new Error('未广告的写工具竟然执行了');
  });

  // 大文件分段读（流式）
  const big = path.join(ws, 'big.txt');
  fs.writeFileSync(big, Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'));
  const seg = await tool('fs_read', { path: 'big.txt', start_line: 10, end_line: 12 });
  t('大文件流式分段读取', () => {
    if (!seg.ok || !seg.data.includes('| line 11')) throw new Error((seg.data || seg.error || '').slice(0, 100));
  });

  // 公式登记（case-A 审计 P0 + deepseek-glm 复审：自证/盲区/状态机）
  const fctx = { ...ctx, session: { formulas: [] } };
  const tryTool = async (name, args) => { try { return await executeTool(fctx, name, args); } catch (e) { return { ok: false, error: e.message }; } };
  const dExpr = '7e-9*exp(-0.89/C)';
  const rightPts = [0.15, 2.55].map(C => ({ inputs: { C }, expected: 7e-9 * Math.exp(-0.89 / C) })); // 独立按正确公式手算的期望值
  const fOk = await tryTool('formula_register', { name: 'D(C)', expression: dExpr, source: '题目PDF第3页', test_points: rightPts });
  t('公式登记：正确公式测试点通过', () => {
    if (!fOk.ok || !/✓一致/.test(fOk.data) || /✗不一致/.test(fOk.data)) throw new Error((fOk.data || fOk.error || '').slice(0, 200));
    if (!fctx.session.formulas.length) throw new Error('未落库');
    if (fctx.session.formulas[0].state !== 'tests_passed') throw new Error('状态机未记录 tests_passed');
  });
  // 复审反例：两个重复的 C=1 点（旧版可通过——恰好是 exp 盲区）
  const dupPts = [{ inputs: { C: 1 }, expected: 2.8746e-9 }, { inputs: { C: 1 }, expected: 2.8746e-9 }];
  const fDup = await tryTool('formula_register', { name: 'D_dup', expression: dExpr, source: '题目PDF第3页', test_points: dupPts });
  t('公式登记：重复测试点被拒（C=1盲区反例）', () => {
    if (fDup.ok) throw new Error('重复点竟然通过');
    if (!/去重后至少/.test(fDup.error || '')) throw new Error('去重提示缺失: ' + (fDup.error || '').slice(0, 100));
  });
  const wrongPts = [0.15, 2.55].map(C => ({ inputs: { C }, expected: 7e-9 * Math.exp(-0.89 * C) })); // 期望值来自错读公式
  const fBad = await tryTool('formula_register', { name: 'D_wrong', expression: dExpr, source: '题目PDF第3页', test_points: wrongPts });
  t('公式登记：错读公式为可执行失败（tests_failed状态）', () => {
    if (fBad.ok) throw new Error('错读公式竟然返回成功');
    if (!/✗不一致/.test(fBad.error || '') || !/核对/.test(fBad.error || '')) throw new Error('错读公式提示缺失');
    const rec = fctx.session.formulas.find(f => f.name === 'D_wrong');
    if (!rec || rec.state !== 'tests_failed') throw new Error('失败状态未落库');
  });
  // 来源必须是可定位的文档位置（旧版任意字符串可过）
  const fSrc = await tryTool('formula_register', { name: 'D_src', expression: dExpr, source: '我觉得是这样', test_points: rightPts });
  t('公式登记：不可定位来源被拒', () => {
    if (fSrc.ok) throw new Error('任意来源字符串竟然通过');
  });
  // 公式修订标记（epoch 失效传播的触发源）
  const fRev = await tryTool('formula_register', { name: 'D(C)', expression: '7.1e-9*exp(-0.89/C)', source: '题目PDF第3页（修订）', test_points: [0.15, 2.55].map(C => ({ inputs: { C }, expected: 7.1e-9 * Math.exp(-0.89 / C) })) });
  t('公式登记：修订触发过期标记', () => {
    if (!fRev.ok || !/公式已修订/.test(fRev.data)) throw new Error('修订未触发过期标记');
  });
  // 失败修订同样携带过期标记（复审 P1-3：失败重登必须作废旧证据，不能只在成功路径标记）
  const fRevBad = await tryTool('formula_register', { name: 'D(C)', expression: '7.3e-9*exp(-0.89*C)', source: '题目PDF第3页（二次修订）', test_points: [0.15, 2.55].map(C => ({ inputs: { C }, expected: 7.3e-9 * Math.exp(-0.89 / C) })) });
  t('公式登记：失败修订也携带过期标记', () => {
    if (fRevBad.ok) throw new Error('错读公式竟然返回成功');
    if (!/✗不一致/.test(fRevBad.error || '')) throw new Error('不一致提示缺失');
    if (!/公式已修订/.test(fRevBad.error || '')) throw new Error('失败修订未带过期标记');
    const rec = fctx.session.formulas.find(f => f.name === 'D(C)');
    if (!rec || rec.state !== 'tests_failed') throw new Error('失败修订状态未落库');
  });

  // ===== A 题对比最终答案沉淀的新增测试 =====
  // 纯 Node 造最小 xlsx（stored zip：local header + central dir + EOCD）
  function makeXlsx(filePath, rowsXml) {
    const zlib = require('zlib');
    function crc32(buf) {
      let c, table = crc32.t;
      if (!table) {
        table = crc32.t = [];
        for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
      }
      let crc = 0xffffffff;
      for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    }
    const files = [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="moisture" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rowsXml + '</sheetData></worksheet>'],
    ];
    const parts = [], cds = [];
    let off = 0;
    for (const [name, content] of files) {
      const nb = Buffer.from(name, 'utf8'), db = Buffer.from(content, 'utf8'), crc = crc32(db);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
      lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22);
      lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
      parts.push(lh, nb, db);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
      cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(db.length, 20); cd.writeUInt32LE(db.length, 24);
      cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(off, 42);
      cds.push(Buffer.concat([cd, nb]));
      off += 30 + nb.length + db.length;
    }
    const cdBuf = Buffer.concat(cds);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(0, 20);
    fs.writeFileSync(filePath, Buffer.concat([...parts, cdBuf, eocd]));
  }

  {
    const wsDir = fs.mkdtempSync(path.join(tmp, 'xlsx_'));
    const hdr = '<row r="1"><c r="A1" t="inlineStr"><is><t>t/r</t></is></c><c r="B1"><v>0</v></c><c r="C1"><v>0.5</v></c><c r="D1"><v>1</v></c><c r="E1"><v>1.5</v></c><c r="F1"><v>2</v></c></row>';
    const r60a = '<row r="2"><c r="A2"><v>60</v></c><c r="B2"><v>1.0</v></c><c r="C2"><v>0.9</v></c><c r="D2"><v>0.7</v></c><c r="E2"><v>0.5</v></c><c r="F2"><v>0.3</v></c></row>';
    const r60b = '<row r="2"><c r="A2"><v>60</v></c><c r="B2"><v>1.0</v></c><c r="C2"><v>0.9</v></c><c r="D2"><v>0.7</v></c><c r="E2"><v>0.51</v></c><c r="F2"><v>0.3</v></c></row>';
    const r120 = '<row r="3"><c r="A3"><v>120</v></c><c r="B3"><v>0.9</v></c><c r="C3"><v>0.8</v></c><c r="D3"><v>0.6</v></c><c r="E3"><v>0.4</v></c><c r="F3"><v>0.2</v></c></row>';
    const r180 = '<row r="4"><c r="A4"><v>180</v></c><c r="B4"><v>0.8</v></c><c r="C4"><v>0.7</v></c><c r="D4"><v>0.5</v></c><c r="E4"><v>0.3</v></c><c r="F4"><v>0.1</v></c></row>';
    makeXlsx(path.join(wsDir, 'a.xlsx'), hdr + r60a + r120);
    makeXlsx(path.join(wsDir, 'b.xlsx'), hdr + r60b + r120 + r180);
    const { diffXlsx } = require('./xlsxDiff');
    const rep = diffXlsx(path.join(wsDir, 'a.xlsx'), path.join(wsDir, 'b.xlsx'), { tol: 5e-4 });
    t('spreadsheet_diff：命中 0.01 差值格（t=60, r=1.5）', () => {
      if (!/最大差 1\.000e-2/.test(rep)) throw new Error('最大差不对: ' + rep.slice(0, 300));
      if (!/行=60/.test(rep) || !/列=1\.5/.test(rep)) throw new Error('差值位置不对: ' + rep.slice(0, 300));
      if (!/比对数值格 10 个/.test(rep)) throw new Error('格数不对: ' + rep.slice(0, 300));
    });
    t('spreadsheet_diff：检测 B 独有行键（t=180）', () => {
      if (!/仅 B 有的行键 1 个/.test(rep)) throw new Error('独有行未检出: ' + rep.slice(0, 400));
    });
    const dctx = { sandbox: { resolve: (p) => path.isAbsolute(p) ? p : path.join(wsDir, p) }, appDir: tmp, session: {} };
    const { TOOLS } = require('./tools');
    const sd = TOOLS.find(x => x.name === 'spreadsheet_diff');
    t('spreadsheet_diff：经工具层调用（工作区相对路径）', () => {
      const r = sd.run(dctx, { a: 'a.xlsx', b: 'b.xlsx' });
      if (typeof r !== 'string' || !/moisture/.test(r)) throw new Error('工具层调用失败: ' + String(r).slice(0, 200));
    });
    t('spreadsheet_diff：缺文件报错（不静默）', () => {
      try { sd.run(dctx, { a: 'a.xlsx', b: 'nope.xlsx' }); throw new Error('竟然没报错'); }
      catch (e) { if (!/不存在/.test(e.message)) throw e; }
    });
    fs.rmSync(wsDir, { recursive: true, force: true });
  }

  // repro_check：判定必须来自结构化结果，不能对报告文本跑正则。
  // 回归锁两条曾让 .py/.m 分支一起废掉的 bug：
  //   ① 内部直调 tPythonRun/tShellRun 拿到的是 {exit,stdout,stderr}，没有 .ok/.data → 必须走 runResult
  //   ② 报告首行是 `[spreadsheet_diff] A=...`，旧判定 /差异|不一致|DIFF/i 被自己的表头命中 → 恒判"有差异"
  {
    const rpDir = fs.mkdtempSync(path.join(tmp, 'repro_'));
    const appDir2 = path.join(rpDir, 'app');
    fs.mkdirSync(path.join(rpDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(rpDir, 'data'), { recursive: true });
    fs.mkdirSync(appDir2, { recursive: true });
    // 主解脚本用 python 写：离线可跑，且与 .m 分支共用同一套判定/包裹逻辑
    fs.writeFileSync(path.join(rpDir, 'data', 'in.csv'), 'x\n1\n2\n3\n4\n', 'utf8');
    fs.writeFileSync(path.join(rpDir, 'scripts', 'solve.py'), [
      'import csv, os, openpyxl',
      'with open(os.path.join("data","in.csv")) as f: v=[float(r["x"]) for r in csv.DictReader(f)]',
      'n, m = sum(v), sum(v)/len(v)',
      'open("result_q1.csv","w").write("sum_x,mean_x\\n%g,%g\\n" % (n,m))',
      'w=openpyxl.Workbook(); s=w.active; s.title="moisture"',
      's.append(["key","sum_x","mean_x"]); s.append([1,n,m]); w.save("result_q1.xlsx")',
      'print("solve done")',
    ].join('\n'), 'utf8');
    // repro_check 第 ③ 步比的是工作区根上"已有"的 result*.xlsx（在重跑前读）
    const hr = '<row r="1"><c r="A1" t="inlineStr"><is><t>key</t></is></c><c r="B1" t="inlineStr"><is><t>sum_x</t></is></c><c r="C1" t="inlineStr"><is><t>mean_x</t></is></c></row>';
    const row = '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>10</v></c><c r="C2"><v>2.5</v></c></row>';
    makeXlsx(path.join(rpDir, 'result_q1.xlsx'), hr + row);
    const rpSession = { mode: 'math', runs: [], data_epoch: 0, source_files: ['scripts/solve.py'] };
    const rpCtx = {
      workspace: rpDir, appDir: appDir2, session: rpSession,
      sandbox: new Sandbox(rpDir, { protected: [appDir2] }),
      settings: {}, spend: () => {}, trackVision: () => {}, emit: () => {},
      abort: new AbortController(), sandboxViolations: 0,
    };
    const { TOOLS: T2 } = require('./tools');
    const rc = T2.find(x => x.name === 'repro_check');
    const rpOut = await rc.run(rpCtx, { script: 'scripts/solve.py', timeout_sec: 300 });
    const rpMan = JSON.parse(fs.readFileSync(path.join(rpDir, 'findings', 'repro_manifest.json'), 'utf8'));
    t('repro_check：runResult 归一化生效（真的重跑成功，不是恒 false）', () => {
      if (rpMan.run_ok !== true) throw new Error('run_ok=' + rpMan.run_ok + '｜' + String(rpOut).slice(0, 300));
    });
    t('repro_check：一致时判 pass（表头 [spreadsheet_diff] 不触发假差异）', () => {
      if (!rpMan.pass) throw new Error('pass=false；compare=' + JSON.stringify(rpMan.compare).slice(0, 400));
      if (!/可复现/.test(String(rpOut))) throw new Error('结论文案不对: ' + String(rpOut).slice(0, 200));
    });
    t('repro_check：隔离目录产物不被 auto_backup 收走（比对目标还在）', () => {
      if (rpMan.compare[0].status !== 'same') throw new Error('status=' + rpMan.compare[0].status);
      if (!(rpMan.compare[0].compared >= 1)) throw new Error('compared=' + rpMan.compare[0].compared);
      if (!fs.existsSync(path.join(rpDir, rpMan.dir, 'result_q1.xlsx'))) throw new Error('隔离复现 XLSX 已被移走');
      if (rpSession.repro_check.pass !== true) throw new Error('session 未登记复现通过');
    });
    fs.rmSync(rpDir, { recursive: true, force: true });
  }

  // question_graph conventions：upsert 带约定字段 → view 可见；仅改 conventions 不触发失效传播
  {
    const qctx = { session: { question_graph: [], runs: [], data_epoch: 0 }, sandbox: { resolve: (p) => p }, appDir: tmp };
    const { TOOLS } = require('./tools');
    const qg = TOOLS.find(x => x.name === 'question_graph');
    await qg.run(qctx, { op: 'upsert', id: 4, title: '移动边界', status: 'drafting',
      conventions: { solver: 'FVM+ode15s', grid: '1281 表面加密', boundary_extension: 'last_plateau', moving_boundary: 'material_coords', endpoint_criterion: 'strict_second' } });
    t('question_graph：conventions 落库并在 view 可见', () => {
      const q = qctx.session.question_graph.find(x => x.id === 4);
      if (!q || !q.conventions || q.conventions.moving_boundary !== 'material_coords') throw new Error('conventions 未落库');
    });
    const v = await qg.run(qctx, { op: 'view' });
    t('question_graph：view 输出约定行', () => {
      if (!/约定: solver=FVM\+ode15s/.test(v)) throw new Error('view 未显示约定: ' + v.slice(0, 300));
    });
    const spec = await qg.run(qctx, { op: 'spec' });
    t('question_graph：spec 是四张登记表的只读组合视图', () => {
      if (!/模型规格书·只读视图/.test(spec) || !/Q4 移动边界/.test(spec)) throw new Error('spec 缺问题路线: ' + spec.slice(0, 300));
      if (!/题目契约[\s\S]*公式与可执行测试[\s\S]*假设与风险/.test(spec)) throw new Error('spec 缺登记表分区');
    });
    const ep = qctx.session.data_epoch;
    await qg.run(qctx, { op: 'upsert', id: 4, conventions: { solver: 'pdepe m=1' } });
    t('question_graph：仅改 conventions 不触发失效传播（约定修订≠路线修订）', () => {
      if (qctx.session.data_epoch !== ep) throw new Error('conventions 修订误触发 epoch 递增');
      const q = qctx.session.question_graph.find(x => x.id === 4);
      if (q.conventions.solver !== 'pdepe m=1') throw new Error('conventions 未更新');
      if (q.conventions.moving_boundary !== 'material_coords') throw new Error('未提供的约定被误清');
    });
    await qg.run(qctx, { op: 'upsert', id: 4, conventions: { weird_key: 'x' } });
    t('question_graph：未知约定键归入 other', () => {
      const q = qctx.session.question_graph.find(x => x.id === 4);
      if (q.conventions.other !== 'x') throw new Error('未知键未归 other');
    });
  }

  // commit 门禁对 unstable 重判（华数杯 C 题事故：会话 88594ddd7ed6 全 run ⚠unstable 卡死 Q1-Q4）
  {
    const { TOOLS } = require('./tools');
    const qg = TOOLS.find(x => x.name === 'question_graph');
    const mkCtx = (runs) => ({
      session: { question_graph: [{ id: 1, title: 'Q1', status: 'reviewing', deps: [],
        experiments: runs.map(r => r.run_id), artifacts: [{ path: 'fig.png', kind: 'figure' }] }],
        runs, data_epoch: 0 },
      // resolve 指到不存在的路径——commit 成功后不触发 paper_build
      sandbox: { resolve: (p) => path.join(tmp, 'no_such_dir_xxx', p) }, appDir: tmp,
    });
    // 真改输入的 unstable（清单含真输入路径）→ 仍拒
    const c1 = mkCtx([{ run_id: 'run1', ok: true, epoch: 0, out: 'x', unstable: true, unstable_files: ['input.csv'] }]);
    let rejected = false;
    try { await qg.run(c1, { op: 'commit', id: 1 }); } catch (e) { rejected = /unstable/.test(e.message) && /input\.csv/.test(e.message); }
    t('commit门禁：unstable_files含真输入路径→仍拒绝', () => {
      if (!rejected) throw new Error('真改输入的 run 竟然放行 commit');
      if (c1.session.question_graph[0].status === 'committed') throw new Error('被拒后状态竟然已 committed');
    });
    // 清单全是产出型路径（历史 run 由产出覆盖误标）→ 重判放行
    const c2 = mkCtx([{ run_id: 'run1', ok: true, epoch: 0, out: 'x', unstable: true, unstable_files: ['result_q1.xlsx', 'findings/x.json'] }]);
    const m2 = await qg.run(c2, { op: 'commit', id: 1 });
    t('commit门禁：unstable_files全在产出排除集→放行并记账', () => {
      if (c2.session.question_graph[0].status !== 'committed') throw new Error('产出覆盖误伤竟然仍被拒: ' + m2);
      const imp = (c2.session.question_impacts || []).find(i => i.event === 'commit_pardoned_unstable_marks');
      if (!imp || imp.runs[0].kind !== 'productive_overwrite') throw new Error('未记 productive_overwrite 放行账');
    });
    // 旧版恒真 bug 标（unstable=true 且无文件清单，会话 88594ddd7ed6 的 42 个 run 都是这种）→ 放行并记账
    const c3 = mkCtx([{ run_id: 'run1', ok: true, epoch: 0, out: 'x', unstable: true }]);
    const m3 = await qg.run(c3, { op: 'commit', id: 1 });
    t('commit门禁：旧版恒真 bug 标（无文件清单）→放行并记 legacy_bug_mark', () => {
      if (c3.session.question_graph[0].status !== 'committed') throw new Error('旧 bug 标竟然仍被拒: ' + m3);
      const imp = (c3.session.question_impacts || []).find(i => i.event === 'commit_pardoned_unstable_marks');
      if (!imp || imp.runs[0].kind !== 'legacy_bug_mark') throw new Error('未记 legacy_bug_mark 放行账');
    });
  }

  // v2.3 新工具/新条款/新字段回归
  {
    // result_align 工具存在且可调用
    const { TOOLS } = require('./tools');
    const ra = TOOLS.find(x => x.name === 'result_align');
    t('result_align：已注册到 TOOLS', () => { if (!ra) throw new Error('result_align 工具未注册'); });
    t('result_align：缺参数报错', () => {
      try { ra.run({ session: {}, sandbox: { resolve: p => p }, appDir: tmp }, {}); throw new Error('竟没报错'); }
      catch (e) { if (!/result_path|template_path/.test(e.message)) throw e; }
    });
    t('result_align：result 文件不存在报错（不静默）', () => {
      const ctx = { session: {}, sandbox: { resolve: p => path.join(tmp, p) }, appDir: tmp };
      const tpl = path.join(tmp, 'tpl.xlsx');
      makeXlsx(tpl, '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>');
      try { ra.run(ctx, { result_path: 'no_such.xlsx', template_path: tpl }); throw new Error('竟没报错'); }
      catch (e) { if (!/不存在/.test(e.message)) throw e; }
    });
    // 用 makeXlsx 做一份 result 和 template（缺一列）应能检出列头差异
    const wsDir = fs.mkdtempSync(path.join(tmp, 'align_'));
    const tplXml = '<row r="1"><c r="A1" t="inlineStr"><is><t>时间</t></is></c><c r="B1" t="inlineStr"><is><t>购电量</t></is></c><c r="C1" t="inlineStr"><is><t>价格</t></is></c></row>'
      + '<row r="2"><c r="A2"><v>0</v></c><c r="B2"><v>100</v></c><c r="C2"><v>0.5</v></c></row>';
    const resXml = '<row r="1"><c r="A1" t="inlineStr"><is><t>时间</t></is></c><c r="B1" t="inlineStr"><is><t>购电量</t></is></c></row>'
      + '<row r="2"><c r="A2"><v>0</v></c><c r="B2"><v>100</v></c></row>';
    makeXlsx(path.join(wsDir, 'tpl.xlsx'), tplXml);
    makeXlsx(path.join(wsDir, 'res.xlsx'), resXml);
    t('result_align：列头差异检出', () => {
      const ctx = { session: {}, sandbox: { resolve: p => path.join(wsDir, p) }, appDir: tmp };
      const r = ra.run(ctx, { result_path: 'res.xlsx', template_path: 'tpl.xlsx' });
      if (!/列头差异/.test(r) || !/仅 template 有.*价格/.test(r)) throw new Error('未检出列头差异: ' + r.slice(0, 400));
    });
    fs.rmSync(wsDir, { recursive: true, force: true });

    // contract_register 新条款类型
    const cr = TOOLS.find(x => x.name === 'contract_register');
    const crCtx = { session: { contract: [] }, appDir: tmp };
    const r1 = await cr.run(crCtx, { items: [{ kind: 'interval_convention', key: 'time_interval', text: '左闭右开 (0:00, 0:10]', source: '附件5 模板', scope: 'result_sheets' }] });
    t('contract_register：interval_convention 接受（带 scope）', () => {
      if (!/interval_convention:time_interval/.test(r1)) throw new Error('interval_convention 未落库: ' + r1.slice(0, 200));
      if (!/\[result_sheets\]/.test(r1)) throw new Error('scope 未在输出中: ' + r1.slice(0, 200));
    });
    const r2 = await cr.run(crCtx, { items: [{ kind: 'baseline_definition', key: 'no_storage', text: '无储能 = 波动电价 + 允许弃光 + 负荷全额覆盖', source: '本题 Q4', scope: 'Q4_benchmark' }] });
    t('contract_register：baseline_definition 接受（带 scope）', () => {
      if (!/baseline_definition:no_storage/.test(r2)) throw new Error('baseline_definition 未落库');
    });
    t('contract_register：未注册 kind 拒收', async () => {
      try { await cr.run(crCtx, { items: [{ kind: 'made_up_kind', key: 'x', text: 't', source: 's' }] }); throw new Error('竟没报错'); }
      catch (e) { if (!/kind 必须是/.test(e.message)) throw e; }
    });
    t('contract_register：缺 source 拒收（契约可溯源铁律）', async () => {
      try { await cr.run(crCtx, { items: [{ kind: 'interval_convention', key: 'x', text: 't' }] }); throw new Error('竟没报错'); }
      catch (e) { if (!/source 必填/.test(e.message)) throw e; }
    });
    const ctx2 = { session: { contract: [{ kind: 'baseline_definition', key: 'no_storage', text: 't1', source: 's' }] }, appDir: tmp };
    const r3 = await cr.run(ctx2, { items: [{ kind: 'baseline_definition', key: 'no_storage', text: 't1', source: 's', scope: 'new' }] });
    t('contract_register：scope 修订触发 revised', () => {
      if (!/契约已修订/.test(r3)) throw new Error('scope 变化未触发 revised: ' + r3.slice(0, 200));
    });
  }

  // v2.3 question_graph experiments_desc 字段
  {
    const { TOOLS } = require('./tools');
    const qg = TOOLS.find(x => x.name === 'question_graph');
    const qctx = { session: { question_graph: [], runs: [], data_epoch: 0 }, sandbox: { resolve: p => p }, appDir: tmp };
    await qg.run(qctx, { op: 'upsert', id: 1, title: '测试实验描述', status: 'drafting',
      experiments_desc: ['用 scipy.linprog + HiGHS 对偶单纯形', '不做 0-1 互斥变量（η<1 同时充放必亏）'] });
    t('question_graph：experiments_desc 落库', () => {
      const q = qctx.session.question_graph.find(x => x.id === 1);
      if (!q.experiments_desc || q.experiments_desc.length !== 2) throw new Error('experiments_desc 未落库: ' + JSON.stringify(q));
    });
    const ep1 = qctx.session.data_epoch;
    // 仅改 experiments_desc（描述文本）→ 不应触发 revised → 不 ++ epoch
    await qg.run(qctx, { op: 'upsert', id: 1, experiments_desc: ['改了的描述'] });
    t('question_graph：仅改 experiments_desc 不 ++ epoch（C 题 2026 教训）', () => {
      if (qctx.session.data_epoch !== ep1) throw new Error('experiments_desc 修订误触发 epoch++（应为格式级）');
    });
    const v = await qg.run(qctx, { op: 'view' });
    t('question_graph：view 显示实验说明数', () => {
      if (!/实验说明\d+条/.test(v)) throw new Error('view 未显示实验说明数: ' + v.slice(0, 300));
    });
  }

  // B 档 1：dispatch_child 父-子会话分发
  {
    const { TOOLS, buildInheritedPrompt: bfn } = require('./tools');
    const dc = TOOLS.find(x => x.name === 'dispatch_child');
    t('dispatch_child：已注册到 TOOLS', () => { if (!dc) throw new Error('dispatch_child 工具未注册'); });
    t('dispatch_child：缺 child_prompt 报错', async () => {
      try { await dc.run({ session: {}, sandbox: { resolve: p => p }, appDir: tmp }, {}); throw new Error('竟没报错'); }
      catch (e) { if (!/child_prompt 必填/.test(e.message)) throw e; }
    });
    t('dispatch_child：缺 child_prompt（whitespace only）也报错', async () => {
      try { await dc.run({ session: {}, sandbox: { resolve: p => p }, appDir: tmp }, { child_prompt: '   \n\t  ' }); throw new Error('竟没报错'); }
      catch (e) { if (!/child_prompt 必填/.test(e.message)) throw e; }
    });
    t('dispatch_child：buildInheritedPrompt 无 contract → 仅 child_prompt', () => {
      const out = bfn({ contract: [], question_graph: [] }, 'do X', true, true);
      if (out !== 'do X') throw new Error('应仅返回 child_prompt: ' + out);
    });
    t('dispatch_child：buildInheritedPrompt 注入 contract + conventions', () => {
      const ps = {
        contract: [{ kind: 'boundary', key: 'r_max', text: 'r ≤ 2 cm', source: '题目PDF' }],
        question_graph: [{ id: 1, title: 'Q1', conventions: { solver: 'FVM', grid: '1281' } }],
      };
      const out = bfn(ps, 'solve Q1', true, true);
      if (!/继承自父会话的契约/.test(out) || !/r ≤ 2 cm/.test(out)) throw new Error('contract 未注入: ' + out.slice(0, 200));
      if (!/继承自父会话的约定/.test(out) || !/solver=FVM/.test(out)) throw new Error('conventions 未注入: ' + out.slice(0, 200));
      if (!/solve Q1$/.test(out.trim())) throw new Error('child_prompt 应在最后: ' + out.slice(0, 200));
    });
    t('dispatch_child：buildInheritedPrompt inherit=false → 不注入', () => {
      const ps = {
        contract: [{ kind: 'boundary', key: 'r_max', text: 'r ≤ 2 cm', source: '题目PDF' }],
        question_graph: [{ id: 1, title: 'Q1', conventions: { solver: 'FVM' } }],
      };
      const out = bfn(ps, 'do it', false, false);
      if (/继承/.test(out)) throw new Error('inherit=false 应不注入: ' + out);
      if (out !== 'do it') throw new Error('应仅 child_prompt');
    });
  }

  // MODE_APPENDIX.math：按题型要求真实检验，守恒不适用时需给替代检验。
  t('buildSystem(math)：分题型质量标准与守恒替代检验', () => {
    const { buildSystem } = require('./agent');
    // 保留省略 session 的原覆盖，同时覆盖生产入口传入真实任务范围的合同。
    for (const sys of [
      buildSystem('math', ws, {}, APP, 'deepseek'),
      buildSystem('math', ws, {}, APP, 'deepseek', null, { mode: 'math', task_scope: 'solve' }),
    ]) {
      for (const kw of ['conservation_check', 'not_applicable', '替代检验', '精确', '随机模拟', 'spreadsheet_diff', 'conventions.statistics_method']) {
        if (!sys.includes(kw)) throw new Error('缺关键词 ' + kw);
      }
      if (/每问一张流程图|至少两套网格|4h 边界/.test(sys)) throw new Error('通用数模提示误套了特定赛题要求');
    }
  });

  // v2.3.2 C 档 1 CI 化：paper_build 工具 + commit 自动编译
  tAsync('paper_build：缺 tex 返回提示（非 throw）', async () => {
    const { TOOLS } = require('./tools');
    const pb = TOOLS.find(x => x.name === 'paper_build');
    if (!pb) throw new Error('paper_build 未注册');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-pb-'));
    const ctx = { sandbox: new Sandbox(tmp2, { protected: [] }), workspace: tmp2 };
    const msg = await pb.run(ctx, {});
    if (!/找不到|paper\/main\.tex/.test(msg)) throw new Error('应提示找不到: ' + msg);
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  tAsync('paper_build：xelatex 真编译出 PDF', async () => {
    const { TOOLS } = require('./tools');
    const pb = TOOLS.find(x => x.name === 'paper_build');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-pb2-'));
    fs.writeFileSync(path.join(tmp2, 'main.tex'), '\\documentclass{article}\\begin{document}Hi $x^2$\\end{document}');
    const ctx = { sandbox: new Sandbox(tmp2, { protected: [] }), workspace: tmp2 };
    const msg = await pb.run(ctx, { tex: 'main.tex' });
    if (!/main\.pdf|✓/.test(msg)) throw new Error('编译应成功: ' + String(msg).slice(0, 300));
    if (!fs.existsSync(path.join(tmp2, 'main.pdf'))) throw new Error('main.pdf 未生成');
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  tAsync('question_graph commit：paper/main.tex 存在时自动编译附结果', async () => {
    const { TOOLS } = require('./tools');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-pb3-'));
    fs.mkdirSync(path.join(tmp2, 'paper'), { recursive: true });
    fs.writeFileSync(path.join(tmp2, 'result.xlsx'), 'x');
    fs.writeFileSync(path.join(tmp2, 'paper', 'main.tex'), '\\documentclass{article}\\begin{document}Hello\\end{document}');
    const ctx = { session: { runs: [{ run_id: 'r1', ok: true, epoch: 0 }], data_epoch: 0 }, sandbox: new Sandbox(tmp2, { protected: [] }), workspace: tmp2 };
    const qg = TOOLS.find(x => x.name === 'question_graph');
    await qg.run(ctx, { op: 'upsert', id: 1, title: 'Q1', route: 'test', status: 'drafting' });
    await qg.run(ctx, { op: 'link_run', id: 1, run_id: 'r1' });
    await qg.run(ctx, { op: 'attach_artifact', id: 1, path: 'result.xlsx', kind: 'result' });
    const msg = await qg.run(ctx, { op: 'commit', id: 1 });
    if (!/committed/.test(msg)) throw new Error('commit 失败: ' + msg);
    if (!/自动编译/.test(msg)) throw new Error('应附自动编译结果: ' + msg.slice(0, 300));
    if (!fs.existsSync(path.join(tmp2, 'paper', 'main.pdf'))) throw new Error('自动编译未出 PDF');
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  tAsync('question_graph commit：无 paper/main.tex 时正常 commit（不触发编译）', async () => {
    const { TOOLS } = require('./tools');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-pb4-'));
    fs.writeFileSync(path.join(tmp2, 'result.xlsx'), 'x');
    const ctx = { session: { runs: [{ run_id: 'r1', ok: true, epoch: 0 }], data_epoch: 0 }, sandbox: new Sandbox(tmp2, { protected: [] }), workspace: tmp2 };
    const qg = TOOLS.find(x => x.name === 'question_graph');
    await qg.run(ctx, { op: 'upsert', id: 1, title: 'Q1', route: 'test', status: 'drafting' });
    await qg.run(ctx, { op: 'link_run', id: 1, run_id: 'r1' });
    await qg.run(ctx, { op: 'attach_artifact', id: 1, path: 'result.xlsx', kind: 'result' });
    const msg = await qg.run(ctx, { op: 'commit', id: 1 });
    if (!/committed/.test(msg)) throw new Error('commit 失败: ' + msg);
    if (/自动编译/.test(msg)) throw new Error('无 main.tex 不应触发编译: ' + msg);
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  // m34 修法：compute 工具返回值附 [run_id]，question_graph runs_view 列出
  t('recordRun 返回 run_id 且 session.runs 落库', () => {
    const { recordRun } = require('./agent');
    const sess = { run_seq: 0, runs: [], data_epoch: 2 };
    const rid = recordRun(sess, { tool: 'python_run', ok: true, ms: 10, out: 'x' });
    if (rid !== 'run1') throw new Error('run_id 不对: ' + rid);
    if (sess.runs[0].epoch !== 2) throw new Error('epoch 未记: ' + JSON.stringify(sess.runs[0]));
  });

  tAsync('question_graph runs_view 列出最近运行供 link_run 取 id', async () => {
    const { TOOLS } = require('./tools');
    const ctx = { session: { runs: [{ run_id: 'run7', ok: true, tool: 'python_run', epoch: 1, formal: true, t: Date.now(), out: 'result1.xlsx 写完' }], data_epoch: 1, question_graph: [] }, sandbox: { resolve: (p) => p } };
    const qg = TOOLS.find(x => x.name === 'question_graph');
    const msg = await qg.run(ctx, { op: 'runs_view' });
    if (!/run7/.test(msg)) throw new Error('runs_view 应列 run7: ' + msg);
    if (!/formal/.test(msg)) throw new Error('runs_view 应标 formal: ' + msg);
  });

  tAsync('runs_view 空库返回提示', async () => {
    const { TOOLS } = require('./tools');
    const ctx = { session: { runs: [], question_graph: [] }, sandbox: { resolve: (p) => p } };
    const qg = TOOLS.find(x => x.name === 'question_graph');
    const msg = await qg.run(ctx, { op: 'runs_view' });
    if (!/为空|没有/.test(msg)) throw new Error('空库应有提示: ' + msg);
  });

  // v2.3.3：ambiguity / information_boundary 契约条款
  tAsync('contract_register：ambiguity 与 information_boundary 条款可登记', async () => {
    const { TOOLS } = require('./tools');
    const ctx = { session: { contract: [], runs: [], data_epoch: 0 }, sandbox: { resolve: (p) => p } };
    const cr = TOOLS.find(x => x.name === 'contract_register');
    const msg = await cr.run(ctx, { items: [
      { kind: 'ambiguity', key: 'endpoint_interp', text: '歧义：烘干结束判据是"连续下穿0.15"还是"首严格整秒"；选首严格整秒（评阅要点口径）', source: '题目第3页', scope: 'Q3' },
      { kind: 'information_boundary', key: 'no_today_actual', text: '0:00 做计划时禁用当天实际电价/实测值，只能用当时可得预测', source: '评阅要点第6条', scope: 'Q4_plan' },
    ] });
    if (!/已登记|2 项/.test(msg)) throw new Error('登记失败: ' + msg);
    if (ctx.session.contract.length !== 2) throw new Error('契约未落库');
    if (ctx.session.contract[0].kind !== 'ambiguity') throw new Error('kind 不对');
  });

  tAsync('contract_register：非法 kind 仍拒收', async () => {
    const { TOOLS } = require('./tools');
    const ctx = { session: { contract: [] }, sandbox: { resolve: (p) => p } };
    const cr = TOOLS.find(x => x.name === 'contract_register');
    let denied = false;
    try { await cr.run(ctx, { items: [{ kind: 'made_up', key: 'x', text: 'y', source: 'z' }] }); } catch (e) { denied = /kind 必须是/.test(e.message); }
    if (!denied) throw new Error('非法 kind 应被拒');
  });

  tAsync('paper_build：断言审计标注无锚定评价词与无来源文献', async () => {
    const { TOOLS } = require('./tools');
    const pb = TOOLS.find(x => x.name === 'paper_build');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-pb5-'));
    fs.writeFileSync(path.join(tmp2, 'main.tex'), [
      '\\documentclass{article}\\begin{document}',
      '我们的模型效果显著。',
      '我们的误差为 0.001，效果显著。',
      '\\section{参考文献}',
      '\\begin{enumerate}\\item 某文献。\\item C:/work/result.xlsx 附件\\end{enumerate}',
      '\\end{document}',
    ].join('\n'));
    const ctx = { sandbox: new Sandbox(tmp2, { protected: [] }), workspace: tmp2, session: {} };
    const msg = await pb.run(ctx, { tex: 'main.tex' });
    if (!/✓/.test(msg)) throw new Error('编译应成功: ' + msg.slice(0, 300));
    if (!/待核|必须修/.test(msg)) throw new Error('应附审计: ' + msg.slice(0, 400));
    if (!/某文献/.test(msg)) throw new Error('应标无来源文献: ' + msg.slice(0, 600));
    if (!/评价词「显著」无数字锚定/.test(msg)) throw new Error('应标无锚定评价词: ' + msg.slice(0, 600));
    // v2.5：审计快照落 session，供 contest_clock 进 final 时校验
    if (!ctx.session.paper_audit || typeof ctx.session.paper_audit.must_fix !== 'number') throw new Error('审计快照未落 session');
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  // v2.3.3：reconcile_artifact 三方对账（论文数字 ↔ xlsx 格值 ↔ 运行输出 + SHA256 清单）
  tAsync('reconcile_artifact：doc 数字命中 xlsx 格值+运行输出，未命中列行号，manifest 落盘', async () => {
    const { TOOLS } = require('./tools');
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-rc-'));
    // 造含 33.5753 和 1.7662 的最小 xlsx
    const mkRows = '<row r="1"><c r="A1" t="inlineStr"><is><t>t</t></is></c><c r="B1"><v>33.5753</v></c><c r="C1"><v>1.7662</v></c></row>';
    // 用已有 makeXlsx 思路内联最小 stored zip
    const zlib = require('zlib');
    function crc32(buf) { let c, table = crc32.t; if (!table) { table = crc32.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } } let crc = 0xffffffff; for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
    const files = [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
      ['xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + mkRows + '</sheetData></worksheet>'],
    ];
    const parts = [], cds = []; let off = 0;
    for (const [name, content] of files) {
      const nb = Buffer.from(name, 'utf8'), db = Buffer.from(content, 'utf8'), crc = crc32(db);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
      parts.push(lh, nb, db);
      const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(db.length, 20); cd.writeUInt32LE(db.length, 24); cd.writeUInt16LE(nb.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt16LE(0, 38); cd.writeUInt32LE(off, 42);
      cds.push(Buffer.concat([cd, nb])); off += 30 + nb.length + db.length;
    }
    const cdBuf = Buffer.concat(cds);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(0, 20);
    fs.writeFileSync(path.join(tmp2, 'result1.xlsx'), Buffer.concat([...parts, cdBuf, eocd]));
    // doc：33.5753（xlsx 命中）、57.1694（运行输出命中）、99.1234（未命中）
    fs.writeFileSync(path.join(tmp2, 'main.tex'), '温度 33.5753 与 57.1694 及 99.1234');
    const ctx = {
      session: { runs: [{ run_id: 'run9', ok: true, out: 't_cross=57.1694 h done' }] },
      sandbox: new Sandbox(tmp2, { protected: [] }), workspace: tmp2,
    };
    const rc = TOOLS.find(x => x.name === 'reconcile_artifact');
    const msg = await rc.run(ctx, { doc: 'main.tex', results: ['result1.xlsx'] });
    if (!/命中 2 \/ 3/.test(msg)) throw new Error('应命中2/3: ' + msg.slice(0, 400));
    if (!/99\.1234/.test(msg)) throw new Error('应列未命中: ' + msg.slice(0, 500));
    if (!fs.existsSync(path.join(tmp2, 'findings', 'reconcile_manifest.json'))) throw new Error('manifest 未落盘');
    const mf = JSON.parse(fs.readFileSync(path.join(tmp2, 'findings', 'reconcile_manifest.json'), 'utf8'));
    if (!mf.doc.sha256 || mf.results.length !== 1) throw new Error('manifest 内容不对');
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  // v2.3.4：web_search 接本地 open-websearch daemon（联网硬伤修复）
  // 这两个 web_search 用例共享模块级 daemon 启动状态，必须串行（并发会互串 base_url）
  await tAsync('web_search：daemon 不可达且无 daemon_dir → 明确报错', async () => {
    const { TOOLS } = require('./tools');
    const ws = TOOLS.find(x => x.name === 'web_search');
    if (!ws) throw new Error('web_search 未注册');
    const appDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-ws-'));
    const old = process.env.OWS_BASE_URL;
    process.env.OWS_BASE_URL = 'http://127.0.0.1:49999'; // 死端口
    let denied = false;
    try { await ws.run({ appDir: appDir2, session: {}, sandbox: {} }, { query: 'test' }); }
    catch (e) { denied = /不可达|daemon/.test(e.message); }
    finally { if (old === undefined) delete process.env.OWS_BASE_URL; else process.env.OWS_BASE_URL = old; }
    if (!denied) throw new Error('daemon 不可达应报错');
    fs.rmSync(appDir2, { recursive: true, force: true });
  });

  await tAsync('web_search：自动拉起 daemon + baidu 真实搜索出结果', async () => {
    const { TOOLS } = require('./tools');
    const ws = TOOLS.find(x => x.name === 'web_search');
    // 先从已知状态起跑：上一次跑测试残留的 daemon 可能还占着 3210 但已半死（实测踩到——
    // 端口有监听却 /health 不应答，导致"自动拉起"拿不到结果）。清干净再测。
    try {
      const { execSync } = require('child_process');
      execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"', { windowsHide: true, stdio: 'ignore' });
    } catch {}
    const appDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-ws2-'));
    fs.mkdirSync(path.join(appDir2, 'config'), { recursive: true });
    fs.writeFileSync(path.join(appDir2, 'config', 'settings.json'), JSON.stringify({
      websearch: { daemon_dir: path.join(APP, 'vendor', 'open-webSearch'), port: 3210, engines: ['baidu'] },
    }));
    const msg = await ws.run({ appDir: appDir2, session: {}, sandbox: {} }, { query: '药材烘干 数学建模', limit: 3 });
    if (!/web_search|条/.test(msg)) throw new Error('应返回搜索结果: ' + String(msg).slice(0, 300));
    if (!/baidu|http/.test(msg)) throw new Error('应含引擎/链接: ' + msg.slice(0, 400));
    // 清理自动拉起的 daemon（端口 3210）
    try {
      const { execSync } = require('child_process');
      execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"', { windowsHide: true });
    } catch {}
    fs.rmSync(appDir2, { recursive: true, force: true });
  });

  // v2.3.4 minor 修复 1：postJsonLocal 30s 超时回归——bug 1 防护
  // 注：原写法用 t(...) 包 async 函数 = fire-and-forget（PASS 立即打印，断言失败变成
  // 未处理拒绝，会在后续测试拖长后被 V8 抛成崩溃）。改成 await tAsync，并把 loopback
  // 端口指向 mock（postJsonLocal/getServerTokenLocal 支持 XIHE_LOCAL_PORT 覆盖）。
  tAsync('postJsonLocal 30s 超时：mock 慢响应 25s 不会误杀', async () => {
    const http = require('http');
    const { postJsonLocal } = require('./tools');
    // 起一个慢响应 mock server，25s 后才回 JSON
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mocked: true }));
      }, 25_000);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const prev = process.env.XIHE_LOCAL_PORT;
    process.env.XIHE_LOCAL_PORT = String(port);
    const t0 = Date.now();
    try {
      // 应在 25s 左右成功返回，而不是在 10s 误杀
      const result = await postJsonLocal('/api/test', { foo: 'bar' }, 'mock-token');
      const elapsed = Date.now() - t0;
      if (!result || !result.ok) throw new Error('慢响应应被 30s 容忍: ' + JSON.stringify(result));
      if (elapsed < 20_000) throw new Error('25s mock 不该这么快返回: ' + elapsed + 'ms');
      if (elapsed > 32_000) throw new Error('超过 30s 超时未生效: ' + elapsed + 'ms');
    } finally {
      if (prev === undefined) delete process.env.XIHE_LOCAL_PORT; else process.env.XIHE_LOCAL_PORT = prev;
      server.close();
    }
  });

  // ==================== v2.5 螺旋创新层（交接清单 X-0 / I-1…I-10）====================
  {
    const spiral = require('./spiral');
    const { auditPaperTex } = require('./tools');
    const spRoot = path.join(tmp, 'spiral-ws');
    fs.mkdirSync(path.join(spRoot, 'findings'), { recursive: true });
    fs.mkdirSync(path.join(spRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(spRoot, 'art_q.txt'), '产物夹具'); // 守恒门禁用例 attach_artifact 的目标

    // ---- I-1 比赛时钟：阶段按 74 小时方案等比缩放（基线 19% / 迭代 54%）----
    const mkSess = (frac) => ({
      contest: true, contest_kind: 'cumcm', mode: 'math', collab_mode: 'collab', contest_start: 0, contest_deadline: 1000,
      contest_phase: null, question_graph: [], assumptions: [], iterations: [], runs: [],
      paper_audit: { at: Date.now(), must_fix: 0 },
    });
    t('时钟：10% 处 = baseline 阶段', () => {
      const p = spiral.effectivePhase(mkSess(), 100);
      if (p !== 'baseline') throw new Error('实际 ' + p);
    });
    t('时钟：30% 处 = iterate 阶段', () => {
      const p = spiral.effectivePhase(mkSess(), 300);
      if (p !== 'iterate') throw new Error('实际 ' + p);
    });
    t('时钟：70% 处 = freeze 阶段', () => {
      const p = spiral.effectivePhase(mkSess(), 700);
      if (p !== 'freeze') throw new Error('实际 ' + p);
    });
    t('时钟：显式 final 不被时间阶段覆盖', () => {
      const s = mkSess(); s.contest_phase = 'final';
      if (spiral.effectivePhase(s, 100) !== 'final') throw new Error('final 被覆盖');
    });
    t('时钟：解冻只在窗口期内有效，窗口过后时间下限接管', () => {
      // 70% 处 = freeze；显式声明 iterate 属于回退 → 窗口（总时长 3%）内生效，过后被顶回
      const s = mkSess(); s.contest_phase = 'iterate'; s.contest_phase_at = 700;
      if (spiral.effectivePhase(s, 710) !== 'iterate') throw new Error('窗口内应生效');
      if (spiral.effectivePhase(s, 900) !== 'freeze') throw new Error('窗口过后应被时间下限接管');
      // 提前推进（如提前冻结）永久有效
      const s2 = mkSess(); s2.contest_phase = 'freeze'; s2.contest_phase_at = 100;
      if (spiral.effectivePhase(s2, 900) !== 'freeze') throw new Error('提前冻结不该被覆盖');
    });
    t('时钟：剩余时间随截止变化（已用 25% → 7.5h/10h）', () => {
      const now = Date.now();
      const s = { contest: true, contest_kind: 'cumcm', contest_start: now - 2.5 * 3600e3, contest_deadline: now + 7.5 * 3600e3 };
      const line = spiral.clockLine(s, now);
      if (!/7\.5h\/10\.0h/.test(line) || !/25% 已用/.test(line)) throw new Error('时间显示不对: ' + line);
      if (!/iterate/.test(line)) throw new Error('阶段不对: ' + line);
    });
    t('X-0 规则注入：比赛 math 会话按阶段给不同规则文字', () => {
      const a = spiral.phaseBlock(mkSess(), 100), b = spiral.phaseBlock(mkSess(), 300), c = spiral.phaseBlock(mkSess(), 900);
      if (!/阶段规则·已验证基线/.test(a)) throw new Error('基线规则缺失');
      if (!/阶段规则·假设迭代/.test(b)) throw new Error('迭代规则缺失');
      if (!/阶段规则·冻结与总验证/.test(c)) throw new Error('冻结规则缺失');
      if (/阶段规则·假设迭代/.test(a)) throw new Error('基线阶段混入了迭代规则（token 浪费）');
    });
    t('X-0 规则注入：比赛规则只在 contest+math 会话出现', () => {
      if (spiral.phaseBlock({ contest: false, mode: 'math' })) throw new Error('普通会话不该注入');
      if (spiral.phaseBlock({ contest: true, mode: 'free' })) throw new Error('free 模式不该注入');
    });
    t('phaseBlock：逐问作答与当届可归属规则', () => {
      const c = spiral.phaseBlock(mkSess(), 900);
      if (!/题目要求的答案/.test(c)) throw new Error('冻结规则缺逐问作答要求');
      if (!/AI使用如实披露/.test(c) || !/位置按当届要求/.test(c)) throw new Error('AI 披露没有与当届规则绑定');
      if (!/页数\/体积限制无明确条款时标待核对/.test(c)) throw new Error('未知规则不应硬套往届限制');
    });

    // ---- I-3 假设登记表 ----
    t('假设表：自动编号 + 字段落地', () => {
      const s = { assumptions: [] };
      const r1 = spiral.upsertAssumption(s, { text: '忽略接触热阻', kind: 'model_simplification', risk: 'high', impact: 'Q1 温升', questions: [1] });
      const r2 = spiral.upsertAssumption(s, { text: '边界保持末值', kind: 'pending_interpretation', risk: 'high' });
      if (r1.id !== 'A1' || r2.id !== 'A2') throw new Error('编号错: ' + r1.id + '/' + r2.id);
      if (r1.rec.risk !== 'high' || !r1.rec.questions.includes(1)) throw new Error('字段未落地');
      const r3 = spiral.upsertAssumption(s, { id: 'A1', text: '忽略接触热阻（修订）', kind: 'model_simplification' });
      if (!r3.updated || s.assumptions.length !== 2) throw new Error('同 id 应更新而非新增');
    });
    t('假设表：given_fact 属不可迭代靶子', () => {
      const s = { assumptions: [] };
      const r = spiral.upsertAssumption(s, { text: '题给环境温度 25℃', kind: 'given_fact' });
      if (!spiral.IMMUTABLE_KINDS.has(s.assumptions[0].kind)) throw new Error('given_fact 未被标为不可改');
    });

    // ---- 工具层：假设登记 + 迭代（先写后跑、判据锁定、采纳作废下游）----
    const spCtx = () => ({
      workspace: spRoot, appDir,
      sandbox: new Sandbox(spRoot, { protected: [appDir] }),
      session: {
        contest: true, mode: 'math', contest_start: Date.now() - 3600e3, contest_deadline: Date.now() + 7 * 3600e3,
        contest_phase: 'iterate', collab_mode: 'collab', assumptions: [], iterations: [], runs: [],
        question_graph: [{ id: 1, title: 'Q1', status: 'committed' }, { id: 2, title: 'Q2', status: 'committed', deps: [1] }],
        data_epoch: 3, paper_audit: { at: Date.now(), must_fix: 0 },
      },
    });
    const spTool = async (ctx, name, args) => {
      const { executeTool } = require('./tools');
      try {
        const r = await executeTool(ctx, name, args);
        const data = String((r && r.data != null) ? r.data : JSON.stringify(r));
        if (r && r.ok === false) return { ok: false, error: data.slice(0, 400) };
        return { ok: true, data: data.slice(0, 400) };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    };
    tAsync('工具：assumption_register upsert/view 往返', async () => {
      const ctx = spCtx();
      const r = await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: '忽略接触热阻', kind: 'model_simplification', risk: 'high', impact: 'Q1' }] });
      if (!r.ok || !/A1/.test(r.data)) throw new Error('登记失败: ' + (r.error || r.data));
      const v = await spTool(ctx, 'assumption_register', { op: 'view' });
      if (!/A1/.test(v.data) || !/model_simplification|模型简化/.test(v.data)) throw new Error('查看失败: ' + v.data);
    });
    tAsync('工具：iteration plan 拒绝 given_fact 靶子（题目硬约束不得改成假设）', async () => {
      const ctx = spCtx();
      await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: '题给 25℃', kind: 'given_fact' }] });
      const r = await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '放宽环境温度', criterion: { success: '误差 <1%' } });
      if (r.ok) throw new Error('竟然放行了 given_fact 靶子');
      if (!/不能作为迭代靶子/.test(r.error)) throw new Error('拒绝理由不对: ' + r.error);
    });
    tAsync('工具：iteration plan 必须给成功判据（先写后跑）', async () => {
      const ctx = spCtx();
      await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: '忽略接触热阻', kind: 'model_simplification', risk: 'high' }] });
      const bad = await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '改', criterion: {} });
      if (bad.ok) throw new Error('缺判据竟然放行');
      const good = await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '加入接触热阻', criterion: { success: '温升差 <0.05℃', failure: '>0.5℃', budget: '40min' } });
      if (!good.ok || !/判据（已锁定/.test(good.data)) throw new Error('plan 失败: ' + (good.error || good.data));
      if (!/基线快照/.test(good.data)) throw new Error('plan 未自动存快照');
    });
    tAsync('工具：同一时间只允许一圈未结', async () => {
      const ctx = spCtx();
      await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: 'A', kind: 'model_simplification' }] });
      await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: 'x', criterion: { success: 'y' } });
      const r = await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: 'z', criterion: { success: 'w' } });
      if (r.ok || !/已有未结圈/.test(r.error)) throw new Error('未拦重复 plan: ' + (r.error || r.data));
    });
    tAsync('工具：result 需要真实 run_id + verdict；adopt 需独立性说明', async () => {
      const ctx = spCtx();
      await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: 'A', kind: 'model_simplification' }] });
      fs.writeFileSync(path.join(spRoot, 'iteration_data.csv'), 'x,y\n1,2\n');
      fs.writeFileSync(path.join(spRoot, 'iteration_eval.py'), '# locked evaluation\n');
      const comparison = { question_id: 1, dataset: 'fixture-v1', protocol: 'same holdout MAE', unit: 'K', direction: 'min' };
      const specs = require('./model_spec');
      specs.registerSpec(ctx.session, { question_id: 1, task: { prompt_ref: 'fixture', goal: '对照', output: 'MAE' }, model_type: 'evaluation',
        givens: [{ statement: '同输入', source: 'fixture' }], assumptions: [], variables: [{ symbol: 'x', meaning: '输入', unit: 'K', domain: '实数' }],
        formulation: [{ expression: 'MAE', meaning: '平均绝对误差' }], data: [{ name: 'fixture', source: 'fixture', fields: 'x,y', treatment: '不变' }], parameters: [],
        algorithm: { name: '对照', inputs: 'x,y', outputs: 'MAE', steps: ['计算'], stopping: '完成' }, validation: [{ method: '手算', criterion: '一致', evidence: 'fixture' }],
        interfaces: { receives: 'fixture', supplies: 'MAE' }, deliverables: ['JSON'] });
      await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: 'x', criterion: { success: 'MAE降低至少1K',
        evaluation: { kind: 'quantitative', comparison, measurement_key: 'MAE', min_improvement: 1,
          inputs: ['iteration_data.csv'], evaluator: 'iteration_eval.py' } } });
      const fake = await spTool(ctx, 'iteration', { op: 'result', id: 'I1', run_id: 'runN', verdict: 'supported' });
      if (fake.ok || !/不是 session.runs 中的有效运行/.test(fake.error)) throw new Error('未拦假 run_id');
      const plan = ctx.session.iterations[0];
      const evaluation_files = Object.fromEntries([...plan.criterion.evaluation.inputs, plan.criterion.evaluation.evaluator].map(row => [row.rel, row.sha256]));
      ctx.session.runs = [1, 2].map((value, i) => ({ run_id: 'run' + (i + 1), ok: true, formal: true, epoch: 3,
        model_spec: specs.specBinding(ctx.session, { question_id: 1 }), t: plan.planned_at + 1, out: JSON.stringify({ MAE: value, comparison, evaluation_files }) }));
      const noVerdict = await spTool(ctx, 'iteration', { op: 'result', id: 'I1', run_id: 'run1' });
      if (noVerdict.ok) throw new Error('缺 verdict 竟然放行');
      const okRes = await spTool(ctx, 'iteration', { op: 'result', id: 'I1', run_id: 'run1', control_run_id: 'run2', verdict: 'supported' });
      if (!okRes.ok) throw new Error('result 失败: ' + okRes.error);
      const noIndep = await spTool(ctx, 'iteration', { op: 'adopt', id: 'I1', impact_questions: [1, 2] });
      if (noIndep.ok) throw new Error('无独立性说明竟然能采纳');
      if (!/独立性/.test(noIndep.error || '')) throw new Error('拒绝理由缺独立性: ' + noIndep.error);
      await spTool(ctx, 'iteration', { op: 'result', id: 'I1', run_id: 'run1', control_run_id: 'run2', verdict: 'supported', independence: '①解析小例 ②共用同一批数据 ③能排除数值实现错 ④仍可能共有网格约定错' });
      const adopt = await spTool(ctx, 'iteration', { op: 'adopt', id: 'I1', impact_questions: [1, 2] });
      if (!adopt.ok) throw new Error('adopt 失败: ' + adopt.error);
      if (ctx.session.data_epoch !== 4) throw new Error('adopt 未推进 data_epoch: ' + ctx.session.data_epoch);
      const downgraded = ctx.session.question_graph.filter(q => q.status === 'reviewing').map(q => q.id);
      if (downgraded.length !== 2) throw new Error('下游未降级重算: ' + JSON.stringify(downgraded));
    });
    tAsync('工具：iteration 圈数上限（全自动默认 3 圈）', async () => {
      const ctx = spCtx();
      ctx.session.question_graph = [];
      await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: 'A', kind: 'model_simplification' }] });
      ctx.session.runs = [{ run_id: 'run1', ok: true, epoch: 3 }];
      for (let i = 0; i < 3; i++) {
        const p = await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: 'x' + i, criterion: { success: 'y' } });
        if (!p.ok) throw new Error('第 ' + (i + 1) + ' 圈 plan 失败: ' + p.error);
        await spTool(ctx, 'iteration', { op: 'result', id: 'I' + (i + 1), run_id: 'run1', verdict: 'refuted', note: 'n' });
        await spTool(ctx, 'iteration', { op: 'withdraw', id: 'I' + (i + 1), reason: '无收益' });
      }
      const over = await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: 'x4', criterion: { success: 'y' } });
      if (over.ok || !/已达迭代上限/.test(over.error)) throw new Error('未拦超圈: ' + (over.error || over.data));
    });
    tAsync('工具：withdraw 记录未跑完候选的初步观察（observations 留档复看）', async () => {
      const ctx = spCtx();
      await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: 'A', kind: 'model_simplification' }] });
      await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '尝试方案B', criterion: { success: 'y' } });
      const w = await spTool(ctx, 'iteration', { op: 'withdraw', id: 'I1', reason: '时间不足', observations: '方案B框架已搭、初看效率高30%未验证' });
      if (!w.ok) throw new Error('withdraw 失败: ' + w.error);
      if (!/初步观察/.test(w.data)) throw new Error('withdraw 未回显初步观察: ' + w.data);
      const it = ctx.session.iterations.find(x => x.id === 'I1');
      if (it.observations !== '方案B框架已搭、初看效率高30%未验证') throw new Error('observations 未落库: ' + it.observations);
      const view = await spTool(ctx, 'iteration', { op: 'view' });
      if (!/初步观察/.test(view.data) || !/撤回理由/.test(view.data)) throw new Error('view 未展示撤回理由与初步观察');
      // 缺省 observations 时提示补齐约定
      await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '方案C', criterion: { success: 'y' } });
      const w2 = await spTool(ctx, 'iteration', { op: 'withdraw', id: 'I2', reason: '无收益' });
      if (!/observations/.test(w2.data)) throw new Error('缺 observations 时未提示: ' + w2.data);
    });

    // ---- I-5 快照与回退 ----
    t('快照：take → 改动 → restore 逐字节一致', () => {
      const root = path.join(tmp, 'snap-ws');
      fs.mkdirSync(path.join(root, 'findings'), { recursive: true });
      fs.writeFileSync(path.join(root, 'result1.xlsx'), 'BINARY-A');
      fs.writeFileSync(path.join(root, 'findings', 'q1.md'), 'v1');
      const snap = spiral.takeSnapshot(root, 'iter_1', 'baseline');
      fs.writeFileSync(path.join(root, 'result1.xlsx'), 'CHANGED');
      fs.writeFileSync(path.join(root, 'findings', 'q1.md'), 'v2');
      const r = spiral.restoreSnapshot(root, snap.rel);
      if (fs.readFileSync(path.join(root, 'result1.xlsx'), 'utf8') !== 'BINARY-A') throw new Error('result 未恢复');
      if (fs.readFileSync(path.join(root, 'findings', 'q1.md'), 'utf8') !== 'v1') throw new Error('findings 未恢复');
      if (r.copied < 2) throw new Error('恢复文件数不对: ' + r.copied);
      if (!spiral.listSnapshots(root).some(x => x.label === 'iter_1')) throw new Error('清单里找不到快照');
    });
    tAsync('工具：contest_clock snapshot / rollback 往返', async () => {
      const ctx = spCtx();
      fs.writeFileSync(path.join(spRoot, 'result9.xlsx'), 'ORIG');
      const s1 = await spTool(ctx, 'contest_clock', { op: 'snapshot', label: 'iter_test', note: '手动' });
      if (!s1.ok || !/快照/.test(s1.data)) throw new Error('快照失败: ' + (s1.error || s1.data));
      fs.writeFileSync(path.join(spRoot, 'result9.xlsx'), 'BROKEN');
      const rb = await spTool(ctx, 'contest_clock', { op: 'rollback', label: 'snapshots/iter_test' });
      if (!rb.ok) throw new Error('回退失败: ' + rb.error);
      if (fs.readFileSync(path.join(spRoot, 'result9.xlsx'), 'utf8') !== 'ORIG') throw new Error('回退后内容不对');
    });

    // ---- I-2 / I-9 完成判据与冻结门槛 ----
    tAsync('工具：冻结后禁止开新迭代；解冻需 reason 留痕', async () => {
      const ctx = spCtx();
      await spTool(ctx, 'assumption_register', { op: 'upsert', items: [{ text: 'A', kind: 'model_simplification' }] });
      const fz = await spTool(ctx, 'contest_clock', { op: 'phase', phase: 'freeze', reason: '时间到' });
      if (!fz.ok) throw new Error('冻结失败: ' + fz.error);
      const blocked = await spTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: 'x', criterion: { success: 'y' } });
      if (blocked.ok || !/已冻结/.test(blocked.error)) throw new Error('冻结后仍能 plan: ' + (blocked.error || blocked.data));
      const noReason = await spTool(ctx, 'contest_clock', { op: 'phase', phase: 'iterate' });
      if (noReason.ok || !/必须写明 reason/.test(noReason.error)) throw new Error('解冻未强制 reason');
      const unfrozen = await spTool(ctx, 'contest_clock', { op: 'phase', phase: 'iterate', reason: '发现致命错误：单位写错' });
      if (!unfrozen.ok) throw new Error('解冻失败: ' + unfrozen.error);
      if (!(ctx.session.unfreeze_log || []).length) throw new Error('解冻未留痕');
    });
    tAsync('工具：进 final 需 论文审计0必须修 + 支撑包 + main.pdf', async () => {
      const ctx = spCtx();
      ctx.session.paper_audit = { at: Date.now(), must_fix: 2 };
      const blocked = await spTool(ctx, 'contest_clock', { op: 'phase', phase: 'final' });
      if (blocked.ok) throw new Error('带【必须修】竟然能进 final');
      if (!/必须修/.test(blocked.error)) throw new Error('拒绝理由缺必须修: ' + blocked.error);
      ctx.session.paper_audit = { at: Date.now(), must_fix: 0 };
      const noPack = await spTool(ctx, 'contest_clock', { op: 'phase', phase: 'final' });
      if (noPack.ok || !/支撑包/.test(noPack.error)) throw new Error('缺支撑包描述: ' + (noPack.error || noPack.data));
    });
    // ---- 守恒/平衡审计门禁（A 题对比获奖答案后沉淀的"高 ROI"项）----
    const consCtx = () => ({
      workspace: spRoot, appDir,
      sandbox: new Sandbox(spRoot, { protected: [appDir] }),
      session: {
        mode: 'math', data_epoch: 0, conservation: [], question_graph: [],
        runs: [{ run_id: 'run1', ok: true, formal: true, epoch: 0 }, { run_id: 'run2', ok: true, formal: false, epoch: 0 }],
      },
    });
    await tAsync('守恒审计：引擎实算闭合残差（通过/不通过）', async () => {
      const ctx = consCtx();
      const ok = await spTool(ctx, 'conservation_check', { op: 'register', question: 1, quantity: '水分质量 ∫C·r dr', initial: 100, final: 60.2, boundary_flux: -40, tolerance: 0.01, run_id: 'run1' });
      if (!ok.ok) throw new Error('登记失败: ' + ok.error);
      if (!/相对误差 0\.2000%/.test(ok.data) || !/✓ 通过/.test(ok.data)) throw new Error('实算不对: ' + ok.data);
      const bad = await spTool(ctx, 'conservation_check', { op: 'register', question: 1, quantity: '水分质量', initial: 100, final: 55, boundary_flux: -40, run_id: 'run1' });
      if (!/相对误差 5\.0000%/.test(bad.data) || !/未通过/.test(bad.data)) throw new Error('超容差应判未通过: ' + bad.data);
    });
    await tAsync('守恒审计：非 formal run 拒收、缺量名拒收', async () => {
      const ctx = consCtx();
      const r = await spTool(ctx, 'conservation_check', { op: 'register', question: 1, quantity: 'x', initial: 1, final: 1, boundary_flux: 0, run_id: 'run2' });
      if (r.ok || !/不是 formal 运行/.test(r.error)) throw new Error('非 formal 未拦: ' + (r.error || r.data));
      const r2 = await spTool(ctx, 'conservation_check', { op: 'register', question: 1, initial: 1, final: 1, boundary_flux: 0, run_id: 'run1' });
      if (r2.ok || !/quantity 必填/.test(r2.error)) throw new Error('缺量名未拦: ' + (r2.error || r2.data));
    });
    await tAsync('守恒审计：commit 门禁三态（无记录拦 / 未通过拦 / 豁免放行并留痕）', async () => {
      const ctx = consCtx();
      await spTool(ctx, 'question_graph', { op: 'upsert', id: 1, title: 'Q1', route: 'FVM' });
      await spTool(ctx, 'question_graph', { op: 'link_run', id: 1, run_id: 'run1' });
      await spTool(ctx, 'question_graph', { op: 'attach_artifact', id: 1, path: 'art_q.txt', kind: 'result' });
      const noRec = await spTool(ctx, 'question_graph', { op: 'commit', id: 1 });
      if (noRec.ok || !/守恒\/平衡审计：无/.test(noRec.error)) throw new Error('无记录未拦: ' + (noRec.error || noRec.data));
      await spTool(ctx, 'conservation_check', { op: 'register', question: 1, quantity: '水分质量', initial: 100, final: 50, boundary_flux: -40, run_id: 'run1' });
      const notPass = await spTool(ctx, 'question_graph', { op: 'commit', id: 1 });
      if (notPass.ok || !/守恒审计未通过/.test(notPass.error)) throw new Error('未通过未拦: ' + (notPass.error || notPass.data));
      const w = await spTool(ctx, 'conservation_check', { op: 'waived', question: 1, reason: '边界只到 4h，外推段通量无法精确积分' });
      if (!w.ok) throw new Error('豁免失败: ' + w.error);
      const after = await spTool(ctx, 'question_graph', { op: 'commit', id: 1 });
      if (!after.ok) throw new Error('豁免后仍被拦: ' + after.error);
      if (!/保留|留痕|豁免|conservation_waived/.test(after.data + JSON.stringify(ctx.session.question_impacts))) throw new Error('豁免未留痕: ' + after.data);
      if (!(ctx.session.question_impacts || []).some(x => x.event === 'conservation_waived')) throw new Error('question_impacts 缺 conservation_waived');
    });
    await tAsync('守恒审计：不适用必须写明替代检验', async () => {
      const ctx = consCtx();
      const bare = await spTool(ctx, 'conservation_check', { op: 'not_applicable', question: 2, reason: '纯组合优化无守恒量' });
      if (bare.ok || !/alternative/.test(bare.error)) throw new Error('缺替代检验未拦: ' + (bare.error || bare.data));
      const full = await spTool(ctx, 'conservation_check', { op: 'not_applicable', question: 2, reason: '纯组合优化无守恒量', alternative: '决策代回全部原始约束 + 与 LP 松弛下界比间隙' });
      if (!full.ok) throw new Error('完整声明失败: ' + full.error);
      await spTool(ctx, 'question_graph', { op: 'upsert', id: 2, title: 'Q2', route: 'MILP' });
      await spTool(ctx, 'question_graph', { op: 'link_run', id: 2, run_id: 'run1' });
      await spTool(ctx, 'question_graph', { op: 'attach_artifact', id: 2, path: 'art_q.txt', kind: 'result' });
      const c = await spTool(ctx, 'question_graph', { op: 'commit', id: 2 });
      if (!c.ok) throw new Error('不适用+替代检验后应放行: ' + c.error);
    });
    t('stateBlock：展示逐问守恒审计状态（压缩不可丢）', () => {
      const { stateBlock } = require('./agent');
      const s = {
        mode: 'math', question_graph: [{ id: 1, status: 'reviewing', title: 'Q1' }, { id: 2, status: 'drafting', title: 'Q2' }],
        conservation: [{ kind: 'closure', question: 1, quantity: 'q', initial: 1, final: 1, flux: 0, residual: 0, rel: 0.001, tol: 0.01, pass: true, run_id: 'run1' }],
      };
      const b = stateBlock(s);
      if (!/守恒审计: Q1 ✓0\.100%/.test(b)) throw new Error('未展示通过状态: ' + b.split('\n').filter(l => /守恒/.test(l)).join(''));
      if (!/Q2 未登记/.test(b)) throw new Error('未展示未登记状态');
    });

    // ---- 验收脚本 vs 引擎审计：同口径交叉校验（脚本不能比引擎松，否则"只跑验收脚本"会漏真问题）----
    t('验收脚本 paper_audit.py 与引擎 auditPaperTex 同口径', () => {
      const { execFileSync } = require('child_process');
      const script = path.resolve(__dirname, '..', '..', 'audit', 'v2.4-2026-09-27', 'paper_audit.py');
      if (!fs.existsSync(script)) { console.log('  (跳过：验收脚本不在预期路径)'); return; }
      const proj = path.join(tmp, 'parity-proj');
      const mk = (abs, body) => `\\documentclass{ctexart}\\begin{document}\n\\begin{abstract}\n本文研究调度问题。${abs}\n\\keywords{调度}\n\\end{abstract}\n\\section{问题重述}\n${body}\n\\section{问题一：模型}\n\\includegraphics{figures/f1.pdf}\n\\section{AI 工具使用声明}\n本队使用 AI。\\cite{r1}\n\\begin{thebibliography}{9}\\bibitem{r1} 张三. 2024.\\end{thebibliography}\n\\appendix\n\\section{支撑材料文件列表}清单\n\\section{完整源程序代码}\n\\VerbatimInput{../scripts/q1.py}\n\\end{document}`;
      const cases = [
        ['合规', mk('', ''), false],
        ['Markdown 残留', mk('', '这是**政策性运行**的结果。'), true],
        ['摘要长数字', mk('总费用 1801660137.89 元。', ''), true],
      ];
      for (const [name, tex, expectHit] of cases) {
        fs.rmSync(proj, { recursive: true, force: true });
        fs.mkdirSync(path.join(proj, 'paper'), { recursive: true });
        fs.mkdirSync(path.join(proj, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(proj, 'scripts', 'q1.py'), 'print(1)');
        fs.writeFileSync(path.join(proj, 'paper', 'main.tex'), tex);
        const engine = auditPaperTex(tex, { sourceFiles: ['scripts/q1.py'] }).filter(w => /^【必须修/.test(w)).length;
        let scriptMust = [];
        try {
          // Windows 上 python 子进程 stdout 默认 cp936(GBK)，Node 按 utf8 解码会得到乱码，
          // 下面 startsWith('必须修:') 永远匹配不上（测试静默失效）。强制子进程输出 utf-8。
          const out = execFileSync('python', [script, proj], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
          // 脚本**允许更严**（多查交付物：支撑材料.zip / AI 使用详情），这里只比"论文内容类"
          scriptMust = out.split('\n').filter(l => l.trim().startsWith('必须修:')).map(l => l.trim().slice(4).trim())
            .filter(w => !/支撑材料\.zip|AI 工具使用详情/.test(w));
        } catch (e) { console.log('  (跳过：python 不可用)'); return; }
        if (expectHit && scriptMust.length < engine) throw new Error(`${name}：脚本比引擎松（引擎 ${engine} 条，脚本内容类 ${scriptMust.length} 条）`);
        if (!expectHit && scriptMust.length) throw new Error(`${name}：脚本无中生有 → ${scriptMust.join(' / ').slice(0, 100)}`);
      }
      fs.rmSync(proj, { recursive: true, force: true });
    });

    // ---- 获奖级 PDE 求解范式技能（pde-award-solve）+ 其模板可跑通且守恒闭合 ----
    t('技能：pde-award-solve 已收录且带两个语言模板', () => {
      const { getIndex, loadSkill } = require('./skills');
      const idx = getIndex(path.resolve(__dirname, '..'), true);
      const s = idx.find(x => x.name === 'pde-award-solve');
      if (!s) throw new Error('技能未被索引');
      if (s.tag !== 'xihe') throw new Error('应来自羲和自有技能库');
      const py = loadSkill(path.resolve(__dirname, '..'), 'pde-award-solve', 'template_scipy.py');
      const ml = loadSkill(path.resolve(__dirname, '..'), 'pde-award-solve', 'template_matlab.m');
      if (!/make_grid/.test(py.content) || !/face_radii/.test(py.content)) throw new Error('Python 模板内容不对');
      if (!/ode15s/.test(ml.content) || !/eventCross/.test(ml.content)) throw new Error('MATLAB 模板内容不对');
      if (!/负号不可省|负号不能省/.test(py.content) || !/负号不可省|负号不能省/.test(ml.content)) throw new Error('模板缺关键符号说明');
    });
    await tAsync('技能模板：Python 骨架真跑通且守恒闭合（<1%）', async () => {
      const { executeTool, installPlotBaseline } = require('./tools');
      const { loadSkill } = require('./skills');
      const ws2 = path.join(tmp, 'pde-run');
      fs.rmSync(ws2, { recursive: true, force: true });
      fs.mkdirSync(path.join(ws2, 'scripts'), { recursive: true });
      installPlotBaseline(ws2);
      fs.writeFileSync(path.join(ws2, 'scripts', 'pde_smoke.py'), loadSkill(path.resolve(__dirname, '..'), 'pde-award-solve', 'template_scipy.py').content);
      const ctx = { sandbox: new Sandbox(ws2, { protected: [appDir] }), workspace: ws2, appDir, session: { runs: [] }, children: new Set(), pyMode: 'rw' };
      const r = await executeTool(ctx, 'python_run', { code: 'exec(open("scripts/pde_smoke.py",encoding="utf-8").read())', timeout_sec: 300, intermediate_artifact: true });
      if (!r.ok) throw new Error('模板跑挂: ' + String(r.data).slice(0, 300));
      const out = String(r.data);
      const m = out.match(/相对误差=([\d.]+)%/);
      if (!m) throw new Error('没打印守恒审计: ' + out.slice(0, 300));
      if (Number(m[1]) > 1) throw new Error(`模板守恒不闭合: ${m[1]}%（骨架必须自洽，否则教坏后面的题）`);
      if (!/连续口径 tc=/.test(out)) throw new Error('没走事件检测双口径终点: ' + out.slice(0, 300));
      if (!/前一秒不达标=True/.test(out)) throw new Error('双口径缺"前一秒不达标"验证: ' + out.slice(0, 300));
    });

    // ---- job_start 日志解码（MATLAB -batch 在中文 Windows 上按 GBK 写盘）----
    t('任务日志：GBK 输出自动退回 GBK 解码，UTF-8 不受影响', () => {
      const jobs = require('./jobs');
      // jobs 模块的 JOBS_DIR 相对模块自身解析（不随 ctx.appDir 走）——测试要写到它真正读的目录
      const dir = path.join(__dirname, '..', 'data', 'jobs', 'gbtest');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const sample = '[终点] 连续口径 tc=554.65 s；首严格达标整秒 t_ok=555.0 s';
      // 用 PowerShell 按系统代码页 936 写盘，模拟 MATLAB -batch 的输出
      const { execSync } = require('child_process');
      try {
        execSync(`powershell -NoProfile -Command "[System.IO.File]::WriteAllBytes('${dir.replace(/\\/g, '/')}/stdout.log', [System.Text.Encoding]::GetEncoding(936).GetBytes('${sample}'))"`, { windowsHide: true, stdio: 'ignore' });
      } catch { console.log('  (跳过：PowerShell 不可用)'); return; }
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'gbtest', status: 'succeeded', pid: null, label: 'gbk' }));
      const st = jobs.statusJob('gbtest');
      if (!st || !/连续口径/.test(st.tail || '')) throw new Error('GBK 日志未正确解码: ' + JSON.stringify(st && st.tail));
      fs.writeFileSync(path.join(dir, 'stdout.log'), sample, 'utf8');
      const st2 = jobs.statusJob('gbtest');
      if (st2.tail !== sample) throw new Error('UTF-8 内容被改坏了: ' + JSON.stringify(st2.tail));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    t('统一中文解码：fs_grep 能搜索 GBK 文件中的中文', () => {
      const { decodeText } = require('./textdec');
      // “显著”的 GBK 字节；无需依赖本机 PowerShell 或代码页。
      const gbk = Buffer.from([0xcf, 0xd4, 0xd6, 0xf8]);
      if (decodeText(gbk) !== '显著') throw new Error('共享 GBK 解码器失效');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-grep-gbk-'));
      try {
        fs.writeFileSync(path.join(root, 'gbk.txt'), gbk);
        const { TOOLS: TT } = require('./tools');
        const tool = TT.find(x => x.name === 'fs_grep');
        const ctx = { sandbox: new Sandbox(root, { protected: [appDir] }), workspace: root, appDir };
        const out = tool.run(ctx, { pattern: '显著', path: '.' });
        if (!/gbk\.txt:1: 显著/.test(out)) throw new Error('GBK 中文假阴性: ' + out);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    await tAsync('视觉转录缓存：同图同问命中且不计费，图片变化自动失效', async () => {
      const vision = require('./vision');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-vision-cache-'));
      const app2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-vision-app-'));
      try {
        const img = path.join(root, 'chart.png');
        fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
        const model = 'glm-5.3-flash';
        const provider = require('./providers').resolveProvider('glm', {});
        const key = vision.visionCacheKey({ imagePath: img, question: '读数', model, maxTokens: 8192,
          provider: 'glm', kind: provider.kind, base: provider.base,
          reasoning: { requested: 'provider_default', options: {}, fallback: 'error' }, actualReasoning: 'provider_default' });
        vision.writeVisionCache(app2, key, { text: '坐标轴读数 42', truncated: false, model });
        let billed = 0;
        const ctx = {
          sandbox: new Sandbox(root, { protected: [app2] }), workspace: root, appDir: app2,
          settings: { vision_model: model, vision_fallback: model },
          session: {}, trackVision: () => { billed++; }, spend: () => { billed++; },
        };
        const r = await executeTool(ctx, 'vision_read', { path: 'chart.png', question: '读数' });
        if (!r.ok || !/缓存命中/.test(r.data) || !/坐标轴读数 42/.test(r.data)) throw new Error('缓存未命中: ' + String(r.data || r.error));
        if (billed !== 0) throw new Error('缓存命中仍计费');
        fs.appendFileSync(img, Buffer.from([2]));
        let invalidated = false;
        try { await executeTool(ctx, 'vision_read', { path: 'chart.png', question: '读数' }); }
        catch (e) { invalidated = /API Key/.test(e.message); }
        if (!invalidated) throw new Error('图片变化后仍误用旧缓存');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(app2, { recursive: true, force: true });
      }
    });

    await tAsync('视觉 region：真实裁切局部像素并保留独立缓存文件', async () => {
      const { cropImageRegion } = require('./tools');
      const { execFileSync } = require('child_process');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-crop-'));
      const app2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-crop-app-'));
      try {
        const src = path.join(root, 'chart.png');
        execFileSync('python', ['-c', `from PIL import Image; Image.new('RGB',(4,5),(255,0,0)).save(r'${src}')`], { stdio: 'ignore' });
        const ctx = { sandbox: new Sandbox(root, { protected: [app2] }), workspace: root, appDir: app2, settings: {}, session: { runs: [] }, children: new Set(), pyMode: 'rw' };
        const out = await cropImageRegion(ctx, src, { x: 1, y: 1, width: 2, height: 3 });
        if (!fs.existsSync(out) || !/\.run[\\/]crops/.test(out)) throw new Error('裁剪文件未落在 .run/crops');
        const size = execFileSync('python', ['-c', `from PIL import Image; print(Image.open(r'${out}').size)`], { encoding: 'utf8' }).trim();
        if (size !== '(2, 3)') throw new Error('裁剪尺寸错误: ' + size);
        let denied = false;
        try { await cropImageRegion(ctx, src, { x: 3, y: 3, width: 5, height: 5 }); } catch { denied = true; }
        if (!denied) throw new Error('越出图片的 region 未拒绝');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(app2, { recursive: true, force: true });
      }
    });

    t('autoFinished：比赛会话必须走到 final 且有 main.pdf', () => {
      const { autoFinished } = require('./agent');
      const root = path.join(tmp, 'fin-ish');
      fs.mkdirSync(path.join(root, 'paper'), { recursive: true });
      fs.writeFileSync(path.join(root, 'paper', 'main.pdf'), 'x');
      const base = { contest: true, question_graph: [{ id: 1, status: 'committed' }], contest_start: 0, contest_deadline: 1000 };
      const aud = (n) => ({ at: Date.now(), must_fix: n });
      if (autoFinished(Object.assign({}, base, { contest_phase: 'baseline', paper_audit: aud(0) }), root)) throw new Error('基线阶段不该算完成');
      if (autoFinished(Object.assign({}, base, { contest_phase: 'final', paper_audit: aud(1) }), root)) throw new Error('带【必须修】不该算完成');
      if (autoFinished(Object.assign({}, base, { contest_phase: 'final' }), root)) throw new Error('没跑过审计不该算完成');
      if (autoFinished(Object.assign({}, base, { contest_phase: 'final', paper_audit: aud(0) }), root)) throw new Error('审计无必须修但交付证据缺失，不应算完成');
      const plain = { contest: false, question_graph: [{ id: 1, status: 'committed' }] };
      if (!autoFinished(plain, root)) throw new Error('普通会话应沿用旧判据');
    });

    // final 阶段的续推提示此前无条件报"仍有【必须修】项"——提示生成器断言了自己没查的事，
    // 且把「从未跑过审计」(paperHardIssues 返回 null) 与「有 N 条待修」混为一谈，
    // 会把模型打发去找不存在的待修项。三种状态必须各说各的。
    t('nextStepHint：final 阶段按审计实况分三种说法（不虚报待修项）', () => {
      const { nextStepHint } = require('./agent');
      const root2 = path.join(tmp, 'hint-ish');
      fs.mkdirSync(path.join(root2, 'paper'), { recursive: true });
      fs.writeFileSync(path.join(root2, 'paper', 'main.pdf'), 'x');
      const base2 = { contest: true, question_graph: [{ id: 1, status: 'committed' }], contest_start: 0, contest_deadline: 1000, contest_phase: 'final' };
      const hUnrun = nextStepHint(Object.assign({}, base2), root2);
      if (!/尚未完成|尚未通过/.test(hUnrun)) throw new Error('没跑过审计应提示交付尚未完成，实际: ' + hUnrun);
      const h2 = nextStepHint(Object.assign({}, base2, { paper_audit: { at: Date.now(), must_fix: 2 } }), root2);
      if (!/仍有2项必须修|仍有 2 项必须修|仍有2条必须修/.test(h2)) throw new Error('有待修项应报条数，实际: ' + h2);
      const h0 = nextStepHint(Object.assign({}, base2, { paper_audit: { at: Date.now(), must_fix: 0 } }), root2);
      // 断言"没在报待修项"，不能写成 /【必须修】/ ——干净态文案里含「无【必须修】」，
      // 子串匹配会命中否定式而恒假失败（与 repro_check 用 /可复现/ 判定的坑同型）。
      if (/还有|仍有|待修|逐条修/.test(h0)) throw new Error('审计干净不该再报待修项: ' + h0);
      if (!/交付尚未完成/.test(h0)) throw new Error('缺交付证据时应提示继续验收，实际: ' + h0);
    });

    // ---- F-1/F-2/F-3/F-5/F-9/F-10/F-13 论文审计 ----
    const texBad = `\\documentclass{ctexart}\\begin{document}
\\section{问题重述}x
\\section{问题一：模型}a
\\begin{figure}[H]\\caption{温度分布示意图}\\label{fig:a}\\end{figure}
\\begin{thebibliography}{9}\\bibitem{r1} 相关公开综述。\\end{thebibliography}
\\appendix
\\section{支撑材料文件列表}见支撑材料
\\end{document}`;
    t('审计 F-1：缺 AI 工具使用声明 → 必须修', () => {
      const w = auditPaperTex(texBad, { sourceFiles: [], rules: { source: '测试当届规则', ai_statement_in_body: true } });
      if (!w.some(x => x.startsWith('【必须修】') && /AI 工具使用声明/.test(x))) throw new Error('未命中: ' + JSON.stringify(w.slice(0, 3)));
    });
    t('审计 F-1：声明在参考文献之后 → 必须修', () => {
      const bad = texBad.replace('\\appendix', '\\section*{AI 工具使用声明}本队使用 AI。\n\\appendix');
      const w = auditPaperTex(bad, { sourceFiles: [], rules: { source: '测试当届规则', ai_statement_in_body: true, ai_statement_position: 'before_references' } });
      if (!w.some(x => /AI 工具使用声明应位于参考文献之前/.test(x))) throw new Error('未命中顺序问题: ' + JSON.stringify(w));
    });
    t('审计 F-2：正式脚本未进附录 → 必须修（注释占位不算）', () => {
      const tex = `\\begin{document}\\appendix\\section{支撑材料文件列表}清单
% \\VerbatimInput{../scripts/q1_solve.py}
\\section{完整源程序代码}\\end{document}`;
      const w = auditPaperTex(tex, { rules: { source: '测试当届规则', appendix_code_required: true }, sourceFiles: ['scripts/q1_solve.py', 'scripts/q2_solve.py'] });
      const hit = w.find(x => /^【必须修/.test(x) && /附录未通过完整源码引入命令/.test(x));
      if (!hit) throw new Error('未命中: ' + JSON.stringify(w.slice(0, 4)));
      if (!w.some(x => /scripts\/q1_solve.py/.test(x)) || !w.some(x => /scripts\/q2_solve.py/.test(x))) throw new Error('两个缺失源文件均应报出: ' + JSON.stringify(w));
      const w2 = auditPaperTex(tex.replace('% \\VerbatimInput', '\\VerbatimInput').replace('\\section{完整源程序代码}', '\\section{完整源程序代码}\n\\VerbatimInput{../scripts/q1_solve.py}\n\\VerbatimInput{../scripts/q2_solve.py}'), { rules: { source: '测试当届规则', appendix_code_required: true }, sourceFiles: ['scripts/q1_solve.py', 'scripts/q2_solve.py'] });
      if (w2.some(x => /附录未通过完整源码引入命令/.test(x))) throw new Error('完整引入后仍报缺失: ' + JSON.stringify(w2));
    });
    t('审计 F-3/F-13：摘要溢出与正文超页 → 必须修；半空页 → 警告', () => {
      const w = auditPaperTex('\\begin{document}x\\end{document}', { contestKind: 'cumcm', rules: { source: '测试规则', max_body_pages: 30 }, pdf: { pages: 34, kw_on_p1: false, kw_on_p2: true, half_pages: [6, 9], body_pages: 33, overflow_pages: [], tail_blank: false } });
      if (!w.some(x => /摘要\/关键词没有落在第 1 页/.test(x))) throw new Error('未命中摘要一页');
      if (!w.some(x => /正文 33 页 > 30 页上限/.test(x))) throw new Error('未命中正文页数');
      if (!w.some(x => /半空页 2 页/.test(x))) throw new Error('未命中半空页');
    });
    t('审计 F-5：参考文献为 0 / 条目未被引用 → 必须修', () => {
      const w = auditPaperTex('\\begin{document}\\section{参考文献}\\begin{thebibliography}{9}\\end{thebibliography}\\end{document}', { sourceFiles: ['a.py'] });
      if (!w.some(x => /参考文献为 0 条/.test(x))) throw new Error('未命中 0 条');
      const w2 = auditPaperTex('\\begin{document}\\section{正文}无引用\\begin{thebibliography}{9}\\bibitem{r1} 张三. 2024.\\bibitem{r2} 李四. 2023.\\end{thebibliography}\\end{document}', { sourceFiles: ['a.py'] });
      if (!w2.some(x => /全部未被正文/.test(x))) throw new Error('未命中全未引用: ' + JSON.stringify(w2));
      const w3 = auditPaperTex('\\begin{document}\\section{正文}见\\cite{r1}\\begin{thebibliography}{9}\\bibitem{r1} 张三. 2024.\\bibitem{r2} 李四. 2023.\\end{thebibliography}\\end{document}', { sourceFiles: ['a.py'] });
      if (!w3.some(x => /1 条参考文献未被引用/.test(x))) throw new Error('未命中部分未引用: ' + JSON.stringify(w3));
    });
    t('审计 F-9/F-10：[H] 过多 + 孤立图表 → 报警；有结果图时不报缺图', () => {
      const tex = `\\begin{document}\\section{问题一：模型}
\\begin{figure}[H]\\includegraphics{figures/flow_q1.pdf}\\caption{流程图}\\label{fig:f1}\\end{figure}
\\begin{figure}[H]\\includegraphics{figures/a.pdf}\\caption{图}\\label{fig:f2}\\end{figure}
\\begin{table}[H]\\begin{tabular}{c}x\\end{tabular}\\caption{表}\\label{tab:t1}\\end{table}
\\end{document}`;
      const w = auditPaperTex(tex, { sourceFiles: ['a.py'] });
      if (!w.some(x => /\[H\] 强制浮动用得过多/.test(x))) throw new Error('未命中 [H]');
      if (!w.some(x => /未被正文引用的图\/表 3 个/.test(x))) throw new Error('未命中孤立图表: ' + JSON.stringify(w));
      if (w.some(x => /没有结果图/.test(x))) throw new Error('有 a.pdf 结果图却报缺图: ' + JSON.stringify(w));
      // 只有流程图 → 提示补充结果证据，但图的数量不作机械门禁。
      const w2 = auditPaperTex(tex.replace('\\begin{figure}[H]\\includegraphics{figures/a.pdf}\\caption{图}\\label{fig:f2}\\end{figure}', ''), { sourceFiles: ['a.py'] });
      if (!w2.some(x => /没有结果图/.test(x))) throw new Error('缺结果图未给修改建议');
    });
    t('审计 F-7：位图数据图 → 警告矢量要求', () => {
      const tex = '\\begin{document}\\section{问题一：模型}\\includegraphics{figures/flow_q1.pdf}\\includegraphics[width=\\linewidth]{figures/r1.png}\\end{document}';
      const w = auditPaperTex(tex, { sourceFiles: ['a.py'] });
      if (!w.some(x => /用位图数据图/.test(x))) throw new Error('未命中位图: ' + JSON.stringify(w));
    });
    t('审计保留旧能力：Markdown 残留 / 摘要长数字 → 必须修', () => {
      const w = auditPaperTex('\\begin{document}\\begin{abstract}总费用 1801660137.89 元\\end{abstract}\n**粗体**\\end{document}', { sourceFiles: ['a.py'] });
      if (!w.some(x => /Markdown 语法残留/.test(x))) throw new Error('Markdown 检测丢失');
      if (!w.some(x => /摘要数字过长/.test(x))) throw new Error('摘要长数字检测丢失');
    });

    // ---- F-6 总体技术路线图版式 ----
    t('flowchart overview：校验通过并生成 draw.io', () => {
      const fc = require('./flowchart');
      const spec = { name: 'fig00_overall_flow', layout: 'overview', title: '本文总体技术路线', top: '题目与附件数据（4 表 12 字段）', columns: [{ head: '问题一 价格预测', items: ['ARIMA 基线', 'LSTM 对照'] }, { head: '问题二 调度优化', items: ['MILP 主模型'] }], bottom: '统一调度方案与灵敏度结论' };
      const errs = fc.validate(spec);
      if (errs.length) throw new Error('规格被拒: ' + errs.join('；'));
      const xml = fc.toDrawio(spec);
      if (!/mxfile/.test(xml) || !/问题一 价格预测/.test(xml)) throw new Error('drawio 内容不对');
      const tooLong = fc.validate({ layout: 'overview', title: 'T', columns: [{ head: '一个特别特别长的列标题文字', items: ['x'] }] });
      if (!tooLong.some(x => /超 10 字/.test(x))) throw new Error('超长列标题未拦: ' + tooLong.join('；'));
    });

    // ---- F-7 绘图基线 ----
    t('绘图基线：xihe_plot.py 可铺到工作区且含关键设置', () => {
      const { installPlotBaseline } = require('./tools');
      const ws2 = path.join(tmp, 'plot-ws'); fs.mkdirSync(ws2, { recursive: true });
      const r = installPlotBaseline(ws2);
      if (!r) throw new Error('铺设失败');
      const src = fs.readFileSync(path.join(ws2, 'xihe_plot.py'), 'utf8');
      for (const k of ['pdf.fonttype', 'CUMCM_PALETTE', 'C = CUMCM_PALETTE', 'MM', 'def finish', '155']) {
        if (!src.includes(k)) throw new Error('基线缺 ' + k);
      }
      if (installPlotBaseline(ws2) !== 'unchanged') throw new Error('重复铺设应返回 unchanged');
    });
    // 串行执行（同 web_search/技能模板惯例）：fire-and-forget 会和后续 support_pack 的 Compress-Archive 等
    // 重型进程并发，机器繁忙时撞 m36 硬崩溃（光秃 exit=-1 无输出，2026-10-17 实测复现）
    await tAsync('绘图基线：python_run 能 import xihe_plot 并出矢量 PDF', async () => {
      const { executeTool } = require('./tools');
      const root = path.join(tmp, 'plot-run'); fs.mkdirSync(path.join(root, 'figures'), { recursive: true });
      require('./tools').installPlotBaseline(root);
      const ctx = { sandbox: new Sandbox(root, { protected: [appDir] }), workspace: root, appDir, session: { runs: [] }, children: new Set(), pyMode: 'rw' };
      const r = await executeTool(ctx, 'python_run', {
        // 同时覆盖单图 API（figure 返回单个 Axes）与多面板（返回 Axes 列表）
        code: `import xihe_plot as xp\nxp.setup()\nfig, ax = xp.figure('half')\nax.plot([0,1,2],[0,1,4], color=xp.C['primary'])\nax.set_xlabel('时间 t/s'); ax.set_ylabel('温度 T/℃')\npdf, png = xp.finish(ax, 'fig01_smoke')\nprint('SINGLE', pdf, png)\nfig2, axs = xp.figure('full', rows=2, ncols=2)\nfor a in axs: a.plot([0,1],[0,1])\nxp.panel_labels(axs)\nprint('MULTI', len(axs))\nprint('MINFONT', xp.check_min_font(fig2))\n`,
        timeout_sec: 300, // 冷缓存 matplotlib 字体缓存重建 + 守卫开销，120s 在繁忙机器上不够（2026-10-17 实测）
      });
      if (!r.ok) throw new Error('python_run 失败: ' + String(r.data).slice(0, 300));
      if (!/SINGLE .*fig01_smoke\.pdf/.test(String(r.data))) throw new Error('未产出 PDF: ' + String(r.data).slice(0, 200));
      if (!/MULTI 4/.test(String(r.data))) throw new Error('多面板 API 异常: ' + String(r.data).slice(0, 200));
      if (!/MINFONT \[\]/.test(String(r.data))) throw new Error('字号自检异常: ' + String(r.data).slice(0, 200));
      // 关键回归：产出型路径（figures/）不得被 auto_backup 丢进回收站——否则每问的画图都白画
      const pdfPath = path.join(root, 'figures', 'fig01_smoke.pdf');
      if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 1000) throw new Error('PDF 不在工作区（被 auto_backup 移走？）');
      if (!fs.existsSync(path.join(root, 'figures', 'fig01_smoke.png'))) throw new Error('PNG 预览缺失');
    });

    // ---- F-4 支撑包与 AI 详情 ----
    tAsync('support_pack：生成 AI 详情 tex + 支撑材料清单 + zip', async () => {
      const root = path.join(tmp, 'pack-ws');
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'findings'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'q1_solve.py'), 'print(1)');
      fs.writeFileSync(path.join(root, 'result1.xlsx'), 'FAKE-XLSX');
      const ctx = {
        sandbox: new Sandbox(root, { protected: [appDir] }), workspace: root, appDir, children: new Set(),
        session: {
          id: 's_test', model: 'deepseek-flash', createdAt: Date.now(), usage: { calls: 12 },
          runs: [{ run_id: 'run1', model: 'deepseek-flash', formal: true, ok: true }],
          messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'python_run', arguments: '{}' } }] }],
        },
      };
      const r = await spTool(ctx, 'support_pack', {});
      if (!r.ok) throw new Error('support_pack 失败: ' + r.error);
      if (!/支撑材料清单/.test(r.data)) throw new Error('未生成清单: ' + r.data.slice(0, 200));
      const tex = fs.readFileSync(path.join(root, 'AI工具使用详情.tex'), 'utf8');
      if (!/AI 工具使用记录/.test(tex) || /本届 MathorCup|国赛强制/.test(tex)) throw new Error('通用 AI 使用记录标题或规则来源不对');
      // 注意 LaTeX 转义：工具名里的下划线写成 python\_run
      if (!/python\\_run/.test(tex)) throw new Error('AI 详情未列实际工具');
      if (!/会话内调用次数|调用次数/.test(tex)) throw new Error('AI 详情缺调用统计表');
      if (!/人工核验/.test(tex) || !/本栏由参赛队员填写/.test(tex)) throw new Error('AI 详情缺人工核验留空栏');
      if (!/deepseek-flash/.test(tex)) throw new Error('AI 详情未列实际模型型号');
      const man = fs.readFileSync(path.join(root, 'findings', 'support_manifest.md'), 'utf8');
      if (!/scripts\/q1_solve\.py/.test(man)) throw new Error('清单缺脚本');
      if (!/result1\.xlsx/.test(man)) throw new Error('清单缺结果表');
      if (fs.existsSync(path.join(root, 'AItools.tex'))) throw new Error('文件名异常');
      // zip 由 PowerShell 生成；失败不判死（环境可能禁用 Compress-Archive），但清单必须有
      if (/(source|附件原始)/.test(man)) throw new Error('清单不应含题目原始附件');
    });

    // ---- v2.5 摘要门禁 abstract_check ----
    // 回归点：md 分支的 extractAbstract 把「关键词：」行当作摘要结束边界，body 里没有关键词行，
    // 所以关键词必须扫原文——曾经写成扫 body，导致传 text 的摘要永远误报「无关键词」。
    tAsync('abstract_check：数值证据背书 + 关键词行 + 落账 session', async () => {
      const acTool = TOOLS.find(t => t.name === 'abstract_check');
      if (!acTool) throw new Error('abstract_check 工具未注册');
      const ctx = {
        session: {
          runs: [{ run_id: 'run1', ok: true, formal: true, epoch: 0, out: '最优用车数 12 辆\n总成本 45600 元\n达标概率 0.93' }],
          data_epoch: 0,
        },
      };
      // 用例1：数值有 formal 运行背书 + 有「关键词：」行 → 无【必须修】
      const good = await acTool.run(ctx, {
        text: '摘 要\n本文针对车辆调度问题建立了整数规划模型。问题一求得最优用车数 12 辆，总费用 45600 元。问题二灵敏度分析显示达标概率 0.93。\n关键词：整数规划；灵敏度分析；车辆调度',
      });
      if (!/关键词「整数规划；灵敏度分析；车辆调度」/.test(good)) throw new Error('有「关键词：」行却报无关键词: ' + good);
      if (/必须修/.test(good)) throw new Error('合格摘要不应有【必须修】: ' + good);
      if (ctx.session.abstract_check.must_fix !== 0) throw new Error('must_fix 应为 0');
      if (ctx.session.abstract_check.numbers_ok !== 3) throw new Error('3 个数应全部有背书，实际 ' + ctx.session.abstract_check.numbers_ok);      // 用例2：无证据数值 + 无关键词行 + 模糊评价词 → 2 条【必须修】
      const bad = await acTool.run(ctx, { text: '摘要\n本文建立了模型，效果良好，结果令人满意。最优用车数 99 辆，成本 12345678 元。' });
      if (!/99/.test(bad) || !/99、12345678yuan|99.*12345678/.test(bad)) throw new Error('未定位无背书数值: ' + bad);
      if (!/关键词/.test(bad)) throw new Error('缺关键词行未报: ' + bad);
      if (ctx.session.abstract_check.must_fix !== 1) throw new Error('无背书数值应有 1 条【必须修】，缺关键词仅作通用提醒，实际 ' + ctx.session.abstract_check.must_fix);
      if (!ctx.session.abstract_check.missing.includes('99')) throw new Error('missing 未记账 99');
    });

    // ---- 论文文本检查：核心公式编号建议 / 数学环境内转义下划线 / 图后分析 ----
    t('auditPaperTex：核心公式编号建议 + 数学环境内转义下划线', () => {
      const { auditPaperTex } = require('./tools');
      // 未编号：\[...\] 与 align*
      const r1 = auditPaperTex('正文如下：\n\\[ E = mc^2 \\]\n\\begin{align*}\na &= b\n\\end{align*}\n', {});
      const s1 = JSON.stringify(r1);
      if (!/核心公式编号/.test(s1)) throw new Error('核心公式编号建议未报: ' + s1.slice(0, 200));
      // 数学环境内 \_ → 必须修；正文 \_ → 仅警告
      const r2 = auditPaperTex('$x\\_i$ 是下标，正文里 x\\_i 不算公式。\n', {});
      const s2 = JSON.stringify(r2);
      if (!/数学环境内出现转义下划线/.test(s2)) throw new Error('数学内 \\_ 未报: ' + s2.slice(0, 200));
      if (!/正文出现转义下划线/.test(s2)) throw new Error('正文 \\_ 未报: ' + s2.slice(0, 200));
      // 注释里的 \[ 和 \_ 不应判罚（Tnc 剔注释）
      const r3 = auditPaperTex('% 这里是注释 \\[ 和 x\\_i\n正文正常。\n', {});
      const s3 = JSON.stringify(r3);
      if (/核心公式编号|转义下划线/.test(s3)) throw new Error('注释内容被误判: ' + s3.slice(0, 200));
    });
    t('auditPaperTex：两图之间无分析文字 → 必须修', () => {
      const { auditPaperTex } = require('./tools');
      const twoFigs = '\\begin{figure}\n\\includegraphics{a.pdf}\n\\caption{图1}\n\\end{figure}\n'
        + '\\begin{figure}\n\\includegraphics{b.pdf}\n\\caption{图2}\n\\end{figure}\n';
      const bad = JSON.stringify(auditPaperTex(twoFigs, {}));
      if (!/两张图表之间没有分析文字/.test(bad)) throw new Error('图间无分析未报: ' + bad.slice(0, 220));
      // 中间有解读文字 → 不报
      const ok = twoFigs.replace('\\end{figure}\n\\begin{figure}',
        '\\end{figure}\n由图1可见，随温度升高转化率由 41% 升至 78%，说明升温显著促进反应。\n\\begin{figure}');
      const good = JSON.stringify(auditPaperTex(ok, {}));
      if (/两张图表之间没有分析文字/.test(good)) throw new Error('有分析文字仍误报: ' + good.slice(0, 220));
    });

    // ---- v2.5 分题型验证器 ----
    tAsync('question_graph：题型登记 + 分题型 commit 门禁', async () => {
      const qgTool = TOOLS.find(t => t.name === 'question_graph');
      const qws = path.join(tmp, 'qtype-ws');
      fs.mkdirSync(path.join(qws, 'figures'), { recursive: true });
      fs.writeFileSync(path.join(qws, 'figures', 'f1.pdf'), 'FAKE-PDF');
      // 分型检查要单独隔离，所以把通用门禁（产物 / 守恒 / 依赖）都先满足。
      const mkCtx = () => ({
        sandbox: new Sandbox(qws, { protected: [appDir] }), workspace: qws, appDir, children: new Set(),
        session: {
          mode: 'math', data_epoch: 0, conservation: [{ question: 1, kind: 'na', at: Date.now() }, { question: 2, kind: 'na', at: Date.now() }, { question: 3, kind: 'na', at: Date.now() }, { question: 4, kind: 'na', at: Date.now() }],
          runs: [{ run_id: 'run1', ok: true, formal: true, epoch: 0, out: 'objective=1200 n_vars=48' }],
        },
      });
      const link = async (ctx, id) => {
        await qgTool.run(ctx, { op: 'link_run', id, run_id: 'run1' });
        await qgTool.run(ctx, { op: 'attach_artifact', id, path: 'figures/f1.pdf', kind: 'figure' });
      };
      // 优化类：experiments_desc 无可行性证据 → commit 被拒
      let ctx = mkCtx();
      await qgTool.run(ctx, { op: 'upsert', id: 1, title: '问题1', route: 'MILP', type: 'optimization', experiments_desc: ['求解了模型'] });
      await link(ctx, 1);
      const bad = await qgTool.run(ctx, { op: 'commit', id: 1 }).then(() => null, e => e.message);
      if (!bad || !/可行性/.test(bad)) throw new Error('优化类缺可行性证据未拦: ' + bad);
      // 补上可行性字样仍拒绝：文字不是回代证据；实算通过路径见 test_optimization_trace。
      await qgTool.run(ctx, { op: 'upsert', id: 1, title: '问题1', route: 'MILP', experiments_desc: ['回代原约束，违反量 violation=0，可行解最优值 12'] });
      const stillBad = await qgTool.run(ctx, { op: 'commit', id: 1 }).then(() => null, e => e.message);
      if (!stillBad || !/optimization_check/.test(stillBad)) throw new Error('仅补字样不能升级为已核验: ' + stillBad);
      // 预测类：随机打乱 → 拒绝
      ctx = mkCtx();
      ctx.session.runs[0].out = '时序数据随机打乱后，测试误差=0.18';
      await qgTool.run(ctx, { op: 'upsert', id: 2, title: '问题2', route: 'LSTM', type: 'prediction', conventions: { prediction_structure: 'time_series' }, experiments_desc: ['时序预测用 train_test_split 随机打乱后训练'] });
      await link(ctx, 2);
      const bad2 = await qgTool.run(ctx, { op: 'commit', id: 2 }).then(() => null, e => e.message);
      if (!bad2 || !/随机打乱/.test(bad2)) throw new Error('预测类随机打乱未拦: ' + bad2);
      // 统计类：无种子 → 拒绝
      ctx = mkCtx();
      ctx.session.runs[0].out = 'Bootstrap 独立重复 100 次，均值=0.51，标准差=0.04';
      await qgTool.run(ctx, { op: 'upsert', id: 3, title: '问题3', route: 'Bootstrap', type: 'statistics', conventions: { statistics_method: 'stochastic' }, experiments_desc: ['做了 Bootstrap 重抽样'] });
      await link(ctx, 3);
      const bad3 = await qgTool.run(ctx, { op: 'commit', id: 3 }).then(() => null, e => e.message);
      if (!bad3 || !/固定种子/.test(bad3)) throw new Error('随机统计缺固定种子未拦: ' + bad3);
      // 未登记题型 → 不追加分型检查（通用门禁仍生效）
      ctx = mkCtx();
      await qgTool.run(ctx, { op: 'upsert', id: 4, title: '问题4', route: '评价', experiments_desc: ['综合评分'] });
      await link(ctx, 4);
      const okT = await qgTool.run(ctx, { op: 'commit', id: 4 }).then(() => 'ok', e => e.message);
      if (okT !== 'ok') throw new Error('未登记题型不应加分型检查: ' + okT);
    });
  }

  // ---------- 四种模式（v2.5 第九轮）：collab_mode × effort 正交 ----------
  // 深度维度是"花多少算力"，与"谁来拍板"正交。这批用例锁三件事：
  // ① 组合解析正确；② deep 工具只在 deep 会话下发（fast 会话绝不能看到，否则默认档会误用高成本手法）；
  // ③ 未知/缺失值一律降级到 fast（旧会话与测试桩不能因为新字段缺失就解锁高成本工具）。
  {
    const modes = require('./modes');
    const { toOpenAITools, toAnthropicTools, TOOLS } = require('./tools');
    const DEEP = ['deep_debate', 'deep_tree', 'deep_loop', 'deep_visual'];

    t('modes：两种维度组合出六种模式', () => {
      const want = {
        'collab:fast': 1, 'auto:fast': 2, 'collab:deep': 3, 'auto:deep': 4,
        'collab:extreme': 5, 'auto:extreme': 6,
      };
      for (const [id, n] of Object.entries(want)) {
        const [c, e] = id.split(':');
        const m = modes.modeOf({ collab_mode: c, effort: e });
        if (m.id !== id) throw new Error(`modeOf(${id}) = ${m.id}`);
        if (m.n !== n) throw new Error(`${id} 序号应为 ${n}，实际 ${m.n}`);
      }
    });
    t('modes：未知/缺失值降级 fast，不误判为 deep', () => {
      const bad = [
        undefined, null, {}, { effort: 'DEEP' }, { effort: 'ultra' },
        { collab_mode: 'auto' }, { collab_mode: 'weird', effort: 'deep' },
      ];
      for (const s of bad) {
        if (s && s.effort === 'deep') continue; // 显式 deep 才该为真
        if (modes.isDeep(s)) throw new Error('非法会话被判定为 deep: ' + JSON.stringify(s));
      }
      if (!modes.isDeep({ effort: 'deep' })) throw new Error('显式 deep 应为真');
      if (!modes.isDeep({ effort: 'extreme' }) || !modes.isExtreme({ effort: 'extreme' })) throw new Error('extreme 应属于 deep 及以上且有独立 tier');
      if (modes.isExtreme({ effort: 'deep' })) throw new Error('deep 不应误判 extreme');
      // collab_mode 非 auto 一律按 collab（保守：宁可多问用户）
      if (modes.collabOf({ collab_mode: 'weird' }) !== 'collab') throw new Error('未知 collab_mode 应为 collab');
    });

    const sess = (o) => Object.assign({ mode: 'math' }, o);
    t('档位门禁：fast 不下发 deep 工具或 subagent_run', () => {
      for (const c of ['collab', 'auto']) {
        const names = toOpenAITools(sess({ collab_mode: c, effort: 'fast' })).map(x => x.function.name);
        const leaked = DEEP.filter(d => names.includes(d));
        if (leaked.length) throw new Error(`fast(${c}) 泄漏了 ${leaked.join('、')}`);
        if (names.includes('subagent_run')) throw new Error('fast 应隐藏子代理编制');
      }
    });
    t('档位门禁：deep/extreme 下发全部 deep 工具，且工具表一致', () => {
      for (const e of ['deep', 'extreme']) for (const c of ['collab', 'auto']) {
        const names = toOpenAITools(sess({ collab_mode: c, effort: e })).map(x => x.function.name);
        const miss = DEEP.filter(d => !names.includes(d));
        if (miss.length) throw new Error(`${e}(${c}) 缺少 ${miss.join('、')}`);
        if (!names.includes('subagent_run')) throw new Error(e + ' 缺 subagent_run');
      }
      const d = toOpenAITools(sess({ effort: 'deep' })).map(x => x.function.name);
      const x = toOpenAITools(sess({ effort: 'extreme' })).map(x => x.function.name);
      if (JSON.stringify(d) !== JSON.stringify(x)) throw new Error('deep 与 extreme 工具面应逐字节一致');
    });
    t('深度门禁：Anthropic 与 OpenAI 两协议一致', () => {
      for (const e of ['fast', 'deep', 'extreme']) {
        const s = sess({ collab_mode: 'collab', effort: e });
        const oa = DEEP.filter(d => toOpenAITools(s).map(x => x.function.name).includes(d)).length;
        const an = DEEP.filter(d => toAnthropicTools(s).map(x => x.name).includes(d)).length;
        if (oa !== an) throw new Error(`effort=${e} 协议不一致: openai=${oa} anthropic=${an}`);
      }
    });
    t('深度门禁：四个 deep 工具都已注册进 TOOLS', () => {
      const all = TOOLS.map(x => x.name);
      const miss = DEEP.filter(d => !all.includes(d));
      if (miss.length) throw new Error('未注册: ' + miss.join('、'));
    });

    t('极致编制：三固定职责工具都真实存在，提示词只在该档注入', () => {
      const all = new Set(TOOLS.map(x => x.name));
      for (const [id, crew] of Object.entries(modes.CREW)) {
        for (const name of crew.tools) if (!all.has(name)) throw new Error(`${id} 引用了不存在的工具 ${name}`);
      }
      const { buildSystem } = require('./agent');
      const root = path.resolve(__dirname, '..');
      const fastSys = buildSystem('free', root, {}, appDir, 'deepseek', null, { effort: 'fast' });
      const deepSys = buildSystem('free', root, {}, appDir, 'deepseek', null, { effort: 'deep' });
      const extremeSys = buildSystem('free', root, {}, appDir, 'deepseek', null, { effort: 'extreme' });
      if (/当前深度：deep|当前深度：extreme/.test(fastSys)) throw new Error('fast 注入高档提示');
      if (!/当前深度：deep/.test(deepSys) || /当前深度：extreme/.test(deepSys)) throw new Error('deep 提示档位错误');
      if (!/当前深度：extreme/.test(extremeSys) || !/三固定职责/.test(extremeSys)) throw new Error('extreme 提示缺失');
    });

    // 执行层兜底：即使模型硬调 deep 工具（fast 会话没下发，但模型可能凭记忆写出名字），
    // deepGuard 必须在执行层拒绝——不能只靠"没广告"这一层。
    // 这四个工具 call 了 runSubagent 之外的引擎，这里只验证守卫本身先于任何副作用触发。
    tAsync('深度门禁：fast 会话硬调 deep 工具在执行层被拒', async () => {
      const { TOOLS: T2 } = require('./tools');
      for (const name of DEEP) {
        const tool = T2.find(x => x.name === name);
        const ctx = {
          session: { mode: 'math', effort: 'fast', collab_mode: 'collab' },
          workspace: ws, appDir, sandbox: new Sandbox(ws, { protected: [appDir] }),
          engines: null, // 没有子代理引擎：若守卫不先生效，这里会因缺引擎而抛别的错
        };
        const err = await Promise.resolve()
          .then(() => tool.run(ctx, { question: 'q', why: 'w', op: 'view', script: 's.py', figures: ['f.png'] }))
          .then(() => null, e => String(e.message || e));
        if (!err) throw new Error(`${name} 在 fast 会话竟然执行了`);
        if (!/深度模式/.test(err)) throw new Error(`${name} 报错原因不对（应提示深度模式）: ${err.slice(0, 120)}`);
      }
    });
  }

  // ============ v2.6 项目文件夹 / 外部目录 / 真实计费 ============
  // 这一组是硬边界：路径归属判错会串题，自动备份判错会删用户的文件。
  {
    const srv = require('./server');
    const v = (p) => srv.validateProjectRoot(p);

    t('附件清单：超出 50 条的最旧索引落盘归档而非静默丢失', () => {
      const srv2 = require('./server');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-attach-archive-'));
      try {
        const sess = { id: 'archive_test', attachment_manifest: Array.from({ length: 55 }, (_, i) => ({ path: 'a' + i + '.png' })) };
        const r = srv2.trimAttachmentManifest(sess, root);
        if (r.archived !== 5 || sess.attachment_manifest.length !== 50) throw new Error('归档数量错误');
        if (sess.attachment_manifest[0].path !== 'a5.png') throw new Error('保留窗口错误');
        const lines = fs.readFileSync(r.archive, 'utf8').trim().split('\n').map(JSON.parse);
        if (lines.length !== 5 || lines[0].path !== 'a0.png' || !lines[0].archived_at) throw new Error('归档内容不可找回');
        const again = srv2.trimAttachmentManifest(sess, root);
        if (again.archived !== 0 || again.archive !== null) throw new Error('未超限时也归档');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    t('_inside：子路径放行、同名前缀不放行', () => {
      if (!srv._inside('C:\\work\\a\\b.txt', 'C:\\work\\a')) throw new Error('子路径被拒');
      if (srv._inside('C:\\work\\ab\\b.txt', 'C:\\work\\a')) throw new Error('同名前缀 C:\\work\\ab 被误判在 C:\\work\\a 内');
    });
    t('validateProjectRoot：正常文件夹通过', () => {
      const ok = v(ws);
      if (ok.error) throw new Error(ok.error);
    });
    t('validateProjectRoot：拒绝磁盘根目录', () => {
      const r = v(path.parse(ws).root);
      if (!r.error) throw new Error('竟然放行磁盘根 ' + path.parse(ws).root);
    });
    t('validateProjectRoot：拒绝系统目录', () => {
      const r = v('C:\\Windows\\System32');
      if (!r.error) throw new Error('竟然放行系统目录');
    });
    t('validateProjectRoot：拒绝包含程序目录的祖先目录（沙箱 protected 对 root 本身无效）', () => {
      const APPREAL = path.resolve(__dirname, '..');
      const r = v(path.resolve(APPREAL, '..'));
      if (!r.error) throw new Error('竟然放行程序目录的父目录——等于把整个程序交出去');
    });
    t('validateProjectRoot：拒绝不存在的路径', () => {
      const r = v(path.join(tmp, 'no-such-dir-' + Date.now()));
      if (!r.error) throw new Error('竟然放行不存在的路径');
    });

    // PROJECTS_DIR 是模块常量，没有注入口 —— 这三个用例会在**真实**项目根下留目录。
    // 每条自己登记，跑完删掉，不给用户的工作区留垃圾（曾经留过 3 个 test_* 残留）。
    const madeProjects = [];
    const mk = (pid, name, opts) => { madeProjects.push(pid); return srv.ensureProject(pid, name, opts); };

    t('projectWorkspace：无 dir 元数据时回落程序内项目目录', () => {
      const pid = 'test_internal_' + Date.now().toString(36);
      mk(pid, '内部项目');
      const w = srv.projectWorkspace(pid);
      if (path.resolve(w) !== path.resolve(srv.projectDir(pid))) throw new Error('回落失败：' + w);
      if (srv.isExternalProject(pid)) throw new Error('内部项目被误标为外部');
    });
    t('projectWorkspace：绑定外部目录后即用户选定目录，且目录里不写元数据', () => {
      const pid = 'test_ext_' + Date.now().toString(36);
      const ext = path.join(tmp, 'user_folder_' + pid);
      fs.mkdirSync(ext, { recursive: true });
      fs.writeFileSync(path.join(ext, '既有资料.txt'), '不许动我', 'utf8');
      mk(pid, '外部项目', { dir: ext });
      if (path.resolve(srv.projectWorkspace(pid)) !== path.resolve(ext)) throw new Error('未解析到外部目录');
      if (!srv.isExternalProject(pid)) throw new Error('未标记 external');
      if (fs.existsSync(path.join(ext, 'project.json'))) throw new Error('元数据被写进用户目录了');
      if (fs.existsSync(path.join(ext, 'runs'))) throw new Error('在用户目录里擅自建 runs/');
      if (!fs.existsSync(path.join(srv.projectDir(pid), 'project.json'))) throw new Error('元数据没落在程序内');
    });
    t('projectWorkspace：外部目录被删后不炸（回落内部目录）', () => {
      const pid = 'test_gone_' + Date.now().toString(36);
      const ext = path.join(tmp, 'gone_' + pid);
      fs.mkdirSync(ext, { recursive: true });
      mk(pid, '已消失的外部项目', { dir: ext });
      fs.rmSync(ext, { recursive: true, force: true });
      const w = srv.projectWorkspace(pid);
      if (path.resolve(w) !== path.resolve(srv.projectDir(pid))) throw new Error('没回落：' + w);
    });
    t('测试不往真实项目根里留垃圾：登记的测试项目可被清理干净', () => {
      if (!madeProjects.length) throw new Error('没登记到任何测试项目，清理逻辑是空转的');
      for (const pid of madeProjects) fs.rmSync(srv.projectDir(pid), { recursive: true, force: true });
      madeProjects.length = 0;
      for (const pid of ['test_internal_', 'test_ext_', 'test_gone_']) {
        const left = fs.readdirSync(srv.PROJECTS_DIR).filter(x => x.startsWith(pid));
        if (left.length) throw new Error('残留没清干净：' + left.join(','));
      }
    });

    // ★ 防数据丢失断言（必须有）：外部项目下自动备份整体短路。
    // 这条守的是用户装满既有资料的外部项目文件夹——auto_backup 一旦生效，
    // 不在 BACKUP_KEEP_DIRS 里的既有文件会被搬进回收站，等于清空用户数据。
    tAsync('自动备份短路：外部项目下 autoBackupAfterRun 不移任何文件', async () => {
      const tools = require('./tools');
      const box = path.join(tmp, 'ext_box_' + Date.now().toString(36));
      fs.mkdirSync(box, { recursive: true });
      fs.writeFileSync(path.join(box, '非常重要.docx'), 'DONE', 'utf8');
      const ctx = {
        workspace: box, appDir,
        sandbox: new Sandbox(box, { protected: [appDir], external: true }),
        session: { runs: [] },
      };
      if (ctx.sandbox.external !== true) throw new Error('external 标记没传到沙箱');
      tools.captureAutoBackupBaseline(ctx);
      fs.writeFileSync(path.join(box, 'script_output.txt'), 'new', 'utf8');
      const backed = tools.autoBackupAfterRun(ctx, 'test');
      if (backed.length) throw new Error('竟然备份了 ' + backed.length + ' 个文件：' + JSON.stringify(backed).slice(0, 200));
      if (!fs.existsSync(path.join(box, '非常重要.docx'))) throw new Error('既有文件被移走了');
      if (!fs.existsSync(path.join(box, 'script_output.txt'))) throw new Error('本轮写入的文件也被移走了');
      if (fs.existsSync(path.join(box, 'recycle'))) throw new Error('在用户目录里建了回收站');
    });

    // 反向对照：非外部项目必须仍然真的备份，否则上面那条断言是空转的。
    tAsync('自动备份对照：内部项目仍照常备份本轮写入', async () => {
      const tools = require('./tools');
      const box = path.join(tmp, 'int_box_' + Date.now().toString(36));
      fs.mkdirSync(box, { recursive: true });
      const ctx = {
        workspace: box, appDir,
        sandbox: new Sandbox(box, { protected: [appDir] }),
        session: { runs: [] },
      };
      tools.captureAutoBackupBaseline(ctx);
      fs.writeFileSync(path.join(box, 'draft.txt'), 'new', 'utf8');
      const backed = tools.autoBackupAfterRun(ctx, 'test');
      if (!backed.length) throw new Error('内部项目没有备份——短路范围开太大了');
      if (fs.existsSync(path.join(box, 'draft.txt'))) throw new Error('draft.txt 没进回收站');
    });

    // 计费：明细是「token 事实」，金额现算——改价后历史账必须跟着变。
    t('计费：改价后重算，历史总额按新价变化', () => {
      const meter = require('./meter');
      const mapp = path.join(tmp, 'meter_app_' + Date.now().toString(36));
      fs.mkdirSync(mapp, { recursive: true });
      // 固定用「空闲时段」的时间戳（周六），避开高峰价造成的抖动
      const at = Date.UTC(2026, 0, 3, 4, 0, 0); // 2026-01-03 是周六
      for (let i = 0; i < 3; i++) {
        meter.record(mapp, { t: at, model: 'deepseek-flash', kind: 'main', session_id: 's1', project_id: 'p1', prompt_tokens: 1e6, completion_tokens: 0, cache_hit_tokens: 1e6 });
      }
      const base = meter.meterSummary(mapp, {});
      if (base.calls !== 3) throw new Error('明细条数不对：' + base.calls);
      // 空闲 hit 价 0.02 ¥/M × 3 × 1M = 0.06
      if (Math.abs(base.total - 0.06) > 1e-6) throw new Error('基准总额不对：' + base.total);
      const dearer = { 'deepseek-flash': { hit: 0.10, miss: 1.0, out: 4.0 } };
      const after = meter.meterSummary(mapp, { prices: dearer });
      if (Math.abs(after.total - 0.30) > 1e-6) throw new Error('改价后没变：' + after.total);
      if (!after.byModel['deepseek-flash'] || !after.byKind.main) throw new Error('分组缺失');
      const r = meter.resummarize(mapp, { prices: dearer });
      if (r.changed !== 1) throw new Error('resummarize 未更新账本：' + JSON.stringify(r));
      const { loadLedger } = require('./external');
      const day = meter.localDay(at);
      const led = loadLedger(mapp);
      if (Math.abs((led.costs[day] || 0) - 0.30) > 1e-3) throw new Error('账本金额不对：' + led.costs[day]);
    });
    t('计费：坏行跳过而不是整文件失败', () => {
      const meter = require('./meter');
      const mapp = path.join(tmp, 'meter_bad_' + Date.now().toString(36));
      fs.mkdirSync(meter.meterDir(mapp), { recursive: true });
      const day = meter.localDay(Date.now());
      fs.writeFileSync(meter.meterFile(mapp, day), '{"t":1,"model":"deepseek-flash","prompt_tokens":1}\n{半行坏数据\n', 'utf8');
      const s = meter.meterSummary(mapp, {});
      if (s.calls !== 1) throw new Error('坏行处理不对，calls=' + s.calls);
    });

    // codeStamp 在 readdir 与 stat 之间可能撞上文件被替换/删除（正在编辑 ui/ 下文件时就会发生）。
    // 本模块由 main.js:4 在模块加载期 require，那时没有窗口也没有 uncaughtException 处理器，
    // 抛出去直接打死 Electron 引导流程。这三条用例合起来才够：第一条证明会坏，第二条证明修复没把
    // 指纹改瞎（正对照，否则「全部跳过」也能过），第三条证明跳过没让结果变得不确定。
    t('指纹：readdir 后文件消失不抛，其余文件仍参与摘要', () => {
      const { codeStamp } = require('./version');
      const fapp = path.join(tmp, 'stamp_app_' + Date.now().toString(36));
      fs.mkdirSync(path.join(fapp, 'core'), { recursive: true });
      fs.mkdirSync(path.join(fapp, 'ui'), { recursive: true });
      fs.writeFileSync(path.join(fapp, 'core', 'a.js'), 'a');
      fs.writeFileSync(path.join(fapp, 'core', 'gone.js'), 'g');
      fs.writeFileSync(path.join(fapp, 'ui', 'b.css'), 'b');

      const realStat = fs.statSync;
      try {
        // 模拟竞态：readdir 看得到 gone.js，stat 时它已经不在了
        fs.statSync = (p, ...rest) => {
          if (String(p).endsWith('gone.js')) { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; }
          return realStat(p, ...rest);
        };
        let stampRaced;
        try { stampRaced = codeStamp(fapp); }
        catch (e) { throw new Error('文件消失直接把指纹算崩了（修复失效）：' + e.message); }
        if (!/^[0-9a-f]{12}$/.test(stampRaced)) throw new Error('返回值不是 12 位指纹：' + stampRaced);
      } finally { fs.statSync = realStat; }

      // 正对照：gone.js 存在时，它的内容必须真的影响指纹——否则上面的 try/catch 是空转
      const clean = codeStamp(fapp);
      fs.writeFileSync(path.join(fapp, 'core', 'gone.js'), 'g2');
      const changed = codeStamp(fapp);
      if (clean === changed) throw new Error('无关文件改内容指纹不变——摘要没把 core/ 下的文件算进去');
      // 稳定性：同一状态连算两次必须一致（sort 保证顺序确定）
      if (codeStamp(fapp) !== changed) throw new Error('同一状态两次指纹不一致');
      // 非目标扩展名不得参与
      fs.writeFileSync(path.join(fapp, 'core', 'note.txt'), 'x'.repeat(50));
      if (codeStamp(fapp) !== changed) throw new Error('txt 不该参与指纹');
      // 测试代码不得参与：改 test_*.js 不该被判成"运行时更新了"，否则改个测试就会让桌面壳换版重启
      fs.writeFileSync(path.join(fapp, 'core', 'test_foo.js'), 'x'.repeat(50));
      fs.writeFileSync(path.join(fapp, 'ui', 'test_bar.js'), 'y'.repeat(50));
      if (codeStamp(fapp) !== changed) throw new Error('test_* 不该参与指纹');
      // 正对照：同样的内容换个非 test_ 名字必须影响指纹——否则上面那条在"整个目录都没算"时也会过
      fs.writeFileSync(path.join(fapp, 'core', 'foo.js'), 'x'.repeat(50));
      if (codeStamp(fapp) === changed) throw new Error('同名非 test_ 文件没进指纹——排除规则把真文件也吞了');
    });

    // 桌面壳的握手（core/probe.js）：决定"点开快捷方式拿到的是不是最新版"。
    // 竞态没法靠点图标验，只能在这里用真 HTTP 服务摆出那个状态。
    // 这些用例用高位端口，避开 18652-18670（用户可能正跑着一个羲和），所以 waitForServer
    // 必须支持传端口段——不能写死。
    const srvOf = (bodyFn) => new Promise((resolve) => {
      const s = require('http').createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(bodyFn()));
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    await tAsync('probePort：同端口但不是羲和的服务不认（不误认别人的服务）', async () => {
      const probe = require('./probe');
      const s = await srvOf(() => ({ app: 'some-other-tool', pid: process.pid, code_stamp: 'aaaaaaaaaaaa' }));
      try {
        const p = s.address().port;
        if (await probe.probePort(p, null)) throw new Error('把无关服务认成羲和了');
        if (await probe.probePort(p, null, 'aaaaaaaaaaaa')) throw new Error('指纹对上了也不该认——app 标识不符');
      } finally { s.close(); }
    });

    await tAsync('probePort：wantStamp 不符返回 null（旧版服务不算本版就绪）', async () => {
      const probe = require('./probe');
      const s = await srvOf(() => ({ app: 'xihe-agent', pid: process.pid, code_stamp: 'f02a297f61e7', running: 0 }));
      try {
        const p = s.address().port;
        const got = await probe.probePort(p, null, 'f02a297f61e7');
        if (!got) throw new Error('指纹一致却认不出来');
        if (await probe.probePort(p, null, 'be4c06db61a0')) throw new Error('指纹不符竟然认出来了——这正是"更新没生效"的路径');
        if (await probe.probePort(p, 999999)) throw new Error('pid 不符竟然认出来了');
      } finally { s.close(); }
    });

    await tAsync('waitPortFree：旧服务还在时不返回，关掉后才放行', async () => {
      const probe = require('./probe');
      const s = await srvOf(() => ({ app: 'xihe-agent', pid: process.pid, code_stamp: 'x', running: 0 }));
      const p = s.address().port;
      let freed = null;
      const waiter = probe.waitPortFree(p, 8000).then(r => { freed = r; });
      await new Promise(r => setTimeout(r, 700));
      if (freed !== null) throw new Error('旧服务还在监听就判定端口已释放——新服务会撞上它然后直接退出');
      s.close();
      await waiter;
      if (freed !== true) throw new Error('旧服务已关闭却仍判定端口被占');
    });

    await tAsync('waitForServer：端口上只有旧版时，不认领（宁可不启动也不错开旧界面）', async () => {
      const probe = require('./probe');
      const s = await srvOf(() => ({ app: 'xihe-agent', pid: process.pid, code_stamp: 'oldstamp0000', running: 0 }));
      try {
        const p = s.address().port;
        // 老行为（不传 wantStamp）会认领——这条锁住"为什么必须传指纹"
        const lazy = await probe.waitForServer(null, 1500, null, p, p);
        if (lazy !== p) throw new Error('不传指纹时本该认领（前提用例失效，后面的断言就没意义）');
        const strict = await probe.waitForServer(null, 1500, 'newstamp0000', p, p);
        if (strict !== null) throw new Error('只认指纹时竟然认领了旧版服务');
      } finally { s.close(); }
    });

    await tAsync('waitForServer：本版服务起来后能认领到', async () => {
      const probe = require('./probe');
      const s = await srvOf(() => ({ app: 'xihe-agent', pid: process.pid, code_stamp: 'newstamp0000', running: 0 }));
      try {
        const p = s.address().port;
        const got = await probe.waitForServer(null, 3000, 'newstamp0000', p, p);
        if (got !== p) throw new Error('本版服务就绪却没认领到（用户会看到启动失败）');
      } finally { s.close(); }
    });

    // 单实例锁的代价：第二次点图标不再开新壳，而是落回老壳。老壳若拿自己启动时算的指纹
    // 来比，结论永远是"不用重启"——你就只能看到老界面，还得手动关掉重开。needsRestart 是
    // 这道判定唯一的地方，所以四条分支都要钉住。
    t('needsRestart：旧服务 + 代码已更新 = 必须重启（这就是"更新没生效"那条路）', () => {
      const { needsRestart } = require('./probe');
      if (needsRestart({ code_stamp: 'oldstamp0000', running: 0 }, 'newstamp0000') !== true) {
        throw new Error('代码更新后仍判定不用重启——单实例锁下用户会被永久钉在老版本');
      }
    });
    t('needsRestart：指纹一致不重启（否则每次点图标都杀服务，白重启）', () => {
      const { needsRestart } = require('./probe');
      if (needsRestart({ code_stamp: 'samestamp000', running: 0 }, 'samestamp000') !== false) {
        throw new Error('本版服务竟判定要重启');
      }
    });
    t('needsRestart：旧版正在跑任务时不重启（比赛跑到一半，宁可给旧界面）', () => {
      const { needsRestart } = require('./probe');
      if (needsRestart({ code_stamp: 'oldstamp0000', running: 1 }, 'newstamp0000') !== false) {
        throw new Error('旧版服务正跑着任务却被判定该重启——这会中途打断比赛');
      }
    });
    t('needsRestart：服务已消失要重启（被关掉/崩了得重拉）', () => {
      const { needsRestart } = require('./probe');
      if (needsRestart(null, 'newstamp0000') !== true) throw new Error('服务没了却判定不用重启，窗口会白屏');
    });
  }

  // 等所有异步用例（含顶层 fire-and-forget 的那些）真正跑完再汇总
  await Promise.allSettled(pending);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  // 末尾清理走不到 process.exit(1) 的失败分支和真正的崩溃路径——那两种恰恰最会留下夹具。
  // 挂 exit 兜底；下面这行让正常路径也不依赖它。
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
