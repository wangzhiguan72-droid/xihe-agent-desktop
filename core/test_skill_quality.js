'use strict';

// 技能首检质检离线测试：零真实 API（fetchImpl 桩）。
// 覆盖：开关/指纹缓存/内容变化重检/跳过/失败不落标记/并发去重/结论归一化/
// 修复副本（原件不动、refs 复制、截断降级批注、保留旧副本）/工具链路计费。

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sq = require('./skill_quality');
const { executeTool } = require('./tools');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-quality-'));
fs.mkdirSync(path.join(root, 'config'), { recursive: true });
fs.writeFileSync(path.join(root, 'config', 'custom_testp.key'), 'test-key', 'utf8');

const SKILL_NAME = 'xihe-quality-test-skill';
const skillDir = path.join(root, 'skills', SKILL_NAME);
fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
const originalBody = '# 测试建模技能\n\n## 第1节\n先用 MATLAB 求解。\n\n## 第2节\n全程只用 Python，禁止 MATLAB。\n\n## 第3节\n摘要要写清模型与结果。\n';
const skillDoc = `---\nname: ${SKILL_NAME}\ndescription: 质检测试用技能\nmetadata:\n  version: "1.0"\n---\n\n${originalBody}`;
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillDoc, 'utf8');
fs.writeFileSync(path.join(skillDir, 'references', 'extra.md'), '参考细则：参数表。\n', 'utf8');

const settings = {
  skill_quality: { enabled: true, provider: 'testp', model: 'test-model' },
  custom_providers: [{ id: 'testp', name: 'TestProvider', base: 'https://test.local/v1', kind: 'openai', models: ['test-model'] }],
  provider_models: { testp: ['test-model'] },
};

let calls = [];
const verdict = { status: 'warn', summary: '语言指令前后矛盾', issues: [
  { severity: 'medium', where: '第1节/第2节', problem: 'MATLAB 与 Python 指令冲突', fix: '统一为 Python 主解' },
] };
const okResponse = (content, finish = 'stop', usage = { prompt_tokens: 100, completion_tokens: 50 }) => ({
  ok: true, status: 200,
  async json() { return { choices: [{ message: { content }, finish_reason: finish }], usage }; },
});
const fetchOk = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return okResponse(JSON.stringify(verdict)); };
const shaOf = () => require('./skills').loadSkill(root, SKILL_NAME).sha256;

(async () => {
  // ---------- 设置归一化 ----------
  const clamped = sq.settingsOf({ skill_quality: { enabled: 'yes', timeout_ms: 999999, max_tokens: 99 } });
  assert.equal(clamped.enabled, false);
  assert.equal(clamped.timeout_ms, 180000);
  assert.equal(clamped.max_tokens, 1024);
  const choice = sq.modelChoice({ heavy_model: 'testp:test-model', ...settings, skill_quality: { enabled: true } });
  assert.equal(choice.provider, 'testp');
  assert.equal(choice.model, 'test-model');

  // ---------- 结论归一化：口径自洽 ----------
  assert.equal(sq.normalizeVerdict({ status: 'ok', issues: [{ problem: 'x' }] }).status, 'warn');
  assert.equal(sq.normalizeVerdict({ status: 'warn', issues: [{ severity: 'high', problem: 'x' }] }).status, 'conflict');
  assert.equal(sq.normalizeVerdict({ status: 'ok', issues: [] }).status, 'ok');
  assert.equal(sq.normalizeVerdict({ status: 'great' }), null);
  assert.equal(sq.normalizeVerdict(null), null);

  // ---------- 开关与指纹 ----------
  const sha = shaOf();
  assert.match(sha, /^[a-f0-9]{64}$/);
  const disabled = await sq.checkSkill({ appDir: root, settings: { ...settings, skill_quality: { enabled: false } }, name: SKILL_NAME, sha256: sha, content: skillDoc, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(disabled.status, 'disabled');
  assert.equal(calls.length, 0);

  const first = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: sha, content: skillDoc, refs: ['extra.md'], fetchImpl: fetchOk });
  assert.equal(first.status, 'checked');
  assert.equal(first.marker.verdict.status, 'warn');
  assert.equal(calls.length, 1);
  assert.ok(fs.existsSync(path.join(root, 'data', 'skill_quality', sha + '.json')));
  assert.equal(calls[0].body.temperature, 0);
  assert.ok(calls[0].body.messages[1].content.includes('references 文件清单'));

  const second = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: sha, content: skillDoc, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(second.status, 'cached');
  assert.equal(calls.length, 1); // 同指纹零 API

  // 并发首检去重：同指纹两个会话同时开赛只花一次钱
  const concurrentSha = 'a'.repeat(64);
  const pair = await Promise.all([
    sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: concurrentSha, content: skillDoc, fetchImpl: fetchOk }),
    sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: concurrentSha, content: skillDoc, fetchImpl: fetchOk }),
  ]);
  assert.equal(pair[0].status, 'checked');
  assert.equal(pair[1].status, 'checked');
  assert.equal(calls.length, 2);

  // 内容变化 = 新指纹 = 重新首检
  const changedDoc = skillDoc.replace('摘要要写清模型与结果', '摘要要写清模型、结果与检验');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), changedDoc, 'utf8');
  const changedSha = shaOf();
  assert.notEqual(changedSha, sha);
  const rechecked = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: changedSha, content: changedDoc, fetchImpl: fetchOk });
  assert.equal(rechecked.status, 'checked');
  assert.equal(calls.length, 3);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillDoc, 'utf8'); // 还原，后续用原指纹

  // 跳过标记
  const declineSha = 'b'.repeat(64);
  sq.declineSkill(root, { name: SKILL_NAME, sha256: declineSha });
  const declined = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: declineSha, content: skillDoc, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(declined.status, 'declined');
  assert.equal(calls.length, 3);

  // 无指纹跳过
  const noSha = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: null, content: skillDoc, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(noSha.status, 'skipped');

  // ---------- 失败不落标记、不阻塞、可重试 ----------
  const errSha = 'c'.repeat(64);
  const httpErr = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: errSha, content: skillDoc, fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }) });
  assert.equal(httpErr.status, 'error');
  assert.equal(sq.readMarker(root, errSha), null);
  const badJson = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: errSha, content: skillDoc, fetchImpl: async () => okResponse('不是 JSON') });
  assert.equal(badJson.status, 'error');
  assert.equal(sq.readMarker(root, errSha), null);
  const retry = await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: errSha, content: skillDoc, fetchImpl: fetchOk });
  assert.equal(retry.status, 'checked');

  // ---------- 提示文本 ----------
  const warnMarker = sq.readMarker(root, sha);
  assert.ok(sq.verdictText(warnMarker).includes('MATLAB 与 Python 指令冲突'));
  assert.ok(sq.qualityWarning(root, sha, settings).includes('[技能质检警告]'));
  assert.equal(sq.qualityWarning(root, declineSha, settings), '');
  assert.equal(sq.qualityWarning(root, 'd'.repeat(64), settings), '');
  assert.equal(sq.qualityWarning(root, sha, { skill_quality: { enabled: false } }), ''); // 关闭即零影响
  assert.equal(sq.qualityWarning(root, sha), ''); // 未传 settings 视为关闭
  const okSha = 'e'.repeat(64);
  await sq.checkSkill({ appDir: root, settings, name: SKILL_NAME, sha256: okSha, content: skillDoc, fetchImpl: async () => okResponse(JSON.stringify({ status: 'ok', summary: '无问题', issues: [] })) });
  assert.equal(sq.qualityWarning(root, okSha, settings), ''); // ok 不占 system token
  assert.ok(sq.verdictText(sq.readMarker(root, okSha)).includes('通过'));

  // ---------- 工具链路：skill_load 自动首检 + 计费 ----------
  // 清掉该指纹标记，模拟此版本第一次经工具加载（前面已直接质检过，会命中缓存）
  fs.rmSync(path.join(root, 'data', 'skill_quality', sha + '.json'));
  // 工具路径不接受 fetchImpl 注入，临时桩掉全局 fetch（结束后还原）
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchOk;
  const spendCalls = [];
  const session = { id: 'quality-test', mode: 'math' };
  const ctx = { appDir: root, session, settings, spend: (model, usage, kind) => spendCalls.push({ model, usage, kind }) };
  const toolOut = await executeTool(ctx, 'skill_load', { name: SKILL_NAME });
  assert.equal(toolOut.ok, true);
  assert.ok(toolOut.data.includes('[技能质检]'));
  assert.ok(toolOut.data.includes('MATLAB 与 Python 指令冲突'));
  assert.equal(spendCalls.length, 1);
  assert.equal(spendCalls[0].kind, 'skill_quality');
  assert.equal(spendCalls[0].model, 'test-model');
  const before = calls.length;
  const toolOut2 = await executeTool(ctx, 'skill_load', { name: SKILL_NAME });
  assert.ok(toolOut2.data.includes('[技能质检]'));
  assert.equal(calls.length, before); // 缓存复用，零 API
  assert.equal(spendCalls.length, 1);
  assert.equal(session.skill_reads.at(-1).quality, 'cached');

  // ---------- 修复副本 ----------
  const fixedBody = originalBody.replace('先用 MATLAB 求解', '先用 Python 求解');
  const repairFetch = async () => okResponse(fixedBody);
  const repaired = await sq.repairSkill({ appDir: root, settings, name: SKILL_NAME, fetchImpl: repairFetch });
  assert.equal(repaired.mode, 'rewrite');
  assert.equal(repaired.name, `${SKILL_NAME}-xihe-fixed`);
  assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), skillDoc); // 原件不动
  const fixedDoc = fs.readFileSync(path.join(repaired.dir, 'SKILL.md'), 'utf8');
  assert.ok(fixedDoc.includes('origin: xihe-quality-repair'));
  assert.ok(fixedDoc.includes(`source_sha256: ${sha}`));
  assert.ok(fixedDoc.includes('先用 Python 求解'));
  assert.ok(fs.existsSync(path.join(repaired.dir, 'references', 'extra.md'))); // refs 复制
  const repaired2 = await sq.repairSkill({ appDir: root, settings, name: SKILL_NAME, fetchImpl: repairFetch });
  assert.equal(repaired2.name, `${SKILL_NAME}-xihe-fixed-2`); // 旧副本保留

  // 截断降级：批注副本，原文逐字保留并披露
  const truncated = await sq.repairSkill({ appDir: root, settings, name: SKILL_NAME, fetchImpl: async () => okResponse('短', 'length') });
  assert.equal(truncated.mode, 'annotated');
  const annotatedDoc = fs.readFileSync(path.join(truncated.dir, 'SKILL.md'), 'utf8');
  assert.ok(annotatedDoc.includes('羲和质检修复批注'));
  assert.ok(annotatedDoc.includes(originalBody.trim()));

  // 无质检结论不许修复
  const freshName = 'xihe-quality-fresh-skill';
  const freshDir = path.join(root, 'skills', freshName);
  fs.mkdirSync(freshDir, { recursive: true });
  fs.writeFileSync(path.join(freshDir, 'SKILL.md'), `---\nname: ${freshName}\ndescription: 未质检\nmetadata:\n  version: "1.0"\n---\n\n正文足够长以满足加载要求，这里只是测试占位内容。\n`, 'utf8');
  await assert.rejects(() => sq.repairSkill({ appDir: root, settings, name: freshName, fetchImpl: repairFetch }), /尚无质检结论/);
  await assert.rejects(() => sq.repairSkill({ appDir: root, settings: { ...settings, skill_quality: { enabled: false } }, name: SKILL_NAME, fetchImpl: repairFetch }), /未启用/);

  // ---------- skill_quality 工具 ----------
  const statusOut = await executeTool(ctx, 'skill_quality', { op: 'status', name: SKILL_NAME });
  assert.ok(statusOut.data.includes('[技能质检]'));
  const skipOut = await executeTool(ctx, 'skill_quality', { op: 'skip', name: freshName });
  assert.ok(skipOut.data.includes('已标记跳过'));
  assert.equal(sq.readMarker(root, require('./skills').loadSkill(root, freshName).sha256).status, 'declined');
  globalThis.fetch = repairFetch; // 工具修复路径返回修复正文而非质检结论
  const repairOut = await executeTool(ctx, 'skill_quality', { op: 'repair', name: SKILL_NAME });
  assert.ok(repairOut.data.includes('修复副本已生成'));
  assert.ok(repairOut.data.includes('原件'));
  globalThis.fetch = realFetch;

  console.log('skill_quality 离线测试全部通过（零真实 API）');
})().catch(e => { console.error(e); process.exit(1); });
