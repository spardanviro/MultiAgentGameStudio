// Runs a workflow script outside Claude Code: the runtime globals are
// emulated, the pipeline-ops agent really executes its command, and the
// LLM agents are replaced by scenario callbacks that act on real worktrees.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, git, makeAgentWorktree } from './helpers.mjs';

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

function runOpsCommand(command, cwd) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
  return { exitCode: result.status ?? -1, stdout: result.stdout || result.stderr || '' };
}

/**
 * Stand-in for a writer agent started with isolation: 'worktree': makes a
 * worktree from the project's current HEAD, runs the claim command from the
 * prompt inside it, then lets the scenario write files.
 */
function actInWorktree(root, prompt, act) {
  const claim = prompt.match(/(node "[^"]+" claim --run \S+ --task \S+)/);
  const taskId = prompt.match(/--task (\S+)/)[1];
  const worktree = makeAgentWorktree(root, taskId);
  const claimed = runOpsCommand(claim[1], worktree);
  if (claimed.exitCode !== 0) {
    throw new Error(`claim failed: ${claimed.stdout}`);
  }
  return act({ worktree, taskId, write: (rel, text) => {
    const file = path.join(worktree, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } });
}

/**
 * @param {string} name workflow file name without .js
 * @param {{root: string, args: object, scenario: object}} options
 *   scenario.implement(ctx) / scenario.integrate(ctx): write files, return the agent's result
 *   scenario.review(taskId, prompt) / scenario.systemReview(prompt): return the reviewer's result
 */
export async function runWorkflow(name, { root, args, scenario }) {
  const calls = [];
  const logs = [];
  async function agent(prompt, options = {}) {
    calls.push({ label: options.label, agentType: options.agentType, isolation: options.isolation, model: options.model, effort: options.effort });
    switch (options.agentType) {
      case 'module-pipeline:pipeline-ops':
        return runOpsCommand(prompt.split('\n\n').slice(1).join('\n\n').trim(), root);
      case 'module-pipeline:module-implementer':
        return actInWorktree(root, prompt, (ctx) => scenario.implement({ ...ctx, prompt, root }));
      case 'module-pipeline:integrator':
        return actInWorktree(root, prompt, (ctx) => scenario.integrate({ ...ctx, prompt, root }));
      case 'module-pipeline:module-reviewer':
        return scenario.review(prompt.match(/Review module "([^"]+)"/)[1], prompt);
      case 'module-pipeline:system-reviewer':
        return scenario.systemReview(prompt);
      default:
        throw new Error(`Unexpected agent type ${options.agentType}`);
    }
  }
  const body = loadWorkflow(name);
  const run = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', body);
  const result = await run(agent, pipeline, parallel, () => {}, (message) => logs.push(message), args);
  return { result, calls, logs, head: git(root, 'rev-parse', 'HEAD') };
}
