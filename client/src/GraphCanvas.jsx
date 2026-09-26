const COLORS = { core: "#5ec8f8", support: "#8f8fd6", config: "#f5b942" };
const COLS = 4;

export default function GraphCanvas({ nodes }) {
  return (
    <div className="graph-canvas">
      {nodes.map((node, i) => (
        <div
          key={node.id}
          className="graph-node"
          style={{
            gridColumn: (i % COLS) + 1,
            gridRow: Math.floor(i / COLS) + 1,
            borderColor: COLORS[node.importance] || "#888",
          }}
          title={node.imports.length ? `imports: ${node.imports.join(", ")}` : undefined}
        >
          <div className="node-file">{node.file}</div>
          <div className="node-role">{node.role}</div>
        </div>
      ))}
    </div>
  );
}
