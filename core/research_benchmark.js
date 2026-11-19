'use strict';

// This module grades supplied answers. It never runs an agent or checks a proof.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUSES = new Set(['answered', 'conditional', 'infeasible', 'insufficient_evidence']);
const ANSWER_KEYS = new Set(['case_id', 'status', 'decision', 'claim_scope', 'quantities', 'next_actions', 'artifacts', 'explanation']);
const PROJECTION_KEYS = new Set(['status', 'decision', 'claim_scope', 'quantities']);
const CASE_KEYS = new Set(['id', 'family', 'prompt', 'materials', 'output_contract']);
const METADATA_KEYS = new Set(['variant', 'model', 'time_budget_ms', 'tool_call_budget']);
const LIMITATIONS = [
  'Grades supplied structured answers only; this grader does not run a model.',
  'Does not verify mathematical derivations, data provenance, or execution.',
  'Artifact checks compare structured projections; natural-language summary and captions are not understood.',
  'This is a development check, not a blind expert evaluation.',
];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const unexpected = (value, allowed) => Object.keys(value).filter(key => !allowed.has(key));

function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('cases must be a nonempty array');
  const ids = new Set();
  for (const row of cases) {
    if (!isObject(row) || typeof row.id !== 'string' || !row.id.trim() ||
        typeof row.family !== 'string' || !row.family.trim() ||
        typeof row.prompt !== 'string' || !row.prompt.trim() || !own(row, 'materials')) {
      throw new Error('invalid case: id, family, prompt, materials required');
    }
    if (unexpected(row, CASE_KEYS).length) throw new Error(`unexpected case fields: ${row.id}`);
    if (ids.has(row.id)) throw new Error(`duplicate case: ${row.id}`);
    ids.add(row.id);
  }
  return ids;
}

function validateRubrics(rubrics, caseIds) {
  if (!Array.isArray(rubrics)) throw new Error('rubrics must be an array');
  const byId = new Map();
  for (const row of rubrics) {
    if (!isObject(row) || typeof row.case_id !== 'string') throw new Error('invalid rubric case_id');
    if (byId.has(row.case_id)) throw new Error(`duplicate rubric: ${row.case_id}`);
    if (!caseIds.has(row.case_id)) throw new Error(`rubric for unknown case: ${row.case_id}`);
    if (!isObject(row.expect) || !STATUSES.has(row.expect.status) ||
        !(typeof row.expect.decision === 'string' || row.expect.decision === null) ||
        typeof row.expect.claim_scope !== 'string') throw new Error(`invalid rubric expect: ${row.case_id}`);
    if (!isObject(row.quantities)) throw new Error(`invalid rubric quantities: ${row.case_id}`);
    if (row.accepted_statuses != null && (!Array.isArray(row.accepted_statuses) || !row.accepted_statuses.length
        || row.accepted_statuses.some(status => !STATUSES.has(status)) || !row.accepted_statuses.includes(row.expect.status))) {
      throw new Error(`invalid rubric accepted_statuses: ${row.case_id}`);
    }
    if (row.optional_quantities != null && !isObject(row.optional_quantities)) throw new Error(`invalid optional quantities: ${row.case_id}`);
    for (const [key, spec] of Object.entries({ ...row.quantities, ...(row.optional_quantities || {}) })) {
      if (!isObject(spec) || typeof spec.value !== 'number' || !Number.isFinite(spec.value) ||
          (own(spec, 'tolerance') && (typeof spec.tolerance !== 'number' || !Number.isFinite(spec.tolerance) || spec.tolerance < 0))) {
        throw new Error(`invalid rubric quantity: ${row.case_id}/${key}`);
      }
    }
    for (const key of ['required_actions', 'forbidden_actions', 'forbidden_quantities']) {
      if (!Array.isArray(row[key]) || row[key].some(item => typeof item !== 'string' || !item)) {
        throw new Error(`invalid rubric ${key}: ${row.case_id}`);
      }
    }
    if (own(row, 'artifacts') && (!Array.isArray(row.artifacts) || row.artifacts.some(name => !['summary', 'figure_caption'].includes(name)))) {
      throw new Error(`invalid rubric artifacts: ${row.case_id}`);
    }
    byId.set(row.case_id, row);
  }
  for (const id of caseIds) if (!byId.has(id)) throw new Error(`missing rubric: ${id}`);
  return byId;
}

function validateProjection(value, label, issues, allowed = PROJECTION_KEYS) {
  if (!isObject(value)) { issues.push(`${label}: missing or invalid structured projection`); return false; }
  const extra = unexpected(value, allowed);
  if (extra.length) issues.push(`${label}: unexpected fields ${extra.join(', ')}`);
  if (!STATUSES.has(value.status)) issues.push(`${label}: invalid status`);
  if (!(typeof value.decision === 'string' || value.decision === null)) issues.push(`${label}: invalid decision`);
  if (typeof value.claim_scope !== 'string') issues.push(`${label}: invalid claim_scope`);
  if (!isObject(value.quantities)) issues.push(`${label}: invalid quantities`);
  else for (const [key, number] of Object.entries(value.quantities)) {
    if (typeof number !== 'number' || !Number.isFinite(number)) issues.push(`${label}: ${key} must be a finite number`);
  }
  return true;
}

function gradeAnswer(answer, rubric) {
  const issues = [];
  if (!isObject(answer)) return ['answer must be an object'];
  const extra = unexpected(answer, ANSWER_KEYS);
  if (extra.length) issues.push(`unexpected answer fields: ${extra.join(', ')}`);
  validateProjection(answer, 'answer', issues, ANSWER_KEYS);
  if (!Array.isArray(answer.next_actions) || answer.next_actions.some(action => typeof action !== 'string' || !action)) {
    issues.push('next_actions must be an array of nonempty strings');
  }
  if (own(answer, 'explanation') && typeof answer.explanation !== 'string') issues.push('invalid explanation');
  for (const key of ['status', 'decision', 'claim_scope']) {
    const matches = key === 'status' ? (rubric.accepted_statuses || [rubric.expect.status]).includes(answer[key]) : answer[key] === rubric.expect[key];
    if (!matches) issues.push(`${key}: expected ${JSON.stringify(rubric.expect[key])}`);
  }
  if (isObject(answer.quantities)) {
    for (const key of Object.keys(answer.quantities)) {
      if (!own(rubric.quantities, key) && !own(rubric.optional_quantities || {}, key) && !rubric.forbidden_quantities.includes(key)) issues.push(`unreviewed quantity: ${key}`);
    }
    for (const [key, spec] of Object.entries(rubric.quantities)) {
      if (!own(answer.quantities, key)) issues.push(`missing quantity: ${key}`);
      else if (typeof answer.quantities[key] === 'number' && Number.isFinite(answer.quantities[key]) &&
               Math.abs(answer.quantities[key] - spec.value) > (spec.tolerance ?? 1e-9)) {
        issues.push(`quantity ${key}: outside absolute tolerance`);
      }
    }
    for (const key of rubric.forbidden_quantities) if (own(answer.quantities, key)) issues.push(`forbidden quantity: ${key}`);
    for (const [key, spec] of Object.entries(rubric.optional_quantities || {})) {
      if (own(answer.quantities, key) && typeof answer.quantities[key] === 'number' && Math.abs(answer.quantities[key] - spec.value) > (spec.tolerance ?? 1e-9)) issues.push(`optional quantity ${key}: outside absolute tolerance`);
    }
  }
  if (Array.isArray(answer.next_actions)) {
    for (const action of rubric.required_actions) if (!answer.next_actions.includes(action)) issues.push(`missing action: ${action}`);
    for (const action of rubric.forbidden_actions) if (answer.next_actions.includes(action)) issues.push(`forbidden action: ${action}`);
  }
  if (own(answer, 'artifacts') && !isObject(answer.artifacts)) issues.push('artifacts must be an object');
  if (isObject(answer.artifacts)) {
    for (const name of Object.keys(answer.artifacts)) {
      if (!['summary', 'figure_caption'].includes(name)) issues.push(`unknown artifact: ${name}`);
    }
  }
  const artifactNames = new Set([...(rubric.artifacts || []), ...(isObject(answer.artifacts) ? Object.keys(answer.artifacts) : [])]);
  for (const name of artifactNames) {
    if (!['summary', 'figure_caption'].includes(name)) continue;
    const artifact = isObject(answer.artifacts) ? answer.artifacts[name] : undefined;
    if (!validateProjection(artifact, name, issues)) continue;
    for (const key of ['status', 'decision', 'claim_scope']) {
      if (artifact[key] !== answer[key]) issues.push(`${name}: ${key} differs from answer`);
    }
    if (isObject(artifact.quantities) && isObject(answer.quantities)) {
      const a = Object.keys(artifact.quantities).sort();
      const b = Object.keys(answer.quantities).sort();
      if (JSON.stringify(a) !== JSON.stringify(b) || a.some(key => !Object.is(artifact.quantities[key], answer.quantities[key]))) {
        issues.push(`${name}: quantities differ from answer`);
      }
    }
  }
  return issues;
}

function gradeSuite(cases, rubrics, answers) {
  const ids = validateCases(cases);
  const gold = validateRubrics(rubrics, ids);
  if (!Array.isArray(answers)) throw new Error('answers must be an array');
  const grouped = new Map();
  const unknown = [];
  for (const [index, answer] of answers.entries()) {
    const id = isObject(answer) ? answer.case_id : undefined;
    if (typeof id !== 'string' || !ids.has(id)) {
      unknown.push({ case_id: typeof id === 'string' ? id : `<answer ${index + 1}>`, status: 'fail', issues: ['unknown or missing case_id'] });
    } else {
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(answer);
    }
  }
  const rows = cases.map(row => {
    const found = grouped.get(row.id) || [];
    if (!found.length) return { case_id: row.id, status: 'unverified', issues: ['answer missing'] };
    if (found.length > 1) return { case_id: row.id, status: 'fail', issues: ['duplicate answers'] };
    const issues = gradeAnswer(found[0], gold.get(row.id));
    return { case_id: row.id, status: issues.length ? 'fail' : 'pass', issues };
  }).concat(unknown);
  const passed = rows.filter(row => row.status === 'pass').length;
  const failed = rows.filter(row => row.status === 'fail').length;
  const unverified = rows.filter(row => row.status === 'unverified').length;
  return { mode: 'development', total: rows.length, passed, failed, unverified,
    judgment_pass: rows.length > 0 && failed === 0 && unverified === 0,
    execution_verified: false, blind_evaluation: false, limitations: LIMITATIONS.slice(), cases: rows };
}

function exportVisible(cases, outDir, metadata = {}) {
  validateCases(cases);
  if (typeof outDir !== 'string' || !outDir.trim()) throw new Error('outDir required');
  if (!isObject(metadata) || unexpected(metadata, METADATA_KEYS).length) throw new Error('invalid export metadata');
  for (const key of ['variant', 'model']) if (own(metadata, key) && typeof metadata[key] !== 'string') throw new Error(`invalid metadata ${key}`);
  for (const key of ['time_budget_ms', 'tool_call_budget']) if (own(metadata, key) && (!Number.isSafeInteger(metadata[key]) || metadata[key] < 0)) throw new Error(`invalid metadata ${key}`);
  const visible = JSON.stringify(cases, null, 2) + '\n';
  const digest = crypto.createHash('sha256').update(visible, 'utf8').digest('hex');
  const manifest = JSON.stringify({ schema_version: 1, mode: 'development', visible_sha256: digest,
    case_ids: cases.map(row => row.id), variant: metadata.variant ?? null, model: metadata.model ?? null,
    metadata: { ...metadata } }, null, 2) + '\n';
  fs.mkdirSync(outDir, { recursive: true });
  const files = [['visible-cases.json', visible], ['manifest.json', manifest]];
  for (const [name, content] of files) {
    const target = path.join(outDir, name);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== content) throw new Error(`refusing to overwrite different content: ${target}`);
  }
  for (const [name, content] of files) {
    const target = path.join(outDir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, content, { flag: 'wx' });
  }
  return { outDir: path.resolve(outDir), visible_sha256: digest, case_ids: cases.map(row => row.id) };
}

function cli(argv) {
  const [command, ...rest] = argv;
  if (!['export', 'grade'].includes(command)) throw new Error('usage: research_benchmark.js export --out DIR | grade --answers FILE --out FILE');
  if (rest.length % 2) throw new Error('options require values');
  const options = {};
  const allowed = new Set(command === 'export' ? ['--out', '--cases', '--variant', '--model'] : ['--out', '--answers', '--cases', '--rubrics']);
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.has(rest[i]) || own(options, rest[i]) || !rest[i + 1]) throw new Error(`invalid option: ${rest[i]}`);
    options[rest[i]] = rest[i + 1];
  }
  if (!options['--out']) throw new Error('--out required');
  if (command === 'grade' && !options['--answers']) throw new Error('--answers required');
  const fixtureDir = path.join(__dirname, 'fixtures', 'research_judgment');
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const casesFile = options['--cases'] || path.join(fixtureDir, 'cases.json');
  const cases = readJson(casesFile);
  if (command === 'export') {
    const result = exportVisible(cases, options['--out'], { variant: options['--variant'] || 'unspecified', model: options['--model'] || 'unspecified' });
    process.stdout.write(`Exported ${result.case_ids.length} visible cases; sha256=${result.visible_sha256}\n`);
    return 0;
  }
  const rubricFile = options['--rubrics'] || path.join(fixtureDir, 'rubrics.json');
  const identity = file => {
    const resolved = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if ([casesFile, rubricFile, options['--answers']].some(file => identity(file) === identity(options['--out']))) throw new Error('report output must not overwrite a benchmark input');
  const rubrics = readJson(rubricFile);
  const report = gradeSuite(cases, rubrics, readJson(options['--answers']));
  const digestFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  report.provenance = { cases_sha256: digestFile(casesFile), rubrics_sha256: digestFile(rubricFile), answers_sha256: digestFile(options['--answers']) };
  fs.writeFileSync(options['--out'], JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`Graded ${report.total} supplied cases: passed=${report.passed}, failed=${report.failed}, unverified=${report.unverified}; execution_verified=false; blind_evaluation=false\n`);
  return report.judgment_pass ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = cli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { gradeSuite, exportVisible };
