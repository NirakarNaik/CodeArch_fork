import { useEffect, useMemo, useRef, useState } from "react";
import { useSSE } from "./hooks/useSSE.js";
import GraphCanvas, { buildHighlights } from "./GraphCanvas.jsx";
import IssueReveal from "./IssueReveal.jsx";
import ExploreStatus from "./ExploreStatus.jsx";
import { createMockEventSource, FAKE_EVENTS } from "./mocks/mockEventSource.js";
import "./explore.css";

export const DEMO_URL = "/api/demo/replay";

// A live run that goes this long without any SSE event switches to the recorded run.
// Deliberately long: the first node normally takes 12-18s and 11-15s gaps while Claude
// reasons are normal, so anything short would false-trigger.
export const STALL_MS = 30_000;

const SWITCH_REASONS = {
  stalled: "The live exploration went 30 seconds without any progress.",
  error: "The live exploration lost its connection partway through.",
};

// Open the app with ?mock to run the whole view against the fake event array, no backend needed.
const MOCK_MODE = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock");
const MockEventSource = MOCK_MODE ? createMockEventSource({ events: FAKE_EVENTS }) : undefined;

// Resolves to { sseUrl } or rejects with an Error whose .code is an ExploreStatus ERROR_COPY key
// ("live_unavailable", "clone_failed", "network", ...).
// commitDepth is only sent when set; without it the server applies its own default (25).
function startSession(repoUrl, commitDepth) {
  if (MOCK_MODE) return Promise.resolve({ sseUrl: "/api/explore/stream/mock" });
  const fail = (code) => Object.assign(new Error(code), { code });
  return fetch("/api/explore/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(commitDepth == null ? { repoUrl } : { repoUrl, commitDepth }),
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

export default function ExploreView({ repoUrl, commitDepth, demo = false, onReset, EventSourceImpl = MockEventSource }) {
  const [demoMode, setDemoMode] = useState(demo || !repoUrl);
  const [streamUrl, setStreamUrl] = useState(null);
  // Why /api/explore/start failed (e.g. "live_unavailable", "clone_failed").
  // Without this a failed start left streamUrl null and the view stuck loading.
  const [startError, setStartError] = useState(null);
  // Bumped to force a fresh stream (replay / retry) even when the URL is the same.
  const [run, setRun] = useState(0);
  // Set when a live run was automatically replaced by the recorded run ("stalled" | "error").
  // Drives the "Switched to a recorded run" notice, which stays up for the rest of this view.
  const [autoSwitched, setAutoSwitched] = useState(null);
  // Shares the in-flight /start request: StrictMode runs this effect twice on mount, and
  // without this each run would POST /start and clone the repo again.
  const sessionRef = useRef({ key: null, promise: null });
  const sessionKey = `${repoUrl}|${commitDepth ?? ""}`;

  useEffect(() => {
    setStartError(null);

    if (demoMode) {
      setStreamUrl(run ? `${DEMO_URL}?run=${run}` : DEMO_URL);
      return undefined;
    }

    setStreamUrl(null);
    if (sessionRef.current.key !== sessionKey) {
      sessionRef.current = { key: sessionKey, promise: startSession(repoUrl, commitDepth) };
    }

    let cancelled = false;
    const pending = sessionRef.current.promise;
    pending
      .then((data) => {
        if (cancelled) return;
        // Sessions are single-use on the server (a second stream gets 409/404), so once this
        // one is being streamed, going live again must start a fresh session.
        if (sessionRef.current.promise === pending) sessionRef.current = { key: null, promise: null };
        setStreamUrl(data.sseUrl);
      })
      .catch((err) => {
        sessionRef.current = { key: null, promise: null }; // allow a retry
        if (!cancelled) setStartError(err.code || "network");
      });

    return () => {
      cancelled = true;
    };
  }, [demoMode, sessionKey, run]); // sessionKey covers repoUrl + commitDepth

  // `direction` (ProjectDirection) arrives after `done`; it's passed to IssueReveal for
  // Member 3's direction panel and also feeds the graph highlights below.
  // The stall timer only runs for live streams; the recorded replay has its own fixed timing.
  // Decided from the URL, not demoMode: when a switch flips demoMode, the URL is still the live
  // one for a render, and a changed stallMs would reopen the (single-use) live stream.
  const isLiveStream = Boolean(streamUrl) && !streamUrl.startsWith(DEMO_URL);
  const { nodes, issue, direction, status, stalled } = useSSE(streamUrl, {
    EventSourceImpl,
    stallMs: isLiveStream ? STALL_MS : null,
  });

  // Automatic switch to the recorded run when a live stream stalls or errors mid-run.
  // (/start failures such as a bad URL or no API key keep ExploreStatus's explanation +
  // "Try demo" button: those aren't mid-run, and the user needs to know why.)
  useEffect(() => {
    if (demoMode || !streamUrl) return;
    const reason = stalled ? "stalled" : status === "error" ? "error" : null;
    if (!reason) return;
    setAutoSwitched(reason);
    setDemoMode(true);
    setRun((n) => n + 1);
  }, [demoMode, streamUrl, stalled, status]);

  const activeClusters = useMemo(
    () => (Array.isArray(direction?.activeClusters) ? direction.activeClusters.filter((c) => c && typeof c === "object") : []),
    [direction]
  );

  // Files to call out on the graph, all through the same highlight mechanism.
  const highlights = useMemo(
    () =>
      buildHighlights({
        flagged: issue?.files,
        stale: direction?.staleFiles,
        active: activeClusters.flatMap((c) => c?.files || []),
      }),
    [issue, direction, activeClusters]
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
      {autoSwitched && (
        // Honesty requirement: never swap to the recorded run silently.
        <div className="auto-switch-notice" role="alert" data-reason={autoSwitched}>
          <strong className="auto-switch-title">Switched to a recorded run</strong>
          <span className="auto-switch-body">
            {SWITCH_REASONS[autoSwitched]} What you see below is a previously recorded exploration, not a live
            result for this repository.
          </span>
        </div>
      )}
      <ExploreStatus
        phase={phase}
        demo={demoMode}
        repoUrl={repoUrl}
        nodes={streaming ? nodes : []}
        errorCode={startError}
        onTryDemo={runDemo}
        onReset={onReset}
      />
      {streaming && <GraphCanvas nodes={nodes} highlights={highlights} activeClusters={activeClusters} />}
      {streaming && issue && <IssueReveal issue={issue} direction={direction} />}
    </div>
  );
}
