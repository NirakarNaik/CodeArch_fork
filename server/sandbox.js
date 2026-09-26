import path from "node:path";
import fs from "node:fs";

/**
 * Resolves userPath against rootDir and throws if the result would escape
 * rootDir, or if it (or any folder on the way to it) is a symlink. Never trust
 * paths that come from Claude's tool calls without running them through this.
 */
export function resolveSafePath(rootDir, userPath) {
  if (typeof userPath !== "string") {
    throw new Error("Path must be a string");
  }
  const cleaned = userPath.trim() === "" ? "." : userPath.trim();

  if (path.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new Error(`Absolute paths are not allowed: ${userPath}`);
  }
  if (cleaned.split(/[\\/]+/).includes("..")) {
    throw new Error(`'..' is not allowed in paths: ${userPath}`);
  }

  const resolvedRoot = path.resolve(rootDir);
  const target = path.resolve(resolvedRoot, cleaned);

  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes sandbox: ${userPath}`);
  }

  // Walk every component below the root so a symlinked parent folder can't
  // smuggle reads outside the sandbox.
  let current = resolvedRoot;
  for (const part of path.relative(resolvedRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed: ${userPath}`);
    }
  }

  return target;
}

/** Normalizes a repo-relative path so "./src/a.js" and "src\\a.js" compare equal. */
export function normalizeRelPath(p) {
  if (typeof p !== "string") return "";
  const norm = path.posix.normalize(p.trim().replace(/\\/g, "/")).replace(/^\.\/+/, "");
  return norm === "." ? "" : norm.replace(/\/+$/, "");
}
