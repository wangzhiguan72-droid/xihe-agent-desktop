# xihe_plot —— 数模论文数据图基线（羲和 v2.5，落实交接清单 F-7）
# 用法（在 python_run 里直接 import，本文件已铺到工作区根）：
#     import xihe_plot as xp
#     xp.setup()                      # 注入国赛版视觉基线（字体/字号/线宽/配色/矢量导出）
#     fig, ax = xp.figure('full')     # 整宽 155 mm / 'half' 80 mm / 'mid' 120 mm
#     ax.plot(x, y, color=xp.C['primary'], lw=1.4, label='本文方法')
#     ax.plot(x, y2, color=xp.C['secondary'], lw=1.2, ls='--', label='对照')
#     xp.finish(ax, 'fig01_q1_result', '（一句话结论，不是"××示意图"）')   # 存 figures/xxx.pdf + .png
#
# 硬底线（不满足不得入文）：成书尺寸下最小字 ≥7 pt；矢量 PDF 入文（论文里不再二次缩放）；
# 中文不乱码、负号不出方框；同一语义全文同色；红绿不作唯一区分（加线型/点形冗余编码）。
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# 国赛版配色（色盲安全，取自 my-cumcm《图表规范》）
CUMCM_PALETTE = {
    'primary':   '#0072B2',  # 蓝：主方法/本文结果/主线
    'secondary': '#D55E00',  # 橙：对照方法/基线
    'positive':  '#009E73',  # 绿：改进/正向结果
    'purple':    '#CC79A7',  # 紫：第三类别
    'neutral':   '#999999',  # 灰：背景/不显著/参考
    'accent':    '#B2182B',  # 红：全图唯一最强强调，慎用
}
C = CUMCM_PALETTE  # 简写别名
# 成书尺寸档位（毫米 → 英寸，按最终尺寸画，不二次缩放）
MM = {'full': 155, 'mid': 120, 'half': 80}
FIG_DIR = 'figures'


def mm(width_mm, height_mm=None, rows=1):
    """毫米转英寸 figsize。height 缺省按黄金比 ×0.62，多面板按 rows 递增高度。"""
    w = width_mm / 25.4
    h = (height_mm / 25.4) if height_mm else w * 0.62 * (1 + 0.45 * (rows - 1))
    return (w, h)


def setup(base=8.0):
    """注入视觉基线。base=图内正文标签字号（≥7，默认 8）。"""
    plt.rcParams.update({
        'figure.dpi': 120, 'savefig.dpi': 300,
        'font.size': base,
        'axes.labelsize': base, 'axes.titlesize': base + 1,
        'xtick.labelsize': max(7, base - 1), 'ytick.labelsize': max(7, base - 1),
        'legend.fontsize': max(7, base - 1),
        'axes.linewidth': 0.7,
        'lines.linewidth': 1.4, 'lines.markersize': 4,
        'xtick.direction': 'out', 'ytick.direction': 'out',
        'xtick.major.width': 0.7, 'ytick.major.width': 0.7,
        'legend.frameon': False,
        'axes.spines.top': False, 'axes.spines.right': False,
        'axes.unicode_minus': False,
        'pdf.fonttype': 42, 'ps.fonttype': 42,
        'figure.autolayout': False,
        'axes.grid': False,
    })


def figure(size='full', height_mm=None, rows=1, ncols=1):
    """建图。size ∈ {'full','mid','half'} 或直接给毫米数。

    返回 (fig, ax)：
      - rows=cols=1 → ax 是单个 Axes，可直接 ax.plot(...)
      - 其它       → ax 是 Axes 的一维列表（行优先），用 ax[i] 逐个画
    （不返回 numpy 数组——曾经 `plt.subplots(squeeze=False)[0]` 让 ax 变成 ndarray，
      调用 ax.plot() 直接 AttributeError；这里统一成 Axes / list[Axes]。）
    """
    w = MM.get(size, size)
    fig, axes = plt.subplots(rows, ncols, figsize=mm(w, height_mm, rows), squeeze=False)
    grid = [axes[i][j] for i in range(rows) for j in range(ncols)]
    return fig, (grid[0] if len(grid) == 1 else grid)


def panel_labels(axes, labels=None, x=0.02, y=0.98):
    """统一 (a)(b)(c) 标号：左上、粗体、位置一致（不手摆 ax.text）。"""
    if not isinstance(axes, (list, tuple)):
        axes = [axes]
    labels = labels or [f'({chr(97 + i)})' for i in range(len(axes))]
    for a, lab in zip(axes, labels):
        a.text(x, y, lab, transform=a.transAxes, va='top', ha='left', fontweight='bold', fontsize=9)


def grid(ax, color='#E0E0E0', lw=0.3, alpha=0.5):
    """确需引导视线时的极浅灰网格（默认无网格）。"""
    ax.grid(True, color=color, lw=lw, alpha=alpha)
    ax.set_axisbelow(True)


def tight_y(ax, lo, hi, margin=0.06):
    """Y 轴贴合数据区间，不用 0–100 装 85–95 的数据。"""
    pad = (hi - lo) * margin or 1e-9
    ax.set_ylim(lo - pad, hi + pad)


def finish(ax_or_fig, name, caption=None, outdir=None, also_png=True):
    """收尾：紧凑布局 → 存矢量 PDF（入文用）+ 300dpi PNG（预览/自检）。

    接受 Figure / Axes / Axes 列表。返回 (pdf_path, png_path)。
    name 可以是纯名字（`fig01_q1_result`，落在 outdir，默认 figures/），
    也可以直接带路径（`paper/figures/fig01_q1_result`）——带路径时按该路径落盘，
    不再叠在 outdir 下（曾经 join 出 figures/paper/figures/... 这种鬼路径）。
    论文里的图题写在 LaTeX \\caption 里（写结论，不写"××示意图"）。
    """
    if isinstance(ax_or_fig, matplotlib.figure.Figure):
        fig = ax_or_fig
    elif isinstance(ax_or_fig, (list, tuple)) and ax_or_fig:
        fig = ax_or_fig[0].figure
    elif isinstance(ax_or_fig, matplotlib.axes.Axes):
        fig = ax_or_fig.figure
    else:
        raise TypeError('finish() 需要 Figure / Axes / Axes 列表')
    name = str(name)
    if os.path.dirname(name):
        outdir, name = os.path.dirname(name), os.path.basename(name)
    outdir = outdir or FIG_DIR
    os.makedirs(outdir, exist_ok=True)
    stem = os.path.join(outdir, name)
    try:
        fig.tight_layout(pad=0.4)
    except Exception:
        pass
    pdf = stem + '.pdf'
    fig.savefig(pdf, bbox_inches='tight')
    png = None
    if also_png:
        png = stem + '.png'
        fig.savefig(png, bbox_inches='tight', dpi=300)
    plt.close(fig)
    return pdf, png


def check_min_font(fig, floor=7.0):
    """自检：报出图内小于 floor 的字号（成书后 <7pt 会糊成灰条）。"""
    bad = []
    for t in fig.findobj(matplotlib.text.Text):
        if t.get_visible() and t.get_text().strip():
            sz = t.get_fontsize()
            if sz and sz < floor:
                bad.append((t.get_text()[:20], sz))
    return bad
