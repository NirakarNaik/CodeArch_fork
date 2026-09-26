import { useEffect, useRef, useState } from "react";
import "./graph.css";

export const COLORS = { core: "#5ec8f8", support: "#8f8fd6", config: "#f5b942" };
const FALLBACK_COLOR = "#888";

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

export default function GraphCanvas({ nodes }) {
  const containerRef = useRef(null);
  const containerWidth = useContainerWidth(containerRef);
  const { positions, width, height } = layout(nodes, containerWidth);
  const edges = buildEdges(nodes);

  return (
    <div className="graph-wrap">
      <div className="graph-legend">
        {Object.entries(COLORS).map(([kind, color]) => (
          <span key={kind} className="legend-item">
            <span className="legend-swatch" style={{ background: color }} />
            {kind}
          </span>
        ))}
      </div>
      <div ref={containerRef} className="graph-canvas" style={{ height }} data-testid="graph-canvas">
        <svg className="graph-edges" width={Math.max(width, 0)} height={height} aria-hidden="true">
          <defs>
            <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#6b6e82" />
            </marker>
          </defs>
          {edges.map(({ id, from, to }) => {
            const a = positions.get(from.id);
            const b = positions.get(to.id);
            const start = edgePoint({ x: b.cx, y: b.cy }, { x: a.cx, y: a.cy });
            const end = edgePoint({ x: a.cx, y: a.cy }, { x: b.cx, y: b.cy });
            return (
              <line
                key={id}
                data-edge={id}
                className="graph-edge"
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                markerEnd="url(#graph-arrow)"
              />
            );
          })}
        </svg>
        {nodes.map((node) => {
          const p = positions.get(node.id);
          const color = COLORS[node.importance] || FALLBACK_COLOR;
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              className={`graph-node importance-${node.importance}`}
              style={{
                left: p.x,
                top: p.y,
                width: NODE_W,
                height: NODE_H,
                borderColor: color,
                boxShadow: `inset 4px 0 0 ${color}`,
              }}
              title={`${node.file}\n${node.role}${node.imports?.length ? `\nimports: ${node.imports.join(", ")}` : ""}`}
            >
              <div className="node-file">{node.file}</div>
              <div className="node-role">{node.role}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
