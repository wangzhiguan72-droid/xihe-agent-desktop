# 羲和 Python 守卫：通过 sys.addaudithook 在解释器层约束模型运行的代码。
# 约束：写操作仅限工作区与私有临时目录（ro 模式全禁）；子进程/网络默认禁用（env 可开）。
# ctypes 不再一概封禁：numpy/scipy 在 Windows 上依赖 ctypes 加载系统库，一概封禁会
# 误杀全部科学计算。残余风险（有意绕过：经 ctypes 调系统 API 写文件）如实声明——
# 本守卫定位是"事故与注入缓解层"，不是 OS 级安全边界；无人值守场景请自行评估。
import os
import sys
import tempfile


def install():
    mode = os.environ.get('XIHE_PY_MODE', 'rw')          # rw=工作区内可写；ro=只读
    allow_net = os.environ.get('XIHE_PY_NET', '0') == '1'
    allow_sub = os.environ.get('XIHE_PY_SUBPROC', '0') == '1'

    root = os.path.realpath(os.environ.get('XIHE_PY_ROOT', os.getcwd()))
    write_root = os.path.realpath(os.environ.get('XIHE_PY_WRITE_ROOT', root))
    # 私有临时目录（由工具层注入 TEMP/TMP/MPLCONFIGDIR，指向 data/pytemp 等）。
    # 不再放开整个系统 TEMP——那是所有进程共享的世界可写区。
    tempdir = os.path.realpath(os.environ.get('XIHE_PY_TEMP')
                               or os.environ.get('TEMP')
                               or os.environ.get('TMP')
                               or tempfile.gettempdir())
    # 只读白名单：标准库/site-packages（保证 import 正常）。
    # 明确剔除程序目录（含 config/*.key、data/ 会话账本）与守卫自身目录——
    # 它们会经 sys.path（脚本目录）混入，不剔除则密钥对 python 可读。
    here = os.path.dirname(os.path.abspath(__file__))
    app_dir = os.path.dirname(here)
    deny_ro = {os.path.normcase(here), os.path.normcase(app_dir)}
    ro_dirs = set()
    for d in sys.path:
        try:
            if d and os.path.isdir(d):
                rp = os.path.realpath(d)
                if os.path.normcase(rp) not in deny_ro:
                    ro_dirs.add(rp)
        except OSError:
            pass

    # 系统字体目录只读放行：matplotlib 中文字体（微软雅黑/黑体）在这里；字体文件无敏感信息
    windir = os.environ.get('WINDIR') or os.environ.get('SystemRoot')
    if windir and os.path.isdir(os.path.join(windir, 'Fonts')):
        ro_dirs.add(os.path.realpath(os.path.join(windir, 'Fonts')))

    def normcase(p):
        return os.path.normcase(os.path.realpath(os.fspath(p)))

    def inside(p, base):
        try:
            rp = normcase(p)
        except Exception:
            return False
        b = os.path.normcase(base)
        return rp == b or rp.startswith(b + os.sep)

    def writable(p):
        # Project Skill snapshots are readable resources, even outside an external project root.
        # They remain immutable when the metadata directory happens to be inside the workspace.
        if skill_root and inside(p, skill_root):
            return False
        # 工作区与私有临时目录可写；redteam 额外收紧到 findings/redteam。
        if mode == 'redteam':
            return inside(p, write_root) or inside(p, tempdir)
        return inside(p, root) or inside(p, tempdir)

    def readable(p):
        # redteam 仍需读主解、数据与运行环境，只是不能写到白名单外。
        return inside(p, root) or inside(p, tempdir) or (skill_root and inside(p, skill_root)) or any(inside(p, d) for d in ro_dirs)

    skill_root = os.environ.get('XIHE_PY_SKILL_ROOT')
    skill_root = os.path.realpath(skill_root) if skill_root else None

    WRITE_FLAGS = (getattr(os, 'O_WRONLY', 1) | getattr(os, 'O_RDWR', 2)
                   | getattr(os, 'O_CREAT', 0x100) | getattr(os, 'O_APPEND', 0x400)
                   | getattr(os, 'O_TRUNC', 0x200))

    def hook(event, args):
        try:
            if event == 'open':
                p, m, flags = args[0], args[1], (args[2] if len(args) > 2 else 0) or 0
                is_write = (m and any(c in m for c in 'wax+')) or (flags and (flags & WRITE_FLAGS))
                if is_write:
                    if mode == 'ro' or not writable(p):
                        raise PermissionError(
                            f'[羲和守卫] 拒绝写入工作区外/只读模式: {p}（允许写入: {root}）')
                else:
                    if not readable(p):
                        raise PermissionError(
                            f'[羲和守卫] 拒绝读取白名单外路径: {p}（允许: 工作区与 Python 运行环境）')
            elif event in ('os.remove', 'os.rmdir', 'os.truncate', 'os.link', 'os.symlink'):
                if mode == 'ro' or not writable(args[0]):
                    raise PermissionError(f'[羲和守卫] 只读模式/工作区外，拒绝 {event}: {args[0]}')
            elif event in ('os.rename', 'os.replace'):
                src, dst = args[0], args[1]
                if mode == 'ro' or not (writable(src) and writable(dst)):
                    raise PermissionError(f'[羲和守卫] 拒绝重命名 {src} -> {dst}（只读或工作区外）')
            elif event in ('os.mkdir', 'os.makedirs'):
                if mode == 'ro' or not writable(args[0]):
                    raise PermissionError(f'[羲和守卫] 拒绝建目录（只读或工作区外）: {args[0]}')
            elif event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn',
                           'os.posix_spawn', 'os.fork'):
                if not allow_sub:
                    raise PermissionError(
                        '[羲和守卫] python_run 内禁止派生子进程/执行系统命令（需要时改用 shell_run 工具；'
                        '或经用户在 XIHE_PY_SUBPROC=1 下运行）')
            elif event in ('socket.connect', 'socket.bind', 'urllib.Request', 'ftplib.connect'):
                if not allow_net:
                    raise PermissionError(
                        '[羲和守卫] python_run 内默认禁网（抓取网页请用 web_fetch 工具；'
                        '确需联网时由用户设置 XIHE_PY_NET=1）')
        except PermissionError:
            raise
        except Exception:
            # 守卫自身异常时放行该事件并继续观察后续事件（避免误杀正常代码）
            pass

    sys.addaudithook(hook)
    return {'mode': mode, 'root': root, 'net': allow_net, 'sub': allow_sub}
