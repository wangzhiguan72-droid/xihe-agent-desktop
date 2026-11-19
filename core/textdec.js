// Windows 中文输出统一解码：UTF-8 优先，出现替换字符时回退 GBK。
// 调用方应先累积完整 Buffer 再解码，避免多字节字符跨 chunk 被切断。
'use strict';
const fs = require('fs');

function decodeText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf);
    const bad = (s) => (s.match(/\uFFFD/g) || []).length;
    if (bad(gbk) < bad(utf8)) return gbk;
  } catch { /* 非完整 ICU 构建没有 GBK 时保留 UTF-8 结果 */ }
  return utf8;
}

function readTextFile(file) {
  return decodeText(fs.readFileSync(file));
}

module.exports = { decodeText, readTextFile };
