import { createRef } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, act, cleanup, screen } from "@testing-library/react";
import GraphCanvas, {
  COLORS,
  MAX_NODES,
  RING_STEP,
  buildEdges,
  createLayout,
  edgePath,
  extendLayout,
  fanInCounts,
  nodeRadius,
  ringCapacity,
} from "../GraphCanvas.jsx";
import { SCENARIOS, n } from "../mocks/scenarios.js";

afterEach(cleanup);

const nodesOf = (name) => SCENARIOS[name].filter((e) => e.type === "node").map((e) => e.data);
const el = (container, file) => container.querySelector(`[data-file="${file}"]`);
const pos = (g) => {
  const [, x, y] = g.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/);
  return { x: +x, y: +y };
};
const radiusOf = (g) => +g.querySelector(".gnode-dot").getAttribute("r");
const dist = (p) => Math.hypot(p.x, p.y);
const minGap = (nodes, layout) => {
  const fan = fanInCounts(nodes);
  let gap = Infinity;
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = layout.positions.get(nodes[i].id);
      const b = layout.positions.get(nodes[j].id);
      gap = Math.min(gap, Math.hypot(a.x - b.x, a.y - b.y) - nodeRadius(nodes[i], fan.get(nodes[i].id)) - nodeRadius(nodes[j], fan.get(nodes[j].id)));
    }
  return gap;
};

describe("radial layout", () => {
  it("puts the first node at the centre and rings nodes at 120px x BFS depth", () => {
    const nodes = [
      n("index.js", { importance: "core", imports: ["app.js"] }),
      n("app.js", { imports: ["db.js"] }), // imported by root -> depth 1
      n("db.js"), // imported by a depth-1 node -> depth 2
      n("orphan.js"), // no relationship -> depth 1
    ];
    const layout = extendLayout(createLayout(), nodes);
    const at = (f) => layout.positions.get(`n:${f}`);
    expect(at("index.js")).toMatchObject({ x: 0, y: 0, depth: 0 });
    expect(at("app.js").depth).toBe(1);
    expect(dist(at("app.js"))).toBeCloseTo(RING_STEP, 0);
    expect(at("db.js").depth).toBe(2);
    expect(dist(at("db.js"))).toBeCloseTo(2 * RING_STEP, 0);
    expect(at("orphan.js").depth).toBe(1);
    expect(dist(at("orphan.js"))).toBeCloseTo(RING_STEP, 0);
  });

  it("traces relationships in either direction (a later node that imports an earlier one)", () => {
    const layout = extendLayout(createLayout(), [n("index.js"), n("uses-index.js", { imports: ["index.js"] })]);
    expect(layout.positions.get("n:uses-index.js").depth).toBe(1);
  });

  it("spaces a full ring evenly (8 slots at r=120 -> 45 degrees apart)", () => {
    expect(ringCapacity(120)).toBe(8);
    const nodes = [n("root.js"), ...Array.from({ length: 8 }, (_, i) => n(`d1-${i}.js`))];
    const layout = extendLayout(createLayout(), nodes);
    const angles = nodes
      .slice(1)
      .map((x) => layout.positions.get(x.id))
      .map((p) => (Math.atan2(p.y, p.x) * 180) / Math.PI)
      .map((a) => (a + 360) % 360)
      .sort((a, b) => a - b);
    const gaps = angles.map((a, i) => (i ? a - angles[i - 1] : a + 360 - angles.at(-1)));
    for (const g of gaps) expect(g).toBeCloseTo(45, 0);
  });

  it("never moves a placed node as more nodes stream in, or when a node is re-emitted", () => {
    const all = nodesOf("realistic18");
    const { container, rerender } = render(<GraphCanvas nodes={all.slice(0, 5)} />);
    const before = Object.fromEntries(all.slice(0, 5).map((x) => [x.id, el(container, x.file).getAttribute("transform")]));
    rerender(<GraphCanvas nodes={all} />);
    rerender(<GraphCanvas nodes={[{ ...all[2], role: "updated" }, ...all.slice(0, 2), ...all.slice(3)].sort((a, b) => all.indexOf(all.find((x) => x.id === a.id)) - all.indexOf(all.find((x) => x.id === b.id)))} />);
    for (const x of all.slice(0, 5)) expect(el(container, x.file).getAttribute("transform")).toBe(before[x.id]);
  });

  it("overflows a crowded ring onto a larger radius instead of overlapping", () => {
    const nodes = [n("root.js"), ...Array.from({ length: 12 }, (_, i) => n(`d1-${i}.js`))];
    const layout = extendLayout(createLayout(), nodes);
    const radii = nodes.slice(1).map((x) => Math.round(dist(layout.positions.get(x.id))));
    expect(radii.filter((r) => r === 120)).toHaveLength(8);
    expect(radii.filter((r) => r === 180)).toHaveLength(4);
    expect(minGap(nodes, layout)).toBeGreaterThan(8);
  });

  it("keeps 25 nodes readable (no overlaps) for realistic, flood and fully-connected streams", () => {
    for (const name of ["realistic18", "flood", "dense25"]) {
      const nodes = nodesOf(name).slice(0, MAX_NODES);
      const layout = extendLayout(createLayout(), nodes);
      expect(minGap(nodes, layout)).toBeGreaterThan(8);
    }
  });

  it("starts a fresh layout when a new run's first node differs", () => {
    const first = extendLayout(createLayout(), [n("a.js"), n("b.js")]);
    const second = extendLayout(first, [n("x.js"), n("y.js")]);
    expect(second.positions.has("n:a.js")).toBe(false);
    expect(second.positions.get("n:x.js")).toMatchObject({ x: 0, y: 0 });
  });
});

describe("node styling", () => {
  it("fills and sizes by importance; config is dimmer; core glows (class hook)", () => {
    const { container } = render(
      <GraphCanvas nodes={[n("core.js", { importance: "core" }), n("support.js", { importance: "support" }), n("config.json", { importance: "config" })]} />
    );
    const dot = (f) => el(container, f).querySelector(".gnode-dot");
    expect(dot("core.js").getAttribute("fill")).toBe(COLORS.core);
    expect(COLORS).toEqual({ core: "#f0a500", support: "#6b8cae", config: "#4a4f57" });
    expect(dot("core.js").getAttribute("r")).toBe("14");
    expect(dot("support.js").getAttribute("r")).toBe("10");
    expect(dot("config.json").getAttribute("r")).toBe("8");
    expect(el(container, "core.js").classList.contains("importance-core")).toBe(true);
    expect(el(container, "config.json").classList.contains("importance-config")).toBe(true);
  });

  it("grows with fan-in: base + min(fanIn * 1.5, 10)", () => {
    const hub = n("hub.js", { importance: "core" });
    const importers = (k) => Array.from({ length: k }, (_, i) => n(`i${i}.js`, { imports: ["hub.js"] }));
    let r = render(<GraphCanvas nodes={[hub, ...importers(4)]} />);
    expect(radiusOf(el(r.container, "hub.js"))).toBe(14 + 6);
    cleanup();
    r = render(<GraphCanvas nodes={[hub, ...importers(12)]} />);
    expect(radiusOf(el(r.container, "hub.js"))).toBe(24); // capped at +10
  });

  it("in the realistic graph the core hub is the largest node", () => {
    const { container } = render(<GraphCanvas nodes={nodesOf("realistic18")} />);
    const all = [...container.querySelectorAll("[data-file]")];
    const biggest = all.reduce((a, b) => (radiusOf(b) > radiusOf(a) ? b : a));
    expect(biggest.dataset.file).toBe("src/app.js");
  });

  it("labels each node with its basename (full path kept in the tooltip)", () => {
    const { container } = render(<GraphCanvas nodes={[n("src/deep/path/userService.js")]} />);
    const g = el(container, "src/deep/path/userService.js");
    expect(g.querySelector(".gnode-label").textContent).toBe("userService.js");
    expect(g.querySelector("title").textContent).toContain("src/deep/path/userService.js");
  });
});

describe("edges", () => {
  it("are quadratic curves clipped to both circles, with an arrowhead, only once both ends exist", () => {
    const a = n("a.js", { imports: ["b.js"] });
    const b = n("b.js");
    const { container, rerender } = render(<GraphCanvas nodes={[a]} />);
    expect(container.querySelectorAll("path[data-edge]")).toHaveLength(0);
    rerender(<GraphCanvas nodes={[a, b]} />);
    const p = container.querySelector("path[data-edge]");
    expect(p.getAttribute("d")).toMatch(/^M[-\d.]+,[-\d.]+ Q[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+$/);
    expect(p.classList.contains("edge")).toBe(true);
    expect(p.getAttribute("marker-end")).toMatch(/^url\(#graph-arrow-/);
    expect(Number(p.style.getPropertyValue("--len"))).toBeGreaterThan(0);
  });

  it("edgePath curves off the straight line and starts/ends on the circle boundaries", () => {
    const { d } = edgePath({ x: 0, y: 0 }, { x: 200, y: 0 }, 14, 10);
    const [s, c, e] = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
    expect(Math.abs(c.y)).toBeGreaterThan(10); // bowed
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(14, 0);
    expect(Math.hypot(e.x - 200, e.y)).toBeCloseTo(13, 0); // radius + 3 for the arrowhead
    // A->B and B->A bow to opposite sides, so cycles don't overlap
    const back = edgePath({ x: 200, y: 0 }, { x: 0, y: 0 }, 10, 14).d.match(/Q[-\d.]+,(-?[\d.]+)/)[1];
    expect(Math.sign(+back)).toBe(-Math.sign(c.y));
  });

  it("highlightedFiles marks every edge touching those files, with the amber arrowhead", () => {
    const nodes = [n("a.js", { imports: ["b.js"] }), n("b.js", { imports: ["c.js"] }), n("c.js"), n("d.js", { imports: ["c.js"] })];
    const { container } = render(<GraphCanvas nodes={nodes} highlightedFiles={["./b.js"]} />);
    const hl = [...container.querySelectorAll("path.edge.highlighted")].map((p) => p.dataset.edge).sort();
    expect(hl).toEqual(["n:a.js->n:b.js", "n:b.js->n:c.js"]);
    expect(container.querySelector('path[data-edge="n:d.js->n:c.js"]').classList.contains("highlighted")).toBe(false);
    expect(container.querySelector("path.edge.highlighted").getAttribute("marker-end")).toMatch(/-hl\)$/);
  });

  it("dedupes duplicate imports and ignores self-imports", () => {
    expect(buildEdges([n("a.js", { imports: ["b.js", "./b.js", "a.js"] }), n("b.js")]).map((e) => e.id)).toEqual(["n:a.js->n:b.js"]);
  });
});

describe("focusNode", () => {
  const nodes = [n("index.js", { importance: "core", imports: ["svc.js"] }), n("svc.js", { imports: ["db.js"] }), n("db.js"), n("other.js")];

  it("via ref: highlights the file's edges and pulses its node once per call", () => {
    const ref = createRef();
    const { container } = render(<GraphCanvas ref={ref} nodes={nodes} />);
    expect(container.querySelectorAll("path.edge.highlighted")).toHaveLength(0);
    act(() => ref.current.focusNode("svc.js"));
    const g = el(container, "svc.js");
    expect(g.classList.contains("is-focused")).toBe(true);
    expect(g.querySelector(".gnode-pulse").classList.contains("pulse-a")).toBe(true);
    expect([...container.querySelectorAll("path.edge.highlighted")].map((p) => p.dataset.edge).sort()).toEqual(["n:index.js->n:svc.js", "n:svc.js->n:db.js"]);
    act(() => ref.current.focusNode(["./svc.js"])); // second call replays the pulse
    expect(g.querySelector(".gnode-pulse").classList.contains("pulse-b")).toBe(true);
    expect(el(container, "other.js").classList.contains("is-focused")).toBe(false);
    screen.getByText("Highlighted path");
  });

  it("automatically focuses flagged-issue files arriving through the highlights prop", () => {
    const { container, rerender } = render(<GraphCanvas nodes={nodes} />);
    rerender(<GraphCanvas nodes={nodes} highlights={new Map([["db.js", "flagged"]])} />);
    expect(el(container, "db.js").classList.contains("is-focused")).toBe(true);
    expect(el(container, "db.js").querySelector(".gnode-pulse").classList.contains("pulse-a")).toBe(true);
    expect(container.querySelector('path[data-edge="n:svc.js->n:db.js"]').classList.contains("highlighted")).toBe(true);
  });

  it("clears focus when a new run starts", () => {
    const ref = createRef();
    const { container, rerender } = render(<GraphCanvas ref={ref} nodes={nodes} />);
    act(() => ref.current.focusNode("svc.js"));
    rerender(<GraphCanvas ref={ref} nodes={[n("fresh.js"), n("svc.js")]} />);
    expect(el(container, "svc.js").classList.contains("is-focused")).toBe(false);
  });

  it("ignores unknown files and non-strings", () => {
    const ref = createRef();
    const { container } = render(<GraphCanvas ref={ref} nodes={nodes} />);
    act(() => ref.current.focusNode(["nope.js", 42, null]));
    expect(container.querySelectorAll(".is-focused")).toHaveLength(0);
  });
});

describe("carried-over features", () => {
  it("stale nodes get the dimming class; shared clusters get a matching dot; 25-node cap with note", () => {
    const nodes = [
      n("a.js", { activity: "stale", clusterId: "root#1" }),
      n("b.js", { clusterId: "root#1" }),
      n("c.js", { clusterId: "solo#1" }),
      ...Array.from({ length: 30 }, (_, i) => n(`x${i}.js`)),
    ];
    const { container } = render(<GraphCanvas nodes={nodes} />);
    expect(el(container, "a.js").classList.contains("activity-stale")).toBe(true);
    const dot = (f) => el(container, f).querySelector(".node-cluster-dot");
    expect(dot("a.js").getAttribute("fill")).toBe(dot("b.js").getAttribute("fill"));
    expect(dot("c.js")).toBeNull();
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(MAX_NODES);
    screen.getByText("Showing the first 25 of 33 files.");
  });
});
