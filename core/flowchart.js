// 建模流程图：简洁 JSON 规格 → draw.io 源文件（可在 draw.io 桌面版再编辑）→ PDF/PNG。
// 版式沿用用户国赛论文每问「建模思路」下的流程图：顶部标题条 + 左列阶段 + 每行 1-3 个节点，箭头串联。
// 字少是硬要求（评委 3 秒看懂思路链）：每节点 ≤2 行、每行 ≤12 字，超了直接报错让模型精简。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const THEMES = {
  blue:   { bg: '#EEF4FB', stroke: '#6C8EBF', fill: '#DAE8FC', head: '#C5D9F1' },
  green:  { bg: '#F1F8EE', stroke: '#82B366', fill: '#D5E8D4', head: '#BFDDB5' },
  orange: { bg: '#FDF5EC', stroke: '#D79B00', fill: '#FFE6CC', head: '#FAD7AC' },
  purple: { bg: '#F5F1FA', stroke: '#9673A6', fill: '#E1D5E7', head: '#D0BFDB' },
  gray:   { bg: '#F5F5F5', stroke: '#666666', fill: '#EEEEEE', head: '#DDDDDD' },
};
const MAX_ROWS = 6, MAX_BOXES = 3, MAX_LINES = 2, MAX_CHARS = 12; // 12 字：插入正文按版心缩放后仍 ≥7pt（v2.4 实测 16 字/13px 印出来约 6pt）

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 中文按 1、ASCII 按 0.5 计宽
const width = (s) => [...String(s)].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : 0.5), 0);

// overview 版式（F-6 总体技术路线图）：横向 4 列（对应各问/各阶段）+ 顶部数据条 + 底部结论条。
// 放在「问题分析」末尾，表达全文信息流与因果链，不是流程堆砌（节点 ≤7、单一主方向）。
const OV_MAX_COLS = 5, OV_MAX_ITEMS = 4;
function validateOverview(spec) {
  const errs = [];
  if (!spec.title) errs.push('缺 title（如"本文总体技术路线"）');
  const cols = Array.isArray(spec.columns) ? spec.columns : [];
  if (!cols.length) errs.push('columns 为空（每列一个问题/阶段）');
  if (cols.length > OV_MAX_COLS) errs.push(`columns ${cols.length} 列 > ${OV_MAX_COLS}`);
  cols.forEach((c, i) => {
    if (!c || !c.head) errs.push(`columns[${i}] 缺 head（列标题，如"问题一 价格预测"）`);
    else if (width(c.head) > 10) errs.push(`columns[${i}].head「${c.head}」超 10 字`);
    const items = Array.isArray(c && c.items) ? c.items : [];
    if (!items.length) errs.push(`columns[${i}] 缺 items`);
    if (items.length > OV_MAX_ITEMS) errs.push(`columns[${i}] ${items.length} 条 > ${OV_MAX_ITEMS}`);
    items.forEach((t, j) => {
      if (width(t) > 14) errs.push(`columns[${i}].items[${j}]「${t}」超 14 字`);
    });
  });
  if (spec.top && width(spec.top) > 34) errs.push('top 条超 34 字');
  if (spec.bottom && width(spec.bottom) > 34) errs.push('bottom 条超 34 字');
  return errs;
}

function toDrawioOverview(spec) {
  const th = THEMES[spec.color] || THEMES.blue;
  const cols = spec.columns;
  const W = 900, PAD = 18, TITLE_H = 44, BAR_H = 38, COL_TOP = 118, COL_H = 250;
  const H = COL_TOP + COL_H + (spec.bottom ? BAR_H + 34 : 0) + PAD + 6;
  const gap = 16;
  const colW = Math.floor((W - 2 * PAD - gap * (cols.length - 1)) / cols.length);
  const cells = [];
  let id = 2;
  const font = 'fontFamily=Microsoft YaHei;';
  const add = (value, style, x, y, w, h) => {
    const cid = 'n' + (id++);
    cells.push(`<mxCell id="${cid}" value="${xmlEsc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
    return cid;
  };
  const edge = (s, t) => {
    cells.push(`<mxCell id="e${id++}" style="endArrow=block;endFill=1;html=1;strokeColor=${th.stroke};strokeWidth=1.5;" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  };
  add('', `rounded=1;arcSize=4;whiteSpace=wrap;html=1;fillColor=${th.bg};strokeColor=${th.stroke};`, 0, 0, W, H);
  add(`<b>${htmlEsc(spec.title)}</b>`, `rounded=1;arcSize=30;whiteSpace=wrap;html=1;${font}fontSize=20;fillColor=${th.head};strokeColor=${th.stroke};`, PAD + 120, PAD, W - 2 * (PAD + 120), TITLE_H);
  let prevTop = null;
  if (spec.top) {
    prevTop = add(`<b>${htmlEsc(spec.top)}</b>`, `rounded=1;whiteSpace=wrap;html=1;${font}fontSize=16;fillColor=#FFFFFF;strokeColor=${th.stroke};`, PAD, PAD + TITLE_H + 12, W - 2 * PAD, BAR_H);
  }
  let prevCol = prevTop;
  cols.forEach((c, i) => {
    const x = PAD + i * (colW + gap);
    const head = add(`<b>${htmlEsc(c.head)}</b>`, `rounded=1;whiteSpace=wrap;html=1;${font}fontSize=16;fillColor=${th.head};strokeColor=${th.stroke};`, x, COL_TOP, colW, 38);
    if (prevCol) edge(prevCol, head); else if (prevTop) edge(prevTop, head);
    prevCol = head;
    const itemW = Math.floor((colW - 10) / 2);
    const itemH = Math.floor((COL_H - 48 - 14) / 2);
    c.items.forEach((t, j) => {
      const ix = x + 4 + (j % 2) * (itemW + 2);
      const iy = COL_TOP + 46 + Math.floor(j / 2) * (itemH + 8);
      const bid = add(`<b>${htmlEsc(t)}</b>`, `rounded=1;whiteSpace=wrap;html=1;${font}fontSize=14;fillColor=#FFFFFF;strokeColor=${th.stroke};`, ix, iy, itemW, itemH);
      if (j === 0) edge(head, bid); else edge(prevCol, bid);
      prevCol = bid;
    });
  });
  if (spec.bottom) {
    add(`<b>${htmlEsc(spec.bottom)}</b>`, `rounded=1;whiteSpace=wrap;html=1;${font}fontSize=16;fillColor=${th.head};strokeColor=${th.stroke};`, PAD, COL_TOP + COL_H + 20, W - 2 * PAD, BAR_H);
  }
  return `<mxfile host="xihe-agent"><diagram name="${xmlEsc(spec.name || 'overview')}"><mxGraphModel dx="0" dy="0" grid="0" gridSize="10" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

function validate(spec) {
  const errs = [];
  if (!spec || typeof spec !== 'object') return ['spec 必须是对象'];
  // overview 版式走独立校验（横向列 + 顶/底条）
  if (spec.layout === 'overview' || Array.isArray(spec.columns)) return validateOverview(spec);
  if (!spec.title) errs.push('缺 title（如"问题一：××模型的建立与求解"）');
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  if (!rows.length) errs.push('rows 为空');
  if (rows.length > MAX_ROWS) errs.push(`rows ${rows.length} 行 > ${MAX_ROWS}，请合并阶段`);
  rows.forEach((r, i) => {
    if (!r || !r.stage) errs.push(`rows[${i}] 缺 stage（阶段名，如"模型建立"）`);
    else if (width(r.stage) > 8) errs.push(`rows[${i}].stage「${r.stage}」超 8 字`);
    const boxes = Array.isArray(r && r.boxes) ? r.boxes : [];
    if (!boxes.length) errs.push(`rows[${i}] 缺 boxes`);
    if (boxes.length > MAX_BOXES) errs.push(`rows[${i}] ${boxes.length} 个节点 > ${MAX_BOXES}`);
    boxes.forEach((b, j) => {
      const lines = String(b).split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) errs.push(`rows[${i}].boxes[${j}] ${lines.length} 行 > ${MAX_LINES}（第一行=关键词，第二行=关键结果/方法）`);
      lines.forEach(l => { if (width(l) > MAX_CHARS) errs.push(`rows[${i}].boxes[${j}]「${l}」超 ${MAX_CHARS} 字，请压缩`); });
    });
  });
  if (spec.footer && width(spec.footer) > 40) errs.push('footer 超 40 字');
  return errs;
}

function toDrawio(spec) {
  if (spec.layout === 'overview' || (!Array.isArray(spec.rows) && Array.isArray(spec.columns))) return toDrawioOverview(spec);
  const th = THEMES[spec.color] || THEMES.blue;
  const rows = spec.rows;
  const W = 900, PAD = 18, TITLE_H = 46, ROW_H = 80, BOX_H = 60, STAGE_W = 120, GAP = 30;
  const nMax = Math.max(...rows.map(r => r.boxes.length));
  const boxX0 = PAD + STAGE_W + GAP + 10;
  const boxW = Math.floor((W - PAD - boxX0 - GAP * (nMax - 1)) / nMax);
  const footerH = spec.footer ? 44 : 0;
  const H = PAD + TITLE_H + 18 + rows.length * ROW_H + footerH + PAD;
  const cells = [];
  let id = 2;
  const font = 'fontFamily=Microsoft YaHei;';
  const add = (value, style, x, y, w, h) => {
    const cid = 'n' + (id++);
    cells.push(`<mxCell id="${cid}" value="${xmlEsc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
    return cid;
  };
  const edge = (s, t) => {
    cells.push(`<mxCell id="e${id++}" style="endArrow=block;endFill=1;html=1;strokeColor=${th.stroke};strokeWidth=1.5;" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  };
  add('', `rounded=1;arcSize=4;whiteSpace=wrap;html=1;fillColor=${th.bg};strokeColor=${th.stroke};`, 0, 0, W, H);
  add(`<b>${htmlEsc(spec.title)}</b>`, `rounded=1;arcSize=30;whiteSpace=wrap;html=1;${font}fontSize=20;fillColor=${th.head};strokeColor=${th.stroke};`, PAD + 120, PAD, W - 2 * (PAD + 120), TITLE_H);
  let prevStage = null;
  rows.forEach((r, i) => {
    const y = PAD + TITLE_H + 18 + i * ROW_H + (ROW_H - BOX_H) / 2;
    const st = add(`<b>${htmlEsc(r.stage)}</b>`, `rounded=1;whiteSpace=wrap;html=1;${font}fontSize=17;fillColor=${th.head};strokeColor=${th.stroke};`, PAD, y, STAGE_W, BOX_H);
    if (prevStage) edge(prevStage, st);
    prevStage = st;
    let prev = st;
    r.boxes.forEach((b, j) => {
      const [head, ...rest] = String(b).split('\n').filter(Boolean);
      const label = `<b>${htmlEsc(head)}</b>` + (rest.length ? `<br><font style="font-size:14px">${htmlEsc(rest.join(' '))}</font>` : '');
      const x = boxX0 + j * (boxW + GAP);
      const bid = add(label, `rounded=1;whiteSpace=wrap;html=1;${font}fontSize=16;fillColor=${j === r.boxes.length - 1 && r.highlight ? th.head : '#FFFFFF'};strokeColor=${th.stroke};`, x, y, boxW, BOX_H);
      edge(prev, bid);
      prev = bid;
    });
  });
  if (spec.footer) {
    add(`<b>${htmlEsc(spec.footer)}</b>`, `rounded=1;whiteSpace=wrap;html=1;${font}fontSize=16;fillColor=${th.head};strokeColor=${th.stroke};`, PAD, H - PAD - 36, W - 2 * PAD, 36);
  }
  return `<mxfile host="xihe-agent"><diagram name="${xmlEsc(spec.name || 'flow')}"><mxGraphModel dx="0" dy="0" grid="0" gridSize="10" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

function findDrawio(settings) {
  const cands = [
    settings && settings.drawio_path,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'draw.io', 'draw.io.exe'),
    'C:\\Program Files\\draw.io\\draw.io.exe',
    'C:\\Program Files (x86)\\draw.io\\draw.io.exe',
  ].filter(Boolean);
  return cands.find(p => fs.existsSync(p)) || null;
}

// draw.io 桌面版 CLI 导出（固定 argv，不经 shell）
function exportDrawio(exe, src, out, fmt, timeoutMs = 90000) {
  const args = ['-x', '-f', fmt, '-o', out];
  if (fmt === 'pdf') args.push('--crop');
  if (fmt === 'png') args.push('-s', '2');
  args.push(src);
  return new Promise((resolve) => {
    let err = '';
    const child = spawn(exe, args, { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, err: '导出超时' }); }, timeoutMs);
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, err: String(e) }); });
    child.on('close', () => { clearTimeout(timer); resolve({ ok: fs.existsSync(out) && fs.statSync(out).size > 0, err: err.slice(-400) }); });
  });
}

module.exports = { validate, toDrawio, toDrawioOverview, validateOverview, findDrawio, exportDrawio, THEMES };
