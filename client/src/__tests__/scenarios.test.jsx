import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, renderHook, act, cleanup } from "@testing-library/react";
import ExploreView from "../ExploreView.jsx";
import { MAX_NODES } from "../GraphCanvas.jsx";
import { useSSE } from "../hooks/useSSE.js";
import { createMockEventSource } from "../mocks/mockEventSource.js";
import { SCENARIOS, playInto, n } from "../mocks/scenarios.js";

beforeAll(() => {
  Element.prototype.scrollIntoView ||= () => {}; // IssueReveal scrolls itself into view
});
afterEach(cleanup);

// Plays a named scenario into a demo-mode ExploreView. `endStream` simulates the server
// closing the connection afterwards (an error event with no data).
function runScenario(name, { endStream = true, upTo } = {}) {
  const ES = createMockEventSource();
  render(<ExploreView repoUrl={null} demo onReset={() => {}} EventSourceImpl={ES} />);
  const src = ES.instances.at(-1);
  const events = upTo == null ? SCENARIOS[name] : SCENARIOS[name].slice(0, upTo);
  act(() => {
    src.open();
    playInto(src, events);
    if (endStream) src.fail();
  });
  return src;
}

const nodesOnScreen = () => [...document.querySelectorAll("[data-node-id]")];
const byFile = (file) => nodesOnScreen().find((el) => el.dataset.file === file);
const edges = () => [...document.querySelectorAll("path[data-edge]")].map((p) => p.dataset.edge);
// Assert on the view's phase, not Member 3's status wording (which changes with UI polish).
const phase = () => document.querySelector(".explore-view").dataset.phase;
const highlightOf = (file) => byFile(file)?.dataset.highlight;
// Key entries beyond the always-present importance legend (highlight kinds, clusters, path).
const keyExtras = () => [...document.querySelectorAll(".graph-key-item:not(.graph-key-importance)")].map((e) => e.textContent);

// Circle geometry from the rendered DOM: centre from the <g transform>, radius from the dot.
const circleOf = (el) => {
  const [, x, y] = el.getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\)/);
  return { x: +x, y: +y, r: +el.querySelector(".gnode-dot").getAttribute("r") };
};
function minGap(els) {
  const cs = els.map(circleOf);
  let gap = Infinity;
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++) gap = Math.min(gap, Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y) - cs[i].r - cs[j].r);
  return gap;
}

describe("easy scenarios", () => {
  it("single node: renders, completes, no edges, no highlights", () => {
    runScenario("single");
    expect(nodesOnScreen()).toHaveLength(1);
    expect(edges()).toEqual([]);
    expect(phase()).toBe("done");
    expect(document.querySelector("[data-highlight]")).toBeNull();
  });

  it("chain: straight edges between neighbours, and each highlight kind lands on its file", () => {
    runScenario("chain");
    expect(nodesOnScreen()).toHaveLength(4);
    expect(edges()).toEqual(["n:src/b.js->n:src/a.js", "n:src/c.js->n:src/b.js", "n:src/d.js->n:src/c.js"]);
    for (const p of document.querySelectorAll("path[data-edge]")) expect(p.getAttribute("d")).toMatch(/^M[-\d.]+,[-\d.]+ Q/);
    expect(highlightOf("src/d.js")).toBe("flagged");
    expect(highlightOf("src/c.js")).toBe("stale");
    expect(highlightOf("src/a.js")).toBe("active");
    expect(highlightOf("src/b.js")).toBeUndefined();
  });

  it("no issue + empty direction: completes cleanly with no highlights and no key", () => {
    runScenario("noIssueEmptyDirection");
    expect(phase()).toBe("done");
    expect(document.querySelector("[data-highlight]")).toBeNull();
    expect(keyExtras()).toEqual([]);
  });
});

describe("hard scenarios", () => {
  it("flood of 100 nodes: exactly 25 render, edges only among them, cap note shown", () => {
    const t0 = performance.now();
    runScenario("flood");
    const ms = performance.now() - t0;
    expect(nodesOnScreen()).toHaveLength(MAX_NODES);
    expect(byFile("src/f24.js")).toBeTruthy();
    expect(byFile("src/f25.js")).toBeUndefined();
    expect(edges()).toHaveLength(24);
    expect(document.querySelector(".graph-cap-note").textContent).toBe("Showing the first 25 of 100 files.");
    expect(ms).toBeLessThan(3000);
  });

  it("dense 25 fully connected: 600 edges, none drawn through a third box, highlights + clusters intact", () => {
    const t0 = performance.now();
    runScenario("dense25");
    const ms = performance.now() - t0;
    const els = nodesOnScreen();
    expect(els).toHaveLength(25);
    const paths = [...document.querySelectorAll("path[data-edge]")];
    expect(paths).toHaveLength(600);

    expect(minGap(els)).toBeGreaterThan(8); // no two circles overlap, even at 25 nodes
    for (const p of paths) expect(p.getAttribute("d")).toMatch(/ Q/);

    expect(highlightOf("src/m0.js")).toBe("flagged");
    expect(highlightOf("src/m4.js")).toBe("stale");
    expect(highlightOf("src/m1.js")).toBe("active");
    expect(keyExtras()).toEqual(expect.arrayContaining(["src/api#1", "src/db#1", "root#1"]));
    expect(ms).toBeLessThan(5000);
  });

  it("out-of-order imports: edges appear only once their target arrives; a never-sent target never gets one", () => {
    runScenario("outOfOrder", { upTo: 1, endStream: false });
    expect(edges()).toEqual([]);
    cleanup();
    runScenario("outOfOrder", { upTo: 2, endStream: false });
    expect(edges()).toEqual(["n:src/app.js->n:src/db.js"]);
    cleanup();
    runScenario("outOfOrder");
    expect(edges().sort()).toEqual(
      ["n:src/app.js->n:src/config.js", "n:src/app.js->n:src/db.js", "n:src/db.js->n:src/config.js"].sort()
    );
  });

  it("re-emitted file: merged in place (first id kept), fields updated, now clustered with its partner", () => {
    runScenario("reemit");
    expect(nodesOnScreen()).toHaveLength(2);
    const a = byFile("src/a.js");
    expect(a.dataset.nodeId).toBe("rnd-1");
    expect(a.dataset.activity).toBe("active");
    expect(a.querySelector("title").textContent).toContain("updated role");
    expect(a.dataset.cluster).toBe("x");
    expect(byFile("src/b.js").querySelector(".node-cluster-dot").getAttribute("fill")).toBe(a.querySelector(".node-cluster-dot").getAttribute("fill"));
  });

  it("highlights for unrendered/unknown files are ignored without errors", () => {
    runScenario("unknownHighlights");
    expect(nodesOnScreen()).toHaveLength(25);
    expect(highlightOf("src/u0.js")).toBe("active");
    expect(document.querySelectorAll("[data-highlight]")).toHaveLength(1);
    expect(keyExtras()).toEqual(["Active cluster"]);
  });

  it("cluster split by the cap: the rendered member alone gets no cluster indicator", () => {
    runScenario("clusterAcrossCap");
    const k24 = byFile("src/k24.js");
    expect(k24.dataset.cluster).toBeUndefined();
    expect(k24.querySelector(".node-cluster-dot")).toBeNull();
    expect(keyExtras()).toEqual([]);
  });

  it("more clusters than colours: all get indicators and colours cycle", () => {
    runScenario("manyClusters");
    expect(document.querySelectorAll(".node-cluster-dot")).toHaveLength(14);
    const dot = (f) => byFile(f).querySelector(".node-cluster-dot").getAttribute("fill");
    expect(dot("src/c0.js")).toBe(dot("src/c10.js")); // cl0 vs cl5
    expect(dot("src/c0.js")).not.toBe(dot("src/c2.js"));
    expect(keyExtras()).toHaveLength(7);
  });

  it("overlapping highlight reasons resolve flagged > stale > active", () => {
    runScenario("highlightPriority");
    expect(highlightOf("src/all.js")).toBe("flagged");
    expect(highlightOf("src/stale-and-active.js")).toBe("stale");
    expect(highlightOf("src/only-active.js")).toBe("active");
  });

  it("direction closes the stream (contract), so a second direction event is ignored", () => {
    const src = runScenario("directionTwice", { endStream: false });
    expect(src.readyState).toBe(2);
    expect(highlightOf("src/a.js")).toBe("stale");
    expect(highlightOf("src/b.js")).toBeUndefined();
  });

  it("a late node after done renders but doesn't flip the status back to analyzing", () => {
    runScenario("lateNodeAfterDone");
    expect(byFile("src/late.js")).toBeTruthy();
    expect(highlightOf("src/late.js")).toBe("stale");
    expect(phase()).toBe("done");
  });

  it("events from a previous stream are ignored after switching url", () => {
    const ES = createMockEventSource();
    const { result, rerender } = renderHook(({ url }) => useSSE(url, { EventSourceImpl: ES }), { initialProps: { url: "/one" } });
    const first = ES.instances[0];
    rerender({ url: "/two" });
    act(() => {
      first.emit("node", n("src/stale-stream.js"));
      first.emit("direction", { staleFiles: ["x"], activeClusters: [] });
    });
    expect(result.current.nodes).toEqual([]);
    expect(result.current.direction).toBeNull();
  });
});

describe("rare scenarios", () => {
  it("missing/odd fields: renders everything, falls back gracefully, ignores empty-string clusters", () => {
    runScenario("weirdFields");
    expect(nodesOnScreen()).toHaveLength(8);
    const upper = byFile("src/UPPER.js");
    expect(upper.querySelector(".gnode-dot").getAttribute("fill")).toBe("#6b6e82"); // unknown importance -> neutral
    expect(upper.classList.contains("activity-stale")).toBe(false);
    expect(byFile("src/bare.js")).toBeTruthy();
    // "" is treated as "no cluster"; numeric 0 is a real cluster id.
    expect(byFile("src/empty-cluster-1.js").querySelector(".node-cluster-dot")).toBeNull();
    expect(byFile("src/zero-1.js").querySelector(".node-cluster-dot")).toBeTruthy();
    expect(byFile("src/zero-1.js").querySelector(".node-cluster-dot").getAttribute("fill")).toBe(byFile("src/zero-2.js").querySelector(".node-cluster-dot").getAttribute("fill"));
    // circular imports both drawn, self-import dropped
    expect(edges().sort()).toEqual(["n:src/cyc-a.js->n:src/cyc-b.js", "n:src/cyc-b.js->n:src/cyc-a.js"]);
  });

  it("hostile text: long/unicode names render as text and HTML is never injected", () => {
    runScenario("hostileText");
    expect(byFile("src/ünïcødé/文件.js")).toBeTruthy();
    const xss = byFile("src/xss.js");
    expect(xss.querySelector("img, script")).toBeNull();
    expect(xss.querySelector("title").textContent).toContain("<img");
    expect(document.querySelector(".issue-reveal b")).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(highlightOf("src/xss.js")).toBe("flagged");
  });

  it("malformed payloads are skipped and bad direction shapes don't crash", () => {
    runScenario("malformed");
    expect(nodesOnScreen()).toHaveLength(1);
    expect(phase()).toBe("done");
    expect(highlightOf("src/ok.js")).toBe("active");
  });

  it("a null or string direction payload is ignored, still closes the stream, run stays complete", () => {
    for (const name of ["directionNull", "directionString"]) {
      const src = runScenario(name, { endStream: false });
      expect(src.readyState).toBe(2);
      expect(phase()).toBe("done");
      expect(document.querySelector("[data-highlight]")).toBeNull();
      cleanup();
    }
  });

  it("authorCount 0 is explained in the tooltip as untouched in the commit window", () => {
    runScenario("untouched");
    expect(byFile("src/cold.js").querySelector("title").textContent).toContain("not touched in the analyzed commits");
    expect(byFile("src/hot.js").querySelector("title").textContent).toContain("authors: 7");
  });

  it("server error mid-stream: error panel shown, already-mapped nodes kept on screen", () => {
    runScenario("errorMidStream");
    expect(phase()).toBe("error");
    expect(nodesOnScreen()).toHaveLength(2);
  });

  it("stream ends without done: treated as interrupted, nodes kept", () => {
    runScenario("noDone");
    expect(phase()).toBe("error");
    expect(nodesOnScreen()).toHaveLength(2);
  });
});
