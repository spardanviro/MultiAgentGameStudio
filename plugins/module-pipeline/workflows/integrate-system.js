export const meta = {
  name: 'module-pipeline-integrate',
  description: 'Write glue code for merged modules in an isolated worktree, commit it on the run branch, run diagnostics, and review the whole system against the spec',
  whenToUse: 'Invoked by /module-pipeline:integrate after every module is merged. Requires args {pluginRoot, manifest}.',
  phases: [
    { title: 'Prepare', detail: 'confirm every module is merged' },
    { title: 'Integrate', detail: 'integration agent in an isolated worktree' },
    { title: 'Merge', detail: 'audit scope and commit the glue code' },
    { title: 'Diagnostics', detail: "run the manifest's compile and test commands on the run branch" },
    { title: 'Review', detail: 'read-only system review against the spec' },
  ],
}

const { pluginRoot, manifest } = args || {}
if (typeof pluginRoot !== 'string' || typeof manifest !== 'string') {
  throw new Error('module-pipeline-integrate requires args {pluginRoot, manifest}')
}
for (const value of [pluginRoot, manifest]) {
  if (/["\r\n]/.test(value)) {
    throw new Error(`Unsafe path argument: ${JSON.stringify(value)}`)
  }
}
const CLI = `node "${pluginRoot}/scripts/pipeline.mjs"`
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// Every agent runs on the strongest model; roles differ only in thinking
// effort. Until prepare returns the manifest's settings, ops runs at the default
// pipeline_ops effort (medium).
let model = 'opus'
let opsEffort = 'medium'

const OPS_SCHEMA = {
  type: 'object',
  required: ['exitCode', 'stdout'],
  properties: {
    exitCode: { type: 'integer' },
    stdout: { type: 'string', description: 'The complete stdout of the command, verbatim' },
  },
}

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
    verdict: { type: 'string', enum: ['pass', 'rework'] },
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

const bullets = (items) => (items && items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none)')

function agentOptions(effort) {
  return EFFORTS.includes(effort) ? { model, effort } : { model }
}

async function ops(command, label, phaseTitle) {
  const reply = await agent(
    `Run this command exactly once and report its exit code and complete stdout verbatim:\n\n${command}`,
    { agentType: 'module-pipeline:pipeline-ops', schema: OPS_SCHEMA, label, phase: phaseTitle, ...agentOptions(opsEffort) },
  )
  if (!reply) {
    throw new Error(`${label}: the ops agent did not return`)
  }
  try {
    return JSON.parse(reply.stdout)
  } catch (error) {
    throw new Error(`${label}: output was not JSON (exit ${reply.exitCode}): ${String(reply.stdout).slice(0, 400)}`)
  }
}

function testSummary(diagnostics) {
  const tests = diagnostics && diagnostics.tests
  if (!tests) return 'not configured'
  if (tests.skipped) return `skipped (${tests.reason})`
  if (!tests.failed) return `passed (${tests.command})`
  return `failed (${tests.command}, exit ${tests.exitCode})\n${fence((tests.tail || []).slice(-20).join('\n'))}`
}

const moduleLines = (modules) =>
  modules.map((module) => `- ${module.id} (${module.feature}): owns ${module.ownedFolder || module.ownedScript}; report ${module.report}`).join('\n')

phase('Prepare')
const plan = await ops(`${CLI} prepare "${manifest}" --stage integration`, 'prepare', 'Prepare')
if (!plan.ok) {
  return { stage: 'integration', status: 'blocked', reason: 'prepare_failed', errors: plan.errors || [plan.error] }
}
model = plan.model || model
opsEffort = plan.efforts.pipelineOps

let integration = { status: 'already_merged' }
let impl = null
if (plan.integration) {
  const task = plan.integration
  impl = await agent(
    `Write the integration glue for run ${plan.runId}.
Run goal: ${plan.goal || '(see the spec)'}

1. Claim your worktree before anything else:
   ${CLI} claim --run ${plan.runId} --task integration
2. Read your instructions in ${task.promptFile}, plus docs/architecture.md, docs/module_contracts.md and the module reports below.
3. Wire the modules together, run the project's build/tests if available, and write your integration report.

You may write only:
${bullets(task.allowedFiles)}
Integration report: ${task.report}
Interface requests (anything a module is missing): ${task.interfaceRequest}

Merged modules:
${moduleLines(plan.modules)}

Acceptance criteria:
${bullets(task.acceptance)}`,
    {
      agentType: 'module-pipeline:integrator',
      isolation: 'worktree',
      schema: IMPL_SCHEMA,
      label: 'integrate',
      phase: 'Integrate',
      ...agentOptions(task.effort),
    },
  )
  integration = await ops(`${CLI} integrate-task --run ${plan.runId} --task integration`, 'merge:integration', 'Merge')
  // 'empty' means the existing glue already fits (common in rework runs); the
  // system review below still checks the whole result.
  if (integration.status !== 'merged' && integration.status !== 'empty') {
    return {
      stage: 'integration',
      runId: plan.runId,
      runBranch: plan.runBranch,
      status: 'integration_failed',
      integration,
      integrator: impl,
      next: 'rework',
    }
  }
}

phase('Diagnostics')
const diagnostics = await ops(`${CLI} diagnostics --run ${plan.runId}`, 'diagnostics', 'Diagnostics')

phase('Review')
const review = await agent(
  `Review the integrated result of run ${plan.runId} against the implementation spec.

Spec: ${plan.spec || 'docs/ (find the implementation spec; the manifest names none)'}
Run branch: ${plan.runBranch} (use git log / git show to see every module and the glue commit). Your working directory may be on a different branch; read files with \`git show ${plan.runBranch}:<path>\`.
${plan.integration ? `Integration report: ${plan.integration.report}` : ''}

Modules:
${moduleLines(plan.modules)}

Tests: ${testSummary(diagnostics)}
Compile diagnostics: ${diagnostics.ran && diagnostics.command ? `${diagnostics.errorCount} errors, ${diagnostics.warningCount} warnings${diagnostics.errors && diagnostics.errors.length ? `\n${fence(diagnostics.errors.slice(0, 15).join('\n'))}` : ''}` : 'not configured'}

${impl ? `The integrator's own account (a claim to verify, not evidence):\n${fence(`${impl.summary}\nExecution order: ${impl.executionOrder || '-'}\nTests: ${impl.testsRun}`)}` : ''}

Number issues SYS-1, SYS-2, and so on.`,
  {
    agentType: 'module-pipeline:system-reviewer',
    schema: SYSTEM_REVIEW_SCHEMA,
    label: 'system-review',
    phase: 'Review',
    ...agentOptions(plan.efforts.systemReviewer),
  },
)

const blockingItems = (review ? review.rework_items : []).filter((item) => item.blocks_release === true || item.severity === 'critical')
const status = !review
  ? 'review_missing'
  : blockingItems.length
    ? 'rework_required'
    : diagnostics.failed
      ? 'diagnostics_failed'
      : 'passed'

return {
  stage: 'integration',
  runId: plan.runId,
  runBranch: plan.runBranch,
  status,
  integration,
  integrator: impl,
  diagnostics,
  review,
  blockingItems,
  next: status === 'passed' ? 'merge_run_branch' : 'rework',
}
