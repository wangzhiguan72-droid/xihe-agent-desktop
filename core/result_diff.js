'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 10_000_000;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function readText(file) {
  if (!fs.statSync(file).isFile()) throw new Error('不是普通文件：' + file);
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('文件超过10MB：' + file);
  return fs.readFileSync(file, 'utf8');
}

function result(status, compared, n_big, lines, ignored, note) {
  const report = [...lines, `实际忽略项：${ignored.length ? ignored.join(', ') : '无'}`].join('\n');
  return { status, compared, n_big, report, ...(note ? { note } : {}) };
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text) throw new Error('CSV为空');
  const rows = [], row = [];
  let field = '', quoted = false, afterQuote = false, started = false;
  const endField = () => { row.push(field); field = ''; quoted = false; afterQuote = false; started = false; };
  const endRow = () => { endField(); rows.push(row.splice(0)); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else field += ch;
    } else if (afterQuote) {
      if (ch === ',') endField();
      else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
      else throw new Error('CSV引用字段结束后存在非法字符');
    } else if (ch === '"') {
      if (started) throw new Error('CSV引号位置无效');
      quoted = true; started = true;
    } else if (ch === ',') endField();
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else { field += ch; started = true; }
  }
  if (quoted) throw new Error('CSV引用字段未闭合');
  if (afterQuote || started || field || row.length) endRow();
  if (!rows.length || !rows[0].length || rows[0].every(x => !x)) throw new Error('CSV缺表头');
  const header = rows[0];
  if (header.some(x => !x)) throw new Error('CSV表头含空列名');
  if (new Set(header).size !== header.length) throw new Error('CSV表头重复');
  for (let i = 1; i < rows.length; i++) if (rows[i].length !== header.length) throw new Error(`CSV第${i + 1}行字段数不等于表头`);
  return rows;
}

function numeric(s) { return NUMBER.test(s) && Number.isFinite(Number(s)); }

function compareCsv(a, b, tol, ignore) {
  const A = parseCsv(readText(a)), B = parseCsv(readText(b));
  const headersA = A[0], headersB = B[0];
  const ignored = ignore.filter(name => headersA.includes(name) || headersB.includes(name));
  const lines = ['格式：CSV；逐行、同序表头比较；数字单元格用绝对容差'];
  let compared = 0, nBig = 0;
  const issue = message => { nBig++; if (lines.length < 60) lines.push(message); };
  if (headersA.length !== headersB.length || headersA.some((name, index) => name !== headersB[index])) issue('表头或列顺序不同');
  if (A.length !== B.length) issue(`数据行数不同：${A.length - 1} vs ${B.length - 1}`);
  const rows = Math.min(A.length, B.length) - 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < Math.min(A[i + 1].length, B[i + 1].length); j++) {
      if (headersA[j] !== headersB[j] || ignore.includes(headersA[j])) continue;
      const x = A[i + 1][j], y = B[i + 1][j];
      compared++;
      if (numeric(x) && numeric(y)) { if (Math.abs(Number(x) - Number(y)) > tol) issue(`第${i + 2}行 ${headersA[j]}：${x} vs ${y}`); }
      else if (x !== y) issue(`第${i + 2}行 ${headersA[j]}：${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    }
  }
  if (nBig) return result('diff', compared, nBig, lines, ignored);
  return result(compared ? 'same' : 'no_comparable', compared, nBig, lines, ignored,
    compared ? undefined : '没有可比较的数据单元格');
}

function compareJson(a, b, tol, ignore) {
  const A = JSON.parse(readText(a)), B = JSON.parse(readText(b));
  function requireFinite(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON含非有限数值');
    if (value && typeof value === 'object') for (const child of Object.values(value)) requireFinite(child);
  }
  requireFinite(A); requireFinite(B);
  const applied = new Set(), lines = ['格式：JSON；递归比较结构和值；数字用绝对容差'];
  let compared = 0, nBig = 0;
  const issue = message => { nBig++; if (lines.length < 60) lines.push(message); };
  function walk(x, y, at) {
    if (ignore.includes(at)) { applied.add(at); return; }
    const typeX = Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x;
    const typeY = Array.isArray(y) ? 'array' : y === null ? 'null' : typeof y;
    if (typeX !== typeY) { compared++; issue(`${at || '$'}：类型不同 ${typeX} vs ${typeY}`); return; }
    if (typeX === 'array') {
      if (x.length !== y.length) issue(`${at || '$'}：数组长度不同 ${x.length} vs ${y.length}`);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], at ? at + '.' + i : String(i));
    } else if (typeX === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const key of keys) {
        const next = at ? at + '.' + key : key;
        if (ignore.includes(next)) { applied.add(next); continue; }
        if (!own(x, key) || !own(y, key)) issue(`${next}：仅一侧存在`);
        else walk(x[key], y[key], next);
      }
    } else {
      compared++;
      if (typeX === 'number' ? Math.abs(x - y) > tol : x !== y) issue(`${at || '$'}：${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    }
  }
  walk(A, B, '');
  const ignored = [...applied];
  if (nBig) return result('diff', compared, nBig, lines, ignored);
  return result(compared ? 'same' : 'no_comparable', compared, nBig, lines, ignored,
    compared ? undefined : '没有可比较的值');
}

function xmlText(value) {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(lt|gt|quot|apos|amp);/gi, (all, numeric, named) => {
    if (numeric) return String.fromCodePoint(numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric));
    return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[named.toLowerCase()];
  });
}

function xmlAttrs(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) attrs[match[1]] = xmlText(match[3]);
  return attrs;
}

function xlsxGrid(file) {
  const { unzipEntries } = require('./xlsxDiff');
  const zip = fs.readFileSync(file);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 66000); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('XLSX ZIP中央目录缺失');
  const entriesCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16), expanded = 0;
  for (let i = 0; i < entriesCount; i++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('XLSX ZIP中央目录无效');
    expanded += zip.readUInt32LE(offset + 24);
    if (expanded > 100_000_000) throw new Error('XLSX解压内容超过100MB');
    offset += 46 + zip.readUInt16LE(offset + 28) + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  const entries = unzipEntries(zip);
  const total = [...entries.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  if (total > 100_000_000) throw new Error('XLSX解压内容超过100MB');
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  const relations = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !relations) throw new Error('XLSX缺工作簿或关系清单');
  const rels = new Map();
  for (const match of relations.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)) {
    const attrs = xmlAttrs(match[1]);
    if (attrs.Id && attrs.Target) rels.set(attrs.Id, attrs.Target);
  }
  const shared = [];
  const stringsXml = entries.get('xl/sharedstrings.xml')?.toString('utf8') || '';
  for (const match of stringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => xmlText(part[1])).join(''));
  }
  const grids = new Map();
  for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)) {
    const attrs = xmlAttrs(match[1]);
    const target = rels.get(attrs['r:id']);
    if (!attrs.name || !target || grids.has(attrs.name)) throw new Error('XLSX工作表名称或关系无效');
    const location = target.startsWith('/') ? target.slice(1) : path.posix.normalize('xl/' + target);
    const xml = entries.get(location.toLowerCase())?.toString('utf8');
    if (!xml) throw new Error('XLSX工作表缺失：' + attrs.name);
    const rows = new Map();
    let implicitRow = 1;
    for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowAttrs = xmlAttrs(rowMatch[1]);
      const rowNumber = rowAttrs.r ? Number(rowAttrs.r) : implicitRow;
      if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rows.has(rowNumber)) throw new Error('XLSX行坐标无效或重复');
      implicitRow = rowNumber + 1;
      const cells = new Map();
      let implicitCol = 1;
      for (const cellMatch of (rowMatch[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cellAttrs = xmlAttrs(cellMatch[1]);
        const ref = cellAttrs.r;
        let col = implicitCol;
        if (ref) {
          const coordinate = /^([A-Z]+)(\d+)$/.exec(ref);
          if (!coordinate || Number(coordinate[2]) !== rowNumber) throw new Error('XLSX单元格坐标无效');
          col = [...coordinate[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
        }
        if (!Number.isSafeInteger(col) || col < 1 || cells.has(col)) throw new Error('XLSX列坐标无效或重复');
        implicitCol = col + 1;
        const inner = cellMatch[2] || '';
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        const kind = cellAttrs.t || 'n';
        let cell;
        if (kind === 's') {
          const index = Number(raw);
          if (!Number.isSafeInteger(index) || !Object.prototype.hasOwnProperty.call(shared, index)) throw new Error('XLSX共享字符串索引无效');
          cell = { type: 'string', value: shared[index] };
        } else if (kind === 'inlineStr') {
          cell = { type: 'string', value: [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => xmlText(part[1])).join('') };
        } else if (kind === 'str' || kind === 'd' || kind === 'e') {
          cell = { type: kind === 'str' ? 'string' : kind, value: raw == null ? '' : xmlText(raw) };
        } else if (kind === 'b') {
          if (raw !== '0' && raw !== '1') throw new Error('XLSX布尔单元格无效');
          cell = { type: 'boolean', value: raw === '1' };
        } else if (kind === 'n' && raw != null && raw !== '') {
          const value = Number(raw);
          if (!Number.isFinite(value)) throw new Error('XLSX非有限数值');
          cell = { type: 'number', value };
        } else if (kind === 'n') cell = { type: 'blank', value: null };
        else throw new Error('XLSX单元格类型不受支持：' + kind);
        if (formula != null) cell.formula = xmlText(formula);
        cells.set(col, cell);
      }
      rows.set(rowNumber, cells);
    }
    grids.set(attrs.name, rows);
  }
  if (!grids.size) throw new Error('XLSX没有可解析的工作表');
  return grids;
}

function compareXlsx(a, b, tol) {
  const A = xlsxGrid(a), B = xlsxGrid(b);
  const lines = ['格式：XLSX；按工作表及绝对行列位置逐格比较；数字用绝对容差'];
  let compared = 0, nBig = 0;
  const issue = message => { nBig++; if (lines.length < 60) lines.push(message); };
  for (const sheet of new Set([...A.keys(), ...B.keys()])) {
    const left = A.get(sheet), right = B.get(sheet);
    if (!left || !right) { issue(`工作表 ${sheet} 仅一侧存在`); continue; }
    for (const row of new Set([...left.keys(), ...right.keys()])) {
      const lrow = left.get(row), rrow = right.get(row);
      if (!lrow || !rrow) { issue(`${sheet} 第${row}行仅一侧存在`); continue; }
      for (const col of new Set([...lrow.keys(), ...rrow.keys()])) {
        const x = lrow.get(col), y = rrow.get(col);
        if (!x || !y) { issue(`${sheet} 第${row}行第${col}列仅一侧存在`); continue; }
        if (x.type !== 'blank' || y.type !== 'blank' || x.formula != null || y.formula != null) compared++;
        if (x.type !== y.type || x.formula !== y.formula || (x.type === 'number' ? Math.abs(x.value - y.value) > tol : x.value !== y.value))
          issue(`${sheet} 第${row}行第${col}列：${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
      }
    }
  }
  if (nBig) return result('diff', compared, nBig, lines, []);
  return result(compared ? 'same' : 'no_comparable', compared, nBig, lines, [],
    compared ? undefined : '没有可比较的单元格');
}

function compareResults(aPath, bPath, { tol = 1e-6, ignore_fields = [] } = {}) {
  if (typeof tol !== 'number' || !Number.isFinite(tol) || tol < 0) throw new Error('tol 容差须为有限非负数');
  if (!Array.isArray(ignore_fields) || ignore_fields.some(x => typeof x !== 'string' || !x || x.length > 500) || new Set(ignore_fields).size !== ignore_fields.length)
    throw new Error('ignore_fields 须为不重复的字段名数组');
  const extA = path.extname(aPath).toLowerCase(), extB = path.extname(bPath).toLowerCase();
  if (extA !== extB || !['.json', '.csv', '.xlsx'].includes(extA)) return result('unsupported', 0, 0, ['文件格式不一致或不受支持'], [], '仅支持同格式 JSON、CSV、XLSX');
  if (extA === '.xlsx' && ignore_fields.length) return result('unsupported', 0, 0, ['XLSX暂不支持按字段忽略'], [], 'XLSX忽略字段不受支持');
  try {
    for (const file of [aPath, bPath]) { if (!fs.statSync(file).isFile() || fs.statSync(file).size > MAX_BYTES) throw new Error('文件缺失、非普通文件或超过10MB：' + file); }
    if (extA === '.json') return compareJson(aPath, bPath, tol, ignore_fields);
    if (extA === '.csv') return compareCsv(aPath, bPath, tol, ignore_fields);
    return compareXlsx(aPath, bPath, tol);
  } catch (error) { return result('read_error', 0, 0, ['读取或解析失败：' + error.message], [], error.message); }
}

module.exports = { compareResults };
