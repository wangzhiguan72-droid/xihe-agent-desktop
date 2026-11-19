// 代码指纹：core/ 与 ui/ 下源文件的 mtime+size 摘要。桌面壳据此识别「端口上跑的是旧版服务」并重启，
// 避免更新后点开桌面快捷方式看到的仍是老版本。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function codeStamp(appDir = path.join(__dirname, '..')) {
  const h = crypto.createHash('md5');
  for (const d of ['core', 'ui']) {
    let names = [];
    // test_* 不参与指纹：那是测试代码，跑起来的东西一模一样，改它不该被判成"代码更新了"而重启外壳换版。
    // 代价：真的改了测试却把它当成版本变更来判断时，指纹不会动——这是有意的，测试不是运行时。
    try { names = fs.readdirSync(path.join(appDir, d)).filter(n => /\.(js|html|css|py)$/.test(n) && !/^test_/.test(n)).sort(); } catch {}
    for (const n of names) {
      // statSync 必须自己 try：文件可能在 readdir 与 stat 之间被替换/删除（正在编辑 ui/ 下文件时就会发生）。
      // 本模块由 main.js:4 在模块加载期 require，早于 app.whenReady——那时还没有窗口，
      // 也没有 uncaughtException 处理器，抛出去会直接打死 Electron 引导流程，表现为"点了图标什么都没发生"。
      // 跳过一个正在消失的文件是安全的：指纹最多差一版，后果只是外壳重启服务，方向是安全的。
      try { const st = fs.statSync(path.join(appDir, d, n)); h.update(n + st.size + ':' + st.mtimeMs); } catch {}
    }
  }
  return h.digest('hex').slice(0, 12);
}
module.exports = { codeStamp };
