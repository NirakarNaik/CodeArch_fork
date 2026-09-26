import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, renderHook, act, cleanup } from "@testing-library/react";
import ExploreView from "../ExploreView.jsx";
import { layout, routeEdge, MAX_NODES } from "../GraphCanvas.jsx";
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
const byFile = (file) => nodesOnScreen().find((el) => el.querySelector(".node-file").textContent === file);
const edges = () => [...document.querySelectorAll("path[data-edge]")].map((p) => p.dataset.edge);
// Assert on the view's phase, not Member 3's status wording (which changes with UI polish).
const phase = () => document.querySelector(".explore-view").dataset.phase;
const highlightOf = (file) => byFile(file)?.dataset.highlight;
const keyText = () => document.querySelector(".graph-key")?.textContent ?? null;

// Box geometry from the rendered DOM, for "no line through a third box" checks.
const boxOf = (el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) });
const pathPoints = (d) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
function firstCrossing(d, boxes) {
  const pts = pathPoints(d);
  for (let i = 1; i < pts.length; i++) {
    for (let t = 0; t <= 1; t += 0.02) {
      const p = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
      const hit = boxes.find((b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h);
      if (hit) return hit;
    }
  }
  return null;
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
    expect(document.querySelectorAll("path[data-routed]")).toHaveLength(0);
    expect(highlightOf("src/d.js")).toBe("flagged");
    expect(highlightOf("src/c.js")).toBe("stale");
    expect(highlightOf("src/a.js")).toBe("active");
    expect(highlightOf("src/b.js")).toBeUndefined();
  });

  it("no issue + empty direction: completes cleanly with no highlights and no key", () => {
    runScenario("noIssueEmptyDirection");
    expect(phase()).toBe("done");
    expect(document.querySelector("[data-highlight]")).toBeNull();
    expect(keyText()).toBeNull();
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

    const boxById = new Map(els.map((el) => [el.dataset.nodeId, boxOf(el)]));
    for (const p of paths) {
      const [from, to] = p.dataset.edge.split("->");
      const others = [...boxById].filter(([id]) => id !== from && id !== to).map(([, b]) => b);
      const hit = firstCrossing(p.getAttribute("d"), others);
      if (hit) throw new Error(`${p.dataset.edge} crosses the box at ${hit.x},${hit.y}`);
    }

    expect(highlightOf("src/m0.js")).toBe("flagged");
    expect(highlightOf("src/m4.js")).toBe("stale");
    expect(highlightOf("src/m1.js")).toBe("active");
    expect(keyText()).toContain("src/api#1");
    expect(keyText()).toContain("src/db#1");
    expect(keyText()).toContain("root#1");
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
    expect(a.querySelector(".node-role").textContent).toBe("updated role");
    expect(a.dataset.cluster).toBe("x");
    expect(byFile("src/b.js").style.backgroundImage).toBe(a.style.backgroundImage);
  });

  it("highlights for unrendered/unknown files are ignored without errors", () => {
    runScenario("unknownHighlights");
    expect(nodesOnScreen()).toHaveLength(25);
    expect(highlightOf("src/u0.js")).toBe("active");
    expect(document.querySelectorAll("[data-highlight]")).toHaveLength(1);
    expect(keyText()).toBe("Active cluster");
  });

  it("cluster split by the cap: the rendered member alone gets no cluster indicator", () => {
    runScenario("clusterAcrossCap");
    const k24 = byFile("src/k24.js");
    expect(k24.dataset.cluster).toBeUndefined();
    expect(k24.querySelector(".node-cluster-dot")).toBeNull();
    expect(keyText()).toBeNull();
  });

  it("more clusters than colours: all get indicators and colours cycle", () => {
    runScenario("manyClusters");
    expect(document.querySelectorAll(".node-cluster-dot")).toHaveLength(14);
    expect(byFile("src/c0.js").style.backgroundImage).toBe(byFile("src/c10.js").style.backgroundImage); // cl0 vs cl5
    expect(byFile("src/c0.js").style.backgroundImage).not.toBe(byFile("src/c2.js").style.backgroundImage);
    expect(document.querySelectorAll(".graph-key-item")).toHaveLength(7);
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

  it("layout + routing stay clean at 1 column and at very wide widths", () => {
    const ns = Array.from({ length: 25 }, (_, i) => n(`w${i}.js`));
    for (const width of [150, 520, 1000, 3200]) {
      const { positions } = layout(ns, width);
      const boxes = ns.map((x) => positions.get(x.id));
      expect(new Set(boxes.map((b) => `${b.x},${b.y}`)).size).toBe(25); // no overlapping boxes
      for (let i = 0; i < ns.length; i += 3) {
        for (let j = 0; j < ns.length; j += 2) {
          if (i === j) continue;
          const others = boxes.filter((_, k) => k !== i && k !== j).map((b) => ({ ...b, w: 200, h: 72 }));
          const { d } = routeEdge(boxes[i], boxes[j], others, 10);
          const hit = firstCrossing(d, others);
          if (hit) throw new Error(`width ${width}: w${i}->w${j} crosses ${hit.x},${hit.y}`);
        }
      }
    }
  });
});

describe("rare scenarios", () => {
  it("missing/odd fields: renders everything, falls back gracefully, ignores empty-string clusters", () => {
    runScenario("weirdFields");
    expect(nodesOnScreen()).toHaveLength(8);
    const upper = byFile("src/UPPER.js");
    expect(upper.style.borderColor).toBe("rgb(136, 136, 136)"); // unknown importance -> neutral
    expect(upper.className).not.toContain("activity-stale");
    expect(upper.style.boxShadow).not.toContain("16px"); // unknown activity -> no glow
    expect(byFile("src/bare.js")).toBeTruthy();
    // "" is treated as "no cluster"; numeric 0 is a real cluster id.
    expect(byFile("src/empty-cluster-1.js").querySelector(".node-cluster-dot")).toBeNull();
    expect(byFile("src/zero-1.js").querySelector(".node-cluster-dot")).toBeTruthy();
    expect(byFile("src/zero-1.js").style.backgroundImage).toBe(byFile("src/zero-2.js").style.backgroundImage);
    // circular imports both drawn, self-import dropped
    expect(edges().sort()).toEqual(["n:src/cyc-a.js->n:src/cyc-b.js", "n:src/cyc-b.js->n:src/cyc-a.js"]);
  });

  it("hostile text: long/unicode names render as text and HTML is never injected", () => {
    runScenario("hostileText");
    expect(byFile("src/ünïcødé/文件.js")).toBeTruthy();
    const xss = byFile("src/xss.js");
    expect(xss.querySelector("img, script")).toBeNull();
    expect(xss.querySelector(".node-role").textContent).toContain("<img");
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
    expect(byFile("src/cold.js").title).toContain("not touched in the analyzed commits");
    expect(byFile("src/hot.js").title).toContain("authors: 7");
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
