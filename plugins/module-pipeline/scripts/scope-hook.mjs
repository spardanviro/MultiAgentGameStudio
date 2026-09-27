#!/usr/bin/env node
// PreToolUse hook for Edit/Write/MultiEdit/NotebookEdit.
//
// Only pipeline writers (the module-implementer and integrator agents) are
// checked; every other session and agent passes through untouched. A
// pipeline writer must work inside its own claimed worktree, and may only
// write the files its task allows. Errors deny the write for pipeline
// writers (fail closed) and allow it for everyone else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScopeMatcher, toRootRelative } from './lib/scope.mjs';
import { findGitRoot, projectRootForWorktree, readClaim } from './lib/state.mjs';

const WRITER_AGENT = /(^|:)(module-implementer|integrator)$/;

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
 * @param {object} input PreToolUse hook input
 * @returns {object|null} hook output, or null to let the call proceed
 */
export function decide(input) {
  if (!WRITER_AGENT.test(String(input?.agent_type || ''))) {
    return null;
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

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
  let input = null;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = null;
  }
  const output = input ? decide(input) : null;
  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
}
