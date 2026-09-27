// Module ownership rules for a manifest: one module agent owns one module
// folder (legacy manifests: one script), and one folder has one owner. No
// other task may write inside a module's owned area.
const { entriesOverlap } = require('./fileScope');

/**
 * The scope entries a module task owns exclusively.
 * @param {{ownedFolder?: string|null, ownedScript?: string|null, testFolder?: string|null}} task
 * @returns {string[]}
 */
function getOwnedEntries(task) {
  return [task.ownedFolder || task.ownedScript, task.testFolder].filter(Boolean);
}

function describeOwned(entry) {
  return entry.endsWith('/') ? `folder ${entry}` : `script ${entry}`;
}

/**
 * Throws when two module tasks own overlapping areas, or when any task's
 * allowed_files reach into another module's owned area.
 * @param {Array<{id: string, role: string, allowedFiles: string[]}>} tasks normalized tasks
 */
function validateModuleOwnership(tasks) {
  const owners = tasks
    .filter((task) => task.role === 'sub')
    .map((task) => ({ id: task.id, entries: getOwnedEntries(task) }));

  for (let i = 0; i < owners.length; i += 1) {
    for (let j = i + 1; j < owners.length; j += 1) {
      for (const a of owners[i].entries) {
        const clash = owners[j].entries.find((b) => entriesOverlap(a, b));
        if (clash) {
          throw new Error(
            `Module ownership overlap: ${owners[i].id} owns ${describeOwned(a)} and ${owners[j].id} owns ${describeOwned(clash)}. ` +
              'One module folder can have only one owner.',
          );
        }
      }
    }
  }

  for (const task of tasks) {
    for (const owner of owners) {
      if (owner.id === task.id) {
        continue;
      }
      for (const entry of task.allowedFiles) {
        const owned = owner.entries.find((ownedEntry) => entriesOverlap(entry, ownedEntry));
        if (owned) {
          throw new Error(
            `${task.id}.allowed_files entry ${entry} reaches into ${owner.id}'s owned ${describeOwned(owned)}. ` +
              `Only ${owner.id} may write there; other tasks must use interface requests.`,
          );
        }
      }
    }
  }
}

module.exports = {
  getOwnedEntries,
  validateModuleOwnership,
};
