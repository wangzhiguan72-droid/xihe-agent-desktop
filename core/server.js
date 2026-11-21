// 羲和服务器：零依赖 Node 原生 http。承载 UI、SSE 流式对话、会话持久化。
// 安全模型（个人自用版）：监听 127.0.0.1 + 启动随机令牌 + Origin/Content-Type 校验；
// 密钥只写 key 文件、永不出现在任何 JSON 响应；会话 id 白名单；文件/设置原子写。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Sandbox, createSandbox } = require('./sandbox');
const { MATH_SKILLS, runTurn, buildSystem, stampInputFiles, inputStampHash, makeSpend } = require('./agent');
const { getIndex } = require('./skills');
const { PROVIDERS, allProviders, customProviders, CUSTOM_ID_RE, PROTOCOL_KINDS, keyFor, providerForModel, resolveProvider } = require('./providers');
const { DEFAULT_PRICES } = require('./pricing');
const { TARGETS, loadLedger, saveLedger, monthKey, dayKey } = require('./external');
const { providerModels } = require('./providers');
const spiral = require('./spiral');
const { normalizeRoleModels } = require('./model_roles');
const jobResume = require('./job_resume');
const taskFocus = require('./task_focus');
const projectContest = require('./project_contest');
const projectPlan = require('./project_plan');
const skillQuality = require('./skill_quality');
const templateLibrary = require('./template_library');
const plugins = require('./plugins');

const APP_PATHS = require('./paths');
const APP_DIR = APP_PATHS.APP_DIR;
const DATA_DIR = APP_PATHS.DATA_DIR;
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
// 工作区与程序目录分离：模型可写范围是 workspace/，程序本体、密钥、会话、账本都不可达
const WORKSPACE = APP_PATHS.WORKSPACE;
const PROJECTS_DIR = path.join(WORKSPACE, 'projects'); // 项目隔离根：每题一个项目，避免串题
const UI_DIR = path.join(APP_DIR, 'ui');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'trash'), { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// 经验库条数上限可配（settings.memory_max_entries，默认 5000）
try { const st0 = loadSettings(); if (st0.memory_max_entries) require('./memory').setMaxEntries(st0.memory_max_entries); } catch {}

// ---------- 项目管理（应用层复审 P1：单用户也需要题目隔离）----------
// 项目 = 一道题（或一组关联题）。workspace/projects/<project_id>/ 是该题的工作目录，
// 包含 source/（题目与原始数据，只读语义）、exp_<id>/（路线实验，路线 A/B/C 各一个）、
// runs/<run_id>/outputs/（运行结果）。同题不同路线互不覆盖；切换题目不再混淆文件。
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;
// 项目元数据目录：永远在 workspace/projects/<id>/，只放 project.json（绝不放进用户的文件夹）
function projectDir(projectId) {
  return path.join(PROJECTS_DIR, projectId);
}
function projectMetaOf(projectId) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir(projectId), 'project.json'), 'utf8')); } catch { return null; }
}
function readMetaFromDir(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch { return null; }
}
// 系统禁区（与 sandbox.hardDeny 同口径）。外部项目根落在这些目录里一律拒绝。
const SYS_DENY = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata'];
function _inside(child, parent) {
  const c = String(child).toLowerCase().replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  const p = String(parent).toLowerCase().replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  return c === p || c.startsWith(p + '\\');
}
// 校验用户选的项目文件夹是否可用作沙箱根。返回 {ok} 或 {error}。
// 危险的不是「用户自己的文件夹」，而是「包含本程序目录的祖先目录」：
//   root=<应用目录的上一级> 时 sandbox 放行整个应用目录（密钥、会话、core 源码），
//   而 sandbox.protected 在「目标是 root 本身」时不生效——等于把程序本体交出去。
function validateProjectRoot(dir) {
  if (!dir || typeof dir !== 'string') return { error: '路径为空' };
  let abs;
  try { abs = path.resolve(dir); } catch { return { error: '路径不合法' }; }
  let st; try { st = fs.statSync(abs); } catch { return { error: '文件夹不存在：' + abs }; }
  if (!st.isDirectory()) return { error: '不是文件夹：' + abs };
  if (path.dirname(abs) === abs) return { error: '不能选磁盘根目录（' + abs + '），请选一个具体文件夹' };
  for (const d of SYS_DENY) if (_inside(abs, d)) return { error: '不能选系统目录：' + abs };
  const appRoot = path.resolve(APP_DIR, '..'); // 含 xihe-agent/ 与 workspace/ 的那一层
  if (_inside(abs, APP_DIR) || _inside(APP_DIR, abs) || _inside(abs, appRoot) || _inside(appRoot, abs)) {
    return { error: '不能选包含羲和程序目录的位置（' + abs + '），请选程序目录之外的文件夹' };
  }
  return { ok: true, dir: abs };
}
// 项目工作目录（沙箱根）：外部项目就地用用户选的文件夹；否则回落 workspace/projects/<id>/
function projectWorkspace(projectId) {
  if (projectId && PROJECT_ID_RE.test(projectId)) {
    const meta = projectMetaOf(projectId);
    if (meta && meta.dir && fs.existsSync(meta.dir)) return meta.dir;
  }
  return projectDir(projectId);
}
// 该项目是否就地作业（外部目录）：是则关掉自动备份/回收站等「我方工作区管家」行为
function isExternalProject(projectId) {
  const meta = projectId ? projectMetaOf(projectId) : null;
  return !!(meta && meta.external && meta.dir);
}
function listProjects() {
  const out = [];
  for (const f of fs.readdirSync(PROJECTS_DIR)) {
    const p = path.join(PROJECTS_DIR, f);
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) continue;
      const meta = readMetaFromDir(p);
      const ext = !!(meta && meta.external && meta.dir);
      out.push({
        id: f, title: (meta && meta.title) || f,
        // 外部项目按目标目录的活跃度排序更符合直觉（否则它永远停在建项目那一刻）
        updatedAt: ext ? (() => { try { return fs.statSync(meta.dir).mtimeMs; } catch { return st.mtimeMs; } })() : st.mtimeMs,
        external: ext, dir: ext ? meta.dir : null,
        dirMissing: ext ? !fs.existsSync(meta.dir) : false,
        contest_profile: meta?.contest_profile || null,
      });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
function ensureProject(projectId, title, opts = {}) {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error('projectId 不合法（限字母数字_-）');
  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true }); // 元数据目录永远存在
  const meta = path.join(dir, 'project.json');
  const cur = readMetaFromDir(dir);
  if (opts.dir) {
    // 外部项目：只写元数据，**不在用户目录里创建 source/ runs/**（那是我方约定，不该强加给既有目录）
    const v = validateProjectRoot(opts.dir);
    if (v.error) throw new Error(v.error);
    atomicWrite(meta, JSON.stringify({ ...cur, id: projectId, title: title || cur?.title || projectId, createdAt: cur?.createdAt || Date.now(), dir: v.dir, external: true }, null, 2));
    return v.dir;
  }
  if (cur && cur.external && cur.dir) return cur.dir; // 已有外部绑定：沿用，不覆盖
  if (!cur) atomicWrite(meta, JSON.stringify({ id: projectId, title: title || projectId, createdAt: Date.now() }, null, 2));
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  return dir;
}
function saveProjectContest(projectId, input) {
  const meta = projectMetaOf(projectId);
  if (!meta) throw new Error('项目不存在');
  const profile = projectContest.createProfile(input, meta.contest_profile);
  let modeling_plan = meta.modeling_plan;
  if (modeling_plan) {
    const changedKind = modeling_plan.plan.contest.contest_kind !== profile.contest_kind;
    const plan = { ...modeling_plan.plan, contest: projectPlan.contestInput(profile),
      skills: { ...modeling_plan.plan.skills, ...(changedKind ? { main: { primary: null, fallbacks: [] } } : {}) } };
    if (JSON.stringify(plan) !== JSON.stringify(modeling_plan.plan)) modeling_plan = { ...modeling_plan, plan,
      lock: changedKind && modeling_plan.lock ? { entries: modeling_plan.lock.entries.filter(row => row.slot !== 'main') } : modeling_plan.lock,
      revision: modeling_plan.revision + 1 };
  }
  atomicWrite(path.join(projectDir(projectId), 'project.json'), JSON.stringify({ ...meta, contest_profile: profile, ...(modeling_plan ? { modeling_plan } : {}) }, null, 2));
  return profile;
}
function projectPlanState(pid) {
  const meta = projectMetaOf(pid);
  const record = meta.modeling_plan;
  const st = loadSettings();
  const plan = record?.plan || projectPlan.defaultPlan(meta.contest_profile);
  const options = projectPlan.skillOptions(st, record?.assetRoot || projectDir(pid));
  const effective = projectPlan.resolvePlan({ appDir: APP_DIR, plan, provider: providerForModel(st.default_model, st) || 'deepseek', options, lock: record?.lock });
  return { plan, revision: record?.revision || 0, effective: { entries: effective.entries, plugins: effective.plugins, notices: effective.notices, assessment: effective.assessment },
    available_plugins: plugins.listAvailable(APP_DIR, { ...options, projectRoot: record?.assetRoot || projectDir(pid) }),
    local_skill_roots: st.skill_roots || [],
    skills: getIndex(APP_DIR, false, options).map(({ name, description, tag, version, source, sha256, shadowed }) => ({ name, description, tag, version, source, sha256, shadowed })) };
}
function saveProjectPlan(pid, input, imported = null) {
  const meta = projectMetaOf(pid);
  const plan = projectPlan.normalizePlan(input, meta.contest_profile);
  const old = meta.modeling_plan;
  const changed = JSON.stringify(plan) !== JSON.stringify(old?.plan);
  const keptLock = old?.lock ? { entries: old.lock.entries.filter(row =>
    JSON.stringify(plan.skills[row.slot]) === JSON.stringify(old.plan.skills[row.slot])
    && (row.slot !== 'main' || plan.contest.contest_kind === old.plan.contest.contest_kind)),
    plugins: (old.lock.plugins || []).filter(row => JSON.stringify((plan.plugins || []).find(p => p.id === row.id))
      === JSON.stringify((old.plan.plugins || []).find(p => p.id === row.id))) } : null;
  const record = { plan, revision: (old?.revision || 0) + (changed || imported ? 1 : 0),
    assetRoot: imported?.assetRoot || old?.assetRoot || null, lock: imported?.lock || keptLock };
  const profile = projectContest.createProfile(plan.contest, meta.contest_profile);
  atomicWrite(path.join(projectDir(pid), 'project.json'), JSON.stringify({ ...meta, contest_profile: profile, modeling_plan: record }, null, 2));
  return projectPlanState(pid);
}
function freezeSessionPlan(session, provider, override) {
  const record = projectMetaOf(session.project_id)?.modeling_plan;
  const origin = session.skill_plan_origin;
  if (!record && !origin) return;
  const plan = origin?.plan || record.plan;
  const st = loadSettings();
  const options = projectPlan.skillOptions(st, origin?.root || record.assetRoot || projectDir(session.project_id));
  const lock = origin ? projectPlan.resolutionLock(origin) : record.lock;
  const frozen = projectPlan.snapshot({ appDir: APP_DIR, plan, provider, options, lock,
    storageRoot: projectDir(session.project_id), revision: origin?.revision ?? record?.revision ?? 0, mainOverride: override });
  session.skill_plan_snapshot = frozen;
  session.claim_trace_required = !!(session.claim_trace_required || projectPlan.sessionFields(frozen.plan).claim_trace_required);
  if (!origin) session.skill_plan_origin = frozen;
}
// 冻结槽位的首检质检：主技能不走 skill_load，必须在这里补上，否则永远漏检。
// 后台异步、不阻塞开赛；同指纹已有标记时零 API。结论落盘后重建 system，
// 让质检警告从下一轮起进入主技能注入段（buildSystem 只读本地标记）。
function scheduleSkillQualitySweep(s) {
  const st = loadSettings();
  if (!skillQuality.settingsOf(st).enabled) return;
  const entries = (s.skill_plan_snapshot?.entries || []).filter(row => row.status === 'loaded' && !row.blocked);
  if (!entries.length) return;
  const spend = makeSpend(s, { ledger: loadLedger(APP_DIR), settings: st, appDir: APP_DIR });
  Promise.all(entries.map(async row => {
    try {
      const loaded = projectPlan.loadSessionSkill(APP_DIR, s, row.name, null, st);
      const result = await skillQuality.checkSkill({ appDir: APP_DIR, settings: st, name: loaded.name,
        sha256: loaded.sha256, content: loaded.content, refs: loaded.refs });
      if (result.status === 'checked' && result.marker?.usage) {
        try {
          spend(String(result.marker.model).split(':').slice(1).join(':') || String(result.marker.model), {
            prompt_tokens: Number(result.marker.usage.prompt_tokens || 0),
            completion_tokens: Number(result.marker.usage.completion_tokens || 0),
            cache_hit_tokens: Number(result.marker.usage.prompt_cache_hit_tokens || result.marker.usage.prompt_tokens_details?.cached_tokens || 0),
          }, 'skill_quality');
        } catch { /* 质检计费失败不拖垮会话 */ }
      }
      return result;
    } catch { return null; }
  })).then(results => {
    if (!results.some(r => r && r.status === 'checked')) return;
    try {
      s.system = buildSystem(s.mode, sessionRoot(s), loadSettings(), APP_DIR, s.system_provider, s.skill_override, s);
      s.skill_loaded = loadedSkillOf(s.system, s.skill_plan_snapshot);
      persistSession(s);
    } catch { /* 重建失败保留原 system，警告仍可在技能面板查看 */ }
  }).catch(() => {});
}
function syncProjectRules(session, rules) {
  const meta = projectMetaOf(session.project_id);
  if (!meta?.contest_profile || session.project_contest_revision !== meta.contest_profile.revision) return '项目档案未同步：当前会话使用旧快照，本次规则仅保存于此会话。';
  const profile = saveProjectContest(session.project_id, { contest_rules: rules });
  session.project_contest_revision = profile.revision;
  return '项目规则已同步，后续新会话自动继承。';
}
// 按绝对路径反查它属于哪个项目的沙箱根（/api/file、/api/reveal、/api/open_file 用）。
// 这三个端点此前一律用默认根 → 外部项目下会全部 403（交付物打不开、图显示不出来）。
function sandboxForPath(absPath) {
  if (!absPath) return createSandbox(APP_DIR);
  let target;
  try { target = path.resolve(absPath); } catch { return createSandbox(APP_DIR); }
  let best = null;
  for (const p of listProjects()) {
    const root = p.external && p.dir ? p.dir : projectDir(p.id);
    // 最长匹配优先：项目目录嵌套时选更具体的那一个
    if (_inside(target, root) && (!best || root.length > best.length)) best = root;
  }
  return createSandbox(APP_DIR, best ? { workspace: best } : {});
}
// ---------- 一键开赛：题目文件夹 → 项目（复制附件+铺论文模板+项目约定）→ 数模会话 ----------
const COPY_LIMIT = 800 * 1024 * 1024;
function copyTree(src, dst, budget = { left: COPY_LIMIT }) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d, budget);
    else if (e.isFile() && !fs.existsSync(d)) {
      const n = fs.statSync(s).size;
      if (n > budget.left) throw new Error('题目文件夹超过 800MB，请只放题目与附件');
      budget.left -= n;
      fs.copyFileSync(s, d);
    }
  }
}
function defaultConventions(title, sourceDir, lang, contestPackage) {
  const py = lang !== 'matlab';
  const identity = contestPackage.identity || {};
  const label = contestPackage.id === 'generic' ? contestPackage.label
    : [identity.competition, identity.edition, identity.stage].filter(Boolean).join(' · ') || contestPackage.label;
  return `# 项目约定（全会话有效）

- **本题**：${title}。题目与附件已复制到 \`source/\`（原目录 ${sourceDir}；原始附件只读，实验输出写在工作区其他目录）。
- **赛事档案**：${label}。规则、流程和论文模板以当前赛事包为准；当届官方规则需要逐条核对来源。
- **工作流**：${contestPackage.workflow.intro}
- **主编程语言：${py ? 'Python 3（numpy/scipy/pandas/openpyxl/matplotlib 已装）；MATLAB 仅作独立复核' : 'MATLAB R2024b（matlab -batch 运行）；Python 仅作独立审计与绘图'}**。
- **目录约定**：脚本写 scripts/（文件名带语义，支撑材料提供完整程序）；中间结果（json/csv/npy）写 outputs/，图写 figures/，报告写 findings/；data/ 只放预处理后的输入数据，运行中不要回写。
- **结果文件**：题目要求的 result*.xlsx 写在工作区根并对齐题给模板；写结果的 python_run 设 result_artifact=true。
- **论文**：paper/main.tex 从当前赛事档案的模板开始，paper_build 编译；按题目组织模型建立、求解、实际结果与检验。流程图仅在能帮助理解时使用 flowchart_draw。数据图用 matplotlib 优先出矢量 PDF，按最终尺寸设置字号，放入论文后检查可读性。
- **比赛规范**：以当届官方要求为准。AI 声明位置、附录代码位置、篇幅与支撑材料体积均须核对本届来源；未知条款标待核对。支撑材料提供完整可运行程序和文件清单。
- **自主性**：非致命歧义用 contract_register 的 ambiguity 条款登记【歧义点+所选解释+理由】后继续。
`;
}
function kickoffPrompt(sourceDir, session, clock) {
  const workflow = require('./contest_workflows');
  const pkg = workflow.packageFor(session);
  return `${pkg.label}开工。题目与附件在 source/（原目录：${sourceDir}）。比赛时钟：${clock || '未设截止'}。
${session.contest_package_notice ? '赛事识别提示：' + session.contest_package_notice + '\n' : ''}先核对赛事身份、届次、赛道、截止时区和规则来源；题设与交付要求逐问登记。\n${workflow.workflowBlock(session)}
${workflow.phaseGuidance('baseline', session)}
先 fs_ls source 并核对附件解码、字段、时空支持及质量标记；逐问登记输入、输出、单位、约束与可解性。对可解问建立 model_spec、正式运行和检验证据，记录跨问接口与版本。paper_build({init:true}) 使用赛事包模板；每项论文结论关联当前代码、结果和图表。完成基线后按赛事流程迭代、冻结、复核和交付；实际截止优先，未核实的规则明确标记待核。`;
}

// ---------- 真实花费：DeepSeek 官方账户余额差 ----------
// 价格表估算与实扣偏差大（v2.4 实测估算 ¥28.4 vs 实扣 ¥10.1），仪表盘改显示余额差：
// 今日实扣 = 当日首次观测余额 + 当日充值 − 当前余额。单独存 data/balance.json（ledger 会被会话账本整体覆盖写）。
const BAL_FILE = path.join(DATA_DIR, 'balance.json');
let balCache = null;
async function dsBalance(force) {
  if (!force && balCache && Date.now() - balCache.at < 60000) return balCache;
  const key = keyFor('deepseek', APP_DIR);
  if (!key) return null;
  let bal;
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const info = (j.balance_infos || []).find(b => b.currency === 'CNY') || (j.balance_infos || [])[0];
    bal = Number(info && info.total_balance);
    if (!Number.isFinite(bal)) return balCache;
  } catch { return balCache; }
  let b = {};
  try { b = JSON.parse(fs.readFileSync(BAL_FILE, 'utf8')); } catch {}
  const day = dayKey();
  if (b.day !== day) b = { day, start: bal, topup: 0, last: bal };
  else if (bal > b.last + 0.005) b.topup = (b.topup || 0) + (bal - b.last); // 余额上涨 = 充值
  b.last = bal;
  try { atomicWrite(BAL_FILE, JSON.stringify(b)); } catch {}
  balCache = { at: Date.now(), balance: +bal.toFixed(2), today_spent: +Math.max(0, b.start + (b.topup || 0) - bal).toFixed(2) };
  return balCache;
}

// 解析会话所属项目的工作目录；向后兼容：无 project_id 的旧会话走共享 WORKSPACE
function sessionWorkspace(session) {
  if (session && session.project_id && PROJECT_ID_RE.test(session.project_id)) {
    try { return ensureProject(session.project_id); } catch {}
  }
  return WORKSPACE;
}
// sessionWorkspace 的路径版：不写盘、不建目录，只回答「本会话的沙箱根在哪」。
// 必须与 projectWorkspace(pid) 同源，否则 startTurn 的 wsRoot 与沙箱根会分叉。
function sessionRoot(session) {
  if (session && session.project_id && PROJECT_ID_RE.test(session.project_id)) return projectWorkspace(session.project_id);
  return WORKSPACE;
}

// 每次启动生成随机令牌：本机任何进程拿到端口也调不动 API（无令牌即 403）
const TOKEN = crypto.randomBytes(24).toString('hex');

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// 附件清单只保留最近 50 条注入会话，但被挤出的索引必须落盘归档，不能静默消失。
function trimAttachmentManifest(session, archiveRoot = path.join(DATA_DIR, 'attachments')) {
  const manifest = session && Array.isArray(session.attachment_manifest) ? session.attachment_manifest : null;
  if (!manifest || manifest.length <= 50) return { archived: 0, archive: null };
  const dropped = manifest.splice(0, manifest.length - 50);
  const safeId = String(session.id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  fs.mkdirSync(archiveRoot, { recursive: true });
  const archive = path.join(archiveRoot, safeId + '.jsonl');
  const at = Date.now();
  fs.appendFileSync(archive, dropped.map(e => JSON.stringify({ ...e, archived_at: at })).join('\n') + '\n', 'utf8');
  return { archived: dropped.length, archive };
}

// ---------- 设置 ----------
const DEFAULT_SETTINGS = {
  default_model: 'deepseek-flash',
  heavy_model: 'deepseek-v4-pro',
  role_models: { modeler: '', coder: '', writer: '', reviewer: '' },
  decision_judge: {
    enabled: false,
    trigger: 'on_demand',
    provider: 'tokenrhythm',
    model: 'neohorse-1-9b',
    timeout_ms: 12000,
    max_tokens: 512,
    min_confidence: 0.82,
    auto_override: false,
    allow_override: false,
    swap_check: false,
  },
  skill_quality: {
    enabled: false,
    provider: '',
    model: '',
    timeout_ms: 60000,
    max_tokens: 4096,
  },
  vision_model: 'glm-5.3-flash',
  vision_max_tokens: 8192, // 视觉支路独立输出预算（两条协议分支共用）
  glm_base: 'https://open.bigmodel.cn/api/anthropic', // coding-plan 订阅端点（paas/v4 需另充平台余额）
  summarize_model: 'deepseek-flash',
  temperature: 0.6,
  daily_budget: 15,
  ctx_limit: 131072,
  max_output_tokens: 65536,
  provider_models: {}, // 可选：{"glm": ["glm-4.8"], "qwen": [...]} 追加各家新模型而不用改代码
  disabled_models: [], // 已注册但不出现在模型选择器/角色路由中的 provider:model 列表
  chatgpt_quota: 30,
  // 知识库语料根目录（只读注入沙箱 + kb_build 索引源）。发行版不预设任何本机目录；
  // 用户可在设置页添加自己的资料目录。agent_run/user_own 等 provenance 分级由 kb_extract.py 按一级目录标注。
  kb_roots: [],
  reasoning_effort: 'on',
  model_reasoning: {},
  reasoning_fallback: 'error',
  efforts: { 'deepseek-flash': 'medium', 'deepseek-v4-pro': 'high' },
  prices: DEFAULT_PRICES,
};
function normalizeStringList(list, field) {
  if (!Array.isArray(list)) throw new Error(`${field} 必须是字符串数组`);
  const seen = new Set();
  return list.map((x) => {
    if (typeof x !== 'string') throw new Error(`${field} 只能包含字符串`);
    return x.trim();
  }).filter(Boolean).filter((x) => !seen.has(x) && seen.add(x));
}
function validProviderBase(value) {
  try { const u = new URL(String(value || '').trim()); return ['http:', 'https:'].includes(u.protocol) && !!u.hostname; }
  catch { return false; }
}
function validateModelSettingsPayload(payload, currentSettings = {}) {
  const b = payload || {};
  if (Object.hasOwn(b, 'decision_judge')) {
    const j = b.decision_judge;
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('decision_judge 必须是对象');
    if (j.enabled != null && typeof j.enabled !== 'boolean') throw new Error('decision_judge.enabled 必须是布尔值');
    if (j.trigger != null && !['on_demand', 'smart', 'always'].includes(j.trigger)) throw new Error('decision_judge.trigger 必须是 on_demand、smart 或 always');
    for (const key of ['provider', 'model']) if (j[key] != null && (typeof j[key] !== 'string' || !j[key].trim())) throw new Error(`decision_judge.${key} 无效`);
    for (const key of ['timeout_ms', 'max_tokens']) if (j[key] != null && (!Number.isFinite(Number(j[key])) || Number(j[key]) < 1)) throw new Error(`decision_judge.${key} 无效`);
    if (j.min_confidence != null && (!Number.isFinite(Number(j.min_confidence)) || Number(j.min_confidence) < 0 || Number(j.min_confidence) > 1)) throw new Error('decision_judge.min_confidence 必须在0到1之间');
    for (const key of ['auto_override', 'allow_override', 'swap_check']) if (j[key] != null && typeof j[key] !== 'boolean') throw new Error(`decision_judge.${key} 必须是布尔值`);
    b.decision_judge = { ...j, trigger: j.trigger || 'on_demand', timeout_ms: j.timeout_ms == null ? 12000 : Math.min(Number(j.timeout_ms), 60000), max_tokens: j.max_tokens == null ? 512 : Math.min(Number(j.max_tokens), 1024), min_confidence: j.min_confidence == null ? 0.82 : Number(j.min_confidence), auto_override: j.auto_override === true, allow_override: j.allow_override === true, swap_check: j.swap_check === true };
  }
  if (Object.hasOwn(b, 'skill_quality')) {
    const q = b.skill_quality;
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('skill_quality 必须是对象');
    if (q.enabled != null && typeof q.enabled !== 'boolean') throw new Error('skill_quality.enabled 必须是布尔值');
    for (const key of ['provider', 'model']) if (q[key] != null && (typeof q[key] !== 'string' || q[key].length > 200)) throw new Error(`skill_quality.${key} 无效`);
    for (const key of ['timeout_ms', 'max_tokens']) if (q[key] != null && (!Number.isFinite(Number(q[key])) || Number(q[key]) < 1)) throw new Error(`skill_quality.${key} 无效`);
    b.skill_quality = { ...q, enabled: q.enabled === true, provider: String(q.provider || '').trim(), model: String(q.model || '').trim(),
      timeout_ms: q.timeout_ms == null ? 60000 : Math.min(Number(q.timeout_ms), 180000), max_tokens: q.max_tokens == null ? 4096 : Math.min(Number(q.max_tokens), 8192) };
  }
  if (Object.hasOwn(b, 'provider_kinds')) {
    if (!b.provider_kinds || typeof b.provider_kinds !== 'object' || Array.isArray(b.provider_kinds)) throw new Error('provider_kinds 必须是对象');
    for (const kind of Object.values(b.provider_kinds)) if (!PROTOCOL_KINDS.includes(kind)) throw new Error('接口格式必须为 Chat Completions、Anthropic Messages 或 Responses');
  }
  if (Object.hasOwn(b, 'provider_models')) {
    if (!b.provider_models || typeof b.provider_models !== 'object' || Array.isArray(b.provider_models)) throw new Error('provider_models 必须是对象');
    const normalized = {};
    const customIds = new Set((Array.isArray(b.custom_providers) ? b.custom_providers : (currentSettings.custom_providers || [])).map(c => String(c && c.id || '').trim().toLowerCase()));
    for (const [pk, list] of Object.entries(b.provider_models)) {
      if (!PROVIDERS[pk] && !customIds.has(pk)) throw new Error(`provider_models.${pk} 提供商不存在`);
      normalized[pk] = normalizeStringList(list, `provider_models.${pk}`);
    }
    b.provider_models = normalized;
  }
  if (Object.hasOwn(b, 'disabled_models')) {
    const list = normalizeStringList(b.disabled_models, 'disabled_models');
    for (const model of list) if (!/^[a-z][a-z0-9_-]{1,23}:.+$/.test(model)) throw new Error(`disabled_models 项必须是 provider:model：${model}`);
    b.disabled_models = list;
  }
  if (Object.hasOwn(b, 'custom_providers')) {
    if (!Array.isArray(b.custom_providers)) throw new Error('custom_providers 必须是数组');
    const ids = new Set();
    for (const c of b.custom_providers) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('custom_providers 条目必须是对象');
      const id = String(c.id || '').trim().toLowerCase();
      if (!CUSTOM_ID_RE.test(id) || PROVIDERS[id]) throw new Error(`custom_providers.id 无效：${id}`);
      if (ids.has(id)) throw new Error(`custom_providers.id 重复：${id}`);
      ids.add(id);
      if (!validProviderBase(c.base)) throw new Error(`custom_providers.${id}.base 必须是 http(s) URL`);
      if (c.kind != null && !PROTOCOL_KINDS.includes(c.kind)) throw new Error(`custom_providers.${id}.kind 接口格式无效`);
      if (Object.hasOwn(c, 'models')) c.models = normalizeStringList(c.models, `custom_providers.${c.id || '?'}.models`);
    }
  }
  return b;
}
function resolveProviderTestRequest(b, reg, keyLookup) {
  const body = b || {};
  let entry = reg && reg[body.pk];
  let draft = false;
  if (!entry) {
    const pk = String(body.pk || '').trim().toLowerCase();
    const base = String(body.base || '').trim().replace(/\/+$/, '');
    const model = String(body.model || '').trim();
    if (!CUSTOM_ID_RE.test(pk) || PROVIDERS[pk]) return { error: '未知提供商' };
    if (!validProviderBase(base) || !model) return { error: '新提供商测试需要有效 Base URL 和模型名' };
    entry = { models: [model] };
    draft = true;
  }
  const key = String(body.key || '').trim() || (draft ? '' : (keyLookup ? keyLookup(body.pk) : ''));
  if (!key) return { error: '没有 Key' };
  const base = String(body.base || '').trim().replace(/\/+$/, '');
  if (!validProviderBase(base)) return { error: 'Base URL 必须是有效 http(s) URL' };
  if (body.kind != null && !PROTOCOL_KINDS.includes(body.kind)) return {error:'接口格式无效'};
  return { draft, key, base, kind: body.kind || entry.kind || 'openai', model: String(body.model || ((entry.models || [])[0] || '')) };
}
function loadSettings() {
  const p = path.join(APP_DIR, 'config', 'settings.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  const merged = { ...DEFAULT_SETTINGS, ...s, prices: { ...DEFAULT_PRICES, ...(s.prices || {}) } };
  merged.role_models = normalizeRoleModels(merged.role_models);
  merged.decision_judge = { ...DEFAULT_SETTINGS.decision_judge, ...(s.decision_judge || {}) };
  merged.skill_quality = { ...DEFAULT_SETTINGS.skill_quality, ...(s.skill_quality || {}) };
  return merged;
}
function saveSettings(s) {
  fs.mkdirSync(path.join(APP_DIR, 'config'), { recursive: true });
  // 密钥字段永远不进 settings.json（单独存 key 文件）
  const { has_deepseek_key, has_glm_key, deepseek_key, glm_key, ...rest } = s;
  atomicWrite(path.join(APP_DIR, 'config', 'settings.json'), JSON.stringify(rest, null, 2));
}

// ---------- 会话 ----------
const sessions = new Map();
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function newSession(mode, title, projectId, options = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const st = loadSettings();
  // 项目隔离（应用层复审 P1）：每个新会话默认归到最近一个项目，避免两题串文件
  let pid = (projectId && PROJECT_ID_RE.test(projectId)) ? projectId : null;
  if (!pid) {
    const projects = listProjects();
    pid = projects.length ? projects[0].id : 'default';
  }
  ensureProject(pid);
  const inherited = mode === 'math' ? projectContest.sessionFields(projectMetaOf(pid)?.contest_profile) : {};
  const wsRoot = projectWorkspace(pid); // 外部项目 = 用户选的文件夹；否则 workspace/projects/<pid>/
  const workflow = require('./contest_workflows');
  const contestKind = inherited.contest_kind || (mode === 'math' ? workflow.contestKind({ title: title || '新会话', project_id: pid }) : 'generic');
  // P_next：环境体检（应用层复审 §10：环境诊断失败后直接给修复路线，减少模型反复试错）
  // 仅 math/code 模式跑一次，free 跳过
  let envReport = null;
  if (mode === 'math' || mode === 'code') {
    try { envReport = require('./env_check').envCheck(wsRoot); }
    catch (e) { envReport = { error: String(e.message || e).slice(0, 200) }; }
  }
  const s = {
    id, mode: mode || 'free', model: null, title: title || '新会话',
    project_id: pid, contest_kind: contestKind,
    ...inherited,
    task_scope: ['solve', 'blind', 'review', 'delivery'].includes(options.task_scope) ? options.task_scope : 'solve',
    createdAt: Date.now(), updatedAt: Date.now(),
    // 会话创建即解析 provider（默认模型）→ math 模式选对应技能版；切模型时 runTurn 会重建
    system: '',
    system_provider: providerForModel(st.default_model, st) || 'deepseek',
    messages: [], todos: [], memory: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, calls: 0, cost: 0, vision_calls: 0 },
    pendingQuestion: null, status: 'idle',
    decisions: [], runs: [], compute_runs: 0, env_report: envReport,
  };
  if (mode === 'math') {
    const parent = options.inherit_session_id ? getSession(options.inherit_session_id) : null;
    if (options.inherit_session_id && (!parent || parent.project_id !== pid)) throw new Error('继承来源会话不属于当前项目');
    if (parent?.claim_trace_required) s.claim_trace_required = true;
    if (parent?.skill_plan_snapshot) {
      s.skill_plan_snapshot = JSON.parse(JSON.stringify(parent.skill_plan_snapshot));
      s.skill_plan_origin = JSON.parse(JSON.stringify(parent.skill_plan_origin || parent.skill_plan_snapshot));
      if (projectPlan.sessionFields(s.skill_plan_snapshot.plan).claim_trace_required) s.claim_trace_required = true;
      for (const key of ['contest_kind', 'contest_identity', 'contest_rules', 'paper_profile', 'contest_deadline', 'project_contest_revision']) {
        if (parent[key] !== undefined) s[key] = JSON.parse(JSON.stringify(parent[key]));
      }
    } else freezeSessionPlan(s, s.system_provider, null);
    scheduleSkillQualitySweep(s);
  }
  s.system = buildSystem(s.mode, wsRoot, st, APP_DIR, s.system_provider, null, s);
  // 真实技能加载信息（前端显示真值，不再硬编码文案）
  s.skill_loaded = loadedSkillOf(s.system, s.skill_plan_snapshot);
  // 深度维度默认 fast（第①②种模式）；deep 由用户显式开启，见 /api/session/effort
  if (!s.effort) s.effort = 'fast';
  persistSession(s);
  sessions.set(id, s);
  return s;
}
function loadedSkillOf(system, snapshot) {
  const main = snapshot?.entries?.find(row => row.slot === 'main' && row.status === 'loaded' && !row.blocked);
  if (main) return { name: main.name, version: main.version, sha256: main.sha256, source: main.source };
  const match = String(system || '').match(/已加载技能 ([^\s，]+) v([\d.]*)/);
  return match ? { name: match[1], version: match[2] || '' } : null;
}
function persistSession(s) {
  s.updatedAt = Date.now();
  atomicWrite(path.join(SESSIONS_DIR, s.id + '.json'), JSON.stringify(s, null, 1));
}
function getSession(id) {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return null;
  if (sessions.has(id)) return sessions.get(id);
  const p = path.join(SESSIONS_DIR, id + '.json');
  if (!fs.existsSync(p)) return null;
  try { const s = JSON.parse(fs.readFileSync(p, 'utf8')); sessions.set(id, s); return s; } catch { return null; }
}
function listSessions() {
  const out = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      out.push({
        id: s.id, title: s.title, mode: s.mode, collab_mode: s.collab_mode || 'collab', status: s.status,
        updatedAt: s.updatedAt, cost: s.usage && s.usage.cost,
        project_id: s.project_id || null,
        task_scope: s.task_scope || 'solve',
        // 归档/置顶（v2.5）：归档 = 从主列表收起但随时可恢复；置顶 = 永远排最前
        pinned: !!s.pinned, archived: !!s.archived,
      });
    } catch {}
  }
  // 排序：置顶优先 → 其余按更新时间；归档的排最后（前端默认折叠）
  return out.sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    || (a.archived ? 1 : 0) - (b.archived ? 1 : 0)
    || b.updatedAt - a.updatedAt);
}
function publicSession(s) {
  const workflow = require('./contest_workflows');
  const pkg = workflow.packageFor(s);
  return {
    id: s.id, title: s.title, mode: s.mode, model: s.model, resolved_model: s.resolved_model || null, resolved_role: s.resolved_role || null, messages: s.messages, todos: s.todos, memory: s.memory,
    usage: s.usage, pendingQuestion: s.pendingQuestion, pendingApproval: s.pendingApproval || null,
    job_wait: s.job_wait || null, task_focus: s.task_focus || null, status: s.status, system_preview: (s.system || '').slice(0, 400),
    wait_reason: s.wait_reason || null,
    continuation: require('./decisions').continuationState(s),
    last_error: s.last_error || null,
    repro_check: s.repro_check || null,
    // 证据与决策状态（前端据此显示「未验证」标记与决策卡；刷新/重启后仍在）
    unverifiedNumeric: !!s.unverifiedNumeric, compute_runs: s.compute_runs || 0,
    decisions: s.decisions || [], runs: s.runs || [],
    resolved_reasoning: s.resolved_reasoning || null, reasoning_history: (s.reasoning_history || []).slice(-30),
    formulas: s.formulas || [], data_epoch: s.data_epoch || 0,
    skill_loaded: s.skill_loaded || null,
    skill_override: s.skill_override || null,
    claim_trace_required: !!s.claim_trace_required,
    skill_plan_snapshot: projectPlan.publicSnapshot(s.skill_plan_snapshot),
    plugin_runs: (s.plugin_runs || []).map(row => ({ id: row.plot_run_id, plot_run_id: row.plot_run_id, plugin_id: row.plugin_id, version: row.version,
      sha256: row.sha256, ok: row.ok, source: row.source, figures: row.figures, issues: row.issues,
      elapsed_ms: row.elapsed_ms, source_run_id: row.source?.run_id })),
    collab_mode: s.collab_mode || 'collab',
    project_id: s.project_id || null,
    question_graph: s.question_graph || [],
    attachment_manifest: s.attachment_manifest || [],
    env_report: s.env_report || null,
    // v2.5 螺旋层：前端据此在顶栏显示比赛时钟（剩余时间 + 当前阶段）
    contest: !!s.contest,
    contest_kind: workflow.contestKind(s),
    contest_identity: s.contest_identity || pkg.identity,
    project_contest_revision: s.project_contest_revision || null,
    task_scope: s.task_scope || 'solve',
    contest_rules: s.contest_rules || {},
    contest_package_notice: s.contest_package_notice || null,
    paper_profile: s.paper_profile || null,
    createdAt: s.createdAt,
    contest_start: s.contest_start || null,
    contest_deadline: s.contest_deadline || null,
    contest_phase: s.contest_phase || null,
    contest_max_rounds: s.contest_max_rounds || null,
    approval: s.approval || null,
    approval_allow: Object.keys(s.approval_allow || {}),
    assumptions: (s.assumptions || []).length,
    iterations: (s.iterations || []).map(x => ({ id: x.id, status: x.status, round: x.round })),
    // v2.5 第九轮：深度维度（fast/deep）与 collab_mode 正交 → 四种模式（见 core/modes.js）
    effort: s.effort || 'fast',
  };
}

// ---------- 崩溃恢复：上次异常退出可能残留 running 状态 ----------
// 只在作为入口启动时跑：测试 import 本模块不能顺手改写用户的会话文件。
function recoverSessions() {
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = path.join(SESSIONS_DIR, f);
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      const poolRecovered = require('./pool').recoverPool(s);
      const waitRecovered = jobResume.recoverWait(s);
      if (s.status === 'running') {
        s.status = 'idle'; // 服务重启说明原运行已不存在，回落待命而不是永远显示运行中
        if (s.job_wait && ['waiting', 'queued'].includes(s.job_wait.status)) s.status = 'waiting_jobs';
        if (s.pendingApproval) s.pendingApproval = null;
        atomicWrite(p, JSON.stringify(s, null, 1));
      } else if (poolRecovered || waitRecovered) atomicWrite(p, JSON.stringify(s, null, 1));
    } catch {}
  }
}

let jobNotices = null;
const jobEventClients = new Set();
function notices() {
  if (!jobNotices) jobNotices = require('./job_notifications').createJobNotifications(path.join(DATA_DIR, 'job_notifications.json'));
  return jobNotices;
}
function matchesJobScope(job, scope = {}) {
  return (!scope.session_id || job.session_id === scope.session_id) && (!scope.project_id || job.project_id === scope.project_id);
}
function publicJobs(scope = {}) {
  const jobs = require('./jobs');
  const all = jobs.listJobs().map(jobs.publicMeta).filter(j => matchesJobScope(j, scope));
  const counts = {};
  for (const row of all) counts[row.status] = (counts[row.status] || 0) + 1;
  // 活跃任务优先，历史再多也不能挤掉仍在运行/需要处理的任务。
  const priority = new Set(['queued', 'running', 'starting', 'failed', 'needs_review']);
  const rows = [...all.filter(j => priority.has(j.status)), ...all.filter(j => !priority.has(j.status))].slice(0, 100);
  const resumptions = listSessions().filter(row => !row.archived).map(row => getSession(row.id))
    .filter(s => s?.job_wait?.status === 'needs_review' && matchesJobScope({ session_id: s.id, project_id: s.project_id }, scope))
    .map(s => ({ session_id: s.id, project_id: s.project_id, title: s.title, status: s.job_wait.status,
      error: s.job_wait.error || '主流程恢复需要核对', interrupted_approval: s.job_wait.interrupted_approval || null }));
  return { jobs: rows, counts, resumptions, ...notices().snapshot(scope) };
}
function broadcastJob(event) {
  for (const client of jobEventClients) {
    const owner = event.job || event;
    if (matchesJobScope(owner, client.scope)) client.send(event);
  }
}

// ---------- 运行时状态 ----------
const stoppers = new Map(); // id -> {stop, abort}
const running = new Set();
const activeTurns = new Map();
const focusTransitions = new Set();
// 待审批的工具调用：`${session_id}:${tool_call_id}` -> resolve(decision)
// decision ∈ allow | allow_session | deny | timeout
const approvals = new Map();

function startTurn(session, userInput, res, resumeId = null) {
  if (focusTransitions.has(session.id)) { if (res) json(res, 409, { error: '正在切换任务，请稍后发送' }); return; }
  if (running.has(session.id)) { if (res) { sse(res, { t: 'error', msg: '该会话正在运行中，请先停止' }); res.end(); } return; }
  if (!resumeId && userInput?.action !== 'clarify' && !taskFocus.isLocalTask(session)) jobResume.cancelWait(session);
  running.add(session.id);
  let failed = false;
  const stopper = { stop: false };
  const abort = new AbortController();
  stoppers.set(session.id, { stopper, abort });
  const children = new Set(); // 本任务派生的进程（python/shell），停止时全部杀掉

  if (res) res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const heartbeat = res ? setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000) : null;

  // 项目隔离：会话绑定 project 后，沙箱根=projectWorkspace(project_id)（外部项目即用户选的文件夹），
  // 两题同名脚本不互覆盖
  const wsRoot = sessionWorkspace(session);
  // 新建会话时环境体检若还在后台跑（python/matlab 标「检测中」），开轮时补上最新结果
  if (session.env_report && session.env_report.python && session.env_report.python.ok === null) {
    try { session.env_report = require('./env_check').envCheck(wsRoot); } catch {}
  }
  const deps = {
    emit: (ev) => {
      if (ev?.t === 'error') failed = true;
      if (ev?.t === 'done') failed = ev.reason === 'error';
      // 每条事件带 session_id（审计：切会话时旧会话流不能污染新视图）
      if (res) sse(res, Object.assign({ session_id: session.id }, ev || {}));
    },
    stopper, abort, settings: loadSettings(), ledger: loadLedger(APP_DIR), appDir: APP_DIR,
    sandbox: createSandbox(APP_DIR, { workspace: wsRoot, external: isExternalProject(session.project_id), skillRoot: session.skill_plan_snapshot?.root }),
    persist: (s) => persistSession(s),
    syncProjectRules,
    children,
    // 审批通道（v2.5「请求审批」模式）：引擎 await 这个 promise，UI 点批准/拒绝后由 /api/approve resolve。
    // 超时兜底在引擎侧（10 分钟按拒绝）；这里只负责"推卡片 + 挂起等待"。
    requestApproval: (req) => new Promise((resolve) => {
      session.pendingApproval = { id: req.id, tool: req.tool, summary: req.summary, args_preview: req.args_preview };
      persistSession(session);
      approvals.set(session.id + ':' + req.id, decision => { session.pendingApproval = null; persistSession(session); resolve(decision); });
      if (res) sse(res, { t: 'approval_request', ...session.pendingApproval });
      broadcastJob({ type: 'session', session_id: session.id, project_id: session.project_id, status: 'waiting_approval' });
    }),
    killChildren: () => { for (const c of children) { try { spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { windowsHide: true }); } catch {} } },
  };
  const turn = runTurn(session, deps, userInput)
    .catch(e => {
      failed = true;
      // ISS-08：runTurn 内部异常（同步抛错 / 意外 reject）落盘——外部推送侧能区分
      // 「没触发」与「内部错误」。注意只在「正常路径没写过 last_error」时写，避免覆盖
      // agent.js failTurn 的更详细记录。
      const errText = '内部错误: ' + (e.stack || e).toString().slice(0, 600);
      if (!session.last_error) {
        session.messages.push({ role: 'user', content: '[系统·本轮失败] ' + errText + '\n（轮已终止，会话可继续；用户/推送方据此判断是否重试或换方法）' });
        session.last_error = { at: Date.now(), reason: 'runTurn 未捕获异常', detail: errText.slice(0, 800) };
      }
      if (res) sse(res, { t: 'error', msg: errText });
    })
    .finally(() => {
      clearInterval(heartbeat);
      running.delete(session.id);
      activeTurns.delete(session.id);
      stoppers.delete(session.id);
      // 异常路径（内部错误等）不得把会话永久留在 running——下次打开还能继续
      if (session.status === 'running') session.status = 'idle';
      if (resumeId) jobResume.finishWake(session, resumeId, { failed, stopped: stopper.stop });
      for (const [key, resolve] of approvals) if (key.startsWith(session.id + ':')) { approvals.delete(key); resolve('deny'); }
      session.pendingApproval = null;
      persistSession(session);
      broadcastJob({ type: 'session', session_id: session.id, project_id: session.project_id, status: session.status });
      try { if (res) { res.write('data: {"t":"__end__"}\n\n'); res.end(); } } catch {}
    });
  activeTurns.set(session.id, turn);
  return turn;
}

let wakeTickBusy = false;
function wakeJobSessions() {
  if (wakeTickBusy || running.size) return;
  wakeTickBusy = true;
  try {
    for (const row of listSessions()) {
      if (row.archived) continue;
      const session = getSession(row.id);
      if (!session?.job_wait || session.pendingApproval || taskFocus.isLocalTask(session) || focusTransitions.has(session.id)) continue;
      const before = JSON.stringify(session.job_wait);
      const ready = jobResume.prepareWake(session, require('./jobs').statusJob);
      if (!ready) { if (before !== JSON.stringify(session.job_wait)) persistSession(session); continue; }
      const id = jobResume.claimWake(session);
      persistSession(session); // 认领先落盘，崩溃后从此检查点恢复，不发送第二份模型任务。
      broadcastJob({ type: 'session', session_id: session.id, project_id: session.project_id, status: 'running' });
      startTurn(session, { text: ready.text }, null, id);
      break;
    }
  } catch (e) { console.warn('主流程后台恢复失败：' + String(e.message || e).slice(0, 200)); }
  finally { wakeTickBusy = false; }
}

function sse(res, ev) {
  try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch {}
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.webp': 'image/webp' };

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// open_file 允许用系统关联程序打开的类型白名单（明确产物；脚本/可执行/快捷方式一律拒绝）
const OPEN_EXT_OK = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.csv', '.md', '.txt', '.html', '.docx', '.xlsx', '.pptx', '.tex', '.log']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // ---- 访问控制：本机 + 令牌 + Origin/Content-Type ----
    const isLocalhost = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || (req.headers['x-xihe-token'] || '');
    const tokenOk = bearer === TOKEN;
    // 静态 UI 与健康检查不需要令牌；全部 /api/* 需要
    const isStatic = (req.method === 'GET' && (p === '/' || p === '/index.html' || p.startsWith('/static/')));
    const isHealth = p === '/api/health';
    if (!isLocalhost) { res.writeHead(403); return res.end('local only'); }
    if (!isStatic && !isHealth && !tokenOk) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('invalid token'); }
    // 写接口必须同源：没有 Origin（同源 fetch/electron）放行；有 Origin 必须是本服务自身
    if (!isStatic && req.method !== 'GET' && !isHealth) {
      const origin = req.headers['origin'];
      if (origin != null) {
        let hostOk = false;
        try { hostOk = new URL(origin).host === req.headers['host']; } catch {}
        if (!hostOk) return json(res, 403, { error: 'cross-origin rejected' });
      }
      const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct && ct !== 'application/json') return json(res, 415, { error: 'json only' });
    }

    // 静态 UI（index.html 注入令牌，前端据此带令牌请求）
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8')
        .replace('__XIHE_TOKEN_PLACEHOLDER__', TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const f = path.join(UI_DIR, path.normalize(p.slice(8)).replace(/^([.][.][\\/])+/, ''));
      if (!f.startsWith(UI_DIR)) { res.writeHead(403); return res.end(); }
      try { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return res.end(fs.readFileSync(f)); }
      catch { res.writeHead(404); return res.end(); }
    }

    // API
    if (isHealth && req.method === 'GET') {
      return json(res, 200, { app: 'xihe-agent', version: 1, pid: process.pid, startedAt: STARTED_AT, code_stamp: CODE_STAMP, running: running.size });
    }
    if (p === '/api/jobs' && req.method === 'GET') {
      return json(res, 200, publicJobs(Object.fromEntries(url.searchParams)));
    }
    if (p === '/api/jobs/detail' && req.method === 'GET') {
      const jobs = require('./jobs');
      const record = jobs.statusJob(url.searchParams.get('id') || '');
      if (record && !matchesJobScope(record.meta, Object.fromEntries(url.searchParams))) return json(res, 403, { error: '后台任务不属于当前会话或项目' });
      return record ? json(res, 200, { meta: jobs.publicMeta(record.meta), tail: record.tail || '', stderr: record.stderr || '' })
        : json(res, 404, { error: '后台任务不存在' });
    }
    if (p === '/api/jobs/events' && req.method === 'GET') {
      const jobs = require('./jobs');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (event) => { try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch {} };
      const scope = Object.fromEntries(url.searchParams);
      const client = { scope, send };
      jobEventClients.add(client);
      send({ type: 'snapshot', at: Date.now(), ...publicJobs(scope) });
      const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);
      res.on('close', () => { clearInterval(heartbeat); jobEventClients.delete(client); });
      return;
    }
    if (p === '/api/jobs/retry' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const jobs = require('./jobs');
      const meta = jobs.statusJob(String(b.id || ''))?.meta;
      if (meta && !matchesJobScope(meta, b)) return json(res, 403, { error: '后台任务不属于当前会话或项目' });
      if (meta?.session_id && running.has(meta.session_id)) return json(res, 409, { error: '所属主会话正在执行，请先停止再重试后台任务' });
      const result = jobs.retryJob(String(b.id || ''));
      if (result.ok && meta?.session_id) {
        const session = getSession(meta.session_id);
        if (session?.job_wait?.job_ids.includes(meta.id) && ['waiting', 'queued', 'needs_review'].includes(session.job_wait.status)
          && !session.pendingQuestion && !session.pendingApproval && !session.archived && session.status !== 'waiting_external') {
          session.job_wait.status = 'waiting'; session.job_wait.attempts = 0;
          session.status = 'waiting_jobs'; persistSession(session);
        }
      }
      return json(res, result.ok ? 200 : 409, result);
    }
    if (p === '/api/jobs/cancel' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const meta = require('./jobs').statusJob(String(b.id || ''))?.meta;
      if (meta && !matchesJobScope(meta, b)) return json(res, 403, { error: '后台任务不属于当前会话或项目' });
      const result = require('./jobs').cancelJob(String(b.id || ''));
      return json(res, result.ok ? 200 : 409, result);
    }
    if (p === '/api/jobs/ack' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      try { return json(res, 200, notices().ack(b.ids)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/session/resume' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const session = getSession(b.id);
      if (!session) return json(res, 404, { error: '会话不存在' });
      if (b.project_id && session.project_id !== b.project_id) return json(res, 403, { error: '会话不属于当前项目' });
      if (b.confirmed !== true || session.job_wait?.status !== 'needs_review') return json(res, 409, { error: '请先核对已有产物后再恢复待核查的主流程' });
      if (running.has(session.id) || session.pendingQuestion || session.pendingApproval || session.status === 'waiting_external') return json(res, 409, { error: '请先处理该会话当前的决策、审批或运行任务' });
      session.job_wait.reviewed_at = Date.now();
      startTurn(session, { text: '[用户确认恢复] 已核对上次中断的产物，请先读取已有文件、确认执行状态，从现有主线继续。未知结果不得冒充已完成，不直接重放先前写入；后续仍遵守人工审批和正式证据门禁。' }, null);
      return json(res, 202, { ok: true, session_id: session.id });
    }
    if (p === '/api/bootstrap' && req.method === 'GET') {
      const ledger = loadLedger(APP_DIR);
      const s = loadSettings();
      return json(res, 200, {
        workspace: WORKSPACE, settings: s, sessions: listSessions(),
        // 不强制重建：getIndex 会按"技能根/技能目录 mtime"自行判定是否重建（新装/删除都感知得到）。
        // 强制重建实测 220 ms，而 bootstrap 是界面每次刷新都调的接口——白付这 200 ms 会让启动明显发钝。
        skills: getIndex(APP_DIR, false, projectPlan.skillOptions(s)).slice(0, 300), math_skills: MATH_SKILLS, contest_skills: require('./contest_workflows').CONTEST_SKILLS,
        contest_packages: require('./contest_workflows').packageRows(),
        contest_package_diagnostics: require('./contest_packages').loadPackages().diagnostics,
        template_library: templateLibrary.list(APP_DIR),
        models: providerModels(s).map(m => ({ id: m.id, provider: m.provider, providerName: m.providerName,
          reasoning: require('./reasoning').reasoningCapabilities(m.provider, resolveProvider(m.provider, s), m.id, s) })),
        external: { targets: Object.fromEntries(Object.entries(TARGETS).map(([k, v]) => [k, v.label])), chatgpt_used: ledger.chatgpt && ledger.chatgpt.month === monthKey() ? ledger.chatgpt.used : 0 },
        today_cost: (ledger.costs || {})[dayKey()] || 0,
        keys: Object.fromEntries(Object.keys(allProviders(loadSettings())).map(pk => [pk, !!keyFor(pk, APP_DIR)])),
        has_deepseek_key: !!keyFor('deepseek', APP_DIR), has_glm_key: !!keyFor('glm', APP_DIR),
        providers: Object.entries(allProviders(loadSettings())).map(([id, v]) => ({ id, name: v.name, base: v.base, kind: v.kind, models: v.models, keyFile: v.keyFile, custom: !!v.custom })),
      });
    }
    if (p === '/api/provider/models' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const settings = loadSettings();
      const request = resolveProviderTestRequest({...b,model:b.model || 'directory-query'},allProviders(settings),pk=>keyFor(pk,APP_DIR));
      if (request.error) return json(res,200,{ok:false,error:request.error});
      const { endpointURL } = require('./responses-routing');
      const protocolEndpoint = endpointURL(request.base,request.kind);
      const directoryURL = new URL(protocolEndpoint.replace(/\/(?:messages|chat\/completions|responses)$/, '/models'));
      if (directoryURL.pathname === '/models') directoryURL.pathname = '/v1/models';
      const url = directoryURL.toString();
      try {
        const upstream = await fetch(url,{headers:{Authorization:'Bearer '+request.key,'x-api-key':request.key,'anthropic-version':'2023-06-01'},signal:AbortSignal.timeout(15000)});
        const directory = await upstream.json().catch(()=>null);
        if (!upstream.ok) return json(res,200,{ok:false,error:`模型目录 HTTP ${upstream.status}；当前端点可能不提供目录查询`});
        const source = Array.isArray(directory?.data) ? directory.data : Array.isArray(directory?.models) ? directory.models : null;
        if (!source) return json(res,200,{ok:false,error:'模型目录格式未识别，未改动已有模型'});
        const models = [...new Set(source.map(m=>typeof m==='string'?m:m?.id || m?.name).filter(m=>typeof m==='string'))].slice(0,2000);
        return json(res,200,{ok:true,models,note:'此列表来自当前密钥可见目录；列出型号不保证生成通道即时可用。查询不发送模型生成请求，不改动已有配置。'});
      } catch {
        return json(res,200,{ok:false,error:'模型目录查询失败或超时；未改动已有模型'});
      }
    }
    if (p === '/api/provider/test' && req.method === 'POST') {
      // 设置页「测试连接」：用表单里尚未保存的 Base URL/格式/模型/Key 发一条最小请求
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const settings = loadSettings();
      const reg = allProviders(settings);
      const request = resolveProviderTestRequest(b, reg, pk => keyFor(pk, APP_DIR));
      if (request.error) return json(res, 200, { ok: false, error: request.error });
      const { resolveReasoning, callWithReasoning, normalizeModelReasoning } = require('./reasoning');
      let reasoningSettings = settings;
      if (Object.hasOwn(b, 'reasoning_level')) {
        const configured = { ...(settings.model_reasoning || {}) };
        if (b.reasoning_level) {
          try { Object.assign(configured, normalizeModelReasoning({ [b.pk + ':' + request.model]: b.reasoning_level })); }
          catch (e) { return json(res, 400, { error: e.message }); }
        } else { delete configured[b.pk + ':' + request.model]; delete configured[request.model]; }
        reasoningSettings = { ...settings, model_reasoning: configured, reasoning_fallback: 'error' };
      }
      const plan = resolveReasoning(reasoningSettings, b.pk, { kind: request.kind, base: request.base }, request.model);
      if (plan.error) return json(res, 200, { ok: false, error: plan.error, requested: plan.requested });
      const t0 = Date.now();
      let reasoning = null;
      const timeoutMs = require('./reasoning').reasoningProbeTimeout(plan);
      const recordUsage = (usage, partial = false) => {
        if (usage && Number.isSafeInteger(usage.prompt_tokens) && (Number.isSafeInteger(usage.completion_tokens) || partial))
          require('./meter').record(APP_DIR, { t: Date.now(), model: request.model, kind: 'probe', session_id: null, project_id: null,
            prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens || 0, cache_hit_tokens: usage.cache_hit_tokens || 0,
            ...(partial ? {usage_partial:true} : {}) });
      };
      try {
        const manualBudget = plan.options.reasoningBody && plan.options.reasoningBody.thinking && plan.options.reasoningBody.thinking.budget_tokens;
        const result = await callWithReasoning(require('./providers').chatStream, {
          kind: request.kind, base: request.base, key: request.key,
          model: request.model, messages: [{ role: 'user', content: '只回复 ok' }],
          system: 'ping', maxTokens: manualBudget ? manualBudget + 256 : 512, signal: AbortSignal.timeout(timeoutMs),
        }, plan, row => { reasoning = row; });
        recordUsage(result.usage);
        return json(res, 200, { ok: true, ms: Date.now() - t0, reasoning, usage: result.usage });
      } catch (e) {
        recordUsage(e.usage, !!e.usage_partial);
        // 输出被截断也说明端点、格式、Key、模型名都通了
        if (e.truncated) return json(res, 200, { ok: true, truncated: true, ms: Date.now() - t0, reasoning, usage: e.usage });
        const timedOut = e.name === 'TimeoutError' || /UND_ERR_(?:HEADERS|BODY)_TIMEOUT/.test(e.cause?.code || '');
        const unavailable = [403,404].includes(e.status) && /model_not_found|not supported by any configured account|账户组|无可用|模型不存在/i.test(e.message || '');
        return json(res, 200, { ok: false, error: timedOut
          ? `等待模型响应超过 ${timeoutMs / 1000} 秒；本次未完成，不代表推理档位不支持。未自动重试。`
          : unavailable ? '当前密钥所属账户组没有该模型的可用通道；目录存在不代表当前Key可调用，更改推理档位无法修复此权限/路由问题。'
          : e.status === 502 ? `中转网关返回502（当前协议：${request.kind === 'anthropic' ? 'Anthropic Messages' : request.kind === 'responses' ? 'Responses' : 'Chat Completions'}）；可能是网关、协议路由或上游故障，不能仅凭502认定协议不支持。未自动切换协议。`
          : String(e.message || e).slice(0, 300), code:unavailable?'model_unavailable':undefined, reasoning, timed_out: timedOut,
          timeout_ms: timeoutMs, usage: e.usage || null, partial_usage: !!e.usage_partial });
      }
    }
    if (p === '/api/balance' && req.method === 'GET') {
      return json(res, 200, (await dsBalance(url.searchParams.get('force') === '1')) || { error: '未配置 DeepSeek Key 或查询失败' });
    }
    if (p === '/api/session/cache-diagnostics' && req.method === 'GET') {
      const s = getSession(url.searchParams.get('session_id') || '');
      if (!s) return json(res, 404, { error: '会话不存在' });
      const diagnostics = require('./cache_diagnostics').readSummary(APP_DIR, { session_id: s.id, limit: 20 });
      const historical = require('./meter').meterSummary(APP_DIR, { session_id: s.id });
      const historical_models = Object.entries(historical.byModel).map(([model, row]) => ({
        model, calls: row.calls, input_tokens: row.prompt_tokens, cached_tokens: row.cache_hit_tokens,
        rate: row.prompt_tokens ? 100 * row.cache_hit_tokens / row.prompt_tokens : null,
      }));
      return json(res, 200, { session_id: s.id, ...diagnostics, historical_models,
        coverage: ['main', 'main:local', 'sub', 'summarize'], historical_reporting: 'missing_cache_fields_were_counted_as_zero' });
    }
    // 计费明细（v2.6）：返回「token 明细 × 当前价目表」的现算结果。
    // 与余额差是两种口径：这里是官方 usage 计量，/api/balance 是账户实扣。
    if (p === '/api/cost/detail' && req.method === 'GET') {
      const meter = require('./meter');
      const s = getSession(url.searchParams.get('session_id') || '');
      const scope = url.searchParams.get('scope') || (s ? 'session' : 'day');
      const opts = { prices: loadSettings().prices, from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined };
      if (scope === 'session' && s) { opts.session_id = s.id; opts.from = undefined; opts.to = undefined; }
      else if (scope === 'project') opts.project_id = (s && s.project_id) || url.searchParams.get('project_id') || undefined;
      else if (scope === 'day' && !opts.from) opts.from = opts.to = dayKey();
      const sum = meter.meterSummary(APP_DIR, opts);
      return json(res, 200, { scope, ...sum });
    }
    if (p === '/api/usage/stats' && req.method === 'GET') {
      const period = url.searchParams.get('period') || 'week';
      if (!['week', 'month', 'all'].includes(period)) return json(res, 400, { error: 'period 必须为 week、month 或 all' });
      const stats = require('./meter').usageStats(APP_DIR, { period });
      const projects = new Map(listProjects().map(p => [p.id, p.title]));
      stats.byProject = stats.byProject.map(row => ({ ...row, title: row.project_id ? (projects.get(row.project_id) || row.project_id) : '未归属项目' }));
      return json(res, 200, stats);
    }
    // 官方调价后一键把历史账对齐：按当前价格表重算 ledger.costs。
    if (p === '/api/cost/resummarize' && req.method === 'POST') {
      return json(res, 200, { ok: true, ...require('./meter').resummarize(APP_DIR, { prices: loadSettings().prices }) });
    }
    if (p === '/api/session/new' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = newSession(b.mode, b.title, b.project_id, b);
      s.approval = b.approval === 'ask' ? 'ask' : (b.approval === 'full' ? 'full' : (s.mode === 'math' ? 'ask' : 'full'));
      if (b.model) s.model = b.model;
      // 角色路由预解析：math 会话未显式选模型时，提前解析 modeler 角色模型，顶栏胶囊即刻显示实际模型
      if (!s.model && s.mode === 'math') {
        try {
          const st = loadSettings();
          const mr = require('./model_roles').resolveRoleModel({ role: 'modeler', settings: st, appDir: APP_DIR, sessionModel: st.default_model });
          if (mr.ok) { s.resolved_model = mr.model; s.resolved_role = mr.roleLabel; }
        } catch { /* 解析失败不阻塞建会话，胶囊退回默认显示 */ }
      }
      if (b.effort) s.effort = require('./modes').effortOf({ effort: b.effort });
      persistSession(s);
      return json(res, 200, publicSession(s));
    }
    // 项目管理（应用层复审 P1：单用户也需要题目隔离）
    if (p === '/api/project/list' && req.method === 'GET') {
      return json(res, 200, { projects: listProjects() });
    }
    if (p === '/api/template-library' && req.method === 'GET') {
      return json(res, 200, { templates: templateLibrary.list(APP_DIR) });
    }
    if (p === '/api/project/plan/template' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 64000)).toString() || '{}');
      const meta = PROJECT_ID_RE.test(b.project_id || '') && projectMetaOf(b.project_id);
      if (!meta) return json(res, 404, { error: '项目不存在' });
      try {
        const current = b.plan || meta.modeling_plan?.plan || projectPlan.defaultPlan(meta.contest_profile);
        return json(res, 200, templateLibrary.apply(APP_DIR, b.template_id, current, meta.contest_profile));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/project/plan/assess' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 64000)).toString() || '{}');
      const meta = PROJECT_ID_RE.test(b.project_id || '') && projectMetaOf(b.project_id);
      if (!meta) return json(res, 404, { error: '项目不存在' });
      try {
        const plan = projectPlan.normalizePlan(b.plan, meta.contest_profile), st = loadSettings();
        const effective = projectPlan.resolvePlan({ appDir: APP_DIR, plan,
          provider: providerForModel(st.default_model, st) || 'deepseek',
          options: projectPlan.skillOptions(st, meta.modeling_plan?.assetRoot || projectDir(b.project_id)),
          // Preserve imported pins for unchanged selections, just as saving does.
          lock: meta.modeling_plan?.lock ? {
            entries: meta.modeling_plan.lock.entries.filter(row => JSON.stringify(plan.skills[row.slot]) === JSON.stringify(meta.modeling_plan.plan.skills[row.slot])
              && (row.slot !== 'main' || plan.contest.contest_kind === meta.modeling_plan.plan.contest.contest_kind)),
            plugins: (meta.modeling_plan.lock.plugins || []).filter(row => JSON.stringify(plan.plugins.find(x => x.id === row.id)) === JSON.stringify(meta.modeling_plan.plan.plugins?.find(x => x.id === row.id))) } : null });
        return json(res, 200, { plan, effective: { entries: effective.entries, plugins: effective.plugins, notices: effective.notices, assessment: effective.assessment } });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if ((p === '/api/project/plan' || p === '/api/project/plan/export') && req.method === 'GET') {
      const pid = url.searchParams.get('project_id') || '';
      if (!PROJECT_ID_RE.test(pid) || !projectMetaOf(pid)) return json(res, 404, { error: '项目不存在' });
      try {
        if (p.endsWith('/export')) {
          const meta = projectMetaOf(pid), st = loadSettings();
          return json(res, 200, projectPlan.exportPackage({ appDir: APP_DIR,
            plan: meta.modeling_plan?.plan || projectPlan.defaultPlan(meta.contest_profile),
            provider: providerForModel(st.default_model, st) || 'deepseek',
            options: projectPlan.skillOptions(st, meta.modeling_plan?.assetRoot || projectDir(pid)), lock: meta.modeling_plan?.lock }));
        }
        return json(res, 200, projectPlanState(pid));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if ((p === '/api/project/plan' || p === '/api/project/plan/import') && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 48 * 1024 * 1024)).toString() || '{}');
      const pid = b.project_id;
      if (!PROJECT_ID_RE.test(pid || '') || !projectMetaOf(pid)) return json(res, 404, { error: '项目不存在' });
      try {
        const imported = p.endsWith('/import') ? projectPlan.importPackage(b.package, projectMetaOf(pid).contest_profile, projectDir(pid)) : null;
        return json(res, 200, saveProjectPlan(pid, imported?.plan || b.plan, imported));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/project/plan/roots' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 64000)).toString() || '{}');
      if (!PROJECT_ID_RE.test(b.project_id || '') || !projectMetaOf(b.project_id)) return json(res, 404, { error: '项目不存在' });
      if (!Array.isArray(b.roots) || b.roots.length > 12 || b.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.length > 1000)) return json(res, 400, { error: '附加目录须为最多12个本机绝对路径' });
      saveSettings({ ...loadSettings(), skill_roots: [...new Set(b.roots)] });
      return json(res, 200, projectPlanState(b.project_id));
    }
    if (p === '/api/project/contest' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (!PROJECT_ID_RE.test(b.project_id || '') || !projectMetaOf(b.project_id)) return json(res, 404, { error: '项目不存在' });
      try { return json(res, 200, { ok: true, contest_profile: saveProjectContest(b.project_id, b) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/project/acceptance' && req.method === 'GET') {
      const pid = url.searchParams.get('project_id') || '';
      if (!PROJECT_ID_RE.test(pid) || !projectMetaOf(pid)) return json(res, 404, { error: '项目不存在' });
      const rows = listSessions().filter(s => s.project_id === pid).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 80);
      const sid = url.searchParams.get('session_id') || rows[0]?.id;
      const selected = sid ? getSession(sid) : null;
      if (selected && selected.project_id !== pid) return json(res, 403, { error: '验收会话不属于所选项目' });
      if (sid && !selected) return json(res, 404, { error: '验收会话不存在' });
      return json(res, 200, { project_id: pid, project_dir: projectWorkspace(pid), profile: projectMetaOf(pid).contest_profile || null,
        sessions: [...(selected && !rows.some(row => row.id === selected.id) ? [{ id: selected.id, title: selected.title, task_scope: selected.task_scope || 'solve' }] : []),
          ...rows.map(s => ({ id: s.id, title: s.title, task_scope: s.task_scope }))].slice(0, 80),
        session_id: selected?.id || null, session_profile_revision: selected?.project_contest_revision || null,
        active: [...running].some(id => getSession(id)?.project_id === pid),
        acceptance: selected ? require('./acceptance').sessionAcceptance(projectWorkspace(pid), selected) : null });
    }
    if (p === '/api/project/trace' && req.method === 'GET') {
      const pid = url.searchParams.get('project_id') || '';
      if (!PROJECT_ID_RE.test(pid) || !projectMetaOf(pid)) return json(res, 404, { error: '项目不存在' });
      const sid = url.searchParams.get('session_id') || '';
      if (!sid) return json(res, 400, { error: '缺少验收会话' });
      const selected = getSession(sid);
      if (!selected) return json(res, 404, { error: '验收会话不存在' });
      if (selected.project_id !== pid) return json(res, 403, { error: '验收会话不属于所选项目' });
      const root = sessionWorkspace(selected);
      return json(res, 200, { project_id: pid, session_id: selected.id, project_dir: root,
        trace: require('./claim_trace').inspect(root, selected) });
    }
    if (p === '/api/project/release' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.session_id);
      if (!s || s.project_id !== b.project_id) return json(res, 404, { error: '项目或验收会话不存在' });
      if ([...running].some(id => getSession(id)?.project_id === s.project_id)) return json(res, 409, { error: '项目仍有运行中的会话，收尾后再固定交付版本' });
      try {
        const root = sessionWorkspace(s);
        const snapshot = require('./acceptance').createRelease({ session: s, workspace: root, sandbox: createSandbox(APP_DIR, { workspace: root }) });
        persistSession(s);
        return json(res, 200, { ok: true, manifest: snapshot.manifest, root_rel: snapshot.root_rel });
      } catch (e) { return json(res, 409, { error: e.message }); }
    }
    // 交付物清单（v2.5）：把"这一题到底产出了什么、在哪个目录"直接摆到界面上。
    // 来源=① question_graph 里 attach_artifact 登记过的 ② 工作区里按约定命名的正式产物。
    // 只读，不写盘；路径一律相对项目根，前端拼绝对路径给 open_file/reveal。
    if (p === '/api/artifacts' && req.method === 'GET') {
      const sid = url.searchParams.get('session_id') || '';
      const s = sid ? getSession(sid) : null;
      const pid = (s && s.project_id) || url.searchParams.get('project_id') || '';
      if (!PROJECT_ID_RE.test(pid)) return json(res, 400, { error: '缺少有效的 session_id 或 project_id' });
      const root = projectWorkspace(pid);
      if (!fs.existsSync(root)) return json(res, 404, { error: '项目目录不存在：' + pid });
      const seen = new Map();
      const add = (rel, kind, note) => {
        const r = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (!r || seen.has(r)) return;
        const abs = path.join(root, r);
        let st = null; try { st = fs.statSync(abs); } catch {}
        if (!st || !st.isFile()) return; // 已被删除/挪走的产物不列（列出会让用户白点）
        seen.set(r, { path: r, abs, kind: kind || 'file', note: note || '', bytes: st.size, mtime: st.mtimeMs });
      };
      for (const q of (s && s.question_graph) || []) {
        for (const a of (q.artifacts || [])) add(a.path, a.kind, `问题${q.id}${a.note ? '·' + a.note : ''}`);
      }
      // 约定命名的正式产物（扫工作区根一层 + 常见子目录，避免全盘递归）
      let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch {}
      for (const e of ents) {
        if (!e.isFile()) continue;
        if (/^result.*\.xlsx$/i.test(e.name) || /^附件.*\.xlsx$/i.test(e.name)) add(e.name, 'result', '结果数据表');
        if (e.name === '支撑材料.zip') add(e.name, 'result', '支撑材料包（交付）');
        if (e.name === 'AI 工具使用详情.pdf') add(e.name, 'report', 'AI 使用详情（交付）');
      }
      for (const [dir, kind, note] of [['paper/main.pdf', 'report', '论文 PDF'], ['paper/main.tex', 'code', '论文源码']]) add(dir, kind, note);
      const glob = (dir, re, kind, note) => {
        let es = []; try { es = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
        for (const e of es) if (e.isFile() && re.test(e.name)) add(path.posix.join(dir, e.name), kind, note);
      };
      glob('findings', /\.md$/i, 'report', '分析报告');
      glob('paper/figures', /\.(pdf|png)$/i, 'figure', '论文插图');
      glob('figures', /\.(pdf|png)$/i, 'figure', '图');
      glob('scripts', /\.(py|m)$/i, 'code', '求解脚本');
      const KIND_ORDER = { result: 0, report: 1, figure: 2, code: 3, file: 4 };
      const files = [...seen.values()].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.path.localeCompare(b.path));
      return json(res, 200, { project_id: pid, project_dir: root, files });
    }
    // 在资源管理器中定位（打开所在文件夹并选中该文件）。只允许工作区内路径，不执行任何程序。
    if (p === '/api/reveal' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      let sb; try { sb = sandboxForPath(b.path); } catch { sb = createSandbox(APP_DIR); }
      let abs; try { abs = sb.resolve(b.path, 'r'); } catch (e) { return json(res, 403, { error: e.message }); }
      if (!fs.existsSync(abs)) return json(res, 404, { error: '路径不存在' });
      const isDir = fs.statSync(abs).isDirectory();
      // explorer 是 Windows 自带文件管理器；参数只用 /select, 与工作区内已校验的绝对路径
      if (isDir) require('child_process').spawn('explorer.exe', [abs], { windowsHide: false, detached: true }).unref();
      else require('child_process').spawn('explorer.exe', ['/select,' + abs], { windowsHide: false, detached: true }).unref();
      return json(res, 200, { ok: true, opened: isDir ? 'folder' : 'select' });
    }
    if (p === '/api/project/new' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const pid = String(b.id || '').trim();
      if (!PROJECT_ID_RE.test(pid)) return json(res, 400, { error: 'id 不合法（字母数字_-，≤48 字符）' });
      // v2.6 外部项目：b.dir = 用户选的电脑上的既有文件夹，就地作业。
      // 校验在 ensureProject 里做（validateProjectRoot）；不合法即 400，不建半个项目。
      let wsDir;
      try { wsDir = ensureProject(pid, b.title, b.dir ? { dir: b.dir } : {}); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      // P0-2 增强：可选 sourceDir —— 把源根的 CLAUDE.md/AGENTS.md 复制到项目工作区根
      // 这样后续会话 buildSystem 时能自动注入项目约定（MATLAB 主解等）。
      // 外部项目下源根常就是工作区本身 → 必须跳过同路径复制（copyFileSync 到自身会截断文件）。
      const src = b.sourceDir && typeof b.sourceDir === 'string' ? path.resolve(b.sourceDir) : null;
      if (src && src !== path.resolve(wsDir) && fs.existsSync(src)) {
        try {
          for (const fname of ['CLAUDE.md', 'AGENTS.md', 'AGENT.md']) {
            const sp = path.join(src, fname);
            const dp = path.join(wsDir, fname);
            if (fs.existsSync(sp) && path.resolve(sp) !== path.resolve(dp)) fs.copyFileSync(sp, dp);
          }
        } catch (e) { /* 不影响项目创建 */ }
      }
      return json(res, 200, { ok: true, id: pid, dir: wsDir, external: isExternalProject(pid) });
    }
    if (p === '/api/contest/start' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const src = path.resolve(String(b.sourceDir || '').trim().replace(/^"|"$/g, ''));
      if (!b.sourceDir || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) return json(res, 400, { error: '题目文件夹不存在：' + (b.sourceDir || '（空）') });
      const title = String(b.title || path.basename(src)).slice(0, 80);
      const d = new Date(), pad = (n) => String(n).padStart(2, '0');
      let pid = 'contest_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
      while (fs.existsSync(projectWorkspace(pid))) pid += 'x';
      ensureProject(pid, title);
      const dir = projectWorkspace(pid);
      try { copyTree(src, path.join(dir, 'source')); } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      const conv = ['CLAUDE.md', 'AGENTS.md'].map(f => path.join(src, f)).find(f => fs.existsSync(f));
      const workflow = require('./contest_workflows');
      const contestKind = workflow.contestKind({ contest_kind: b.contest_kind === 'auto' ? '' : b.contest_kind, title });
      const pkg = workflow.packageFor({ contest_kind: contestKind });
      if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), conv ? fs.readFileSync(conv, 'utf8') : defaultConventions(title, src, b.lang, pkg), 'utf8');
      require('./tools').installPaperTemplate(path.join(dir, 'paper'), 'main.tex', { contest_kind: contestKind });
      require('./tools').installPlotBaseline(dir);
      const s = newSession('math', title, pid);
      s.contest_kind = contestKind;
      if (b.contest_kind && b.contest_kind !== 'auto' && b.contest_kind !== contestKind) {
        s.contest_package_notice = `未找到赛事包 ${String(b.contest_kind).slice(0, 80)}，已使用通用赛事档案；请核对并补充当届规则。`;
      }
      s.collab_mode = b.collab_mode === 'auto' ? 'auto' : 'collab';
      s.approval = s.collab_mode === 'auto' ? 'full' : 'ask'; // 权限默认跟模式走，可随时单独切
      s.require_model_spec = true; // 新比赛正式计算需经过模型规格校验
      s.contest_rules = (b.contest_rules && typeof b.contest_rules === 'object') ? b.contest_rules : {};
      const packageProfile = pkg.rules.paper_quality_profile || 'generic';
      const allowedProfiles = new Set([packageProfile, 'generic']);
      s.paper_profile = allowedProfiles.has(b.paper_profile) ? b.paper_profile : packageProfile;
      s.contest = true; // 比赛会话：两种模式都自动续推到完成，只在决策卡处停
      if (b.model) s.model = b.model;
      // 只有用户提供真实截止或剩余小时，才设置比赛时钟。
      s.contest_start = Date.now();
      const hours = Number(b.hours);
      const dlRaw = b.deadline ? new Date(String(b.deadline)) : null;
      if (dlRaw && !isNaN(dlRaw.getTime()) && dlRaw.getTime() > Date.now()) {
        s.contest_deadline = dlRaw.getTime();
      } else if (Number.isFinite(hours) && hours > 0 && hours <= 240) {
        s.contest_deadline = s.contest_start + Math.round(hours * 3.6e6);
      }
      s.contest_phase = 'baseline';
      s.contest_max_rounds = Number.isFinite(Number(b.max_rounds)) && Number(b.max_rounds) > 0 ? Math.min(Number(b.max_rounds), 20) : spiral.DEFAULT_MAX_ROUNDS;
      s.assumptions = []; s.iterations = [];
      const profile = saveProjectContest(pid, { contest_kind: contestKind, contest_rules: s.contest_rules,
        paper_profile: s.paper_profile, deadline: s.contest_deadline || null,
        ...(b.edition != null ? { edition: b.edition } : {}), ...(b.stage != null ? { stage: b.stage } : {}), ...(b.track != null ? { track: b.track } : {}) });
      s.project_contest_revision = profile.revision;
      s.contest_identity = profile.identity;
      // 三档算力由 modes.effortOf 统一裁决；system_effort 会在下一轮 runTurn 自动重建提示词。
      if (b.effort) s.effort = require('./modes').effortOf({ effort: b.effort });
      s.system = buildSystem(s.mode, dir, loadSettings(), APP_DIR, s.system_provider || 'deepseek', s.skill_override, s);
      s.skill_loaded = loadedSkillOf(s.system, s.skill_plan_snapshot);
      const clock = spiral.clockLine(s);
      persistSession(s);
      return json(res, 200, { session: publicSession(s), kickoff: kickoffPrompt(src, s, clock), project_id: pid });
    }
    // 审批决定（v2.5 请求审批模式）：UI 点「批准 / 拒绝 / 本会话总是允许」→ 唤醒挂起的工具调用
    if (p === '/api/approve' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const key = String(b.session_id || '') + ':' + String(b.tool_call_id || '');
      const resolve = approvals.get(key);
      const decision = ['allow', 'allow_session', 'deny'].includes(b.decision) ? b.decision : 'deny';
      if (!resolve) return json(res, 404, { error: '没有待审批的调用（可能已超时或会话已结束）' });
      approvals.delete(key);
      resolve(decision);
      return json(res, 200, { ok: true, decision });
    }
    // 权限策略切换（v2.5）：完全访问 / 请求审批。与协作模式解耦——模式只决定"谁答决策卡"，
    // 权限决定"执行前要不要点批准"。
    // 本次会话指定技能（v2.5）：默认按提供商自动选；这里给用户一个显式覆盖入口。
    // 传空字符串 = 回到自动。
    if (p === '/api/session/skill' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      const want = String(b.skill || '').trim();
      if (want) {
        try { projectPlan.loadSessionSkill(APP_DIR, s, want, null, loadSettings()); } catch (e) { return json(res, 400, { error: '技能不可用：' + e.message }); }
      }
      if (s.skill_plan_snapshot) {
        try { freezeSessionPlan(s, s.system_provider || 'deepseek', want || null); }
        catch (e) { return json(res, 400, { error: '方案快照失败：' + e.message }); }
        scheduleSkillQualitySweep(s);
      }
      s.skill_override = want || null;
      s.system = buildSystem(s.mode, sessionRoot(s), loadSettings(), APP_DIR, s.system_provider || 'deepseek', s.skill_override, s);
      s.system_skill = s.skill_override;
      s.skill_loaded = loadedSkillOf(s.system, s.skill_plan_snapshot);
      persistSession(s);
      return json(res, 200, { ok: true, skill_override: s.skill_override, skill_loaded: s.skill_loaded,
        skill_plan_snapshot: projectPlan.publicSnapshot(s.skill_plan_snapshot) });
    }
    if (p === '/api/session/approval' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      s.approval = b.approval === 'ask' ? 'ask' : 'full';
      if (s.approval === 'full') s.approval_allow = {}; // 切回完全访问时清掉逐工具授权，避免下次切回时残留
      persistSession(s);
      return json(res, 200, { ok: true, approval: s.approval, approval_allow: s.approval_allow || {} });
    }
    if (p === '/api/session/collab' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      s.collab_mode = b.collab_mode === 'auto' ? 'auto' : 'collab';
      persistSession(s);
      return json(res, 200, { ok: true, collab_mode: s.collab_mode, pendingQuestion: s.pendingQuestion || null });
    }
    // 算力维度：fast/deep/extreme，与 collab_mode 正交 → 六种模式。
    if (p === '/api/session/effort' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      s.effort = require('./modes').effortOf({ effort: b.effort });
      persistSession(s);
      const modes = require('./modes');
      return json(res, 200, { ok: true, effort: s.effort, tier: modes.tierOf(s), mode: modes.modeOf(s) });
    }
    if (p === '/api/session/open' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      return json(res, 200, publicSession(s));
    }
    // 会话置顶 / 归档（v2.5）：只改元数据，不动消息内容。归档不删任何东西，随时可恢复。
    if (p === '/api/session/meta' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      if (typeof b.pinned === 'boolean') s.pinned = b.pinned;
      if (typeof b.archived === 'boolean') s.archived = b.archived;
      persistSession(s);
      return json(res, 200, { ok: true, pinned: !!s.pinned, archived: !!s.archived });
    }
    if (p === '/api/session/delete' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      // 审计 P1：删除运行中的会话会让后台任务 persist 重建刚移入回收站的文件——先停止
      if (running.has(s.id)) {
        return json(res, 409, { error: '该会话正在运行，请先点击停止按钮再删除（删除运行中会话会让后台 persist 重建刚进回收站的会话）' });
      }
      if (require('./jobs').listJobs().some(job => job.session_id === s.id && (['queued', 'starting', 'running', 'cancelling'].includes(job.status) || job.uncertainActive))) {
        return json(res, 409, { error: '该会话仍有排队或运行中的后台任务，请先停止并等待任务结束再删除' });
      }
      const src = path.join(SESSIONS_DIR, s.id + '.json');
      // 先持久化旧版无逐次明细的累计差值，删会话不能顺带丢历史用量。
      require('./meter').captureUsageHistory(APP_DIR);
      // hard=true（设置页「彻底删除」用）：连回收站副本也不留。
      // 注意经验库不受影响——经验在 data/memory/store.jsonl，跟聊天记录是两个文件（删会话不掉经验）。
      if (fs.existsSync(src)) {
        if (b.hard === true) fs.unlinkSync(src);
        else fs.renameSync(src, path.join(DATA_DIR, 'trash', `session_${Date.now()}_${s.id}.json`));
      }
      sessions.delete(s.id);
      return json(res, 200, { ok: true, hard: b.hard === true });
    }
    if (p === '/api/session/model' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (s) { s.model = b.model; persistSession(s); }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/session/focus' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (!['local', 'main'].includes(b.action)) return json(res, 400, { error: '任务范围需为 local 或 main' });
      const session = getSession(b.id);
      if (!session) return json(res, 404, { error: '会话不存在' });
      if (focusTransitions.has(session.id)) return json(res, 409, { error: '正在切换任务，请稍后重试' });
      if (b.action === 'main' && !taskFocus.isLocalTask(session)) return json(res, 409, { error: '当前不在临时小任务中' });
      if (b.action === 'local' && taskFocus.isLocalTask(session)) return json(res, 200, { session: publicSession(session) });
      focusTransitions.add(session.id);
      try {
        const pausedFrom = session.status;
        const active = stoppers.get(session.id);
        if (active) {
          active.stopper.stop = true;
          active.abort.abort();
          // Release a pending approval as denied; resuming never re-approves the old call.
          for (const [key, resolve] of approvals) if (key.startsWith(session.id + ':')) { approvals.delete(key); resolve('deny'); }
          const turn = activeTurns.get(session.id);
          if (turn) {
            let timeout;
            try {
              await Promise.race([turn, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('已请求暂停，当前工具仍在收尾，请稍后再次切换')), 15000); })]);
            } finally { clearTimeout(timeout); }
          }
        }
        if (running.has(session.id)) return json(res, 409, { error: '当前工具仍在收尾，尚未进入临时任务' });
        const diskInputs = inputStampHash(stampInputFiles(sessionWorkspace(session)));
        const resume = b.action === 'main' ? taskFocus.returnToMain(session, diskInputs) : null;
        if (b.action === 'local') taskFocus.enterLocalTask(session, pausedFrom, diskInputs);
        persistSession(session);
        broadcastJob({ type: 'session', session_id: session.id, project_id: session.project_id, status: session.status });
        return json(res, 200, { session: publicSession(session), resume });
      } catch (e) { return json(res, 409, { error: e.message }); }
      finally { focusTransitions.delete(session.id); }
    }
    if (p === '/api/chat' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = getSession(b.id);
      if (!s) return json(res, 404, { error: '会话不存在' });
      try {
        if (b.action === 'clarify') require('./decisions').validateClarification(s.pendingQuestion, b);
        else {
          if (b.action === 'retry') {
            if (!s.last_error || s.pendingQuestion || s.wait_reason || s.pendingApproval) return json(res, 409, { error: '当前没有可恢复的失败，或仍有待处理的决策/审批' });
            b.text = require('./recovery').recoveryPrompt(s, { workspace: sessionWorkspace(s) });
          }
          if (b.action !== 'retry' && (s.wait_reason?.kind === 'decision_text' || s.last_error) && require('./decisions').isVagueContinuation(b.text)) return json(res, 409, { error: '当前任务需要处理阻塞，重复续推已暂停。', continuation: require('./decisions').continuationState(s) });
          if (s.pendingQuestion?.candidates && s.collab_mode === 'auto' && !taskFocus.isLocalTask(s) && !b.decision) b.decision = { decision_id: s.pendingQuestion.decision_id, selected_id: s.pendingQuestion.recommended_id };
          require('./decisions').validateResponse(s.pendingQuestion, b.decision);
        }
      }
      catch (e) { return json(res, 409, { error: e.message }); }
      startTurn(s, b.action === 'clarify'
        ? { action: 'clarify', decision_id: b.decision_id, question: b.question }
        : { text: b.text, decision: b.decision, action: b.action }, res);
      return;
    }
    if (p === '/api/stop' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const st = stoppers.get(b.id);
      if (st) { st.stopper.stop = true; st.abort.abort(); }
      const session = getSession(b.id);
      if (session && !taskFocus.isLocalTask(session)) {
        jobResume.cancelWait(session);
        for (const job of require('./jobs').listJobs()) {
          if (job.session_id === session.id && ['queued', 'starting', 'running'].includes(job.status)) require('./jobs').cancelJob(job.id);
        }
        if (session.status === 'waiting_jobs') session.status = 'idle';
        persistSession(session);
      }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const dir = path.join(WORKSPACE, '.attachments');
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}_${String(b.name || 'image.png').replace(/[\\/:*?"<>|]/g, '_')}`;
      const buf = Buffer.from(b.dataB64 || '', 'base64');
      if (!buf.length) return json(res, 400, { error: 'empty upload' });
      if (buf.length > 60 * 1024 * 1024) return json(res, 413, { error: '附件过大（>60MB）' });
      atomicWrite(path.join(dir, name), buf);
      // 自动解析（应用层复审 §10）：上传即探测 PDF 文本层/Excel 工作表清单/扫描质量，
      // 返回诊断让前端展示，减少模型读题重复花的钱
      let probe = null;
      let manifestResult = { archived: 0, archive: null };
      try {
        const { probeFile } = require('./attachments');
        probe = await probeFile(path.join(dir, name));
        // 同时维护会话级 attachment_manifest（持久化在 session）
        if (b.session_id) {
          const s = getSession(b.session_id);
          if (s) {
            s.attachment_manifest = s.attachment_manifest || [];
            s.attachment_manifest.push(Object.assign({ at: Date.now() }, probe));
            manifestResult = trimAttachmentManifest(s);
            persistSession(s);
          }
        }
      } catch (e) { probe = { error: String(e.message || e).slice(0, 160) }; }
      return json(res, 200, {
        path: `.attachments/${name}`, size: buf.length, probe,
        manifest_archived: manifestResult.archived,
        manifest_archive: manifestResult.archive ? path.relative(APP_DIR, manifestResult.archive).replace(/\\/g, '/') : null,
      });
    }
    if (p === '/api/file' && req.method === 'GET') {
      let sb; try { sb = sandboxForPath(url.searchParams.get('path') || ''); } catch { sb = createSandbox(APP_DIR); }
      let abs;
      try { abs = sb.resolve(url.searchParams.get('path') || '', 'r'); } catch (e) { res.writeHead(403); return res.end(String(e.message)); }
      // 追加令牌 query 由前端拼；此处不再单独鉴权（上面统一做了）
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" });
      return res.end(fs.readFileSync(abs));
    }
    if (p === '/api/open_file' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      let sb; try { sb = sandboxForPath(b.path); } catch { sb = createSandbox(APP_DIR); }
      let abs; try { abs = sb.resolve(b.path, 'r'); } catch (e) { return json(res, 403, { error: e.message }); }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: '文件不存在' });
      if (!OPEN_EXT_OK.has(path.extname(abs).toLowerCase())) return json(res, 403, { error: `拒绝用系统程序打开 ${path.extname(abs) || '该类型'} 文件（仅允许文档/图片等产物类型）` });
      require('child_process').spawn('cmd.exe', ['/c', 'start', '', abs], { windowsHide: true });
      return json(res, 200, { ok: true });
    }
    // 外部模型交接（应用层复审 §10）
    if (p === '/api/handoff/list' && req.method === 'GET') {
      const { loadHandoffs } = require('./external');
      const list = loadHandoffs(APP_DIR).filter(h => h.status === 'pending' || h.status === 'imported');
      return json(res, 200, { handoffs: list.slice(-20).reverse() });
    }
    if (p === '/api/handoff/import' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const { importHandoffResult } = require('./external');
      const h = importHandoffResult(APP_DIR, String(b.id || ''), b.result, b.session_id);
      if (!h) return json(res, 404, { error: 'handoff 不存在' });
      return json(res, 200, { ok: true, handoff: h });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const cur = loadSettings();
      try {
        if (Object.hasOwn(b, 'reasoning_effort') && !['on', 'off'].includes(b.reasoning_effort)) throw new Error('reasoning_effort 必须为 on 或 off（DeepSeek旧配置开关）');
        if (Object.hasOwn(b, 'model_reasoning')) b.model_reasoning = require('./reasoning').normalizeModelReasoning(b.model_reasoning);
        if (Object.hasOwn(b, 'model_reasoning_limits')) b.model_reasoning_limits = require('./reasoning').normalizeReasoningLimits(b.model_reasoning_limits);
        if (Object.hasOwn(b, 'reasoning_fallback') && !['error', 'provider_default'].includes(b.reasoning_fallback)) throw new Error('reasoning_fallback 必须为 error 或 provider_default');
        // Validate all model list fields before writing keys or settings. Empty
        // arrays are meaningful; duplicate names are canonicalized after trim.
        validateModelSettingsPayload(b, cur);
      } catch (e) { return json(res, 400, { error: e.message }); }
      // 密钥只写入专用 key 文件，绝不合并进 settings.json，也绝不回显
      const keyFields = { deepseek_key: 'deepseek.key', glm_key: 'glm.key', moonshot_key: 'moonshot.key', qwen_key: 'qwen.key', openai_key: 'openai.key', xai_key: 'xai.key', anthropic_key: 'anthropic.key' };
      const rest = { ...b };
      for (const [field, file] of Object.entries(keyFields)) {
        if (rest[field]) fs.writeFileSync(path.join(APP_DIR, 'config', file), String(rest[field]).trim(), 'utf8');
        delete rest[field];
      }
      // 自定义供应商（v2.5）：定义进 settings.custom_providers，Key 按约定落 config/custom_<id>.key。
      // 只接受形状合法的条目（id 安全、不与内置撞名、base 必须是 http(s)）——写坏一个条目会让启动时的
      // 提供商解析整体错乱，所以在入口就过滤掉，而不是等运行时炸。
      if (Array.isArray(rest.custom_providers)) {
        const seen = new Set();
        rest.custom_providers = rest.custom_providers.map(c => {
          const id = String((c && c.id) || '').trim().toLowerCase();
          if (!PROVIDERS[id] && CUSTOM_ID_RE.test(id) && !seen.has(id)) { seen.add(id); return {
            id, name: String((c.name || id)).slice(0, 40),
            base: String(c.base || '').trim().replace(/\/+$/, ''),
            kind: PROTOCOL_KINDS.includes(c.kind) ? c.kind : 'openai',
            models: (Array.isArray(c.models) ? c.models : []).map(x => String(x).trim()).filter(Boolean).slice(0, 40),
            ctx_limit: Number(c.ctx_limit) > 0 ? Number(c.ctx_limit) : undefined,
            max_tokens: Number(c.max_tokens) > 0 ? Number(c.max_tokens) : undefined,
          }; }
          return null;
        }).filter(Boolean);
        // 每个自定义供应商的 Key（表单字段名 custom_<id>_key）；留空则不动已保存的 key 文件
        for (const c of rest.custom_providers) {
          const f = rest['custom_' + c.id + '_key'];
          if (f) fs.writeFileSync(path.join(APP_DIR, 'config', 'custom_' + c.id + '.key'), String(f).trim(), 'utf8');
        }
      }
      for (const k of Object.keys(rest)) if (/^custom_.+_key$/.test(k)) delete rest[k];
      if (Object.prototype.hasOwnProperty.call(rest, 'role_models')) rest.role_models = normalizeRoleModels(rest.role_models);
      saveSettings({ ...cur, ...rest });
      return json(res, 200, { ok: true, settings: loadSettings() });
    }
    if (p === '/api/skill/preview' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const session = b.session_id ? getSession(b.session_id) : null;
      if (b.session_id && !session) return json(res, 404, { error: '会话不存在' });
      try { const r = projectPlan.loadSessionSkill(APP_DIR, session, b.name, b.file, loadSettings()); return json(res, 200, { content: r.content.slice(0, 40000) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    // ---------- 技能首检质检（全局开关默认关；同指纹零 API；修复须用户确认） ----------
    if (p === '/api/skill/quality' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const session = b.session_id ? getSession(b.session_id) : null;
      if (b.session_id && !session) return json(res, 404, { error: '会话不存在' });
      try {
        // 质检与槽位适配无关：用 loadSkill（同 skill_quality 工具），main-only 技能无会话也能查。
        const r = require('./skills').loadSkill(APP_DIR, b.name, null, projectPlan.skillOptions(loadSettings(), session?.skill_plan_snapshot?.root));
        const marker = r.sha256 ? skillQuality.readMarker(APP_DIR, r.sha256) : null;
        return json(res, 200, { enabled: skillQuality.settingsOf(loadSettings()).enabled, sha256: r.sha256, marker });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/skill/quality/skip' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const session = b.session_id ? getSession(b.session_id) : null;
      if (b.session_id && !session) return json(res, 404, { error: '会话不存在' });
      try {
        const r = require('./skills').loadSkill(APP_DIR, b.name, null, projectPlan.skillOptions(loadSettings(), session?.skill_plan_snapshot?.root));
        if (!r.sha256) throw new Error('该技能无法生成完整指纹，无法标记');
        const marker = skillQuality.declineSkill(APP_DIR, { name: r.name, sha256: r.sha256 });
        return json(res, 200, { ok: true, marker });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/skill/quality/recheck' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const session = b.session_id ? getSession(b.session_id) : null;
      if (b.session_id && !session) return json(res, 404, { error: '会话不存在' });
      const st = loadSettings();
      try {
        const r = require('./skills').loadSkill(APP_DIR, b.name, null, projectPlan.skillOptions(st, session?.skill_plan_snapshot?.root));
        const result = await skillQuality.checkSkill({ appDir: APP_DIR, settings: st, name: r.name,
          sha256: r.sha256, content: r.content, refs: r.refs, force: true });
        if (result.status === 'checked' && result.marker?.usage) {
          const usage = {
            prompt_tokens: Number(result.marker.usage.prompt_tokens || 0),
            completion_tokens: Number(result.marker.usage.completion_tokens || 0),
            cache_hit_tokens: Number(result.marker.usage.prompt_cache_hit_tokens || result.marker.usage.prompt_tokens_details?.cached_tokens || 0),
          };
          const model = String(result.marker.model).split(':').slice(1).join(':') || String(result.marker.model);
          if (session) { try { makeSpend(session, { ledger: loadLedger(APP_DIR), settings: st, appDir: APP_DIR })(model, usage, 'skill_quality'); } catch {} }
          else require('./meter').record(APP_DIR, { t: Date.now(), model, kind: 'skill_quality', session_id: null, project_id: null, ...usage });
        }
        if (session && result.status === 'checked') {
          try {
            session.system = buildSystem(session.mode, sessionRoot(session), st, APP_DIR, session.system_provider, session.skill_override, session);
            persistSession(session);
          } catch {}
        }
        return json(res, 200, result);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/skill/quality/repair' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const session = b.session_id ? getSession(b.session_id) : null;
      if (b.session_id && !session) return json(res, 404, { error: '会话不存在' });
      const st = loadSettings();
      try {
        const options = projectPlan.skillOptions(st, session?.skill_plan_snapshot?.root);
        const result = await skillQuality.repairSkill({ appDir: APP_DIR, settings: st, name: b.name, options });
        if (result.usage) {
          const usage = {
            prompt_tokens: Number(result.usage.prompt_tokens || 0),
            completion_tokens: Number(result.usage.completion_tokens || 0),
            cache_hit_tokens: Number(result.usage.prompt_cache_hit_tokens || result.usage.prompt_tokens_details?.cached_tokens || 0),
          };
          const model = String(result.model).split(':').slice(1).join(':') || String(result.model);
          if (session) { try { makeSpend(session, { ledger: loadLedger(APP_DIR), settings: st, appDir: APP_DIR })(model, usage, 'skill_quality'); } catch {} }
          else require('./meter').record(APP_DIR, { t: Date.now(), model, kind: 'skill_quality', session_id: null, project_id: null, ...usage });
        }
        return json(res, 200, result);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    json(res, 404, { error: 'no route: ' + p });
  } catch (e) {
    json(res, 500, { error: String(e.stack || e).slice(0, 500) });
  }
});
// ---------- 启动 ----------
const STARTED_AT = new Date().toISOString();
const CODE_STAMP = require('./version').codeStamp(APP_DIR);
function listen(startPort, cb) {
  server.once('error', () => (startPort < 18670 ? listen(startPort + 1, cb) : cb(null)));
  server.listen(startPort, '127.0.0.1', () => cb(startPort));
}
// 单实例：已有羲和服务在跑就不再起第二个（两个服务共用同一会话目录会互相覆盖——v2.4 实测 V-9）
async function findRunning() {
  for (let p = 18652; p <= 18670; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) });
      const j = await r.json();
      if (j && j.app === 'xihe-agent') return p;
    } catch {}
  }
  return null;
}
// XIHE_PORT：显式指定端口，且跳过"已在运行就复用退出"的单实例守卫。
// 用途：开发/测试时起一个旁路实例（不打断用户正在用的那个）；正常启动不设这个变量。
const FORCED_PORT = Number(process.env.XIHE_PORT);
const forced = Number.isInteger(FORCED_PORT) && FORCED_PORT > 0 && FORCED_PORT < 65536 ? FORCED_PORT : null;
function main() {
  if (forced) {
    console.log('XIHE_PORT=' + forced + '：跳过单实例守卫，在指定端口启动旁路实例');
    return startListening(forced);
  }
  return findRunning().then((existing) => {
    if (!existing) return startListening();
    const url = `http://127.0.0.1:${existing}`;
    console.log('羲和服务已在运行: ' + url + '（不再启动第二个实例）');
    if (process.argv.includes('--open-edge')) {
      require('child_process').spawn('cmd.exe', ['/c', 'start', '', 'msedge', '--app=' + url], { windowsHide: true });
    }
    process.exit(0);
  });
}
// 只有被当作入口启动时才起服务。测试 require 本模块拿纯函数，不能顺手占用端口、
// 改写 data/port.txt、预热环境体检。
if (require.main === module) main();

module.exports = {
  // 供离线回归测试使用（core/test_sandbox.js）：项目路径解析与安全校验是硬边界，
  // 必须有可跑的断言，不能只靠手工点。
  projectDir, projectWorkspace, validateProjectRoot, sandboxForPath, isExternalProject,
  ensureProject, listProjects, PROJECT_ID_RE, PROJECTS_DIR, _inside, SYS_DENY, trimAttachmentManifest,
  validateModelSettingsPayload,
  resolveProviderTestRequest,
};
function startListening(port) {
let releaseRuntime;
try { releaseRuntime = require('./runtime_lock').acquireRuntimeLock(path.join(DATA_DIR, 'runtime.lock')); }
catch (e) { console.error(e.message); process.exitCode = 1; return; }
process.once('exit', releaseRuntime);
server.once('close', releaseRuntime);
// 启动即后台预热环境体检（python/matlab），新建会话不再同步等待
try { require('./env_check').warmup(); } catch {}
// 同时预热技能索引：首次 buildIndex 要读 225 个 SKILL.md（实测 220 ms），
// 不预热的话这笔钱全落在界面第一次 /api/bootstrap 上（启动发钝的元凶之一）。
try { setTimeout(() => { try { getIndex(APP_DIR); } catch {} }, 0); } catch {}
listen(port || 18652, (port) => {
  if (!port) { console.error('无可用端口'); process.exit(1); }
  // 先取得监听实例再恢复/派发。双击第二个窗口不会改写原实例会话或启动第二批任务。
  try { require('./meter').captureUsageHistory(APP_DIR); }
  catch (e) { console.warn('历史用量快照保存失败：' + e.message); }
  recoverSessions();
  try {
    const jobs = require('./jobs');
    jobs.subscribe(event => {
      notices().observe(event);
      broadcastJob(event);
      if (['finish', 'needs_review'].includes(event.type)) setImmediate(wakeJobSessions);
    });
    jobs.recoverJobs({ start: false });
    for (const job of jobs.listJobs()) notices().observe({ type: 'recovered', job: jobs.publicMeta(job) });
    jobs.startScheduler();
  } catch (e) { console.warn('后台任务恢复失败：' + e.message); }
  const wakeTimer = setInterval(wakeJobSessions, 3000);
  wakeTimer.unref(); setImmediate(wakeJobSessions);
  server.once('close', () => { clearInterval(wakeTimer); require('./jobs').stopScheduler(); });
  fs.writeFileSync(path.join(DATA_DIR, 'port.txt'), String(port));
  const url = `http://127.0.0.1:${port}`;
  console.log('羲和 Agent 核心已启动: ' + url + '  （工作区: ' + WORKSPACE + '）');
  if (process.argv.includes('--open-electron') || process.argv.includes('--open-edge')) {
    const { spawn } = require('child_process');
    spawn('cmd.exe', ['/c', 'start', '', 'msedge', '--app=' + url], { windowsHide: true });
    console.log('已尝试用 Edge 应用模式打开窗口。');
  }
  if (process.argv.includes('--open-browser')) {
    const { spawn } = require('child_process');
    spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
  }
});
}
