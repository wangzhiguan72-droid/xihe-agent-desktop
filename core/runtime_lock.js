// One writer for a data directory, including explicitly-port-selected instances.
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // malformed owner is ambiguous
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function acquireRuntimeLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = { pid: process.pid, token: randomUUID(), created_at: Date.now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.unlinkSync(file); } catch {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Serialize stale-owner cleanup: two restarts must not unlink each other's
      // newly claimed lock between a stale read and unlink.
      const reclaimFile = file + '.reclaim';
      let reclaimFd;
      try { reclaimFd = fs.openSync(reclaimFile, 'wx'); }
      catch (err) { if (err.code === 'EEXIST') throw new Error('另一实例正在回收运行锁，稍后重试'); throw err; }
      try {
        let existing;
        try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (err) { if (err.code === 'ENOENT') continue; throw new Error('另一实例的运行锁尚未完整写入，稍后重试'); }
        if (alive(existing.pid)) throw new Error('另一实例正在使用此数据目录，拒绝重复调度任务');
        fs.unlinkSync(file);
      } finally { fs.closeSync(reclaimFd); fs.unlinkSync(reclaimFile); }
    }
  }
  throw new Error('无法认领此数据目录的运行实例');
}
module.exports = { acquireRuntimeLock };
