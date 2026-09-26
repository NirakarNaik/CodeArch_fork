import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import "./graph.css";

// Importance sets fill + base radius. Fan-in (how many rendered nodes import this one) grows it.
export const COLORS = { core: "#f0a500", support: "#6b8cae", config: "#4a4f57" };
export const BASE_RADIUS = { core: 14, support: 10, config: 8 };
const FALLBACK_COLOR = "#6b6e82";
const FALLBACK_RADIUS = 10;

// Safety guard: the backend stops at 25 emit_node calls, but a misbehaving stream must not
// be able to wreck the layout. Only the first 25 distinct nodes to arrive are rendered.
export const MAX_NODES = 25;

// Radial layout: ring radius = RING_STEP * depth. A full ring overflows onto a ring
// OVERFLOW_STEP further out instead of squeezing nodes together.
export const RING_STEP = 120;
const OVERFLOW_STEP = 60;
// Minimum arc between neighbours on a ring: largest node (14 + 10 fan-in = 24px radius)
// on both sides plus room for a truncated label.
const MIN_ARC = 84;

// Cluster dots, chosen to stay clear of the importance fills and the highlight colours.
const CLUSTER_COLORS = ["#f472b6", "#c084fc", "#a3e635", "#fdba74", "#94a3b8"];

// One highlight system for every "look at this file" reason (ExploreView builds the map).
// A file can carry several kinds. Flagged/stale draw the main ring (flagged outranks stale);
// active-cluster membership is layered on as its own outer ring, so it stays visible even
// when the file is also flagged or stale (the common case).
export const HIGHLIGHTS = {
  flagged: { label: "Flagged issue", color: "#f0a500" },
  stale: { label: "Stale", color: "#fb923c" },
  active: { label: "Active cluster", color: "#4fd1a5" },
};

const EMPTY_MAP = new Map();
const EMPTY_LIST = [];

// Imports may come back as "./src/x.js" or "/src/x.js"; match on a canonical form.
const normalize = (p) => (p || "").replace(/^\.?\//, "");
const basename = (p) => normalize(p).split("/").pop() || p;
const truncate = (s, n = 16) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// { flagged: [...files], stale: [...], active: [...] } -> Map(normalized file -> kinds[]),
// kinds in priority order (flagged, stale, active).
export function buildHighlights(groups) {
  const map = new Map();
  for (const kind of Object.keys(HIGHLIGHTS)) {
    for (const file of Array.isArray(groups[kind]) ? groups[kind] : []) {
      if (typeof file !== "string") continue;
      const key = normalize(file);
      const kinds = map.get(key) || [];
      if (!kinds.includes(kind)) map.set(key, [...kinds, kind]);
    }
  }
  return map;
}

// kinds[] (or a single kind string) -> { main: ring kind or undefined, active, kinds }
function splitHighlight(value) {
  const kinds = Array.isArray(value) ? value : value ? [value] : [];
  const active = kinds.includes("active");
  return { main: kinds.find((k) => k !== "active") ?? (active ? "active" : undefined), active, kinds };
}

// "src/routes#1" -> "src/routes", "root#1" -> "root folder", "src#2" -> "src #2"
function clusterPlace(id) {
  const m = /^(.*)#(\d+)$/.exec(String(id));
  const dir = m ? m[1] : String(id);
  const place = dir === "root" || dir === "." || dir === "" ? "root folder" : dir.length > 22 ? "…" + dir.slice(-21) : dir;
  return m && m[2] !== "1" ? place + " #" + m[2] : place;
}

// Human-readable cluster label for the key/tooltip, e.g. "Shared work: root folder (3 people)".
// The author count comes from direction.activeClusters (matched by file); without it, no count.
export function clusterLabel(id, authorCount) {
  const people = Number.isFinite(authorCount) && authorCount > 0 ? " (" + authorCount + (authorCount === 1 ? " person)" : " people)") : "";
  return "Shared work: " + clusterPlace(id) + people;
}

// clusterId -> authorCount, by matching each cluster's rendered files against activeClusters.
export function clusterAuthorCounts(nodes, activeClusters) {
  const counts = new Map();
  const list = Array.isArray(activeClusters) ? activeClusters : [];
  for (const node of nodes) {
    if (node.clusterId == null || node.clusterId === "" || counts.has(node.clusterId)) continue;
    const file = normalize(node.file);
    const match = list.find((c) => Array.isArray(c?.files) && c.files.some((x) => typeof x === "string" && normalize(x) === file));
    if (match && Number.isFinite(match.authorCount)) counts.set(node.clusterId, match.authorCount);
  }
  return counts;
}

// clusterId -> colour, only for clusters shared by at least two rendered nodes, assigned in
// order of first appearance so colours don't shuffle as nodes stream in.
export function clusterColors(nodes) {
  const counts = new Map();
  for (const n of nodes) {
    // null/undefined/"" all mean "not in a cluster"; any other value (including 0) is an id.
    if (n.clusterId == null || n.clusterId === "") continue;
    counts.set(n.clusterId, (counts.get(n.clusterId) || 0) + 1);
  }
  const colors = new Map();
  for (const [id, count] of counts) {
    if (count >= 2) colors.set(id, CLUSTER_COLORS[colors.size % CLUSTER_COLORS.length]);
  }
  return colors;
}

// Only emits an edge when the imported file is already rendered.
export function buildEdges(nodes) {
  const byFile = new Map(nodes.map((n) => [normalize(n.file), n]));
  const edges = [];
  const seen = new Set();
  for (const node of nodes) {
    for (const imp of node.imports || []) {
      const target = byFile.get(normalize(imp));
      const id = target && `${node.id}->${target.id}`;
      if (target && target.id !== node.id && !seen.has(id)) {
        seen.add(id);
        edges.push({ id, from: node, to: target });
      }
    }
  }
  return edges;
}

// node id -> number of other rendered nodes that import it.
export function fanInCounts(nodes) {
  const counts = new Map(nodes.map((n) => [n.id, 0]));
  for (const { to } of buildEdges(nodes)) counts.set(to.id, counts.get(to.id) + 1);
  return counts;
}

export function nodeRadius(node, fanIn = 0) {
  return (BASE_RADIUS[node.importance] ?? FALLBACK_RADIUS) + Math.min(fanIn * 1.5, 10);
}

// Van der Corput sequence: 0, 1/2, 1/4, 3/4, 1/8, 5/8, ... Slot i sits at angle 2π·vdc(i), so a
// ring fills in an order that stays balanced at every step, and is exactly even when full,
// without ever moving a node that's already placed.
const vdc = (i) => {
  let v = 0;
  for (let d = 0.5; i; i >>= 1, d /= 2) if (i & 1) v += d;
  return v;
};

// Slots on a ring: a power of two (so vdc spacing is exact) keeping neighbours >= MIN_ARC apart.
export const ringCapacity = (r) => 2 ** Math.max(1, Math.floor(Math.log2((2 * Math.PI * r) / MIN_ARC)));

export function createLayout() {
  return { rootId: null, positions: new Map(), ringFill: new Map() };
}

// BFS distance from the root over import relationships (either direction) among the nodes
// placed so far plus this one. No traceable relationship -> depth 1.
function depthOf(node, layout, nodesById, fileToId) {
  const ids = new Set([...layout.positions.keys(), node.id]);
  const adj = new Map([...ids].map((id) => [id, new Set()]));
  for (const id of ids) {
    for (const imp of nodesById.get(id)?.imports || []) {
      const target = fileToId.get(normalize(imp));
      if (target && target !== id && ids.has(target)) {
        adj.get(id).add(target);
        adj.get(target).add(id);
      }
    }
  }
  const dist = new Map([[layout.rootId, 0]]);
  const queue = [layout.rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const next of adj.get(id) || []) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(id) + 1);
        queue.push(next);
      }
    }
  }
  return Math.max(1, dist.get(node.id) ?? 1);
}

/**
 * Places every not-yet-placed node, in arrival order, and returns the layout. Positions are
 * computed exactly once per node and never recomputed, so the graph never jitters. A different
 * first node (a new run) starts a fresh layout.
 */
export function extendLayout(layout, nodes) {
  if (!nodes.length) return layout.rootId === null ? layout : createLayout();
  if (layout.rootId !== null && layout.rootId !== nodes[0].id) layout = createLayout();

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const fileToId = new Map(nodes.map((n) => [normalize(n.file), n.id]));
  for (const node of nodes) {
    if (layout.positions.has(node.id)) continue;
    if (layout.rootId === null) {
      layout.rootId = node.id;
      layout.positions.set(node.id, { x: 0, y: 0, depth: 0, ring: 0 });
      continue;
    }
    const depth = depthOf(node, layout, nodesById, fileToId);
    let r = RING_STEP * depth;
    while ((layout.ringFill.get(r) || 0) >= ringCapacity(r)) r += OVERFLOW_STEP;
    const slot = layout.ringFill.get(r) || 0;
    layout.ringFill.set(r, slot + 1);
    // Each ring gets its own rotation so rings don't line up along the same spokes.
    const angle = -Math.PI / 2 + (r / OVERFLOW_STEP) * 0.41 + 2 * Math.PI * vdc(slot);
    const round = (v) => Math.round(v * 10) / 10;
    layout.positions.set(node.id, { x: round(r * Math.cos(angle)), y: round(r * Math.sin(angle)), depth, ring: r });
  }
  return layout;
}

// Quadratic bezier bowed perpendicular to the direct line (always to the same side of the
// direction of travel, so A->B and B->A curve apart), clipped to both circles so the
// arrowhead sits on the target's edge. `length` is approximate, for the draw-in animation.
export function edgePath(a, b, ra, rb) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(len * 0.18, 60);
  const c = { x: (a.x + b.x) / 2 - (dy / len) * bend, y: (a.y + b.y) / 2 + (dx / len) * bend };
  const toward = (from, to, dist) => {
    const l = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: from.x + ((to.x - from.x) / l) * dist, y: from.y + ((to.y - from.y) / l) * dist };
  };
  const s = toward(a, c, ra);
  const e = toward(b, c, rb + 3);
  let length = 0;
  let prev = s;
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    const p = {
      x: (1 - t) ** 2 * s.x + 2 * (1 - t) * t * c.x + t ** 2 * e.x,
      y: (1 - t) ** 2 * s.y + 2 * (1 - t) * t * c.y + t ** 2 * e.y,
    };
    length += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  const f = (v) => Math.round(v * 10) / 10;
  return { d: `M${f(s.x)},${f(s.y)} Q${f(c.x)},${f(c.y)} ${f(e.x)},${f(e.y)}`, length: Math.ceil(length) };
}

/**
 * Props:
 *   nodes            GraphNode[] in arrival order
 *   highlights       Map(file -> kinds[]) from buildHighlights (flagged / stale / active)
 *   activeClusters   direction.activeClusters ({ files, authorCount }[]) for cluster labels
 *   highlightedFiles string[]: files whose edges get the `.edge.highlighted` treatment
 * Ref API:
 *   focusNode(file | file[]): highlights the file's edges and pulses its node once per call.
 * Flagged-issue files (highlights kind "flagged") are focused automatically when they arrive,
 * so the end-of-run emphasis works without the parent calling focusNode itself.
 */
const GraphCanvas = forwardRef(function GraphCanvas(
  { nodes: allNodes, highlights = EMPTY_MAP, highlightedFiles = EMPTY_LIST, activeClusters = EMPTY_LIST },
  ref
) {
  const nodes = allNodes.length > MAX_NODES ? allNodes.slice(0, MAX_NODES) : allNodes;
  const markerId = `graph-arrow-${useId().replace(/:/g, "")}`;

  const layoutRef = useRef(createLayout());
  layoutRef.current = extendLayout(layoutRef.current, nodes);
  const { positions, rootId } = layoutRef.current;

  const [focus, setFocus] = useState({ files: new Set(), pulses: new Map() });
  const focusNode = useCallback((fileOrFiles) => {
    const list = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]).filter((f) => typeof f === "string").map(normalize);
    if (!list.length) return;
    setFocus((prev) => {
      const files = new Set(prev.files);
      const pulses = new Map(prev.pulses);
      for (const f of list) {
        files.add(f);
        pulses.set(f, (pulses.get(f) || 0) + 1);
      }
      return { files, pulses };
    });
  }, []);
  useImperativeHandle(ref, () => ({ focusNode }), [focusNode]);

  // A new run clears any focus from the previous one.
  useEffect(() => setFocus({ files: new Set(), pulses: new Map() }), [rootId]);

  const flaggedKey = [...highlights].filter(([, v]) => splitHighlight(v).kinds.includes("flagged")).map(([f]) => f).sort().join("\n");
  useEffect(() => {
    if (flaggedKey) focusNode(flaggedKey.split("\n"));
  }, [flaggedKey, focusNode]);

  const emphasized = new Set([...highlightedFiles.filter((f) => typeof f === "string").map(normalize), ...focus.files]);
  const fanIn = fanInCounts(nodes);
  const radius = new Map(nodes.map((n) => [n.id, nodeRadius(n, fanIn.get(n.id))]));
  const edges = buildEdges(nodes);
  const clusters = clusterColors(nodes);
  const clusterAuthors = clusterAuthorCounts(nodes, activeClusters);

  let outer = 0;
  for (const n of nodes) {
    const p = positions.get(n.id);
    outer = Math.max(outer, Math.hypot(p.x, p.y));
  }
  const extent = Math.max(260, outer + 70);

  const shownHighlights = Object.keys(HIGHLIGHTS).filter((kind) =>
    nodes.some((n) => splitHighlight(highlights.get(normalize(n.file))).kinds.includes(kind))
  );
  const anyEmphasized = edges.some((e) => emphasized.has(normalize(e.from.file)) || emphasized.has(normalize(e.to.file)));

  return (
    <div className="graph-wrap">
      <div className="graph-canvas" data-testid="graph-canvas">
        <svg
          className="graph-svg"
          viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Dependency graph of ${nodes.length} files`}
        >
          <defs>
            {[
              [markerId, "#333"],
              [`${markerId}-hl`, "#f0a500"],
            ].map(([id, color]) => (
              <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={color} />
              </marker>
            ))}
          </defs>

          <g className="graph-edges">
            {edges.map(({ id, from, to }) => {
              const hl = emphasized.has(normalize(from.file)) || emphasized.has(normalize(to.file));
              const { d, length } = edgePath(positions.get(from.id), positions.get(to.id), radius.get(from.id), radius.get(to.id));
              return (
                <path
                  key={id}
                  data-edge={id}
                  data-highlighted={hl || undefined}
                  className={hl ? "edge highlighted" : "edge"}
                  d={d}
                  // Slack so the dash still covers the path if a radius change lengthens it slightly.
                  style={{ "--len": length + 24 }}
                  markerEnd={`url(#${hl ? `${markerId}-hl` : markerId})`}
                />
              );
            })}
          </g>

          <g className="graph-nodes">
            {nodes.map((node) => {
              const p = positions.get(node.id);
              const r = radius.get(node.id);
              const file = normalize(node.file);
              const { main: highlight, active: inActiveCluster } = splitHighlight(highlights.get(file));
              const layeredActive = inActiveCluster && highlight !== "active";
              const clusterColor = clusters.get(node.clusterId);
              const pulse = focus.pulses.get(file) || 0;
              const details = [
                node.file,
                node.role,
                node.imports?.length ? `imports: ${node.imports.join(", ")}` : null,
                `imported by: ${fanIn.get(node.id)}`,
                node.activity ? `activity: ${node.activity}` : null,
                node.authorCount === 0
                  ? "not touched in the analyzed commits"
                  : node.authorCount != null
                    ? `authors: ${node.authorCount}`
                    : null,
                node.clusterId != null && node.clusterId !== "" ? clusterLabel(node.clusterId, clusterAuthors.get(node.clusterId)) : null,
                highlight ? `highlighted: ${HIGHLIGHTS[highlight].label}` : null,
                layeredActive ? `also: ${HIGHLIGHTS.active.label}` : null,
              ];
              return (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  data-file={file}
                  data-importance={node.importance}
                  data-activity={node.activity || undefined}
                  data-cluster={clusterColor ? node.clusterId : undefined}
                  data-highlight={highlight}
                  data-active-cluster={inActiveCluster || undefined}
                  data-focused={focus.files.has(file) || undefined}
                  className={[
                    "gnode",
                    `importance-${node.importance}`,
                    node.activity && `activity-${node.activity}`,
                    highlight && `highlight highlight-${highlight}`,
                    inActiveCluster && "in-active-cluster",
                    focus.files.has(file) && "is-focused",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  transform={`translate(${p.x} ${p.y})`}
                >
                  <title>{details.filter(Boolean).join("\n")}</title>
                  {/* Two alternating keyframe names so every focusNode() call replays the pulse
                      without remounting the node (which would replay its fade-in too). */}
                  <g className={`gnode-pulse${pulse ? (pulse % 2 ? " pulse-a" : " pulse-b") : ""}`}>
                    <g className="gnode-body">
                      {highlight && <circle className="gnode-ring" r={r + 5} style={{ "--hl": HIGHLIGHTS[highlight].color }} />}
                      {layeredActive && (
                        <circle className="gnode-ring-active" r={r + 9} style={{ "--hl": HIGHLIGHTS.active.color }} />
                      )}
                      <circle className="gnode-dot" r={r} fill={COLORS[node.importance] || FALLBACK_COLOR} />
                      {clusterColor && <circle className="node-cluster-dot" cx={r * 0.72} cy={-r * 0.72} r={3.5} fill={clusterColor} />}
                    </g>
                  </g>
                  <text className="gnode-label" y={r + 13} textAnchor="middle">
                    {truncate(basename(node.file))}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {nodes.length > 0 && (
        <div className="graph-key">
          {Object.entries(COLORS).map(([kind, color]) => (
            <span key={kind} className="graph-key-item graph-key-importance">
              <span className="graph-key-tint" style={{ background: color }} aria-hidden="true" />
              {kind}
            </span>
          ))}
          {anyEmphasized && (
            <span className="graph-key-item">
              <span className="graph-key-line" aria-hidden="true" />
              Highlighted path
            </span>
          )}
          {shownHighlights.map((kind) => (
            <span key={kind} className={`graph-key-item highlight-${kind}`}>
              <span className="graph-key-ring" style={{ "--hl": HIGHLIGHTS[kind].color }} aria-hidden="true" />
              {HIGHLIGHTS[kind].label}
            </span>
          ))}
          {[...clusters].map(([id, c]) => (
            <span key={id} className="graph-key-item">
              <span className="graph-key-tint graph-key-cluster" style={{ background: c }} aria-hidden="true" />
              {clusterLabel(id, clusterAuthors.get(id))}
            </span>
          ))}
        </div>
      )}
      {allNodes.length > MAX_NODES && (
        <p className="graph-cap-note">Showing the first {MAX_NODES} of {allNodes.length} files.</p>
      )}
    </div>
  );
});

export default GraphCanvas;
