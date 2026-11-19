'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const gain = require('./skill_gain');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-skill-gain-'));
const H = value => sha(String(value));
const baseline = { skills: [{ slot: 'main', name: 'default', sha256: H('default-v1'), mode: 'replace' }], plugins: [] };
const candidate = { skills: [{ slot: 'main', name: 'default', sha256: H('default-v1'), mode: 'replace' },
  { slot: 'research', name: 'method', sha256: H('method-v1'), mode: 'append' }], plugins: [] };
const context = { model: { id: 'provider:model-v1', reasoning: 'medium', config_sha256: H('model-config') },
  problem_family: 'optimization', stage: 'solve', task_sha256: H('task-v1'), data_sha256: H('data-v1'),
  runtime_sha256: H('runtime-v1'), metric: { name: 'accuracy', unit: 'points', protocol: 'fixed-holdout-v1', direction: 'max' },
  budget: { wall_time_ms: 5000, token_limit: 100, tool_call_limit: 2 } };
const trials = ['a', 'b'].map(id => ({ id, task_sha256: context.task_sha256, data_sha256: context.data_sha256 }));
const key = crypto.randomBytes(32);
const attest = digest => crypto.createHmac('sha256', key).update(digest).digest('hex');
const verifyAttestation = (digest, signature) => signature === attest(digest);
const execute = async ({ arm, trial }) => {
  // Real executable fixture, still only a development observation.
  const script = `process.stdout.write(JSON.stringify({ score: ${arm === 'candidate' ? 9 : 7}, trial: ${JSON.stringify(trial.id)} }))`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 1000 });
  if (child.status !== 0) throw new Error(child.stderr || 'fixture failed');
  return { artifact: child.stdout, usage: { tokens: 10, tool_calls: 1 } };
};
const grade = ({ artifact }) => JSON.parse(artifact.toString()).score;
const query = (more = {}) => ({ combination: candidate, baseline, context, verifyAttestation, ...more });

(async () => {
  assert.equal(gain.summarize(root, query()).status, 'unverified');
  assert.equal(gain.summarize(root, { combination: candidate, context, verifyAttestation }).status, 'unverified');
  const dev = await gain.run({ root, protocol: { kind: 'development', context, seed: 12 }, baseline, candidate, trials, execute, grade });
  assert.equal(dev.outcome.status, 'observed_gain');
  assert.equal(gain.summarize(root, query()).status, 'unverified', 'development fixture cannot justify recommendation');
  assert.equal(gain.summarize(root, { combination: candidate, baseline, context: null }).status, 'unverified');
  assert.equal(gain.inspect(dev.root, verifyAttestation).status, 'development');
  await assert.rejects(gain.run({ root, protocol: { kind: 'empirical', context, seed: 12 }, baseline, candidate,
    trials, execute, grade, attest: () => { throw new Error('signing failed'); } }), /signing failed/);
  assert(!fs.readdirSync(root).some(name => name.startsWith('.pending-')), 'failed publication leaves no incomplete record');
  const nested = trials.map(row => ({ ...row, input: { fixed: 1 } }));
  const seen = [];
  await gain.run({ root, protocol: { kind: 'development', context, seed: 12 }, baseline, candidate, trials: nested,
    execute: async input => { seen.push([input.trial.id, input.seed, input.trial.input.fixed]); input.trial.input.fixed = 99; return execute(input); }, grade });
  assert(seen.every(row => row[2] === 1), 'each arm receives independent input values');
  assert.equal(new Set(seen.map(row => row[1])).size, 2, 'paired trials use different reproducible seeds');
  assert.equal(gain.summarize(root, query({ context: { ...context, model: { ...context.model, id: 'provider:other' } } })).status, 'unverified');
  assert.equal(gain.summarize(root, query({ context: { ...context, budget: { ...context.budget, token_limit: 101 } } })).status, 'unverified');
  assert.equal(gain.summarize(root, query({ combination: { ...candidate, skills: candidate.skills.map(row =>
    row.slot === 'research' ? { ...row, sha256: H('method-v2') } : row) } })).status, 'unverified');
  assert.equal(gain.summarize(root, query({ baseline: { ...baseline, skills: [{ ...baseline.skills[0], sha256: H('default-v2') }] } })).status, 'unverified');
  assert.equal(gain.summarize(root, query({ context: { ...context, data_sha256: H('other data') } })).status, 'unverified');
  assert.equal(gain.summarize(root, query({ context: { ...context, runtime_sha256: H('runtime-v2') } })).status, 'unverified');
  await assert.rejects(gain.run({ root, protocol: { kind: 'development', context, seed: 1 }, baseline, candidate,
    trials: [{ ...trials[0], data_sha256: H('changed') }, trials[1]], execute, grade }), /试次题目或数据/);
  const empirical = await gain.run({ root, protocol: { kind: 'empirical', context, seed: 12 }, baseline, candidate,
    trials, execute, grade, attest });
  assert.equal(gain.summarize(root, query()).status, 'observed_gain');
  const noGain = await gain.run({ root, protocol: { kind: 'empirical', context: { ...context,
    metric: { ...context.metric, name: 'other-criterion' } }, seed: 14 }, baseline, candidate,
    trials, execute: async input => ({ artifact: JSON.stringify({ score: input.arm === 'candidate' ? 1 : 2 }),
      usage: { tokens: 10, tool_calls: 1 } }), grade, attest });
  assert.equal(noGain.outcome.status, 'no_gain');
  assert.equal(gain.summarize(root, query({ context: { ...context, metric: { ...context.metric, name: 'other-criterion' } } })).status, 'no_gain');
  assert.equal(gain.summarize(root, query({ verifyAttestation: undefined })).status, 'unverified');
  assert.equal(gain.summarize(root, query({ verifyAttestation: () => false })).status, 'unverified');
  const failed = await gain.run({ root, protocol: { kind: 'empirical', context, seed: 13 }, baseline, candidate, trials,
    execute: async input => input.arm === 'candidate' ? { artifact: '{"score":20}', usage: { tokens: 101, tool_calls: 1 } } : execute(input),
    grade, attest });
  assert.equal(failed.outcome.status, 'inconclusive');
  assert.equal(gain.summarize(root, query()).status, 'inconclusive', 'failure cannot be hidden by another good run');
  const reportFile = path.join(failed.root, 'report.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const artifact = report.payload.observations[0].arms.baseline.artifact;
  fs.appendFileSync(path.join(failed.root, artifact), 'tamper');
  assert.equal(gain.inspect(failed.root, verifyAttestation).status, 'invalid');
  fs.writeFileSync(reportFile, JSON.stringify({ ...report, payload: { ...report.payload, protocol: { ...report.payload.protocol, seed: 99 } } }));
  assert.equal(gain.inspect(failed.root, verifyAttestation).status, 'invalid');
  assert.equal(gain.summarize(root, query()).status, 'inconclusive', 'corrupt negative evidence must not restore a positive conclusion');
  assert.equal(gain.inspect(empirical.root, verifyAttestation).status, 'eligible');
  console.log('PASS Skill gain: paired executable fixture, exact cohort, budget/failure, development isolation, attestation, tamper');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
});
