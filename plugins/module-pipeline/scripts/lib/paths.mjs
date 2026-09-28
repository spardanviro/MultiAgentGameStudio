// Path identity on every platform. Windows can name one folder several ways
// (8.3 short names such as C:\Users\RUNNER~1, different letter case), and git
// always reports the long form, so paths are compared in canonical form.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The real, long form of a path. Parts that do not exist yet (a file about to
 * be written) are kept as given below the deepest existing folder.
 */
export function canonicalPath(value) {
  const resolved = path.resolve(String(value));
  const missing = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...[...missing].reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** A key that is equal for two spellings of the same path. */
export function pathKey(value) {
  const canonical = canonicalPath(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}
