# 绘图配方

脚本只读一份实际结果 JSON。相对路径都以 `--root` 指定的工作区为准，不得越界。调用：

```text
python render_evidence.py --root . --recipe figure-plan.json --output figures/comparison
```

实际在羲和中，使用 `python_run` 载入当前冻结 Skill 的脚本，不用 `shell_run` 绕过守卫。`--output` 为文件名前缀，生成 `.pdf`、`.png`、`.figure.json`。

```json
{
  "schema_version": 1,
  "source": "outputs/result.json",
  "locale": "en",
  "width_mm": 168,
  "panels": [
    {
      "id": "mean",
      "kind": "bar",
      "title": "Mean delivery time",
      "categories": ["A", "B"],
      "unit": "min",
      "ylabel": "Time",
      "series": [{ "label": "Given demand weights", "fields": ["scores.A", "scores.B"] }]
    }
  ]
}
```

`series` 中 `field` 读取一个数值数组，或用 `fields` 读取多个标量字段，二者只选一个。所有数值须有限，长度与类别一致；空值、缺值、字符串数字和布尔值不会悄悄转换或补齐。支持 1–4 个面板，每面板最多 5 个系列。

- `bar`：类别柱图，纵轴包含零；不接受裁掉数据的范围。
- `paired`：恰好两个系列的成对点图，类别共用横轴与连接线；仅用于同口径前后对照。
- `line`：须指定结果 JSON 中真实参数数组的 `x_field`，严格递增；连线仅连接实际计算点，不是额外样本。
- `scale_group`：可将同单位面板放在同一尺度组，程序统一纵轴范围。不同单位不可共享尺度。

`locale` 为 `zh` 或 `en`，仅控制字体选择，不翻译数据标签。`width_mm` 为最终排版宽度，范围 80–210。脚本记录实际字体和导出尺寸；中文字体缺失会报错，不能以方框字符假装已完成。

来源清单记录结果与配方哈希、字段和原始数值、单位、恒等变换、实际图文件哈希。它不是正式运行回执；须再通过 `result_files` 和 `claim_trace` 接入现有验收。
