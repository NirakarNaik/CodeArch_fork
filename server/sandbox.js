import path from "node:path";
import fs from "node:fs";

/**
 * Resolves userPath against rootDir and throws if the result would escape
 * rootDir, or if it points at a symlink. Never trust paths that come from
 * Claude's tool calls without running them through this first.
 */
export function resolveSafePath(rootDir, userPath) {
  const resolvedRoot = path.resolve(rootDir);
  const target = path.resolve(resolvedRoot, userPath || ".");

  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes sandbox: ${userPath}`);
  }

  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed: ${userPath}`);
    }
  }

  return target;
}
