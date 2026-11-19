'use strict';
const assert = require('assert');
const { auditAbstractStyle, auditReferences, extractBracedCommands } = require('./paper_contract');

const goodAbstract = String.raw`\begin{abstract}
针对问题一，建立\textbf{双层规划模型}，最终选用\textbf{方案B}，总成本\textbf{35126.95元}。
\end{abstract}
\keywords{双层规划；调度策略；总成本}`;
assert.deepStrictEqual(auditAbstractStyle(goodAbstract), []);
assert.deepStrictEqual(extractBracedCommands(String.raw`\textbf{成本\(x_{1}\)为12元}`, ['textbf']).map(x => x.content), [String.raw`成本\(x_{1}\)为12元`]);
assert.deepStrictEqual(extractBracedCommands(String.raw`% \textbf{忽略}
\textbf{有效}`, ['textbf']).map(x => x.content), ['有效']);

const badAbstract = String.raw`\begin{abstract}
\textbf{首先，我们分析了问题。}建立双层规划模型，成本35126.95元。
\end{abstract}
\keywords{数学建模；数学建模}`;
const badWarnings = auditAbstractStyle(badAbstract);
assert(badWarnings.some(x => x.startsWith('【必须修】') && /关键词.*3.?5/.test(x)));
assert(badWarnings.some(x => /重复/.test(x)));
assert(badWarnings.some(x => /套话|过程/.test(x)));
assert(badWarnings.some(x => /模型|算法/.test(x)));
assert(badWarnings.some(x => /数值/.test(x)));
assert(auditAbstractStyle('% \\keywords{甲；乙；丙}', { required: true }).some(x => /摘要/.test(x)));
assert.deepStrictEqual(auditAbstractStyle('普通文本', { required: false }), []);

const md = `# 摘要\n采用**自适应遗传算法**，误差**降低12.5%**，选择**方案B**。\n\n关键词：自适应遗传算法；误差；调度`;
assert.deepStrictEqual(auditAbstractStyle(md), []);
assert.deepStrictEqual(auditAbstractStyle(String.raw`\begin{abstract}\textbf{岭回归模型}的\textbf{R^2=0.96}，误差\textbf{下降12.5\%}。\end{abstract}\keywords{岭回归模型；拟合优度；误差}`), []);
assert.deepStrictEqual(auditAbstractStyle(String.raw`\begin{abstract}建立\textbf{动态规划模型}，成本\textbf{降低12.5\%}。\noindent\textbf{关键词：}抽样检验；动态规划；成本\end{abstract}`), []);
assert.deepStrictEqual(auditAbstractStyle(String.raw`\begin{abstract}使用\textbf{XGBoost}，得到\textbf{最优解x=15}。\end{abstract}\keywords{XGBoost；决策变量；成本}`), []);

const refs = String.raw`正文\citep[见][第2页]{jiang, si}，并参考\citet{work}。
% \cite{ghost}
\begin{thebibliography}{9}
\bibitem{jiang} 姜启源. 数学模型[M]. 北京: 高等教育出版社, 2018.
\bibitem[司守奎(2011)]{si} 司守奎. 数学建模算法与应用[M]. 北京: 国防工业出版社, 2011.
\bibitem{work} Author. A paper[J]. Journal, 2020, 2(1): 1-9.
\end{thebibliography}
\appendix
\cite{ghost}`;
const refWarnings = auditReferences(refs);
assert(refWarnings.some(x => /6.?10/.test(x)));
assert(!refWarnings.some(x => /未引用|未定义|教材/.test(x)));
const brokenRefs = String.raw`正文\cite{missing}\begin{thebibliography}{9}\bibitem{one} A\bibitem{one} B\end{thebibliography}`;
const broken = auditReferences(brokenRefs);
assert(broken.some(x => /未定义/.test(x)));
assert(broken.some(x => /重复/.test(x)));
assert(broken.some(x => /未在正文引用/.test(x)));
assert(broken.some(x => /教材/.test(x)));
const codeOnly = String.raw`\verb|\cite{one}|\begin{lstlisting}\cite{one}\end{lstlisting}\begin{verbatim}\cite{one}\end{verbatim}\begin{thebibliography}{9}\bibitem{one} A\end{thebibliography}`;
assert(auditReferences(codeOnly).some(x => /未在正文引用/.test(x)));
const supplied = String.raw`正文说明题目第2页及附件1字段；\cite{problem, data, external}\begin{thebibliography}{9}
\bibitem{problem} 全国大学生数学建模竞赛组委会. 2025年A题竞赛题目[EB/OL].
\bibitem{data} 题目随题附件1：观测数据.xlsx[DB/OL].
\bibitem{external} 全国大学生数学建模竞赛组委会. 数学建模教育研究报告[R]. 2024.
\end{thebibliography}`;
const suppliedWarnings = auditReferences(supplied);
assert(suppliedWarnings.some(x => /题面.*附件|随题材料/.test(x) && /problem.*data/.test(x)), '题面和随题附件不应进入参考文献');
assert(suppliedWarnings.some(x => /当前1篇/.test(x)), '本机6-10篇目标只统计独立外部文献');
assert(!suppliedWarnings.some(x => /题面.*external|随题材料.*external/.test(x)), '组委会另行出版的报告不能按题面误判');
assert(!auditReferences(supplied, { source: '当届规则第5条', problem_materials_in_references: true }).some(x => /题面.*附件|随题材料/.test(x)), '有来源的当届明文规则可例外');
assert(suppliedWarnings.some(x => /^【待人工核验】/.test(x) && /随题材料/.test(x)), '疑似材料只能提示回读，不能自动认定违规');
assert(auditReferences(supplied, { problem_materials_in_references: true }).some(x => /随题材料/.test(x)), '无来源的规则开关不能免除核实');
const externalOnly = String.raw`正文\cite{paper, dataset}\begin{thebibliography}{9}
\bibitem{paper} 张某. 数学建模竞赛题目及附件的教学研究[J]. 教育研究, 2025.
\bibitem{dataset} 国家统计局. 统计数据附件说明[DB/OL]. 2024.
\end{thebibliography}`;
assert(!auditReferences(externalOnly).some(x => /随题材料/.test(x)), '外部研究论文或外部数据的题目/附件字样不单独触发');
console.log('paper contract tests passed');
