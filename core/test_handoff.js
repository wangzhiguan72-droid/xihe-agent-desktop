'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
let pass = 0, fail = 0;
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.xihe-handoff-'));
function t(name, fn) { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', e.message); } }
try {
  let h;
  t('交接模块可用', () => { h = require('./handoff'); });
  if (h) {
    t('长报告完整落盘，活动交接有界且不冒充正式证据', () => {
      const report = '关键结果\n' + '调试日志'.repeat(7000) + '\n尚未验证边界条件';
      const result = h.makeHandoff({ workspace: tmp, sessionId: 's:1', taskId: 'p1_', role: 'coder',
        report, reason: 'stop', childRunIds: ['subrun7'], messages: [{ role: 'assistant', content: report }] });
      assert.equal(result.status, 'completed');
      assert.equal(result.acceptance, 'pending');
      assert.equal(result.formal, false);
      assert.deepEqual(result.child_run_ids, ['subrun7']);
      assert.ok(JSON.stringify(result).length < 3500);
      const raw = JSON.parse(fs.readFileSync(path.join(tmp, result.archive), 'utf8'));
      assert.equal(raw.report, report);
      assert.equal(raw.messages[0].content, report);
      assert.equal(h.archiveHash(path.join(tmp, result.archive)), result.archive_hash);
    });
    t('到上限、预算中断和无引擎状态不得计为完成', () => {
      for (const reason of ['max_iter', 'budget', 'provider_error', 'output_truncated', 'empty_report', 'unverified']) {
        const r = h.makeHandoff({ workspace: tmp, sessionId: 's', taskId: reason, report: '已完成', reason });
        assert.notEqual(r.status, 'completed');
      }
      const stopped = h.makeHandoff({ workspace: tmp, report: 'stop', reason: 'stopped' });
      assert.equal(stopped.status, 'cancelled');
    });
    t('归档目标被文件阻断时仍返回失败证据，不谎称原文已保存', () => {
      const blocked = path.join(tmp, 'blocked'); fs.writeFileSync(blocked, 'file');
      const r = h.makeHandoff({ workspace: blocked, report: 'x'.repeat(9000), reason: 'stop' });
      assert.equal(r.archive, null);
      assert.ok(r.warnings.some(x => /归档/.test(x)));
      assert.equal(r.acceptance, 'pending');
    });
    t('上下文归档保留完整历史与哈希，目录名不能越界', () => {
      const messages = [{ role: 'user', content: '原始约束必须保留' }];
      const a = h.archiveContext(tmp, '../../outside', messages);
      assert.ok(a.path.startsWith(path.join(tmp, 'findings', 'context') + path.sep));
      assert.deepEqual(JSON.parse(fs.readFileSync(a.path, 'utf8')).messages, messages);
      assert.equal(h.archiveHash(a.path), a.sha256);
    });
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${pass} 通过 / ${fail} 失败`); process.exitCode = fail ? 1 : 0;
