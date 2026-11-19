'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { TOOLS, auditPaperTex } = require('./tools');
const { Sandbox } = require('./sandbox');
const { rulesBlockers } = require('./contest_workflows');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-mama-delivery-'));
(async () => {
  try {
    const session = { contest_kind: 'mathorcup-bigdata', paper_audit: { must_fix: 0 } };
    const ctx = { session, workspace: root, sandbox: new Sandbox(root) };
    assert(rulesBlockers(session).length > 0);
    const configure = TOOLS.find(t => t.name === 'contest_rules');
    let syncs = 0;
    ctx.deps = { syncProjectRules(s, rules) { assert.equal(s, session); assert(rules.source); syncs++; return '同步成功'; } };
    await assert.rejects(configure.run(ctx, { rules: { max_body_pages: 30 } }), /source/);
    await assert.rejects(configure.run(ctx, { rules: { source: '已读条款', appendix_code_required: 'true' } }), /布尔/);
    assert.equal(syncs, 0, 'invalid rules must not update project');
    await configure.run(ctx, { rules: { source: '本届格式PDF第2页及AI规定第3条', profile: 'mathorcup-bigdata-2026-preliminary', max_body_pages: 30,
      ai_statement_in_body: true, ai_statement_position: 'after_references', appendix_code_required: true } });
    assert.deepEqual(rulesBlockers(session), []);
    assert.equal(session.paper_audit, null);
    assert.equal(syncs, 1, 'validated rules explicitly update project once');
    const state = require('./agent').stateBlock({ ...session, mode: 'math' });
    assert.match(state, /ai_statement_position.*after_references/);
    assert.match(state, /独立复算: 未登记/);
    const wrong = { source: '本届格式PDF第2页及AI规定第3条', max_body_pages: 999,
      appendix_code_required: false, ai_statement_in_body: false, ai_statement_position: 'before_references' };
    await assert.rejects(configure.run(ctx, { rules: wrong }), /届次/);
    await assert.rejects(configure.run(ctx, { rules: { ...wrong, profile: 'mathorcup-bigdata-2026-preliminary' } }), /冲突/);
    assert(rulesBlockers({ ...session, title: '2026 MathorCup大数据', contest_rules: { ...session.contest_rules, profile: 'mathorcup-bigdata-2027-preliminary' } }).some(s => /年份冲突/.test(s)));
    const head = String.raw`\begin{document}
\begin{abstract}结果\end{abstract}\tableofcontents
\section{问题一}结果\cite{a}
\begin{thebibliography}{9}\bibitem{a}真实来源2026\end{thebibliography}
\section*{人工智能工具使用声明}实际情况
\appendix\section{支撑材料}`;
    const opts = { contestFit: true, contestKind: session.contest_kind, rules: session.contest_rules,
      sourceFiles: ['scripts/solve.py'], pdf: { pages: 114, body_pages: 29, appendix_pages: 83, toc_pages: 1, kw_on_p1: true } };
    const onlyName = auditPaperTex(head + '\nscripts/solve.py', opts);
    assert(onlyName.some(s => /^【必须修】附录未通过完整源码/.test(s)), '清单不能冒充源码');
    const full = auditPaperTex(head + '\n\\VerbatimInput{../scripts/solve.py}', opts);
    assert(!full.some(s => /^【必须修/.test(s) && /完整源码|AI.*声明/.test(s)));
    const minted = auditPaperTex(head + '\n\\inputminted{python}{../scripts/solve.py}', opts);
    assert(!minted.some(s => /^【必须修】附录未通过完整源码/.test(s)));
    const excerpt = auditPaperTex(head + '\n\\VerbatimInput[firstline=1,lastline=2]{../scripts/solve.py}', opts);
    assert(excerpt.some(s => /^【必须修】附录未通过完整源码/.test(s)));
    const before = head.replace('\\section*{人工智能工具使用声明}实际情况', '').replace('\\begin{thebibliography}', '\\section*{人工智能工具使用声明}实际情况\n\\begin{thebibliography}');
    assert(auditPaperTex(before, opts).some(s => /^【必须修】.*AI.*之后/.test(s)));
    fs.mkdirSync(path.join(root, 'findings'));
    fs.writeFileSync(path.join(root, 'findings', 'bad.json'), '{}');
    const verify = TOOLS.find(t => t.name === 'independent_verify');
    assert.match(await verify.run(ctx, { manifest: 'findings/bad.json' }), /未通过/);
    assert(session.independent_verification);
    await assert.rejects(TOOLS.find(t => t.name === 'contest_clock').run(ctx, { op: 'phase', phase: 'final' }), /独立复算|目标论文|主解结果/);
    console.log('mama delivery gates: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
