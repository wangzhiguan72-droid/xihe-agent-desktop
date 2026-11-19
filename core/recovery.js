'use strict';
function failureKind(reason, detail) {
  const text = String(reason || '') + ' ' + String(detail || '');
  if (/insufficient.{0,20}(balance|quota)|余额不足|额度不足|quota.{0,20}exhaust|credit.{0,20}(exhaust|insufficient)/i.test(text)) return 'quota_exhausted';
  if (/\b401\b|invalid.{0,10}(key|token)|authentication/i.test(text)) return 'authentication';
  if (/\b429\b|rate.{0,10}limit|限流/i.test(text)) return 'rate_limited';
  if (/重复已完成决策/.test(text)) return 'repeated_decision';
  return 'runtime_error';
}
function verifiedReportReceipts(session, workspace, runs) {
  if (!workspace || !runs.length) return [];
  try {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const agent = require('./agent'), sandbox = new (require('./sandbox').Sandbox)(workspace, { readOnlyRoots: [] });
    const currentHash = agent.inputStampHash(agent.stampInputFiles(workspace));
    if (!runs.some(run => run.input_hash && run.input_hash === currentHash)) return [];
    const messages = session.messages || [], seen = new Set(), receipts = [];
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 80) && receipts.length < 3; i--) {
      for (const call of [...(messages[i].tool_calls || [])].reverse()) {
        if (!['fs_write', 'fs_edit'].includes(call.function?.name) || typeof call.function.arguments !== 'string' || call.function.arguments.length > 200000) continue;
        let args; try { args = JSON.parse(call.function.arguments); } catch { continue; }
        if (typeof args.path !== 'string' || /[\x00-\x1f]/.test(args.path) || !/\.(md|txt)$/i.test(args.path)) continue;
        let file; try { file = sandbox.resolve(args.path, 'r'); } catch { continue; }
        const rel = path.relative(sandbox.root, file).replace(/\\/g, '/');
        if (!rel || rel.startsWith('../') || path.isAbsolute(rel) || seen.has(rel)) continue;
        seen.add(rel);
        if (call.function.name !== 'fs_write' || typeof args.content !== 'string' || !args.content.trim() || Buffer.byteLength(args.content) > 131072) continue;
        const acknowledged = messages.slice(i + 1).some(message => message.role === 'tool' && message.tool_call_id === call.id
          && typeof message.content === 'string' && /^已写入 /.test(message.content));
        if (!acknowledged || !fs.statSync(file).isFile() || fs.statSync(file).size > 131072) continue;
        const content = fs.readFileSync(file);
        if (!content.equals(Buffer.from(args.content, 'utf8'))) continue;
        receipts.push({ path: rel, sha256: crypto.createHash('sha256').update(content).digest('hex') });
      }
    }
    return receipts;
  } catch { return []; }
}
function recoveryPrompt(session, { workspace } = {}) {
  const current = (session.runs || []).filter(r => r.ok && !r.unstable && r.epoch === (session.data_epoch || 0)).slice(-3);
  const reports = verifiedReportReceipts(session, workspace, current);
  return '[用户·恢复当前任务] 原阻塞：' + (session.last_error?.reason || '中断后收尾')
    + '\n已有当前版本成功计算：' + (current.length ? current.map(r => r.run_id + '：' + String(r.out || '').slice(-1000)).join('\n') : '无可确认记录')
    + (reports.length ? '\n宿主已核验未变化的报告（成功写入回执、当前文件字节和成功运行输入指纹均匹配）：' + JSON.stringify(reports)
      + '\n若只缺最终说明，直接根据这些已核验回执完成说明，无需重复读取同一报告或扫描空经验库。这些回执不替代原任务尚未完成的验收。'
      : '\n先读取现有产物和运行记录，从未完成的验证、报告或交付步骤继续。')
    + '\n不得无故重跑已成功计算。若产物缺失、输入已变或必须复核，先说明依据再重算。不要重放结果未知的写入。';
}
module.exports = { failureKind, recoveryPrompt };
