# 羲和建模模板库

界面入口：选择项目 →「模板库 / 方案」→ 选择模板 →「载入模板草稿」→ 保存项目方案 → 新建会话。

`catalog.json` 是独立模板目录，复用已安装的赛事包、主流程、研究技能和论文资源，不重复复制旧模板。通用、国赛、APMCM、美赛及 MathorCup 属于赛事模板；仿真与机理属于方法模板，保留当前赛事规则。切换不同赛事后，旧届次、规则和截止时间清空，须按实际比赛重新登记。

亚太杯新增内容在 `contest_packages/apmcm/`、`skills/contest-modeling-apmcm/` 与 `knowledge/apmcm/`。提供英文论文骨架、四类机制流程及 2022—2025 范文蒸馏；中文赛项和其他届次重新核规则。完整历史资料保留在本机，模板导出只携带选用的 Skill，资料库不随之导出。

新增目录条目需唯一 id、label、description、category、contest_kind、research、figures 和 resources。category=contest 需有效赛事包；category=method 的 contest_kind 为 null。服务端通过现有项目方案校验处理模板，载入只生成草稿；保存与会话快照沿用既有机制。
