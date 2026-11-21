// 羲和 Agent 前端
'use strict';
const $ = (s) => document.querySelector(s);
// 启动令牌：服务端注入 <meta name="xihe-token">（CSP 禁内联脚本，不能用 <script> 设置）
window.__XIHE_TOKEN__ = (document.querySelector('meta[name="xihe-token"]') || {}).content || '';
const state = {
  boot: null, session: null, running: false,
  localStreamRunning: false, backgroundSessionRunning: false,
  taskFocusChanging: false, chatStreamSeq: 0,
  streamBuf: null, reasonBuf: null, attachments: [],
  projectFilter: null,      // 当前侧栏选中的项目 id（null=全部）
  deliverables: [],         // 当前项目交付物缓存：对话内联路径靠它判断"可点击跳转"
  steps: null,              // 当前正在累积的步骤块（折叠式时间线）
  backgroundJobs: { jobs: [], counts: {}, resumptions: [], notifications: [], unread: 0 },
  jobRefreshSeq: 0, jobEventAbort: null, jobScopeKey: null, jobEventRetryTimer: null, seenJobNotifications: new Set(),
};

// ---------- Markdown 渲染（零依赖；属性值一律转义引号，URL 走协议白名单） ----------
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function safeUrl(u) {
  const s = String(u).trim();
  return /^(https?:|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(s) ? s : null; // 只放行 http(s) 与内嵌图片
}
function renderMD(src) {
  const blocks = [];
  let text = String(src ?? '');
  // 代码块先摘出
  text = text.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
    blocks.push(`<pre data-lang="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  text = esc(text);
  // 数学（$...$ / $$...$$）
  text = text.replace(/\$\$([^$]+)\$\$/g, (m, x) => `<span class="math">${x}</span>`);
  text = text.replace(/\$([^$\n]+)\$/g, (m, x) => `<span class="math">${x}</span>`);
  // 表格
  text = text.replace(/(^\|.+\|\s*$\n?)+/gm, (m) => {
    const rows = m.trim().split('\n').map(r => r.trim()).filter(Boolean);
    if (rows.length < 2 || !/^[\s|:-]+$/.test(rows[1])) return m;
    const cells = (r) => r.split('|').slice(1, -1).map(c => c.trim());
    const head = cells(rows[0]).map(c => `<th>${c}</th>`).join('');
    const body = rows.slice(2).map(r => '<tr>' + cells(r).map(c => `<td>${c}</td>`).join('') + '</tr>').join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  });
  // 标题
  text = text.replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  // 行内
  text = text.replace(/`([^`\n]+)`/g, (m, inner) => {
    const hit = matchArtifact(inner);
    return hit
      ? `<code class="artifact" data-artpath="${esc(hit.abs)}" title="${esc(hit.abs)}｜点击用系统程序打开，右键卡片可定位">${esc(inner)}</code>`
      : `<code>${esc(inner)}</code>`;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  // 图片 ![x](path)：URL 经白名单+转义；alt 转义（防 onerror 类属性注入）
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, p) => {
    if (/^(https?:|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(p)) return `<img src="${esc(p)}" alt="${esc(alt)}" title="${esc(alt)}">`;
    if (/^[a-z]+:/i.test(p)) return esc(m); // 其他协议（javascript: 等）只按纯文本显示
    const local = p.startsWith('/') ? p.slice(1) : p.replace(/^\.\//, '');
    return `<img src="/api/file?token=${encodeURIComponent(window.__XIHE_TOKEN__ || '')}&path=${encodeURIComponent(local)}" alt="${esc(alt)}" title="${esc(alt)}">`;
  });
  // 链接：仅 http(s) 且文本转义
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
    const u = safeUrl(href);
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : esc(m);
  });
  // 列表
  text = text.replace(/(^[ \t]*[-*] .*(\n|$))+/gm, (m) => '<ul>' + m.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*] /, '')}</li>`).join('') + '</ul>');
  text = text.replace(/(^[ \t]*\d+[.)] .*(\n|$))+/gm, (m) => '<ol>' + m.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+[.)] /, '')}</li>`).join('') + '</ol>');
  // 引用
  text = text.replace(/(^> .*(\n|$))+/gm, (m) => '<blockquote>' + m.trim().split('\n').map(l => l.replace(/^> /, '')).join('<br>') + '</blockquote>');
  // 分段
  text = text.split(/\n{2,}/).map(p => /^\s*<(h\d|ul|ol|table|blockquote|pre|\u0000)/.test(p.trim()) || p.includes('\u0000B') ? p : (p.trim() ? `<p>${p.trim().replace(/\n/g, '<br>')}</p>` : '')).join('');
  // 还原代码块
  text = text.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[+i]);
  return text;
}

// 对话内联产物路径 → 已知交付物（v2.6）：命中才可点，未命中保持纯文本，不做猜测。
function matchArtifact(p) {
  const cands = state.deliverables || [];
  if (!cands.length) return null;
  const norm = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!norm) return null;
  const base = norm.split('/').pop();
  return cands.find(f => f.path === norm)
    || cands.find(f => f.abs && f.abs.replace(/\\/g, '/').endsWith('/' + norm))
    || (base && base.length > 3 ? cands.find(f => f.path.split('/').pop() === base) : null)
    || null;
}

// ---------- API（统一带启动令牌） ----------
async function api(path, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Xihe-Token': window.__XIHE_TOKEN__ || '' };
  let res;
  try {
    res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  } catch {
    throw new Error('无法连接本机服务，请检查服务是否正在运行');
  }
  let j;
  try { j = await res.json(); }
  catch {
    throw new Error(res.ok ? '服务响应格式异常，请稍后重试' : `请求失败（HTTP ${res.status}），服务未返回有效 JSON`);
  }
  if (!res.ok) throw new Error(j?.error || `请求失败（HTTP ${res.status}）`);
  return j;
}

// ---------- 后台任务监控：状态来自持久化 jobs 队列，SSE 丢事件时由轮询补齐 ----------
const JOB_STATUS_TEXT = { queued: '排队中', starting: '启动中', running: '运行中', cancelling: '取消中', succeeded: '已完成', failed: '失败', needs_review: '待人工核查', cancelled: '已取消', interrupted: '已中断', exited_unknown: '状态未知' };
function jobScopeParams() {
  const q = new URLSearchParams();
  if (state.session?.id) q.set('session_id', state.session.id);
  if (state.session?.project_id || state.projectFilter) q.set('project_id', state.session?.project_id || state.projectFilter);
  return q;
}
function jobScopePath() {
  const q = jobScopeParams();
  const text = q.toString();
  return '/api/jobs' + (text ? '?' + text : '');
}
function jobCounts(rows) {
  const counts = {};
  for (const row of rows || []) counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
}
function jobStatusClass(status) { return String(status || '').replace(/[^a-z_]/g, ''); }
function showJobNotice(text, attention = false) {
  const el = $('#jobNotice');
  if (!el) return;
  el.textContent = text; el.classList.toggle('attention', !!attention); el.hidden = false;
  clearTimeout(showJobNotice.timer);
  showJobNotice.timer = setTimeout(() => { el.hidden = true; }, 5000);
}
function renderJobRows(rows) {
  const list = $('#jobList'); if (!list) return;
  list.innerHTML = '';
  if (!rows.length) { list.textContent = '（暂无后台任务）'; return; }
  for (const job of rows) {
    const row = document.createElement('div'); row.className = 'job-row'; row.dataset.jobId = job.id;
    const head = document.createElement('div'); head.className = 'job-row-head';
    const label = document.createElement('span'); label.className = 'job-row-label'; label.textContent = job.label || job.id; label.title = job.command || job.id;
    const status = document.createElement('span'); status.className = 'job-status ' + jobStatusClass(job.status); status.textContent = JOB_STATUS_TEXT[job.status] || job.status || '未知';
    head.append(label, status); row.appendChild(head);
    const meta = document.createElement('div'); meta.className = 'mini'; meta.textContent = `尝试 ${Number(job.attempts || 0)}/${Number(job.maxAttempts || 1)}${job.retryable ? ' · 可续跑' : ''}`; row.appendChild(meta);
    if (job.status === 'needs_review') { const warn = document.createElement('div'); warn.className = 'job-row-error'; warn.textContent = '将从任务入口重跑，请先核对已有产物。'; row.appendChild(warn); }
    if (job.lastError) { const err = document.createElement('div'); err.className = 'job-row-error'; err.textContent = job.lastError; row.appendChild(err); }
    const actions = document.createElement('div'); actions.className = 'job-row-actions';
    const detail = document.createElement('button'); detail.className = 'ghost tiny'; detail.type = 'button'; detail.textContent = '查看日志'; detail.onclick = () => showJobDetails(job.id, row); actions.appendChild(detail);
    if (['failed', 'needs_review', 'interrupted', 'exited_unknown'].includes(job.status)) {
      const retry = document.createElement('button'); retry.className = 'ghost tiny'; retry.type = 'button'; retry.textContent = '重试'; retry.onclick = () => retryBackgroundJob(job.id); actions.appendChild(retry);
    }
    if (['queued', 'starting', 'running'].includes(job.status)) {
      const cancel = document.createElement('button'); cancel.className = 'ghost tiny'; cancel.type = 'button'; cancel.textContent = '取消'; cancel.onclick = () => cancelBackgroundJob(job.id); actions.appendChild(cancel);
    }
    row.appendChild(actions); list.appendChild(row);
  }
}
function renderJobs(payload, { notify = false } = {}) {
  const incoming = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const previous = new Map((state.backgroundJobs.jobs || []).map(j => [j.id, j]));
  const counts = payload?.counts && typeof payload.counts === 'object' ? payload.counts : jobCounts(incoming);
  const notifications = Array.isArray(payload?.notifications) ? payload.notifications : state.backgroundJobs.notifications || [];
  const resumptions = Array.isArray(payload?.resumptions) ? payload.resumptions : state.backgroundJobs.resumptions || [];
  const unread = Number.isFinite(Number(payload?.unread)) ? Number(payload.unread) : notifications.filter(n => !n.read).length;
  state.backgroundJobs = { jobs: incoming, counts, resumptions, notifications, unread };
  const bar = $('#jobStatusBar'); const text = $('#jobStatusText'); const badge = $('#jobBadge');
  const active = (counts.queued || 0) + (counts.starting || 0) + (counts.running || 0) + (counts.cancelling || 0);
  const attention = (counts.failed || 0) + (counts.needs_review || 0) + resumptions.length;
  if (bar) { bar.hidden = incoming.length === 0 && !resumptions.length || (!active && !attention && !unread); bar.classList.toggle('attention', attention > 0); }
  if (text) text.textContent = `后台任务　排队 ${counts.queued || 0} · 运行 ${(counts.starting || 0) + (counts.running || 0)} · 失败/待核查 ${attention}`;
  if (badge) { badge.textContent = unread || active || attention ? `${unread || active + attention}` : ''; badge.style.color = attention || unread ? 'var(--red)' : ''; }
  if ($('#jobSummary')) $('#jobSummary').textContent = incoming.length || resumptions.length ? `共 ${incoming.length} 个任务；排队 ${counts.queued || 0}，运行 ${(counts.starting || 0) + (counts.running || 0)}，失败/待核查 ${attention}` : '（暂无任务）';
  renderJobResumptions(resumptions);
  renderJobRows(incoming);
  renderJobNotifications(notifications);
  if (notify) for (const job of incoming) {
    const old = previous.get(job.id);
    if (!old || old.status === job.status) continue;
    if (job.status === 'succeeded') showJobNotice(`后台任务完成：${job.label || job.id}`);
    else if (['failed', 'needs_review'].includes(job.status)) showJobNotice(`后台任务需要处理：${job.label || job.id}`, true);
    else if (job.status === 'queued' && old.status === 'running') showJobNotice(`后台任务已重新排队：${job.label || job.id}`);
  }
}
function renderJobResumptions(rows) {
  const box = $('#jobResumptions'); if (!box) return;
  box.innerHTML = '';
  if (!rows.length) return;
  const heading = document.createElement('h4'); heading.textContent = '主流程待恢复'; box.appendChild(heading);
  for (const item of rows) {
    const card = document.createElement('div'); card.className = 'job-resumption'; card.dataset.sessionId = item.session_id;
    const title = document.createElement('strong'); title.textContent = item.title || item.session_id; card.appendChild(title);
    const warning = document.createElement('div'); warning.className = 'job-row-error';
    warning.textContent = `上次执行结果不明，请核对已有产物后继续。${item.error ? ' ' + item.error : ''}`; card.appendChild(warning);
    if (item.interrupted_approval) {
      const approval = document.createElement('div'); approval.className = 'mini';
      approval.textContent = `中断的审批：${item.interrupted_approval.tool || '工具'} · ${item.interrupted_approval.summary || ''}`;
      card.appendChild(approval);
    }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'primary tiny'; button.textContent = '核对后继续';
    button.onclick = () => resumeBackgroundSession(item);
    card.appendChild(button); box.appendChild(card);
  }
}
function renderJobNotifications(notifications) {
  const box = $('#jobNotifications'); if (!box) return;
  box.innerHTML = '';
  const pending = (notifications || []).filter(n => !n.read);
  $('#btnAckJobNotifications').hidden = !pending.length;
  if (!notifications?.length) { box.textContent = ''; return; }
  const heading = document.createElement('h4'); heading.textContent = '通知'; box.appendChild(heading);
  for (const n of notifications.slice(0, 20)) {
    const item = document.createElement('div'); item.className = 'job-notification' + (n.read ? ' read' : '');
    item.dataset.notificationId = n.id;
    const text = document.createElement('span');
    const statusText = JOB_STATUS_TEXT[n.job?.status] || '任务状态更新';
    const recoveryText = ['reclaim', 'recovered'].includes(n.type) ? ' · 服务恢复后已接回' : '';
    text.textContent = `${statusText}${recoveryText}：${n.job?.label || n.job?.id || ''}`;
    item.appendChild(text);
    if (!n.read) {
      const ack = document.createElement('button'); ack.className = 'ghost tiny'; ack.type = 'button'; ack.textContent = '标为已读';
      ack.onclick = () => acknowledgeJobNotifications([n.id]); item.appendChild(ack);
    }
    box.appendChild(item);
  }
}
async function acknowledgeJobNotifications(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  try {
    await api('/api/jobs/ack', { ids, ...Object.fromEntries(jobScopeParams()) });
    const selected = new Set(ids);
    const notifications = (state.backgroundJobs.notifications || []).map(n => selected.has(n.id) ? { ...n, read: true } : n);
    renderJobs({ ...state.backgroundJobs, notifications, unread: notifications.filter(n => !n.read).length }, { notify: false });
    await refreshJobs();
  }
  catch (e) { showJobNotice('更新任务通知失败：' + (e.message || e), true); }
}
async function refreshJobs({ notify = false } = {}) {
  const seq = ++state.jobRefreshSeq;
  const scope = jobScopePath();
  if (state.jobScopeKey != null && state.jobScopeKey !== scope) {
    state.jobEventAbort?.abort(); state.jobEventAbort = null; clearTimeout(state.jobEventRetryTimer);
    state.jobScopeKey = scope;
    connectJobEvents();
  }
  state.jobScopeKey = scope;
  try { const data = await api(scope); if (seq !== state.jobRefreshSeq) return; renderJobs(data, { notify }); }
  catch (e) { /* 后台监控失败不打断聊天；下一轮轮询或 SSE 重连再试 */ }
}
function handleJobEvent(event) {
  if (!event) return;
  state.jobRefreshSeq++;
  if (event.type === 'session') {
    refreshSessions();
    if (event.session_id && state.session?.id === event.session_id) {
      setRunning(['running', 'waiting_approval'].includes(event.status), 'background');
      if (!state.localStreamRunning) openSession(event.session_id).catch(() => {});
    }
    return;
  }
  if (event.type === 'snapshot') renderJobs(event, { notify: false });
  else if (!event.job && (event.notifications || event.notification)) {
    const notifications = event.notifications || [event.notification, ...(state.backgroundJobs.notifications || []).filter(n => n.id !== event.notification.id)];
    renderJobs({ ...state.backgroundJobs, notifications, unread: event.unread ?? notifications.filter(n => !n.read).length }, { notify: false });
    if (event.notification && !event.notification.read && !state.seenJobNotifications.has(event.notification.id)) {
      state.seenJobNotifications.add(event.notification.id);
      showJobNotice(`${JOB_STATUS_TEXT[event.notification.job?.status] || '后台任务状态更新'}：${event.notification.job?.label || event.notification.job?.id || ''}`,
        ['failed', 'needs_review'].includes(event.notification.job?.status));
    }
  }
  if (!event.job) return;
  const rows = [...(state.backgroundJobs.jobs || [])]; const i = rows.findIndex(j => j.id === event.job.id);
  const previous = i >= 0 ? rows[i] : null;
  if (i >= 0) rows[i] = event.job; else rows.unshift(event.job);
  const counts = event.counts || { ...state.backgroundJobs.counts };
  if (!event.counts && previous && previous.status !== event.job.status) {
    counts[previous.status] = Math.max(0, (counts[previous.status] || 0) - 1);
    counts[event.job.status] = (counts[event.job.status] || 0) + 1;
  } else if (!event.counts && !previous) counts[event.job.status] = (counts[event.job.status] || 0) + 1;
  const notifications = event.notifications || (event.notification
    ? [event.notification, ...(state.backgroundJobs.notifications || []).filter(n => n.id !== event.notification.id)]
    : state.backgroundJobs.notifications);
  renderJobs({ jobs: rows, counts, resumptions: event.resumptions || state.backgroundJobs.resumptions, notifications,
    unread: event.unread ?? state.backgroundJobs.unread }, { notify: event.type !== 'enqueue' && !event.notification });
  if (event.notification && !event.notification.read && !state.seenJobNotifications.has(event.notification.id)) {
    state.seenJobNotifications.add(event.notification.id);
    showJobNotice(`${JOB_STATUS_TEXT[event.notification.job?.status] || '后台任务状态更新'}：${event.notification.job?.label || event.notification.job?.id || ''}`,
      ['failed', 'needs_review'].includes(event.notification.job?.status));
  }
  if (['finish', 'retry', 'needs_review', 'reclaim', 'recovered'].includes(event.type) && event.job.session_id && state.session?.id === event.job.session_id && !state.localStreamRunning) {
    openSession(event.job.session_id).catch(() => {});
  }
  if (Array.isArray(event.resumptions)) renderJobResumptions(event.resumptions);
}
async function connectJobEvents() {
  if (state.jobEventAbort || !window.fetch) return;
  const scope = jobScopePath();
  const controller = new AbortController(); state.jobEventAbort = controller;
  try {
    const url = '/api/jobs/events' + scope.slice('/api/jobs'.length);
    const res = await fetch(url, { headers: { 'X-Xihe-Token': window.__XIHE_TOKEN__ || '' }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error('job events unavailable');
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (!controller.signal.aborted) {
      const part = await reader.read(); if (part.done) break; buf += dec.decode(part.value, { stream: true });
      let idx; while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2); const line = block.split('\n').find(x => x.startsWith('data:'));
        if (!line || controller.signal.aborted || jobScopePath() !== scope) continue;
        try { handleJobEvent(JSON.parse(line.slice(5))); } catch {}
      }
    }
  } catch {} finally {
    if (state.jobEventAbort === controller) {
      state.jobEventAbort = null;
      if (!controller.signal.aborted) state.jobEventRetryTimer = setTimeout(connectJobEvents, 5000);
    }
  }
}
function scopeJobMutation(id) { return { id, ...Object.fromEntries(jobScopeParams()) }; }
async function retryBackgroundJob(id) {
  try { await api('/api/jobs/retry', scopeJobMutation(id)); showJobNotice('已重新排队任务：' + id); await refreshJobs(); }
  catch (e) { showJobNotice('任务重试失败：' + (e.message || e), true); }
}
async function cancelBackgroundJob(id) {
  try { await api('/api/jobs/cancel', scopeJobMutation(id)); showJobNotice('已请求取消任务：' + id); await refreshJobs(); }
  catch (e) { showJobNotice('任务取消失败：' + (e.message || e), true); }
}
async function showJobDetails(id, row) {
  try { const q = jobScopeParams(); q.set('id', id); const r = await api('/api/jobs/detail?' + q.toString()); const pre = document.createElement('pre'); pre.className = 'mini'; pre.textContent = (r.tail || '') + (r.stderr ? '\n' + r.stderr : ''); row.appendChild(pre); }
  catch (e) { showJobNotice('读取任务日志失败：' + (e.message || e), true); }
}
async function resumeBackgroundSession(item) {
  const button = [...document.querySelectorAll('.job-resumption')].find(el => el.dataset.sessionId === item.session_id)?.querySelector('button');
  if (button) { button.disabled = true; button.textContent = '正在恢复…'; }
  try {
    await api('/api/session/resume', { id: item.session_id, project_id: item.project_id || '', confirmed: true });
    if (state.session?.id === item.session_id) setRunning(true, 'background');
    showJobNotice('已从保存的检查点恢复主流程：' + (item.title || item.session_id));
    await refreshJobs(); await refreshSessions();
    if (state.session?.id === item.session_id) await openSession(item.session_id);
  } catch (e) {
    showJobNotice('恢复主流程失败：' + (e.message || e), true);
    if (button) { button.disabled = false; button.textContent = '核对后继续'; }
  }
}
function openJobsDialog() { renderJobRows(state.backgroundJobs.jobs || []); $('#dlgJobs')?.showModal(); }
function startJobMonitor() {
  refreshJobs(); connectJobEvents();
  if (!state.jobPollTimer) state.jobPollTimer = setInterval(() => refreshJobs({ notify: true }), 5000);
}

// ---------- 会话渲染 ----------
function addMsgEl(role, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = `<div class="who">${who || (role === 'user' ? '你' : '羲和')}</div><div class="body"></div>`;
  $('#chatStream').appendChild(div);
  scrollBottom();
  return div;
}
function scrollBottom() { const c = $('#chatStream'); c.scrollTop = c.scrollHeight; }

// 折叠式步骤时间线（v2.6）：连续的工具卡收进一个 <details>，summary 显示步数与耗时。
// 失败步骤在 summary 上标红计数——折叠是默认态，不能把错误一起埋掉。
function stepGroup(container) {
  let d = container.querySelector(':scope > details.steps');
  if (!d) {
    d = document.createElement('details');
    d.className = 'steps';
    d.dataset.t0 = String(Date.now());
    d.innerHTML = '<summary class="steps-sum"></summary><div class="steps-body"></div>';
    container.appendChild(d);
  }
  return d;
}
function updateStepSummary(d) {
  if (!d) return;
  const cards = d.querySelectorAll('.toolcard');
  const bad = d.querySelectorAll('.toolcard span.bad').length;
  const secs = Math.round((Date.now() - Number(d.dataset.t0 || Date.now())) / 1000);
  const dur = secs >= 60 ? Math.floor(secs / 60) + 'm' + String(secs % 60).padStart(2, '0') + 's' : secs + 's';
  d.querySelector('summary').innerHTML = `🛠 工作过程（${cards.length} 步 · ${dur}）`
    + (bad ? ` <span class="bad">${bad} 步失败</span>` : '');
}
function lastStepGroup() {
  const groups = $('#chatStream').querySelectorAll('details.steps');
  return groups.length ? groups[groups.length - 1] : null;
}

function renderToolCard(container, name, argsPrev, ok, resultPrev, ms, callId) {
  const el = document.createElement('div');
  el.className = 'toolcard';
  if (callId) el.dataset.callid = callId;
  // 三态：ok=null=运行中(⏳)，true=✓，false=✗（此前 ok=null 被 falsy 渲染成 ✗ ——运行中误显失败）
  const status = ok == null ? '<span class="run">⏳</span>' : `<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span>`;
  el.innerHTML = `<div class="head"><span class="tname">🛠 ${esc(name)}</span><span class="tprev">${esc(argsPrev || '')}</span>${status}<span class="tms">${ms != null ? ms + 'ms' : ''}</span></div><div class="tbody" style="display:none">${esc(resultPrev || '')}</div>`;
  el.querySelector('.head').onclick = () => { el.classList.toggle('open'); const b = el.querySelector('.tbody'); b.style.display = b.style.display === 'none' ? 'block' : 'none'; };
  const g = stepGroup(container);
  g.querySelector('.steps-body').appendChild(el);
  updateStepSummary(g);
  scrollBottom();
  return el;
}
// 状态条：让长任务期间界面不"啥都没有"——当前动作 + 步骤计数 + 已耗时
function setWork(text, meta) {
  const bar = $('#workBar');
  if (!bar) return;
  if (text == null) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  $('#workText').textContent = text;
  $('#workMeta').textContent = meta || '';
}

function renderHistory(s) {
  const cs = $('#chatStream');
  cs.innerHTML = '';
  state.stepCount = 0;
  setWork(null);
  let lastGroup = null; // 历史重放：同一 assistant 消息里的工具卡共用一个折叠块
  for (let i = 0; i < s.messages.length; i++) {
    const m = s.messages[i];
    if (m.role === 'user') {
      const el = addMsgEl('user');
      el.querySelector('.body').innerHTML = renderMD(m.content);
      lastGroup = null;
    } else if (m.role === 'assistant') {
      const el = addMsgEl('assistant');
      const body = el.querySelector('.body');
      if (m.content) body.innerHTML = renderMD(m.content);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          // 找配对的 tool 结果
          let result = '', ok = true;
          for (let j = i + 1; j < s.messages.length; j++) {
            if (s.messages[j].role === 'tool' && s.messages[j].tool_call_id === tc.id) { result = s.messages[j].content; ok = !/^\[工具执行失败\]/.test(result); break; }
          }
          let argsPrev = '';
          try { const a = JSON.parse(tc.function.arguments); argsPrev = Object.values(a).map(v => String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 60)).join(' · '); } catch { argsPrev = tc.function.arguments.slice(0, 60); }
          renderToolCard(body, tc.function.name, argsPrev, ok, result, null);
          lastGroup = body.querySelector(':scope > details.steps');
        }
      }
      if (!m.content && !m.tool_calls) body.innerHTML = '<span class="mini">(空回复)</span>';
    }
  }
  if (lastGroup) updateStepSummary(lastGroup);
  renderTodos(s.todos);
  renderMemory(s.memory);
  updateCost(s.usage);
  if (s.pendingQuestion) showQuestion(s.pendingQuestion.question, s.pendingQuestion.options, s.pendingQuestion);
  else if (s.wait_reason?.kind === 'decision_text') showQuestion(s.wait_reason.question, []);
}

function renderTodos(todos) {
  const el = $('#todoList');
  if (!todos || !todos.length) { el.innerHTML = '（暂无）'; return; }
  el.innerHTML = todos.map(t => {
    const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '▶' : '○';
    const cls = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'prog' : '';
    return `<div class="ti"><span>${icon}</span><span class="${cls}">${esc(t.content)}</span></div>`;
  }).join('');
}
function renderMemory(mem) {
  const el = $('#memList');
  if (!mem || !mem.length) { el.innerHTML = '（暂无）'; return; }
  el.innerHTML = mem.slice(-12).map(m => `<div class="ti">• ${esc(m.text).slice(0, 120)}</div>`).join('');
}
function updateCost(u) {
  if (!u) return;
  $('#tIn').textContent = fmtK(u.prompt_tokens);
  $('#tOut').textContent = fmtK(u.completion_tokens);
  $('#tCalls').textContent = u.calls || 0;
  const hit = u.prompt_tokens ? Math.round(100 * (u.cache_hit_tokens || 0) / u.prompt_tokens) : 0;
  $('#tHit').textContent = hit + '%';
  $('#tVision').textContent = u.vision_calls || 0;
  // Historical per-model totals require reading the ledger. Refresh on open,
  // explicit action, or session switch, rather than on every usage event.
  if ($('#cacheDiagnostics').open && $('#cacheDiagnostics').dataset.sessionId !== state.session?.id) refreshCacheDiagnostics();
}
let cacheDiagnosticSeq = 0;
function cachePrefixDescription(row) {
  const c = row.comparison || {};
  const names = { first: '本轮首个样本', unchanged: '输入内容保持一致', append: '历史仅在末尾追加', rewrite: '请求消息发生变化（可能含临时状态）', shorter: '请求消息缩短', structure_change: '系统提示、工具或设置变化', route_change: '模型或通道已切换', skipped_large_request: '请求较大，本次未比较前缀' };
  const parts = { system: '系统提示', tools: '工具列表', options: '请求设置', conversation: '历史消息' };
  let text = names[c.kind] || '前缀待核对';
  const changes = (c.changed_parts || []).filter(key => key !== 'conversation').map(key => parts[key] || '请求结构');
  if (changes.length) text += '；变化：' + changes.join('、');
  if (c.kind === 'rewrite' && c.first_changed) text += '；首处位于第' + (c.first_changed.index + 1) + '条消息';
  return text;
}
async function refreshCacheDiagnostics() {
  const seq = ++cacheDiagnosticSeq;
  const id = state.session?.id;
  const body = $('#cacheDiagnosticsBody');
  if (!id) { body.textContent = '打开会话后查看。'; return; }
  $('#cacheDiagnostics').dataset.sessionId = id;
  body.textContent = '读取诊断中…';
  let report;
  try { report = await api('/api/session/cache-diagnostics?session_id=' + encodeURIComponent(id)); }
  catch (e) { if (seq === cacheDiagnosticSeq && state.session?.id === id) body.textContent = '诊断读取失败：' + e.message; return; }
  if (seq !== cacheDiagnosticSeq || state.session?.id !== id) return;
  body.replaceChildren();
  const line = (text, cls = '') => { const p = document.createElement('p'); p.textContent = text; if (cls) p.className = cls; body.appendChild(p); };
  if (report.recording_errors > 0) line('诊断记录未能完整保存；模型请求不受影响，请核对本机存储空间或写入权限。');
  line('按模型查看历史用量：');
  for (const row of report.historical_models || []) line(row.model + ' · ' + row.calls + '次 · 缓存上报占比' + (row.rate == null ? '未知' : row.rate.toFixed(1) + '%'));
  if (!report.historical_models?.length) line('尚无用量记录。');
  line('历史比例包含旧口径：未返回缓存字段也计作0。');
  if (!report.available) {
    line(report.truncated ? '诊断记录不完整或不可读取，当前未能获得本会话的逐请求记录。'
      : '尚无逐请求诊断。后续正常请求会自动采集，无需为诊断额外调用模型。');
    return;
  }
  line('最近' + (report.window_days || 7) + '天新增诊断：' + report.requests + '次HTTP请求；无法计算占比' + report.unknown_count + '次，其中缓存字段未返回' + (report.cache_missing || 0) + '次。');
  line('已上报部分的缓存命中率：' + (report.known_rate == null ? '暂无' : report.known_rate.toFixed(1) + '%') + '（按输入token加权）');
  const target = report.cache_target;
  if (target) {
    const verdict = target.status === 'met' ? '当前已采集记录全部达标'
      : target.status === 'below' ? '当前已采集记录未全部达标' : '无法证实全部达标';
    line('逐请求缓存目标≥' + target.threshold_percent + '%：达标' + target.met + '次，低于目标'
      + target.below + '次，无法核验' + target.unverified + '次；' + verdict + '（仅限最近'
      + (report.window_days || 7) + '天已采集记录）。');
    for (const low of target.below_requests || []) {
      line('低于90% · 请求#' + low.request_seq + ' · ' + low.model + ' · 缓存'
        + low.cached_tokens + '/' + low.input_tokens + ' token（'
        + (100 * low.cached_tokens / low.input_tokens).toFixed(3) + '%）');
    }
  }
  if (report.truncated) line('当前显示最近的部分记录。');
  for (const row of (report.records || []).slice(0, 5)) {
    const lane = row.lane?.startsWith('sub:') ? '子任务' : row.lane === 'summarize' ? '历史压缩' : row.lane === 'main:local' ? '临时任务' : '主流程';
    const cache = row.usage?.raw_cache || {};
    const cacheText = cache.state === 'missing' ? '通道未返回缓存字段' : cache.state === 'invalid' || cache.state === 'conflicting' ? '缓存计量需核对' : '缓存读取' + fmtK(cache.tokens) + ' token';
    const targetText = row.cache_target_status === 'met' ? ' · 达到90%'
      : row.cache_target_status === 'below' ? ' · 低于90%' : row.cache_target_status === 'unverified' ? ' · 90%目标无法核验' : '';
    line(lane + ' · ' + row.model + ' · ' + cacheText + targetText
      + (row.outcome === 'error' ? ' · 请求未完成' : ''), 'cache-diagnostic-entry');
    line(cachePrefixDescription(row));
    if (row.usage?.warnings?.length) line('通道回传与本地计量存在待核对项。');
  }
  line('诊断覆盖启用后的主流程、子任务和历史压缩；前缀稳定不保证服务端命中。');
}
$('#cacheDiagnostics').ontoggle = () => { if ($('#cacheDiagnostics').open) refreshCacheDiagnostics(); };
$('#btnRefreshCache').onclick = refreshCacheDiagnostics;
// 费用信息不在界面显示；保留 token / 调用 / 缓存 / 识图统计。
function fmtK(n) { n = n || 0; return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

function showQuestion(q, options, decision) {
  removeInteractive();
  const el = document.createElement('div');
  el.className = 'qcard';
  el.id = 'liveQ';
  el.innerHTML = `<div class="q">❓ ${esc(q)}</div><div class="opts"></div>`;
  const opts = el.querySelector('.opts');
  if (decision && decision.candidates) {
    const judgment = document.createElement('div');
    judgment.className = 'decision-judgment';
    judgment.textContent = decision.recommendation_reason
      ? '推荐判断：' + decision.recommendation_reason
      : '原卡片未记录综合推荐判断，可以追问补充依据。';
    opts.appendChild(judgment);
    if (decision.judge) {
      const j = decision.judge;
      const d = j.disposition || {};
      const status = d.status === 'accepted' ? '复核通过' : d.status === 'escalate' ? '需升级复核' : '未启用/未完成';
      const confidence = Number.isFinite(Number(j.confidence)) ? `，置信度 ${Number(j.confidence).toFixed(2)}` : '';
      const note = document.createElement('div');
      note.className = 'decision-judge-note ' + (d.status === 'accepted' ? 'ok' : d.status === 'escalate' ? 'warn' : 'muted');
      note.textContent = `判断层：${status}${confidence}${j.reason ? '；' + j.reason : (d.reason ? '；' + d.reason : '')}`;
      opts.appendChild(note);
    }
    const reason = document.createElement('textarea');
    reason.className = 'decision-reason';
    reason.placeholder = '选择理由（可选；自定义方案必填）';
    decision.candidates.forEach(c => {
      const b = document.createElement('button');
      b.className = 'decision-option' + (c.id === decision.recommended_id ? ' rec' : '');
      b.innerHTML = `<strong>${esc(c.label)}${c.id === decision.recommended_id ? ' · 推荐' : ''}</strong><span>依据：${esc(c.basis)}</span>${c.tradeoff ? '<span>权衡：' + esc(c.tradeoff) + '</span>' : ''}${c.risk ? '<span>风险：' + esc(c.risk) + '</span>' : ''}`;
      b.onclick = () => sendText(c.label, { decision_id: decision.decision_id, selected_id: c.id, rationale: reason.value.trim() });
      opts.appendChild(b);
    });
    opts.appendChild(reason);
    const custom = document.createElement('textarea');
    custom.placeholder = '第四项：填写自定义方案';
    opts.appendChild(custom);
    const submit = document.createElement('button');
    submit.className = 'decision-custom-submit';
    submit.textContent = '提交自定义方案';
    submit.onclick = () => {
      if (!custom.value.trim() || !reason.value.trim()) { alert('请填写自定义方案和选择理由'); return; }
      sendText(custom.value.trim(), { decision_id: decision.decision_id, selected_id: 'custom', custom_text: custom.value.trim(), rationale: reason.value.trim() });
    };
    opts.appendChild(submit);
    const clarify = document.createElement('div');
    clarify.className = 'decision-clarify';
    const followup = document.createElement('textarea');
    followup.className = 'decision-clarify-question';
    followup.placeholder = '追问推荐依据或某个方案';
    const ask = document.createElement('button');
    ask.className = 'decision-clarify-submit';
    ask.textContent = '追问';
    ask.onclick = () => {
      const question = followup.value.trim();
      if (!question) { alert('请填写追问问题'); return; }
      sendText(question, { action: 'clarify', decision_id: decision.decision_id, question });
    };
    clarify.append(followup, ask);
    opts.appendChild(clarify);
    $('#chatStream').appendChild(el);
    scrollBottom();
    return;
  }

  (options || []).forEach(o => {
    const b = document.createElement('button');
    b.textContent = '◉ ' + o;
    if (/推荐/.test(o)) b.classList.add('rec');
    b.onclick = () => sendText(o);
    opts.appendChild(b);
  });
  const free = document.createElement('div');
  free.style.marginTop = '8px';
  free.innerHTML = '<div class="mini">✎ 都不满意？写你自己的方案（自定义）：</div>';
  const inp = document.createElement('input');
  inp.placeholder = '输入回答，回车发送…';
  inp.onkeydown = (e) => { if (e.key === 'Enter' && inp.value.trim()) sendText(inp.value.trim()); };
  free.appendChild(inp);
  opts.appendChild(free);
  $('#chatStream').appendChild(el);
  scrollBottom();
  inp.focus();
}

function showExternalCard(target, toolResult) {
  removeInteractive();
  const label = EXTERNAL_LABELS[target] || target || '外部模型';
  const el = document.createElement('div');
  el.className = 'xcard';
  el.innerHTML = `<div class="xtarget">🔀 已调度外部模型：${esc(label)}</div><div class="mini" style="margin:6px 0">${esc(toolResult || '提示词已复制到剪贴板，目标窗口已打开。')}</div><textarea placeholder="把外部模型的结果粘贴到这里，回车注入…"></textarea>`;
  const ta = el.querySelector('textarea');
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && ta.value.trim()) { e.preventDefault(); sendText(`[外部结果·${label}]\n` + ta.value.trim()); } };
  $('#chatStream').appendChild(el);
  scrollBottom();
  ta.focus();
}
function removeInteractive() { $('#liveQ') && $('#liveQ').remove(); }

const EXTERNAL_LABELS = { chatgpt_web: 'ChatGPT 网页版', codex_desktop: 'Codex 桌面版', glm_web: 'GLM 网页版', deepseek_web: 'DeepSeek 网页版' };

// ---------- SSE 消费 ----------
async function sseChat(body) {
  const streamSeq = ++state.chatStreamSeq;
  setRunning(true, 'local');
  let res;
  try {
    res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': window.__XIHE_TOKEN__ || '' }, body: JSON.stringify(body) });
  } catch (e) { setRunning(false, 'local'); alert('网络错误: ' + e.message); return; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setRunning(false, 'local');
    alert(err.error || '请求失败');
    await openSession(body.id);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let curAssistant = null, curBody = null, reasonEl = null;
  const closeStreamBubble = () => { curAssistant = null; curBody = null; reasonEl = null; };

  while (true) {
    let chunk;
    try { chunk = await reader.read(); } catch { break; }
    if (chunk.done) break;
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = raw.split('\n').find(l => l.startsWith('data:'));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.t === '__end__') { buf = ''; break; }
      if (streamSeq !== state.chatStreamSeq) continue;
      // 审计 P1：旧会话流不能污染新视图——按 session_id 过滤
      if (ev.session_id && state.session && ev.session_id !== state.session.id) continue;
      try { handleEvent(ev, { get cur() { return curAssistant; }, set cur(v) { curAssistant = v; }, get body() { return curBody; }, set body(v) { curBody = v; }, get reason() { return reasonEl; }, set reason(v) { reasonEl = v; }, close: closeStreamBubble }); }
      catch (e) { console.error(e); }
    }
  }
  // 审计 P1：SSE 断开不等于任务结束——不要无条件 setRunning(false)，
  // 否则界面显示「未运行」但后台仍在烧钱/计算。只在收到显式 done 后才停按钮。
  // 这里只刷新会话列表（让下次 bootstrap 校正按钮状态）。
  refreshSessions();
}

function handleEvent(ev, st) {
  switch (ev.t) {
    case 'reasoning_config':
      if (state.session) {
        state.session.resolved_reasoning = ev;
        renderReasoningStatus(ev);
      }
      break;
    case 'turn_start':
      if (state.session) state.session.messages.push({ role: 'user', content: window.__lastSent || '' });
      setWork('已接收任务，准备中…', '0 步');
      break;
    case 'stream_start':
      setWork('模型思考中…', '');
      break;
    case 'delta': {
      if (!st.cur) { st.cur = addMsgEl('assistant', '羲和 <span class="mini">输出中…</span>'); st.body = st.cur.querySelector('.body'); st.body.innerHTML = ''; }
      st.body.innerHTML = renderMD(st.body.dataset.raw = (st.body.dataset.raw || '') + ev.s);
      scrollBottom();
      break;
    }
    case 'rdelta': {
      if (!st.cur) { st.cur = addMsgEl('assistant', '羲和 <span class="mini">思考中…</span>'); st.body = st.cur.querySelector('.body'); }
      if (!st.reason) { st.reason = document.createElement('div'); st.reason.className = 'reasoning'; st.body.appendChild(st.reason); }
      st.reason.textContent = (st.reason.textContent + ev.s).slice(-2000);
      st.reason.scrollTop = st.reason.scrollHeight;
      scrollBottom();
      break;
    }
    case 'assistant_msg': {
      if (st.cur && st.body) { delete st.body.dataset.raw; st.body.innerHTML = renderMD(ev.content); }
      else { const el = addMsgEl('assistant'); el.querySelector('.body').innerHTML = renderMD(ev.content); }
      st.close();
      break;
    }
    case 'tool_start': {
      if (st.cur) { if (st.body && st.body.dataset.raw) { st.body.innerHTML = renderMD(st.body.dataset.raw); delete st.body.dataset.raw; } st.close(); }
      const anchor = lastAssistantBody();
      renderToolCard(anchor, ev.name, ev.args_preview, null, '运行中…', null, ev.id);
      state.stepCount = (state.stepCount || 0) + 1;
      setWork('正在执行：' + ev.name, `${state.stepCount} 步 · ` + (ev.args_preview || '').slice(0, 80));
      break;
    }
    case 'tool_end': {
      const anchor = lastAssistantBody();
      // 按 callId 精确匹配（一个 assistant 消息批量多个工具调用时，"取最后一张卡"会标错对象——
      // 旧实现的 || true 兜底把结束状态盖到错误的卡上，用户看到的就是"成功了还显示在跑"）
      let card = ev.id ? anchor.querySelector(`.toolcard[data-callid="${CSS.escape(ev.id)}"]`) : null;
      if (!card) {
        // 兜底：找该 anchor 下最后一张仍处于运行中（无 ✓/✗ 标记）的卡
        const cards = [...anchor.querySelectorAll('.toolcard')];
        card = cards.reverse().find(c => !c.querySelector('.ok,.bad'));
      }
      if (card) {
        card.querySelector('.tms').textContent = ev.ms + 'ms';
        const run = card.querySelector('.run'); if (run) run.remove();
        const sEl = document.createElement('span'); sEl.className = ev.ok ? 'ok' : 'bad'; sEl.textContent = ev.ok ? '✓' : '✗';
        card.querySelector('.head').insertBefore(sEl, card.querySelector('.tms'));
        card.querySelector('.tbody').textContent = ev.result_preview;
      }
      updateStepSummary(card ? card.closest('details.steps') : null);
      setWork(ev.ok ? '完成一步，继续…' : '一步失败，看折叠块里的红标', `${state.stepCount || 0} 步`);
      break;
    }
    case 'usage': updateCost(ev.usage); break;
    case 'todo': renderTodos(ev.todos); break;
    case 'memory': renderMemory(ev.memory); break;
    case 'question': showQuestion(ev.question, ev.options, ev); break;
    case 'approval_request': showApprovalCard(ev); break;
    case 'auto_decision': {
      const c = document.createElement('div'); c.className = 'sysnote';
      c.textContent = '🤖 全自动选择：' + (ev.question || '').slice(0, 80) + ' → ' + (ev.choice || '智能体自定');
      $('#chatStream').appendChild(c); scrollBottom();
      break;
    }
    case 'external_wait': {
      const last = state.session && state.session.messages[state.session.messages.length - 1];
      showExternalCard(ev.target, '');
      break;
    }    case 'redteam': {
      if ($('#workMeta')) $('#workMeta').textContent = `🎯 红队 ${ev.id || ''} · ${ev.ok ? '对账通过' : '验收未过'}${ev.status ? ' · ' + ev.status : ''}`;
      break;
    }
    case 'crew': {
      if ($('#workMeta')) $('#workMeta').textContent = `👥 固定 ${ev.fixed || 3} · 池 ${ev.active || 0} 在跑 · 累计 ${ev.dispatched || 0}/${ev.cap || 12}`;
      break;
    }
    case 'subagent': {
      const anchor = lastAssistantBody();
      const d = document.createElement('div');
      d.className = 'subagent';
      const roleName = (ev.profile === 'redteam' ? '红队' : null) || { modeler: '建模手', coder: '编程手', writer: '论文手', reviewer: '审查手' }[ev.role] || (ev.profile === 'reviewer' ? '独立审查员' : '子代理');
      const modelNote = ev.model ? ` · ${ev.model}${ev.fallback ? '（回退）' : ''}` : '';
      d.textContent = ev.phase === 'start' ? `🤖 ${roleName} 出动${modelNote}…` : `🤖 ${roleName}结束（${ev.iters || ''} 轮）${modelNote}${ev.msg ? ' · ' + ev.msg : ''}`;
      anchor.appendChild(d);
      scrollBottom();
      break;
    }
    case 'compact': case 'warn': {
      const c = document.createElement('div'); c.className = 'sysnote'; c.textContent = '⚙ ' + ev.msg;
      $('#chatStream').appendChild(c); scrollBottom();
      break;
    }
    case 'compact_done': {
      const c = document.createElement('div'); c.className = 'compact'; c.textContent = `🗜 历史已压缩，保留 ${ev.kept} 条`;
      $('#chatStream').appendChild(c); scrollBottom();
      break;
    }
    case 'error': {
      const c = document.createElement('div'); c.className = 'msg assistant'; c.innerHTML = `<div class="who">错误</div><div class="body"><span style="color:var(--red)">${esc(ev.msg)}</span></div>`;
      $('#chatStream').appendChild(c); scrollBottom();
      break;
    }
    case 'done': {
      // ask_user / 外部调度等待时保留问答卡片（卡片自身可交互，等用户回答）；
      // 其余结束原因才清理。修复：此前 done 无条件 removeInteractive 导致问题卡片消失。
      const awaitingDecision = ev.reason === 'ask_user' || ev.reason === 'waiting_for_decision';
      if (!awaitingDecision && ev.reason !== 'wait_external') removeInteractive();
      setWork(awaitingDecision ? '等你拍板…' : ev.reason === 'wait_external' ? '等外部模型结果…' : null, '');
      if (state.session) { state.session.status = awaitingDecision ? 'waiting_input' : ev.reason === 'wait_external' ? 'waiting_external' : 'idle'; }
      setRunning(false, 'local');
      // 一轮结束刷新交付物清单：用户不用去翻文件夹也知道这一轮产出了什么、在哪
      if (state.session) renderDeliverables(state.session).catch(() => {});
      break;
    }
  }
}

function lastAssistantBody() {
  const msgs = $('#chatStream').querySelectorAll('.msg.assistant');
  const last = msgs[msgs.length - 1];
  if (last) return last.querySelector('.body');
  const el = addMsgEl('assistant');
  return el.querySelector('.body');
}

function setRunning(v, source = 'local') {
  if (source === 'background') state.backgroundSessionRunning = !!v;
  else state.localStreamRunning = !!v;
  state.running = !!(state.localStreamRunning || state.backgroundSessionRunning);
  $('#btnSend').style.display = state.running ? 'none' : '';
  $('#btnStop').style.display = state.running ? '' : 'none';
  renderTaskFocus();
}

function renderTaskFocus() {
  const local = state.session?.task_focus?.kind === 'local';
  const enter = $('#btnLocalTask'), back = $('#btnReturnMain'), hint = $('#taskFocusHint');
  if (!enter || !back || !hint) return;
  enter.disabled = !state.session || state.taskFocusChanging || local;
  enter.textContent = state.taskFocusChanging ? '正在切换…' : local ? '临时小任务中' : '临时小任务';
  back.hidden = !local;
  back.disabled = state.taskFocusChanging;
  hint.textContent = local ? '主线已暂停 · 当前小问题做完就停；可在顶部切换 Flash'
    : state.running ? '可先输入小问题，再点“临时小任务”暂停主线' : '可随时暂停主线，先处理一个小问题';
  $('#input').placeholder = local ? '只处理这个小问题…（做完即停，之后可返回主线）' : '给羲和下达任务…（Enter 发送 / Shift+Enter 换行）';
}

async function changeTaskFocus(action) {
  if (!state.session || state.taskFocusChanging) return;
  const id = state.session.id;
  let resumeText = null;
  state.taskFocusChanging = true;
  renderTaskFocus();
  try {
    const result = await api('/api/session/focus', { id, action });
    if (state.session?.id !== id) return;
    // The endpoint waits for the old turn to finish. Late SSE events cannot alter the new view.
    state.chatStreamSeq++;
    state.localStreamRunning = false;
    state.backgroundSessionRunning = false;
    await openSession(id);
    if (state.session?.id !== id) return;
    if (action === 'main' && result.resume?.action === 'continue') {
      resumeText = result.resume.text;
    } else if (action === 'main' && result.resume?.action === 'review') {
      setWork('已返回主线，请先在后台任务中核对输入变化与结果', '');
    } else {
      $('#input').focus();
    }
  } catch (e) {
    alert('切换任务失败：' + e.message);
  } finally {
    state.taskFocusChanging = false;
    renderTaskFocus();
  }
  if (resumeText && state.session?.id === id) await sseChat({ id, text: resumeText });
}

// ---------- 发送 ----------
async function sendText(text, decision) {
  if (attachmentUploading) { alert('附件正在处理，请等待上传完成后再发送'); return; }
  if (!state.session) { alert('先新建或打开一个会话'); return; }
  if (state.running) { alert('当前会话正在运行，请先停止'); return; }
  text = (text || '').trim();
  if (!text && !state.attachments.length) return;
  removeInteractive();
  for (const a of state.attachments) text += `\n[附件已保存: ${a.path}]`;
  state.attachments = [];
  renderAttachRow();
  window.__lastSent = text;
  const el = addMsgEl('user');
  el.querySelector('.body').innerHTML = renderMD(text);
  $('#input').value = '';
  autoGrow();
  await sseChat(decision && decision.action === 'clarify'
    ? { id: state.session.id, action: 'clarify', decision_id: decision.decision_id, question: decision.question }
    : { id: state.session.id, text, ...(decision ? { decision } : {}) });
}

// ---------- 会话管理 ----------
// 模式提示用真实加载信息（skill_loaded 由服务端回填；不再硬编码"my-cumcm-deepseek 已加载"）
function modeHintOf(s) {
  if (s.mode === 'math') return s.skill_loaded
    ? `📐 数学建模 · ${s.skill_loaded.name} v${s.skill_loaded.version} 已加载`
    : '📐 数学建模 · 通用流程';
  return { code: '⌨ 编程模式', free: '💬 自由对话' }[s.mode] || '';
}
// 项目选择器：填充「最近项目 + ＋新建项目…」，避免所有会话都挤在同一个文件夹里
async function fillProjectPicker() {
  const sel = $('#nsProject');
  if (!sel) return;
  const r = await api('/api/project/list');
  const projs = (r && r.projects) || [];
  state.projects = projs;
  const opts = projs.map(p => `<option value="${p.id}">${(p.title || p.id).slice(0, 30)}（${p.id}）</option>`);
  opts.push('<option value="__new__">＋ 新建项目…</option>');
  sel.innerHTML = opts.join('');
  // 默认沿用最近一个项目（与旧行为一致），用户想换就换
  if (state.session && state.session.project_id) sel.value = state.session.project_id;
}
function slugifyProject(name) {
  const raw = String(name || '').trim();
  // \u540e\u7aef PROJECT_ID_RE\uff08server.js:38\uff09\u53ea\u8ba4 ASCII\uff0c\u800c\u8fd9\u91cc\u7684\u9ed8\u8ba4\u540d\u5c31\u662f\u4e2d\u6587\u300c\u65b0\u9879\u76ee\u300d\u2014\u2014
  // \u539f\u5148\u628a \u4e00-\u9fa5 \u4e5f\u653e\u8fdb\u767d\u540d\u5355\uff0c\u751f\u6210 '\u65b0\u9879\u76ee_261005' \u5fc5\u7136\u88ab /api/project/new \u5224 400\uff1a
  // \u4e0d\u586b\u540d\u5b57\u76f4\u63a5\u65b0\u5efa\u9879\u76ee\uff0c100% \u5931\u8d25\u3002id \u4fdd\u6301\u7eaf ASCII\uff0c\u4e2d\u6587\u540d\u4e00\u4e2a\u5b57\u4e0d\u5c11\u5730\u7559\u5728 title \u91cc\u3002
  const base = raw.replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  // \u5265\u79bb\u65f6\u4e22\u8fc7\u4e1c\u897f\uff08\u4e2d\u6587\u540d\u5265\u5b8c\u662f\u7a7a\u4e32\uff0c\u300c\u7b2c\u4e00\u9898\u300d\u300c\u7b2c\u4e8c\u9898\u300d\u4f1a\u649e\u8f66\uff09\u624d\u8865\u539f\u6587\u54c8\u5e0c\uff1b
  // \u7eaf ASCII \u540d\u4fdd\u6301\u539f\u6837\uff0c\u4e0d\u4e3a\u4e00\u4e2a\u7eaf\u82f1\u6587\u9879\u76ee\u51ed\u7a7a\u52a0\u540e\u7f00\u3002
  let h = '';
  if (raw && /[^\w-]/.test(raw)) {
    // djb2 后必须过一遍 murmur3 finalizer：djb2 把差异留在低位，直接取高位 base36
    // 会让「第1题」「第2题」这种只差一个字符的名字全部撞成同一个后缀（实测 6 个全撞）。
    let x = 5381; for (let i = 0; i < raw.length; i++) x = (Math.imul(x, 33) + raw.charCodeAt(i)) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0; x ^= x >>> 13;
    h = '_' + x.toString(36).slice(-4);
  }
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');  return (base || 'proj') + h + '_' + stamp;
}
// ---------- \u4fa7\u680f\u9879\u76ee\u5207\u6362\u5668\uff08v2.6\uff09----------
// \u4f1a\u8bdd\u5217\u8868\u4e0e\u53f3\u4fa7\u4ea4\u4ed8\u7269\u90fd\u6309\u5b83\u8fc7\u6ee4\uff1b\u9009\u62e9\u5b58 localStorage\uff0c\u91cd\u542f\u4fdd\u6301\u3002
async function fillProjectSwitch(force) {
  const sel = $('#projSwitch');
  if (!sel) return;
  // boot 里的 projects 是页面加载时的快照：刚新建的项目不 force 重取就永远看不到。
  let projs = (force ? null : (state.boot && state.boot.projects)) || null;
  if (!projs) { try { projs = (await api('/api/project/list')).projects || []; } catch { projs = []; } }
  state.projects = projs;
  if (state.projectFilter === null) {
    try { state.projectFilter = localStorage.getItem('xihe.project') || null; } catch {}
  }
  const opts = ['<option value="">\u5168\u90e8\u9879\u76ee</option>'].concat(projs.map(p =>
    `<option value="${esc(p.id)}">${esc((p.title || p.id).slice(0, 26))}${p.external ? ' \ud83d\udcc1' : ''}${p.dirMissing ? ' \u26a0\u7f3a\u5931' : ''}</option>`));
  sel.innerHTML = opts.join('');
  if (state.projectFilter && !projs.some(p => p.id === state.projectFilter)) state.projectFilter = null; // \u9879\u76ee\u5df2\u5220
  sel.value = state.projectFilter || '';
  const cur = projs.find(p => p.id === state.projectFilter);
  sel.title = cur ? `\u9879\u76ee\u76ee\u5f55\uff1a${cur.external ? cur.dir : '\uff08\u7a0b\u5e8f\u5185 workspace/projects/' + cur.id + '\uff09'}` : '\u5168\u90e8\u9879\u76ee';
}
$('#projSwitch').onchange = async () => {
  state.projectFilter = $('#projSwitch').value || null;
  try { localStorage.setItem('xihe.project', state.projectFilter || ''); } catch {}
  await fillProjectSwitch();
  await refreshSessions();
  // \u4ea4\u4ed8\u7269\u9762\u677f\u8ddf\u968f\u9879\u76ee\u5207\u6362\uff08\u672c\u4f1a\u8bdd\u4e0d\u5c5e\u4e8e\u8be5\u9879\u76ee\u65f6\u4e0d\u53bb\u6253\u65ad\u4f1a\u8bdd\uff0c\u53ea\u6362\u9762\u677f\u6570\u636e\uff09
  if (state.projectFilter) renderDeliverables(null, state.projectFilter).catch(() => {});
  else if (state.session) renderDeliverables(state.session).catch(() => {});
  refreshJobs();
  if ($('#dlgProjectPlan').open) loadProjectPlan(state.projectFilter || state.session?.project_id || '').catch(() => {});
};
async function resolveProjectForNewSession() {
  const sel = $('#nsProject');
  if (!sel || !sel.value || sel.value !== '__new__') return sel ? sel.value || null : null;
  const name = $('#nsProjectName').value.trim() || '新项目';
  const pid = slugifyProject(name);
  const body = { id: pid, title: name };
  const dir = ($('#nsProjectDir') && $('#nsProjectDir').value.trim()) || '';
  if (dir) body.dir = dir; // 外部项目：就地用用户选的文件夹
  const r = await api('/api/project/new', body);
  if (r.error) throw new Error(r.error);
  return pid;
}
$('#nsPickDir').onclick = async () => {
  if (!window.xihe || !window.xihe.pickFolder) { alert('当前不是桌面端（命令行启动的没有文件夹选择器），请手动粘贴路径'); return; }
  const d = await window.xihe.pickFolder();
  if (d) $('#nsProjectDir').value = d;
};
async function newSession(mode) {
  const project_id = await resolveProjectForNewSession();
  if (mode === 'math' && $('#nsContestKind').value) {
    await api('/api/project/contest', { project_id, contest_kind: $('#nsContestKind').value,
      edition: $('#nsEdition').value, stage: $('#nsStage').value, track: $('#nsTrack').value, control_number: $('#nsControlNumber').value || null });
  }
  const s = await api('/api/session/new', { mode, project_id, task_scope: $('#nsTaskScope').value });
  state.session = s;
  $('#dlgNew').close();
  renderHistory(s);
  $('#sessionTitle').textContent = titleOf(s);
  $('#modelPill').textContent = modelPillText(s);
  renderReasoningStatus(s.resolved_reasoning);
  $('#modeHint').textContent = modeHintOf(s);
  renderCollab(s);
  renderEffort(s);
  renderContest(s);
  renderDeliverables(s);
  renderApproval(s);
  // 新建（外部）项目后：项目下拉还是启动时的快照，必须重取；
  // 同时把侧栏过滤切到新项目——否则新会话被旧项目的过滤藏住，看起来像"什么都没发生"。
  if (project_id) {
    state.projectFilter = project_id;
    try { localStorage.setItem('xihe.project', project_id); } catch {}
    fillProjectSwitch(true);
  }
  refreshSessions();
  $('#input').focus();
}
function renderCollab(s) {
  const pill = $('#collabPill');
  if (!s || s.mode !== 'math') { pill.style.display = 'none'; return; }
  pill.style.display = '';
  const auto = s.collab_mode === 'auto';
  pill.textContent = auto ? '🤖 全自动' : '🤝 人机协同';
  pill.classList.toggle('auto', auto);
}
function renderEffort(s) {
  const pill = $('#effortPill');
  if (!pill) return;
  if (!s || s.mode !== 'math') { pill.style.display = 'none'; return; }
  pill.style.display = '';
  const tier = ({ fast: 0, deep: 1, extreme: 2 })[s.effort || 'fast'] ?? 0;
  pill.textContent = ['⚡ 快速', '🔬 深度', '🧬 极致'][tier];
  pill.classList.toggle('deep', tier === 1);
  pill.classList.toggle('extreme', tier === 2);
}
// ---------- 权限档位（v2.5：完全访问 / 请求审批）----------
function renderApproval(s) {
  const pill = $('#approvalPill');
  if (!pill) return;
  if (!s || !s.mode || s.mode === 'free') { pill.style.display = 'none'; return; }
  pill.style.display = '';
  const ask = (s.approval || (s.collab_mode === 'auto' ? 'full' : 'ask')) === 'ask';
  pill.textContent = ask ? '🔐 请求审批' : '🔓 完全访问';
  pill.classList.toggle('auto', !ask);
  pill.title = ask
    ? '请求审批：写文件 / 跑命令 / 花钱的操作会先弹卡等你点批准（点此切到完全访问）'
    : '完全访问：工具直接执行，不打断（点此切到请求审批）';
}
$('#approvalPill').onclick = async () => {
  const s = state.session;
  if (!s) return;
  const cur = (s.approval || (s.collab_mode === 'auto' ? 'full' : 'ask'));
  const next = cur === 'ask' ? 'full' : 'ask';
  const r = await api('/api/session/approval', { id: s.id, approval: next });
  s.approval = r.approval;
  s.approval_allow = r.approval_allow || [];
  renderApproval(s);
};

// 审批卡（请求审批模式下弹出）：批准 / 拒绝 / 本会话总是允许该工具
function showApprovalCard(ev) {
  removeInteractive();
  const wrap = document.createElement('div');
  wrap.className = 'card interactive';
  wrap.id = 'liveQ';
  wrap.innerHTML = `<h3>🔐 需要批准</h3>
    <div class="mini" style="margin:4px 0 8px">${esc(ev.tool)}：${esc(ev.summary || '')}</div>
    <div class="mini" style="opacity:.7;margin-bottom:8px;white-space:pre-wrap;max-height:120px;overflow:auto">${esc((ev.args_preview || '').slice(0, 500))}</div>
    <div class="btnrow">
      <button class="primary" data-dec="allow">批准这次</button>
      <button data-dec="allow_session">本会话总是允许 ${esc(ev.tool)}</button>
      <button class="danger" data-dec="deny">拒绝</button>
    </div>`;
  $('#chatStream').appendChild(wrap);
  scrollBottom();
  wrap.querySelectorAll('button[data-dec]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      await api('/api/approve', { session_id: state.session && state.session.id, tool_call_id: ev.id, decision: b.dataset.dec });
      if (b.dataset.dec === 'allow_session' && state.session) {
        state.session.approval_allow = [...new Set([...(state.session.approval_allow || []), ev.tool])];
      }
    } catch (e) { alert('提交失败：' + e.message); }
    wrap.remove();
  });
}

// ---------- 交付物面板（v2.5）：这一题产出了什么、在哪儿，直接摆出来 ----------
const KIND_LABEL = { result: '结果', report: '报告', figure: '图', code: '代码', file: '文件' };
function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(0) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
// 交付物清单。session 可为 null（此时用 projectId 拉该项目全部交付物——侧栏切项目时用）。
async function renderDeliverables(session, projectId) {
  renderAcceptance(session, projectId).catch(() => {});
  const list = $('#deliverList');
  if (!list) return;
  if (!session && !projectId) { list.textContent = '（暂无会话）'; $('#deliverProj').textContent = '—'; return; }
  let r;
  const q = session && session.id
    ? 'session_id=' + encodeURIComponent(session.id)
    : 'project_id=' + encodeURIComponent(projectId);
  try { r = await api('/api/artifacts?' + q); }
  catch (e) { list.textContent = '读取失败：' + e.message; return; }
  if (r.error) { list.textContent = r.error; $('#deliverProj').textContent = '—'; return; }
  $('#deliverProj').textContent = r.project_id;
  $('#deliverProj').title = r.project_dir;
  state.artifactDir = r.project_dir;
  state.deliverables = r.files || []; // 供对话内联路径判断"可点击跳转"
  if (!r.files.length) { list.textContent = '（还没有产物——跑完一问后这里会出现 result*.xlsx / 论文 / 图）'; return; }
  list.innerHTML = '';
  for (const f of r.files) {
    const row = document.createElement('div');
    row.className = 'deliver-row';
    row.title = f.abs + (f.note ? '｜' + f.note : '');
    const open = document.createElement('a');
    open.textContent = f.path;
    open.href = '#';
    open.onclick = (e) => { e.preventDefault(); api('/api/open_file', { path: f.abs }).catch(err => alert('打开失败：' + err.message)); };
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ` ${KIND_LABEL[f.kind] || ''} ${fmtBytes(f.bytes)}`;
    const rev = document.createElement('button');
    rev.className = 'ghost tiny';
    rev.textContent = '📂';
    rev.title = '在资源管理器中定位';
    rev.onclick = () => api('/api/reveal', { path: f.abs }).catch(err => alert('打开失败：' + err.message));
    row.append(open, meta, rev);
    list.appendChild(row);
  }
}
$('#btnRevealProj').onclick = () => {
  const dir = state.artifactDir;
  if (!dir) { alert('还没有项目目录信息，先跑一个会话'); return; }
  api('/api/reveal', { path: dir }).catch(e => alert('打开失败：' + e.message));
};
let acceptanceSeq = 0;
function traceFileLink(root, rel, label) {
  const button = document.createElement('button'); button.className = 'ghost tiny evidence-link';
  button.textContent = label || rel;
  if (typeof rel !== 'string' || !rel || /(^[A-Za-z]:|^[/\\]|(^|[/\\])\.\.([/\\]|$))/.test(rel)) {
    button.disabled = true;
  } else {
    button.onclick = () => api('/api/open_file', { path: root.replace(/[\\/]+$/, '') + '/' + rel.replace(/\\/g, '/') })
      .catch(e => alert('打开失败：' + e.message));
  }
  return button;
}
function renderClaimTrace(trace, root) {
  const status = $('#claimTraceStatus'), body = $('#claimTraceBody'); body.replaceChildren();
  const label = { unregistered: '未登记', fresh: '引用文件当前一致', stale: '需更新' };
  status.textContent = label[trace?.status] || '未知状态';
  status.className = 'mini ' + (trace?.status === 'stale' ? 'acceptance-stale' : trace?.status === 'fresh' ? 'acceptance-passed' : 'acceptance-pending');
  if (!trace || trace.status === 'unregistered') {
    body.textContent = '本会话尚未登记主张追溯；可用 claim_trace 启用并绑定正式运行、结果字段、摘要和图件。旧会话不会被标为已核验。';
    return;
  }
  const note = document.createElement('p');
  note.textContent = '此处核对登记的引用与当前计算文件及图文版本是否一致；不代替数学判断或人工审图。'; body.append(note);
  for (const issue of trace.issues || []) {
    const el = document.createElement('p'); el.className = 'acceptance-stale'; el.textContent = '• ' + issue; body.append(el);
  }
  for (const c of trace.claims || []) {
    const item = document.createElement('details'); item.className = 'claim-trace-item';
    const head = document.createElement('summary');
    head.textContent = `问${c.question_id} · ${c.id} · ${c.status === 'fresh' ? '当前一致' : '已失效'} · ${c.text || ''}`;
    head.className = c.status === 'fresh' ? 'acceptance-passed' : 'acceptance-stale'; item.append(head);
    const origin = document.createElement('p');
    const field = c.source?.field ? '.' + c.source.field : '';
    const t = c.transform && c.transform.kind !== 'identity' ? `；变换 ${JSON.stringify(c.transform)}` : '';
    origin.textContent = c.kind === 'analytic'
      ? `解析核查 ${c.verification?.run_id || '未知'}；推导 ${c.proof?.path || '未登记'}；适用范围：${c.scope || '未登记'}；有限核查不等于通用数学证明`
      : `正式运行 ${c.run_id || '未知'}；结果 ${c.source?.path || '未知'}${field}（原始单位 ${c.source?.unit || '未登记'}）；${c.value ?? '未知'} ${c.output_unit || c.source?.unit || ''}${t}；主张范围：${c.scope || '未登记'}`
        + (c.optimality ? `；优化核验：${c.optimality.report?.optimality_scope || '缺少范围'}，已查${c.optimality.report?.checked_points ?? '?'}点，可行${c.optimality.report?.feasible_points ?? '?'}点；限登记模型` : '');
    item.append(origin);
    if (c.source?.path) item.append(traceFileLink(root, c.source.path, '打开结果：' + c.source.path));
    if (c.proof?.path) item.append(traceFileLink(root, c.proof.path, '打开推导：' + c.proof.path));
    for (const file of c.verification?.files || []) {
      if (file.path) item.append(traceFileLink(root, file.path, '核查文件：' + file.path));
    }
    if (c.proof?.review_boundary) {
      const boundary = document.createElement('p'); boundary.textContent = '核查范围及未证明部分：' + c.proof.review_boundary; item.append(boundary);
    }
    for (const premise of c.premises || []) {
      const p = document.createElement('p'); p.textContent = '前提来源：' + JSON.stringify(premise); item.append(p);
    }
    if (c.model_spec) {
      const spec = document.createElement('p'); spec.textContent = '模型规格：' + JSON.stringify(c.model_spec).slice(0, 500); item.append(spec);
    }
    for (const reason of c.reasons || []) {
      const el = document.createElement('p'); el.className = 'acceptance-stale'; el.textContent = '• ' + reason; item.append(el);
    }
    for (const f of c.figures || []) {
      const p = document.createElement('p'); p.textContent = `图件 ${f.path || ''}${f.panel ? ' / ' + f.panel : ''}${f.note ? '：' + f.note : ''}`; item.append(p);
      if (f.plot_run_id) { const origin = document.createElement('p'); origin.textContent = '绘图插件回执：' + f.plot_run_id + '；正式数值来源仍为 ' + c.run_id; item.append(origin); }
      if (f.path) item.append(traceFileLink(root, f.path, '打开图件：' + f.path));
    }
    for (const ref of c.references || []) {
      const p = document.createElement('p'); p.textContent = `${ref.kind || '正文'}：${ref.quote || ''}`; item.append(p);
      if (ref.path) item.append(traceFileLink(root, ref.path, '打开文稿：' + ref.path));
    }
    body.append(item);
  }
  for (const diagram of trace.diagrams || []) {
    const item = document.createElement('details'); item.className = 'claim-trace-item';
    const head = document.createElement('summary');
    head.textContent = `问${diagram.question_id} · 示意图 ${diagram.id} · ${diagram.status === 'fresh' ? '当前一致' : '已失效'}`;
    head.className = diagram.status === 'fresh' ? 'acceptance-passed' : 'acceptance-stale'; item.append(head);
    const p = document.createElement('p'); p.textContent = `${diagram.path || ''} / ${diagram.panel || ''}`; item.append(p);
    if (diagram.path) item.append(traceFileLink(root, diagram.path, '打开示意图：' + diagram.path));
    for (const source of diagram.sources || []) {
      const el = document.createElement('p'); el.textContent = '来源：' + JSON.stringify(source); item.append(el);
      if (source.path) item.append(traceFileLink(root, source.path, '打开来源：' + source.path));
    }
    for (const reason of diagram.reasons || []) {
      const el = document.createElement('p'); el.className = 'acceptance-stale'; el.textContent = '• ' + reason; item.append(el);
    }
    body.append(item);
  }
  for (const limit of trace.limits || []) {
    const el = document.createElement('p'); el.className = 'claim-trace-limit'; el.textContent = limit; body.append(el);
  }
}
async function renderAcceptance(session = state.session, projectId, selectedId) {
  const pid = projectId || session?.project_id;
  const seq = ++acceptanceSeq;
  if (!pid) { $('#acceptanceHeadline').textContent = '打开项目后显示实际验收状态'; renderClaimTrace(null); return; }
  const card = $('#acceptanceCard');
  card.dataset.projectId = pid;
  const requested = selectedId || (session?.project_id === pid ? session.id : '');
  let r;
  try { r = await api('/api/project/acceptance?project_id=' + encodeURIComponent(pid) + (requested ? '&session_id=' + encodeURIComponent(requested) : '')); }
  catch (e) { if (seq === acceptanceSeq) $('#acceptanceHeadline').textContent = '验收读取失败：' + e.message; return; }
  if (seq !== acceptanceSeq) return;
  state.acceptance = r;
  const sel = $('#acceptanceSession');
  sel.innerHTML = (r.sessions || []).map(s => `<option value="${esc(s.id)}">${esc(s.title || s.id)} · ${esc(s.task_scope)}</option>`).join('');
  sel.value = r.session_id || '';
  $('#acceptanceProfile').textContent = r.profile
    ? `${r.profile.identity.competition} · ${r.profile.identity.edition} · ${r.profile.identity.track || '赛道待核'}｜项目档案v${r.profile.revision} / 会话v${r.session_profile_revision || '未继承'}` : '项目尚未设置赛事档案';
  const a = r.acceptance;
  $('#acceptanceHeadline').textContent = a?.headline || '项目尚无会话';
  $('#acceptanceHeadline').className = a?.last_error ? 'acceptance-blocked' : a?.released || a?.scoped_complete ? 'acceptance-passed' : '';
  const stages = $('#acceptanceStages'); stages.replaceChildren();
  const names = { passed: '通过', pending: '待完成', blocked: '需处理', stale: '已过期', not_required: '本范围不要求' };
  for (const row of a?.stages || []) {
    const el = document.createElement('div'); el.className = 'acceptance-row';
    const label = document.createElement('span'); label.textContent = row.label;
    const status = document.createElement('span'); status.className = 'acceptance-' + row.state; status.textContent = names[row.state] || row.state;
    el.title = [...row.issues, row.detail].filter(Boolean).join('\n'); el.append(label, status); stages.append(el);
  }
  const details = $('#acceptanceDetails'); details.replaceChildren();
  for (const issue of [...(a?.blockers || []), ...(a?.release?.issues || []), ...(a?.review_snapshot?.issues || [])]) {
    const el = document.createElement('p'); el.textContent = '• ' + issue; details.append(el);
  }
  for (const finding of a?.findings || []) {
    const el = document.createElement('p'); el.textContent = `${finding.id} · ${finding.status}：${finding.claim}`; details.append(el);
  }
  for (const file of [...(a?.comparison_reports || []).map(x => x.path), a?.review_snapshot?.manifest?.rel, a?.release?.manifest?.rel].filter(Boolean)) {
    const button = document.createElement('button'); button.className = 'ghost tiny evidence-link'; button.textContent = file;
    if (a?.comparison_reports?.some(x => x.path === file && x.status === 'superseded')) button.textContent += '（历史，已替代）';
    button.onclick = () => api('/api/open_file', { path: r.project_dir.replace(/\\/g, '/') + '/' + file }).catch(e => alert(e.message)); details.append(button);
  }
  $('#btnRetryTask').disabled = !a?.last_error || state.running || r.active || r.session_id !== state.session?.id;
  $('#btnFreezeRelease').disabled = !a?.can_freeze || r.active || state.running;
  if (!r.session_id) { renderClaimTrace(null); return; }
  $('#claimTraceStatus').textContent = '读取中';
  $('#claimTraceBody').textContent = '正在核对所选会话的当前证据文件…';
  try {
    const t = await api('/api/project/trace?project_id=' + encodeURIComponent(pid) + '&session_id=' + encodeURIComponent(r.session_id));
    if (seq === acceptanceSeq) renderClaimTrace(t.trace, t.project_dir);
  } catch (e) {
    if (seq === acceptanceSeq) { $('#claimTraceStatus').textContent = '读取失败'; $('#claimTraceBody').textContent = e.message; }
  }
}
$('#btnRefreshAcceptance').onclick = () => renderAcceptance(null, $('#acceptanceCard').dataset.projectId, $('#acceptanceSession').value);
$('#acceptanceSession').onchange = () => renderAcceptance(null, $('#acceptanceCard').dataset.projectId, $('#acceptanceSession').value);
$('#btnRetryTask').onclick = () => state.acceptance?.session_id && sseChat({ id: state.acceptance.session_id, action: 'retry' });
$('#btnFreezeRelease').onclick = async () => {
  const r = state.acceptance;
  if (!r) return;
  $('#btnFreezeRelease').disabled = true;
  try { await api('/api/project/release', { project_id: r.project_id, session_id: r.session_id }); }
  catch (e) { alert(e.message); }
  await renderAcceptance(null, r.project_id, r.session_id);
};
setInterval(() => {
  const pid = $('#acceptanceCard').dataset.projectId;
  if (pid && !document.hidden) renderAcceptance(null, pid, $('#acceptanceSession').value).catch(() => {});
}, 15000);

// 比赛时钟显示服务端当前阶段；阶段计划由赛事档案决定。
const PHASE_CN = { baseline: '基线', iterate: '迭代', freeze: '冻结总验证', final: '交付' };
function contestText(s) {
  if (!s || !s.contest) return '';
  const st = Number(s.contest_start || s.createdAt || 0), dl = Number(s.contest_deadline || 0);
  const phase = PHASE_CN[s.contest_phase] || '待开始';
  const notice = s.contest_package_notice ? ' · ⚠ 通用赛事档案' : '';
  if (!dl || dl <= st) return `⏱ ${phase} · 未设截止${notice}`;
  const now = Date.now();
  const left = Math.max(0, (dl - now) / 3.6e6), total = (dl - st) / 3.6e6;
  return `⏱ ${left.toFixed(1)}h/${total.toFixed(1)}h · ${phase}${notice}`;
}
function renderContest(s) {
  const pill = $('#contestPill');
  if (!pill) return;
  const txt = contestText(s);
  pill.style.display = txt ? '' : 'none';
  pill.textContent = txt;
  pill.title = s && s.contest_package_notice ? s.contest_package_notice : '比赛时钟：剩余时间与当前阶段';
}
setInterval(() => { if (state.session && state.session.contest) renderContest(state.session); }, 30000);
function effortWarning(next) {
  if (next === 'deep') return confirm(
    '切到深度模式会解锁四种高成本手法：\n\n' +
    '· 多评审辩论（每轮 4 次子代理调用）\n' +
    '· 方案树搜索（候选展开 + Top-2 实测）\n' +
    '· 建模-求解回改循环（多轮重跑）\n' +
    '· 图表视觉迭代闭环（每轮调用识图模型）\n\n' +
    '花销是快速档的数倍，仍受今日预算硬顶。确定切到深度？');
  if (next === 'extreme') return confirm(
    '切到极致模式会增加三类开支：\n\n' +
    '· 建模手 / 编程手 / 论文手三固定职责按阶段工作\n' +
    '· 独立路线与专项核查按需摊派动态子代理\n' +
    '· 红队构造反例、成本—精度审计与算法对照\n\n' +
    '简单任务可能只需 1–2 个子代理，复杂任务可能十几个；这只是量级示例，不是配额。最多 3 个并发、12 个硬上限，仍受今日预算与全部证据门禁约束。确定切到极致？');
  return true;
}
async function chooseEffort(next) {
  const s = state.session;
  if (!s) return;
  if (next === (s.effort || 'fast') || !effortWarning(next)) return;
  const r = await api('/api/session/effort', { id: s.id, effort: next });
  s.effort = r.effort;
  renderEffort(s);
}
const effortMenu = $('#effortMenu');
function closeEffortMenu() { effortMenu.hidden = true; $('#effortPill').setAttribute('aria-expanded', 'false'); }
$('#effortPill').onclick = () => {
  const pill = $('#effortPill');
  if (!effortMenu.hidden) return closeEffortMenu();
  const rect = pill.getBoundingClientRect();
  effortMenu.style.top = `${rect.bottom + 8}px`;
  effortMenu.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
  effortMenu.hidden = false;
  pill.setAttribute('aria-expanded', 'true');
  effortMenu.querySelectorAll('[data-effort]').forEach(button => {
    button.classList.toggle('active', button.dataset.effort === (state.session?.effort || 'fast'));
  });
};
effortMenu.querySelectorAll('[data-effort]').forEach(button => button.onclick = async () => {
  closeEffortMenu();
  await chooseEffort(button.dataset.effort);
});
document.addEventListener('pointerdown', event => {
  if (!effortMenu.hidden && !effortMenu.contains(event.target) && event.target !== $('#effortPill')) closeEffortMenu();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeEffortMenu(); });
$('#collabPill').onclick = async () => {
  const s = state.session;
  if (!s) return;
  const next = s.collab_mode === 'auto' ? 'collab' : 'auto';
  const r = await api('/api/session/collab', { id: s.id, collab_mode: next });
  s.collab_mode = r.collab_mode;
  renderCollab(s);
  renderContest(s);
  renderDeliverables(s);
  renderApproval(s);
  // 切到全自动时若有未答卡片：直接替用户选推荐项，流程继续
  if (next === 'auto' && r.pendingQuestion && !state.running) {
    const q = r.pendingQuestion;
    if (q.candidates) {
      const pick = q.candidates.find(c => c.id === q.recommended_id);
      if (pick) await sendText(pick.label, { decision_id: q.decision_id, selected_id: pick.id, rationale: '切换全自动后采用显式推荐：' + (q.recommendation_reason || pick.basis) });
    } else {
      const opts = q.options || [];
      await sendText(opts.find(o => /推荐/.test(o)) || opts[0] || '按你的推荐方案继续');
    }
  }
};
function titleOf(s) { return `${{ math: '📐', code: '⌨', free: '💬' }[s.mode] || ''} ${s.title}`; }
// 模型胶囊：顶部手动选择优先显示；未显式选（角色路由会话）显示实际解析出的模型与角色；都没有才退默认模型
function modelPillText(s) {
  if (s && s.model) return s.model;
  if (s && s.resolved_model) return (s.resolved_role ? s.resolved_role + '·' : '') + s.resolved_model;
  return (state.boot && state.boot.settings.default_model) || '';
}

// 判断层是可选的独立能力：把当前开关和触发策略放在标题栏，用户无需先猜设置页位置。
// 这里仅反映配置状态，不代表本次请求一定调用了判断模型；实际是否触发由服务端策略决定。
function renderJudgePill(settings) {
  const pill = $('#judgePill');
  if (!pill) return;
  const dj = (settings && settings.decision_judge) || {};
  const trigger = ['on_demand', 'smart', 'always'].includes(dj.trigger) ? dj.trigger : 'on_demand';
  const labels = { on_demand: '按需', smart: '智能', always: '全开' };
  const model = dj.provider && dj.model ? `${dj.provider}:${dj.model}` : (dj.model || '未配置模型');
  pill.classList.toggle('judge-off', dj.enabled !== true);
  pill.classList.toggle('judge-on', dj.enabled === true);
  pill.dataset.trigger = trigger;
  pill.textContent = dj.enabled === true ? `Jev ${labels[trigger]}` : 'Jev 关闭';
  pill.title = dj.enabled === true
    ? `判断层：${labels[trigger]}（${model}）\n点击打开判断层设置；它是可选能力，可随时关闭。`
    : '判断层已关闭；主流程、主模型和人工决策照常运行。点击打开设置。';
  pill.setAttribute('aria-label', pill.title.replace(/\n/g, ' '));
  pill.setAttribute('aria-pressed', dj.enabled === true ? 'true' : 'false');
}

function renderReasoningStatus(record) {
  const pill = $('#reasoningPill');
  if (!pill) return;
  if (!record) { pill.style.display = 'none'; return; }
  const statusNames = {
    requested: '已请求', api_accepted: 'API 已接受', provider_default: '提供商默认',
    fallback: '已回退', unsupported: '不支持', failed: '失败', cache_hit: '缓存复用',
  };
  const levelNames = { provider_default: '默认', none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '最高', max: '最大' };
  const requested = record.requested || '未指定';
  pill.style.display = '';
  const fellBack = record.status === 'fallback' || (requested !== 'provider_default' &&
    (record.effective === 'provider_default' || (record.status === 'api_accepted' && record.sent == null)));
  const displayedLevel = fellBack ? '默认（已回退）' : (levelNames[requested] || requested);
  pill.textContent = `推理 ${displayedLevel} · ${statusNames[record.status] || record.status || '待确认'}`;
  pill.title = `${record.kind || 'main'} · ${record.provider || '?'}:${record.model || '?'}\n` +
    `请求：${requested}；发送：${record.sent || '未发送'}；状态：${statusNames[record.status] || record.status || '待确认'}` +
    `${record.note ? '\n' + record.note : ''}\nAPI 接受参数不代表中转站最终执行该档位。`;
}

async function openSession(id) {
  const s = await api('/api/session/open', { id });
  state.session = s;
  if ($('#dlgProjectPlan').open) renderCurrentPlanSnapshot();
  renderHistory(s);
  $('#sessionTitle').textContent = titleOf(s);
  $('#modelPill').textContent = modelPillText(s);
  renderReasoningStatus(s.resolved_reasoning);
  $('#modeHint').textContent = modeHintOf(s);
  renderCollab(s);
  renderEffort(s);
  renderContest(s);
  renderDeliverables(s);
  renderApproval(s);
  // 未验证标记（持久化字段）：刷新/重开后仍可见
  if (s.unverifiedNumeric) $('#modeHint').textContent += ' ⚠含未验证数值结论';
  // 审计 P1：服务端标记 running 但前端没恢复停止按钮——若服务重启回落 idle
  // 这里读到 running 但服务端实际进程已不存在（X-Xihe-Token 错误或崩了），按钮恢复无意义；
  // UI 侧策略：仅当最近一次 refreshSessions 显示 running 才设 true，否则下次刷新会纠正。
  setRunning(['running', 'waiting_approval'].includes(s.status), 'background');
  if (s.status === 'waiting_jobs') setRunning(false, 'background');
  if (s.pendingApproval) showApprovalCard({ id: s.pendingApproval.id, tool: s.pendingApproval.tool, summary: s.pendingApproval.summary, args_preview: s.pendingApproval.args_preview });
  refreshJobs();
}

async function refreshSessions(preloaded) {
  // 刷新同时更新今日费用（旧版只拿 sessions 列表，仪表盘不随真实消耗更新）
  // preloaded：启动时可把刚取回的 bootstrap 直接传进来，省掉一次重复请求
  const b = preloaded || await api('/api/bootstrap').catch(() => null);
  if (b) { state.boot = b; fillContestKinds(); }
  if (state.boot) renderJudgePill(state.boot.settings);
  const list = (b && b.sessions) || [];
  const el = $('#sessionList');
  el.innerHTML = '';
  // v2.6：会话列表按当前项目过滤——所有项目的会话平铺在一起才是"堆在一起"的根源
  const pid = state.projectFilter;
  const scoped = pid ? list.filter(s => s.project_id === pid) : list;
  const shown = scoped.filter(s => !s.archived);
  const archived = scoped.filter(s => s.archived);
  state.archivedSessions = archived;
  // v2.6.1：项目名永远当组标题顶着（选定单项目时也要有——否则光秃秃一串对话，
  // 看不出这些对话属于哪个项目）。右侧 + 直接往这个项目里加对话。
  const projOf = (id) => ((state.projects || []).find(p => p.id === id) || null);
  const groupHead = (id) => {
    const p = projOf(id);
    const t = document.createElement('div');
    t.className = 'proj-head';
    const name = (p && (p.title || p.id)) || id || '未归类';
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = (p && p.dirMissing) ? name + ' ⚠缺失' : name;
    t.title = p ? (p.external ? `项目目录：${p.dir}` : `项目目录：workspace/projects/${p.id}`) : `项目：${id}`;
    t.appendChild(nm);
    // 项目 id 暴露到 DOM 上：标题可能是人改过的项目名，方向也可能是外部目录路径，
    // 从文本反查 id 只在 projOf() 拿不到项目时碰巧成立（验收 1c 就这么假通过过）。
    t.dataset.pid = id;
    // + = 在这个项目下新建对话。点击时直接取 dataset 上的 id，不靠闭包顺序。
    const plus = document.createElement('span');
    plus.className = 'padd';
    plus.textContent = '＋';
    plus.title = `在「${name}」项目下新建对话`;
    plus.onclick = async (e) => {
      e.stopPropagation();
      await newSessionIn(id);
    };
    t.appendChild(plus);
    return t;
  };
  const row = (s) => {
    const d = document.createElement('div');
    d.className = 'sess' + (state.session && state.session.id === s.id ? ' active' : '') + (s.pinned ? ' pinned' : '');
    d.innerHTML = `<span class="t">${s.pinned ? '📌 ' : ''}${esc(titleOf(s))}</span>`
      + `<span class="m">${s.status === 'waiting_input' ? '❓' : s.status === 'running' ? '⏳' : ''}</span>`
      + `<span class="a" title="${s.pinned ? '取消置顶' : '置顶'}">${s.pinned ? '📌' : '📍'}</span>`
      + `<span class="a" title="归档（从列表收起，随时可在设置里恢复）">📦</span>`
      + `<span class="x" title="删除（移入回收站，可手工找回）">✕</span>`;
    d.onclick = async (e) => {
      const cls = e.target.classList;
      if (cls.contains('a') || cls.contains('x')) {
        e.stopPropagation();
        if (d.querySelector('.m').textContent === '⏳') { alert('该会话正在运行，请先点击停止按钮'); return; }
        if (cls.contains('x')) {
          if (!confirm('删除这个会话？（移入 data/trash，可手工找回；经验库不受影响）')) return;
          const r = await api('/api/session/delete', { id: s.id });
          if (r && r.error) { alert(r.error); return; }
        } else if (e.target.title === '归档（从列表收起，随时可在设置里恢复）') {
          await api('/api/session/meta', { id: s.id, archived: true });
          if (state.session && state.session.id === s.id) { /* 当前会话仍可继续，只是从列表收起 */ }
        } else {
          await api('/api/session/meta', { id: s.id, pinned: !s.pinned });
        }
        refreshSessions();
        return;
      }
      openSession(s.id);
    };
    el.appendChild(d);
  };
  // v2.6.1：任何视图下都先出项目分组头，再列这个项目下的对话。
  // 选定单项目时也要头——否则一串对话看不出属于哪个项目（参考实现正是这么做的）。
  // 保持 listSessions 的既有排序（updatedAt 降序），按首次出现的顺序分组，不重排，
  // 免得"最近用过的项目"被字典序打乱。
  const order = [];
  const bucket = new Map();
  for (const s of shown) {
    const k = s.project_id || '';
    if (!bucket.has(k)) { bucket.set(k, []); order.push(k); }
    bucket.get(k).push(s);
  }
  if (pid && !order.includes(pid)) order.push(pid);   // 该项目下一个会话都没有时也要显示头（＋ 才有地方点）
  for (const k of order) {
    el.appendChild(groupHead(k));
    for (const s of bucket.get(k) || []) row(s);
  }
  if (archived.length) {
    const t = document.createElement('div');
    t.className = 'mini';
    t.style.cssText = 'margin:8px 0 2px;opacity:.7';
    t.textContent = `已归档 ${archived.length} 个（设置 → 归档会话 里恢复或彻底删除）`;
    el.appendChild(t);
  }
  // 外部配额
  if (b) {
    $('#extQuota').innerHTML = `本月 ChatGPT/Codex：${b.external.chatgpt_used}/${b.settings.chatgpt_quota} 次`;
    $('#extPanel').innerHTML = Object.entries(b.external.targets).map(([k, v]) => `<div>• ${esc(v)}</div>`).join('') + '<div class="mini">由模型按纪律自动调度；结果粘贴回输入框。</div>';
    $('#wsPath').textContent = b.workspace;
  }
}

// ---------- 附件（图片走识图桥；PDF/CSV/Excel/数据文件直接落盘供工具读取） ----------
let attachmentUploading = false;
$('#btnAttach').onclick = () => {
  if (attachmentUploading) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*,.pdf,.csv,.xlsx,.json,.txt,.md,.dat,.mat,.zip';
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    if (f.size > 60 * 1024 * 1024) { alert('附件过大（>60MB），请拆分或压缩'); return; }
    if (attachmentUploading) return;
    attachmentUploading = true;
    const status = $('#attachStatus');
    $('#btnAttach').disabled = true;
    $('#btnSend').disabled = true;
    status.hidden = false;
    status.textContent = `正在读取：${f.name}`;
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取文件，请检查文件是否可访问'));
        reader.onabort = () => reject(new Error('文件读取已中止'));
        reader.readAsDataURL(f);
      });
      status.textContent = `正在上传：${f.name}`;
      const up = await api('/api/upload', { name: f.name, dataB64: b64 });
      if (!up || typeof up.path !== 'string' || !up.path.trim()) throw new Error('上传响应缺少附件路径');
      state.attachments.push(up);
      renderAttachRow();
      status.textContent = `已添加：${f.name}`;
    } catch (e) {
      status.textContent = `附件添加失败：${e.message || String(e)}。请点击附件按钮重新选择文件重试。`;
    } finally {
      attachmentUploading = false;
      $('#btnAttach').disabled = false;
      $('#btnSend').disabled = false;
    }
  };
  inp.click();
};
function renderAttachRow() {
  $('#attachRow').innerHTML = state.attachments.map((a, i) => {
    const n = a.path.split('/').pop();
    const icon = /\.(png|jpe?g|gif|webp|bmp)$/i.test(n) ? '🖼' : /\.(pdf)$/i.test(n) ? '📕' : '📄';
    return `<span class="chip">${icon} ${esc(n.replace(/^\d+_/, ''))} <span class="x" data-i="${i}">✕</span></span>`;
  }).join('');
  $('#attachRow').querySelectorAll('.x').forEach(x => x.onclick = () => { state.attachments.splice(+x.dataset.i, 1); renderAttachRow(); });
}

// ---------- 设置 ----------
// 归档会话管理：恢复 / 彻底删除（彻底删除连 data/trash 副本也不留；经验库不受影响）
function renderArchived() {
  const el = $('#archivedList');
  if (!el) return;
  const list = state.archivedSessions || [];
  if (!list.length) { el.textContent = '（没有归档的会话）'; return; }
  el.innerHTML = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'deliver-row';
    row.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titleOf(s))}</span>
      <span class="meta">${s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('zh-CN') : ''}</span>`;
    const back = document.createElement('button');
    back.className = 'ghost tiny'; back.textContent = '恢复';
    back.onclick = async () => { await api('/api/session/meta', { id: s.id, archived: false }); await refreshSessions(); renderArchived(); };
    const del = document.createElement('button');
    del.className = 'ghost tiny'; del.textContent = '彻底删除';
    del.title = '从磁盘删除该会话文件（回收站副本也删）；经验库不受影响';
    del.onclick = async () => {
      if (!confirm(`彻底删除「${titleOf(s)}」？\n\n这会从磁盘删掉这个会话的聊天记录（含回收站副本），不可恢复。\n经验库（data/memory/store.jsonl）不受影响。`)) return;
      const r = await api('/api/session/delete', { id: s.id, hard: true });
      if (r && r.error) { alert(r.error); return; }
      if (state.session && state.session.id === s.id) { state.session = null; }
      await refreshSessions(); renderArchived();
    };
    row.append(back, del);
    el.appendChild(row);
  }
}
async function openSettings(focusReasoning = false, trigger = null) {
  const button = trigger || (focusReasoning ? $('#btnReasoningSettings') : $('#btnSettings'));
  const originalText = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (focusReasoning) button.textContent = '读取中…';
  try {
    const b = await api('/api/bootstrap');
    state.boot = b;
    renderJudgePill(b.settings);
    const s = b.settings;
    renderProviders(b);
    renderArchived();
    $('#setDefaultModel').value = s.default_model; $('#setHeavyModel').value = s.heavy_model;
    $('#setVisionModel').value = s.vision_model; $('#setSummarizeModel').value = s.summarize_model;
    const rm = s.role_models || {};
    $('#setRoleModeler').value = rm.modeler || ''; $('#setRoleCoder').value = rm.coder || '';
    $('#setRoleWriter').value = rm.writer || ''; $('#setRoleReviewer').value = rm.reviewer || '';
    const dj = s.decision_judge || {};
    $('#setJudgeEnabled').checked = dj.enabled === true;
    $('#setJudgeModel').value = dj.provider && dj.model && !String(dj.model).includes(':') ? `${dj.provider}:${dj.model}` : (dj.model || '');
    $('#setJudgeTrigger').value = ['on_demand', 'smart', 'always'].includes(dj.trigger) ? dj.trigger : 'on_demand';
    $('#setJudgeThreshold').value = dj.min_confidence != null ? dj.min_confidence : 0.82;
    $('#setJudgeSwap').checked = dj.swap_check === true;
    const judgeKeyReady = !!(b.keys && b.keys[dj.provider || 'tokenrhythm']);
    $('#judgeConfigStatus').textContent = dj.enabled
      ? (judgeKeyReady ? '判断层已启用；分歧和低置信度会升级给主模型或人。' : '判断层已启用，但当前供应商尚未配置 Key；运行时会安全回退。')
      : '判断层当前关闭；下方供应商配置只在你打开后参与判断。';
    const sq = s.skill_quality || {};
    $('#setQualityEnabled').checked = sq.enabled === true;
    $('#setQualityModel').value = sq.provider && sq.model && !String(sq.model).includes(':') ? `${sq.provider}:${sq.model}` : (sq.model || '');
    $('#qualityConfigStatus').textContent = sq.enabled
      ? '技能首检质检已启用：首次使用自动审一遍，同指纹跳过；修复副本须你确认。'
      : '技能首检质检当前关闭；技能照常加载，不产生质检调用。';
    $('#modelChoices').innerHTML = (b.models || []).map(m => `<option value="${esc(m.provider + ':' + m.id)}">${esc(m.providerName || m.provider)}</option>`).join('');
    $('#setTemp').value = s.temperature; $('#setEffort').value = s.reasoning_effort;
    $('#reasoningModelFilter').value = '';
    renderModelReasoningRows(b);
    $('#setReasoningFallback').value = s.reasoning_fallback || 'error';
    $('#setMaxOut').value = s.max_output_tokens != null ? s.max_output_tokens : 65536;
    $('#setCtxLimit').value = s.ctx_limit != null ? s.ctx_limit : 131072;
    // 构建指纹：全在设置页脚一行。用户看不出自己开的是哪一版，就只能靠我远程 curl /api/health——
    // 拿到这个号就能跟磁盘上的最新版对比，判断桌面快捷方式有没有落在旧壳上。
    $('#buildStamp').textContent = '读取构建指纹…';
    api('/api/health').then(h => {
      $('#buildStamp').innerHTML = '构建 <code>' + h.code_stamp + '</code>　服务 pid ' + h.pid;
    }).catch(() => { $('#buildStamp').textContent = '构建指纹读取失败'; });
    $('#dlgSettings').showModal();
    if (focusReasoning) {
      const section = $('#reasoningSettings');
      section.open = true;
      requestAnimationFrame(() => {
        const current = state.session && (state.session.model || state.session.resolved_model);
        const key = String(current || '').includes(':') ? current : '';
        const row = key && [...document.querySelectorAll('.reasoning-row')]
          .find(candidate => candidate.dataset.reasoningKey === key);
        const target = row || section;
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        (row && row.querySelector('select') || section.querySelector('select'))?.focus({ preventScroll: true });
      });
    }
  } catch (e) {
    alert('读取设置失败：' + (e.message || String(e)));
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
  }
}
$('#btnSaveSettings').onclick = async () => {
  const s = state.boot.settings;
  const patch = {
    default_model: $('#setDefaultModel').value.trim(), heavy_model: $('#setHeavyModel').value.trim(),
    vision_model: $('#setVisionModel').value.trim(), summarize_model: $('#setSummarizeModel').value.trim(),
    role_models: {
      modeler: $('#setRoleModeler').value.trim(), coder: $('#setRoleCoder').value.trim(),
      writer: $('#setRoleWriter').value.trim(), reviewer: $('#setRoleReviewer').value.trim(),
    },
    decision_judge: (() => {
      const raw = $('#setJudgeModel').value.trim();
      const sep = raw.indexOf(':');
      return {
        enabled: $('#setJudgeEnabled').checked,
        provider: sep > 0 ? raw.slice(0, sep) : 'tokenrhythm',
        model: sep > 0 ? raw.slice(sep + 1) : raw,
        trigger: $('#setJudgeTrigger').value,
        min_confidence: Math.min(1, Math.max(0, Number($('#setJudgeThreshold').value) || 0.82)),
        timeout_ms: (s.decision_judge && s.decision_judge.timeout_ms) || 12000,
        max_tokens: (s.decision_judge && s.decision_judge.max_tokens) || 512,
        auto_override: false,
        allow_override: false,
        swap_check: $('#setJudgeSwap').checked,
      };
    })(),
    skill_quality: (() => {
      const raw = $('#setQualityModel').value.trim();
      const sep = raw.indexOf(':');
      return {
        enabled: $('#setQualityEnabled').checked,
        provider: sep > 0 ? raw.slice(0, sep) : '',
        model: sep > 0 ? raw.slice(sep + 1) : raw,
        timeout_ms: (s.skill_quality && s.skill_quality.timeout_ms) || 60000,
        max_tokens: (s.skill_quality && s.skill_quality.max_tokens) || 4096,
      };
    })(),
    temperature: +$('#setTemp').value, reasoning_effort: $('#setEffort').value,
    model_reasoning: collectModelReasoning(), reasoning_fallback: $('#setReasoningFallback').value,
    max_output_tokens: +$('#setMaxOut').value || 0, ctx_limit: +$('#setCtxLimit').value || 131072,
  };
  try {
    Object.assign(patch, collectProviders());
    await api('/api/settings', patch);
    state.boot = await api('/api/bootstrap');
    renderJudgePill(state.boot.settings);
    $('#dlgSettings').close();
  } catch (e) { alert(e.message || String(e)); }
};

const REASONING_LEVELS = [
  ['', '沿用原有配置'], ['provider_default', '提供商默认'], ['none', '无'],
  ['minimal', '极低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '最高'], ['max', '最大'],
];
function renderModelReasoningRows(boot) {
  const saved = boot.settings.model_reasoning || {};
  const names = new Map((boot.models || []).map(m => [m.provider + ':' + m.id, (m.providerName || m.provider) + ' · ' + m.id]));
  const models = new Map((boot.models || []).map(m => [m.provider + ':' + m.id, m]));
  for (const key of Object.keys(saved)) if (!names.has(key)) names.set(key, key + '（当前列表外）');
  const box = $('#modelReasoningRows');
  box.innerHTML = '';
  for (const [key, label] of names) {
    const row = document.createElement('div');
    row.className = 'reasoning-row';
    row.dataset.reasoningKey = key;
    row.dataset.searchText = label.toLowerCase();
    const title = document.createElement('label');
    title.textContent = label;
    const model = models.get(key);
    const capability = model && model.reasoning;
    const select = document.createElement('select');
    select.className = 'model-reasoning';
    select.dataset.modelKey = key;
    select.setAttribute('aria-label', label + ' 推理设置');
    const savedLevel = capability?.aliases?.[saved[key]] || saved[key];
    const choices = REASONING_LEVELS.filter(([value]) => !value || !capability || capability.levels.includes(value));
    const unavailable = savedLevel && !choices.some(([value]) => value === savedLevel);
    if (unavailable && !capability?.limited) choices.push([savedLevel, savedLevel + '（原有配置，当前协议不支持）']);
    const isBudget = capability && /budget|manual/.test(capability.mode);
    select.innerHTML = choices.map(([value, name]) => {
      const switchLabel = /switch/.test(capability?.mode || '') && (value === 'high' ? '开启思考' : value === 'none' ? '关闭思考' : null);
      const budgetLabel = isBudget && ({minimal:1024,low:2048,medium:4096,high:8192,xhigh:16384,max:32768})[value];
      return `<option value="${value}">${switchLabel || (budgetLabel ? `思考预算 ${budgetLabel.toLocaleString()} Token` : name)}</option>`;
    }).join('');
    select.value = unavailable && capability?.limited ? 'provider_default' : (savedLevel || '');
    select.hidden = true;
    title.appendChild(select);
    row.appendChild(title);
    const stableLevels = ['minimal','low','medium','high','xhigh','max'].filter(level => capability?.levels.includes(level));
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '4'; slider.step = '1';
    slider.className = 'model-reasoning-slider'; slider.dataset.modelKey = key;
    slider.setAttribute('aria-label', label + ' 思考强度');
    const ticks = document.createElement('div'); ticks.className = 'reasoning-ticks';
    ticks.innerHTML = '<span>极低</span><span>低</span><span>中</span><span>高</span><span>最高</span>';
    const valueLabel = document.createElement('span'); valueLabel.className = 'reasoning-value';
    const choicesRow = document.createElement('div'); choicesRow.className = 'reasoning-choice-row';
    const setDefault = document.createElement('button'); setDefault.type = 'button'; setDefault.className = 'ghost tiny reasoning-default'; setDefault.textContent = '提供商默认';
    const setOff = document.createElement('button'); setOff.type = 'button'; setOff.className = 'ghost tiny reasoning-off'; setOff.textContent = '关闭思考';
    setOff.hidden = !capability?.levels.includes('none');
    const displayLevel = level => ({minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'最高',max:'最大'})[level] || level;
    const resolvedLevel = position => stableLevels.length ? stableLevels[Math.round(position * (stableLevels.length - 1) / 4)] : null;
    const syncControl = () => {
      const isDefault = select.value === 'provider_default' || select.value === '';
      const isOff = select.value === 'none';
      slider.disabled = !stableLevels.length || isDefault || isOff;
      setDefault.classList.toggle('active', isDefault);
      setOff.classList.toggle('active', isOff);
      if (!isDefault && !isOff && stableLevels.length) {
        const normalized = capability?.aliases?.[select.value] || select.value;
        const index = Math.max(0, stableLevels.indexOf(normalized));
        slider.value = String(stableLevels.length === 1 ? 2 : Math.round(index * 4 / (stableLevels.length - 1)));
        valueLabel.textContent = stableLevels.length === 1 ? `固定 ${displayLevel(stableLevels[0])}` : `当前：${displayLevel(normalized)}`;
      } else valueLabel.textContent = isOff ? '当前：关闭思考' : '当前：提供商默认';
    };
    slider.addEventListener('input', () => { const level = resolvedLevel(Number(slider.value)); if (level) select.value = level; syncControl(); });
    setDefault.onclick = () => { select.value = 'provider_default'; syncControl(); };
    setOff.onclick = () => { select.value = 'none'; syncControl(); };
    syncControl();
    const sliderWrap = document.createElement('div'); sliderWrap.className = 'reasoning-slider-wrap';
    sliderWrap.append(slider, ticks, valueLabel);
    choicesRow.append(setDefault, setOff);
    row.append(sliderWrap, choicesRow);
    if (capability) {
      const note = document.createElement('p'); note.className = 'mini'; note.textContent = (capability.note || '使用该模型原生推理档位') +
        (unavailable && capability.limited ? `；原档位 ${saved[key]} 当前不适用，保存后改用默认` : '') +
        (stableLevels.length === 1 ? '；此模型仅有一个稳定强度，滑杆各档均路由至该强度' : ''); row.appendChild(note);
    }
    if (model) {
      const test = document.createElement('button'); test.className = 'ghost tiny'; test.type = 'button'; test.textContent = '测试此推理设置';
      test.title = '发送一条短模型请求（会产生真实用量）；通常最多等待120秒，最高/最大档180秒，超时不代表档位不支持';
      const result = document.createElement('span'); result.className = 'mini reasoning-test-result'; result.setAttribute('role', 'status');
      test.onclick = async () => {
        test.disabled = true; result.textContent = '等待模型响应…思考可能需要较长时间';
        try {
          const providerRow = [...document.querySelectorAll('#provTable .prov')].find(el => el.dataset.pk === model.provider);
          const provider = (boot.providers || []).find(p => p.id === model.provider) || {};
          const r = await api('/api/provider/test', { pk: model.provider, model: model.id, reasoning_level: select.value,
            base: providerRow ? providerRow.querySelector('.pv-base').value.trim() : provider.base,
            kind: providerRow ? providerRow.querySelector('.pv-kind').value : provider.kind,
            key: providerRow ? providerRow.querySelector('.pv-key').value.trim() : '' });
          result.textContent = r.ok ? `接口已接受${r.truncated ? '（短输出预算已用尽）' : ''}；实际执行强度未独立确认` : '未通过：' + (r.error || '未知错误');
          if (r.reasoning) result.title = '实际请求：' + (r.reasoning.sent || '提供商默认');
        } catch (e) { result.textContent = '验证失败：' + e.message; }
        finally { test.disabled = false; }
      };
      row.append(test, result);
    }
    box.appendChild(row);
  }
}
$('#reasoningModelFilter').addEventListener('input', (e) => {
  const query = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#modelReasoningRows .reasoning-row').forEach(row => {
    row.hidden = query && !row.dataset.searchText.includes(query);
  });
});
function collectModelReasoning() {
  const selected = { ...((state.boot && state.boot.settings.model_reasoning) || {}) };
  document.querySelectorAll('#modelReasoningRows select.model-reasoning').forEach(select => {
    if (select.value) selected[select.dataset.modelKey] = select.value;
    else delete selected[select.dataset.modelKey];
  });
  return selected;
}

// 提供商表：每个模型独立一行，可启用/停用、编辑、删除和单独测试。
function modelRowsHtml(pk, models, disabled) {
  return `<div class="pv-model-list" data-provider="${esc(pk)}">${(models || []).map((id, i) => {
    const q = pk + ':' + id;
    return `<div class="pv-model-row" data-model="${esc(id)}">
      <input class="pv-model-id" value="${esc(id)}" placeholder="模型 ID">
      <label class="pv-model-enabled"><input type="checkbox" class="pv-model-toggle" ${disabled.has(q) ? '' : 'checked'}>启用</label>
      <button type="button" class="ghost pv-model-test" title="测试此模型">测试</button>
      <button type="button" class="ghost pv-model-del" title="删除此模型">删除</button><span class="mini pv-model-res"></span>
    </div>`;
  }).join('')}</div><button type="button" class="ghost pv-model-add">＋ 添加模型</button>`;
}
function bindModelRows(row) {
  const list = row.querySelector('.pv-model-list');
  const catalog = document.createElement('button'); catalog.type='button'; catalog.className='ghost pv-model-catalog'; catalog.textContent='查询当前 Key 可见模型';
  catalog.title='只读取当前接口的模型目录，不发送生成请求，也不更改模型列表';
  const catalogStatus=document.createElement('p');catalogStatus.className='mini';catalogStatus.setAttribute('role','status');
  catalog.onclick=async()=>{
    catalog.disabled=true;catalogStatus.textContent='读取当前密钥的模型目录…';
    try{
      const pk=row.classList.contains('custom')?row.querySelector('.pv-id').value.trim():row.dataset.pk;
      const result=await api('/api/provider/models',{pk,base:row.querySelector('.pv-base').value.trim(),kind:row.querySelector('.pv-kind').value,key:row.querySelector('.pv-key').value.trim()});
      if(!result.ok){catalogStatus.textContent=result.error || '目录不可用；未改动模型列表';return;}
      const visible=new Set(result.models);const missing=[];
      row.querySelectorAll('.pv-model-row').forEach(modelRow=>{
        const id=modelRow.querySelector('.pv-model-id').value.trim();
        const listed=visible.has(id);modelRow.querySelector('.pv-model-res').textContent=listed?'当前目录已列出':'当前 Key 目录未列出';
        if(!listed)missing.push(id);
      });
      catalogStatus.textContent=`当前 Key 目录共 ${visible.size} 个模型。${missing.length?'未列出：'+missing.join('、')+'。':''}目录存在不保证生成通道可用；没有修改配置。`;
    }catch(e){catalogStatus.textContent='目录读取失败：'+e.message;}
    finally{catalog.disabled=false;}
  };
  row.append(catalog,catalogStatus);
  row.querySelector('.pv-model-add')?.addEventListener('click', () => {
    const el = document.createElement('div'); el.className = 'pv-model-row'; el.dataset.new = '1';
    el.innerHTML = `<input class="pv-model-id" placeholder="模型 ID"><label class="pv-model-enabled"><input type="checkbox" class="pv-model-toggle" checked>启用</label><button type="button" class="ghost pv-model-test">测试</button><button type="button" class="ghost pv-model-del">删除</button><span class="mini pv-model-res"></span>`;
    list.appendChild(el); el.querySelector('.pv-model-id').focus(); bindModelRow(row, el);
  });
  [...list.children].forEach(el => bindModelRow(row, el));
}
function bindModelRow(providerRow, modelRow) {
  modelRow.querySelector('.pv-model-del').onclick = () => modelRow.remove();
  modelRow.querySelector('.pv-model-test').onclick = async () => {
    const res = modelRow.querySelector('.pv-model-res'), id = modelRow.querySelector('.pv-model-id').value.trim();
    const pk = providerRow.dataset.pk || providerRow.querySelector('.pv-id')?.value.trim().toLowerCase();
    if (!pk || !id) { res.textContent = '✗ 先填供应商 id 和模型 id'; return; }
    res.textContent = '测试中…';
    const r = await api('/api/provider/test', { pk, base: providerRow.querySelector('.pv-base').value.trim(), kind: providerRow.querySelector('.pv-kind').value, model: id, key: providerRow.querySelector('.pv-key').value.trim() }).catch(e => ({ok:false,error:e.message}));
    res.textContent = r.ok ? `✓ 通了（${r.ms} ms）` : '✗ ' + String(r.error || '').slice(0, 120);
  };
}
function protocolOptions(kind = 'openai') {
  return [['anthropic','Anthropic Messages (/v1/messages)'],['openai','Chat Completions (/chat/completions)'],['responses','Responses (/responses)']]
    .map(([value,label]) => '<option value="'+value+'"'+(kind===value?' selected':'')+'>'+label+'</option>').join('');
}
function customProvRow(c, isNew, disabled) {
  const row = document.createElement('div'); row.className = 'prov custom'; row.dataset.pk = c.id || ''; row.dataset.custom = '1';
  row.innerHTML = `<div class="provhead"><b>${esc(c.name || '（新供应商）')}</b><span class="mini">自定义${isNew ? '·未保存' : ''}${c.keySet ? ' · ✓ Key 已配置' : ' · ✗ 未配置 Key'}</span><button type="button" class="ghost provdel">删除供应商</button></div>
    <div class="grid2"><label>显示名称<input class="pv-name" value="${esc(c.name || '')}" placeholder="如 我的中转站"></label><label>标识 id（模型路由用）<input class="pv-id" value="${esc(c.id || '')}" placeholder="myrelay"></label></div>
    <div class="grid2"><label>Base URL<input class="pv-base" value="${esc(c.base || '')}" placeholder="https://xxx.example.com/v1"></label><label>接口格式<select class="pv-kind">${protocolOptions(c.kind)}</select></label></div>
    <div class="pv-models-label mini">模型列表</div>${modelRowsHtml(c.id || '', c.models || [], disabled)}<label>API Key<input class="pv-key" type="password" placeholder="${c.keySet ? '已保存（留空不改）' : '填这一家的 key'}"></label>`;
  row.querySelector('.provdel').onclick = () => row.remove(); bindModelRows(row); return row;
}
function renderProviders(b) {
  const s = b.settings, P = b.providers || [], disabled = new Set(s.disabled_models || []);
  $('#provTable').innerHTML = '';
  for (const p of P.filter(x => !x.custom)) {
    const base = (s.provider_bases || {})[p.id] || (p.id === 'glm' && s.glm_base) || p.base, kind = (s.provider_kinds || {})[p.id] || p.kind;
    const models = (s.provider_models || {})[p.id] || p.models || [];
    const row = document.createElement('div'); row.className = 'prov'; row.dataset.pk = p.id;
    row.innerHTML = `<div class="provhead"><b>${esc(p.name)}</b><span class="mini">${b.keys && b.keys[p.id] ? '✓ Key 已配置' : '✗ 未配置 Key'}</span></div><div class="grid2"><label>Base URL<input class="pv-base" value="${esc(base)}" placeholder="${esc(p.base)}"></label><label>接口格式<select class="pv-kind">${protocolOptions(kind)}</select></label></div><div class="pv-models-label mini">模型列表</div>${modelRowsHtml(p.id, models, disabled)}<label>API Key<input class="pv-key" type="password" placeholder="留空则沿用 ${esc(p.keyFile || '')}"></label>`;
    $('#provTable').appendChild(row); bindModelRows(row);
  }
  const customBox = document.createElement('div'); customBox.id = 'customProvs';
  for (const c of P.filter(x => x.custom)) customBox.appendChild(customProvRow(Object.assign({keySet:!!(b.keys&&b.keys[c.id])}, c), false, disabled));
  $('#provTable').appendChild(customBox);
  const add = document.createElement('button'); add.type='button'; add.className='ghost'; add.textContent='＋ 添加供应商'; add.onclick=()=>{ const r=customProvRow({id:'',name:'',base:'',kind:'openai',models:[]},true,disabled); customBox.appendChild(r); r.querySelector('.pv-id').focus(); }; $('#provTable').appendChild(add);
}
function collectProviders() {
  const out = { provider_bases:{}, provider_kinds:{}, provider_models:{}, custom_providers:[], disabled_models:[] }, seen = new Set(), P = state.boot.providers || [];
  const oldDisabled = new Set((state.boot.settings && state.boot.settings.disabled_models) || []);
  const previous = new Set();
  for (const p of P) for (const id of ((state.boot.settings.provider_models || {})[p.id] || p.models || [])) previous.add(p.id + ':' + id);
  for (const c of P.filter(x => x.custom)) for (const id of c.models || []) previous.add(c.id + ':' + id);
  document.querySelectorAll('#provTable .prov').forEach(row => {
    const custom = row.dataset.custom === '1', idField = row.querySelector('.pv-id'), pk = custom ? idField.value.trim().toLowerCase() : row.dataset.pk;
    const base = row.querySelector('.pv-base').value.trim(), kind = row.querySelector('.pv-kind').value;
    const entries = [];
    for (const m of row.querySelectorAll('.pv-model-row')) {
      const id = m.querySelector('.pv-model-id').value.trim(), enabled = m.querySelector('.pv-model-toggle').checked;
      if (!id) { if (enabled && !m.dataset.new) throw new Error('已有模型行不能为空；请填写模型 id、停用或删除'); continue; }
      entries.push({id, enabled});
    }
    const models = entries.map(x=>x.id);
    for (const x of entries) { const q=pk+':'+x.id; if (seen.has(q)) throw new Error('模型重复：'+q); seen.add(q); if (!x.enabled) out.disabled_models.push(q); }
    if (!pk) { if (custom && (base || models.length || row.querySelector('.pv-name').value.trim())) throw new Error('自定义供应商缺少标识 id'); return; }
    if (custom) { const original = ((state.boot.settings && state.boot.settings.custom_providers) || []).find(p => p.id === pk) || P.find(p => p.custom && p.id === pk) || {}; const cp = {id:pk,name:row.querySelector('.pv-name').value.trim()||pk,base,kind,models}; for (const k of ['ctx_limit','max_tokens']) if (original[k] != null) cp[k] = original[k]; out.custom_providers.push(cp); const key=row.querySelector('.pv-key').value.trim(); if(key) out['custom_'+pk+'_key']=key; }
    else { const def=P.find(p=>p.id===pk)||{}; if(base && base!==def.base) out.provider_bases[pk]=base; if(kind!==def.kind) out.provider_kinds[pk]=kind; if(JSON.stringify(models)!==JSON.stringify(def.models||[])) out.provider_models[pk]=models; const key=row.querySelector('.pv-key').value.trim(); if(key) out[pk+'_key']=key; }
  });
  // Keep unknown tombstones and tombstone deleted/renamed registered models. Re-enabling a row removes its tombstone.
  for (const q of oldDisabled) if (!seen.has(q)) out.disabled_models.push(q);
  for (const q of previous) if (!seen.has(q) && !out.disabled_models.includes(q)) out.disabled_models.push(q);
  return out;
}

// ---------- 技能库 ----------
let skillsCache = [];
// 项目方案存于服务端项目元数据；弹窗只编辑草稿，不写用户的外部项目文件夹。
const PLAN_SLOTS = { research: '研究方法', figures: '图表方法', review: '审查方法' };
const planDrafts = new Map();
let planProjectId = '', planRequestSeq = 0, planSkills = [];
let planPreviewIsDraft = false;
function planStatus(message, isError = false) {
  const el = $('#planStatus');
  el.textContent = message;
  el.style.color = isError ? 'var(--red)' : '';
}
function planSkillOptions(selected, autoLabel) {
  const names = [...new Set(planSkills.map(row => row.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const opts = [`<option value="">${esc(autoLabel)}</option>`];
  if (selected && !names.includes(selected)) opts.push(`<option value="${esc(selected)}">⚠ ${esc(selected)}（当前未找到，将按回退处理）</option>`);
  for (const name of names) opts.push(`<option value="${esc(name)}">${esc(name)}</option>`);
  return opts.join('');
}
function planFromEditor() {
  const value = JSON.parse($('#planJson').value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('方案 JSON 顶层必须是对象');
  return value;
}
let planPluginCatalog = [];
function fillTemplateLibrary() {
  const select = $('#planTemplate');
  const selected = select.value;
  select.innerHTML = '<option value="">选择建模模板…</option>' + (state.boot?.template_library || []).map(row =>
    `<option value="${esc(row.id)}"${row.available ? '' : ' disabled'}>${esc(row.label)}${row.available ? '' : '（未安装）'}</option>`).join('');
  select.value = selected;
  describePlanTemplate();
}
function describePlanTemplate() {
  const row = (state.boot?.template_library || []).find(row => row.id === $('#planTemplate').value);
  const description = row?.description || '赛事模板选择对应流程和论文骨架；仿真方法模板保留当前赛事规则。';
  $('#planTemplateDescription').textContent = `${description} 当前搭配效果未验证，选择后请检查任务适配性。`;
}
$('#planTemplate').onchange = describePlanTemplate;
$('#btnPlanTemplate').onclick = async () => {
  const id = planProjectId;
  const requestSeq = planRequestSeq;
  const templateId = $('#planTemplate').value;
  if (!id || !templateId) { planStatus('请先选择一个模板。', true); return; }
  const button = $('#btnPlanTemplate'); button.disabled = true;
  try {
    const draft = $('#planJson').value;
    const r = await api('/api/project/plan/template', { project_id: id, template_id: templateId, plan: planFromEditor() });
    if (id !== planProjectId || requestSeq !== planRequestSeq || !$('#dlgProjectPlan').open || $('#planTemplate').value !== templateId) return;
    if ($('#planJson').value !== draft) { planStatus('草稿已在请求期间更改，请重新载入模板。', true); return; }
    $('#planJson').value = JSON.stringify(r.plan, null, 2);
    planDrafts.set(id, $('#planJson').value);
    fillPlanControls(r.plan);
    planStatus(`已载入「${r.template.label}」草稿；${planPreviewIsDraft ? '下方检查结果已过期，请重新检查。' : '保存项目方案后用于新会话。'}`);
  } catch (e) { if (id === planProjectId) planStatus('模板载入失败：' + e.message, true); }
  finally { button.disabled = false; }
};
function fillPlanControls(plan) {
  $('#planLabel').value = plan.label || '';
  for (const [key, input] of [['problem_types', 'planProblemTypes'], ['stages', 'planStages'], ['data', 'planData']]) {
    const values = plan.task_context?.[key];
    $("#" + input).value = Array.isArray(values) ? values.join(', ') : '';
  }
  $('#planTraceRequired').checked = plan.evidence?.claim_trace === 'required';
  $('#planEvidenceFigures').checked = !!plan.plugins?.find(row => row.id === 'evidence-figures')?.enabled;
  const otherPlugins = $('#planOtherPlugins'); otherPlugins.replaceChildren();
  const catalog = new Map((planPluginCatalog || []).map(row => [row.id, row]));
  for (const row of plan.plugins || []) catalog.set(row.id, { ...catalog.get(row.id), ...row });
  for (const [id, row] of catalog) if (id !== 'evidence-figures') {
    const label = document.createElement('label'); label.className = 'plan-trace-option';
    const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.pluginId = id;
    check.checked = !!plan.plugins?.find(p => p.id === id)?.enabled; check.onchange = updatePlanFromControls;
    label.append(check, document.createTextNode('启用插件：' + (row.label || id))); otherPlugins.append(label);
  }
  const contest = plan.contest?.contest_kind || 'generic';
  const packages = state.boot?.contest_packages || [];
  $('#planContestKind').innerHTML = packages.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')
    + (packages.some(p => p.id === contest) ? '' : `<option value="${esc(contest)}">⚠ ${esc(contest)}（此机未安装）</option>`);
  $('#planContestKind').value = contest;
  $('#planControlNumber').value = plan.contest?.control_number || '';
  const main = plan.skills?.main?.primary || '';
  $('#planMainSkill').innerHTML = planSkillOptions(main, '自动（保留赛事主技能）');
  $('#planMainSkill').value = main;
  const wrap = $('#planSlotControls');
  wrap.replaceChildren();
  for (const [slot, label] of Object.entries(PLAN_SLOTS)) {
    const row = document.createElement('div');
    row.className = 'plan-slot'; row.dataset.slot = slot;
    const title = document.createElement('span'); title.className = 'plan-slot-name'; title.textContent = label;
    const modeLabel = document.createElement('label'); modeLabel.textContent = '使用方式';
    const mode = document.createElement('select'); mode.className = 'plan-slot-mode';
    for (const [value, name] of [['off', '关闭'], ['append', '补充'], ['replace', '替换']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = name; mode.append(option);
    }
    mode.value = plan.skills?.[slot]?.mode || 'off'; modeLabel.append(mode);
    const skillLabel = document.createElement('label'); skillLabel.textContent = '首选 Skill';
    const skill = document.createElement('select'); skill.className = 'plan-slot-skill';
    const primary = plan.skills?.[slot]?.primary || '';
    skill.innerHTML = planSkillOptions(primary, '选择时自动按回退链查找');
    skill.value = primary; skillLabel.append(skill);
    row.append(title, modeLabel, skillLabel); wrap.append(row);
    mode.onchange = skill.onchange = updatePlanFromControls;
  }
}
function updatePlanFromControls() {
  try {
    const plan = planFromEditor();
    plan.label = $('#planLabel').value.trim();
    plan.task_context = { ...(plan.task_context || {}) };
    for (const [key, input] of [['problem_types', 'planProblemTypes'], ['stages', 'planStages'], ['data', 'planData']]) {
      const value = $("#" + input).value.trim();
      plan.task_context[key] = value ? [...new Set(value.split(/[,，]/).map(item => item.trim()).filter(Boolean))]
        : Array.isArray(plan.task_context[key]) && plan.task_context[key].length === 0 ? [] : null;
    }
    plan.evidence = { ...(plan.evidence || {}), claim_trace: $('#planTraceRequired').checked ? 'required' : 'optional' };
    plan.plugins = [...(Array.isArray(plan.plugins) ? plan.plugins : []).filter(row => row.id !== 'evidence-figures'),
      { id: 'evidence-figures', enabled: $('#planEvidenceFigures').checked }];
    for (const check of $('#planOtherPlugins').querySelectorAll('[data-plugin-id]')) {
      plan.plugins = plan.plugins.filter(row => row.id !== check.dataset.pluginId);
      plan.plugins.push({ id: check.dataset.pluginId, enabled: check.checked });
    }
    const contestChanged = plan.contest?.contest_kind !== $('#planContestKind').value;
    plan.contest = contestChanged ? { contest_kind: $('#planContestKind').value, contest_rules: {}, deadline: null }
      : { ...(plan.contest || {}), contest_kind: $('#planContestKind').value };
    plan.contest.control_number = $('#planControlNumber').value || null;
    plan.skills = { ...(plan.skills || {}) };
    plan.skills.main = contestChanged ? { primary: null, fallbacks: [] } : { ...(plan.skills.main || {}), primary: $('#planMainSkill').value || null };
    if (contestChanged) $('#planMainSkill').value = '';
    for (const row of $('#planSlotControls').querySelectorAll('.plan-slot')) {
      const slot = row.dataset.slot;
      plan.skills[slot] = { ...(plan.skills[slot] || {}), mode: row.querySelector('.plan-slot-mode').value,
        primary: row.querySelector('.plan-slot-skill').value || null };
    }
    $('#planJson').value = JSON.stringify(plan, null, 2);
    planDrafts.set(planProjectId, $('#planJson').value);
    planStatus(planPreviewIsDraft ? '草稿已更改，下方检查结果已过期；请重新检查。' : '更改尚未保存；下方预览仍是上次保存的方案。');
  } catch (e) { planStatus('JSON 尚未改成有效方案：' + e.message, true); }
}
function renderPlanEntries(target, entries, notices) {
  target.replaceChildren();
  const slotNames = { main: '赛事主技能', ...PLAN_SLOTS };
  const installationLabels = { installable: '可安装', unavailable: '不可用', off: '已关闭' };
  const applicabilityLabels = { compatible: '适配当前任务', incompatible: '不适配当前任务', unknown: '适配性待确认', off: '已关闭' };
  if (!Array.isArray(entries) || !entries.length) { target.textContent = '尚无生效记录'; return; }
  for (const row of entries) {
    const item = document.createElement('div'); item.className = 'plan-entry';
    const title = document.createElement('b'); title.textContent = `${slotNames[row.slot] || row.slot}：${row.name || (['disabled', 'off'].includes(row.status) ? '关闭' : '未加载')}`;
    const detail = document.createElement('span'); detail.className = 'mini';
    const installation = row.installation?.status || (row.status === 'loaded' ? 'installable' : row.status === 'off' ? 'off' : 'unavailable');
    const applicability = row.applicability?.status || (row.status === 'off' ? 'off' : 'unknown');
    const info = [`安装：${installationLabels[installation] || installation}`, `任务：${applicabilityLabels[applicability] || applicability}`,
      row.blocked && '因不适配未注入', row.version && `v${row.version}`, row.source && `来源 ${row.source}`,
      row.sha256 && `SHA-256 ${row.sha256}`].filter(Boolean).join(' · ');
    detail.textContent = info;
    item.append(title, detail);
    const assessmentReasons = [...(row.installation?.reasons || []), ...(row.applicability?.reasons || [])];
    if (assessmentReasons.length) {
      const reason = document.createElement('span'); reason.className = 'mini';
      reason.textContent = '检查依据：' + assessmentReasons.join('；'); item.append(reason);
    }
    if (row.shadowed?.length) {
      const shade = document.createElement('span'); shade.className = 'mini';
      shade.textContent = '同名遮蔽：' + row.shadowed.map(x => typeof x === 'string' ? x : [x.source || x.tag || x.root, x.version && `v${x.version}`, x.sha256].filter(Boolean).join(' · ')).join('；');
      item.append(shade);
    }
    const reasons = row.fallbacks || row.failures || [];
    if (reasons.length) {
      const fallback = document.createElement('span'); fallback.className = 'mini';
      fallback.textContent = '回退：' + reasons.map(x => typeof x === 'string' ? x : x.reason || JSON.stringify(x)).join('；');
      item.append(fallback);
    }
    target.append(item);
  }
  if (notices?.length) {
    const note = document.createElement('p'); note.className = 'mini'; note.textContent = notices.join('；'); target.append(note);
  }
}
function renderPlanAssessment(target, assessment) {
  const item = document.createElement('div'); item.className = 'plan-entry';
  const applicabilityLabels = { compatible: '组合适配当前任务', incompatible: '组合存在不适配', unknown: '组合适配性待确认' };
  const gainLabels = { unverified: '效果未验证', observed_gain: '限定条件下观察到增益', no_gain: '限定条件下未观察到增益', inconclusive: '增益证据尚无定论' };
  const applicability = assessment?.applicability;
  const gain = assessment?.gain;
  const title = document.createElement('b');
  title.textContent = `组合检查：${applicabilityLabels[applicability?.status] || '适配性未检查'} · ${gainLabels[gain?.status] || '效果未验证'}`;
  item.append(title);
  const reasons = [...(applicability?.reasons || []), ...(gain?.reasons || [])];
  const explanation = document.createElement('span'); explanation.className = 'mini';
  explanation.textContent = reasons.length ? reasons.join('；') : '默认或自定义搭配尚无同模型、同题目、同预算的可比增益记录。';
  item.append(explanation);
  if (gain?.status === 'observed_gain') {
    const scope = document.createElement('span'); scope.className = 'mini';
    scope.textContent = '增益只适用于记录中的版本、模型、题型、阶段和预算；不代表论文质量已得到保证。';
    item.append(scope);
  }
  target.append(item);
}
function renderPlanEffective(target, effective, traceRequired) {
  renderPlanEntries(target, effective?.entries || [], effective?.notices || []);
  renderPlanAssessment(target, effective?.assessment);
  renderPlanPlugins(target, effective?.plugins || []);
  const trace = document.createElement('p'); trace.className = 'mini';
  trace.textContent = `主张追溯：${traceRequired ? '新会话交付必须逐问登记并绑定摘要与图件' : '新会话可按需启用'}。`;
  target.prepend(trace);
}
function renderPlanPlugins(target, plugins) {
  if (!Array.isArray(plugins) || !plugins.length) return;
  for (const row of plugins) {
    const item = document.createElement('div'); item.className = 'plan-entry';
    const title = document.createElement('b');
    title.textContent = `插件 ${row.label || row.id}：${row.status === 'loaded' ? '已启用' : row.status === 'off' ? '已关闭' : '不可用'}`;
    const detail = document.createElement('span'); detail.className = 'mini';
    detail.textContent = [row.version && `v${row.version}`, row.source && `来源 ${row.source}`,
      row.sha256 && `SHA-256 ${row.sha256}`, row.capabilities?.length && `能力 ${row.capabilities.join('、')}`].filter(Boolean).join(' · ');
    item.append(title, detail);
    if (row.reason) {
      const reason = document.createElement('span'); reason.className = 'mini'; reason.textContent = `原因：${row.reason}`; item.append(reason);
    }
    target.append(item);
  }
}
function renderCurrentPlanSnapshot() {
  const target = $('#planCurrentSession');
  const session = state.session;
  if (!session || session.project_id !== planProjectId) { target.textContent = '当前未打开此项目的会话。'; return; }
  const snapshot = session.skill_plan_snapshot;
  if (!snapshot) { target.textContent = '当前会话没有项目方案快照（可能建于启用此功能之前）。'; return; }
  const head = document.createElement('p'); head.textContent = `会话创建时的项目方案第 ${snapshot.revision || '—'} 版；当前项目修改不会改写该会话。`;
  target.replaceChildren(head);
  const trace = document.createElement('p'); trace.textContent = `主张追溯：${session.claim_trace_required ? '本会话要求交付检查' : '此方案不强制'}。`;
  target.append(trace);
  const rows = document.createElement('div'); target.append(rows);
  renderPlanEntries(rows, snapshot.entries || []);
  renderPlanAssessment(rows, snapshot.assessment);
  renderPlanPlugins(rows, snapshot.plugins || []);
}
async function loadProjectPlan(projectId) {
  if (!projectId) { planStatus('请先在左侧选择或创建项目。', true); return; }
  const seq = ++planRequestSeq;
  if (planProjectId && planProjectId !== projectId && $('#planJson').value) planDrafts.set(planProjectId, $('#planJson').value);
  planProjectId = projectId;
  $('#planProjectName').textContent = `项目：${(state.projects || []).find(p => p.id === projectId)?.title || projectId}（${projectId}）`;
  planStatus('正在读取方案…');
  try {
    const r = await api('/api/project/plan?project_id=' + encodeURIComponent(projectId));
    if (seq !== planRequestSeq || projectId !== planProjectId || !$('#dlgProjectPlan').open) return;
    planSkills = Array.isArray(r.skills) ? r.skills : (state.boot?.skills || []);
    fillTemplateLibrary();
    planPluginCatalog = r.available_plugins || [];
    $('#planLocalRoots').value = (r.local_skill_roots || []).join('\n');
    const saved = JSON.stringify(r.plan, null, 2);
    $('#planJson').value = planDrafts.get(projectId) || saved;
    planPreviewIsDraft = false;
    try { fillPlanControls(planFromEditor()); }
    catch (e) { planStatus('草稿 JSON 无法解析：' + e.message, true); }
    renderPlanEffective($('#planEffective'), r.effective, r.plan?.evidence?.claim_trace === 'required');
    const figurePlugin = (r.available_plugins || []).find(row => row.id === 'evidence-figures');
    $('#planPluginHint').textContent = figurePlugin?.status === 'unavailable'
      ? `证据图渲染插件当前不可用：${figurePlugin.reason || '未找到'}。保存启用后仍需安装可用版本。`
      : '插件仅影响新会话：隔离副本绘图、禁网与子进程，仅接收声明图件；生效版本与来源见下方预览。';
    renderCurrentPlanSnapshot();
    if (!planDrafts.has(projectId)) planStatus(`项目方案第 ${r.revision || '—'} 版。以下预览是已保存方案在新会话的选择结果。`);
  } catch (e) { if (seq === planRequestSeq && projectId === planProjectId) planStatus('读取失败：' + e.message, true); }
}
async function openProjectPlan() {
  const projectId = state.projectFilter || state.session?.project_id || (state.projects || [])[0]?.id;
  if (!projectId) { alert('请先创建一个项目，再编辑项目方案。'); return; }
  $('#dlgProjectPlan').showModal();
  await loadProjectPlan(projectId);
}
$('#btnProjectPlan').onclick = openProjectPlan;
$('#btnPlanClose').onclick = () => { planRequestSeq++; $('#dlgProjectPlan').close(); };
$('#planLabel').oninput = $('#planControlNumber').oninput = $('#planProblemTypes').oninput = $('#planStages').oninput = $('#planData').oninput
  = $('#planContestKind').onchange = $('#planMainSkill').onchange = $('#planTraceRequired').onchange = $('#planEvidenceFigures').onchange = updatePlanFromControls;
$('#planJson').oninput = () => { planDrafts.set(planProjectId, $('#planJson').value);
  planStatus(planPreviewIsDraft ? '草稿已更改，下方检查结果已过期；请重新检查。' : 'JSON 草稿未保存；保存前会检查格式。'); };
$('#btnPlanApplyJson').onclick = () => {
  try { fillPlanControls(planFromEditor()); planStatus('已按 JSON 更新选项；保存后才影响新会话。'); }
  catch (e) { planStatus('JSON 无效：' + e.message, true); }
};
$('#btnPlanAssess').onclick = async () => {
  const id = planProjectId, seq = planRequestSeq, draft = $('#planJson').value;
  let plan;
  try { plan = planFromEditor(); } catch (e) { planStatus('草稿检查失败：' + e.message, true); return; }
  const button = $('#btnPlanAssess'); button.disabled = true;
  try {
    const result = await api('/api/project/plan/assess', { project_id: id, plan });
    if (id !== planProjectId || seq !== planRequestSeq || !$('#dlgProjectPlan').open) return;
    if ($('#planJson').value !== draft) { planStatus('草稿已在检查期间更改，请重新检查。'); return; }
    renderPlanEffective($('#planEffective'), result.effective, plan.evidence?.claim_trace === 'required');
    planPreviewIsDraft = true;
    planStatus('已检查当前草稿；草稿仍未保存，当前会话也未改变。');
  } catch (e) { if (id === planProjectId && seq === planRequestSeq) planStatus('草稿检查失败：' + e.message, true); }
  finally { button.disabled = false; }
};
$('#btnPlanSave').onclick = async () => {
  const id = planProjectId;
  let plan;
  try { plan = planFromEditor(); } catch (e) { planStatus('保存失败：' + e.message, true); return; }
  const button = $('#btnPlanSave'); button.disabled = true;
  try {
    await api('/api/project/plan', { project_id: id, plan });
    planDrafts.delete(id);
    if (id === planProjectId) await loadProjectPlan(id);
  } catch (e) { if (id === planProjectId) planStatus('保存失败，草稿已保留：' + e.message, true); }
  finally { button.disabled = false; }
};
$('#btnPlanImport').onclick = () => $('#planImportFile').click();
$('#planImportFile').onchange = async () => {
  const file = $('#planImportFile').files?.[0], id = planProjectId;
  $('#planImportFile').value = '';
  if (!file || !id) return;
  try {
    const packaged = JSON.parse(await file.text());
    if (id !== planProjectId) return;
    await api('/api/project/plan/import', { project_id: id, package: packaged });
    planDrafts.delete(id);
    if (id === planProjectId) await loadProjectPlan(id);
  } catch (e) { if (id === planProjectId) planStatus('导入失败，现有草稿已保留：' + e.message, true); }
};
$('#btnPlanExport').onclick = async () => {
  const id = planProjectId;
  try {
    const packaged = await api('/api/project/plan/export?project_id=' + encodeURIComponent(id));
    if (id !== planProjectId) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(packaged, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${id}-xihe-plan.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    planStatus('已导出保存的项目方案、所选 Skill 与插件文件；未保存的草稿不在导出文件中。');
  } catch (e) { if (id === planProjectId) planStatus('导出失败：' + e.message, true); }
};
$('#btnPlanRoots').onclick = async () => {
  const id = planProjectId;
  const roots = $('#planLocalRoots').value.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  try {
    await api('/api/project/plan/roots', { project_id: id, roots });
    if (id === planProjectId) await loadProjectPlan(id);
  } catch (e) { if (id === planProjectId) planStatus('本机目录保存失败：' + e.message, true); }
};
// 本次会话技能覆盖：默认按赛事档案与模型选择，用户也可显式覆盖。
// 存在会话上，重开会话仍生效——用户想手动指定技能时走这条，不动自动加载的默认行为。
function fillSkillOverride() {
  const sel = $('#skillOverride');
  if (!sel) return;
  const cur = (state.session && state.session.skill_override) || '';
  const names = (skillsCache || []).map(s => s.name).sort();
  const mine = contestSkillRows();
  sel.innerHTML = ['<option value="">自动（先按赛事，再按模型适配）</option>',
    '<optgroup label="我的专属">', ...mine.map(m => `<option value="${esc(m.name)}" ${m.skill ? '' : 'disabled'}>${esc(m.name)} · ${m.label}${m.skill ? '' : '（未安装）'}</option>`), '</optgroup>',
    '<optgroup label="其他技能">', ...names.filter(n => !mine.some(m => m.name === n)).map(n => `<option value="${esc(n)}">${esc(n)}</option>`), '</optgroup>'].join('');
  sel.value = names.includes(cur) ? cur : '';
}
function contestSkillRows() {
  return ((state.boot && state.boot.contest_packages) || [])
    .filter(pkg => pkg.skill)
    .map(pkg => ({ key: pkg.id, name: pkg.skill, label: pkg.label,
      skill: (skillsCache || []).find(s => s.name === pkg.skill) }));
}
function renderMyCumcm() {
  const el = $('#myCumcmBody');
  if (!el) return;
  const loaded = state.session && state.session.skill_loaded && state.session.skill_loaded.name;
  el.innerHTML = contestSkillRows().map(m => `<div class="skillrow mycumcm${m.skill ? '' : ' missing'}" data-n="${esc(m.name)}">
    <b>${esc(m.name)}</b> <span class="mini">${m.label}${m.skill ? ` · ${esc(m.skill.tag)}${m.skill.version ? ' v' + esc(m.skill.version) : ''}` : ' · ⚠ 未安装，会回退到通用版'}</span>${loaded === m.name ? ' <span class="pill-on">本会话在用</span>' : ''}</div>`).join('');
  el.querySelectorAll('.skillrow:not(.missing)').forEach(r => r.onclick = () => showSkillPreview(r.dataset.n));
}
async function openSkills() {
  fillSkillOverride();
  renderMyCumcm();
  $('#dlgSkills').showModal();
  $('#skillPreview').style.display = 'none';
  $('#skQuality').style.display = 'none';
  renderSkillList('');
}
$('#skillOverride').addEventListener('change', async (e) => {
  if (!state.session) { alert('先打开一个会话再设置技能'); e.target.value = ''; return; }
  try {
    const r = await api('/api/session/skill', { id: state.session.id, skill: e.target.value });
    state.session.skill_override = r.skill_override;
    state.session.skill_loaded = r.skill_loaded;
    if (r.skill_plan_snapshot) state.session.skill_plan_snapshot = r.skill_plan_snapshot;
    $('#modeHint').textContent = modeHintOf(state.session);
  } catch (err) { alert('设置失败：' + err.message); fillSkillOverride(); }
});
function renderSkillList(filter) {
  const el = $('#skillListBody');
  const f = (filter || '').toLowerCase();
  el.innerHTML = skillsCache.filter(s => !f || s.name.toLowerCase().includes(f) || (s.description || '').toLowerCase().includes(f))
    .map(s => `<div class="skillrow" data-n="${esc(s.name)}"><b>${esc(s.name)}</b> <span class="mini">${esc(s.tag)}${s.version ? ' v' + s.version : ''}</span><div class="d">${esc((s.description || '').slice(0, 110))}</div></div>`).join('');
  el.querySelectorAll('.skillrow').forEach(r => r.onclick = () => showSkillPreview(r.dataset.n));
}

// 技能详情 + 两个动作按钮：
//  「让羲和读这个技能」= 往对话里发一句指令，模型会 skill_load 它（**调用一次**，用完即走）
//  「设为本次会话主技能」= 覆盖自动加载（换掉灌进 system 的那份正文，整场生效）
async function showSkillPreview(name) {
  // 质检面板独立于预览：main-only 技能无会话时预览会被适配门禁挡住，质检仍须可查。
  renderSkillQuality(name);
  const pv = await api('/api/skill/preview', { name, session_id: state.session?.id });
  const pre = $('#skillPreview');
  const actions = $('#skillActions');
  pre.style.display = 'block';
  pre.textContent = pv.content;
  pre.scrollTop = 0;
  if (!actions) return;
  const isMain = state.session && state.session.skill_override === name;
  actions.style.display = '';
  actions.innerHTML = `<span class="mini">${esc(name)}</span>
    <button id="skLoad" title="往对话里发一条指令，让羲和现在就 skill_load 读它（单次调用，不换主技能）">让羲和读这个技能</button>
    <button id="skMain" title="覆盖自动加载：把本次会话注入 system 的技能正文换成它（整场生效，可随时切回自动）" ${isMain ? 'disabled' : ''}>${isMain ? '已是主技能' : '设为本次会话主技能'}</button>`;
  $('#skLoad').onclick = async () => {
    if (!state.session) { alert('先打开一个会话'); return; }
    $('#dlgSkills').close();
    sendText(`请用 skill_load 读一下「${name}」技能，然后按它的规范继续当前工作（如果它不适用本题，说明原因后继续，不要勉强套用）。`);
  };
  $('#skMain').onclick = async () => {
    if (!state.session) { alert('先打开一个会话'); return; }
    try {
      const r = await api('/api/session/skill', { id: state.session.id, skill: name });
      state.session.skill_override = r.skill_override;
      state.session.skill_loaded = r.skill_loaded;
      if (r.skill_plan_snapshot) state.session.skill_plan_snapshot = r.skill_plan_snapshot;
      $('#modeHint').textContent = modeHintOf(state.session);
      fillSkillOverride();
      showSkillPreview(name);
    } catch (e) { alert('设置失败：' + e.message); }
  };
}

// 技能首检质检面板：结论 + 重检/跳过/生成修复副本。修复按钮点击即用户确认，
// 服务端只生成独立副本（-xihe-fixed），共享原件不动。
async function renderSkillQuality(name) {
  const box = $('#skQuality');
  if (!box) return;
  box.style.display = 'none';
  box.innerHTML = '';
  let q;
  try { q = await api('/api/skill/quality', { name, session_id: state.session?.id }); } catch { return; }
  box.style.display = '';
  if (!q.enabled) { box.textContent = '技能首检质检未启用（设置页可打开「技能首检质检」）。'; return; }
  const m = q.marker;
  const statusText = !q.sha256 ? '无法生成完整指纹，质检跳过'
    : !m ? '此版本尚未质检；skill_load 首次加载正文时自动首检'
    : m.status === 'declined' ? '已跳过此版本质检'
    : m.verdict?.status === 'ok' ? '质检通过'
    : m.verdict?.status === 'conflict' ? '质检发现严重问题' : '质检发现问题';
  const head = document.createElement('div');
  head.innerHTML = `<b>首检质检：${esc(statusText)}</b>` + (m && m.status !== 'declined' && m.model ? ` <span class="mini">${esc(m.model)} · ${esc(m.scope || '')}</span>` : '');
  box.appendChild(head);
  if (m && m.verdict && m.verdict.summary) {
    const sum = document.createElement('div');
    sum.textContent = m.verdict.summary;
    box.appendChild(sum);
  }
  if (m && m.verdict && m.verdict.issues && m.verdict.issues.length) {
    const list = document.createElement('div');
    list.textContent = m.verdict.issues.map((row, i) => `${i + 1}. [${row.severity}]${row.where ? ' ' + row.where : ''} ${row.problem}${row.fix ? ' → 修复建议：' + row.fix : ''}`).join('\n');
    box.appendChild(list);
  }
  const btnrow = document.createElement('div');
  btnrow.className = 'btnrow';
  btnrow.style.justifyContent = 'flex-start';
  const mk = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn; btnrow.appendChild(b); return b; };
  mk('重新质检', '忽略已有标记，强制重新质检此版本（消耗一次 LLM 调用）', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/skill/quality/recheck', { name, session_id: state.session?.id });
      if (r.status === 'error') alert('质检未完成：' + r.error);
    } catch (err) { alert('质检失败：' + err.message); }
    renderSkillQuality(name);
  });
  if (!m || m.status !== 'declined') mk('跳过质检', '标记跳过此版本质检；内容变化后视为新版本会重新首检', async () => {
    try { await api('/api/skill/quality/skip', { name, session_id: state.session?.id }); } catch (err) { alert('标记失败：' + err.message); }
    renderSkillQuality(name);
  });
  if (m && m.verdict && m.verdict.issues && m.verdict.issues.length) mk('生成修复副本', '确认后生成 -xihe-fixed 新技能到羲和私有技能库；原件不动', async (e) => {
    if (!confirm(`将按质检发现的 ${m.verdict.issues.length} 处问题生成修复副本（原件 ${name} 不动，副本可对比回退）。继续？`)) return;
    e.target.disabled = true;
    try {
      const r = await api('/api/skill/quality/repair', { name, session_id: state.session?.id });
      alert(`修复副本已生成：${r.name}（${r.mode === 'rewrite' ? '最小重写' : '批注覆盖：重写超输出预算，原文保留并以批注为准'}）。可在技能列表加载它。`);
    } catch (err) { alert('修复失败：' + err.message); }
    renderSkillQuality(name);
  });
  box.appendChild(btnrow);
}

// ---------- 初始化 ----------
function autoGrow() { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(180, i.scrollHeight) + 'px'; }
$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendText($('#input').value); } });
$('#btnSend').onclick = () => sendText($('#input').value);
$('#btnStop').onclick = () => state.session && api('/api/stop', { id: state.session.id });
$('#btnLocalTask').onclick = () => changeTaskFocus('local');
$('#btnReturnMain').onclick = () => changeTaskFocus('main');
$('#btnNewSession').onclick = async () => {
  await fillProjectPicker();
  $('#nsProjectName').value = '';
  $('#nsNewProjectRow').style.display = 'none';
  fillProjectContest();
  $('#dlgNew').showModal();
};
// 点项目分组头上的 ＋：同一个弹窗，只是先把项目钉在该项目上（模式还是用户自己挑）。
// 不直接建会话——建会话必须选模式，替用户猜模式不如让他点一下。
async function newSessionIn(pid) {
  await fillProjectPicker();
  const sel = $('#nsProject');
  // 项目已删/下拉里没有它时不要硬设 value：<select> 会静默保持原值，结果建到别的项目里去
  if (!Array.from(sel.options).some(o => o.value === pid)) { alert('这个项目已不在列表里（可能已删除），请刷新后再试'); return; }
  sel.value = pid;
  $('#nsProjectName').value = '';
  $('#nsNewProjectRow').style.display = 'none';
  fillProjectContest();
  $('#dlgNew').showModal();
}
$('#nsProject').addEventListener('change', (e) => {
  $('#nsNewProjectRow').style.display = e.target.value === '__new__' ? '' : 'none';
  if (e.target.value === '__new__') $('#nsProjectName').focus();
  fillProjectContest();
});
function fillProjectContest() {
  const sel = $('#nsContestKind');
  const profile = (state.projects || state.boot?.projects || []).find(p => p.id === $('#nsProject').value)?.contest_profile;
  sel.innerHTML = '<option value="">继承项目档案</option>' + (state.boot?.contest_packages || []).map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  sel.value = profile?.contest_kind || '';
  for (const [id, key] of [['nsEdition', 'edition'], ['nsStage', 'stage'], ['nsTrack', 'track'], ['nsControlNumber', 'control_number']]) {
    const value = profile?.identity?.[key];
    $('#' + id).value = value && value !== 'to-verify' && value !== 'unknown' ? value : '';
  }
  $('#nsTaskScope').value = 'solve';
  $('#nsContestHint').textContent = profile ? `项目档案第${profile.revision}版；修改后只影响以后创建的会话。` : '此项目尚无赛事档案，请明确选择；未知赛事使用通用流程。';
}
$('#btnCloseNew').onclick = () => $('#dlgNew').close();
// 点弹窗外的遮罩即关闭（<dialog> 默认只认 Esc）
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', (e) => {
  if (e.target !== d) return;
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
}));
$('#dlgIntro').addEventListener('close', () => {
  if (!document.querySelector('dialog[open]')) $('#input').focus();
});
$('#btnContest').onclick = () => { $('#ctPick').style.display = window.xihe && window.xihe.pickFolder ? '' : 'none'; $('#dlgContest').showModal(); };
$('#ctCancel').onclick = () => $('#dlgContest').close();
function fillContestKinds() {
  const sel = $('#ctContestKind');
  const selected = sel.value || 'auto';
  sel.innerHTML = '<option value="auto">按项目识别（不确定时使用通用流程）</option>'
    + ((state.boot && state.boot.contest_packages) || []).map(pkg => `<option value="${esc(pkg.id)}">${esc(pkg.label)}</option>`).join('');
  sel.value = [...sel.options].some(option => option.value === selected) ? selected : 'auto';
  const warning = $('#ctPackageWarnings');
  const diagnostics = (state.boot && state.boot.contest_package_diagnostics) || [];
  warning.hidden = diagnostics.length === 0;
  warning.innerHTML = diagnostics.length ? '⚠ 以下赛事包未加载：' + diagnostics.map(item => `${esc(item.id)}（${esc(item.error)}）`).join('；') : '';
}
$('#ctPick').onclick = async () => { const d = await window.xihe.pickFolder(); if (d) $('#ctDir').value = d; };
$('#ctGo').onclick = async () => {
  const dir = $('#ctDir').value.trim();
  if (!dir) { alert('请先填写题目文件夹'); return; }
  if (state.running) { alert('当前有会话在运行，请先停止'); return; }
  $('#ctGo').disabled = true;
  try {
    const r = await api('/api/contest/start', {
      sourceDir: dir, collab_mode: $('#ctMode').value, lang: $('#ctLang').value,
      hours: $('#ctHours').value, max_rounds: $('#ctRounds').value,
      effort: $('#ctEffort').value, contest_kind: $('#ctContestKind').value,
      deadline: $('#ctDeadline').value.trim(),
    });
    $('#dlgContest').close();
    state.session = r.session;
    renderHistory(r.session);
    $('#sessionTitle').textContent = titleOf(r.session);
    $('#modelPill').textContent = modelPillText(r.session);
    $('#modeHint').textContent = modeHintOf(r.session);
    renderCollab(r.session);
    renderEffort(r.session);
    renderContest(r.session);
    renderDeliverables(r.session);
    renderApproval(r.session);
    await refreshSessions();
    sendText(r.kickoff);
  } catch (e) { alert('开工失败：' + e.message); }
  finally { $('#ctGo').disabled = false; }
};
document.querySelectorAll('.mode-card').forEach(b => b.onclick = () => newSession(b.dataset.mode));
$('#btnSettings').onclick = (e) => openSettings(false, e.currentTarget);
$('#btnReasoningSettings').onclick = (e) => openSettings(true, e.currentTarget);
const openJudgeSettings = (e) => openSettings(false, e.currentTarget);
$('#judgePill').onclick = openJudgeSettings;
$('#judgePill').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openJudgeSettings(e); } };
$('#btnJobs').onclick = openJobsDialog;
$('#btnOpenJobs').onclick = openJobsDialog;
$('#btnCloseJobs').onclick = () => $('#dlgJobs').close();
$('#btnAckJobNotifications').onclick = () => acknowledgeJobNotifications((state.backgroundJobs.notifications || []).filter(n => !n.read).map(n => n.id));
$('#btnCloseSettings').onclick = () => $('#dlgSettings').close();
$('#btnSkills').onclick = openSkills;
$('#btnCloseSkills').onclick = () => $('#dlgSkills').close();
$('#skillFilter').addEventListener('input', (e) => renderSkillList(e.target.value));
// ---------- 模型选择器（全部提供商模型，按厂商分组） ----------
function buildModelMenu() {
  const wrap = document.createElement('div');
  wrap.id = 'modelMenu';
  wrap.style.display = 'none';
  const models = (state.boot && state.boot.models) || [];
  const rawCur = state.session ? (state.session.model || state.session.resolved_model || state.boot.settings.default_model) : (state.boot && state.boot.settings.default_model);
  const cur = String(rawCur || '').includes(':') ? rawCur : '';
  const byProvider = {};
  for (const m of models) (byProvider[m.providerName] = byProvider[m.providerName] || []).push(m);
  // DeepSeek 置顶，GLM 第二（个人使用优先级）
  const order = ['DeepSeek 官方', '智谱 GLM'];
  const names = [...order.filter(n => byProvider[n]), ...Object.keys(byProvider).filter(n => !order.includes(n))];
  for (const pname of names) {
    const h = document.createElement('div');
    h.className = 'mm-group';
    h.textContent = pname;
    wrap.appendChild(h);
    for (const m of byProvider[pname]) {
      const b = document.createElement('div');
      const qualified = m.provider + ':' + m.id;
      b.className = 'mm-item' + (qualified === cur || (!cur && m.id === rawCur) ? ' active' : '');
      // key 未配置的提供商：仍可选（先选后配），但视觉提示
      const hasKey = !state.boot.keys || state.boot.keys[m.provider] !== false;
      b.textContent = m.id + (hasKey ? '' : '（未配Key）');
      if (!hasKey) b.style.opacity = '0.55';
      b.onclick = async () => {
        wrap.style.display = 'none';
        if (!state.session) return;
        state.session.model = qualified;
        $('#modelPill').textContent = m.id;
        await api('/api/session/model', { id: state.session.id, model: qualified });
      };
      wrap.appendChild(b);
    }
  }
  document.body.appendChild(wrap);
  return wrap;
}
$('#modelPill').onclick = (e) => {
  e.stopPropagation();
  const old = $('#modelMenu');
  if (old) old.remove();
  const menu = buildModelMenu();
  const r = $('#modelPill').getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.display = 'block';
};
document.addEventListener('click', (e) => {
  const m = $('#modelMenu');
  if (m && !m.contains(e.target) && e.target !== $('#modelPill')) m.style.display = 'none';
});
document.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && e.target.src.includes('/api/file')) {
    const u = new URL(e.target.src);
    api('/api/open_file', { path: u.searchParams.get('path') || '' });
  }
});
// 对话内联产物 chip：左键用系统程序打开（像 codex 点产物），Alt/右键在资源管理器中定位
$('#chatStream').addEventListener('click', (e) => {
  const chip = e.target.closest && e.target.closest('code.artifact');
  if (!chip) return;
  const p = chip.dataset.artpath;
  if (!p) return;
  if (e.altKey) { api('/api/reveal', { path: p }).catch(err => alert('定位失败：' + err.message)); return; }
  api('/api/open_file', { path: p }).catch(err => alert('打开失败：' + err.message));
});
$('#chatStream').addEventListener('contextmenu', (e) => {
  const chip = e.target.closest && e.target.closest('code.artifact');
  if (!chip || !chip.dataset.artpath) return;
  e.preventDefault();
  api('/api/reveal', { path: chip.dataset.artpath }).catch(err => alert('定位失败：' + err.message));
});

(async function init() {
  // 启动只拉一次 bootstrap（原先 init 拉一次、refreshSessions 又拉一次 = 双倍等待）。
  // refreshSessions 允许复用传入的 bootstrap 结果。
  state.boot = await api('/api/bootstrap');
  fillContestKinds();
  renderJudgePill(state.boot.settings);
  skillsCache = state.boot.skills;
  await fillProjectSwitch();
  await refreshSessions(state.boot);
  startJobMonitor();
  const list = state.boot.sessions;
  if (list.length) await openSession(list[0].id);
  if (!document.querySelector('dialog[open]')) $('#input').focus();
})();
