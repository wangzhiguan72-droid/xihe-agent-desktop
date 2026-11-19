# 获奖级 PDE 求解骨架（Python / scipy）——pde-award-solve 技能附带模板
# 适用：球/柱对称扩散-反应、传热传质、移动（收缩）边界、多场耦合。
# 骨架含：守恒型有限体积 + 表面加密网格 + BDF(rtol=1e-9) + 稀疏雅可比 + 事件检测 + 双口径终点 + 守恒审计。
# 用法：复制到 scripts/ 下改方程与参数；先 SMOKE=True 的最小规模冒烟，再放大正式跑。
#
# 关键设计：**离散必须是守恒型的**——每个控制体的进出面通量成对出现（i 的右面 = i+1 的左面），
# 表面用 Robin（对流）而不是拍脑袋的边界项。这样 Σu·V 的时间导数恰好等于表面通量 × 面积，
# 守恒审计才会闭合到离散误差量级。随便写边界项会让"守恒审计"报出 100% 残差（本模板初版就踩了）。
import sys
import numpy as np

try:
    sys.stdout.reconfigure(line_buffering=True)   # 长跑看得到进度（否则像卡死）
except Exception:
    pass

from scipy.integrate import solve_ivp
from scipy.sparse import lil_matrix

# ---------------- 参数（改成你的题的） ----------------
SMOKE = True          # True=最小规模冒烟；正式跑设 False
N_GRID = 51 if SMOKE else 1281
T_END = 600.0 if SMOKE else 24 * 3600.0
T_CHUNK = 3600.0      # 分块推进上限（秒）：单块别超 1h，避免内存爆
RTOL, ATOL, MAX_STEP = 1e-9, 1e-12, 10.0
R0 = 2.0e-2           # 初始半径 [m]（收缩域用；不收缩就传常量）
D = 7e-9              # 扩散系数 [m²/s]（可换成 D(u,T) 形式）
# 表面对流系数 [m/s]，**必须与 D 同量纲**。若你手上的是换热系数 h [W/(m²·K)]，
# 先除以 ρ·cp 换算成 m/s 再填（A 题烘干：hm≈8e-7 m/s、h/(ρcp)≈1e-5 m/s 量级）。
# 量纲搞错的直接后果是刚度爆炸：把 25 W/(m²·K) 当成 25 m/s 用，表面节点的时间常数会
# 从「秒」掉到「纳秒」，BDF 立刻 overflow（本模板初版就踩了这个坑）。
H_CONV = 1.0e-5
U_AMB = 0.05          # 环境值（与 u 同量纲：含水率 kg/kg / 温度 K 都行）
U_INIT = 0.35         # 初值（均匀场）


def make_grid(n, R):
    """表面加密网格：r_j = R·(1 − (1 − ξ_j)²)，ξ 均匀。表面附近格距最小。"""
    xi = np.linspace(0.0, 1.0, n)
    return R * (1.0 - (1.0 - xi) ** 2)


def face_radii(r):
    """控制体左右界面半径：内部取相邻格中点，中心 0，最外等于表面 r[-1]。"""
    n = len(r)
    rL = np.empty(n); rR = np.empty(n)
    rL[0] = 0.0
    rL[1:] = 0.5 * (r[:-1] + r[1:])
    rR[:-1] = 0.5 * (r[:-1] + r[1:])
    rR[-1] = r[-1]
    return rL, rR


def make_jac_sparsity(n):
    """三对角稀疏结构（一维径向二阶差分）。BDF 用它把雅可比构造从 O(n²) 降到 O(n)。"""
    J = lil_matrix((n, n), dtype=int)
    for i in range(n):
        for j in (i - 1, i, i + 1):
            if 0 <= j < n:
                J[i, j] = 1
    return J.tocsr()


def rhs(t, y, r, rL, rR, Dcoef, h, uamb):
    """守恒型有限体积右端项（球对称）：∂u/∂t = (A_R·F_R − A_L·F_L) / V。

    F = D·∂u/∂r（+r 方向即向外）；表面界面改用 Robin：−D·∂u/∂r|_R = h·(u_R − u_amb)，
    所以 F_R = **−**h·(u_R − u_amb)。这个负号是「干燥/散热到底会不会发生」的分水岭：
    写成 +h·(u_R−u_amb) 表面会反向暴涨，守恒审计同时报 100% 残差（本模板初版两个症状齐发）。
    A ∝ r²（4π 在分子分母中约掉，不影响结果），V = (rR³ − rL³)/3。
    """
    n = len(y)
    FR = np.empty(n); FL = np.empty(n)
    FL[0] = 0.0                                        # 中心对称：通量为 0
    FL[1:] = Dcoef * (y[1:] - y[:-1]) / (r[1:] - r[:-1])
    FR[:-1] = FL[1:]                                   # i 的右面 = i+1 的左面（成对，守恒的关键）
    FR[-1] = -h * (y[-1] - uamb)                       # 表面 Robin（向外通量，负号不可省）
    V = (rR ** 3 - rL ** 3) / 3.0
    return (FR * rR ** 2 - FL * rL ** 2) / V


def _event_cross(level):
    """事件函数：min(y) 下穿 level（direction=-1）时定位精确时刻。"""
    def f(t, y, *args):
        return np.min(y) - level
    f.terminal = True
    f.direction = -1
    return f


def solve(n=N_GRID, t_end=T_END, R=R0, Dcoef=D, h=H_CONV, uamb=U_AMB, level=0.10, y0_val=U_INIT):
    r = make_grid(n, R)
    rL, rR = face_radii(r)
    y0 = np.full(n, y0_val)
    J = make_jac_sparsity(n)
    events = _event_cross(level)
    args = (r, rL, rR, Dcoef, h, uamb)

    ts, ys, tc = [], [], np.nan
    t0 = 0.0
    while t0 < t_end:
        te = min(t0 + T_CHUNK, t_end)
        sol = solve_ivp(rhs, (t0, te), y0, method='BDF', args=args,
                        rtol=RTOL, atol=ATOL, max_step=MAX_STEP,
                        jac_sparsity=J, events=events, dense_output=False)
        if sol.t.size == 0:
            break
        ts.append(sol.t); ys.append(sol.y)
        if sol.t_events and len(sol.t_events[0]):
            tc = float(sol.t_events[0][0])             # 连续口径：精确下穿时刻
            t_ok = float(np.floor(tc) + 1)             # 首严格达标整秒
            back = solve_ivp(rhs, (max(tc - 1.0, 0.0), t_ok), sol.y[:, -1], method='BDF',
                             args=args, rtol=RTOL, atol=ATOL, max_step=MAX_STEP, jac_sparsity=J)
            prev_ok = bool(np.min(back.y[:, -1]) >= level)   # 前一秒应仍不达标
            print(f'[终点] 连续口径 tc={tc:.6f}s；首严格达标整秒 t_ok={t_ok:.1f}s（前一秒不达标={not prev_ok}）')
            break
        y0 = sol.y[:, -1]; t0 = te
    t = np.concatenate(ts); Y = np.concatenate(ys, axis=1)
    return r, rL, rR, t, Y, tc


def total_mass(rL, rR, u):
    """球对称总量 Σu·V（4π 因子两侧约掉，比较闭合时不需要）。"""
    V = (rR ** 3 - rL ** 3) / 3.0
    return float(np.sum(u * V))


def conservation_audit(r, rL, rR, t, Y, h=H_CONV, uamb=U_AMB):
    """守恒审计：总量初末差 vs 表面 Robin 通量时间积分。

    返回 (initial, final, flux_integral)，形状与 conservation_check 的
    initial / final / boundary_flux 三个参数一一对应（引擎会自己复算残差与相对误差）。
    注意：通量项必须与 rhs 里用的**同一个**表达式——用 Fick 去核 Robin 的边界会报假残差。
    """
    ini, fin = total_mass(rL, rR, Y[:, 0]), total_mass(rL, rR, Y[:, -1])
    surf = h * (Y[-1, :] - uamb) * r[-1] ** 2          # 表面通量 × 面积因子(=4πR² 的 4π 已约掉)
    flux = float(np.trapezoid(surf, t))                # 向外为正（u_R > u_amb → 正）
    return ini, fin, -flux                            # 流入为正（与 boundary_flux 约定一致）


if __name__ == '__main__':
    print(f'[冒烟] n={N_GRID}, T_END={T_END}, SMOKE={SMOKE}')
    r, rL, rR, t, Y, tc = solve()
    ini, fin, flux = conservation_audit(r, rL, rR, t, Y)
    rel = abs((fin - ini) - flux) / max(abs(fin - ini), abs(flux), 1e-12)
    print(f'[守恒] 初值={ini:.10e} 末值={fin:.10e} 表面通量积分(流入为正)={flux:.10e} 相对误差={rel * 100:.4f}%')
    print(f'[网格] 节点={len(r)} 表面格距={r[-1] - r[-2]:.3e} 中心格距={r[1] - r[0]:.3e}')
    print(f'[输出] 末态中心={Y[0, -1]:.4f} 表面={Y[-1, -1]:.4f}  连续口径终点={"未触发" if np.isnan(tc) else f"{tc:.6f}s"}')
    print('[下一步] 把 ini/fin/flux 拿去 conservation_check 登记；再把 N_GRID 取 161/641/1281 各跑一次报收敛差。')
    # 网格收敛：N_GRID 换成 161/641/1281 各跑一次，比关键输出（临界时刻/峰值/终值）的差值或收敛阶
    # 情景灵敏度：边界延拓口径（末值保持 / 末段均值）各跑一次，差值写进结果与论文检验节
