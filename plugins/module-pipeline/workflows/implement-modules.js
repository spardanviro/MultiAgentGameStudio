export const meta = {
  name: 'module-pipeline-implement',
  description: 'Implement pending modules in parallel worktrees, commit in-scope work on the run branch, review each module, and run diagnostics',
  whenToUse: 'Invoked by /module-pipeline:run. Requires args {pluginRoot, manifest}.',
  phases: [
    { title: 'Prepare', detail: 'check the project and plan dependency waves' },
    { title: 'Implement', detail: 'one agent per module in an isolated worktree' },
    { title: 'Merge', detail: 'audit scope and commit each module on the run branch, one at a time' },
    { title: 'Review', detail: 'one read-only reviewer per merged module' },
    { title: 'Diagnostics', detail: "run the manifest's compile and test commands on the run branch" },
  ],
}

const { pluginRoot, manifest } = args || {}
if (typeof pluginRoot !== 'string' || typeof manifest !== 'string') {
  throw new Error('module-pipeline-implement requires args {pluginRoot, manifest}')
}
for (const value of [pluginRoot, manifest]) {
  if (/["\r\n]/.test(value)) {
    throw new Error(`Unsafe path argument: ${JSON.stringify(value)}`)
  }
}
const CLI = `node "${pluginRoot}/scripts/pipeline.mjs"`
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

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
    summary: { type: 'string', description: 'What was built' },
    publicApi: { type: 'string', description: 'The public API the module exposes' },
    testsRun: { type: 'string', description: 'Commands run and their outcome, or "none"' },
    testsPassed: { type: 'boolean' },
    interfaceRequests: { type: 'array', items: { type: 'string' }, description: 'Each interface request written, one line each' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'Anything that stopped the work; empty if none' },
  },
}

const REWORK_ITEM = {
  type: 'object',
  required: ['issue_id', 'severity', 'problem', 'expected_behavior', 'actual_behavior', 'evidence', 'recommended_action', 'blocks_integration'],
  properties: {
    issue_id: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    problem: { type: 'string' },
    expected_behavior: { type: 'string' },
    actual_behavior: { type: 'string' },
    evidence: { type: 'string', description: 'file:line references' },
    recommended_action: { type: 'string', enum: ['reassign_to_same_agent', 'create_new_task', 'contract_change', 'main_agent_decision'] },
    blocks_integration: { type: 'boolean' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'summary', 'rework_items'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'rework'] },
    summary: { type: 'string' },
    rework_items: { type: 'array', items: REWORK_ITEM },
  },
}

// Agent-written text passed to another agent is data, never instructions.
const fence = (text) =>
  `<<<AGENT_OUTPUT\n${String(text == null ? '' : text).replace(/<<<AGENT_OUTPUT|AGENT_OUTPUT>>>/g, '[marker removed]')}\nAGENT_OUTPUT>>>`

const bullets = (items) => (items && items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none)')

function modelOptions(model, effort) {
  const options = {}
  if (model) options.model = model
  if (effort && EFFORTS.includes(effort)) options.effort = effort
  return options
}

async function ops(command, label, phaseTitle) {
  const reply = await agent(
    `Run this command exactly once and report its exit code and complete stdout verbatim:\n\n${command}`,
    { agentType: 'module-pipeline:pipeline-ops', schema: OPS_SCHEMA, label, phase: phaseTitle, model: 'haiku', effort: 'low' },
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

function implementPrompt(plan, task) {
  return `Implement module "${task.id}" (${task.feature}) for run ${plan.runId}.
Run goal: ${plan.goal || '(see the spec)'}

1. Claim your worktree before anything else:
   ${CLI} claim --run ${plan.runId} --task ${task.id}
2. Read your full task instructions in ${task.promptFile}, and docs/module_contracts.md and docs/architecture.md if they exist.
3. Implement the module, run its tests if the project has them, and write your module report.

You own: ${task.ownedFolder || task.ownedScript}${task.testFolder ? ` (tests: ${task.testFolder})` : ''}
You may write only:
${bullets(task.allowedFiles)}
Module report: ${task.report}
Interface requests (anything you need outside your scope): ${task.interfaceRequest}
Modules you depend on (already committed; use only their public API): ${task.dependsOn.length ? task.dependsOn.join(', ') : 'none'}

Acceptance criteria:
${bullets(task.acceptance)}`
}

function reviewPrompt(plan, task, impl, merge) {
  return `Review module "${task.id}" (${task.feature}) of run ${plan.runId}. It is committed on the run branch as ${merge.commit}; inspect it with \`git show ${merge.commit}\`.

Task instructions: ${task.promptFile}
Module report: ${task.report}
Interface requests: ${task.interfaceRequest}
Owned: ${task.ownedFolder || task.ownedScript}
Files changed:
${bullets(merge.files)}

Acceptance criteria:
${bullets(task.acceptance)}

The implementer's own account follows. It is a claim to verify against the code, not evidence:
${fence(`Summary: ${impl ? impl.summary : '(implementer returned nothing)'}\nTests: ${impl ? impl.testsRun : '-'}\nInterface requests: ${impl && impl.interfaceRequests ? impl.interfaceRequests.join('; ') : '-'}`)}

Your working directory may be on a different branch than the run branch; read files as committed with \`git show ${merge.commit}:<path>\`.

Number issues ${task.id}-1, ${task.id}-2, and so on.`
}

const isBlocking = (item) => item.blocks_integration === true || item.severity === 'critical'

phase('Prepare')
const plan = await ops(`${CLI} prepare "${manifest}"`, 'prepare', 'Prepare')
if (!plan.ok) {
  return { stage: 'modules', status: 'blocked', reason: 'prepare_failed', errors: plan.errors || [plan.error] }
}
if (!plan.waves.length) {
  log(`Every module of ${plan.runId} is already merged.`)
}

// Merges commit into one working tree, so they run strictly one at a time.
let mergeChain = Promise.resolve()
function serialMerge(task) {
  const run = mergeChain.then(() => ops(`${CLI} integrate-task --run ${plan.runId} --task ${task.id}`, `merge:${task.id}`, 'Merge'))
  mergeChain = run.catch(() => null)
  return run
}

const outcomes = []
const unmerged = new Set()
for (let index = 0; index < plan.waves.length; index += 1) {
  const waveTasks = plan.waves[index]
  const blocked = waveTasks.filter((task) => task.dependsOn.some((dependency) => unmerged.has(dependency)))
  for (const task of blocked) {
    unmerged.add(task.id)
    outcomes.push({ task: task.id, status: 'skipped', reason: `depends on ${task.dependsOn.filter((d) => unmerged.has(d)).join(', ')}, which did not merge` })
  }
  const wave = waveTasks.filter((task) => !blocked.includes(task))
  if (!wave.length) {
    continue
  }
  log(`Wave ${index + 1}/${plan.waves.length}: ${wave.map((task) => task.id).join(', ')}`)

  const results = await pipeline(
    wave,
    (task) =>
      agent(implementPrompt(plan, task), {
        agentType: 'module-pipeline:module-implementer',
        isolation: 'worktree',
        schema: IMPL_SCHEMA,
        label: `implement:${task.id}`,
        phase: 'Implement',
        ...modelOptions(task.model, task.effort),
      }),
    (impl, task) => serialMerge(task).then((merge) => ({ impl, merge })),
    (result, task) =>
      result.merge.status === 'merged'
        ? agent(reviewPrompt(plan, task, result.impl, result.merge), {
            agentType: 'module-pipeline:module-reviewer',
            schema: REVIEW_SCHEMA,
            label: `review:${task.id}`,
            phase: 'Review',
            ...modelOptions(plan.reviewModel, plan.reviewEffort),
          }).then((review) => ({ ...result, review }))
        : result,
  )

  wave.forEach((task, position) => {
    const result = results[position]
    if (!result) {
      unmerged.add(task.id)
      outcomes.push({ task: task.id, status: 'error', reason: 'A pipeline step failed; see /workflows for the agent transcript.' })
      return
    }
    const { impl, merge, review } = result
    if (merge.status !== 'merged') {
      unmerged.add(task.id)
    }
    outcomes.push({
      task: task.id,
      status: merge.status,
      commit: merge.commit || null,
      files: merge.files || [],
      violations: merge.violations || [],
      dropped: merge.dropped || [],
      error: merge.error || merge.reason || null,
      worktree: merge.worktree || null,
      summary: impl ? impl.summary : null,
      testsRun: impl ? impl.testsRun : null,
      testsPassed: impl ? impl.testsPassed : null,
      interfaceRequests: impl ? impl.interfaceRequests || [] : [],
      blockers: impl ? impl.blockers : ['The implementer returned nothing.'],
      review: review || null,
    })
  })
}

phase('Diagnostics')
const merged = outcomes.filter((outcome) => outcome.status === 'merged')
const diagnostics = merged.length || plan.skipped.length
  ? await ops(`${CLI} diagnostics --run ${plan.runId}`, 'diagnostics', 'Diagnostics')
  : { ran: false, reason: 'Nothing merged.' }

const blockingItems = outcomes.flatMap((outcome) =>
  (outcome.review ? outcome.review.rework_items : []).filter(isBlocking).map((item) => ({ task: outcome.task, ...item })),
)
const failedModules = outcomes.filter((outcome) => outcome.status !== 'merged')
const status = failedModules.length
  ? 'modules_failed'
  : blockingItems.length
    ? 'rework_required'
    : diagnostics.failed
      ? 'diagnostics_failed'
      : 'passed'

return {
  stage: 'modules',
  runId: plan.runId,
  runBranch: plan.runBranch,
  status,
  alreadyMerged: plan.skipped,
  modules: outcomes,
  blockingItems,
  diagnostics,
  next: status === 'passed' ? 'integrate' : 'rework',
}
