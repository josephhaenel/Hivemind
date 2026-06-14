/**
 * Minimal common-prefix/suffix diff. Turns a whole-file replacement (which is
 * how an agent's Edit/Write arrives) into a single splice into a Y.Text, so a
 * small edit produces a small CRDT op instead of churning the whole document.
 */
export interface Splice {
  index: number;
  deleteCount: number;
  insert: string;
}

export function computeSplice(oldStr: string, newStr: string): Splice {
  if (oldStr === newStr) return { index: 0, deleteCount: 0, insert: "" };

  const oldLen = oldStr.length;
  const newLen = newStr.length;
  const maxPrefix = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < maxPrefix && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) {
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = Math.min(oldLen, newLen) - prefix;
  while (
    suffix < maxSuffix &&
    oldStr.charCodeAt(oldLen - 1 - suffix) === newStr.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++;
  }

  return {
    index: prefix,
    deleteCount: oldLen - prefix - suffix,
    insert: newStr.slice(prefix, newLen - suffix),
  };
}
