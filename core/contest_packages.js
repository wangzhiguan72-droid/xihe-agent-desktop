'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..', 'contest_packages');
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PHASES = ['baseline', 'iterate', 'freeze', 'final'];

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function resourcePath(pkg, rel) {
  if (!pkg || typeof pkg.root !== 'string' || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) {
    throw new Error('Invalid package resource path');
  }
  const root = fs.realpathSync(pkg.root);
  const candidate = path.resolve(root, rel);
  if (!within(root, candidate)) throw new Error(`Package resource escapes root: ${rel}`);
  const real = fs.realpathSync(candidate);
  if (!within(root, real)) throw new Error(`Package resource symlink escapes root: ${rel}`);
  return real;
}

function readJson(pkg, rel) {
  const file = resourcePath(pkg, rel);
  if (!fs.statSync(file).isFile()) throw new Error(`Expected package file: ${rel}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function strings(values, nonempty = false) {
  return Array.isArray(values) && (!nonempty || values.length > 0)
    && values.every(value => typeof value === 'string' && value.trim() === value && value.length > 0);
}

function validatePackageDir(dir, { scanTemplate = true } = {}) {
  const parent = fs.realpathSync(path.dirname(path.resolve(dir)));
  const entry = path.resolve(dir);
  if (fs.lstatSync(entry).isSymbolicLink() || !fs.statSync(entry).isDirectory()) throw new Error(`Invalid package directory: ${dir}`);
  const root = fs.realpathSync(entry);
  if (!within(parent, root)) throw new Error(`Package directory escapes root: ${dir}`);
  const pkg = { root };
  const manifest = readJson(pkg, 'manifest.json');
  if (!manifest || manifest.schema_version !== 1 || !ID.test(manifest.id || '') || manifest.id !== path.basename(root)
      || typeof manifest.label !== 'string' || !manifest.label.trim()) throw new Error(`Invalid package manifest: ${dir}`);
  const identity = manifest.identity;
  if (!identity || !['competition', 'edition', 'stage'].every(key => typeof identity[key] === 'string' && identity[key].trim())) {
    throw new Error(`Invalid package identity: ${manifest.id}`);
  }
  const match = manifest.match;
  if (!match || !strings(match.any) || !strings(match.all)) throw new Error(`Invalid package match: ${manifest.id}`);
  const skills = manifest.skills;
  if (!skills || typeof skills.default !== 'string' || !ID.test(skills.default)
      || !skills.providers || typeof skills.providers !== 'object' || Array.isArray(skills.providers)
      || Object.values(skills.providers).some(skill => typeof skill !== 'string' || !ID.test(skill))) {
    throw new Error(`Invalid package skills: ${manifest.id}`);
  }
  for (const field of ['rules', 'workflow', 'template']) {
    if (typeof manifest[field] !== 'string' || !manifest[field] || path.isAbsolute(manifest[field])) {
      throw new Error(`Invalid package ${field}: ${manifest.id}`);
    }
  }
  const rules = readJson(pkg, manifest.rules);
  const workflow = readJson(pkg, manifest.workflow);
  const template_dir = resourcePath(pkg, manifest.template);
  if (!fs.statSync(template_dir).isDirectory()) throw new Error(`Invalid package template: ${manifest.id}`);
  resourcePath(pkg, path.join(manifest.template, 'main.tex'));
  // A template may contain nested fonts/assets. Reject any link that would escape at use time.
  function inspect(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const rel = path.relative(root, path.join(dirPath, entry.name));
      const real = resourcePath(pkg, rel);
      if (fs.statSync(real).isDirectory() && !entry.isSymbolicLink()) inspect(real);
    }
  }
  if (scanTemplate) inspect(template_dir);
  if (!rules || !Array.isArray(rules.sources)
      || rules.sources.some(s => !s || typeof s.id !== 'string' || !s.id || !['official', 'user'].includes(s.type)
        || typeof s.description !== 'string' || !s.description.trim()
        || (s.path !== undefined && (typeof s.path !== 'string' || !s.path.trim())))
      || typeof rules.require_confirmation !== 'boolean' || !strings(rules.required_fields)
      || !(rules.paper_quality_profile === null || typeof rules.paper_quality_profile === 'string')
      || !rules.defaults || !rules.defaults.support_policy
      || !(rules.defaults.support_policy.max_bytes === null || Number.isSafeInteger(rules.defaults.support_policy.max_bytes))
      || !rules.paper || typeof rules.paper.toc_required !== 'boolean'
      || !strings(rules.paper.appendix_heading_titles) || !rules.paper.ai_details
      || !rules.profiles || typeof rules.profiles !== 'object' || Array.isArray(rules.profiles)) {
    throw new Error(`Invalid package rules: ${manifest.id}`);
  }
  for (const source of rules.sources) if (source.path) resourcePath(pkg, source.path);
  const support = rules.defaults.support_policy, ai = rules.paper.ai_details;
  for (const profile of Object.values(rules.profiles)) {
    if (!profile || typeof profile !== 'object' || !profile.constraints || typeof profile.constraints !== 'object'
        || Array.isArray(profile.constraints) || !strings(profile.required_fields || [])) throw new Error(`Invalid package profile: ${manifest.id}`);
  }
  const hasConstraints = support.max_bytes !== null || rules.paper.toc_required || rules.paper.abstract_first_page
    || rules.paper.support_manifest_required || ai.required || Object.keys(rules.quality || {}).length
    || Object.values(rules.profiles).some(p => Object.keys(p.constraints).length);
  if (hasConstraints && !rules.sources.length) throw new Error(`Package constraints require sources: ${manifest.id}`);
  if ((support.max_bytes !== null && (support.max_bytes <= 0 || typeof support.source !== 'string' || !support.source.trim()))
      || (support.exclusive !== undefined && typeof support.exclusive !== 'boolean')
      || typeof ai.title !== 'string' || typeof ai.filename !== 'string'
      || (ai.filename && (/[\\/:]/.test(ai.filename) || !ai.filename.endsWith('.pdf')))
      || typeof ai.draft_only !== 'boolean'
      || (ai.required !== undefined && typeof ai.required !== 'boolean')) {
    throw new Error(`Invalid package delivery policy: ${manifest.id}`);
  }
  if (!workflow || typeof workflow.intro !== 'string' || !workflow.phases
      || PHASES.some(key => typeof workflow.phases[key] !== 'string')
      || !workflow.clock || typeof workflow.reference_routes_enabled !== 'boolean') {
    throw new Error(`Invalid package workflow: ${manifest.id}`);
  }
  const ratios = workflow.clock.ratios;
  const unfreeze = workflow.clock.unfreeze_ratio;
  if (unfreeze !== undefined && (typeof unfreeze !== 'number' || !Number.isFinite(unfreeze) || unfreeze < 0 || unfreeze >= 1)) {
    throw new Error(`Invalid package unfreeze clock: ${manifest.id}`);
  }
  if (ratios !== null && (!ratios || !(ratios.baseline > 0 && ratios.baseline < ratios.iterate
      && ratios.iterate < ratios.freeze && ratios.freeze < 1))) throw new Error(`Invalid package clock: ${manifest.id}`);
  if (workflow.paper_quality_block !== undefined && typeof workflow.paper_quality_block !== 'string') {
    throw new Error(`Invalid package paper quality block: ${manifest.id}`);
  }
  return { ...manifest, root, rules, workflow, template_dir };
}

function loadPackages(baseDir = DEFAULT_ROOT) {
  const base = fs.realpathSync(baseDir);
  const packages = [];
  const diagnostics = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!ID.test(entry.name)) continue;
    try {
      if (entry.isSymbolicLink()) throw new Error('Symlinked contest package is not allowed');
      const pkg = validatePackageDir(path.join(base, entry.name), { scanTemplate: false });
      if (!within(base, pkg.root)) throw new Error('Package escapes package root');
      packages.push(pkg);
    } catch (error) {
      if (entry.name === 'generic') throw new Error(`Generic contest package is invalid: ${error.message}`);
      diagnostics.push({ id: entry.name, error: error.message });
    }
  }
  if (!packages.some(pkg => pkg.id === 'generic')) throw new Error(`Missing generic contest package in ${base}`);
  Object.defineProperty(packages, 'diagnostics', { value: diagnostics, enumerable: false });
  return packages;
}

function getPackage(id, baseDir = DEFAULT_ROOT) {
  return loadPackages(baseDir).find(pkg => pkg.id === id) || null;
}

function detectPackage(session = {}, baseDir = DEFAULT_ROOT) {
  const packages = loadPackages(baseDir);
  const generic = packages.find(pkg => pkg.id === 'generic');
  if (typeof session.contest_kind === 'string' && session.contest_kind.trim()) {
    return packages.find(pkg => pkg.id === session.contest_kind) || generic;
  }
  if (typeof session.paper_profile === 'string' && session.paper_profile.trim()) {
    const byProfile = packages.find(pkg => pkg.rules.paper_quality_profile === session.paper_profile);
    if (byProfile) return byProfile;
  }
  const title = String(session.title || '').toLocaleLowerCase();
  if (!title) return generic;
  // Prefer the most specific title match: APMCM contains MCM. Directory
  // enumeration order must never decide which competition's rules apply.
  const matches = packages.filter(pkg => pkg.id !== 'generic').map(pkg => {
    const any = pkg.match.any.filter(token => title.includes(token.toLocaleLowerCase()));
    const all = pkg.match.all.length > 0 && pkg.match.all.every(token => title.includes(token.toLocaleLowerCase()));
    return { pkg, score: Math.max(0, ...any.map(token => token.length), all ? pkg.match.all.reduce((n, token) => n + token.length, 0) : 0) };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.pkg.id.localeCompare(b.pkg.id));
  return matches[0]?.pkg || generic;
}

module.exports = { loadPackages, getPackage, detectPackage, validatePackageDir, resourcePath };
