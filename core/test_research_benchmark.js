'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { gradeSuite, exportVisible } = require('./research_benchmark');

const cases = [{ id: 'site-mean', family: 'optimization', prompt: 'Choose the minimum mean time site.',
  materials: { east_share: 0.65 }, output_contract: ['summary', 'figure_caption'] }];
const rubrics = [{ case_id: 'site-mean', expect: { status: 'answered', decision: 'A', claim_scope: 'given data and two sites' },
  quantities: { A_minutes: { value: 7.5 }, B_minutes: { value: 8.6, tolerance: 1e-6 } },
  required_actions: ['compare both sites'], forbidden_actions: ['claim universal optimality'],
  forbidden_quantities: ['unmeasured_demand'], artifacts: ['summary', 'figure_caption'] }];
const projection = { status: 'answered', decision: 'A', claim_scope: 'given data and two sites', quantities: { A_minutes: 7.5, B_minutes: 8.6 } };
const answer = { case_id: 'site-mean', ...projection, next_actions: ['compare both sites'],
  artifacts: { summary: { ...projection, quantities: { ...projection.quantities } },
    figure_caption: { ...projection, quantities: { ...projection.quantities } } } };
const grade = value => gradeSuite(cases, rubrics, value);
const changed = patch => ({ ...answer, ...patch });
const failed = (value, match) => {
  const report = grade([value]);
  assert.equal(report.judgment_pass, false);
  assert.equal(report.failed, 1);
  assert.match(report.cases[0].issues.join('; '), match);
};

const good = grade([answer]);
assert.equal(good.mode, 'development');
assert.equal(good.total, 1);
assert.equal(good.passed, 1);
assert.equal(good.judgment_pass, true);
assert.equal(good.execution_verified, false);
assert.equal(good.blind_evaluation, false);
assert.ok(good.limitations.some(text => /grader does not run a model/i.test(text)));
failed(changed({ claim_scope: 'global optimum' }), /claim_scope/);
failed(changed({ next_actions: ['claim universal optimality'] }), /missing action.*forbidden action/);
failed(changed({ quantities: { A_minutes: 7.5, B_minutes: 8.60001 } }), /outside absolute tolerance/);
failed(changed({ quantities: { ...projection.quantities, unmeasured_demand: 999 } }), /forbidden quantity/);
failed(changed({ artifacts: { ...answer.artifacts, figure_caption: { ...projection, decision: 'B' } } }), /figure_caption: decision/);
failed(changed({ artifacts: { ...answer.artifacts, summary: { ...projection, quantities: { A_minutes: 7.5 } } } }), /summary: quantities differ/);
const optionalArtifactRubric = [{ ...rubrics[0], artifacts: [] }];
assert.equal(gradeSuite(cases, optionalArtifactRubric, [changed({ artifacts: { summary: { ...projection, decision: 'B' } } })]).failed, 1);
failed(changed({ passed: true }), /unexpected answer fields: passed/);
failed(changed({ execution_verified: true }), /unexpected answer fields: execution_verified/);
failed(changed({ quantities: { ...projection.quantities, guessed_input: 0.65 } }), /unreviewed quantity/);
const optional = [{ ...rubrics[0], optional_quantities: { east_share: { value: 0.65 } } }];
const withOptional = { ...answer, quantities: { ...answer.quantities, east_share: 0.65 }, artifacts: undefined };
const projectionWithoutArtifacts = [{ ...optional[0], artifacts: [] }];
delete withOptional.artifacts;
assert.equal(gradeSuite(cases, projectionWithoutArtifacts, [withOptional]).judgment_pass, true);
withOptional.quantities.east_share = 0.5;
assert.equal(gradeSuite(cases, projectionWithoutArtifacts, [withOptional]).judgment_pass, false);
failed(changed({ quantities: { ...projection.quantities, A_minutes: Number.NaN } }), /finite number/);
assert.equal(grade([]).unverified, 1);
assert.equal(grade([answer, answer]).failed, 1);
assert.equal(grade([answer, { ...answer, case_id: 'unknown' }]).failed, 1);
assert.equal(grade([answer, { ...answer, case_id: 'unknown' }]).judgment_pass, false);
assert.throws(() => gradeSuite([...cases, cases[0]], rubrics, [answer]), /duplicate case/);
assert.throws(() => gradeSuite(cases, [...rubrics, rubrics[0]], [answer]), /duplicate rubric/);
assert.throws(() => gradeSuite(cases, [], [answer]), /missing rubric/);
const equivalent = [{ ...rubrics[0], accepted_statuses: ['answered', 'conditional'], artifacts: [] }];
const conditional = { ...answer, status: 'conditional' }; delete conditional.artifacts;
assert.equal(gradeSuite(cases, equivalent, [conditional]).judgment_pass, true);
assert.equal(gradeSuite(cases, equivalent, [{ ...conditional, claim_scope: 'global optimum' }]).judgment_pass, false);
assert.throws(() => gradeSuite(cases, [{ ...rubrics[0], accepted_statuses: ['anything'] }], [answer]), /accepted_statuses/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-benchmark-'));
try {
  const out = path.join(dir, 'visible');
  assert.throws(() => exportVisible(cases, ''), /outDir required/);
  const result = exportVisible(cases, out, { variant: 'skill-only', model: 'held-constant' });
  assert.deepEqual(fs.readdirSync(out).sort(), ['manifest.json', 'visible-cases.json']);
  const visible = fs.readFileSync(path.join(out, 'visible-cases.json'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(JSON.parse(visible), cases);
  assert.equal(manifest.visible_sha256, crypto.createHash('sha256').update(visible).digest('hex'));
  assert.deepEqual(manifest.case_ids, ['site-mean']);
  assert.equal(manifest.variant, 'skill-only');
  assert.equal(result.visible_sha256, manifest.visible_sha256);
  assert.doesNotMatch(visible + JSON.stringify(manifest), /rubric|required_actions|forbidden_actions|7\.5|8\.6/);
  exportVisible(cases, out, { variant: 'skill-only', model: 'held-constant' });
  assert.throws(() => exportVisible([{ ...cases[0], prompt: 'Changed' }], out,
    { variant: 'skill-only', model: 'held-constant' }), /refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(out, 'visible-cases.json'), 'utf8'), visible);
  assert.throws(() => exportVisible(cases, path.join(dir, 'bad'), { gold: 'A' }), /invalid export metadata/);

  const casesFile = path.join(dir, 'cases.json');
  const rubricsFile = path.join(dir, 'rubrics.json');
  const answersFile = path.join(dir, 'answers.json');
  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  fs.writeFileSync(rubricsFile, JSON.stringify(rubrics));
  fs.writeFileSync(answersFile, JSON.stringify([answer]));
  const script = path.join(__dirname, 'research_benchmark.js');
  const cli = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const noAnswers = cli(['grade', '--cases', casesFile, '--rubrics', rubricsFile, '--out', reportFile]);
  assert.equal(noAnswers.status, 1);
  assert.match(noAnswers.stderr, /--answers required/);
  assert.doesNotMatch(noAnswers.stdout, /PASS/);
  const run = cli(['grade', '--cases', casesFile, '--rubrics', rubricsFile, '--answers', answersFile, '--out', reportFile]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(fs.readFileSync(reportFile, 'utf8')).judgment_pass, true);
  const provenance = JSON.parse(fs.readFileSync(reportFile, 'utf8')).provenance;
  assert.equal(provenance.answers_sha256, crypto.createHash('sha256').update(fs.readFileSync(answersFile)).digest('hex'));
  const originalAnswers = fs.readFileSync(answersFile, 'utf8');
  const overwrite = cli(['grade', '--cases', casesFile, '--rubrics', rubricsFile, '--answers', answersFile, '--out', answersFile]);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /must not overwrite/);
  assert.equal(fs.readFileSync(answersFile, 'utf8'), originalAnswers);
  fs.writeFileSync(answersFile, JSON.stringify([]));
  const missing = cli(['grade', '--cases', casesFile, '--rubrics', rubricsFile, '--answers', answersFile, '--out', reportFile]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(reportFile, 'utf8')).unverified, 1);
  const exported = cli(['export', '--cases', casesFile, '--out', path.join(dir, 'cli-visible')]);
  assert.equal(exported.status, 0, exported.stderr);
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert(path.basename(dir).startsWith('xihe-benchmark-'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('research_benchmark tests passed');
