# MCM/ICM 赛事包（已核实 2027 通用条款）

2026-11-14。`mcm-icm` 是独立赛事包。输入 `2027 MCM/ICM` 可识别该包；项目档案须选择届次 `2027`、赛题字母及已获分配的团队控制号，登记有来源的 `mcm-icm-2027` 规则。题目尚未发布前，不登记 2027 题面专属信函或备忘录。未知或以后的届次不继承 2027 的页数和提交断言。

2027 已确认的格式来源：[COMAP MCM/ICM Instructions，第 III、IV、VI 节](https://www.contest.comap.com/undergraduate/contests/mcm/instructions.php)、[FAQ](https://www.contest.comap.com/undergraduate/contests/mcm/faq.php)、[AI Policy v102025，第 2 页](https://www.contest.comap.com/undergraduate/contests/mcm/flyer/Contest_AI_Policy.pdf)。应以赛时实际发布的规则及所选题面核对。

```json
{
  "contest_kind": "mcm-icm",
  "edition": "2027",
  "stage": "contest",
  "track": "D",
  "control_number": "1234567",
  "contest_rules": {
    "source": "COMAP 2027 MCM/ICM Instructions III/IV/VI; AI Policy v102025 p.2",
    "profile": "mcm-icm-2027",
    "max_body_pages": 25,
    "max_file_bytes": 24999999
  }
}
```

示例控制号只是演示，不能用于提交。项目方案导出/导入保存团队控制号和届次，新会话继承。仅更改控制号会保留同届已登记规则，但现有论文 PDF 须重新编译验收。

通用提交为 **单个英文 PDF**，第 1 页是单页 Summary Sheet。25 页限额包括 Summary Sheet、解答、目录、参考文献、附录、源码和题目指定交付物。正文可读文字至少 12 pt；每页顶部应有团队控制号与页码；除了控制号，不应出现队员、指导教师或机构身份。最终 PDF 以控制号命名，大小严格小于 25 MB。目录通常受鼓励；当前题面若明确要求则按题面登记。羲和内部 ZIP 是复现档案，不是 COMAP 的提交附件。

使用 AI 时，应在正文和参考文献准确说明工具与用途，并在**同一个 PDF 的末尾**加入 AI 使用报告。赛事说明写 `Report on Use of AI`，专项政策写 `Report on Use of AI Tools`，两种标题均接受。只有可识别的末尾报告区页数不计入 25 页；报告与正文共页时，该页仍计入正文。译文软件、代码补全也可能属于需披露用途。自动草稿不能自证队员核验，也不能代替实际提示、输出和引用记录。

现有 PDF 审计实测标题所在页、页眉、可读正文文字大小、Summary Sheet 单页、AI 报告位置和正文实际计页。源码可将正文或报告放在工作区内的静态 `\input{...}` 或 `\include{...}` 子文件；越界链接、循环及超大文件会阻止版式认证。文字识别只能辅助匿名和表达复核，最终仍需参赛队逐页检查。

题面专属交付物只有在实际题面要求且登记 `problem_deliverables` 后才硬验。每条需注明 `letter`/`memo`、赛题字母、该文档的实际英文标题、COMAP 题面 URL 和页码、页数范围；年份和题号不得与项目不符。公开回归样例：[2026 ICM D，第 4 页的给球队所有者和总经理的 1–2 页信函](https://www.contest.comap.com/undergraduate/contests/mcm/contests/2026/problems/2026_ICM_Problem_D.pdf)；[2025 ICM F，第 2 页的给非技术政策制定者的 1 页备忘录](https://www.contest.comap.com/undergraduate/contests/mcm/contests/2025/problems/2025_ICM_Problem_F.pdf)。这些不是 2027 题面要求，也不是封存盲评材料。

官方 [LaTeX Summary 模板](https://www.contest.comap.com/undergraduate/contests/mcm/flyer/MCM-ICM_Summary.tex) 在核查时文件注释写 2027，但渲染标题仍写 2026。本包自行提供可编辑骨架，保留待核届次与控制号占位；不据旧模板生成错误年份。

`node core/test_mcm_policy.js` 实际用 XeLaTeX 编译正反例：单页英文摘要、文末 AI 报告两种标题、独立子文件、超 25 页正文、AI 报告超过 25 页但正文未超、摘要溢页、页眉控制号、无章节的假报告和有来源的历史信函。用 `paper_build` 的真实入口额外验证同一规则链。原有国赛与 MathorCup 测试仍分别执行。本测试是**合成格式验收**，不证明一篇陌生完整赛题的建模质量、实际参赛提交或人工审核完成。
