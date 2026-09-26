// Header + analysis panel for the explore screen. Purely presentational: every
// number shown is derived from the GraphNode events received so far.

const ERROR_COPY = {
  live_unavailable: {
    title: "Live mode unavailable",
    body: "Live AI exploration isn't configured on this server — no Anthropic API key is set. The demo replays a full recorded exploration without one.",
  },
  invalid_url: {
    title: "Exploration interrupted",
    body: "The server rejected that repository URL. Use the form github.com/owner/repository.",
  },
  clone_failed: {
    title: "Exploration interrupted",
    body: "The repository couldn't be cloned. Check that it exists, is public, and that this machine can reach GitHub.",
  },
  network: {
    title: "Exploration interrupted",
    body: "Couldn't reach the exploration server. Check that it is still running.",
  },
  stream: {
    title: "Exploration interrupted",
    body: "The exploration stream ended before the analysis finished. Whatever was mapped so far is shown below.",
  },
  demo: {
    title: "Demo interrupted",
    body: "The recorded demo couldn't be streamed from the server. Try it again.",
  },
};

const IMPORTANCE = [
  ["core", "Core"],
  ["support", "Support"],
  ["config", "Config"],
];

function repoSlug(url) {
  if (!url) return "";
  return url.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\/$/, "");
}

function summarize(nodes) {
  const files = new Set();
  const byImportance = { core: 0, support: 0, config: 0 };
  let relationships = 0;
  for (const node of nodes) {
    files.add(node.file);
    for (const dep of node.imports || []) files.add(dep);
    relationships += node.imports?.length || 0;
    if (node.importance in byImportance) byImportance[node.importance] += 1;
  }
  return { discovered: nodes.length, traced: files.size, relationships, byImportance };
}

function phaseCopy(phase, demo, slug, stats) {
  switch (phase) {
    case "starting":
      return { kicker: "Preparing", line: "Cloning repository", detail: `Shallow clone of ${slug}` };
    case "connecting":
      return {
        kicker: "Connecting",
        line: demo ? "Loading recorded session" : "Starting the agent",
        detail: demo ? "Replaying a captured exploration" : "Handing the repository to Claude",
      };
    case "done":
      return {
        kicker: "Analysis complete",
        line: "Architecture mapped",
        detail: `${stats.discovered} files mapped · ${stats.relationships} relationships`,
      };
    default:
      return {
        kicker: "Analyzing repository",
        line: stats.discovered ? "Mapping repository architecture" : "Surveying repository structure",
        detail: null,
      };
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
  const slug = demo ? "sample/storefront-api" : repoSlug(repoUrl);
  const stats = summarize(nodes);
  const latest = nodes.length ? nodes[nodes.length - 1].file : null;
  const failed = phase === "error";
  const error = failed ? ERROR_COPY[errorCode] || ERROR_COPY[demo ? "demo" : "stream"] : null;
  const copy = phaseCopy(phase, demo, slug, stats);
  const active = phase === "starting" || phase === "connecting" || phase === "streaming";

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
            Explore another repo
          </button>
        </div>
      </header>

      <section
        className="analysis-panel"
        data-phase={phase}
        aria-label="Exploration status"
        aria-busy={active || undefined}
      >
        <p className="sr-only" role="status">
          {failed ? `${error.title}. ${error.body}` : `${copy.kicker}. ${copy.line}.`}
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
                Explore another repo
              </button>
            </div>
          </div>
        ) : (
          <div className="analysis-status" aria-hidden="true">
            <p className="analysis-kicker">{copy.kicker}</p>
            <p className="analysis-line">
              <span className={active ? "analysis-pulse is-active" : "analysis-pulse"} />
              {copy.line}
            </p>
            <p className="analysis-detail">
              {copy.detail ||
                (latest ? (
                  <>
                    <span className="analysis-detail-prompt">›</span> traced{" "}
                    <code>{latest}</code>
                  </>
                ) : (
                  "Reading the repository root"
                ))}
            </p>
          </div>
        )}

        <div className="analysis-metrics">
          <dl className="analysis-stats">
            <div className="analysis-stat">
              <dt>Nodes discovered</dt>
              <dd>{stats.discovered}</dd>
            </div>
            <div className="analysis-stat">
              <dt>Files traced</dt>
              <dd>{stats.traced}</dd>
            </div>
            <div className="analysis-stat">
              <dt>Relationships</dt>
              <dd>{stats.relationships}</dd>
            </div>
          </dl>
          <p className="analysis-legend">
            {IMPORTANCE.map(([key, label]) => (
              <span key={key} className="legend-item" data-importance={key}>
                <span className="legend-swatch" aria-hidden="true" />
                {label}
                <span className="legend-count">{stats.byImportance[key]}</span>
              </span>
            ))}
          </p>
        </div>
      </section>

      {active && nodes.length === 0 && (
        <div className="graph-placeholder" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="graph-placeholder-cell" style={{ "--i": i }} />
          ))}
        </div>
      )}
    </>
  );
}
