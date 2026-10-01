#!/usr/bin/env node
// Scope hooks for pipeline writers (the module-implementer, integrator and
// patcher agents); every other session and agent passes through untouched.
//
// PreToolUse (Edit/Write/MultiEdit/NotebookEdit): a pipeline writer must work
// inside its own claimed worktree and may only write the files its task
// allows. Errors deny the write (fail closed).
//
// PreToolUse (Bash): a command whose text shows a write into the main project
// checkout is refused (lib/shell.mjs). Reading there is never refused. This
// catches the usual slip; it is not a sandbox.
//
// PostToolUse (Bash): what a shell command writes cannot be known before it
// runs, so after each one the worktree is compared with the task's scope and
// the agent is told at once about files outside it, while it can still undo
// them. Errors here are ignored; the audit before merging is the final check.
//
// What these guarantee: only in-scope changes are merged into the run branch.
// They do not confine the shell. A command can still write outside the
// worktree in a way its text does not show (a path built at run time, a
// program that writes by itself). Only an OS sandbox confines a shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedFiles } from './lib/git.mjs';
import { samePath } from './lib/paths.mjs';
import { auditChanges, createScopeMatcher, toRootRelative } from './lib/scope.mjs';
import { findProtectedWrite } from './lib/shell.mjs';
import { findGitRoot, projectRootForWorktree, readClaim } from './lib/state.mjs';

const WRITER_AGENT = /(^|:)(module-implementer|integrator|patcher)$/;
const MAX_LISTED = 15;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isWriter = (input) => WRITER_AGENT.test(String(input?.agent_type || ''));

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * PreToolUse (Bash) for a pipeline writer: refuse a command whose text shows
 * a write into the main project checkout or another agent's worktree (a
 * redirection, a file-changing command or a mutating git command aimed
 * there). Reading there is never refused. Errors let the command through; the
 * write hook and the merge audit still apply.
 */
function decideShell(input) {
  try {
    const cwd = input.cwd || process.cwd();
    const gitInfo = findGitRoot(cwd);
    if (!gitInfo?.isLinkedWorktree) {
      return null;
    }
    const projectRoot = projectRootForWorktree(gitInfo);
    const hit = findProtectedWrite(String(input.tool_input?.command || ''), {
      cwd,
      protectedRoot: projectRoot,
      // Its own worktree, the plugin and the temp folder may sit under the project root.
      allowed: [gitInfo.root, PLUGIN_ROOT, os.tmpdir()],
    });
    if (!hit) {
      return null;
    }
    return deny(
      `\`${hit.command}\` would change ${hit.path}, which is in the main project checkout (${projectRoot}), not in your worktree ` +
        `(${gitInfo.root}). Change files only inside your worktree, with relative paths. Reading the main checkout is fine.`,
    );
  } catch {
    return null;
  }
}

/**
 * @param {object} input PreToolUse hook input
 * @returns {object|null} hook output, or null to let the call proceed
 */
export function decide(input) {
  if (!isWriter(input)) {
    return null;
  }
  if (input.tool_name === 'Bash') {
    return decideShell(input);
  }
  try {
    const gitInfo = findGitRoot(input.cwd || process.cwd());
    if (!gitInfo?.isLinkedWorktree) {
      return deny('Pipeline agents must work inside their isolated git worktree, not the main project checkout.');
    }
    const projectRoot = projectRootForWorktree(gitInfo);
    const claim = readClaim(projectRoot, gitInfo.root);
    if (!claim) {
      return deny('This worktree is not claimed yet. Run the claim command from your instructions before editing any file.');
    }
    const target = input.tool_input?.file_path || input.tool_input?.notebook_path || null;
    const relPath = toRootRelative(claim.worktree, target);
    if (relPath && createScopeMatcher(claim.allowedFiles)(relPath)) {
      return null;
    }
    const shown = relPath || String(target || '(no path)');
    return deny(
      `${shown} is outside what task ${claim.taskId} may write (${claim.allowedFiles.join(', ')}). ` +
        `If another module or file needs a change, describe it in ${claim.interfaceRequest} instead.`,
    );
  } catch (error) {
    return deny(`Scope check failed, so the write was blocked: ${error.message}`);
  }
}

/**
 * @param {object} input PostToolUse hook input
 * @returns {object|null} hook output telling the agent about out-of-scope files, or null
 */
export function watch(input) {
  if (!isWriter(input) || input.tool_name !== 'Bash') {
    return null;
  }
  try {
    const gitInfo = findGitRoot(input.cwd || process.cwd());
    if (!gitInfo?.isLinkedWorktree) {
      return null;
    }
    const claim = readClaim(projectRootForWorktree(gitInfo), gitInfo.root);
    if (!claim) {
      return null;
    }
    const changed = changedFiles(claim.worktree, claim.base);
    const { violations } = auditChanges(changed, claim.allowedFiles, claim.generatedFiles || []);
    if (!violations.length) {
      return null;
    }
    const listed = violations.slice(0, MAX_LISTED).map((file) => `  ${file}`).join('\n');
    const more = violations.length > MAX_LISTED ? `\n  … and ${violations.length - MAX_LISTED} more` : '';
    return {
      decision: 'block',
      reason:
        `Your worktree now has changes outside what task ${claim.taskId} may write:\n${listed}${more}\n` +
        'If they stay, the whole module is rejected at merge. Undo them now: restore files that existed before with ' +
        `\`git checkout ${claim.base.slice(0, 12)} -- <path>\`, and delete new files (\`git rm -f <path>\` if you committed them). ` +
        `If the project really needs that change, describe it in ${claim.interfaceRequest} instead.`,
    };
  } catch {
    return null;
  }
}

export function handle(input) {
  return input?.hook_event_name === 'PostToolUse' ? watch(input) : decide(input);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  let input = null;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = null;
  }
  const output = input ? handle(input) : null;
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
}
