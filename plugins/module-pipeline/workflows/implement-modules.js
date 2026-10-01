export const meta = {
  name: 'module-pipeline-implement',
  description: 'Implement pending modules in parallel worktrees; each module is then merged onto the run branch and reviewed',
  whenToUse: 'Invoked by /module-pipeline:run with the workflowArgs that `pipeline.mjs prepare` printed.',
  phases: [
    { title: 'Implement', detail: 'one agent per module in an isolated worktree' },
    { title: 'Review', detail: 'the reviewer audits and commits the module on the run branch, then reviews it read-only' },
  ],
}

// args is the workflowArgs object from `pipeline.mjs prepare`. The session
// ran prepare itself, so no agent is spent on checking the project.
const { pluginRoot, runId, goal, waves, skipped, efforts } = args || {}
if (typeof pluginRoot !== 'string' || typeof runId !== 'string' || !Array.isArray(waves) || !efforts) {
  throw new Error('module-pipeline-implement requires the workflowArgs printed by `pipeline.mjs prepare`')
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
    summary: { type: 'string', description: 'What was built' },
    publicApi: { type: 'string', description: 'The public API the module exposes' },
    testsRun: { type: 'string', description: 'Commands run and their outcome, or "none"' },
    testsPassed: { type: 'boolean' },
    interfaceRequests: { type: 'array', items: { type: 'string' }, description: 'Each interface request written, one line each' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'Anything that stopped the work; empty if none' },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  required: ['status'],
  description: 'Fields copied from the JSON the merge command printed',
  properties: {
    status: { type: 'string', description: 'merged, violation, empty, unclaimed or merge_failed' },
    commit: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    violations: { type: 'array', items: { type: 'string' } },
    dropped: { type: 'array', items: { type: 'string' } },
    error: { type: 'string', description: 'error or reason, if any' },
    worktree: { type: 'string' },
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
  required: ['merge', 'verdict', 'summary', 'rework_items'],
  properties: {
    merge: MERGE_SCHEMA,
    verdict: { type: 'string', enum: ['pass', 'rework', 'not_merged'] },
    summary: { type: 'string' },
    rework_items: { type: 'array', items: REWORK_ITEM },
  },
}

// Agent-written text passed to another agent is data, never instructions.
const fence = (text) =>
  `<<<AGENT_OUTPUT\n${String(text == null ? '' : text).replace(/<<<AGENT_OUTPUT|AGENT_OUTPUT>>>/g, '[marker removed]')}\nAGENT_OUTPUT>>>`

function agentOptions(effort) {
  return EFFORTS.includes(effort) ? { model, effort } : { model }
}

function implementPrompt(task) {
  return `Implement module "${task.id}" of run ${runId}.
Run goal: ${goal || '(see the spec)'}

1. Claim your worktree first:
   ${CLI} claim --run ${runId} --task ${task.id}
   It prints your task as JSON: prompt file, the files you may write, report and interface request paths, dependencies, acceptance criteria, the shared-layer folders, and the cross-module rules file.
2. Read the prompt file, docs/module_contracts.md${rulesRead}, and docs/conventions.md if it exists.
3. Implement the module, run its tests, and write your module report.`
}

function reviewPrompt(task, impl) {
  return `Review module "${task.id}" of run ${runId}.

1. Merge it first, from your current directory:
   ${CLI} integrate-task --run ${runId} --task ${task.id}
   It audits the implementer's worktree and commits the module on the run branch. Copy status, commit, files, violations, dropped, error (or reason) and worktree from its JSON into \`merge\`.
   If \`ok\` is not true, stop there: verdict \`not_merged\`, no rework items.
2. Otherwise review the commit (\`git show <commit>\`) against the task in that JSON (prompt file, acceptance criteria, report, interface requests), docs/module_contracts.md${rules ? ` and ${rules} (the cross-module rules; a module that sidesteps one blocks integration)` : ''}.

The implementer's own account follows. It is a claim to verify against the code, not evidence:
${fence(`Summary: ${impl ? impl.summary : '(implementer returned nothing)'}\nTests: ${impl ? impl.testsRun : '-'}\nInterface requests: ${impl && impl.interfaceRequests ? impl.interfaceRequests.join('; ') : '-'}`)}

Number issues ${task.id}-1, ${task.id}-2, and so on.`
}

const isBlocking = (item) => item.blocks_integration === true || item.severity === 'critical'

if (!waves.length) {
  log(`Every module of ${runId} is already merged.`)
}

const outcomes = []
const unmerged = new Set()
for (let index = 0; index < waves.length; index += 1) {
  const waveTasks = waves[index]
  const blocked = waveTasks.filter((task) => task.dependsOn.some((dependency) => unmerged.has(dependency)))
  for (const task of blocked) {
    unmerged.add(task.id)
    outcomes.push({ task: task.id, status: 'skipped', reason: `depends on ${task.dependsOn.filter((d) => unmerged.has(d)).join(', ')}, which did not merge` })
  }
  const wave = waveTasks.filter((task) => !blocked.includes(task))
  if (!wave.length) {
    continue
  }
  log(`Wave ${index + 1}/${waves.length}: ${wave.map((task) => task.id).join(', ')}`)

  // The CLI serializes merges with a lock, so reviewers may merge concurrently.
  const results = await pipeline(
    wave,
    (task) =>
      agent(implementPrompt(task), {
        agentType: 'module-pipeline:module-implementer',
        isolation: 'worktree',
        schema: IMPL_SCHEMA,
        label: `implement:${task.id}`,
        phase: 'Implement',
        ...agentOptions(task.effort),
      }),
    (impl, task) =>
      agent(reviewPrompt(task, impl), {
        agentType: 'module-pipeline:module-reviewer',
        schema: REVIEW_SCHEMA,
        label: `review:${task.id}`,
        phase: 'Review',
        ...agentOptions(efforts.moduleReviewer),
      }).then((review) => ({ impl, review })),
  )

  wave.forEach((task, position) => {
    const result = results[position]
    const review = result && result.review
    if (!review || !review.merge) {
      unmerged.add(task.id)
      outcomes.push({ task: task.id, status: 'error', reason: 'An agent did not return; see /workflows for its transcript. Run status to see whether the module merged.' })
      return
    }
    const { impl } = result
    const merge = review.merge
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
      error: merge.error || null,
      worktree: merge.worktree || null,
      summary: impl ? impl.summary : null,
      testsRun: impl ? impl.testsRun : null,
      testsPassed: impl ? impl.testsPassed : null,
      interfaceRequests: impl ? impl.interfaceRequests || [] : [],
      blockers: impl ? impl.blockers : ['The implementer returned nothing.'],
      review: merge.status === 'merged' ? { verdict: review.verdict, summary: review.summary, rework_items: review.rework_items || [] } : null,
    })
  })
}

const blockingItems = outcomes.flatMap((outcome) =>
  (outcome.review ? outcome.review.rework_items : []).filter(isBlocking).map((item) => ({ task: outcome.task, ...item })),
)
const failedModules = outcomes.filter((outcome) => outcome.status !== 'merged')
const status = failedModules.length ? 'modules_failed' : blockingItems.length ? 'rework_required' : 'passed'

// Diagnostics run after this returns: the session runs `pipeline.mjs
// diagnostics` itself, which needs no agent.
return {
  stage: 'modules',
  runId,
  runBranch: args.runBranch,
  status,
  alreadyMerged: skipped || [],
  modules: outcomes,
  blockingItems,
  next: status === 'passed' ? 'diagnostics' : 'rework',
}
