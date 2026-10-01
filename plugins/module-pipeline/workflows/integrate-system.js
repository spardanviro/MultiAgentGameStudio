export const meta = {
  name: 'module-pipeline-integrate',
  description: 'Write glue code for merged modules in an isolated worktree; the system reviewer commits it, runs diagnostics and reviews the whole system against the spec',
  whenToUse: 'Invoked by /module-pipeline:integrate with the workflowArgs that `pipeline.mjs prepare --stage integration` printed.',
  phases: [
    { title: 'Integrate', detail: 'integration agent in an isolated worktree' },
    { title: 'Review', detail: 'commit the glue, run diagnostics, review the whole system against the spec' },
  ],
}

// args is the workflowArgs object from `pipeline.mjs prepare --stage integration`.
const { pluginRoot, runId, runBranch, goal, spec, manifest, integration, modules, efforts } = args || {}
if (typeof pluginRoot !== 'string' || typeof runId !== 'string' || !Array.isArray(modules) || !efforts) {
  throw new Error('module-pipeline-integrate requires the workflowArgs printed by `pipeline.mjs prepare --stage integration`')
}
if (/["\r\n]/.test(pluginRoot) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
  throw new Error(`Unsafe argument: ${JSON.stringify({ pluginRoot, runId })}`)
}
const CLI = `node "${pluginRoot}/scripts/pipeline.mjs"`
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// Every agent runs on the strongest model; roles differ only in thinking effort.
const model = args.model || 'opus'
// The cross-module rules file (shared_layer.rules), when the run has one.
const rules = typeof args.rules === 'string' ? args.rules : null
const rulesRead = rules ? `, ${rules} (the cross-module rules)` : ''

const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary', 'testsRun', 'blockers'],
  properties: {
    summary: { type: 'string', description: 'What was wired, in five sentences at most; the detail belongs in the integration report' },
    executionOrder: { type: 'string', description: 'How the modules are started and in which order' },
    testsRun: { type: 'string', description: 'Each command run and its outcome on one line, or "none"' },
    testsPassed: { type: 'boolean' },
    interfaceRequests: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['status'],
  description: 'Fields copied from the JSON the merge command printed',
  properties: {
    status: { type: 'string', description: 'merged, empty, violation, unclaimed or merge_failed' },
    commit: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    violations: { type: 'array', items: { type: 'string' } },
    error: { type: 'string', description: 'error or reason, if any' },
  },
}

const DIAGNOSTICS_SCHEMA = {
  type: 'object',
  required: ['failed', 'summary'],
  description: 'From the JSON the diagnostics command printed',
  properties: {
    failed: { type: 'boolean', description: 'The `failed` field' },
    summary: { type: 'string', description: 'Compile errors/warnings count and the test result, one or two lines' },
  },
}

const SYSTEM_ITEM = {
  type: 'object',
  required: ['issue_id', 'severity', 'scope', 'problem', 'expected_behavior', 'actual_behavior', 'evidence', 'recommended_owner', 'recommended_action', 'blocks_release'],
  properties: {
    issue_id: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    scope: { type: 'string', description: 'A module id, "integration", or "architecture"' },
    problem: { type: 'string' },
    expected_behavior: { type: 'string' },
    actual_behavior: { type: 'string' },
    evidence: { type: 'string', description: 'file:line references' },
    recommended_owner: { type: 'string', description: 'module id, integration, new_module, main_architect, or user' },
    recommended_action: { type: 'string', enum: ['reassign_to_same_agent', 'create_new_task', 'contract_change', 'main_agent_decision'] },
    blocks_release: { type: 'boolean' },
  },
}

// One entry per topic of the cross-module rules file. No single module review
// can see whether every module does these the same way, so the system
// reviewer has to answer for each.
const RULE_CHECK = {
  type: 'object',
  required: ['topic', 'status', 'evidence'],
  properties: {
    topic: { type: 'string', description: 'A heading of the cross-module rules file' },
    status: { type: 'string', enum: ['followed', 'violated', 'not_applicable'] },
    evidence: { type: 'string', description: 'What you searched or ran, and file:line of every place that sidesteps the rule' },
  },
}

const SYSTEM_REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'spec_coverage', 'rework_items', ...(rules ? ['rule_checks'] : [])],
  properties: {
    rule_checks: { type: 'array', items: RULE_CHECK },
    merge: MERGE_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
    verdict: { type: 'string', enum: ['pass', 'rework', 'not_merged'] },
    summary: { type: 'string', description: 'Five sentences at most; each problem goes into a rework item' },
    spec_coverage: {
      type: 'array',
      items: {
        type: 'object',
        required: ['feature', 'status'],
        properties: {
          feature: { type: 'string' },
          status: { type: 'string', enum: ['done', 'partial', 'missing'] },
          owner: { type: 'string' },
          deferred: {
            type: 'boolean',
            description: 'true only for a partial or missing feature that the spec itself or a rework decision (reports/rework/) puts off; say where in note',
          },
          note: { type: 'string', description: 'What is missing, or where the deferral is written' },
        },
      },
    },
    rework_items: { type: 'array', items: SYSTEM_ITEM },
  },
}

const fence = (text) =>
  `<<<AGENT_OUTPUT\n${String(text == null ? '' : text).replace(/<<<AGENT_OUTPUT|AGENT_OUTPUT>>>/g, '[marker removed]')}\nAGENT_OUTPUT>>>`

function agentOptions(effort) {
  return EFFORTS.includes(effort) ? { model, effort } : { model }
}

let impl = null
if (integration) {
  phase('Integrate')
  impl = await agent(
    `Write the integration glue for run ${runId}.
Run goal: ${goal || '(see the spec)'}

1. Claim your worktree first:
   ${CLI} claim --run ${runId} --task integration
   It prints your task as JSON: prompt file, the files you may write, report and interface request paths, acceptance criteria.
2. Read the prompt file, docs/architecture.md, docs/module_contracts.md${rulesRead}, docs/conventions.md if it exists, and the module reports.
3. Wire the modules together, run the project's build and tests, and write your integration report.

Merged modules: ${modules.join(', ')}`,
    {
      agentType: 'module-pipeline:integrator',
      isolation: 'worktree',
      schema: IMPL_SCHEMA,
      label: 'integrate',
      phase: 'Integrate',
      ...agentOptions(integration.effort),
    },
  )
}

phase('Review')
const steps = [
  integration
    ? `Commit the integration glue:
   ${CLI} integrate-task --run ${runId} --task integration
   Copy status, commit, files, violations and error (or reason) from its JSON into \`merge\`. Status \`empty\` means the existing glue already fits; carry on. For any status other than \`merged\` or \`empty\`, stop there: verdict \`not_merged\`, no rework items.`
    : null,
  `Run the project's compile and test commands on the run branch:
   ${CLI} diagnostics --run ${runId}
   Put its \`failed\` field and a one or two line summary into \`diagnostics\`; its log file has the full output.`,
  `Review the integrated result on branch ${runBranch} against the spec${spec ? ` (${spec})` : ''}. Your working directory may be on another branch; read files with \`git show ${runBranch}:<path>\`. The manifest (${manifest}) lists every module, its folder and its report. List every feature of the spec in \`spec_coverage\`. A \`partial\` or \`missing\` feature blocks the run, so write a rework item for it; mark it \`deferred\` only when the spec or a decision under reports/rework/ puts it off, and say where in \`note\`.`,
  rules
    ? `Audit the seams against ${rules}. For every topic heading in it, search all module folders and the glue (\`git grep <pattern> ${runBranch}\`) for code or tests that sidestep the rule, and run a short end-to-end check where one settles it. Put one entry per topic into \`rule_checks\`, and write a rework item with \`blocks_release: true\` for every violation.`
    : null,
].filter(Boolean)

const review = await agent(
  `Review run ${runId} as a whole.

${steps.map((step, index) => `${index + 1}. ${step}`).join('\n\n')}

Modules: ${modules.join(', ')}
${impl ? `\nThe integrator's own account (a claim to verify, not evidence):\n${fence(`${impl.summary}\nExecution order: ${impl.executionOrder || '-'}\nTests: ${impl.testsRun}`)}\n` : ''}
Number issues SYS-1, SYS-2, and so on.`,
  {
    agentType: 'module-pipeline:system-reviewer',
    schema: SYSTEM_REVIEW_SCHEMA,
    label: 'system-review',
    phase: 'Review',
    ...agentOptions(efforts.systemReviewer),
  },
)

const merge = integration ? (review && review.merge) || null : { status: 'already_merged' }
const diagnostics = (review && review.diagnostics) || null
const blockingItems = (review ? review.rework_items || [] : []).filter((item) => item.blocks_release === true || item.severity === 'critical')
// A broken cross-module rule blocks the run even when the reviewer wrote no
// blocking item for it: such defects sit between modules and spread.
const ruleViolations = (review ? review.rule_checks || [] : []).filter((check) => check.status === 'violated')
// The gate is computed, not taken from the reviewer's verdict: a feature the
// review found partial or missing blocks the run whether or not a blocking
// item was written for it, unless it is deferred on record.
const coverageGaps = (review ? review.spec_coverage || [] : []).filter((row) => row.status !== 'done' && row.deferred !== true)
// 'empty' means the existing glue already fits (common in rework runs).
const integrationFailed = !merge || (merge.status !== 'merged' && merge.status !== 'empty' && merge.status !== 'already_merged')
const status = !review
  ? 'review_missing'
  : integrationFailed
    ? 'integration_failed'
    : blockingItems.length || ruleViolations.length || coverageGaps.length
      ? 'rework_required'
      : !diagnostics || diagnostics.failed
        ? 'diagnostics_failed'
        : 'passed'

return {
  stage: 'integration',
  runId,
  runBranch,
  status,
  integration: merge,
  integrator: impl,
  diagnostics,
  review: review
    ? { verdict: review.verdict, summary: review.summary, spec_coverage: review.spec_coverage, rule_checks: review.rule_checks || [], rework_items: review.rework_items }
    : null,
  blockingItems,
  ruleViolations,
  coverageGaps,
  next: status === 'passed' ? 'merge_run_branch' : 'rework',
}
