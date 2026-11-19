// 角色模型路由离线测试：不调用任何真实 API。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./model_roles');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '->', e.message); }
}
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.xihe-roles-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config', 'deepseek.key'), 'test-key');

t('任务分类：建模/编程/论文/审查与不确定继承', () => {
  const cases = [
    ['建立目标函数和约束并比较模型假设', 'modeler'],
    ['用 Python 写脚本调试求解器报错', 'coder'],
    ['撰写论文摘要并润色正文', 'writer'],
    ['独立审查这篇论文的数值证据', 'reviewer'],
    ['整理一下已有材料', null],
  ];
  for (const [text, want] of cases) {
    const got = R.classifyTask(text);
    if (got !== want) throw new Error(`${text}: ${got} != ${want}`);
  }
});

t('crew 明确职责优先于 prompt 中的其他材料词', () => {
  if (R.roleForSubagent('worker', { crew: 'coder' }, '根据论文公式写 MATLAB') !== 'coder') throw new Error('crew 未优先');
  if (R.roleForSubagent('reviewer', {}, '写代码') !== 'reviewer') throw new Error('reviewer 被材料词抢走');
});

t('角色模型：role_models 与 provider:model 路由', () => {
  fs.writeFileSync(path.join(tmp, 'config', 'glm.key'), 'test-glm');
  const r = R.resolveRoleModel({
    role: 'modeler', appDir: tmp,
    settings: { role_models: { modeler: 'glm:glm-5.3' }, default_model: 'deepseek-flash' },
  });
  if (!r.ok || r.providerKey !== 'glm' || r.model !== 'glm:glm-5.3' || r.source !== 'role:modeler') throw new Error(JSON.stringify(r));
});

t('缺 key 回退可见；默认模型可用', () => {
  const r = R.resolveRoleModel({
    role: 'coder', appDir: tmp,
    settings: { role_models: { coder: 'qwen-plus' }, default_model: 'deepseek-flash' },
  });
  if (!r.ok || r.model !== 'deepseek-flash' || !r.fallback) throw new Error('未回退默认模型');
  if (!r.warnings.some(x => /qwen-plus/.test(x) && /API Key/.test(x))) throw new Error('缺 key 没有告警');
});

t('reviewer 兼容 heavy_model', () => {
  const r = R.resolveRoleModel({
    role: 'reviewer', appDir: tmp,
    settings: { role_models: {}, heavy_model: 'deepseek-v4-pro', default_model: 'deepseek-flash' },
  });
  if (!r.ok || r.model !== 'deepseek-v4-pro' || r.source !== 'heavy_model') throw new Error(JSON.stringify(r));
});

t('手动会话模型缺 key 时不得静默换模型', () => {
  const r = R.resolveRoleModel({
    role: 'modeler', appDir: tmp, sessionModel: 'qwen-plus', sessionExplicit: true,
    settings: { role_models: { modeler: 'deepseek-v4-pro' }, default_model: 'deepseek-flash' },
  });
  if (r.ok || r.model !== null || !r.warnings.some(x => /session_explicit/.test(x))) throw new Error(JSON.stringify(r));
});

t('提供商失败回退：排除当前模型后选择下一候选', () => {
  const r = R.resolveRoleModel({
    role: 'writer', appDir: tmp, excludeModels: ['glm:glm-5.3'],
    settings: { role_models: { writer: 'glm:glm-5.3' }, default_model: 'deepseek-flash' },
    sessionModel: 'glm:glm-5.3',
  });
  if (!r.ok || r.model !== 'deepseek-flash') throw new Error(JSON.stringify(r));
});

t('role_models 归一化只接受四个角色', () => {
  const r = R.normalizeRoleModels({ modeler: ' a ', coder: 'b', writer: 'c', reviewer: 'd', evil: 'x' });
  if (r.modeler !== 'a' || r.evil != null || Object.keys(r).length !== 4) throw new Error(JSON.stringify(r));
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
