// Runs a workflow script outside Claude Code: the runtime globals are
// emulated, and the LLM agents are replaced by stand-ins. Writers act on real
// worktrees; reviewers really run the pipeline commands their prompt names
// (merge, diagnostics) and let the scenario supply the verdict.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, cli, git, makeAgentWorktree } from './helpers.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadWorkflow(name) {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'workflows', `${name}.js`), 'utf8');
  if (!source.startsWith('export const meta = {')) {
    throw new Error(`${name}.js must start with export const meta`);
  }
  return source.replace(/^export const meta =/, 'const meta =');
}

/** Emulates the runtime's pipeline(): items in parallel, stages in order, a throwing stage yields null. */
async function pipeline(items, ...stages) {
  return Promise.all(
    items.map(async (item, index) => {
      let value = item;
      for (const [position, stage] of stages.entries()) {
        try {
          value = await stage(position === 0 ? item : value, item, index);
        } catch {
          return null;
        }
      }
      return value;
    }),
  );
}

async function parallel(thunks) {
  return Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
}

/** Runs the first `node "…pipeline.mjs" <command> …` line of a prompt, the way an agent would. */
function runPromptCommand(prompt, command, cwd) {
  const match = prompt.match(new RegExp(`(node "[^"]+" ${command} [^\\n]+)`));
  if (!match) {
    return null;
  }
  const result = spawnSync(match[1], { cwd, shell: true, encoding: 'utf8' });
  return JSON.parse(result.stdout);
}

/**
 * Stand-in for a writer agent started with isolation: 'worktree': makes a
 * worktree from the project's current HEAD, runs the claim command from the
 * prompt inside it, then lets the scenario write files.
 */
function actInWorktree(root, prompt, act) {
  const taskId = prompt.match(/claim --run \S+ --task (\S+)/)[1];
  const worktree = makeAgentWorktree(root, taskId);
  const claimed = runPromptCommand(prompt, 'claim', worktree);
  if (!claimed.ok) {
    throw new Error(`claim failed: ${JSON.stringify(claimed)}`);
  }
  return act({ worktree, taskId, claimed, write: (rel, text) => {
    const file = path.join(worktree, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } });
}

const mergeFields = (json) => ({
  status: json.status,
  commit: json.commit,
  files: json.files,
  violations: json.violations,
  dropped: json.dropped,
  error: json.error || json.reason,
  worktree: json.worktree,
});

/** The args the session passes: the workflowArgs printed by prepare. */
export function prepareArgs(root, manifest, ...extra) {
  const { json } = cli(root, 'prepare', manifest, ...extra);
  if (!json.ok) {
    throw new Error(`prepare failed: ${JSON.stringify(json.errors)}`);
  }
  return json.workflowArgs;
}

/**
 * @param {string} name workflow file name without .js
 * @param {{root: string, args: object, scenario: object}} options
 *   scenario.implement(ctx) / scenario.integrate(ctx): write files, return the agent's result
 *   scenario.review(taskId, prompt, merge) / scenario.systemReview(prompt, diagnostics): return the verdict
 */
export async function runWorkflow(name, { root, args, scenario }) {
  const calls = [];
  const logs = [];
  async function agent(prompt, options = {}) {
    calls.push({ label: options.label, agentType: options.agentType, isolation: options.isolation, model: options.model, effort: options.effort });
    switch (options.agentType) {
      case 'module-pipeline:module-implementer':
        return actInWorktree(root, prompt, (ctx) => scenario.implement({ ...ctx, prompt, root }));
      case 'module-pipeline:integrator':
        return actInWorktree(root, prompt, (ctx) => scenario.integrate({ ...ctx, prompt, root }));
      case 'module-pipeline:patcher':
        return actInWorktree(root, prompt, (ctx) => scenario.patch({ ...ctx, prompt, root }));
      case 'module-pipeline:module-reviewer': {
        const merged = runPromptCommand(prompt, 'integrate-task', root);
        const merge = { ...mergeFields(merged), changedLines: merged.changedLines };
        if (!merged.ok) {
          return { merge, verdict: 'not_merged', summary: 'not merged', rework_items: [] };
        }
        const diagnostics = runPromptCommand(prompt, 'diagnostics', root);
        const taskId = merged.taskId;
        return {
          merge,
          ...(diagnostics ? { diagnostics: { failed: Boolean(diagnostics.failed), summary: diagnostics.ran ? 'ran' : 'nothing configured' } } : {}),
          ...scenario.review(taskId, prompt, merged),
        };
      }
      case 'module-pipeline:system-reviewer': {
        const merged = runPromptCommand(prompt, 'integrate-task', root);
        if (merged && merged.status !== 'merged' && merged.status !== 'empty') {
          return { merge: mergeFields(merged), verdict: 'not_merged', summary: 'not merged', spec_coverage: [], rework_items: [] };
        }
        const diagnostics = runPromptCommand(prompt, 'diagnostics', root);
        return {
          ...(merged ? { merge: mergeFields(merged) } : {}),
          diagnostics: { failed: Boolean(diagnostics.failed), summary: diagnostics.ran ? 'ran' : 'nothing configured' },
          ...scenario.systemReview(prompt, diagnostics),
        };
      }
      default:
        throw new Error(`Unexpected agent type ${options.agentType}`);
    }
  }
  const body = loadWorkflow(name);
  const run = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', body);
  const result = await run(agent, pipeline, parallel, () => {}, (message) => logs.push(message), args);
  return { result, calls, logs, head: git(root, 'rev-parse', 'HEAD') };
}
