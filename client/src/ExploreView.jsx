import { useEffect, useState } from "react";
import { useSSE } from "./hooks/useSSE.js";
import GraphCanvas from "./GraphCanvas.jsx";
import IssueReveal from "./IssueReveal.jsx";
import ExploreStatus from "./ExploreStatus.jsx";

export default function ExploreView({ repoUrl, demo = false, onReset }) {
  const [demoMode, setDemoMode] = useState(demo || !repoUrl);
  const [streamUrl, setStreamUrl] = useState(null);
  // Why /api/explore/start failed (e.g. "live_unavailable", "clone_failed").
  // Without this a failed start left streamUrl null and the view stuck loading.
  const [startError, setStartError] = useState(null);
  // Bumped to force a fresh stream (replay / retry) even when the URL is the same.
  const [run, setRun] = useState(0);

  useEffect(() => {
    setStartError(null);

    if (demoMode) {
      setStreamUrl(run ? `/api/demo/replay?run=${run}` : "/api/demo/replay");
      return undefined;
    }

    let cancelled = false;
    setStreamUrl(null);
    fetch("/api/explore/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl }),
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok && data.sseUrl) setStreamUrl(data.sseUrl);
        else setStartError(data.error || `http_${r.status}`);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[explore] start request failed:", err);
        setStartError("network");
      });

    return () => {
      cancelled = true;
    };
  }, [demoMode, repoUrl, run]);

  const { nodes, issue, status } = useSSE(streamUrl);

  // useSSE keeps its last state while streamUrl is null, so only trust it once
  // a stream for this run exists.
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
      {streaming && <GraphCanvas nodes={nodes} />}
      {streaming && issue && <IssueReveal issue={issue} />}
    </div>
  );
}
