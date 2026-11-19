# 赛事包与三档执行能力

快速、深度、极致只决定执行深度、评审和验证强度；不决定赛事规则。先解析赛事包，再组合所选执行档。同一赛事可以使用任一档。

运行时读取 `contest_packages/<id>/manifest.json`，界面从有效包生成选项。显式选择优先；未选择时仅按会话标题匹配，未知或失效包回退 `generic` 并显示提示，不根据项目目录猜赛事。已有稿件不会因切换赛事而覆盖；切换后应重新编译审计。

## 安装接口（schema_version: 1）

每个包同时交付以下内容：

- 身份与届次：manifest 的 `identity.competition/edition/stage`。未知写 `unknown` 或 `to-verify`，不得把往届冒充当届。
- 有来源的规则：`rules.json` 的 `sources` 标注 `official` 或 `user`；说明实际来源，包内证据用相对 `path`。官方规则与本机用户偏好必须分开标记。来源登记不证明已经核验原文。
- 流程 Skill：manifest 的 `skills.default`，可选 `skills.providers`。对应 Skill 安装到应用 `skills/<名称>/SKILL.md`；`workflow.json` 声明各阶段指导、计时策略及按需参考材料。
- 论文模板：manifest 的 `template` 指向包内目录，至少包含 `main.tex` 及其依赖。

示例 manifest：

```json
{
  "schema_version": 1,
  "id": "future-cup",
  "label": "未来挑战赛",
  "identity": {"competition": "FutureCup", "edition": "2027", "stage": "preliminary"},
  "match": {"any": ["未来挑战赛"], "all": []},
  "skills": {"default": "future-cup-workflow", "providers": {}},
  "rules": "rules.json",
  "workflow": "workflow.json",
  "template": "paper"
}
```

新增赛事可复制 `generic` 作为起点，替换以上四部分，安装对应 Skill；无需添加引擎分支。目录 id 用小写字母、数字及短横线。包中只使用声明式 JSON 和资源，不能注入可执行加载代码。资源不得通过路径或符号链接越界。非法非通用包会被跳过并显示诊断，通用包损坏则启动失败。

## 规则与工作流字段

规则的 `required_fields` 和 `profiles` 定义赛前需登记的条款；`contest_rules.source/profile` 绑定会话所用届次和来源。包内已核 profile 的约束不能通过登记放宽。未核页数、文件体积和 AI 声明位置不填写猜测值。

`defaults.support_policy.max_bytes: null` 表示无默认体积上限；正整数字节数必须附 `source`，`exclusive` 表示严格小于。会话中有来源的 `max_support_bytes` 可覆盖默认策略，验收会比较最新策略与已打包记录。

`paper` 定义摘要首页、目录、附录支撑清单、附录标题及 AI 详情的要求；`quality` 仅在本包声明 `paper_quality_profile` 时启用。国赛的本机页数、关键词、文献及教材偏好位于国赛包，并非全国统一官方规定。Mama 的已核条款仅适用于大数据竞赛对应届次与阶段，不能外推到所有 MathorCup 比赛。

`workflow.clock.ratios: null` 表示不按赛程比例自动推进。需要计时策略的包自行声明 baseline/iterate/freeze 比例及可选 `unfreeze_ratio`；截止时间始终使用真实输入。未知赛事先核规则，通用工作流可先读题、审计数据和运行基线。

## 验证

在应用根目录运行 `npm run test:contests` 检查加载、隔离与三档组合；`node core/test_contest_api.js` 通过临时安装合成新赛事验证发现、选择、模板及回退。`npm test` 包含这些检查。模板生成与技术验收不代表人工审核、签署或实际提交已经完成。
