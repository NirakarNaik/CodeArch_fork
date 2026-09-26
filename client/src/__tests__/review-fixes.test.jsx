// Post-review fix pass: commitDepth, automatic switch to the recorded run, layered
// active-cluster highlight, readable cluster labels.
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from "vitest";
import { render, act, cleanup, screen } from "@testing-library/react";
import ExploreView, { DEMO_URL, STALL_MS } from "../ExploreView.jsx";
import GraphCanvas, { buildHighlights, clusterLabel } from "../GraphCanvas.jsx";
import { createMockEventSource } from "../mocks/mockEventSource.js";
import { n } from "../mocks/scenarios.js";

beforeAll(() => {
  Element.prototype.scrollIntoView ||= () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const REPO = "https://github.com/expressjs/session";
const LIVE_URL = "/api/explore/stream/s1";
const ISSUE = { issue: "x", evidence: "y", files: ["index.js"] };
const phase = () => document.querySelector(".explore-view").dataset.phase;
const notice = () => document.querySelector(".auto-switch-notice");

function mockStart() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ sessionId: "s1", sseUrl: LIVE_URL }) });
}

// Mounts a live run and resolves the /start request, returning the live EventSource.
async function startLive(props = {}) {
  const ES = createMockEventSource();
  render(<ExploreView repoUrl={REPO} onReset={() => {}} EventSourceImpl={ES} {...props} />);
  await act(async () => {});
  const live = ES.instances.at(-1);
  expect(live.url).toBe(LIVE_URL);
  return { ES, live };
}

describe("1. commitDepth", () => {
  beforeEach(() => {
    mockStart();
  });

  it("omits commitDepth from the payload when the prop is not set (server default applies)", async () => {
    await startLive();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ repoUrl: REPO });
    cleanup();
    fetch.mockClear();
    await startLive({ commitDepth: null });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ repoUrl: REPO });
  });

  it("sends commitDepth when set", async () => {
    await startLive({ commitDepth: 40 });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ repoUrl: REPO, commitDepth: 40 });
  });
});

describe("2. automatic switch to the recorded run", () => {
  beforeEach(() => {
    mockStart();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("switches after 30s with no event, closes the stalled stream, and shows the notice", async () => {
    const { ES, live } = await startLive();
    act(() => live.open());
    act(() => vi.advanceTimersByTime(STALL_MS - 100));
    expect(notice()).toBeNull();
    expect(ES.instances.at(-1)).toBe(live);

    act(() => vi.advanceTimersByTime(100));
    expect(live.readyState).toBe(2); // stalled live stream closed (server aborts the run)
    expect(ES.instances.at(-1).url).toMatch(new RegExp(`^${DEMO_URL}`));
    expect(notice().textContent).toMatch(/Switched to a recorded run/);
    expect(notice().textContent).toMatch(/30 seconds without any progress/);
    expect(notice().getAttribute("role")).toBe("alert");
    expect(screen.getByText("Demo replay")).toBeTruthy(); // ExploreStatus badge also on
    // the single-use live session is never reopened during the switch
    expect(ES.instances.filter((s) => s.url === LIVE_URL)).toHaveLength(1);
  });

  it("does not false-trigger on normal pacing: every event resets the 30s timer", async () => {
    const { live } = await startLive();
    act(() => live.open());
    act(() => vi.advanceTimersByTime(18_000)); // first node after 18s (normal)
    act(() => live.emit("node", n("index.js")));
    for (let i = 0; i < 4; i++) {
      act(() => vi.advanceTimersByTime(15_000)); // 15s gaps while Claude reasons
      act(() => live.emit("node", n(`f${i}.js`)));
    }
    act(() => vi.advanceTimersByTime(25_000));
    expect(notice()).toBeNull();
    expect(live.readyState).not.toBe(2);
  });

  it("also switches if direction takes more than 30s after done (agreed behaviour)", async () => {
    const { ES, live } = await startLive();
    act(() => {
      live.open();
      live.emit("node", n("index.js"));
      live.emit("done", ISSUE);
    });
    act(() => vi.advanceTimersByTime(STALL_MS));
    expect(ES.instances.at(-1).url).toMatch(new RegExp(`^${DEMO_URL}`));
    expect(notice()).toBeTruthy();
  });

  it("stops the timer once direction arrives (a finished run never switches)", async () => {
    const { ES, live } = await startLive();
    act(() => {
      live.open();
      live.emit("node", n("index.js"));
      live.emit("done", ISSUE);
      live.emit("direction", { direction: "d", staleFiles: [], activeClusters: [] });
    });
    act(() => vi.advanceTimersByTime(STALL_MS * 3));
    expect(ES.instances.at(-1)).toBe(live);
    expect(notice()).toBeNull();
    expect(phase()).toBe("done");
  });

  it("switches automatically on a mid-run stream error (server error event)", async () => {
    const { ES, live } = await startLive();
    act(() => {
      live.open();
      live.emit("node", n("index.js"));
      live.emit("error", { message: "Exploration failed: boom" });
    });
    expect(ES.instances.at(-1).url).toMatch(new RegExp(`^${DEMO_URL}`));
    expect(notice().dataset.reason).toBe("error");
    expect(notice().textContent).toMatch(/lost its connection/);
    expect(ES.instances.filter((s) => s.url === LIVE_URL)).toHaveLength(1);
  });

  it("switches automatically when the connection drops mid-run", async () => {
    const { ES, live } = await startLive();
    act(() => {
      live.open();
      live.emit("node", n("index.js"));
      live.fail();
    });
    expect(ES.instances.at(-1).url).toMatch(new RegExp(`^${DEMO_URL}`));
    expect(notice().dataset.reason).toBe("error");
  });

  it("keeps the notice for the rest of the view, including across Replay", async () => {
    const { ES, live } = await startLive();
    act(() => live.fail());
    const demo = ES.instances.at(-1);
    act(() => {
      demo.open();
      demo.emit("done", ISSUE);
    });
    act(() => screen.getByRole("button", { name: /^Replay$/ }).click());
    expect(ES.instances.at(-1).url).toBe(`${DEMO_URL}?run=2`);
    expect(notice()).toBeTruthy();
  });

  it("never runs a stall timer on the recorded replay itself", async () => {
    const ES = createMockEventSource();
    render(<ExploreView repoUrl={null} demo onReset={() => {}} EventSourceImpl={ES} />);
    const demo = ES.instances.at(-1);
    act(() => demo.open());
    act(() => vi.advanceTimersByTime(STALL_MS * 3));
    expect(ES.instances).toHaveLength(1);
    expect(demo.readyState).not.toBe(2);
    expect(notice()).toBeNull();
  });

  it("/start failures keep the explanation screen (not mid-run): no auto-switch, no notice", async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "live_unavailable" }) });
    const ES = createMockEventSource();
    render(<ExploreView repoUrl={REPO} onReset={() => {}} EventSourceImpl={ES} />);
    await act(async () => {});
    expect(phase()).toBe("error");
    expect(ES.instances).toHaveLength(0);
    expect(notice()).toBeNull();
    expect(screen.getByRole("button", { name: /Try demo/ })).toBeTruthy();
  });
});

describe("4. active-cluster highlight is layered, not replaced", () => {
  const nodes = [n("flagged-active.js"), n("stale-active.js"), n("only-active.js"), n("only-stale.js"), n("plain.js")];
  const highlights = buildHighlights({
    flagged: ["flagged-active.js"],
    stale: ["stale-active.js", "only-stale.js"],
    active: ["flagged-active.js", "stale-active.js", "only-active.js"],
  });

  it("flagged/stale keep their main ring AND show a separate active-cluster ring", () => {
    const { container } = render(<GraphCanvas nodes={nodes} highlights={highlights} />);
    const g = (f) => container.querySelector(`[data-file="${f}"]`);
    for (const [file, main] of [["flagged-active.js", "flagged"], ["stale-active.js", "stale"]]) {
      expect(g(file).dataset.highlight).toBe(main);
      expect(g(file).dataset.activeCluster).toBe("true");
      expect(g(file).querySelector(".gnode-ring")).toBeTruthy();
      expect(g(file).querySelector(".gnode-ring-active")).toBeTruthy();
      expect(g(file).querySelector("title").textContent).toContain("also: Active cluster");
    }
    // active-only: the active ring is the main ring (no duplicate outer ring)
    expect(g("only-active.js").dataset.highlight).toBe("active");
    expect(g("only-active.js").querySelector(".gnode-ring-active")).toBeNull();
    // stale-only and plain: no active marker
    expect(g("only-stale.js").dataset.activeCluster).toBeUndefined();
    expect(g("plain.js").querySelector(".gnode-ring, .gnode-ring-active")).toBeNull();
    expect(screen.getByText("Active cluster")).toBeTruthy(); // key entry
  });

  it("flagged still drives the automatic focus", () => {
    const { container } = render(<GraphCanvas nodes={nodes} highlights={highlights} />);
    expect(container.querySelector('[data-file="flagged-active.js"]').classList.contains("is-focused")).toBe(true);
    expect(container.querySelector('[data-file="stale-active.js"]').classList.contains("is-focused")).toBe(false);
  });
});

describe("5. readable cluster labels", () => {
  it("clusterLabel formats folder and people count", () => {
    expect(clusterLabel("root#1", 3)).toBe("Shared work: root folder (3 people)");
    expect(clusterLabel("src/routes#1", 1)).toBe("Shared work: src/routes (1 person)");
    expect(clusterLabel("src#2", 4)).toBe("Shared work: src #2 (4 people)");
    expect(clusterLabel("root#1")).toBe("Shared work: root folder");
    expect(clusterLabel("a/very/long/directory/path/that/goes/on#1", 2)).toMatch(/^Shared work: ….{21} \(2 people\)$/);
  });

  it("key shows labels with the author count from direction.activeClusters", () => {
    const nodes = [
      n("index.js", { clusterId: "root#1" }),
      n("package.json", { clusterId: "root#1" }),
      n("session/cookie.js", { clusterId: "session#1" }),
      n("session/store.js", { clusterId: "session#1" }),
    ];
    const activeClusters = [{ files: ["index.js", "package.json", "History.md"], authorCount: 7 }];
    render(<GraphCanvas nodes={nodes} activeClusters={activeClusters} />);
    expect(screen.getByText("Shared work: root folder (7 people)")).toBeTruthy();
    // no activeClusters entry for session#1 -> readable label without a count, never the raw id
    expect(screen.getByText("Shared work: session")).toBeTruthy();
    expect(screen.queryByText("root#1")).toBeNull();
  });

  it("ExploreView passes direction.activeClusters so labels get counts after direction arrives", () => {
    const ES = createMockEventSource();
    render(<ExploreView repoUrl={null} demo onReset={() => {}} EventSourceImpl={ES} />);
    const src = ES.instances.at(-1);
    act(() => {
      src.open();
      src.emit("node", n("index.js", { clusterId: "root#1" }));
      src.emit("node", n("package.json", { clusterId: "root#1" }));
      src.emit("done", ISSUE);
    });
    expect(screen.getByText("Shared work: root folder")).toBeTruthy();
    act(() => src.emit("direction", { direction: "d", staleFiles: [], activeClusters: [{ files: ["index.js", "package.json"], authorCount: 7 }] }));
    expect(screen.getByText("Shared work: root folder (7 people)")).toBeTruthy();
  });
});
