// 外部模型调度：ChatGPT 网页版 / Codex 桌面版 / GLM 网页 / DeepSeek 网页
// 策略：提示词自动进剪贴板并打开目标；结果由用户粘贴回羲和（半自动，稳定不封号）
// 额度纪律：ledger 记账，ChatGPT/Codex 每月配额预警；失败不计数
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TARGETS = {
  chatgpt_web: { label: 'ChatGPT 网页版', url: 'https://chatgpt.com/', quota: 'chatgpt' },
  codex_desktop: { label: 'ChatGPT 桌面版 (Codex)', protocol: 'chatgpt://', url: 'https://chatgpt.com/codex', quota: 'chatgpt' },
  glm_web: { label: 'GLM 网页版', url: 'https://chatglm.cn/', quota: null },
  deepseek_web: { label: 'DeepSeek 网页版', url: 'https://chat.deepseek.com/', quota: null },
};

// 本地时区日期键（预算按用户本地的“今天”计，不用 UTC）
function dayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

// 账本单例：进程内共享同一对象，避免多会话各持副本互相覆盖丢账；落盘为原子替换
let _ledger = null, _ledgerDir = null;
function loadLedger(appDir) {
  if (_ledger && _ledgerDir === appDir) return _ledger;
  const p = path.join(appDir, 'data', 'ledger.json');
  let l = null;
  try { l = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  _ledger = l && typeof l === 'object' ? l : {};
  _ledger.chatgpt = _ledger.chatgpt && _ledger.chatgpt.month === monthKey() ? _ledger.chatgpt : { month: monthKey(), used: 0 };
  _ledger.costs = _ledger.costs || {};
  _ledgerDir = appDir;
  return _ledger;
}
function saveLedger(appDir, ledger) {
  const dir = path.join(appDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'ledger.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function copyToClipboard(text) {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', '$input | Set-Clipboard'], { windowsHide: true });
    let ok = false;
    ps.stdin.end(text, 'utf8');
    ps.on('close', (code) => resolve(code === 0));
    ps.on('error', () => resolve(false));
    ps.on('spawn', () => { ok = true; });
  });
}

function openTarget(t) {
  return new Promise((resolve) => {
    const child = t.protocol
      ? spawn('cmd.exe', ['/c', 'start', '', t.protocol], { windowsHide: true })
      : spawn('cmd.exe', ['/c', 'start', '', t.url], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    setTimeout(() => resolve(true), 1500); // start 通常异步拉起，进程正常退出即视为成功
  });
}

async function dispatchExternal({ appDir, target, prompt, reason, ledger, settings, sessionId, epoch }) {
  const t = TARGETS[target];
  if (!t) throw new Error(`未知调度目标 ${target}。可用: ${Object.keys(TARGETS).join(', ')}`);
  if (!prompt || String(prompt).length < 5) throw new Error('dispatch 提示词过短');

  // 持久化 handoff（应用层复审 §10）：服务重启可找回「上次外派的提示词与状态」。
  // 用户回来粘贴外部结果时，主代理能从会话上下文找到对应 handoff 记录做交叉核验。
  const handoffs = loadHandoffs(appDir);
  const hid = 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id: hid, at: Date.now(), target, prompt: String(prompt).slice(0, 4000),
    reason: String(reason || '').slice(0, 400), sessionId: sessionId || null,
    epoch: epoch || null, status: 'pending', result: null, imported_at: null,
  };
  handoffs.push(rec);
  saveHandoffs(appDir, handoffs);

  const clipOk = await copyToClipboard(String(prompt));
  const openOk = await openTarget(t);
  if (!clipOk || !openOk) {
    // 失败：标记 handoff 为 failed，不影响计数
    rec.status = 'failed'; rec.error = `clip=${clipOk} open=${openOk}`;
    saveHandoffs(appDir, handoffs);
    throw new Error(`外部调度失败（剪贴板 ${clipOk ? 'OK' : '失败'}，打开目标 ${openOk ? 'OK' : '失败'}）。请手动打开 ${t.url} 并粘贴提示词。本次未计数。`);
  }

  // 月度配额（仅 ChatGPT 系；成功后才计数）
  let quotaNote = '';
  if (t.quota) {
    if (ledger.chatgpt.month !== monthKey()) { ledger.chatgpt = { month: monthKey(), used: 0 }; }
    ledger.chatgpt.used += 1;
    saveLedger(appDir, ledger);
    quotaNote = `\n[本月 ${t.label} 已用 ${ledger.chatgpt.used}/${(settings && settings.chatgpt_quota) || 30} 次]`;
  }

  return [
    `✅ 已切换到外部模型：${t.label}`,
    `📋 完整提示词已复制到剪贴板（${String(prompt).length} 字符），浏览器/客户端已打开。`,
    `理由：${reason || '未说明'}` + quotaNote,
    ``,
    `handoff_id: ${hid}（重启服务后可用 /api/handoff/list 找回待粘贴的提示词）`,
    ``,
    `【下一步】把提示词粘贴到目标模型，得到结果后复制，回到羲和输入框粘贴发送`,
    `（系统会自动关联 handoff_id 并把外部结果与原始问题+输入版本一同记入决策卡）。`,
  ].join('\n');
}

// ---------- handoff 持久化（应用层复审 §10）----------
// 外部模型交接的持久化账本：保存目标/提示词/输入版本 epoch/状态/外部结果。
// 服务重启或前端刷新都不丢，用户回来粘贴结果时可关联原始问题做交叉验证。
function handoffsPath(appDir) { return path.join(appDir, 'data', 'handoffs.json'); }
function loadHandoffs(appDir) {
  try { return JSON.parse(fs.readFileSync(handoffsPath(appDir), 'utf8')) || []; } catch { return []; }
}
function saveHandoffs(appDir, list) {
  const dir = path.join(appDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const p = handoffsPath(appDir);
  // 只保留最近 50 条，防止文件无限增长
  const trimmed = (Array.isArray(list) ? list : []).slice(-50);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function getHandoff(appDir, id) { return loadHandoffs(appDir).find(h => h.id === id) || null; }
function importHandoffResult(appDir, id, result, sessionId) {
  const list = loadHandoffs(appDir);
  const h = list.find(x => x.id === id);
  if (!h) return null;
  h.result = String(result || '').slice(0, 8000);
  h.imported_at = Date.now();
  h.imported_in_session = sessionId || null;
  h.status = 'imported';
  saveHandoffs(appDir, list);
  return h;
}

module.exports = { TARGETS, dispatchExternal, loadLedger, saveLedger, dayKey, monthKey, loadHandoffs, saveHandoffs, getHandoff, importHandoffResult };
