import { useId, useRef, useState } from "react";

// Accepts the forms people actually paste — bare "github.com/…", "www.", a
// trailing ".git" or "/", deep links like "/tree/main" or "?tab=readme" — and
// normalises them to the canonical https://github.com/owner/repo that the
// server's validator (server/routes/explore.js) expects.
const GITHUB_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[/?#].*)?$/i;

function normalizeRepoUrl(input) {
  const match = GITHUB_URL_RE.exec(input.trim());
  if (!match) return null;
  const [, owner, repo] = match;
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return `https://github.com/${owner}/${repo}`;
}

// How many recent commits the server reads for the project-direction analysis
// (StartExploreRequest.commitDepth, clamped server-side to the same range).
const DEPTH_MIN = 10;
const DEPTH_MAX = 50;
const DEPTH_DEFAULT = 25;

function parseDepth(raw) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= DEPTH_MIN && n <= DEPTH_MAX ? n : null;
}

function GitHubMark() {
  return (
    <svg className="repo-field-icon" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

// Faint dependency-trace linework framing the hero. Purely decorative.
function ArchitectureTrace() {
  return (
    <svg
      className="landing-trace"
      viewBox="0 0 1200 800"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g className="trace-lines">
        <path d="M0 180H140V300H260" />
        <path d="M140 300V470H220" />
        <path d="M60 800V620H180V560H300" />
        <path d="M1200 140H1060V260H940" />
        <path d="M1060 260V420H1000" />
        <path d="M1200 600H1080V680H960" />
        <path d="M1080 600V520H1140V0" />
      </g>
      <g className="trace-nodes">
        <rect x="256" y="296" width="8" height="8" />
        <rect x="216" y="466" width="8" height="8" />
        <rect x="296" y="556" width="8" height="8" />
        <rect x="996" y="416" width="8" height="8" />
        <rect x="956" y="676" width="8" height="8" />
      </g>
      <rect className="trace-node-live" x="936" y="256" width="8" height="8" />
    </svg>
  );
}

// `loading` is optional: App currently swaps views synchronously on submit, but
// if a parent ever awaits something before navigating it can pass it through.
// `onDemo` is optional; the demo entry point only renders when it is provided.
// `onSubmit(url, commitDepth)` — callers that only take the URL can ignore the
// second argument.
export default function LandingInput({ onSubmit, onDemo, loading = false }) {
  const [value, setValue] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [depthValue, setDepthValue] = useState(String(DEPTH_DEFAULT));
  const [showDepthError, setShowDepthError] = useState(false);
  const inputRef = useRef(null);
  const depthRef = useRef(null);
  const inputId = useId();
  const hintId = useId();
  const depthId = useId();
  const depthHintId = useId();

  const depth = parseDepth(depthValue);
  const depthError =
    showDepthError && depth === null ? `Pick a whole number from ${DEPTH_MIN} to ${DEPTH_MAX}.` : "";
  const depthHelp =
    depth === null
      ? `Choose how many recent changes (commits) Claude looks at: ${DEPTH_MIN}–${DEPTH_MAX}.`
      : `Claude looks at the project's last ${depth} changes (commits) to see where recent work is happening.`;

  const normalized = normalizeRepoUrl(value);
  const isEmpty = value.trim() === "";

  let error = "";
  if (showErrors && !normalized) {
    error = isEmpty
      ? "Paste a link to a GitHub project to begin."
      : "That doesn't look like a GitHub project link. It should look like github.com/owner/project.";
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    if (loading) return;
    if (!normalized) {
      setShowErrors(true);
      inputRef.current?.focus();
      return;
    }
    if (depth === null) {
      setShowDepthError(true);
      depthRef.current?.focus();
      return;
    }
    onSubmit(normalized, depth);
  };

  const fieldState = error ? "invalid" : normalized ? "valid" : "idle";

  return (
    <main className="landing">
      <div className="landing-backdrop" aria-hidden="true" />
      <ArchitectureTrace />

      <div className="landing-inner">
        <p className="landing-status">
          <span className="status-dot" aria-hidden="true" />
          <span>Agent ready</span>
          <span className="landing-status-sep" aria-hidden="true">/</span>
          <span className="landing-status-model">claude-opus-5-5</span>
        </p>

        <h1 className="landing-title">
          <span className="landing-title-line landing-title-line--dim">Code</span>
          <span className="landing-title-line">Archaeologist</span>
        </h1>

        <p className="landing-tagline">Give it a project it has never seen before.</p>

        <p className="landing-copy">
          Claude explores the project piece by piece, figures out how everything fits together,
          and looks for something that could go wrong — then shows you the evidence.
        </p>

        <p className="landing-aside">Think of it as a detective for unfamiliar software.</p>

        <form className="landing-form" onSubmit={handleSubmit} noValidate>
          <label className="field-label" htmlFor={inputId}>
            Link to a project on GitHub
          </label>

          <div className="repo-field" data-state={fieldState} aria-busy={loading || undefined}>
            <GitHubMark />
            <input
              ref={inputRef}
              id={inputId}
              className="repo-field-input"
              type="url"
              inputMode="url"
              placeholder="github.com/owner/project"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setShowErrors(false);
              }}
              onBlur={() => {
                if (!isEmpty) setShowErrors(true);
              }}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={error ? "true" : "false"}
              aria-describedby={hintId}
            />
            <button
              type="submit"
              className="explore-btn"
              aria-disabled={normalized && depth !== null && !loading ? "false" : "true"}
              data-loading={loading ? "true" : undefined}
            >
              <span className="explore-btn-label">{loading ? "Starting" : "Explore"}</span>
              {loading ? (
                <span className="explore-btn-spinner" aria-hidden="true" />
              ) : (
                <span className="explore-btn-arrow" aria-hidden="true">
                  →
                </span>
              )}
            </button>
          </div>

          <p
            id={hintId}
            className={error ? "field-hint error-text" : "field-hint"}
            aria-live="polite"
          >
            {error || (
              <>
                Any public project on GitHub <span aria-hidden="true">·</span> Claude reads it live
              </>
            )}
          </p>

          <div className="depth-row">
            <div className="depth-field" data-state={depthError ? "invalid" : "idle"}>
              <label className="depth-label" htmlFor={depthId}>
                How far back should Claude look?
              </label>
              <input
                ref={depthRef}
                id={depthId}
                className="depth-input"
                type="number"
                inputMode="numeric"
                min={DEPTH_MIN}
                max={DEPTH_MAX}
                step={1}
                value={depthValue}
                onChange={(e) => {
                  setDepthValue(e.target.value);
                  setShowDepthError(false);
                }}
                onBlur={() => setShowDepthError(true)}
                aria-invalid={depthError ? "true" : "false"}
                aria-describedby={depthHintId}
              />
              <span className="depth-unit">recent changes</span>
            </div>
            <p
              id={depthHintId}
              className={depthError ? "depth-hint error-text" : "depth-hint"}
              aria-live="polite"
            >
              {depthError || depthHelp}
            </p>
          </div>
        </form>

        {onDemo && (
          <div className="landing-demo">
            <p className="landing-divider" aria-hidden="true">
              <span>or</span>
            </p>
            <button type="button" className="demo-btn" onClick={onDemo} disabled={loading}>
              <span className="demo-btn-play" aria-hidden="true" />
              <span className="demo-btn-text">
                <span className="demo-btn-label">Try interactive demo</span>
                <span className="demo-btn-note">
                  Watch Claude investigate a real open-source project (expressjs/session) · no
                  setup needed
                </span>
              </span>
              <span className="demo-btn-arrow" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        )}

        <ol className="landing-steps" aria-label="How it works">
          <li>
            <span className="landing-step-index">01</span> Copy the project
          </li>
          <li>
            <span className="landing-step-index">02</span> Read each piece
          </li>
          <li>
            <span className="landing-step-index">03</span> Connect the pieces
          </li>
          <li>
            <span className="landing-step-index">04</span> Find the problem
          </li>
        </ol>
      </div>
    </main>
  );
}
