// Naming rules for groups, following Grouper's folder and group design guidance:
//   - names are plain, single-line, and do not use the suffixes reserved for include and exclude groups, which the
//     system creates and names itself;
//   - a description, saying what a group is for, is optional but kept within a length.

const RESERVED_SUFFIXES = [':include', ':exclude'];
const MAX_NAME = 200;
const MAX_DESCRIPTION = 1000;

/**
 * Problems with a group's name and description, as messages. `system` marks groups the system makes for itself (the include
 * and exclude groups), which may use the reserved names.
 */
function groupErrors({ name, description = '' }, { system = false } = {}) {
  const errors = [];
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) errors.push('Name is required.');
  else {
    if (n.length > MAX_NAME) errors.push(`Name must be ${MAX_NAME} characters or fewer.`);
    if (/[\u0000-\u001f\u007f]/.test(n)) errors.push('Name must be on one line, without control characters.');
    if (!system && RESERVED_SUFFIXES.some((s) => n.toLowerCase().endsWith(s))) {
      errors.push(`Names ending in ${RESERVED_SUFFIXES.join(' or ')} are reserved for a group's include and exclude groups.`);
    }
  }
  const d = typeof description === 'string' ? description.trim() : '';
  if (d.length > MAX_DESCRIPTION) errors.push(`Description must be ${MAX_DESCRIPTION} characters or fewer.`);
  return errors;
}

module.exports = { groupErrors, RESERVED_SUFFIXES };
