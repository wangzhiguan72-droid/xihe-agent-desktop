'use strict';
const fs = require('fs');
const path = require('path');
const projectPlan = require('./project_plan');
const projectContest = require('./project_contest');
const contests = require('./contest_workflows');
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function load(appDir) {
  const file = path.join(appDir, 'template_library', 'catalog.json');
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schema_version !== 1 || !Array.isArray(data.templates)) throw new Error('模板库版本或目录无效');
  const seen = new Set();
  return data.templates.map(row => {
    if (!row || !ID.test(row.id || '') || seen.has(row.id)
        || typeof row.label !== 'string' || !row.label.trim() || typeof row.description !== 'string'
        || !['contest', 'method'].includes(row.category)
        || (row.category === 'contest' ? !ID.test(row.contest_kind || '') : row.contest_kind !== null)
        || !ID.test(row.research || '') || !ID.test(row.figures || '')
        || !Array.isArray(row.resources) || row.resources.some(rel => typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..'))) {
      throw new Error('模板目录条目无效或重复：' + (row?.id || '?'));
    }
    seen.add(row.id);
    return row;
  });
}

function list(appDir) {
  const installed = new Set(contests.packageRows().map(row => row.id));
  return load(appDir).map(row => ({ ...row, available: row.category === 'method' || installed.has(row.contest_kind) }));
}

function apply(appDir, id, currentPlan, previousProfile) {
  const row = list(appDir).find(row => row.id === id);
  if (!row) throw new Error('未找到模板：' + id);
  if (!row.available) throw new Error('模板所需赛事包未安装：' + row.contest_kind);
  const base = projectPlan.normalizePlan(currentPlan, previousProfile);
  const profile = projectContest.createProfile(base.contest, previousProfile);
  const contestChanged = row.category === 'contest' && row.contest_kind !== profile.contest_kind;
  // A method template keeps the complete contest identity. Switching competitions
  // starts with that package's defaults and clears the previous verified rules.
  const contest = contestChanged ? { contest_kind: row.contest_kind, contest_rules: {}, deadline: null } : base.contest;
  const result = projectPlan.normalizePlan({ ...base, label: row.label, contest,
    skills: { ...base.skills, main: contestChanged || row.category === 'contest' ? { primary: null, fallbacks: [] } : base.skills.main,
      research: { mode: 'append', primary: row.research, fallbacks: [] },
      figures: { mode: 'append', primary: row.figures, fallbacks: [] } } }, profile);
  return { template: row, plan: result };
}

module.exports = { load, list, apply };
