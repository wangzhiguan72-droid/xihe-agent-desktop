// 附件自动解析（应用层复审 §10）：上传时做一次本地确定性探测，分类与质量评估，
// 让模型与用户不必再花 LLM 成本判断「这是扫描件还是文本 PDF」「Excel 有几页」。
// 安全：纯 Python 内置模块即可——PDF 走 pymupdf（可选），Excel 走 zip+xml 解析（内置）。
'use strict';
const fs = require('fs');
const path = require('path');

const PDF_EXTS = new Set(['.pdf']);
const XLSX_EXTS = new Set(['.xlsx']);
const XLS_EXTS = new Set(['.xls']);
const DOCX_EXTS = new Set(['.docx']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.tex', '.py', '.m', '.r']);

// 探测 PDF 文本层：扫描前 K 字节找 %%EOF 与常见二进制标记；如果 pymupdf 可用则真实抽文本。
async function probePdf(filePath) {
  const stat = fs.statSync(filePath);
  let hasTextLayer = false; let pageCount = 0; let firstChars = ''; let titleGuess = ''; let error = null;
  try {
    // 优先用 pymupdf（精度高）
    let fitz = null;
    try { fitz = require('pymupdf'); } catch { /* 未装 */ }
    if (fitz) {
      const doc = fitz.open(filePath);
      pageCount = doc.page_count || 0;
      if (pageCount > 0) {
        const t = doc.load_page(0).get_text().trim();
        firstChars = t.slice(0, 200);
        // 文本层判定：纯图片 PDF 单页抽取 < 20 字；含文本的 PDF 至少几十到几百字
        hasTextLayer = t.length >= 20;
        // 标题猜测：扫描前 5 行非空内容
        for (const line of t.split('\n')) {
          const s = line.trim();
          if (s.length >= 4 && s.length <= 80) { titleGuess = s; break; }
        }
      }
      doc.close();
    } else {
      // 无 pymupdf：粗略判定——看是否含 /Type /Page 对象（PDF 结构）/ImagesOnly 标记
      const buf = fs.readFileSync(filePath);
      const head = buf.slice(0, Math.min(buf.length, 4096)).toString('latin1');
      hasTextLayer = /BT[\s\n]+/.test(head) && /Tj|TJ/.test(head); // 文本操作符
      pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      error = 'pymupdf 未安装，仅做粗略探测（建议 pip install pymupdf）';
    }
  } catch (e) {
    error = String(e.message || e).slice(0, 160);
  }
  return {
    kind: 'pdf', pages: pageCount, bytes: stat.size,
    has_text_layer: hasTextLayer,
    title_guess: titleGuess, first_chars: firstChars, error,
    recommendation: !hasTextLayer ? '无文本层（扫描件），必须 vision_read 逐页识图' : '含文本层，fs_read/文本提取即可',
  };
}

// 探测 Excel：xlsx 是 zip，读 xl/workbook.xml 拿工作表名。
function probeXlsx(filePath) {
  const stat = fs.statSync(filePath);
  let sheets = []; let sharedStrings = 0; let error = null;
  try {
    // 纯 Node 解 zip：找 local file header 标记 + 简单解析。完整 zip 需要 zlib。
    // 这里采用极简策略：用 zip 内置 zip entries 的 central directory，解析 XML。
    const buf = fs.readFileSync(filePath);
    const zlib = require('zlib');
    // 找 xl/workbook.xml（在 zip 内）
    const findEntry = (name) => {
      // 简单遍历 entries：每个 local file header 以 PK\x03\x04 开头，含文件名
      let off = 0; const entries = [];
      while (off < buf.length - 4) {
        if (buf[off] === 0x50 && buf[off + 1] === 0x4b && buf[off + 2] === 0x03 && buf[off + 3] === 0x04) {
          const nameLen = buf.readUInt16LE(off + 26);
          const extraLen = buf.readUInt16LE(off + 28);
          const compMethod = buf.readUInt16LE(off + 8);
          const compSize = buf.readUInt32LE(off + 18);
          const uncompSize = buf.readUInt32LE(off + 22);
          const nm = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
          entries.push({ name: nm, off: off + 30 + nameLen + extraLen, compMethod, compSize, uncompSize });
          off += 30 + nameLen + extraLen + compSize;
        } else break;
      }
      return entries.find(e => e.name === name);
    };
    const wb = findEntry('xl/workbook.xml');
    const ss = findEntry('xl/sharedStrings.xml');
    if (wb) {
      const xml = (wb.compMethod === 8 ? zlib.inflateSync(buf.slice(wb.off, wb.off + wb.compSize)) : buf.slice(wb.off, wb.off + wb.uncompSize)).toString('utf8');
      // 提取 <sheet name="..."/>
      const re = /<sheet\s[^>]*name="([^"]+)"[^>]*\/?>/g;
      let m; while ((m = re.exec(xml))) sheets.push(m[1]);
    }
    if (ss) {
      const xml = (ss.compMethod === 8 ? zlib.inflateSync(buf.slice(ss.off, ss.off + ss.compSize)) : buf.slice(ss.off, ss.off + ss.uncompSize)).toString('utf8');
      sharedStrings = (xml.match(/<si>/g) || []).length;
    }
  } catch (e) {
    error = String(e.message || e).slice(0, 160);
  }
  return {
    kind: 'xlsx', sheets, shared_strings: sharedStrings, bytes: stat.size, error,
    recommendation: sheets.length === 0 ? '未识别到工作表，文件可能损坏' : `共 ${sheets.length} 个工作表：${sheets.slice(0, 8).join('、')}${sheets.length > 8 ? '…' : ''}`,
  };
}

// 探测 docx（应用层复审）：内部是 zip，含 word/document.xml（可选文档文本）
function probeDocx(filePath) {
  const stat = fs.statSync(filePath);
  let hasDocument = false; let paraCount = 0; let titleGuess = ''; let error = null;
  try {
    const buf = fs.readFileSync(filePath);
    const zlib = require('zlib');
    let off = 0;
    while (off < buf.length - 4) {
      if (buf[off] === 0x50 && buf[off + 1] === 0x4b && buf[off + 2] === 0x03 && buf[off + 3] === 0x04) {
        const nameLen = buf.readUInt16LE(off + 26);
        const extraLen = buf.readUInt16LE(off + 28);
        const compMethod = buf.readUInt16LE(off + 8);
        const compSize = buf.readUInt32LE(off + 18);
        const uncompSize = buf.readUInt32LE(off + 22);
        const nm = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
        if (nm === 'word/document.xml') {
          hasDocument = true;
          const xml = (compMethod === 8 ? zlib.inflateSync(buf.slice(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + compSize)) : buf.slice(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + uncompSize)).toString('utf8');
          paraCount = (xml.match(/<w:p[ >]/g) || []).length;
          const t = (xml.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || []).slice(0, 5).map(x => x.replace(/<[^>]+>/g, '')).join(' ');
          titleGuess = t.slice(0, 100);
        }
        off += 30 + nameLen + extraLen + compSize;
      } else break;
    }
  } catch (e) {
    error = String(e.message || e).slice(0, 160);
  }
  return { kind: 'docx', has_document: hasDocument, paragraphs: paraCount, title_guess: titleGuess, bytes: stat.size, error,
    recommendation: !hasDocument ? '未识别到正文，可能损坏' : `约 ${paraCount} 段` };
}

// 文本/代码类：粗略看前几行（不是解析，是质量提示）
function probeText(filePath) {
  const stat = fs.statSync(filePath);
  let firstLines = ''; let lines = 0; let encoding = 'utf-8';
  try {
    const buf = fs.readFileSync(filePath, { encoding: 'utf-8' });
    lines = buf.split('\n').length;
    firstLines = buf.split('\n').slice(0, 8).join('\n').slice(0, 500);
  } catch (e) {
    encoding = 'binary';
  }
  return { kind: 'text', encoding, lines, bytes: stat.size, head: firstLines };
}

// 图片：仅记录元数据，不做内容分析（图片理解走 vision_read）
function probeImage(filePath) {
  const stat = fs.statSync(filePath);
  return { kind: 'image', bytes: stat.size, mtime: stat.mtimeMs, recommendation: '图片理解用 vision_read 工具' };
}

// 旧 .xls（二进制格式）不做完整解析（需 olefile 库），仅提示
function probeLegacyXls(filePath) {
  const stat = fs.statSync(filePath);
  let magic = ''; try { magic = fs.readFileSync(filePath).slice(0, 8).toString('hex'); } catch {}
  return { kind: 'xls_legacy', bytes: stat.size, magic, recommendation: '旧版 .xls 建议在 Excel 里另存为 .xlsx 后再上传，或用 python xlrd 读取' };
}

async function probeFile(filePath) {
  if (!fs.existsSync(filePath)) return { error: '文件不存在', path: filePath };
  const ext = path.extname(filePath).toLowerCase();
  const meta = { path: filePath, name: path.basename(filePath), bytes: fs.statSync(filePath).size };
  let detail;
  try {
    if (PDF_EXTS.has(ext)) detail = await probePdf(filePath);
    else if (XLSX_EXTS.has(ext)) detail = probeXlsx(filePath);
    else if (XLS_EXTS.has(ext)) detail = probeLegacyXls(filePath);
    else if (DOCX_EXTS.has(ext)) detail = probeDocx(filePath);
    else if (IMG_EXTS.has(ext)) detail = probeImage(filePath);
    else if (TEXT_EXTS.has(ext)) detail = probeText(filePath);
    else detail = { kind: 'unknown', recommendation: '未识别类型，工具默认按 fs_read 读取' };
  } catch (e) {
    detail = { kind: 'unknown', error: String(e.message || e).slice(0, 160) };
  }
  return Object.assign(meta, detail);
}

module.exports = { probeFile, probePdf, probeXlsx, probeDocx, probeText, probeImage };