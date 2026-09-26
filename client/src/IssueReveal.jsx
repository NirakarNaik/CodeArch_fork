import { useEffect, useId, useMemo, useRef, useState } from "react";

const NO_ISSUE_TEXT = "No notable issue flagged this run.";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// All reveal beats derive from one elapsed-time value, so there is exactly one
// rAF loop to clean up. Typing durations are capped so long text never makes
// the audience wait: the whole sequence finishes in roughly 2–4.5s.
function buildTimeline(headline, evidence, fileCount) {
  const statusAt = 250;
  const headlineStart = 550;
  const headlineEnd = headlineStart + clamp(headline.length * 14, 450, 1500);
  const filesAt = headlineEnd + 150;
  const evidenceStart = filesAt + (fileCount ? 250 + Math.min(fileCount, 6) * 70 : 0);
  const evidenceEnd = evidence
    ? evidenceStart + clamp(evidence.length * 9, 400, 1400)
    : evidenceStart;
  return { statusAt, headlineStart, headlineEnd, filesAt, evidenceStart, end: evidenceEnd };
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function typedCount(text, t, start, end) {
  if (t <= start) return 0;
  if (t >= end) return text.length;
  return Math.round(((t - start) / (end - start)) * text.length);
}

// The untyped remainder stays in the DOM as `visibility: hidden`, so the card
// is laid out at its final size from the first frame and never jumps.
function Typed({ text, count, typing }) {
  return (
    <>
      <span>{text.slice(0, count)}</span>
      {typing && <span className="typed-caret" aria-hidden="true" />}
      <span className="typed-rest">{text.slice(count)}</span>
    </>
  );
}

function FilePath({ path }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <>
      {cut > 0 && <span className="issue-file-dir">{path.slice(0, cut)}</span>}
      <span className="issue-file-name">{path.slice(cut)}</span>
    </>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M10 2.5 18.5 17h-17L10 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M10 8v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="14.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="7.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="m6.75 10.25 2.25 2.25 4.25-4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function IssueReveal({ issue }) {
  const flagged = typeof issue?.issue === "string" && issue.issue.trim() !== "";
  const headline = flagged ? issue.issue.trim() : NO_ISSUE_TEXT;
  const evidence = typeof issue?.evidence === "string" ? issue.evidence.trim() : "";
  const files = Array.isArray(issue?.files)
    ? issue.files.filter((f) => typeof f === "string" && f.trim() !== "")
    : [];

  const timeline = useMemo(
    () => buildTimeline(headline, evidence, files.length),
    [headline, evidence, files.length]
  );

  const [t, setT] = useState(() => (prefersReducedMotion() ? Infinity : 0));
  const frameRef = useRef(0);
  const rootRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (prefersReducedMotion()) {
      setT(Infinity);
      return undefined;
    }

    setT(0);
    const startedAt = performance.now();
    const tick = (now) => {
      const elapsed = now - startedAt;
      if (elapsed >= timeline.end) {
        setT(Infinity);
        return;
      }
      setT(elapsed);
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [timeline]);

  const done = t >= timeline.end;

  const skip = (moveFocus = false) => {
    cancelAnimationFrame(frameRef.current);
    setT(Infinity);
    // The "Show all" button unmounts once the reveal completes; hand focus to
    // the card so keyboard users aren't dropped back to <body>.
    if (moveFocus) rootRef.current?.focus();
  };

  const headlineCount = typedCount(headline, t, timeline.headlineStart, timeline.headlineEnd);
  const evidenceCount = typedCount(evidence, t, timeline.evidenceStart, timeline.end);
  const typingHeadline = t > timeline.headlineStart && t < timeline.headlineEnd;
  const typingEvidence = t > timeline.evidenceStart && t < timeline.end;

  const variant = flagged ? "flagged" : "clear";
  const fileLabel = files.length === 1 ? "1 file implicated" : `${files.length} files implicated`;

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      className="issue-reveal"
      data-variant={variant}
      data-done={done ? "true" : "false"}
      aria-labelledby={titleId}
      onClick={done ? undefined : () => skip()}
    >
      <p className="sr-only" role="status">
        {done
          ? flagged
            ? `Analysis complete. Issue detected: ${headline}`
            : `Analysis complete. ${NO_ISSUE_TEXT}`
          : ""}
      </p>

      <header className="issue-head">
        <span className="issue-kicker">
          <span className="issue-kicker-dot" aria-hidden="true" />
          Analysis complete
        </span>
        {done ? (
          flagged &&
          files.length > 0 && <span className="issue-head-meta">{fileLabel}</span>
        ) : (
          <button
            type="button"
            className="issue-skip"
            onClick={(e) => {
              e.stopPropagation();
              skip(true);
            }}
          >
            Show all
          </button>
        )}
      </header>

      <div className="issue-body" aria-hidden={done ? undefined : "true"}>
        <div
          className={
            t >= timeline.statusAt ? "issue-status issue-staged is-in" : "issue-status issue-staged"
          }
        >
          <span className="issue-status-icon">{flagged ? <WarningIcon /> : <CheckIcon />}</span>
          <h2 className="issue-status-title" id={titleId}>
            {flagged ? "Issue detected" : "No issues detected"}
          </h2>
        </div>

        <div className="issue-section">
          <h3 className="issue-label">{flagged ? "Finding" : "Result"}</h3>
          <p className="issue-headline">
            <Typed text={headline} count={headlineCount} typing={typingHeadline} />
          </p>
        </div>

        {files.length > 0 && (
          <div
            className={
              t >= timeline.filesAt
                ? "issue-section issue-staged is-in"
                : "issue-section issue-staged"
            }
          >
            <h3 className="issue-label issue-label--reveal">
              {flagged ? "Affected files" : "Files referenced"}
            </h3>
            <ul className="issue-files">
              {files.map((file, i) => (
                <li key={`${i}:${file}`} className="issue-file" style={{ "--i": i }}>
                  <span className="issue-file-glyph" aria-hidden="true">
                    ▸
                  </span>
                  <code className="issue-file-path">
                    <FilePath path={file} />
                  </code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {evidence && (
          <div
            className={
              t >= timeline.evidenceStart - 150
                ? "issue-section issue-evidence issue-staged is-in"
                : "issue-section issue-evidence issue-staged"
            }
          >
            <h3 className="issue-label issue-label--reveal">{flagged ? "Evidence" : "Notes"}</h3>
            <p className="issue-evidence-text">
              <Typed text={evidence} count={evidenceCount} typing={typingEvidence} />
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
