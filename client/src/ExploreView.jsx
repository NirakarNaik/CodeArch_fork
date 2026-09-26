import { useEffect, useMemo, useRef, useState } from "react";
import { useSSE } from "./hooks/useSSE.js";
import GraphCanvas, { buildHighlights } from "./GraphCanvas.jsx";
import IssueReveal from "./IssueReveal.jsx";
import ExploreStatus from "./ExploreStatus.jsx";
import { createMockEventSource, FAKE_EVENTS } from "./mocks/mockEventSource.js";

export const DEMO_URL = "/api/demo/replay";

// Open the app with ?mock to run the whole view against the fake event array, no backend needed.
const MOCK_MODE = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock");
const MockEventSource = MOCK_MODE ? createMockEventSource({ events: FAKE_EVENTS }) : undefined;

// Resolves to { sseUrl } or rejects with an Error whose .code is an ExploreStatus ERROR_COPY key
// ("live_unavailable", "clone_failed", "network", ...).
function startSession(repoUrl) {
  if (MOCK_MODE) return Promise.resolve({ sseUrl: "/api/explore/stream/mock" });
  const fail = (code) => Object.assign(new Error(code), { code });
  return fetch("/api/explore/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  }).then(
    async (r) => {
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.sseUrl) return data;
      throw fail(data.error || `http_${r.status}`);
    },
    (err) => {
      console.error("[explore] start request failed:", err);
      throw fail("network");
    }
  );
}

export default function ExploreView({ repoUrl, demo = false, onReset, EventSourceImpl = MockEventSource }) {
  const [demoMode, setDemoMode] = useState(demo || !repoUrl);
  const [streamUrl, setStreamUrl] = useState(null);
  // Why /api/explore/start failed (e.g. "live_unavailable", "clone_failed").
  // Without this a failed start left streamUrl null and the view stuck loading.
  const [startError, setStartError] = useState(null);
  // Bumped to force a fresh stream (replay / retry) even when the URL is the same.
  const [run, setRun] = useState(0);
  // Shares the in-flight /start request: StrictMode runs this effect twice on mount, and
  // without this each run would POST /start and clone the repo again.
  const sessionRef = useRef({ repoUrl: null, promise: null });

  useEffect(() => {
    setStartError(null);

    if (demoMode) {
      setStreamUrl(run ? `${DEMO_URL}?run=${run}` : DEMO_URL);
      return undefined;
    }

    setStreamUrl(null);
    if (sessionRef.current.repoUrl !== repoUrl) {
      sessionRef.current = { repoUrl, promise: startSession(repoUrl) };
    }

    let cancelled = false;
    const pending = sessionRef.current.promise;
    pending
      .then((data) => {
        if (cancelled) return;
        // Sessions are single-use on the server (a second stream gets 409/404), so once this
        // one is being streamed, going live again must start a fresh session.
        if (sessionRef.current.promise === pending) sessionRef.current = { repoUrl: null, promise: null };
        setStreamUrl(data.sseUrl);
      })
      .catch((err) => {
        sessionRef.current = { repoUrl: null, promise: null }; // allow a retry
        if (!cancelled) setStartError(err.code || "network");
      });

    return () => {
      cancelled = true;
    };
  }, [demoMode, repoUrl, run]);

  // `direction` (ProjectDirection) is also available here for Member 3's direction panel.
  const { nodes, issue, direction, status } = useSSE(streamUrl, { EventSourceImpl });

  // Files to call out on the graph, all through the same highlight mechanism.
  const highlights = useMemo(
    () =>
      buildHighlights({
        flagged: issue?.files,
        stale: direction?.staleFiles,
        active: (direction?.activeClusters || []).flatMap((c) => c?.files || []),
      }),
    [issue, direction]
  );

  // useSSE resets while streamUrl is null, so only trust it once a stream for this run exists.
  const streaming = Boolean(streamUrl) && !startError;
  const phase = startError ? "error" : streamUrl ? status : "starting";

  const runDemo = () => {
    setDemoMode(true);
    setRun((n) => n + 1);
  };

  return (
    <div className="explore-view" data-phase={phase}>
      <ExploreStatus
        phase={phase}
        demo={demoMode}
        repoUrl={repoUrl}
        nodes={streaming ? nodes : []}
        errorCode={startError}
        onTryDemo={runDemo}
        onReset={onReset}
      />
      {streaming && <GraphCanvas nodes={nodes} highlights={highlights} />}
      {streaming && issue && <IssueReveal issue={issue} />}
    </div>
  );
}
