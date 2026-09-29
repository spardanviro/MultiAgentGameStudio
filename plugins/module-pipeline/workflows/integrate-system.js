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

const IMPL_SCHEMA = {
  type: 'object',
  required: ['summary', 'testsRun', 'blockers'],
  properties: {
    summary: { type: 'string' },
    executionOrder: { type: 'string', description: 'How the modules are started and in which order' },
    testsRun: { type: 'string', description: 'Commands run and their outcome, or "none"' },
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

const SYSTEM_REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'spec_coverage', 'rework_items'],
  properties: {
    merge: MERGE_SCHEMA,
    diagnostics: DIAGNOSTICS_SCHEMA,
    verdict: { type: 'string', enum: ['pass', 'rework', 'not_merged'] },
    summary: { type: 'string' },
    spec_coverage: {
      type: 'array',
      items: {
        type: 'object',
        required: ['feature', 'status'],
        properties: {
          feature: { type: 'string' },
          status: { type: 'string', enum: ['done', 'partial', 'missing'] },
          owner: { type: 'string' },
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
2. Read the prompt file, docs/architecture.md, docs/module_contracts.md, docs/conventions.md if it exists, and the module reports.
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
  `Review the integrated result on branch ${runBranch} against the spec${spec ? ` (${spec})` : ''}. Your working directory may be on another branch; read files with \`git show ${runBranch}:<path>\`. The manifest (${manifest}) lists every module, its folder and its report.`,
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
// 'empty' means the existing glue already fits (common in rework runs).
const integrationFailed = !merge || (merge.status !== 'merged' && merge.status !== 'empty' && merge.status !== 'already_merged')
const status = !review
  ? 'review_missing'
  : integrationFailed
    ? 'integration_failed'
    : blockingItems.length
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
  review: review ? { verdict: review.verdict, summary: review.summary, spec_coverage: review.spec_coverage, rework_items: review.rework_items } : null,
  blockingItems,
  next: status === 'passed' ? 'merge_run_branch' : 'rework',
}
