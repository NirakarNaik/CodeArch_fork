import path from "node:path";

// A file is "stale" if its last touch in the commit window is older than this,
// or if it wasn't touched in the window at all.
export const STALE_THRESHOLD_DAYS = 90;

// Two files in the same directory join a cluster when they share at least this
// many authors. 2 means "the same people collaborate on both", not just one
// prolific author touching everything.
const MIN_SHARED_AUTHORS = 2;

const UNKNOWN = { activity: "active", authorCount: 0, clusterId: null };

function sharedCount(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

/**
 * Deterministically groups files into collaboration clusters:
 *   (a) same parent directory, and
 *   (b) overlapping author sets (>= MIN_SHARED_AUTHORS shared authors),
 * joined transitively (union-find). Only files with 2+ distinct authors are
 * candidates; clusters of one file are dropped (clusterId null).
 *
 * clusterId is stable for the same history: "<dir>#<n>", numbered by each
 * cluster's alphabetically-first file.
 *
 * Returns { clusters, fileInfo, staleFiles, annotate(file) }. annotate() gives
 * the {activity, authorCount, clusterId} merged into every node event; files
 * not in the window are "stale" with authorCount 0.
 */
export function computeClusters(commitStats) {
  const stats = Array.isArray(commitStats) ? commitStats : [];
  const authorSets = new Map(stats.map((s) => [s.file, new Set(s.authors || [])]));

  const candidates = stats
    .filter((s) => s.distinctAuthors >= 2)
    .map((s) => s.file)
    .sort();

  const parent = new Map(candidates.map((f) => [f, f]));
  const find = (f) => {
    while (parent.get(f) !== f) {
      parent.set(f, parent.get(parent.get(f)));
      f = parent.get(f);
    }
    return f;
  };
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)].sort();
    if (ra !== rb) parent.set(rb, ra);
  };

  const byDir = new Map();
  for (const f of candidates) {
    const dir = path.posix.dirname(f);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  for (const files of byDir.values()) {
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (sharedCount(authorSets.get(files[i]), authorSets.get(files[j])) >= MIN_SHARED_AUTHORS) {
          union(files[i], files[j]);
        }
      }
    }
  }

  const groups = new Map();
  for (const f of candidates) {
    const root = find(f);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }

  const perDirCounter = new Map();
  const clusters = [...groups.values()]
    .filter((files) => files.length >= 2)
    .map((files) => files.sort())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((files) => {
      const dir = path.posix.dirname(files[0]);
      const n = (perDirCounter.get(dir) || 0) + 1;
      perDirCounter.set(dir, n);
      const authors = new Set();
      for (const f of files) for (const a of authorSets.get(f)) authors.add(a);
      return { id: `${dir === "." ? "root" : dir}#${n}`, files, authorCount: authors.size };
    });

  const clusterOf = new Map();
  for (const c of clusters) for (const f of c.files) clusterOf.set(f, c.id);

  const fileInfo = new Map(
    stats.map((s) => [
      s.file,
      {
        activity: s.lastTouchedDaysAgo > STALE_THRESHOLD_DAYS ? "stale" : "active",
        authorCount: s.distinctAuthors,
        clusterId: clusterOf.get(s.file) ?? null,
      },
    ])
  );

  const staleFiles = stats.filter((s) => fileInfo.get(s.file).activity === "stale").map((s) => s.file);

  return {
    clusters,
    fileInfo,
    staleFiles,
    annotate: (file) => fileInfo.get(file) ?? { activity: "stale", authorCount: 0, clusterId: null },
  };
}

/**
 * Annotation used when no git history is available at all. Nodes default to
 * "active": calling every file stale because we couldn't read history would
 * be a false claim shown to the audience.
 */
export function unknownAnnotation() {
  return { ...UNKNOWN };
}
