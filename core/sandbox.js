// 羲和沙箱：路径监狱 + 命令安全策略
// 工作区与程序本体分离（工作区=workspace/，程序/密钥/会话在沙箱外不可达）；
// 读和写都做真实路径（realpath）校验，符号链接/junction 逃逸读写均拒绝。
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOTS: SKILL_ROOTS, getRoots: getSkillRoots } = require('./skills');

const WIN = process.platform === 'win32';

class Sandbox {
  // root: 模型可写工作区；opts.protected: 绝对禁区（程序目录、审计目录等，读写都拒）
  constructor(root, opts = {}) {
    this.root = fs.realpathSync(root);
    // 外部项目标记（v2.6）：沙箱根 = 用户自己的既有文件夹。置位后引擎必须关掉一切
    // 「工作区管家」行为（自动备份/回收站）——那些行为会把用户既有文件移走。
    this.external = !!opts.external;
    this.protected = (opts.protected || []).map(p => path.resolve(p).toLowerCase());
    // 绝对禁区：Windows 系统目录
    this.hardDeny = [
      'c:\\windows',
      'c:\\program files',
      'c:\\program files (x86)',
      'c:\\programdata',
    ].map(p => p.toLowerCase());
    // 只读区：技能库根（只有读经这里放行；skill_load 走 skills.js 自己的边界校验）
    this.readOnlyRoots = (opts.readOnlyRoots || SKILL_ROOTS.map(r => r.dir)).map(p => path.resolve(p).toLowerCase());
  }

  _isInside(child, parent) {
    const c = String(child).toLowerCase().replace(/[\\/]+/g, '\\');
    const p = String(parent).toLowerCase().replace(/[\\/]+/g, '\\');
    // 严格边界匹配：必须以 \ 结尾才算"真在内部"——避免"/work/a"被"/work/ab"前缀误中
    // （P0 修复：A 题跑题时 5 次读不到 source/ 附件，根因就是这里 startsWith 漏判）
    if (c === p) return true;
    const sep = p.endsWith('\\') ? '' : '\\';
    return c.startsWith(p + sep);
  }

  // 解析并校验一个路径。mode: 'r' | 'w'
  resolve(p, mode = 'r') {
    if (!p || typeof p !== 'string') throw new Error('路径为空');
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.root, p);
    const lower = abs.toLowerCase();
    for (const d of [...this.protected, ...this.hardDeny]) {
      if (this._isInside(lower, d)) throw new Error(`越界拒绝：${abs} 位于受保护目录（程序/系统文件，读写均禁止）`);
    }
    if (mode === 'w' && this.readOnlyRoots.some(ro => this._isInside(lower, ro))) throw new Error(`只读拒绝：${abs} 属于只读技能目录`);
    const inRoot = this._isInside(lower, this.root);
    if (!inRoot) {
      for (const ro of this.readOnlyRoots) {
        if (this._isInside(lower, ro)) {
          if (mode === 'w') throw new Error(`只读拒绝：${abs} 属于技能库（只能看，不能改）`);
          return abs;
        }
      }
      throw new Error(`越界拒绝：${abs} 不在工作目录 ${this.root} 内。所有文件操作局限在工作区文件夹。`);
    }
    // 符号链接/junction 真实路径逃逸检查：读和写都拦截。
    // 目标不存在时锚定到最近存在的祖先目录再验真实路径。
    let probe = abs;
    while (probe) {
      if (fs.existsSync(probe)) break;
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    const real = fs.realpathSync(probe);
    const realLower = real.toLowerCase();
    if (mode === 'w' && this.readOnlyRoots.some(ro => this._isInside(realLower, ro))) throw new Error('只读拒绝：目标实际指向冻结技能目录');
    if (this._isInside(realLower, this.root)) return abs; // 真实位置在工作区内
    // 真实位置在根外：只读技能根例外（仅读）
    const inRO = this.readOnlyRoots.some(ro => this._isInside(realLower, ro));
    if (inRO && mode === 'r') return abs;
    const via = probe === abs ? '' : '的上级目录';
    throw new Error(`越界拒绝：${abs}${via} 实际指向工作区外（${real}）。`);
  }

  // 命令扫描：展开环境变量后检查盘符绝对路径与 .. 相对逃逸（cwd 为命令工作目录）
  checkCommand(cmd, cwd = this.root) {
    const reasons = [];
    const catastrophic = /\b(format|diskpart|cipher|bcdedit|vssadmin|dism|sfc)\b|shutdown\s+(-s|\/s)|reg\s+(add|delete|import)|wevtutil\s+cl|wmic\s+process\s+call\s+create/i;
    if (catastrophic.test(cmd)) return { ok: false, reason: `命中灾难命令黑名单：${cmd.slice(0, 120)}` };
    // 解释器直调 = 绕过执行守卫的通道（shell 启动 python/node 跑脚本，脚本内容不受任何守卫约束）。
    // Python 代码一律走 python_run（带审计钩子守卫）；node/octave/Rscript 无守卫通道，直接禁。
    // MATLAB 仅允许 -batch 形式（数模求解链路）；pip/npm 为用户授权的依赖安装入口。
    const interp = /(^|[\s&|;(`])((python|python3|py|node|octave|Rscript)(\.exe)?)(\s|$)/i;
    if (interp.test(cmd)) return { ok: false, reason: '禁止在 shell 中直调 python/node 等解释器（绕过执行守卫）：Python 代码用 python_run 工具。' };
    if (/(^|[\s&|;(`])matlab(\.exe)?(\s|$)/i.test(cmd) && !/(^|[\s&;])matlab(\.exe)?\s+(-batch|-r)\s/i.test(cmd)) {
      return { ok: false, reason: 'MATLAB 仅允许 `matlab -batch "..."` 形式（非交互执行）。' };
    }
    // 系统级安装器：这类工具把文件写到 Program Files / 注册表 / 服务，**完全绕开工作区沙箱**
    // （下面的路径扫描只看命令行里出现的路径，安装器内部的写入它看不见）。实测 hole：
    // `choco install ffmpeg` 原先直接放行。依赖安装只留 pip 与项目内的 npm install。
    const sysInstaller = /(^|[\s&|;(`])(choco|winget|scoop|msiexec|installutil|nssm)(\.exe)?(\s|$)/i;
    if (sysInstaller.test(cmd)) return { ok: false, reason: '禁止在 shell 中调用系统级安装器（choco/winget/scoop/msiexec 会写 Program Files 与注册表，绕开工作区沙箱）。Python 依赖用 pip，项目依赖在项目目录内 npm install。' };
    if (/(^|[\s&|;(`])npm(\.exe)?\s+(i|install|add)\s+[^&|;]*-g\b/i.test(cmd)) {
      return { ok: false, reason: '禁止 npm 全局安装（-g 写到用户级目录，绕开工作区）。改为在项目目录内 npm install。' };
    }
    // 展开环境变量后再扫描（%USERPROFILE% 这类引用展开后即是沙箱外路径）
    const expanded = String(cmd).replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name) => {
      const v = process.env[name] || process.env[name.toUpperCase()];
      return v != null ? v : m;
    });
    const drivePaths = expanded.match(/[A-Za-z]:[\\/][^\s"'|&;><*)]+/g) || [];
    for (const dp0 of drivePaths) {
      const dp = dp0.replace(/\//g, '\\').replace(/\\+$/, ''); // 正斜杠与反斜杠盘符路径统一处理
      if (!this._isInside(dp, this.root)) {
        const inReadOnly = this.readOnlyRoots.some(ro => this._isInside(dp.toLowerCase(), ro));
        if (inReadOnly) reasons.push(`命令引用了只读技能库路径（不允许在 shell 中操作）：${dp}`);
        else reasons.push(`命令引用了沙箱外路径：${dp}（工作范围限工作区）`);
      }
    }
    // 相对路径 .. 逃逸：提取带路径分隔符的 token，按 cwd 解析，落到根外即拒绝
    const tokens = expanded.match(/[^\s"'|&;><]+/g) || [];
    for (const tk of tokens) {
      const clean = tk.replace(/^["']+|["':,]+$/g, '');
      if (!clean.includes('\\') && !clean.includes('/')) continue;
      if (/^[A-Za-z]:[\\/]/.test(clean)) continue; // 盘符路径已在上面处理
      if (!clean.includes('..')) continue;
      const abs = path.resolve(cwd, clean);
      if (!this._isInside(abs, this.root)) {
        reasons.push(`相对路径逃逸：${clean} 会解析到工作区外（${abs}）`);
      }
    }
    if (reasons.length) return { ok: false, reason: reasons.join('；') + '。请改用相对路径（相对工作区）。' };
    return { ok: true };
  }
}

// 统一沙箱工厂：server / cli / 文件预览 / 测试共用同一构造，避免各处参数漂移。
// 禁区 = 程序目录（密钥/会话/账本/代码）+ 审计目录；不圈工作区上级目录
// （旧写法 protected 含 APP_DIR 的上级，把 workspace 也划进了禁区 → 正常读写被 403）。
// opts.workspace 显式指定沙箱根（项目隔离用）；默认走 APP_DIR/../workspace
function createSandbox(appDir, opts = {}) {
  const root = opts.workspace || opts.root || path.join(path.resolve(appDir, '..'), 'workspace');
  const protectedDirs = [appDir];
  const auditDir = path.join(path.resolve(appDir, '..'), 'audit');
  if (fs.existsSync(auditDir)) protectedDirs.push(auditDir);
  if (opts.extraProtected) protectedDirs.push(...opts.extraProtected);
  // 只读根 = 技能库 + settings.kb_roots 声明的知识库语料目录。
  // 知识库语料对模型是只读参考——能 fs_ls/fs_read 直接翻 md/txt；PDF 走 kb_search 的索引。
  // 显式 opts.readOnlyRoots 优先（测试注入），否则从 settings.json 读 kb_roots 合并。
  let roRoots = opts.readOnlyRoots;
  if (!roRoots) {
    roRoots = getSkillRoots(appDir).map(r => r.dir);
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(appDir, 'config', 'settings.json'), 'utf8'));
      for (const root of (cfg.skill_roots || [])) if (typeof root === 'string' && path.isAbsolute(root)) roRoots.push(root);
      for (const r of (cfg.kb_roots || [])) {
        const s = String(r || '').trim();
        if (s) roRoots.push(s);
      }
    } catch {}
  }
  if (opts.skillRoot) roRoots = [...roRoots, opts.skillRoot];
  return new Sandbox(root, {
    protected: protectedDirs,
    readOnlyRoots: roRoots,
    external: !!opts.external,
  });
}

module.exports = { Sandbox, createSandbox, WIN };
