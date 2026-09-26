import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, renderHook, act, screen, fireEvent, cleanup } from "@testing-library/react";
import { useSSE } from "../hooks/useSSE.js";
import GraphCanvas, { buildEdges, layout, routeEdge } from "../GraphCanvas.jsx";
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
    expect(src.readyState).toBe(2);
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
    expect(result.current.nodes).toHaveLength(FAKE_EVENTS.length - 1);
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
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: "s1", sseUrl: "/api/explore/stream/s1" }),
    });
  });

  it("shows cloning -> exploring -> done and renders nodes live from the real stream", async () => {
    const ES = createMockEventSource();
    render(<ExploreView repoUrl="https://github.com/o/r" onReset={() => {}} EventSourceImpl={ES} />);
    expect(screen.getByRole("status").textContent).toMatch(/Cloning/);

    await act(async () => {});
    const src = ES.instances.at(-1);
    expect(src.url).toBe("/api/explore/stream/s1");
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => src.open());
    expect(screen.getByRole("status").textContent).toMatch(/Exploring/);
    act(() => src.emit("node", node("n1", "src/index.js")));
    expect(screen.getByText("src/index.js")).toBeTruthy();

    act(() => src.emit("done", ISSUE));
    expect(screen.getByRole("status").textContent).toBe("Done — 1 file mapped");
  });

  it("Demo Mode toggle switches the stream between the real URL and /api/demo/replay", async () => {
    const ES = createMockEventSource();
    render(<ExploreView repoUrl="https://github.com/o/r" onReset={() => {}} EventSourceImpl={ES} />);
    await act(async () => {});
    expect(ES.instances.at(-1).url).toBe("/api/explore/stream/s1");

    const toggle = screen.getByLabelText("Demo Mode");
    fireEvent.click(toggle);
    const demo = ES.instances.at(-1);
    expect(demo.url).toBe(DEMO_URL);
    expect(ES.instances.at(-2).readyState).toBe(2);

    fireEvent.click(toggle);
    await act(async () => {});
    expect(ES.instances.at(-1).url).toBe("/api/explore/stream/s1");
    expect(demo.readyState).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1); // session reused, no second clone
  });

  it("surfaces a failed clone instead of spinning on 'Cloning'", async () => {
    fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "clone_failed" }) });
    render(<ExploreView repoUrl="https://github.com/o/r" onReset={() => {}} EventSourceImpl={createMockEventSource()} />);
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toMatch(/Could not clone.*Demo Mode/);
  });
});
