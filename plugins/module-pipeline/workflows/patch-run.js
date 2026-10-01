export const meta = {
  name: 'module-pipeline-patch',
  description: 'Apply a small rework patch in one isolated worktree; one reviewer merges it, runs diagnostics and checks every item',
  whenToUse: 'Invoked by /module-pipeline:run for a patch manifest, with the workflowArgs that `pipeline.mjs prepare` printed.',
  phases: [
    { title: 'Patch', detail: 'one agent applies every rework item in an isolated worktree' },
    { title: 'Review', detail: 'merge the patch, run diagnostics, check each item' },
  ],
}

// args is the workflowArgs object from `pipeline.mjs prepare` for a patch manifest.
const { pluginRoot, runId, runBranch, goal, patch, efforts } = args || {}
if (typeof pluginRoot !== 'string' || typeof runId !== 'string' || args.mode !== 'patch' || !efforts) {
  throw new Error('module-pipeline-patch requires the workflowArgs printed by `pipeline.mjs prepare` for a patch manifest')
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

const PATCH_SCHEMA = {
  type: 'object',
  required: ['summary', 'testsRun', 'blockers'],
  properties: {
    summary: { type: 'string', description: 'What was changed for each item' },
    testsRun: { type: 'string', description: 'Commands run and their outcome, or "none"' },
    testsPassed: { type: 'boolean' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'Items that could not be fixed as a patch, and why; empty if none' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['merge', 'verdict', 'summary', 'rework_items'],
  properties: {
    merge: {
      type: 'object',
      required: ['status'],
      description: 'Fields copied from the JSON the merge command printed',
      properties: {
        status: { type: 'string', description: 'merged, too_large, violation, empty, unclaimed or merge_failed' },
        commit: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        violations: { type: 'array', items: { type: 'string' } },
        changedLines: { type: 'integer' },
        error: { type: 'string', description: 'error or reason, if any' },
        worktree: { type: 'string' },
      },
    },
    diagnostics: {
      type: 'object',
      required: ['failed', 'summary'],
      description: 'From the JSON the diagnostics command printed',
      properties: {
        failed: { type: 'boolean', description: 'The `failed` field' },
        summary: { type: 'string', description: 'Compile errors/warnings count and the test result, one or two lines' },
      },
    },
    verdict: { type: 'string', enum: ['pass', 'rework', 'not_merged'] },
    summary: { type: 'string' },
    rework_items: {
      type: 'array',
      items: {
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
          blocks_integration: { type: 'boolean', description: 'true when an item is unresolved or something regressed' },
        },
      },
    },
  },
}

const fence = (text) =>
  `<<<AGENT_OUTPUT\n${String(text == null ? '' : text).replace(/<<<AGENT_OUTPUT|AGENT_OUTPUT>>>/g, '[marker removed]')}\nAGENT_OUTPUT>>>`

function agentOptions(effort) {
  return EFFORTS.includes(effort) ? { model, effort } : { model }
}

if (!patch) {
  log(`The patch of ${runId} is already merged.`)
  return { stage: 'patch', runId, runBranch, status: 'passed', alreadyMerged: true, next: 'finish' }
}

phase('Patch')
const impl = await agent(
  `Apply the rework patch of run ${runId}.
Run goal: ${goal || '(see the rework decisions)'}

1. Claim your worktree first:
   ${CLI} claim --run ${runId} --task patch
   It prints your task as JSON: the prompt file with every rework item, the files you may change, report and interface request paths, one acceptance criterion per item, and the line limit (${patch.maxChangedLines} changed lines).
2. Read the prompt file, docs/module_contracts.md${rulesRead}, and docs/conventions.md if it exists.
3. Fix every item, update the affected tests, run the whole test suite, and write your patch report.`,
  {
    agentType: 'module-pipeline:patcher',
    isolation: 'worktree',
    schema: PATCH_SCHEMA,
    label: 'patch',
    phase: 'Patch',
    ...agentOptions(patch.effort),
  },
)

phase('Review')
const review = await agent(
  `Review the rework patch of run ${runId}.

1. Merge it first, from your current directory:
   ${CLI} integrate-task --run ${runId} --task patch
   It audits the patch (scope and its ${patch.maxChangedLines}-line limit) and commits it on the run branch. Copy status, commit, files, violations, changedLines, error (or reason) and worktree from its JSON into \`merge\`.
   If \`ok\` is not true, stop there: verdict \`not_merged\`, no rework items.
2. Run the project's compile and test commands on the run branch:
   ${CLI} diagnostics --run ${runId}
   Put its \`failed\` field and a one or two line summary into \`diagnostics\`.
3. Review the commit (\`git show <commit>\`) against the task in the merge output: every acceptance criterion is one rework item that must now be resolved. Report each item that is not, and anything the patch broke${rules ? ` or any rule in ${rules} it sidesteps` : ''}, as a rework item.

The patcher's own account follows. It is a claim to verify against the code, not evidence:
${fence(`Summary: ${impl ? impl.summary : '(patcher returned nothing)'}\nTests: ${impl ? impl.testsRun : '-'}\nBlockers: ${impl && impl.blockers && impl.blockers.length ? impl.blockers.join('; ') : 'none'}`)}

Number issues PATCH-1, PATCH-2, and so on.`,
  {
    agentType: 'module-pipeline:module-reviewer',
    schema: REVIEW_SCHEMA,
    label: 'review:patch',
    phase: 'Review',
    ...agentOptions(efforts.moduleReviewer),
  },
)

const merge = review && review.merge ? review.merge : null
const diagnostics = (review && review.diagnostics) || null
const blockingItems = (review && merge && merge.status === 'merged' ? review.rework_items || [] : [])
  .filter((item) => item.blocks_integration === true || item.severity === 'critical')
  .map((item) => ({ task: 'patch', ...item }))
const status = !merge
  ? 'review_missing'
  : merge.status === 'too_large'
    ? 'patch_too_large'
    : merge.status !== 'merged'
      ? 'patch_failed'
      : blockingItems.length
        ? 'rework_required'
        : !diagnostics || diagnostics.failed
          ? 'diagnostics_failed'
          : 'passed'

return {
  stage: 'patch',
  runId,
  runBranch,
  status,
  merge,
  patcher: impl,
  diagnostics,
  review: review ? { verdict: review.verdict, summary: review.summary, rework_items: review.rework_items || [] } : null,
  blockingItems,
  next: status === 'passed' ? 'finish' : 'rework',
}
