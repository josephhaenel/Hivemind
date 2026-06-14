/**
 * Sync scope = the gitignore-bounded working tree (docs/design/sync-loop.md §6.5).
 * MVP: committed .gitignore + a built-in always-ignore list. Secrets/node_modules
 * are excluded because they're already gitignored; each dev keeps their own.
 */
import fs from "node:fs";
import path from "node:path";
import ignoreFactory from "ignore";

/** Minimal structural type for the bits of `ignore` we use (avoids `export =` typing friction). */
export interface Ignore {
  add(patterns: string | string[]): Ignore;
  ignores(pathname: string): boolean;
}
const makeIgnore = ignoreFactory as unknown as (options?: unknown) => Ignore;

const ALWAYS_IGNORE = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".wt/",
  ".working-together/",
];

export function buildIgnore(repoDir: string): Ignore {
  const ig = makeIgnore();
  ig.add(ALWAYS_IGNORE);
  const gitignorePath = path.join(repoDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  return ig;
}

/** True if `absPath` is outside the repo or matches the effective ignore set.
 *  The repo root itself is never ignored (so the watcher can watch it). */
export function isIgnored(ig: Ignore, repoDir: string, absPath: string): boolean {
  const rel = path.relative(repoDir, absPath).split(path.sep).join("/");
  if (rel === "") return false; // the root
  if (rel.startsWith("..")) return true; // outside the repo
  return ig.ignores(rel);
}

/** Repo-relative POSIX path, or null if outside the repo. */
export function toRel(repoDir: string, absPath: string): string | null {
  const rel = path.relative(repoDir, absPath).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}
