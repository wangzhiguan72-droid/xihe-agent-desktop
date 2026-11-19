# 羲和 Python 执行包装：先装守卫再运行用户脚本（fail-closed：守卫装不上就拒绝执行）
import os
import sys
import runpy

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _here)
try:
    import pyguard
    pyguard.install()
except Exception as e:  # 守卫缺失/损坏 → 拒绝执行任意代码
    print(f'[羲和守卫] 初始化失败，已拒绝执行: {e}', file=sys.stderr)
    sys.exit(101)

if len(sys.argv) < 2:
    print('[羲和守卫] 缺少脚本参数', file=sys.stderr)
    sys.exit(102)
script = os.path.abspath(sys.argv[1])
sys.argv = [script] + sys.argv[2:]
runpy.run_path(script, run_name='__main__')
