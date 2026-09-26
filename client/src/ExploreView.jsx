import { useEffect, useRef, useState } from "react";
import { useSSE } from "./hooks/useSSE.js";
import GraphCanvas from "./GraphCanvas.jsx";
import IssueReveal from "./IssueReveal.jsx";
import { createMockEventSource, FAKE_EVENTS } from "./mocks/mockEventSource.js";
import "./graph.css";

export const DEMO_URL = "/api/demo/replay";

// Open the app with ?mock to run the whole view against the fake event array, no backend needed.
const MOCK_MODE = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock");
const MockEventSource = MOCK_MODE ? createMockEventSource({ events: FAKE_EVENTS }) : undefined;

function startSession(repoUrl) {
  if (MOCK_MODE) return Promise.resolve({ sseUrl: "/api/explore/stream/mock" });
  return fetch("/api/explore/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.sseUrl) throw new Error(data.error === "clone_failed" ? "Could not clone that repo." : "Could not start exploration.");
    return data;
  });
}

export default function ExploreView({ repoUrl, onReset, EventSourceImpl = MockEventSource }) {
  const [demoMode, setDemoMode] = useState(false);
  const [streamUrl, setStreamUrl] = useState(null);
  const [startError, setStartError] = useState(null);
  // One clone per repo URL: survives StrictMode's double effect run and demo toggling.
  const sessionRef = useRef({ repoUrl: null, promise: null });

  useEffect(() => {
    setStartError(null);
    if (demoMode) {
      setStreamUrl(DEMO_URL);
      return undefined;
    }

    setStreamUrl(null);
    if (sessionRef.current.repoUrl !== repoUrl) {
      sessionRef.current = { repoUrl, promise: startSession(repoUrl) };
    }

    let cancelled = false;
    sessionRef.current.promise
      .then((data) => {
        if (!cancelled) setStreamUrl(data.sseUrl);
      })
      .catch((err) => {
        sessionRef.current = { repoUrl: null, promise: null }; // allow a retry
        if (!cancelled) setStartError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [demoMode, repoUrl]);

  const { nodes, issue, status, errorMessage } = useSSE(streamUrl, { EventSourceImpl });

  const failed = startError || status === "error";
  const mapped = `${nodes.length} file${nodes.length === 1 ? "" : "s"} mapped`;
  let label;
  if (startError) label = `${startError} Try Demo Mode.`;
  else if (status === "connecting") label = demoMode ? "Loading demo…" : "Cloning repo…";
  else if (status === "streaming") label = `Exploring… ${mapped}`;
  else if (status === "done") label = `Done — ${mapped}`;
  else label = `${errorMessage || "Live exploration failed."}${demoMode ? "" : " Try Demo Mode."}`;

  return (
    <div className="explore-view">
      <div className="explore-header">
        <span className={`status-label${failed ? " error" : ""}`} role="status">
          {label}
        </span>
        <button onClick={onReset}>Explore another repo</button>
      </div>
      <label className={`demo-toggle${demoMode ? " on" : ""}`}>
        <input type="checkbox" checked={demoMode} onChange={(e) => setDemoMode(e.target.checked)} />
        Demo Mode
      </label>
      <GraphCanvas nodes={nodes} />
      {issue && <IssueReveal issue={issue} />}
    </div>
  );
}
