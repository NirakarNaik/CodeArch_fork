import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MIN_COMMIT_DEPTH = 10;
export const MAX_COMMIT_DEPTH = 50;
export const DEFAULT_COMMIT_DEPTH = 25;

const DAY_MS = 24 * 60 * 60 * 1000;
const HEADER_RE = /^([0-9a-f]{40})\|(.*)\|(\d+)$/;

/** Clamps any input (string, NaN, out of range) into [10, 50]; never throws. */
export function clampCommitDepth(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_COMMIT_DEPTH;
  return Math.min(MAX_COMMIT_DEPTH, Math.max(MIN_COMMIT_DEPTH, n));
}

function git(rootDir, args) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      { cwd: rootDir, maxBuffer: 20 * 1024 * 1024, timeout: 15_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * Parses the last `commitDepth` commits into one CommitStats entry per file
 * that still exists in the checkout (deleted/renamed-away paths can't be graph
 * nodes, so they're dropped). If the repo has fewer commits than requested,
 * git simply returns what exists.
 *
 * Each entry also carries a server-only `authors` array (the actual author
 * names) so clustering can compare author sets; it is not part of the wire
 * contract and is never sent to the client.
 *
 * Returns { commitStats, commitsAnalyzed, authorCount }.
 */
export async function getCommitStats(rootDir, commitDepth) {
  const depth = clampCommitDepth(commitDepth);
  const out = await git(rootDir, ["log", "-n", String(depth), "--name-only", "--format=%H|%an|%at"]);

  const byFile = new Map();
  const allAuthors = new Set();
  let commitsAnalyzed = 0;
  let current = null;
  const now = Date.now();

  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = HEADER_RE.exec(line);
    if (header) {
      current = { author: header[2].trim(), at: Number(header[3]) * 1000 };
      allAuthors.add(current.author);
      commitsAnalyzed += 1;
      continue;
    }
    if (!current) continue;
    const file = line.replace(/\\/g, "/");
    let entry = byFile.get(file);
    if (!entry) {
      entry = { file, touchCount: 0, authors: new Set(), lastTouchedAt: 0 };
      byFile.set(file, entry);
    }
    entry.touchCount += 1;
    entry.authors.add(current.author);
    entry.lastTouchedAt = Math.max(entry.lastTouchedAt, current.at);
  }

  const commitStats = [...byFile.values()]
    .filter((e) => fs.existsSync(path.join(rootDir, e.file)))
    .map((e) => ({
      file: e.file,
      touchCount: e.touchCount,
      distinctAuthors: e.authors.size,
      lastTouchedDaysAgo: Math.max(0, Math.floor((now - e.lastTouchedAt) / DAY_MS)),
      authors: [...e.authors].sort(),
    }))
    .sort((a, b) => b.touchCount - a.touchCount || a.file.localeCompare(b.file));

  return { commitStats, commitsAnalyzed, authorCount: allAuthors.size };
}
