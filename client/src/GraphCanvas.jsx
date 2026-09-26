import { useEffect, useRef, useState } from "react";
import "./graph.css";

export const COLORS = { core: "#5ec8f8", support: "#8f8fd6", config: "#f5b942" };
const FALLBACK_COLOR = "#888888";

// Safety guard: the backend stops at 25 emit_node calls, but a misbehaving stream must not
// be able to wreck the layout. Only the first 25 distinct nodes to arrive are rendered.
export const MAX_NODES = 25;

// Cluster tints, chosen to stay clear of the importance hues and the highlight colours.
const CLUSTER_COLORS = ["#f472b6", "#c084fc", "#a3e635", "#fdba74", "#94a3b8"];

// One highlight system for every "look at this file" reason. Earlier entries win when a
// file qualifies for several.
export const HIGHLIGHTS = {
  flagged: { label: "Flagged issue", color: "#f07c7c" },
  stale: { label: "Stale", color: "#fb923c" },
  active: { label: "Active cluster", color: "#4fd1a5" },
};

const NODE_W = 200;
const NODE_H = 72;
const GAP_X = 56;
const GAP_Y = 48;

// Imports may come back as "./src/x.js" or "/src/x.js"; match on a canonical form.
const normalize = (p) => p.replace(/^\.?\//, "");

// Point where the segment from `from` to the centre of box `to` crosses that box's border.
function edgePoint(from, to) {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  if (dx === 0 && dy === 0) return to;
  const s = Math.min(dx ? NODE_W / 2 / Math.abs(dx) : Infinity, dy ? NODE_H / 2 / Math.abs(dy) : Infinity);
  return { x: to.x + dx * s, y: to.y + dy * s };
}

// Does segment p->q pass through the box at `pos` (with a small margin)? Liang–Barsky clip.
function segmentHitsBox(p, q, pos, pad = 6) {
  const [x0, y0, x1, y1] = [pos.x - pad, pos.y - pad, pos.x + NODE_W + pad, pos.y + NODE_H + pad];
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  for (const [pk, qk] of [[-dx, p.x - x0], [dx, x1 - p.x], [-dy, p.y - y0], [dy, y1 - p.y]]) {
    if (pk === 0) {
      if (qk < 0) return false;
    } else {
      const r = qk / pk;
      if (pk < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// Polyline -> SVG path with softly rounded corners.
function roundedPath(points, r = 8) {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const inLen = Math.hypot(c.x - p.x, c.y - p.y);
    const outLen = Math.hypot(n.x - c.x, n.y - c.y);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const a = { x: c.x - ((c.x - p.x) / (inLen || 1)) * k, y: c.y - ((c.y - p.y) / (inLen || 1)) * k };
    const b = { x: c.x + ((n.x - c.x) / (outLen || 1)) * k, y: c.y + ((n.y - c.y) / (outLen || 1)) * k };
    d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

// Straight line between the two boxes when nothing is in the way. Otherwise the line would
// pass behind another box and look like part of a chain, so route it through the empty
// gutters between rows/columns instead (they never contain boxes). `lane` nudges parallel
// routed edges apart so they don't sit exactly on top of each other.
export function routeEdge(a, b, others, lane = 0) {
  const ca = { x: a.cx, y: a.cy };
  const cb = { x: b.cx, y: b.cy };
  if (!others.some((box) => segmentHitsBox(ca, cb, box))) {
    const s = edgePoint(cb, ca);
    const e = edgePoint(ca, cb);
    return { d: `M${s.x},${s.y} L${e.x},${e.y}`, routed: false };
  }

  const rowGap = (box, side) => (side === "above" ? box.y - GAP_Y / 2 : box.y + NODE_H + GAP_Y / 2);
  const sameRow = a.y === b.y;
  // Horizontal gutter next to the source (toward the target), and next to the target (toward the source).
  const srcSide = sameRow ? (a.y === 0 ? "below" : "above") : b.y < a.y ? "above" : "below";
  const dstSide = sameRow ? srcSide : srcSide === "above" ? "below" : "above";
  const yA = rowGap(a, srcSide);
  const yB = rowGap(b, dstSide);
  const exitA = { x: a.cx, y: srcSide === "above" ? a.y : a.y + NODE_H };
  const enterB = { x: b.cx, y: dstSide === "above" ? b.y : b.y + NODE_H };

  let points;
  if (yA === yB) {
    // Source and target border the same gutter: one horizontal run.
    points = [exitA, { x: a.cx, y: yA + lane }, { x: b.cx, y: yB + lane }, enterB];
  } else {
    // Drop down/up a column gutter beside the target, on the side facing the source.
    const leftOfB = b.x - GAP_X / 2;
    const rightOfB = b.x + NODE_W + GAP_X / 2;
    const xV = a.x < b.x ? leftOfB : a.x > b.x ? rightOfB : b.x === 0 ? rightOfB : leftOfB;
    points = [
      exitA,
      { x: a.cx, y: yA + lane },
      { x: xV + lane, y: yA + lane },
      { x: xV + lane, y: yB + lane },
      { x: b.cx, y: yB + lane },
      enterB,
    ];
  }
  return { d: roundedPath(points), routed: true };
}

// { flagged: [...files], stale: [...], active: [...] } -> Map(normalized file -> kind)
export function buildHighlights(groups) {
  const map = new Map();
  for (const kind of Object.keys(HIGHLIGHTS)) {
    for (const file of Array.isArray(groups[kind]) ? groups[kind] : []) {
      if (typeof file !== "string") continue;
      const key = normalize(file);
      if (!map.has(key)) map.set(key, kind);
    }
  }
  return map;
}

// clusterId -> colour, only for clusters shared by at least two rendered nodes, assigned in
// order of first appearance so colours don't shuffle as nodes stream in.
export function clusterColors(nodes) {
  const counts = new Map();
  for (const n of nodes) if (n.clusterId != null) counts.set(n.clusterId, (counts.get(n.clusterId) || 0) + 1);
  const colors = new Map();
  for (const [id, count] of counts) {
    if (count >= 2) colors.set(id, CLUSTER_COLORS[colors.size % CLUSTER_COLORS.length]);
  }
  return colors;
}

function useContainerWidth(ref) {
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (el.clientWidth) setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

// Stable grid layout: nodes are placed in arrival order, so earlier boxes never move
// when new ones stream in (only when the container is resized).
export function layout(nodes, width) {
  const cols = Math.max(1, Math.floor((width + GAP_X) / (NODE_W + GAP_X)));
  const positions = new Map();
  nodes.forEach((node, i) => {
    const x = (i % cols) * (NODE_W + GAP_X);
    const y = Math.floor(i / cols) * (NODE_H + GAP_Y);
    positions.set(node.id, { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 });
  });
  const rows = Math.ceil(nodes.length / cols);
  return { positions, width: cols * (NODE_W + GAP_X) - GAP_X, height: Math.max(0, rows * (NODE_H + GAP_Y) - GAP_Y) };
}

// Only emits an edge when the imported file is already rendered.
export function buildEdges(nodes) {
  const byFile = new Map(nodes.map((n) => [normalize(n.file), n]));
  const edges = [];
  for (const node of nodes) {
    for (const imp of node.imports || []) {
      const target = byFile.get(normalize(imp));
      if (target && target.id !== node.id) edges.push({ id: `${node.id}->${target.id}`, from: node, to: target });
    }
  }
  return edges;
}

export default function GraphCanvas({ nodes: allNodes, highlights = new Map() }) {
  const nodes = allNodes.length > MAX_NODES ? allNodes.slice(0, MAX_NODES) : allNodes;
  const containerRef = useRef(null);
  const containerWidth = useContainerWidth(containerRef);
  const { positions, width, height } = layout(nodes, containerWidth);
  const edges = buildEdges(nodes);
  const clusters = clusterColors(nodes);
  const shownHighlights = Object.keys(HIGHLIGHTS).filter((kind) =>
    nodes.some((n) => highlights.get(normalize(n.file)) === kind)
  );

  return (
    <div className="graph-wrap">
      <div ref={containerRef} className="graph-canvas" style={{ height: height + GAP_Y / 2 }} data-testid="graph-canvas">
        <svg className="graph-edges" width={Math.max(width, 0)} height={height + GAP_Y / 2} aria-hidden="true">
          <defs>
            <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#6b6e82" />
            </marker>
          </defs>
          {edges.map(({ id, from, to }, i) => {
            const others = nodes.filter((n) => n.id !== from.id && n.id !== to.id).map((n) => positions.get(n.id));
            const lane = ((i % 5) - 2) * 5;
            const { d, routed } = routeEdge(positions.get(from.id), positions.get(to.id), others, lane);
            return (
              <path
                key={id}
                data-edge={id}
                data-routed={routed || undefined}
                className="graph-edge"
                d={d}
                fill="none"
                markerEnd="url(#graph-arrow)"
              />
            );
          })}
        </svg>
        {nodes.map((node) => {
          const p = positions.get(node.id);
          const color = COLORS[node.importance] || FALLBACK_COLOR;
          const stale = node.activity === "stale";
          // Importance sets the hue; activity sets the intensity (stale = faded, active = glow).
          const edgeColor = stale ? `${color}59` : color;
          const clusterColor = clusters.get(node.clusterId);
          const highlight = highlights.get(normalize(node.file));
          const details = [
            node.file,
            node.role,
            node.imports?.length ? `imports: ${node.imports.join(", ")}` : null,
            node.activity ? `activity: ${node.activity}` : null,
            node.authorCount != null ? `authors: ${node.authorCount}` : null,
            node.clusterId != null ? `cluster: ${node.clusterId}` : null,
            highlight ? `highlighted: ${HIGHLIGHTS[highlight].label}` : null,
          ];
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              data-activity={node.activity || undefined}
              data-cluster={clusterColor ? node.clusterId : undefined}
              data-highlight={highlight}
              className={[
                "graph-node",
                `importance-${node.importance}`,
                node.activity && `activity-${node.activity}`,
                highlight && `highlight highlight-${highlight}`,
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: p.x,
                top: p.y,
                width: NODE_W,
                height: NODE_H,
                borderColor: edgeColor,
                boxShadow: [
                  `inset 4px 0 0 ${edgeColor}`,
                  node.activity === "active" && `0 0 16px -4px ${color}`,
                ]
                  .filter(Boolean)
                  .join(", "),
                backgroundImage: clusterColor ? `linear-gradient(${clusterColor}1f, ${clusterColor}1f)` : undefined,
                "--hl": highlight ? HIGHLIGHTS[highlight].color : undefined,
              }}
              title={details.filter(Boolean).join("\n")}
            >
              {clusterColor && <span className="node-cluster-dot" style={{ background: clusterColor }} aria-hidden="true" />}
              <div className="node-file">{normalize(node.file)}</div>
              <div className="node-role">{node.role}</div>
            </div>
          );
        })}
      </div>
      {(shownHighlights.length > 0 || clusters.size > 0) && (
        <div className="graph-key">
          {shownHighlights.map((kind) => (
            <span key={kind} className={`graph-key-item highlight-${kind}`}>
              <span className="graph-key-ring" style={{ "--hl": HIGHLIGHTS[kind].color }} aria-hidden="true" />
              {HIGHLIGHTS[kind].label}
            </span>
          ))}
          {[...clusters].map(([id, c]) => (
            <span key={id} className="graph-key-item">
              <span className="graph-key-tint" style={{ background: c }} aria-hidden="true" />
              {id}
            </span>
          ))}
        </div>
      )}
      {allNodes.length > MAX_NODES && (
        <p className="graph-cap-note">Showing the first {MAX_NODES} of {allNodes.length} files.</p>
      )}
    </div>
  );
}
