// Project-relative write scopes. An entry is either a file ("src/a.gd") or a
// folder written with a trailing slash ("src/player/"), which covers every
// file below it. Used by the manifest validator, the post-run audit, and the
// agent runner's PreToolUse hook, so all three agree on what "allowed" means.
const path = require('node:path');

const FOLDER_GLOB_SUFFIX = /\/\*\*$/;

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

/**
 * Normalize a scope entry. `src/player/**` and `src/player/` both become the
 * folder entry `src/player/`. Throws for absolute or escaping paths.
 * @param {string} value
 * @param {string} fieldName used in error messages
 * @param {{folder?: boolean}} options force folder form (for owned_folder)
 * @returns {string}
 */
function normalizeScopeEntry(value, fieldName = 'path', options = {}) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${fieldName} is required.`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${fieldName} must be relative to the project root.`);
  }

  let normalized = toPosix(value).trim().replace(/^\.\/+/, '').replace(/\/+/g, '/');
  const isFolder = options.folder || normalized.endsWith('/') || FOLDER_GLOB_SUFFIX.test(normalized);
  normalized = normalized.replace(FOLDER_GLOB_SUFFIX, '').replace(/\/+$/, '');

  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) {
    throw new Error(`${fieldName} must stay inside the project root.`);
  }
  if (/[*?[\]]/.test(normalized)) {
    throw new Error(`${fieldName} must be a file or a folder ending in "/", not a glob: ${value}`);
  }
  return isFolder ? `${normalized}/` : normalized;
}

function isFolderEntry(entry) {
  return entry.endsWith('/');
}

function compareKey(value) {
  return toPosix(value).toLowerCase();
}

/**
 * Whether a project-relative file path falls inside a scope entry.
 */
function entryCovers(entry, relPath) {
  const target = compareKey(relPath);
  const key = compareKey(entry);
  return isFolderEntry(entry) ? target.startsWith(key) : target === key;
}

/**
 * Whether two entries can touch the same file (equal, or one folder contains
 * the other entry).
 */
function entriesOverlap(a, b) {
  return entryCovers(a, b.replace(/\/$/, '')) || entryCovers(b, a.replace(/\/$/, '')) || compareKey(a) === compareKey(b);
}

function createScopeMatcher(entries) {
  const list = [...entries];
  return (relPath) => list.some((entry) => entryCovers(entry, relPath));
}

/**
 * Resolve a tool's file path (absolute, or relative to cwd) to a
 * project-relative posix path, or null when it points outside `root`.
 */
function toRootRelative(root, filePath) {
  if (!filePath) {
    return null;
  }
  const absolute = path.resolve(root, String(filePath));
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return toPosix(relative);
}

module.exports = {
  createScopeMatcher,
  entriesOverlap,
  entryCovers,
  isFolderEntry,
  normalizeScopeEntry,
  toRootRelative,
};
