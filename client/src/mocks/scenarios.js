// Named mock SSE streams for exercising the graph: easy, hard and rare cases.
// Same event shape as FAKE_EVENTS (see mockEventSource.js). Plain JS, so the browser e2e
// script can import it too.

export const n = (file, extra = {}) => ({
  id: extra.id ?? `n:${file}`,
  file,
  role: `Role of ${file}`,
  imports: [],
  importance: "support",
  activity: "active",
  authorCount: 1,
  clusterId: null,
  ...extra,
});
const node = (file, extra) => ({ type: "node", delayMs: 40, data: n(file, extra) });
const done = (issue = null, files = [], evidence = "") => ({ type: "done", delayMs: 40, data: { issue, evidence, files } });
const direction = (data) => ({ type: "direction", delayMs: 40, data });
const range = (k) => Array.from({ length: k }, (_, i) => i);

export const SCENARIOS = {
  // ---------- easy ----------
  single: [node("src/index.js", { importance: "core" }), done()],

  chain: [
    node("src/a.js", { importance: "core" }),
    node("src/b.js", { imports: ["src/a.js"] }),
    node("src/c.js", { imports: ["src/b.js"] }),
    node("src/d.js", { imports: ["src/c.js"], importance: "config" }),
    done("src/d.js is unused", ["src/d.js"]),
    direction({ staleFiles: ["src/c.js"], activeClusters: [{ id: "k", files: ["src/a.js"] }] }),
  ],

  noIssueEmptyDirection: [
    node("src/a.js"),
    node("src/b.js", { imports: ["src/a.js"] }),
    done(null, []),
    direction({ staleFiles: [], activeClusters: [] }),
  ],

  // ---------- hard ----------
  // 100 nodes, every one importing its predecessor: only the first 25 may render.
  flood: [...range(100).map((i) => node(`src/f${i}.js`, { imports: i ? [`src/f${i - 1}.js`] : [] })), done()],

  // Exactly at the cap, fully connected: 25 * 24 = 600 import edges to route.
  dense25: [
    ...range(25).map((i) =>
      node(`src/m${i}.js`, {
        imports: range(25).filter((j) => j !== i).map((j) => `src/m${j}.js`),
        importance: ["core", "support", "config"][i % 3],
        activity: i % 4 === 0 ? "stale" : "active",
        clusterId: ["api", "db", "ui", null][i % 4],
      })
    ),
    done("src/m0.js is a god file", ["src/m0.js"]),
    direction({ staleFiles: ["src/m4.js", "src/m8.js"], activeClusters: [{ id: "api", files: ["src/m1.js", "src/m5.js"] }] }),
  ],

  // Imports point at files that only show up later (and one that never does).
  outOfOrder: [
    node("src/app.js", { imports: ["src/db.js", "src/config.js", "src/ghost.js"] }),
    node("src/db.js", { imports: ["src/config.js"] }),
    node("src/config.js", { importance: "config" }),
    done(),
  ],

  // Same file re-emitted: first with a random id and "./" prefix, later updated fields.
  reemit: [
    node("src/a.js", { id: "rnd-1", activity: "stale", clusterId: null }),
    node("src/b.js", { clusterId: "x" }),
    node("./src/a.js", { id: "rnd-2", activity: "active", clusterId: "x", role: "updated role" }),
    done(),
  ],

  // Direction/issue name files that were never rendered, or are beyond the cap.
  unknownHighlights: [
    ...range(30).map((i) => node(`src/u${i}.js`)),
    done("gone", ["src/nope.js", "src/u29.js"]),
    direction({ staleFiles: ["src/u27.js", "does/not/exist.js"], activeClusters: [{ id: "c", files: ["src/u0.js", "src/u26.js"] }] }),
  ],

  // Cluster whose second member is cut off by the cap -> rendered member is a singleton.
  clusterAcrossCap: [
    ...range(24).map((i) => node(`src/k${i}.js`)),
    node("src/k24.js", { clusterId: "split" }),
    node("src/k25.js", { clusterId: "split" }),
    done(),
  ],

  // More clusters than tint colours (palette has 5).
  manyClusters: [...range(14).map((i) => node(`src/c${i}.js`, { clusterId: `cl${Math.floor(i / 2)}` })), done()],

  // Same file in flagged, stale and active lists at once.
  highlightPriority: [
    node("src/all.js"),
    node("src/stale-and-active.js"),
    node("src/only-active.js"),
    done("x", ["src/all.js"]),
    direction({
      staleFiles: ["src/all.js", "src/stale-and-active.js"],
      activeClusters: [{ id: "a", files: ["src/all.js", "src/stale-and-active.js", "src/only-active.js"] }],
    }),
  ],

  // Direction sent twice; the second should win.
  directionTwice: [
    node("src/a.js"),
    node("src/b.js"),
    done(),
    direction({ staleFiles: ["src/a.js"], activeClusters: [] }),
    direction({ staleFiles: ["src/b.js"], activeClusters: [] }),
  ],

  // A late node after `done` (stream is kept open for direction) must not flip status back.
  lateNodeAfterDone: [node("src/a.js"), done(), node("src/late.js"), direction({ staleFiles: ["src/late.js"], activeClusters: [] })],

  // ---------- rare ----------
  // Fields missing or odd: no imports/activity/cluster, unknown importance/activity,
  // empty-string and numeric cluster ids, circular + self imports.
  weirdFields: [
    { type: "node", delayMs: 40, data: { id: "w1", file: "src/bare.js", role: "no optional fields" } },
    node("src/UPPER.js", { importance: "CORE", activity: "archived" }),
    node("src/empty-cluster-1.js", { clusterId: "" }),
    node("src/empty-cluster-2.js", { clusterId: "" }),
    node("src/zero-1.js", { clusterId: 0 }),
    node("src/zero-2.js", { clusterId: 0 }),
    node("src/cyc-a.js", { imports: ["src/cyc-b.js", "src/cyc-a.js"] }),
    node("src/cyc-b.js", { imports: ["src/cyc-a.js"] }),
    done(),
  ],

  // Long, unicode and HTML-looking content must render as text.
  hostileText: [
    node("src/very/deeply/nested/directory/structure/with/a/really/long/file-name-that-goes-on.module.test.js", {
      role: "A".repeat(600),
    }),
    node("src/ünïcødé/文件.js", { role: "Handles 日本語 and emoji 🚀 names" }),
    node("src/xss.js", { role: '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script>' }),
    done('<b>bold?</b> issue', ["src/xss.js"]),
  ],

  // Payloads that are malformed or the wrong type.
  malformed: [
    { type: "node", delayMs: 40, raw: "{not json" },
    node("src/ok.js"),
    { type: "direction", delayMs: 40, raw: "null" },
    { type: "direction", delayMs: 40, raw: '"just a string"' },
    done(null, undefined),
    direction({ staleFiles: null, activeClusters: [null, { id: "x" }, { files: "src/ok.js" }, { files: [7, null, "src/ok.js"] }] }),
  ],

  // Server reports an error mid-stream after some nodes.
  errorMidStream: [node("src/a.js"), node("src/b.js"), { type: "error", delayMs: 40, data: { message: "rate limited" } }],

  // Stream ends with no done at all.
  noDone: [node("src/a.js"), node("src/b.js")],
};

// Plays a scenario through a controllable mock EventSource instance.
export function playInto(source, events) {
  for (const evt of events) {
    if (evt.raw !== undefined) source.emit(evt.type, evt.raw);
    else source.emit(evt.type, evt.data);
  }
}

// Serializes a scenario as an SSE response body (for browser route interception).
export function toSSEBody(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${e.raw ?? JSON.stringify(e.data)}\n\n`).join("");
}
