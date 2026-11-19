// 所有项目使用统计。与右侧「本会话用量」独立，数据只取持久化的模型调用明细。
(() => {
  'use strict';

  const periods = { week: '本周', month: '本月', all: '累计' };
  const colors = ['#f5b942', '#5b9dff', '#4fc38a', '#ad80e7', '#ed8563', '#4bc4c5', '#d778aa'];
  const number = new Intl.NumberFormat('zh-CN');
  let period = 'week';
  let requestId = 0;
  let dialog;

  function safeCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function formatCount(value) {
    const n = safeCount(value);
    if (n >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 1 : 2).replace(/\.?0+$/, '')} 亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 1 : 2).replace(/\.?0+$/, '')} 万`;
    return number.format(Math.round(n));
  }

  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = String(content);
    return el;
  }

  function setStatus(message, kind = '') {
    const el = dialog.querySelector('#usageStatus');
    el.textContent = message;
    el.dataset.kind = kind;
  }

  function makeDialog() {
    dialog = document.createElement('dialog');
    dialog.id = 'dlgUsage';
    dialog.setAttribute('aria-labelledby', 'usageTitle');
    dialog.setAttribute('aria-describedby', 'usageScope');
    dialog.innerHTML = `
      <div class="usage-head">
        <div><p class="usage-eyebrow">XIHE · ALL PROJECTS</p><h2 id="usageTitle">使用统计</h2>
          <p id="usageScope">所有项目 · 模型调用明细</p></div>
        <div class="usage-actions"><button type="button" id="usageRefresh" class="ghost" title="重新读取统计">↻ 刷新</button>
          <button type="button" id="usageClose" class="ghost" aria-label="关闭使用统计">✕</button></div>
      </div>
      <div id="usageStatus" class="usage-status" role="status" aria-live="polite"></div>
      <div id="usageSummary" class="usage-summary" aria-label="所有项目 Token 汇总"></div>
      <p id="usageCoverage" class="usage-coverage" hidden></p>
      <div class="usage-section-head"><h3>Token 活动</h3>
        <div class="usage-switch" role="group" aria-label="统计时间范围">
          <button type="button" data-usage-period="week" aria-pressed="true">本周</button>
          <button type="button" data-usage-period="month" aria-pressed="false">本月</button>
          <button type="button" data-usage-period="all" aria-pressed="false">累计</button>
        </div></div>
      <div class="usage-grid">
        <section class="usage-panel usage-trend-panel" aria-labelledby="usageTrendTitle"><h4 id="usageTrendTitle">每日 Token 趋势</h4>
          <div id="usageTrend" class="usage-trend"></div></section>
        <section class="usage-panel" aria-labelledby="usageModelsTitle"><h4 id="usageModelsTitle">模型用量</h4>
          <div id="usageModels" class="usage-models"></div></section>
        <section class="usage-panel usage-project-panel" aria-labelledby="usageProjectsTitle"><h4 id="usageProjectsTitle">项目排行</h4>
          <div id="usageProjects" class="usage-projects"></div></section>
      </div>
      <p class="usage-note">统计基于已保存调用明细，包含主调用、子代理、压缩等；归档或删除会话不减历史明细。Token 为输入加输出，缓存命中已包含在输入中，不重复累计。右侧数字仅对应当前会话。</p>`;
    document.body.appendChild(dialog);
    dialog.querySelector('#usageClose').addEventListener('click', () => dialog.close());
    dialog.querySelector('#usageRefresh').addEventListener('click', load);
    dialog.querySelectorAll('[data-usage-period]').forEach(button => button.addEventListener('click', () => {
      period = button.dataset.usagePeriod;
      dialog.querySelectorAll('[data-usage-period]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      load();
    }));
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => { if (!dialog.open) requestId++; });
    return dialog;
  }

  function renderSummary(totals) {
    const container = dialog.querySelector('#usageSummary');
    container.replaceChildren();
    for (const [key, label] of Object.entries(periods)) {
      const value = totals && totals[key] || {};
      const card = node('div', 'usage-summary-card');
      card.append(node('span', 'usage-card-label', label), node('strong', '', formatCount(value.tokens)),
        node('span', 'usage-card-unit', `Token · ${formatCount(value.calls)} 次调用`));
      container.append(card);
    }
  }

  function renderTrend(rows) {
    const container = dialog.querySelector('#usageTrend');
    container.replaceChildren();
    const data = Array.isArray(rows) ? rows.filter(row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.day)) : [];
    if (!data.length || data.every(row => safeCount(row.tokens) === 0)) {
      container.append(node('p', 'usage-empty', '此范围暂无每日用量')); return;
    }
    const values = data.map(row => safeCount(row.tokens));
    const max = values.reduce((largest, value) => Math.max(largest, value), 1);
    const width = 640, height = 176, left = 18, right = 622, top = 15, bottom = 145;
    const points = values.map((value, i) => {
      const x = left + (data.length === 1 ? (right - left) / 2 : (right - left) * i / (data.length - 1));
      return [x, bottom - (bottom - top) * value / max];
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `每日 Token 趋势，${data[0].day} 至 ${data[data.length - 1].day}，最高 ${formatCount(max)}`);
    svg.classList.add('usage-chart');
    for (let i = 0; i < 3; i++) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const y = top + i * (bottom - top) / 2;
      line.setAttribute('x1', left); line.setAttribute('x2', right);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('class', 'usage-gridline'); svg.append(line);
    }
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('points', `${left},${bottom} ${points.map(p => p.join(',')).join(' ')} ${right},${bottom}`);
    area.setAttribute('class', 'usage-chart-area'); svg.append(area);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points.map(p => p.join(',')).join(' '));
    line.setAttribute('class', 'usage-chart-line'); svg.append(line);
    if (points.length <= 32) points.forEach(([x, y], i) => {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 3);
      dot.setAttribute('class', 'usage-chart-dot');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${data[i].day}：${formatCount(values[i])} Token`;
      dot.append(title); svg.append(dot);
    });
    container.append(svg);
    const axis = node('div', 'usage-axis');
    axis.append(node('span', '', data[0].day.slice(5)), node('span', '', `峰值 ${formatCount(max)}`),
      node('span', '', data[data.length - 1].day.slice(5)));
    container.append(axis);
  }

  function renderModels(rows) {
    const container = dialog.querySelector('#usageModels');
    container.replaceChildren();
    const data = Array.isArray(rows) ? rows.filter(row => row && safeCount(row.tokens) > 0) : [];
    if (!data.length) { container.append(node('p', 'usage-empty', '此范围暂无模型用量')); return; }
    const total = data.reduce((sum, row) => sum + safeCount(row.tokens), 0);
    const chart = node('div', 'usage-donut');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', '模型 Token 用量占比');
    let cursor = 0;
    const stops = data.map((row, i) => {
      const next = cursor + safeCount(row.tokens) / total * 100;
      const stop = `${colors[i % colors.length]} ${cursor}% ${next}%`;
      cursor = next; return stop;
    });
    chart.style.background = `conic-gradient(${stops.join(', ')})`;
    const core = node('div', 'usage-donut-core');
    core.append(node('strong', '', formatCount(total)), node('span', '', 'Token'));
    chart.append(core);
    const list = node('div', 'usage-model-list');
    data.forEach((row, i) => {
      const item = node('div', 'usage-model-row');
      const swatch = node('i', 'usage-swatch'); swatch.style.background = colors[i % colors.length];
      item.append(swatch, node('span', 'usage-model-name', row.model || '未知模型'),
        node('span', 'usage-model-value', `${formatCount(row.tokens)} · ${Math.round(safeCount(row.tokens) / total * 100)}%`));
      list.append(item);
    });
    container.append(chart, list);
  }

  function renderProjects(rows) {
    const container = dialog.querySelector('#usageProjects');
    container.replaceChildren();
    const data = Array.isArray(rows) ? rows.filter(row => row && safeCount(row.tokens) > 0) : [];
    if (!data.length) { container.append(node('p', 'usage-empty', '此范围暂无项目用量')); return; }
    const max = data.reduce((largest, row) => Math.max(largest, safeCount(row.tokens)), 1);
    data.forEach((row, i) => {
      const item = node('div', 'usage-project-row');
      const heading = node('div', 'usage-project-heading');
      heading.append(node('span', 'usage-project-name', `${i + 1}. ${row.title || row.project_id || '未命名项目'}`),
        node('strong', '', formatCount(row.tokens)));
      const track = node('div', 'usage-project-track');
      const fill = node('div', 'usage-project-fill');
      fill.style.width = `${Math.max(2, safeCount(row.tokens) / max * 100)}%`;
      track.append(fill);
      item.append(heading, track, node('span', 'usage-project-calls', `${formatCount(row.calls)} 次调用`));
      container.append(item);
    });
  }

  async function load() {
    const current = ++requestId;
    const range = period;
    setStatus(`正在读取${periods[range]}统计…`, 'loading');
    dialog.querySelector('#usageRefresh').disabled = true;
    try {
      const data = await api(`/api/usage/stats?period=${range}`);
      if (current !== requestId || !dialog.open) return;
      if (!data || data.period !== range) throw new Error('统计范围与请求不一致');
      renderSummary(data.totals);
      const coverage = data.coverage || {};
      const coverageNote = dialog.querySelector('#usageCoverage');
      coverageNote.hidden = !coverage.legacy_tokens;
      coverageNote.textContent = coverage.legacy_tokens
        ? `累计包含 ${formatCount(coverage.legacy_tokens)} Token 未分期历史（${formatCount(coverage.legacy_sessions)} 个历史会话）；历史缺少逐次调用日期与模型分项，本周、本月及每日趋势仅统计已记录的调用明细。`
        : '';
      renderTrend(data.trend);
      renderModels(data.byModel);
      renderProjects(data.byProject);
      const stamp = data.asOf ? ` · 更新于 ${new Date(data.asOf).toLocaleString('zh-CN')}` : '';
      setStatus(`${periods[range]} · 所有项目${stamp}`);
    } catch (error) {
      if (current !== requestId || !dialog.open) return;
      dialog.querySelector('#usageCoverage').hidden = true;
      setStatus(`读取失败：${error.message || '未知错误'}。可点击刷新重试。`, 'error');
      for (const id of ['usageSummary', 'usageTrend', 'usageModels', 'usageProjects'])
        dialog.querySelector(`#${id}`).replaceChildren(node('p', 'usage-empty', '暂无可显示的统计'));
    } finally {
      if (current === requestId) dialog.querySelector('#usageRefresh').disabled = false;
    }
  }

  window.openUsageStats = () => {
    if (!dialog) makeDialog();
    if (!dialog.open) dialog.showModal();
    return load();
  };
  document.querySelector('#btnUsage')?.addEventListener('click', window.openUsageStats);
})();
