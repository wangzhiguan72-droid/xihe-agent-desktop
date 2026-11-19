// xlsxDiff.js — 纯 Node 实现的 xlsx 工作簿逐格数值比对（应用层复审/A 题跑通教训落地）
// 场景：同一方程不同实现/不同约定跑出的 result*.xlsx 互相比对（如 Landau 含对流 vs 物质坐标）；
//       或 agent 产出 vs 参考解/上一版结果回归对比。
// 不依赖第三方库：Node 自带 zlib 解 zip，sheet XML 用正则解（xlsx 是受限格式，够用）。
// 比对口径：按 (t, r) 行列坐标对齐——第 1 列是行键（时间/序号），表头是列键（距离/变量名）。
//           共同键上的数值格逐格比 |a-b|；空串/非数值格跳过。两侧各自独有的行列单独列出。

const fs = require('fs');
const zlib = require('zlib');

// ---------- 最小 zip 读取：返回 { 文件名(小写,正斜杠): Buffer } ----------
function unzipEntries(buf) {
  const out = new Map();
  // 扫 EOCD 定位中央目录
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip/xlsx 文件（找不到 EOCD）');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cd + 10);
    const csize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const cmtLen = buf.readUInt16LE(cd + 32);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.slice(cd + 46, cd + 46 + nameLen).toString('utf8');
    // 本地头里的 nameLen/extraLen 可能与中央目录不同，必须重读
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else continue; // 其他压缩方式跳过
    out.set(name.replace(/\\/g, '/').toLowerCase(), data);
    cd += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function colToIdx(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- 解析一个 sheet XML 为 rows: Array<Array<string|number|null>> ----------
function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const cellsXml = m[1];
    const row = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(cellsXml))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const rM = attrs.match(/\br="([A-Z]+)\d+"/);
      const ci = rM ? colToIdx(rM[1]) : row.length;
      const tM = attrs.match(/\bt="([^"]+)"/);
      const type = tM ? tM[1] : 'n';
      let val = null;
      const vM = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      const isM = inner.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      if (type === 's' && vM) {
        val = sharedStrings[Number(vM[1])] || '';
      } else if (type === 'inlineStr' && isM) {
        val = isM[1];
      } else if (type === 'str' && vM) {
        val = vM[1];
      } else if (vM) {
        const f = Number(vM[1]);
        val = Number.isFinite(f) ? f : vM[1];
      }
      row[ci] = val;
    }
    rows.push(row);
  }
  return rows;
}

function xmlUnesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

// ---------- 读工作簿：{ sheetName -> rows } ----------
function readXlsx(absPath) {
  const entries = unzipEntries(fs.readFileSync(absPath));
  // sharedStrings
  const sharedStrings = [];
  const ssXml = entries.get('xl/sharedstrings.xml');
  if (ssXml) {
    const s = ssXml.toString('utf8');
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(s))) {
      // <si> 内可能多段 <t>（富文本），拼接
      const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]);
      sharedStrings.push(xmlUnesc(parts.join('')));
    }
  }
  // workbook: sheet 名 -> rId
  const wbXml = (entries.get('xl/workbook.xml') || Buffer.from('')).toString('utf8');
  const relsXml = (entries.get('xl/_rels/workbook.xml.rels') || Buffer.from('')).toString('utf8');
  const ridToTarget = new Map();
  const relRe = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) ridToTarget.set(rm[1], rm[2]);
  const sheets = new Map(); // name -> xmlPath
  const shRe = /<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/?>/g;
  while ((rm = shRe.exec(wbXml))) {
    const target = ridToTarget.get(rm[2]);
    if (target) sheets.set(xmlUnesc(rm[1]), 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, 'xl/'));
  }
  // 兜底：workbook.xml 解析失败时按 sheet1..N 顺序
  if (!sheets.size) {
    for (const k of entries.keys()) {
      const mm = k.match(/^xl\/worksheets\/(sheet\d+)\.xml$/);
      if (mm) sheets.set(mm[1], k);
    }
  }
  const out = new Map();
  for (const [name, p] of sheets) {
    const data = entries.get(p) || entries.get(p.toLowerCase());
    if (data) out.set(name, parseSheet(data.toString('utf8'), sharedStrings));
  }
  return out;
}

// ---------- 行键/列键对齐的数值格比对 ----------
// 口径：rows[0] 是表头（第1列是行键名，其余是列键）；后续每行第0列是行键。
// 键的归一化：数值取 Number（容差内相等视为同键——浮点 0.30000000000000004 vs 0.3）。
function keyOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const f = Number(v);
  if (Number.isFinite(f)) return 'n:' + f.toPrecision(12);
  return 's:' + String(v).trim();
}

function sheetToMap(rows) {
  const colKeys = [];
  const header = rows[0] || [];
  for (let j = 1; j < header.length; j++) colKeys[j] = keyOf(header[j]);
  const data = new Map(); // rowKey -> Map(colIdx -> value)
  for (let i = 1; i < rows.length; i++) {
    const rk = keyOf(rows[i] && rows[i][0]);
    if (rk === null) continue;
    const rec = new Map();
    for (let j = 1; j < rows[i].length; j++) rec.set(j, rows[i][j]);
    data.set(rk, rec);
  }
  return { colKeys, data };
}

function diffSheets(aRows, bRows, tol) {
  const A = sheetToMap(aRows), B = sheetToMap(bRows);
  // 列对齐：A 的第 j 列 与 B 的第 k 列 键相同才比
  const colPairs = [];
  for (let j = 1; j < A.colKeys.length; j++) {
    if (!A.colKeys[j]) continue;
    for (let k = 1; k < B.colKeys.length; k++) {
      if (B.colKeys[k] === A.colKeys[j]) { colPairs.push([j, k]); break; }
    }
  }
  const onlyARows = [], onlyBRows = [];
  const rowKeysB = new Set(B.data.keys());
  const rowKeysA = new Set(A.data.keys());
  for (const rk of rowKeysA) if (!rowKeysB.has(rk)) onlyARows.push(rk);
  for (const rk of rowKeysB) if (!rowKeysA.has(rk)) onlyBRows.push(rk);
  const diffs = [];
  let compared = 0, nBig = 0;
  for (const rk of rowKeysA) {
    if (!rowKeysB.has(rk)) continue;
    const ra = A.data.get(rk), rb = B.data.get(rk);
    for (const [ja, jb] of colPairs) {
      const va = ra.get(ja), vb = rb.get(jb);
      if (va === null || va === undefined || va === '') continue;
      if (vb === null || vb === undefined || vb === '') continue;
      const fa = Number(va), fb = Number(vb);
      if (!Number.isFinite(fa) || !Number.isFinite(fb)) continue;
      const d = Math.abs(fa - fb);
      compared++;
      if (d > tol) nBig++;
      diffs.push({ d, row: rk.slice(2), col: A.colKeys[ja].slice(2), a: fa, b: fb });
    }
  }
  diffs.sort((x, y) => y.d - x.d);
  return {
    compared, nBig, max: diffs[0] || null, top: diffs.slice(0, 8),
    onlyARows: onlyARows.slice(0, 10), onlyBRows: onlyBRows.slice(0, 10),
    onlyACount: onlyARows.length, onlyBCount: onlyBRows.length,
    colPairsCount: colPairs.length,
    onlyACols: A.colKeys.filter(k => k && !B.colKeys.includes(k)).slice(0, 10),
    onlyBCols: B.colKeys.filter(k => k && !A.colKeys.includes(k)).slice(0, 10),
  };
}

function fmtKey(k) { return k; }

// 对外：diffXlsx(absA, absB, { sheet, tol }) -> 文本报告
// 判定请用 diffVerdict（结构化），**不要**对报告文本跑正则：报告首行是 `[spreadsheet_diff] A=...`，
// 任何匹配 /diff/i 的判据都会被自己的表头命中而恒为 true（repro_check 曾因此永远判不过，
// 明明逐格零超差也报"有差异"）。文本只是给人看的视图。
function diffSheetsAll(absA, absB, opts) {
  const tol = (opts && opts.tol) || 5e-4;
  const wantSheet = opts && opts.sheet;
  const A = readXlsx(absA), B = readXlsx(absB);
  if (!A.size) throw new Error('A 文件没有可解析的工作表: ' + absA);
  if (!B.size) throw new Error('B 文件没有可解析的工作表: ' + absB);
  const sheetNames = wantSheet
    ? [[wantSheet, wantSheet]]
    : [...A.keys()].map(n => [n, B.has(n) ? n : null]).filter(x => x[1]);
  if (!sheetNames.length) throw new Error(`没有同名工作表可比。A: ${[...A.keys()].join('/')}；B: ${[...B.keys()].join('/')}`);
  const sheets = sheetNames.map(([na, nb]) => ({ name: na, ...diffSheets(A.get(na), B.get(nb), tol) }));
  return { tol, sheets, onlySheetsA: [...A.keys()].filter(n => !B.has(n)), onlySheetsB: [...B.keys()].filter(n => !A.has(n)) };
}

// 结构化判定：same=true 才代表"两边一致"。行/列/工作表的有无差异也算不一致——
// 结果表少了行/列同样是不能签字的复现问题，只是没有超差数值格而已。
function diffVerdict(absA, absB, opts) {
  const d = diffSheetsAll(absA, absB, opts);
  const nBig = d.sheets.reduce((s, x) => s + x.nBig, 0);
  const onlyRows = d.sheets.reduce((s, x) => s + x.onlyACount + x.onlyBCount, 0);
  const onlyCols = d.sheets.reduce((s, x) => s + x.onlyACols.length + x.onlyBCols.length, 0);
  const compared = d.sheets.reduce((s, x) => s + x.compared, 0);
  const shapeOk = !onlyRows && !onlyCols && !d.onlySheetsA.length && !d.onlySheetsB.length;
  return {
    same: nBig === 0 && shapeOk && compared > 0,
    nBig, compared, onlyRows, onlyCols,
    onlySheetsA: d.onlySheetsA, onlySheetsB: d.onlySheetsB,
    // 一个格子都没比上（列名/行键全对不齐）= 没有证据，不是"一致"
    noOverlap: compared === 0,
    tol: d.tol,
  };
}

function diffXlsx(absA, absB, opts) {
  const tol = (opts && opts.tol) || 5e-4;
  const wantSheet = opts && opts.sheet;
  const A = readXlsx(absA), B = readXlsx(absB);
  if (!A.size) throw new Error('A 文件没有可解析的工作表: ' + absA);
  if (!B.size) throw new Error('B 文件没有可解析的工作表: ' + absB);
  const lines = [];
  lines.push(`[spreadsheet_diff] A=${absA}`);
  lines.push(`                     B=${absB}`);
  lines.push(`容差 tol=${tol}；口径：第1列行键 × 表头列键对齐，数值格逐格比 |A-B|`);
  const sheetNames = wantSheet
    ? [[wantSheet, wantSheet]]
    : [...A.keys()].map(n => [n, B.has(n) ? n : null]).filter(x => x[1]);
  if (!wantSheet) {
    const onlyA = [...A.keys()].filter(n => !B.has(n));
    const onlyB = [...B.keys()].filter(n => !A.has(n));
    if (onlyA.length) lines.push(`仅 A 有的工作表: ${onlyA.join('、')}`);
    if (onlyB.length) lines.push(`仅 B 有的工作表: ${onlyB.join('、')}`);
  }
  if (!sheetNames.length) throw new Error(`没有同名工作表可比。A: ${[...A.keys()].join('/')}；B: ${[...B.keys()].join('/')}`);
  for (const [na, nb] of sheetNames) {
    const ra = A.get(na), rb = B.get(nb);
    const r = diffSheets(ra, rb, tol);
    lines.push(`--- 工作表「${na}」---`);
    lines.push(`对齐列数 ${r.colPairsCount}；共同行内比对数值格 ${r.compared} 个；超差(>${tol}) ${r.nBig} 个`);
    if (r.max) lines.push(`最大差 ${r.max.d.toExponential(3)} 在 行=${fmtKey(r.max.row)} 列=${fmtKey(r.max.col)}（A=${r.max.a} B=${r.max.b}）`);
    if (r.top.length > 1) {
      lines.push('top 差异:');
      for (const d of r.top.slice(1)) lines.push(`  行=${d.row} 列=${d.col} |A-B|=${d.d.toExponential(3)}（A=${d.a} B=${d.b}）`);
    }
    if (r.onlyACount) lines.push(`仅 A 有的行键 ${r.onlyACount} 个: ${r.onlyARows.join(', ')}${r.onlyACount > 10 ? ' …' : ''}`);
    if (r.onlyBCount) lines.push(`仅 B 有的行键 ${r.onlyBCount} 个: ${r.onlyBRows.join(', ')}${r.onlyBCount > 10 ? ' …' : ''}`);
    if (r.onlyACols.length) lines.push(`仅 A 有的列: ${r.onlyACols.join(', ')}`);
    if (r.onlyBCols.length) lines.push(`仅 B 有的列: ${r.onlyBCols.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { readXlsx, diffXlsx, unzipEntries, diffVerdict, diffSheetsAll };
