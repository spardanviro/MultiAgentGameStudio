// Finds, in the text of a shell command, a write into a folder the agent must
// not change. Only what the text shows is judged: a redirection, a
// file-changing command, or a mutating git command whose target resolves into
// that folder. Reading there, and anything the text does not spell out (a
// path built at run time, a program that writes by itself), is left alone:
// this is a guard against the usual slip, not a sandbox.
import os from 'node:os';
import path from 'node:path';
import { pathKey } from './paths.mjs';

/**
 * Splits a command line into simple commands, the way a POSIX shell reads it.
 * @param {string} text
 * @returns {Array<{words: string[], writes: string[]}|{group: 'open'|'close'}>} simple commands with their words
 *   (quotes removed) and output redirection targets, and a marker where a subshell opens or closes
 */
export function lexShell(text) {
  const commands = [];
  let words = [];
  let writes = [];
  let word = null;
  let quote = null;
  let redirect = null; // what the next word is: 'write' target, 'heredoc' delimiter, or 'skip'
  let heredocs = [];

  const endWord = () => {
    if (word === null) {
      return;
    }
    if (redirect === 'write') {
      writes.push(word);
    } else if (redirect === 'heredoc') {
      heredocs.push(word);
    } else if (redirect !== 'skip') {
      words.push(word);
    }
    redirect = null;
    word = null;
  };
  const endCommand = () => {
    endWord();
    redirect = null;
    if (words.length || writes.length) {
      commands.push({ words, writes });
    }
    words = [];
    writes = [];
  };
  // A file descriptor before a redirection ("2>") is not an argument.
  const dropDescriptor = () => {
    if (word !== null && /^\d+$/.test(word)) {
      word = null;
    } else {
      endWord();
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        word += char;
      }
    } else if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && /["\\$`]/.test(next || '')) {
        word += next;
        index += 1;
      } else {
        word += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= '';
    } else if (char === '\\') {
      if (next !== '\n') {
        word = (word ?? '') + (next ?? '');
      }
      index += 1;
    } else if (char === '\n') {
      endCommand();
      // The body of a here-document is data, not commands.
      for (const delimiter of heredocs) {
        for (;;) {
          const lineEnd = text.indexOf('\n', index + 1);
          const line = text.slice(index + 1, lineEnd < 0 ? text.length : lineEnd);
          index = lineEnd < 0 ? text.length : lineEnd;
          if (line.trim() === delimiter || lineEnd < 0) {
            break;
          }
        }
      }
      heredocs = [];
    } else if (/\s/.test(char)) {
      endWord();
    } else if (char === ';') {
      endCommand();
    } else if (char === '(' || char === ')') {
      endCommand();
      commands.push({ group: char === '(' ? 'open' : 'close' });
    } else if (char === '&' && next === '>') {
      endWord();
      index += text[index + 2] === '>' ? 2 : 1;
      redirect = 'write';
    } else if (char === '&' || char === '|') {
      endCommand();
      if (next === char || (char === '|' && next === '&')) {
        index += 1;
      }
    } else if (char === '>') {
      dropDescriptor();
      if (next === '>' || next === '|') {
        index += 1;
      }
      if (text[index + 1] === '&') {
        index += 1;
        redirect = 'skip'; // ">&2" duplicates a descriptor
      } else {
        redirect = 'write';
      }
    } else if (char === '<') {
      dropDescriptor();
      if (next === '<' && text[index + 2] === '<') {
        index += 2;
        redirect = 'skip'; // here-string
      } else if (next === '<') {
        index += text[index + 2] === '-' ? 2 : 1;
        redirect = 'heredoc';
      } else {
        redirect = 'skip'; // input file
      }
    } else if (char === '#' && word === null) {
      const lineEnd = text.indexOf('\n', index);
      index = (lineEnd < 0 ? text.length : lineEnd) - 1;
    } else {
      word = (word ?? '') + char;
    }
  }
  endCommand();
  return commands;
}

// Words before the command itself: keywords, wrappers and VAR=value.
const PREFIX = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'sudo', 'env', 'command', 'exec', 'nohup', 'builtin']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Commands that change every path they name.
const CHANGES_ALL = new Set(['rm', 'rmdir', 'mkdir', 'touch', 'mv', 'chmod', 'chown', 'truncate', 'tee', 'unlink', 'shred']);
// Commands that change only their last path (or the one after -t).
const CHANGES_LAST = new Set(['cp', 'ln', 'install', 'rsync', 'scp']);
const GIT_MUTATING = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash',
  'switch', 'worktree', 'update-ref', 'update-index', 'gc', 'init', 'submodule',
]);
// git's own options that take a value, so the value is not the subcommand.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

const isOption = (word) => word.startsWith('-') && word !== '-';

/** The path a shell word names, or null when the text does not say (a variable, a command substitution, a glob-only word). */
function wordPath(word, cwd) {
  if (!word || /[$`]/.test(word)) {
    return null;
  }
  let text = word;
  if (text === '~' || text.startsWith('~/')) {
    text = path.join(os.homedir(), text.slice(1));
  } else if (process.platform === 'win32') {
    // Git Bash spells C:\x as /c/x.
    const drive = text.match(/^\/([A-Za-z])(\/.*)?$/);
    if (drive) {
      text = `${drive[1]}:${drive[2] || '/'}`;
    }
  }
  if (path.isAbsolute(text)) {
    return path.resolve(text);
  }
  return cwd ? path.resolve(cwd, text) : null;
}

function isInside(target, folder) {
  const a = pathKey(target);
  const b = pathKey(folder);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
}

function gitTarget(args, cwd) {
  let dir = cwd;
  let index = 0;
  for (; index < args.length && isOption(args[index]); index += 1) {
    const [name, inline] = args[index].split(/=(.*)/s);
    const takesValue = GIT_VALUE_OPTIONS.has(name) && inline === undefined;
    const value = takesValue ? args[index + 1] : inline;
    if (name === '-C' || name === '--work-tree' || name === '--git-dir') {
      dir = wordPath(value, dir);
    }
    if (takesValue) {
      index += 1;
    }
  }
  return { subcommand: args[index] || '', dir };
}

/** The paths one simple command would change, as far as its text shows. */
function changedPaths({ words, writes }, cwd) {
  const start = words.findIndex((word) => !PREFIX.has(word) && !ASSIGNMENT.test(word));
  const targets = writes.map((word) => wordPath(word, cwd));
  if (start < 0) {
    return targets;
  }
  const name = path.basename(words[start]).toLowerCase().replace(/\.exe$/, '');
  const args = words.slice(start + 1);
  const operands = args.filter((word) => !isOption(word));
  if (name === 'git') {
    const { subcommand, dir } = gitTarget(args, cwd);
    if (GIT_MUTATING.has(subcommand)) {
      targets.push(dir);
    }
  } else if (CHANGES_ALL.has(name)) {
    targets.push(...operands.map((word) => wordPath(word, cwd)));
  } else if (CHANGES_LAST.has(name)) {
    const into = args.findIndex((word) => word === '-t' || word === '--target-directory');
    const inline = args.find((word) => word.startsWith('--target-directory='));
    const target = inline ? inline.slice(inline.indexOf('=') + 1) : into >= 0 ? args[into + 1] : operands.at(-1);
    if (inline || into >= 0 || operands.length >= 2) {
      targets.push(wordPath(target, cwd));
    }
  } else if (name === 'sed' && args.some((word) => /^-[A-Za-z]*i/.test(word) || word.startsWith('--in-place'))) {
    targets.push(...operands.slice(1).map((word) => wordPath(word, cwd)));
  } else if (name === 'dd') {
    targets.push(...args.filter((word) => word.startsWith('of=')).map((word) => wordPath(word.slice(3), cwd)));
  }
  return targets;
}

/**
 * The first place where a command line would change a file inside `protectedRoot`
 * but outside every `allowed` folder.
 * @param {string} command the shell command line
 * @param {{cwd: string, protectedRoot: string, allowed: string[]}} options
 * @returns {{path: string, command: string}|null}
 */
export function findProtectedWrite(command, { cwd, protectedRoot, allowed }) {
  // Only a folder inside the protected one is a carve-out; one that contains it (a temp folder
  // holding the whole project, say) must not unprotect everything.
  const carveOuts = allowed.filter((folder) => isInside(folder, protectedRoot) && pathKey(folder) !== pathKey(protectedRoot));
  const isProtected = (target) => target && isInside(target, protectedRoot) && !carveOuts.some((folder) => isInside(target, folder));
  let current = cwd;
  const outer = [];
  for (const simple of lexShell(command)) {
    // A `cd` inside a subshell ends with it.
    if (simple.group === 'open') {
      outer.push(current);
      continue;
    }
    if (simple.group === 'close') {
      current = outer.length ? outer.pop() : current;
      continue;
    }
    const hit = changedPaths(simple, current).find(isProtected);
    if (hit) {
      return { path: hit, command: [...simple.words, ...simple.writes.map((target) => `> ${target}`)].join(' ') };
    }
    // Later relative paths resolve from where `cd` went; an unreadable target leaves them unresolved.
    const start = simple.words.findIndex((word) => !PREFIX.has(word) && !ASSIGNMENT.test(word));
    if (start >= 0 && (simple.words[start] === 'cd' || simple.words[start] === 'pushd')) {
      const target = simple.words.slice(start + 1).find((word) => !isOption(word));
      current = target === undefined ? os.homedir() : target === '-' ? null : wordPath(target, current);
    }
  }
  return null;
}
