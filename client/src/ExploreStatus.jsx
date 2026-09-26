// Header + analysis panel for the explore screen. Purely presentational: every
// number shown is derived from the GraphNode events received so far.

import { useEffect, useState } from "react";

// Written for someone who has never programmed: "project", not "repository".
const ERROR_COPY = {
  live_unavailable: {
    title: "Live mode unavailable",
    body: "Live investigations need an Anthropic API key, and this server doesn't have one set up. The demo replays a complete recorded investigation instead.",
  },
  invalid_url: {
    title: "Investigation interrupted",
    body: "That link wasn't accepted. It should look like github.com/owner/project.",
  },
  clone_failed: {
    title: "Investigation interrupted",
    body: "We couldn't get a copy of that project. Check that the link is right and that the project is public.",
  },
  network: {
    title: "Investigation interrupted",
    body: "We couldn't reach the Code Archaeologist server. Check that it is still running.",
  },
  stream: {
    title: "Investigation interrupted",
    body: "The investigation stopped before it finished. Whatever Claude looked at so far is shown below.",
  },
  demo: {
    title: "Demo interrupted",
    body: "The recorded demo couldn't be played. Try it again.",
  },
};

const IMPORTANCE = [
  ["core", "Important parts"],
  ["support", "Helper parts"],
  ["config", "Settings"],
];

// A run can take a while before its first discovery (the recorded demo waits
// ~18s). Until a piece arrives, cycle through general, honest activity — never
// a claim about a specific file or a result — then settle on the last line.
const WAITING_LINES = [
  "Claude is reading the project structure…",
  "Looking through the project's files…",
  "Figuring out how the project is put together…",
  "Following the project's connections…",
  "Still investigating…",
];
const WAITING_STEP_S = 4;

// Seconds since `running` last became true (or `resetKey` changed); 0 otherwise.
function useElapsedSeconds(running, resetKey) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    setSeconds(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running, resetKey]);
  return running ? seconds : 0;
}

const formatElapsed = (s) =>
  s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;

// The project recorded in server/demo-log.json (Member 1's capture). Keep in sync.
const DEMO_REPO = "expressjs/session";

// Narration sentences come straight from the agent and can run long; step the
// type size down so the panel doesn't grow to four lines.
const LONG_LINE = 90;

function repoSlug(url) {
  if (!url) return "";
  return url.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\/$/, "");
}

function summarize(nodes) {
  const byImportance = { core: 0, support: 0, config: 0 };
  let connections = 0;
  for (const node of nodes) {
    connections += node.imports?.length || 0;
    if (node.importance in byImportance) byImportance[node.importance] += 1;
  }
  return { explored: nodes.length, connections, byImportance };
}

// While streaming, the headline narrates the latest discovery in the agent's
// own plain-language words (GraphNode.role), so the run reads as a story.
function phaseCopy(phase, demo, slug, stats, latest, waitedS) {
  switch (phase) {
    case "starting":
      return {
        kicker: "Preparing",
        line: "Getting a copy of the project",
        detail: `Downloading ${slug}`,
        sr: "Getting a copy of the project",
      };
    case "connecting":
      return {
        kicker: "Preparing",
        line: demo ? "Replaying the investigation" : "Sending the project to Claude",
        detail: demo
          ? "A recording of an earlier run — no live AI calls"
          : "Claude will read it one piece at a time",
        sr: demo ? "Replaying the investigation" : "Sending the project to Claude",
      };
    case "done":
      return {
        kicker: "Investigation complete",
        line: "Claude worked out how the project fits together",
        detail: "What it found is below ↓",
        sr: "Investigation complete",
      };
    default: {
      if (latest) {
        return {
          kicker: "Figuring out how the project is put together",
          line: latest.role || "Reading the next piece",
          detail: latest.file,
          sr: "Figuring out how the project is put together",
        };
      }
      const step = Math.min(Math.floor(waitedS / WAITING_STEP_S), WAITING_LINES.length - 1);
      return {
        kicker: "Investigating",
        line: WAITING_LINES[step],
        detail: `${formatElapsed(waitedS)} so far · the first pieces appear here as Claude finds them`,
        sr: "Investigating the project",
      };
    }
  }
}

export default function ExploreStatus({
  phase,
  demo,
  repoUrl,
  nodes,
  errorCode,
  onTryDemo,
  onReset,
}) {
  const slug = demo ? DEMO_REPO : repoSlug(repoUrl);
  const stats = summarize(nodes);
  const latest = nodes.length ? nodes[nodes.length - 1] : null;
  const failed = phase === "error";
  const error = failed ? ERROR_COPY[errorCode] || ERROR_COPY[demo ? "demo" : "stream"] : null;
  const active = phase === "starting" || phase === "connecting" || phase === "streaming";
  // Streaming but nothing discovered yet: show that the investigation is alive.
  const waiting = phase === "streaming" && nodes.length === 0;
  const waitedS = useElapsedSeconds(waiting, demo);
  const copy = phaseCopy(phase, demo, slug, stats, latest, waitedS);
  // Numbers only mean something once a piece has arrived (or the run finished):
  // no "0 pieces / 0 links" beside an error or during the opening wait.
  const showMetrics = nodes.length > 0 || phase === "done";
  // The graph area is on screen from the moment a stream exists; label it then.
  const showCaption = nodes.length > 0 || phase === "connecting" || phase === "streaming";

  return (
    <>
      <header className="explore-header">
        <div className="explore-brand">
          <span className="explore-wordmark">
            <span className="explore-wordmark-dim">Code</span>Archaeologist
          </span>
          <span className="explore-target" title={demo ? undefined : repoUrl}>
            <span className="explore-target-sep" aria-hidden="true">
              /
            </span>
            {slug}
          </span>
        </div>

        <div className="explore-actions">
          {demo && (
            <span className="demo-badge">
              <span className="demo-badge-dot" aria-hidden="true" />
              Demo replay
              <span className="demo-badge-note">Recorded run · no API calls</span>
            </span>
          )}
          {!demo && active && (
            <button type="button" className="btn btn-ghost" onClick={onTryDemo}>
              Run demo instead
            </button>
          )}
          {demo && phase === "done" && (
            <button type="button" className="btn btn-ghost" onClick={onTryDemo}>
              Replay
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onReset}>
            Explore another project
          </button>
        </div>
      </header>

      <section
        className="analysis-panel"
        data-phase={phase}
        aria-label="Investigation status"
        aria-busy={active || undefined}
      >
        <p className="sr-only" role="status">
          {failed ? `${error.title}. ${error.body}` : `${copy.sr}.`}
        </p>

        {failed ? (
          <div className="analysis-error">
            <p className="analysis-kicker analysis-kicker--error">
              <span className="analysis-kicker-mark" aria-hidden="true" />
              {error.title}
            </p>
            <p className="analysis-error-body">{error.body}</p>
            <div className="analysis-error-actions">
              <button type="button" className="btn btn-primary" onClick={onTryDemo}>
                <span className="btn-play" aria-hidden="true" />
                {demo ? "Retry demo" : "Try demo"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onReset}>
                Explore another project
              </button>
            </div>
          </div>
        ) : (
          <div className="analysis-status" aria-hidden="true">
            <p className="analysis-kicker">{copy.kicker}</p>
            <p className="analysis-line">
              <span className={active ? "analysis-pulse is-active" : "analysis-pulse"} />
              <span
                key={copy.line}
                className={
                  copy.line.length > LONG_LINE ? "analysis-line-text is-long" : "analysis-line-text"
                }
              >
                {copy.line}
              </span>
            </p>
            <p className="analysis-detail">
              {phase === "streaming" && latest ? (
                <>
                  <span className="analysis-detail-prompt">›</span> Now looking at{" "}
                  <code>{copy.detail}</code>
                </>
              ) : (
                copy.detail || "Looking at how the project is organised"
              )}
            </p>
          </div>
        )}

        {showMetrics && (
          <div className="analysis-metrics">
            <p className="analysis-metrics-title">What Claude figured out</p>
            <dl className="analysis-stats">
              <div className="analysis-stat">
                <dt>Pieces examined</dt>
                <dd>{stats.explored}</dd>
              </div>
              <div className="analysis-stat">
                <dt>Links between them</dt>
                <dd>{stats.connections}</dd>
              </div>
            </dl>
            <p className="analysis-metrics-note">
              A link means one part of the project needs another part to do its job.
            </p>
            <p className="analysis-legend">
              {IMPORTANCE.map(([key, label]) => (
                <span key={key} className="legend-item" data-importance={key}>
                  <span className="legend-swatch" aria-hidden="true" />
                  {label}
                  <span className="legend-term">{key}</span>
                  <span className="legend-count">{stats.byImportance[key]}</span>
                </span>
              ))}
            </p>
          </div>
        )}
      </section>

      {showCaption && (
        <div className="graph-caption">
          <h2 className="graph-caption-title">How the project works</h2>
          <p className="graph-caption-text">
            Each dot is one part of the project, labelled with its real file name. Bigger dots are
            more central parts; hover over a dot to read what it does. A line with an arrow points
            from a part to another part it needs. When Claude finishes, rings mark what it found —
            the key under the graph explains each colour.
          </p>
        </div>
      )}

    </>
  );
}
