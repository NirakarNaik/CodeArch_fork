import { useEffect, useState } from "react";
import { useSSE } from "./hooks/useSSE.js";
import GraphCanvas from "./GraphCanvas.jsx";
import IssueReveal from "./IssueReveal.jsx";

export default function ExploreView({ repoUrl, onReset }) {
  const [demoMode, setDemoMode] = useState(false);
  const [streamUrl, setStreamUrl] = useState(null);

  useEffect(() => {
    if (demoMode) {
      setStreamUrl("/api/demo/replay");
      return undefined;
    }

    let cancelled = false;
    setStreamUrl(null);
    fetch("/api/explore/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.sseUrl) setStreamUrl(data.sseUrl);
      })
      .catch(() => {
        if (!cancelled) setStreamUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [demoMode, repoUrl]);

  const { nodes, issue, status } = useSSE(streamUrl);

  return (
    <div className="explore-view">
      <div className="explore-header">
        <span className="status-label">
          {status === "connecting" && "Cloning repo…"}
          {status === "streaming" && "Exploring…"}
          {status === "done" && "Done"}
          {status === "error" && "Live exploration failed — try Demo Mode"}
        </span>
        <label className="demo-toggle">
          <input
            type="checkbox"
            checked={demoMode}
            onChange={(e) => setDemoMode(e.target.checked)}
          />
          Demo Mode
        </label>
        <button onClick={onReset}>Explore another repo</button>
      </div>
      <GraphCanvas nodes={nodes} />
      {issue && <IssueReveal issue={issue} />}
    </div>
  );
}
