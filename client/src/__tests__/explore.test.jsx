import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, renderHook, act, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { useSSE } from "../hooks/useSSE.js";
import { buildHighlights } from "../GraphCanvas.jsx";
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
    expect(document.querySelector('[data-node-id="n1"]').dataset.file).toBe("src/index.js");

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
    expect(document.querySelector('[data-node-id="n3"]').classList.contains("highlight-stale")).toBe(true);
    expect(screen.getByText("Flagged issue")).toBeTruthy();
    expect(screen.getByText("Active cluster")).toBeTruthy();
  });
});
