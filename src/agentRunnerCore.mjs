// Runs one Claude agent session through the Agent SDK and reports progress
// into a status object. Kept free of process/filesystem concerns so tests can
// drive it with a fake `query`; src/agentRunner.mjs wires it to real files.
import fileScope from './fileScope.js';

const { createScopeMatcher, toRootRelative } = fileScope;

export const RUNNER_STATUS_VERSION = 1;
const HEARTBEAT_MS = 15000;
const LOG_TEXT_LIMIT = 600;
const FILE_WRITE_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';
const LOGIN_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
]);

function clip(text, limit = LOG_TEXT_LIMIT) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function describeToolUse(block) {
  const input = block.input || {};
  const target = input.file_path || input.notebook_path || input.command || input.pattern || input.path || '';
  return `→ ${block.name}${target ? ` ${clip(target, 160)}` : ''}`;
}

/**
 * Classify a thrown error or error text into a blocked reason, or null.
 */
export function classifyFailureText(text) {
  const value = String(text || '').toLowerCase();
  if (/\/login|not logged in|log in|authenticat|oauth|api key|credential|expired/.test(value)) {
    return 'login';
  }
  if (/rate.?limit|usage limit|session limit|resets? (at|in)|too many requests|\b429\b/.test(value)) {
    return 'rate_limit';
  }
  return null;
}

/**
 * PreToolUse hook that denies file writes outside the agent's allowed scope.
 * Bash can still write files, so the post-run audit stays as the backstop.
 */
export function createScopeHook({ cwd, allowedPaths, interfaceRequest, onDeny }) {
  const allows = createScopeMatcher(allowedPaths);
  const allowedList = allowedPaths.join(', ');
  const redirect = interfaceRequest
    ? ` If you need a change there, describe it in ${interfaceRequest} instead.`
    : '';

  return async (input) => {
    const toolInput = input?.tool_input || {};
    const target = toolInput.file_path || toolInput.notebook_path || null;
    const relPath = toRootRelative(cwd, target);
    if (relPath && allows(relPath)) {
      return {};
    }
    const shown = relPath || String(target || '(no path)');
    onDeny({ tool: input?.tool_name || 'unknown', path: shown });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${shown} is outside your allowed files (${allowedList}).${redirect}`,
      },
    };
  };
}

export function buildQueryOptions(spec, hooks) {
  const options = {
    cwd: spec.cwd,
    model: spec.model || undefined,
    effort: spec.effort || undefined,
    permissionMode: spec.permissionMode || 'acceptEdits',
    // Nobody watches a background agent live: anything that would prompt is
    // denied immediately (and reported) instead of stalling the session.
    permissionPrompts: 'none',
    settingSources: ['user', 'project', 'local'],
  };
  if (spec.projectConfigRoot && spec.projectConfigRoot !== spec.cwd) {
    options.projectConfigRoot = spec.projectConfigRoot;
  }
  if (spec.resume) {
    options.resume = spec.sessionId;
  } else {
    options.sessionId = spec.sessionId;
  }
  if (hooks) {
    options.hooks = hooks;
  }
  return options;
}

function summarizeResult(result) {
  if (!result) {
    return null;
  }
  return {
    subtype: result.subtype,
    isError: Boolean(result.is_error),
    numTurns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    costUsd: result.total_cost_usd ?? null,
    usage: result.usage
      ? {
          inputTokens: result.usage.input_tokens ?? 0,
          outputTokens: result.usage.output_tokens ?? 0,
          cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: result.usage.cache_creation_input_tokens ?? 0,
        }
      : null,
    terminalReason: result.terminal_reason ?? null,
    permissionDenials: (result.permission_denials || []).map((denial) => denial.tool_name),
    errors: result.errors || [],
  };
}

/**
 * Decide the final status from what the session produced.
 */
export function finalizeStatus(status, { result, assistantError, rateLimited, thrown }) {
  status.result = summarizeResult(result);
  status.finishedAt = new Date().toISOString();

  if (!thrown && result?.subtype === 'success' && !result.is_error) {
    status.state = 'done';
    status.detail = null;
    return status;
  }

  const errorText = thrown
    ? thrown.message || String(thrown)
    : [...(result?.errors || []), result?.result, result?.subtype].filter(Boolean).join(' | ');
  let blockReason = null;
  if (assistantError && LOGIN_ERRORS.has(assistantError)) {
    blockReason = 'login';
  } else if (assistantError === 'rate_limit' || rateLimited || result?.terminal_reason === 'blocking_limit') {
    blockReason = 'rate_limit';
  } else {
    blockReason = classifyFailureText(errorText);
  }

  status.state = blockReason ? 'blocked' : 'failed';
  status.blockReason = blockReason;
  status.detail = errorText || assistantError || 'Claude session ended without a result.';
  return status;
}

/**
 * @param {object} params
 * @param {object} params.spec runner spec (see agentProcess.launchAgentProcess)
 * @param {Function} params.query the Agent SDK `query` function
 * @param {(status: object) => Promise<void>} params.writeStatus
 * @param {(line: string) => Promise<void>} params.appendLog
 */
export async function runAgent({ spec, query, writeStatus, appendLog, pid = process.pid, heartbeatMs = HEARTBEAT_MS }) {
  const nowIso = () => new Date().toISOString();
  const status = {
    version: RUNNER_STATUS_VERSION,
    pid,
    sessionId: spec.sessionId,
    state: 'running',
    blockReason: null,
    detail: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    claudeCodeVersion: null,
    scopeDenials: [],
    result: null,
  };
  const save = async () => {
    status.updatedAt = nowIso();
    await writeStatus(status);
  };
  await save();
  const heartbeat = setInterval(() => {
    save().catch(() => {});
  }, heartbeatMs);

  let hooks = null;
  if (Array.isArray(spec.allowedPaths)) {
    const scopeHook = createScopeHook({
      cwd: spec.cwd,
      allowedPaths: spec.allowedPaths,
      interfaceRequest: spec.interfaceRequest,
      onDeny: (denial) => {
        status.scopeDenials.push({ ...denial, at: nowIso() });
        appendLog(`✗ blocked ${denial.tool} outside scope: ${denial.path}`).catch(() => {});
        save().catch(() => {});
      },
    });
    hooks = { PreToolUse: [{ matcher: FILE_WRITE_TOOLS, hooks: [scopeHook] }] };
  }

  const outcome = { result: null, assistantError: null, rateLimited: false, thrown: null };
  await appendLog(`${spec.resume ? 'resume' : 'start'} session ${spec.sessionId} in ${spec.cwd}`);
  try {
    for await (const message of query({ prompt: spec.prompt, options: buildQueryOptions(spec, hooks) })) {
      await handleMessage(message, { status, outcome, appendLog });
    }
  } catch (error) {
    outcome.thrown = error;
    await appendLog(`error: ${clip(error?.message || error)}`);
  } finally {
    clearInterval(heartbeat);
  }

  finalizeStatus(status, outcome);
  await appendLog(`${status.state}${status.detail ? `: ${clip(status.detail)}` : ''}`);
  await save();
  return status;
}

async function handleMessage(message, { status, outcome, appendLog }) {
  if (message.type === 'system' && message.subtype === 'init') {
    status.claudeCodeVersion = message.claude_code_version || null;
    await appendLog(`init model=${message.model} permissionMode=${message.permissionMode}`);
  } else if (message.type === 'system' && message.subtype === 'permission_denied') {
    await appendLog(`✗ permission denied: ${message.tool_name}`);
  } else if (message.type === 'assistant') {
    if (message.error) {
      outcome.assistantError = message.error;
    }
    for (const block of message.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) {
        await appendLog(clip(block.text));
      } else if (block.type === 'tool_use') {
        await appendLog(describeToolUse(block));
      }
    }
  } else if (message.type === 'rate_limit_event') {
    if (message.rate_limit_info?.status === 'rejected') {
      outcome.rateLimited = true;
    }
  } else if (message.type === 'result') {
    outcome.result = message;
  }
}
