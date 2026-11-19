# Third-Party Notices

本项目自身代码以 MIT 许可发布。下列组件、字体与资料由第三方提供，遵循各自许可；本文件不改变其许可条款。

## 运行时

- **Electron**（MIT）。便携包 `runtime/` 内为 Electron 官方发行文件；Chromium 及其内置第三方组件的完整许可文本见 `runtime/LICENSES.chromium.html`。
- **Node.js**（MIT）。随 Electron 内置。

## 随包服务

- **open-websearch 2.1.11**（Apache License 2.0）。位于 `vendor/open-webSearch/`，包含其 `LICENSE` 与 `node_modules` 依赖。本项目未修改其搜索逻辑，仅作为本地守护进程调用。
- **academic-search MCP server**（MIT，与本项目同许可）。位于 `vendor/academic-search-mcp/server.js`，零依赖，仅访问 Crossref / arXiv 公开元数据接口。

## 字体

- **Fira Code / Nerd Fonts 补丁版**（SIL Open Font License 1.1）。
- **Source Han Serif CN**（SIL Open Font License 1.1）。

字体文件位于 `templates/` 与 `contest_packages/`，仅用于 LaTeX 模板排版。

## 模板

- **cumcmthesis.cls v2.6**：公开的全国大学生数学建模竞赛 LaTeX 模板，版权归原作者所有，按其原始分发条件使用。若权利人要求移除，请通过仓库 Issue 联系。

## 知识库资料

- **竞赛规则、评阅要点、AI 工具使用规定**：版权归全国大学生数学建模竞赛组委会等原发布方所有，随包仅作本地检索与写作参考，不构成官方发布渠道；请以官方最新文件为准。
- **公开范文文本索引**：版权归各原文作者所有，仅作本地检索与写法参考，不证明奖级，也不代表当前题结论。公开再分发前请自行确认授权；权利人可要求移除。
- **方法建议与词表**：为本项目整理的公开方法摘要，不含个人身份信息。

## 可选依赖

- **PyMuPDF**（AGPL-3.0）：仅 `scripts/ingest_apmcm.py` 在用户自行安装后使用，不随包分发。使用与再分发须遵守 AGPL。
- **MATLAB / TeX Live / draw.io**：由用户本机另行安装，不在本仓库分发。

如发现许可或归属问题，请通过仓库 Issue 联系处理。