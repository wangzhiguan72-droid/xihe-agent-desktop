'use strict';
const { checkedFile } = require('./verification_run');
const { sha256 } = require('./support_integrity');
function freshReproBlockers(root, record) {
  if (!record?.at) return ['空目录复现尚未执行'];
  if (!record.pass || record.run_ok !== true) return ['空目录复现未通过：' + (record.status || '缺成功执行证明')];
  if (!Array.isArray(record.files) || !record.files.length || !record.manifest) return ['复现缺当前输入、结果与清单指纹，请重新repro_check'];
  const issues = [];
  for (const row of [...record.files, record.manifest]) {
    try { checkedFile(root, row); } catch (e) { issues.push('复现证据：' + e.message); }
  }
  try {
    const main = record.files.find(row => row.rel === record.main_script);
    if (!main || main.sha256 !== record.script_sha256 || sha256(checkedFile(root, main)) !== record.script_sha256) issues.push('复现主脚本版本已变化');
  } catch { issues.push('复现主脚本不可读'); }
  return [...new Set(issues)];
}
module.exports = { freshReproBlockers };
