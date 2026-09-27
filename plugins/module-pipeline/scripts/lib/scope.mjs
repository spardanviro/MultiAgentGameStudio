// Project-relative write scopes. An entry is a file ("src/a.gd") or a folder
// written with a trailing slash ("src/player/") that covers everything below
// it. The manifest validator, the PreToolUse hook and the audit all use these
// helpers so they agree on what "allowed" means.
import path from 'node:path';

const FOLDER_GLOB_SUFFIX = /\/\*\*$/;

export function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

/**
 * Normalize a scope entry; `src/player/**` and `src/player/` both become
 * `src/player/`. Throws for absolute, escaping, or glob paths.
 * @param {string} value
 * @param {string} fieldName for error messages
 * @param {{folder?: boolean}} [options] force the folder form
 */
export function normalizeScopeEntry(value, fieldName = 'path', options = {}) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${fieldName} is required.`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${fieldName} must be relative to the project root: ${value}`);
  }
  let normalized = toPosix(value).trim().replace(/^\.\/+/, '').replace(/\/+/g, '/');
  const isFolder = options.folder || normalized.endsWith('/') || FOLDER_GLOB_SUFFIX.test(normalized);
  normalized = normalized.replace(FOLDER_GLOB_SUFFIX, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) {
    throw new Error(`${fieldName} must stay inside the project root: ${value}`);
  }
  if (/[*?[\]]/.test(normalized)) {
    throw new Error(`${fieldName} must be a file or a folder ending in "/", not a glob: ${value}`);
  }
  return isFolder ? `${normalized}/` : normalized;
}

export function normalizeRelPath(value, fieldName = 'path') {
  return normalizeScopeEntry(value, fieldName).replace(/\/$/, '');
}

const key = (value) => toPosix(value).toLowerCase();

export function entryCovers(entry, relPath) {
  return entry.endsWith('/') ? key(relPath).startsWith(key(entry)) : key(relPath) === key(entry);
}

/** Whether two entries can touch the same file. */
export function entriesOverlap(a, b) {
  return key(a) === key(b) || entryCovers(a, b.replace(/\/$/, '')) || entryCovers(b, a.replace(/\/$/, ''));
}

export function createScopeMatcher(entries) {
  const list = [...entries];
  return (relPath) => list.some((entry) => entryCovers(entry, relPath));
}

/**
 * Resolve a path (absolute, or relative to root) to a root-relative posix
 * path, or null when it is outside root.
 */
export function toRootRelative(root, filePath) {
  if (!filePath) {
    return null;
  }
  const relative = path.relative(path.resolve(root), path.resolve(root, String(filePath)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return toPosix(relative);
}
