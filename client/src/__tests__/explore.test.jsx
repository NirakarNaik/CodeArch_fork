import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, renderHook, act, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { useSSE } from "../hooks/useSSE.js";
import GraphCanvas, { buildEdges, buildHighlights, layout, routeEdge, MAX_NODES } from "../GraphCanvas.jsx";
import ExploreView, { DEMO_URL } from "../ExploreView.jsx";
import { createMockEventSource, FAKE_EVENTS } from "../mocks/mockEventSource.js";

const node = (id, file, imports = [], importance = "core") => ({ id, file, role: `role of ${file}`, imports, importance });
const ISSUE = { issue: "dead code", evidence: "nothing imports it", files: ["a.js"] };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSSE", () => {
  it("goes connecting -> streaming -> done, accumulating nodes and the issue", () => {
    const ES = createMockEventSource();
    const { result } = renderHook(() => useSSE("/stream/x", { EventSourceImpl: ES }));
    const src = ES.instances[0];

    expect(src.url).toBe("/stream/x");
    expect(result.current).toMatchObject({ nodes: [], issue: null, status: "connecting" });

    act(() => src.open());
    expect(result.current.status).toBe("streaming");

    act(() => src.emit("node", node("n1", "a.js")));
    act(() => src.emit("node", node("n2", "b.js", ["a.js"])));
    expect(result.current.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);

    act(() => src.emit("done", ISSUE));
    expect(result.current.status).toBe("done");
    expect(result.current.issue).toEqual(ISSUE);
    // Stays open for a trailing `direction` event; the server ending the stream closes it.
    expect(src.readyState).toBe(1);
    act(() => src.fail());
    expect(src.readyState).toBe(2);
    expect(result.current.status).toBe("done");
  });

  it("replaces a re-emitted node id instead of duplicating it", () => {
    const ES = createMockEventSource();
    const { result } = renderHook(() => useSSE("/s", { EventSourceImpl: ES }));
    const src = ES.instances[0];
    act(() => src.emit("node", node("n1", "a.js")));
    act(() => src.emit("node", { ...node("n1", "a.js"), role: "updated" }));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0].role).toBe("updated");
  });

  it("handles server error events and connection failures, closing the source", () => {
    const ES = createMockEventSource();
    const { result, rerender } = renderHook(({ url }) => useSSE(url, { EventSourceImpl: ES }), { initialProps: { url: "/a" } });
    act(() => ES.instances[0].emit("error", { message: "rate limited" }));
    expect(result.current).toMatchObject({ status: "error", errorMessage: "rate limited" });
    expect(ES.instances[0].readyState).toBe(2);

    rerender({ url: "/b" });
    expect(result.current.status).toBe("connecting");
    act(() => ES.instances[1].fail());
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toMatch(/failed/);
  });

  it("stays idle with a null url and resets + closes when the url changes", () => {
    const ES = createMockEventSource();
    const { result, rerender, unmount } = renderHook(({ url }) => useSSE(url, { EventSourceImpl: ES }), { initialProps: { url: null } });
    expect(ES.instances).toHaveLength(0);
    expect(result.current.status).toBe("connecting");

    rerender({ url: "/a" });
    act(() => ES.instances[0].emit("node", node("n1", "a.js")));
    rerender({ url: "/b" });
    expect(ES.instances[0].readyState).toBe(2);
    expect(result.current.nodes).toEqual([]);

    unmount();
    expect(ES.instances[1].readyState).toBe(2);
  });

  it("plays back the fake event array on timers", () => {
    vi.useFakeTimers();
    const ES = createMockEventSource({ events: FAKE_EVENTS });
    const { result } = renderHook(() => useSSE("/api/demo/replay", { EventSourceImpl: ES }));
    act(() => vi.advanceTimersByTime(10));
    expect(result.current.status).toBe("streaming");
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.nodes).toHaveLength(1);
    act(() => vi.runAllTimers());
    expect(result.current.nodes).toHaveLength(FAKE_EVENTS.filter((e) => e.type === "node").length);
    expect(result.current.status).toBe("done");
  });
});

describe("GraphCanvas", () => {
  const edgeIds = (container) => [...container.querySelectorAll("path[data-edge]")].map((l) => l.dataset.edge);

  it("renders a labeled box per node, colored by importance", () => {
    const { container } = render(
      <GraphCanvas nodes={[node("n1", "a.js", [], "core"), node("n2", "b.json", [], "config"), node("n3", "c.js", [], "support")]} />
    );
    expect(screen.getByText("a.js")).toBeTruthy();
    expect(screen.getByText("role of b.json")).toBeTruthy();
    const colors = [...container.querySelectorAll("[data-node-id]")].map((el) => el.style.borderColor);
    expect(new Set(colors).size).toBe(3);
  });

  it("only draws an import line once the imported file is rendered", () => {
    const a = node("n1", "src/a.js");
    const b = node("n2", "src/b.js", ["src/a.js", "./src/c.js", "lodash"]);
    const c = node("n3", "src/c.js");

    const { container, rerender } = render(<GraphCanvas nodes={[b]} />);
    expect(edgeIds(container)).toEqual([]);

    rerender(<GraphCanvas nodes={[b, a]} />);
    expect(edgeIds(container)).toEqual(["n2->n1"]);

    rerender(<GraphCanvas nodes={[b, a, c]} />);
    expect(edgeIds(container)).toEqual(["n2->n1", "n2->n3"]);
  });

  it("keeps existing nodes mounted (no re-fade) when new ones arrive", () => {
    const a = node("n1", "a.js");
    const { container, rerender } = render(<GraphCanvas nodes={[a]} />);
    const first = container.querySelector('[data-node-id="n1"]');
    rerender(<GraphCanvas nodes={[a, node("n2", "b.js")]} />);
    expect(container.querySelector('[data-node-id="n1"]')).toBe(first);
  });

  it("ignores self-imports", () => {
    expect(buildEdges([node("n1", "a.js", ["a.js"])])).toEqual([]);
  });

  it("keeps adjacent import lines straight but reroutes lines that would pass behind another box", () => {
    // 1000px wide -> 4 columns. n0..n3 fill row 0, n4 sits under n0, n8 under n4.
    const ns = Array.from({ length: 9 }, (_, i) => node(`n${i}`, `f${i}.js`));
    const { positions } = layout(ns, 1000);
    const others = (a, b) => ns.filter((n) => n.id !== a && n.id !== b).map((n) => positions.get(n.id));

    expect(routeEdge(positions.get("n1"), positions.get("n0"), others("n1", "n0")).routed).toBe(false);
    // Same row, skipping n1 and n2.
    expect(routeEdge(positions.get("n3"), positions.get("n0"), others("n3", "n0")).routed).toBe(true);
    // Same column, skipping n4.
    const vertical = routeEdge(positions.get("n8"), positions.get("n0"), others("n8", "n0"));
    expect(vertical.routed).toBe(true);
  });

  it("never draws an edge through a third box, for every pair in a 4x4 grid", () => {
    const ns = Array.from({ length: 16 }, (_, i) => node(`n${i}`, `f${i}.js`));
    const { positions } = layout(ns, 1000);
    const inside = (p, box) => p.x > box.x && p.x < box.x + 200 && p.y > box.y && p.y < box.y + 72;
    for (const a of ns) {
      for (const b of ns) {
        if (a === b) continue;
        const others = ns.filter((n) => n !== a && n !== b).map((n) => positions.get(n.id));
        for (const lane of [-10, 0, 10]) {
          const { d } = routeEdge(positions.get(a.id), positions.get(b.id), others, lane);
          const pts = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
          // Sample every segment (corner control points included) and require no sample inside another box.
          for (let i = 1; i < pts.length; i++) {
            for (let t = 0; t <= 1; t += 0.02) {
              const p = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
              const hit = others.find((box) => inside(p, box));
              if (hit) throw new Error(`${a.id}->${b.id} (lane ${lane}) crosses box at ${hit.x},${hit.y}: ${d}`);
            }
          }
        }
      }
    }
  });
});

describe("useSSE live-backend quirks", () => {
  it("merges a file re-emitted under a new random id instead of drawing a second box", () => {
    const ES = createMockEventSource();
    const { result } = renderHook(() => useSSE("/s", { EventSourceImpl: ES }));
    const src = ES.instances[0];
    act(() => src.emit("node", node("abc123", "src/a.js", [], "support")));
    act(() => src.emit("node", node("zzz999", "./src/a.js", ["src/b.js"], "core")));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.nodes[0]).toMatchObject({ id: "abc123", importance: "core", imports: ["src/b.js"] });
  });
});

describe("ExploreView", () => {
  // Assert on the view's phase, not Member 3's status wording (which changes with UI polish).
  const phase = () => document.querySelector(".explore-view").dataset.phase;

  beforeEach(() => {
    // IssueReveal scrolls itself into view; jsdom doesn't implement scrollIntoView.
    Element.prototype.scrollIntoView ||= () => {};
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: "s1", sseUrl: "/api/explore/stream/s1" }),
    });
  });

  it("goes cloning -> analyzing -> complete and renders nodes live from the real stream", async () => {
    const ES = createMockEventSource();
    render(<ExploreView repoUrl="https://github.com/o/r" onReset={() => {}} EventSourceImpl={ES} />);
    expect(phase()).toBe("starting");

    await act(async () => {});
    const src = ES.instances.at(-1);
    expect(src.url).toBe("/api/explore/stream/s1");

    act(() => src.open());
    act(() => src.emit("node", node("n1", "src/index.js")));
    expect(phase()).toBe("streaming");
    expect(document.querySelector('[data-node-id="n1"]').textContent).toContain("src/index.js");

    act(() => src.emit("done", ISSUE));
    expect(phase()).toBe("done");
  });

  it("clones only once under StrictMode's double effect run", async () => {
    const ES = createMockEventSource();
    render(
      <StrictMode>
        <ExploreView repoUrl="https://github.com/o/r" onReset={() => {}} EventSourceImpl={ES} />
      </StrictMode>
    );
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ES.instances.at(-1).url).toBe("/api/explore/stream/s1");
  });

  it("'Run demo instead' switches from the live stream to /api/demo/replay and shows the demo badge", async () => {
    const ES = createMockEventSource();
    render(<ExploreView repoUrl="https://github.com/o/r" onReset={() => {}} EventSourceImpl={ES} />);
    await act(async () => {});
    const live = ES.instances.at(-1);
    expect(live.url).toBe("/api/explore/stream/s1");

    fireEvent.click(screen.getByRole("button", { name: "Run demo instead" }));
    expect(ES.instances.at(-1).url).toMatch(new RegExp(`^${DEMO_URL}`));
    expect(live.readyState).toBe(2);
    expect(screen.getByText("Demo replay")).toBeTruthy();
  });

  it("starts straight in demo mode from the landing page's demo button and can replay", () => {
    const ES = createMockEventSource();
    render(<ExploreView repoUrl={null} demo onReset={() => {}} EventSourceImpl={ES} />);
    expect(fetch).not.toHaveBeenCalled();
    const first = ES.instances.at(-1);
    expect(first.url).toBe(DEMO_URL);

    act(() => first.emit("done", ISSUE));
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(first.readyState).toBe(2);
    expect(ES.instances.at(-1).url).toBe(`${DEMO_URL}?run=1`);
  });

  it("surfaces a failed clone with the matching error copy instead of spinning", async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "clone_failed" }) });
    render(<ExploreView repoUrl="https://github.com/o/r" onReset={() => {}} EventSourceImpl={createMockEventSource()} />);
    await act(async () => {});
    expect(phase()).toBe("error");
    expect(screen.getByRole("button", { name: /Try demo/ })).toBeTruthy();
  });
});

describe("direction event, activity, clusters, highlights", () => {
  const rich = (id, file, extra = {}) => ({ ...node(id, file), activity: "active", authorCount: 1, clusterId: null, ...extra });
  // Shaped like ProjectDirection in shared/types.ts.
  const DIRECTION = {
    direction: "Work is concentrated in src/a.js and src/b.js.",
    staleFiles: ["src/old.js"],
    activeClusters: [{ files: ["src/a.js", "src/b.js"], authorCount: 3 }],
  };

  it("useSSE exposes a direction that arrives after done, and resets it on a new url", () => {
    const ES = createMockEventSource();
    const { result, rerender } = renderHook(({ url }) => useSSE(url, { EventSourceImpl: ES }), { initialProps: { url: "/a" } });
    expect(result.current.direction).toBeNull();
    const src = ES.instances[0];
    act(() => src.emit("node", rich("n1", "src/a.js")));
    act(() => src.emit("done", ISSUE));
    act(() => src.emit("direction", DIRECTION));
    expect(result.current.direction).toEqual(DIRECTION);
    expect(result.current.status).toBe("done");

    rerender({ url: "/b" });
    expect(result.current.direction).toBeNull();
  });

  it("useSSE ignores a malformed direction payload but still closes on it", () => {
    const ES = createMockEventSource();
    const { result } = renderHook(() => useSSE("/a", { EventSourceImpl: ES }));
    act(() => ES.instances[0].emit("done", ISSUE));
    act(() => ES.instances[0].emit("direction", "not json {"));
    expect(result.current.direction).toBeNull();
    expect(ES.instances[0].readyState).toBe(2);
    expect(result.current.status).toBe("done");
  });

  it("useSSE keeps the stream open after done however long direction takes, then closes on direction", () => {
    vi.useFakeTimers();
    const ES = createMockEventSource();
    const { result } = renderHook(() => useSSE("/a", { EventSourceImpl: ES }));
    act(() => ES.instances[0].emit("done", ISSUE));
    act(() => vi.advanceTimersByTime(60_000)); // direction may need its own Claude call
    expect(ES.instances[0].readyState).not.toBe(2);
    act(() => ES.instances[0].emit("direction", DIRECTION));
    expect(result.current.direction).toEqual(DIRECTION);
    expect(ES.instances[0].readyState).toBe(2);
  });

  it("renders stale nodes dimmed and active nodes with a glow, keeping the importance hue", () => {
    const { container } = render(
      <GraphCanvas
        nodes={[
          rich("n1", "a.js", { importance: "core", activity: "active" }),
          rich("n2", "b.js", { importance: "core", activity: "stale" }),
          node("n3", "c.js", [], "core"), // no activity field: plain rendering
        ]}
      />
    );
    const [active, stale, plain] = ["n1", "n2", "n3"].map((id) => container.querySelector(`[data-node-id="${id}"]`));
    expect(active.className).toContain("activity-active");
    expect(active.style.boxShadow).toContain("16px");
    expect(stale.className).toContain("activity-stale");
    expect(stale.style.boxShadow).not.toContain("16px");
    // Same hue (core blue) for both; stale is the translucent variant.
    expect(active.style.borderColor).toBe("rgb(94, 200, 248)");
    expect(stale.style.borderColor).toMatch(/^rgba\(94, 200, 248, 0\.3/);
    expect(plain.dataset.activity).toBeUndefined();
  });

  it("gives nodes sharing a clusterId the same tint + dot, and leaves singletons/null alone", () => {
    const { container } = render(
      <GraphCanvas
        nodes={[
          rich("n1", "a.js", { clusterId: "http" }),
          rich("n2", "b.js", { clusterId: "http" }),
          rich("n3", "c.js", { clusterId: "data" }),
          rich("n4", "d.js", { clusterId: "data" }),
          rich("n5", "e.js", { clusterId: "solo" }),
          rich("n6", "f.js"),
        ]}
      />
    );
    const q = (id) => container.querySelector(`[data-node-id="${id}"]`);
    expect(q("n1").style.backgroundImage).toBe(q("n2").style.backgroundImage);
    expect(q("n1").style.backgroundImage).not.toBe(q("n3").style.backgroundImage);
    expect(q("n3").style.backgroundImage).toBe(q("n4").style.backgroundImage);
    expect(q("n1").querySelector(".node-cluster-dot")).toBeTruthy();
    for (const id of ["n5", "n6"]) {
      expect(q(id).style.backgroundImage).toBe("");
      expect(q(id).querySelector(".node-cluster-dot")).toBeNull();
    }
    expect(screen.getByText("http")).toBeTruthy(); // key entry per cluster
  });

  it("caps rendering at 25 nodes and only draws edges between rendered ones", () => {
    const ns = Array.from({ length: 30 }, (_, i) => rich(`n${i}`, `f${i}.js`, { imports: i === 0 ? ["f29.js"] : i === 1 ? ["f0.js"] : [] }));
    const { container } = render(<GraphCanvas nodes={ns} />);
    expect(MAX_NODES).toBe(25);
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(25);
    expect(container.querySelector('[data-node-id="n25"]')).toBeNull();
    const edges = [...container.querySelectorAll("path[data-edge]")].map((p) => p.dataset.edge);
    expect(edges).toEqual(["n1->n0"]); // n0 -> f29.js dropped: f29 isn't rendered
    expect(screen.getByText("Showing the first 25 of 30 files.")).toBeTruthy();
  });

  it("buildHighlights merges flagged/stale/active with flagged winning, normalizing paths", () => {
    const h = buildHighlights({ flagged: ["./x.js"], stale: ["x.js", "y.js", 42], active: ["y.js", "z.js"] });
    expect(Object.fromEntries(h)).toEqual({ "x.js": "flagged", "y.js": "stale", "z.js": "active" });
    expect(buildHighlights({ stale: "not-an-array" }).size).toBe(0);
  });

  it("ExploreView highlights flagged, stale and active-cluster files once done + direction arrive", async () => {
    Element.prototype.scrollIntoView ||= () => {};
    const ES = createMockEventSource();
    render(<ExploreView repoUrl={null} demo onReset={() => {}} EventSourceImpl={ES} />);
    const src = ES.instances.at(-1);
    act(() => {
      src.open();
      src.emit("node", rich("n1", "src/a.js", { clusterId: "http" }));
      src.emit("node", rich("n2", "src/b.js", { clusterId: "http" }));
      src.emit("node", rich("n3", "src/old.js", { activity: "stale" }));
      src.emit("node", rich("n4", "src/bug.js"));
      src.emit("node", rich("n5", "src/plain.js"));
    });
    const hl = (id) => document.querySelector(`[data-node-id="${id}"]`).dataset.highlight;
    expect(["n1", "n2", "n3", "n4", "n5"].map(hl)).toEqual([undefined, undefined, undefined, undefined, undefined]);

    act(() => src.emit("done", { issue: "bug", evidence: "e", files: ["src/bug.js"] }));
    expect(hl("n4")).toBe("flagged");

    act(() => src.emit("direction", DIRECTION));
    expect(["n1", "n2", "n3", "n4", "n5"].map(hl)).toEqual(["active", "active", "stale", "flagged", undefined]);
    expect(document.querySelector('[data-node-id="n3"]').className).toContain("highlight-stale");
    expect(screen.getByText("Flagged issue")).toBeTruthy();
    expect(screen.getByText("Active cluster")).toBeTruthy();
  });
});
