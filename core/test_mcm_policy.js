'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { createProfile, sessionFields } = require('./project_contest');
const workflow = require('./contest_workflows');
const registry = require('./contest_packages');
const policy = require('./mcm_policy');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-mcm-policy-'));
const rules = { source: policy.SOURCE_2027 + ' §§III/IV/VI; ' + policy.AI_POLICY + ' p2', profile: 'mcm-icm-2027',
  max_body_pages: 25, max_file_bytes: 24999999 };
function session() {
  const profile = createProfile({ contest_kind: 'mcm-icm', edition: '2027', stage: 'contest', track: 'D', control_number: '1234567', contest_rules: rules });
  return { title: '2027 MCM/ICM D', ...sessionFields(profile) };
}
function compile(name, tex, extra = {}) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'main.tex'), tex);
  for (const [rel, value] of Object.entries(extra)) {
    const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  }
  const run = spawnSync('xelatex', ['-halt-on-error', '-interaction=nonstopmode', 'main.tex'], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(run.status, 0, `${name}: ${String(run.stdout).slice(-2500)}`);
  const pdf = path.join(dir, 'main.pdf');
  const output = spawnSync('python', [path.join(repo, 'core', 'paper_pdf_audit.py'), pdf, JSON.stringify(workflow.paperPolicy(session()))],
    { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
  assert.equal(output.status, 0, String(output.stderr));
  const metadata = JSON.parse(output.stdout.trim()); assert(metadata.mcm, JSON.stringify(metadata));
  return { tex, pdf: metadata, pdfBytes: fs.statSync(pdf).size, session: session(), root: dir, texPath: 'main.tex' };
}
function validTex() {
  return fs.readFileSync(path.join(repo, 'contest_packages', 'mcm-icm', 'paper', 'main.tex'), 'utf8')
    .replaceAll('TO\\_VERIFY\\_CONTROL', '1234567').replaceAll('TO\\_VERIFY\\_EDITION', '2027').replaceAll('TO\\_VERIFY\\_PROBLEM', 'D')
    .replace('State the actual results, method, evidence and limitations for this problem. Replace this instruction and verify that this entire sheet fits on page one.',
      'We compare two candidate locations against a stated travel-time objective. The recommendation is conditional on the given demand weights.')
    .replace('Restate the actual task and identify data sources, units and limitations.',
      'The team evaluates the two given locations with travel times measured in minutes.')
    .replace('Report the executable model, baseline, comparisons and checks.',
      'A direct enumeration compares the candidate locations. AI-assisted drafting was recorded and verified by the team.\\cite{ai-use}')
    .replace('List sources actually cited in the text, including the AI tools used and their purpose when applicable.',
      '\\begin{thebibliography}{9}\\bibitem{ai-use} OpenAI. AI-assisted drafting and code review; team checked calculations and citations.\\end{thebibliography}')
    .replace('\\end{document}', '\\clearpage\n\\section*{Report on Use of AI Tools}\nThe team used an AI assistant for drafting and code review. Actual prompts and outputs must be provided from the retained log before submission.\n\\end{document}');
}
(async () => {
try {
  assert.equal(registry.detectPackage({ title: '2027 MCM/ICM D' }).id, 'mcm-icm');
  assert.equal(workflow.mathSkill('deepseek', session()), 'contest-modeling-generic');
  assert(workflow.skillChain('deepseek', 'contest-modeling-generic', session()).includes('contest-modeling-generic'));
  assert(workflow.skillChain('deepseek', 'contest-modeling-generic', { contest_kind: 'generic' }).includes('contest-modeling-generic'));
  const controlChanged = structuredClone(session()); controlChanged.contest_identity.control_number = '7654321';
  assert.notEqual(workflow.auditPolicy(controlChanged), workflow.auditPolicy(session()), 'team header identity must invalidate old PDF audit');
  assert.deepEqual(workflow.rulesBlockers({ ...session(), contest: true }), []);
  assert.throws(() => createProfile({ contest_kind: 'mcm-icm', edition: '2028', contest_rules: rules }), /年份冲突/);
  assert.throws(() => createProfile({ contest_kind: 'mcm-icm', edition: '2027', control_number: 'ABC' }), /控制号/);
  assert.equal(registry.getPackage('mcm-icm').rules.paper.toc_required, false);
  assert.equal(workflow.supportPolicy(session()).max_bytes, null, 'COMAP single-PDF rule must not invent a support ZIP size cap');

  const good = compile('valid', validTex());
  const { buildPaper } = require('./tools');
  const { Sandbox } = require('./sandbox');
  const runDir = path.join(root, 'runtime'); fs.mkdirSync(runDir); fs.copyFileSync(path.join(root, 'valid', 'main.tex'), path.join(runDir, 'main.tex'));
  const built = await buildPaper({ workspace: runDir, sandbox: new Sandbox(runDir), session: session(), children: new Set() }, 'main.tex', { passes: 1 });
  assert(built.ok, built.errors);
  assert.deepEqual(built.audit.filter(x => x.startsWith('【必须修】')), [], built.audit.join('\n'));
  const errors = policy.auditPaper(good.tex, good).filter(x => x.startsWith('【必须修】'));
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.equal(good.pdf.mcm.headings.find(x => x.text === 'Summary Sheet').page, 1);
  assert(good.pdf.mcm.headings.some(x => x.text === 'Report on Use of AI Tools'));
  assert(good.pdf.pages >= 3);
  const noReport = compile('no-report', validTex().replace('\\clearpage\n\\section*{Report on Use of AI Tools}\nThe team used an AI assistant for drafting and code review. Actual prompts and outputs must be provided from the retained log before submission.\n', ''));
  assert.match(policy.auditPaper(noReport.tex, noReport).join(' '), /缺单独.*Report on Use of AI/);
  const fakePhrase = noReport.tex.replace('\\end{document}', '\\section{Discussion}\nReport on Use of AI Tools\\end{document}');
  const fake = compile('fake-report', fakePhrase);
  assert.match(policy.auditPaper(fake.tex, fake).join(' '), /缺单独.*Report on Use of AI/);
  const summarySpill = compile('summary-spill', validTex().replace('The recommendation is conditional on the given demand weights.',
    'The recommendation is conditional on the given demand weights. ' + 'A long, unverified paragraph must not be submitted. '.repeat(420)));
  assert.match(policy.auditPaper(summarySpill.tex, summarySpill).join(' '), /摘要页未单独占第 1 页/);
  const wrongHeader = compile('wrong-header', validTex().replace('\\fancyhead[L]{Team Control Number: 1234567}', '\\fancyhead[L]{Team Control Number: 7654321}'));
  assert.match(policy.auditPaper(wrongHeader.tex, wrongHeader).join(' '), /页眉缺对应团队控制号/);
  const alternate = compile('alternate-heading', validTex().replace('Report on Use of AI Tools}', 'Report on Use of AI}'));
  assert.deepEqual(policy.auditPaper(alternate.tex, alternate).filter(x => x.startsWith('【必须修】')), []);
  const inputTail = '\\clearpage\n\\section*{Report on Use of AI Tools}\nThe team used an AI assistant for drafting; its actual inputs and outputs need team verification.\n';
  const inputTex = validTex().replace('\\clearpage\n\\section*{Report on Use of AI Tools}\nThe team used an AI assistant for drafting and code review. Actual prompts and outputs must be provided from the retained log before submission.\n', '\\input{sections/ai-use}\n');
  const included = compile('included-report', inputTex, { 'sections/ai-use.tex': inputTail });
  assert.deepEqual(policy.auditPaper(included.tex, included).filter(x => x.startsWith('【必须修】')), []);
  assert.match(policy.auditPaper(included.tex, { ...included, root: path.join(root, 'missing') }).join(' '), /章节依赖无法核验/);

  const sourceOverflow = validTex().replace('\\clearpage\n\\section*{Report on Use of AI Tools}',
    '\\clearpage\n' + 'Additional explanation and sources.\\clearpage\n'.repeat(25) + '\\section*{Report on Use of AI Tools}');
  const over = compile('over', sourceOverflow);
  assert.match(policy.auditPaper(over.tex, over).join(' '), /超出.*25 页/);
  const aiLong = validTex().replace('Actual prompts and outputs must be provided from the retained log before submission.',
    'Actual prompts and outputs must be provided from the retained log before submission.\\clearpage\n' + 'AI output record.\\clearpage\n'.repeat(28));
  const long = compile('ai-long', aiLong);
  assert(long.pdf.pages > 25);
  assert.doesNotMatch(policy.auditPaper(long.tex, long).filter(x => x.startsWith('【必须修】')).join(' '), /超出.*25 页/);
  const small = { ...good, pdfBytes: 25_000_000 };
  assert.match(policy.auditPaper(good.tex, small).join(' '), /PDF 不得达到或超过 25 MB/);

  const letter = { kind: 'letter', problem_id: 'D', heading: 'Letter to the Club Owners',
    source: { url: 'https://www.contest.comap.com/undergraduate/contests/mcm/contests/2026/problems/2026_ICM_Problem_D.pdf', page: 4 },
    min_pages: 1, max_pages: 2 };
  assert.deepEqual(policy.validateProblemDeliverables([letter], { edition: '2026', track: 'D' }), [letter]);
  assert.throws(() => policy.validateProblemDeliverables([letter], { edition: '2027', track: 'D' }), /年份/);
  assert.throws(() => policy.validateProblemDeliverables([{ ...letter, source: { ...letter.source, page: 0 } }], { edition: '2026', track: 'D' }), /problem_deliverables/);
  const letterText = validTex().replace('\\section*{References}', '\\clearpage\\section*{Letter to the Club Owners}\nDear owner, this one-page letter gives the requested summary.\\clearpage\\section*{References}');
  const letterPdf = compile('sourced-letter', letterText);
  const dated = { ...letterPdf, session: { ...letterPdf.session, contest_identity: { ...letterPdf.session.contest_identity, edition: '2026' },
    contest_rules: { profile: 'mcm-icm-2026', source: letter.source.url + ' p4', problem_deliverables: [letter] } } };
  assert.doesNotMatch(policy.auditPaper(letterPdf.tex, dated).join(' '), /Letter to the Club Owners|实测约.*页|豁免区/);
  assert.match(policy.auditPaper(noReport.tex, { ...dated, tex: noReport.tex, pdf: noReport.pdf }).join(' '), /Letter to the Club Owners/);
  const future = { ...good, session: { ...good.session, contest_identity: { ...good.session.contest_identity, edition: '2028' } } };
  assert.match(policy.auditPaper(good.tex, future).join(' '), /规则待核对/);
  assert.doesNotMatch(policy.auditPaper(good.tex, future).join(' '), /25 页上限|超出/);
  assert.match(workflow.rulesBlockers({ ...future.session, contest_rules: { source: 'unverified', profile: 'mcm-icm-2028' } }).join(' '), /无已核实赛事档/);
  if (process.env.XIHE_MCM_EVIDENCE_DIR) {
    const target = path.resolve(process.env.XIHE_MCM_EVIDENCE_DIR);
    assert(target.startsWith(path.join(repo, 'audit') + path.sep));
    fs.mkdirSync(target, { recursive: true });
    for (const dir of ['valid', 'included-report', 'over', 'ai-long', 'summary-spill', 'sourced-letter']) {
      fs.cpSync(path.join(root, dir), path.join(target, dir), { recursive: true });
    }
    const outcomes = { kind: 'synthetic_format_rehearsal', official_source: policy.SOURCE_2027, ai_policy: policy.AI_POLICY,
      valid: { pages: good.pdf.pages, audit: policy.auditPaper(good.tex, good), mcm_pdf: good.pdf.mcm },
      included_report: { pages: included.pdf.pages, audit: policy.auditPaper(included.tex, included) },
      summary_spill: { pages: summarySpill.pdf.pages, audit: policy.auditPaper(summarySpill.tex, summarySpill) },
      over_limit: { pages: over.pdf.pages, audit: policy.auditPaper(over.tex, over) },
      ai_report_pages: { pages: long.pdf.pages, audit: policy.auditPaper(long.tex, long) },
      letter: { pages: letterPdf.pdf.pages, audit: policy.auditPaper(letterPdf.tex, dated) } };
    fs.writeFileSync(path.join(target, 'format-audit.json'), JSON.stringify(outcomes, null, 2));
  }
  console.log('PASS MCM/ICM 2027 package: actual PDF Summary Sheet, header, English AI tail, counted pages, source limits, edition isolation and sourced letter');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch(error => { console.error(error); process.exitCode = 1; });
