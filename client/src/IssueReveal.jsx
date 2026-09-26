import { useEffect, useId, useMemo, useRef, useState } from "react";

const NO_ISSUE_TEXT = "No notable issue flagged this run.";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

// `evidence` is a plain string (FlaggedIssue contract). It may optionally be
// written as labelled paragraphs, which lets the reveal explain the finding in
// plain language before the technical detail:
//
//   Think of it like this: <everyday analogy; "Name: line" rows become quotes>
//   Loop: Order part (a.js) → Inventory part (b.js) → Order part (a.js)
//   What is happening: …          Technical name: …
//   Why it matters: …             Files: a.js — what it does (one per line)
//   Possible fix: …               Technical fix: …
//   Technical detail: …
//
// Evidence without any recognised label renders exactly as before, as a
// single evidence block.
const EVIDENCE_LABELS = [
  [/^(?:think of it like this|analogy)$/i, "analogy"],
  [/^loop$/i, "loop"],
  [/^what(?:'s| is) happening\??$/i, "what"],
  [/^technical name$/i, "term"],
  [/^why (?:it matters|should i care\??)$/i, "why"],
  [/^files$/i, "notes"],
  [/^(?:possible |suggested )?fix$/i, "fix"],
  [/^technical fix$/i, "techFix"],
  [/^technical (?:detail|details|evidence)$/i, "tech"],
];

function parseEvidence(evidence) {
  const parts = {};
  const loose = [];
  for (const raw of evidence.split(/\n\s*\n/)) {
    const para = raw.trim();
    if (!para) continue;
    const m = /^([A-Za-z' ]{2,40}\??):\s+([\s\S]+)$/.exec(para);
    const key = m && EVIDENCE_LABELS.find(([re]) => re.test(m[1].trim()))?.[1];
    if (key && !parts[key]) parts[key] = m[2].trim();
    else loose.push(para);
  }
  if (Object.keys(parts).length === 0) return null;
  // Nothing is dropped: unlabelled paragraphs join the technical evidence.
  if (loose.length) parts.tech = [parts.tech, ...loose].filter(Boolean).join("\n\n");

  if (parts.loop) {
    const steps = parts.loop
      .split(/\s*(?:→|->)\s*/)
      .filter(Boolean)
      .map((step) => {
        const named = /^(.*?)\s*\(([^)]+)\)$/.exec(step);
        return named ? { name: named[1], file: named[2] } : { name: null, file: step };
      });
    if (steps.length >= 2) parts.loop = steps;
    else delete parts.loop;
  }

  if (parts.notes) {
    const notes = {};
    for (const line of parts.notes.split("\n")) {
      const note = /^(\S+)\s+(?:—|–|-)\s+(.+)$/.exec(line.trim());
      if (note) notes[note[1]] = note[2];
    }
    parts.notes = notes;
  }
  return parts;
}

// All reveal beats derive from one elapsed-time value, so there is exactly one
// rAF loop to clean up. Each block either types its text or fades in; typing
// durations are capped so the whole sequence stays around 3–5s.
function buildTimeline(headline, blocks) {
  const statusAt = 250;
  const headlineStart = 550;
  const headlineEnd = headlineStart + clamp(headline.length * 12, 450, 1300);
  const at = {};
  let cursor = headlineEnd;
  for (const block of blocks) {
    const start = cursor + 150;
    if (block.typed) {
      const typeStart = start + 150;
      const end = typeStart + clamp(block.typed.length * block.rate, 350, block.max);
      at[block.key] = { start, typeStart, end };
      cursor = end;
    } else {
      cursor = start + (block.count ? 250 + Math.min(block.count, 6) * 70 : 380);
      at[block.key] = { start, end: cursor };
    }
  }
  return { statusAt, headlineStart, headlineEnd, at, end: cursor };
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

// `backtick` spans render as inline code.
function Inline({ text }) {
  return text.split(/`([^`]+)`/).map((chunk, i) => (i % 2 ? <code key={i}>{chunk}</code> : chunk));
}

// Paragraphs split on blank lines.
function Prose({ text, className }) {
  return text.split(/\n\s*\n/).map((para, i) => (
    <p key={i} className={className}>
      <Inline text={para} />
    </p>
  ));
}

// Analogy lines shaped "Name: words" render as short quotes.
function Analogy({ text }) {
  return (
    <div className="issue-analogy">
      {text.split("\n").map((line, i) => {
        const quote = /^([A-Z][A-Za-z ]{0,20}):\s+(.+)$/.exec(line.trim());
        return quote ? (
          <p key={i} className="issue-quote">
            <span className="issue-quote-who">{quote[1]}</span>
            <span className="issue-quote-text">{quote[2]}</span>
          </p>
        ) : (
          <p key={i} className="issue-prose">
            <Inline text={line} />
          </p>
        );
      })}
    </div>
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

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

// A → B → A, drawn top to bottom. Each arrow reads "needs".
function LoopDiagram({ steps }) {
  const closes = steps.length > 2 && steps[steps.length - 1].file === steps[0].file;
  return (
    <ol className="issue-loop">
      {steps.map((step, i) => (
        <li key={i} className="issue-loop-step">
          {i > 0 && (
            <span className="issue-loop-link">
              <span className="issue-loop-arrow" aria-hidden="true">
                ↓
              </span>
              needs
            </span>
          )}
          <span
            className={
              closes && (i === 0 || i === steps.length - 1)
                ? "issue-loop-node is-repeat"
                : "issue-loop-node"
            }
          >
            {step.name ? (
              <>
                <span className="issue-loop-name">{step.name}</span>
                <code className="issue-loop-file">{baseName(step.file)}</code>
              </>
            ) : (
              <code className="issue-loop-file">
                <FilePath path={step.file} />
              </code>
            )}
          </span>
          {closes && i === steps.length - 1 && (
            <span className="issue-loop-back">↺ back where it started</span>
          )}
        </li>
      ))}
    </ol>
  );
}

// Numbered like a report so the card reads top to bottom at a glance.
function SectionLabel({ index, reveal = false, children }) {
  return (
    <h3 className={reveal ? "issue-label issue-label--reveal" : "issue-label"}>
      <span className="issue-label-index" aria-hidden="true">
        {String(index).padStart(2, "0")}
      </span>
      {children}
    </h3>
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

  const parts = useMemo(() => (evidence ? parseEvidence(evidence) : null), [evidence]);

  // Order of the staged blocks after the headline.
  const blocks = useMemo(() => {
    const list = [];
    const addFiles = () => files.length && list.push({ key: "files", count: files.length });
    if (parts) {
      if (parts.analogy) list.push({ key: "analogy" });
      if (parts.what || parts.loop || parts.term) list.push({ key: "what" });
      if (parts.why) list.push({ key: "why" });
      addFiles();
      if (parts.fix || parts.techFix) list.push({ key: "fix" });
      if (parts.tech) list.push({ key: "tech" });
    } else {
      addFiles();
      if (evidence) list.push({ key: "evidence", typed: evidence, rate: 9, max: 1400 });
    }
    return list;
  }, [parts, evidence, files.length]);

  const timeline = useMemo(() => buildTimeline(headline, blocks), [headline, blocks]);

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

  // The reveal lands below the graph; bring it into view once, on arrival.
  useEffect(() => {
    rootRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
    });
  }, []);

  const done = t >= timeline.end;

  const skip = (moveFocus = false) => {
    cancelAnimationFrame(frameRef.current);
    setT(Infinity);
    // The "Show all" button unmounts once the reveal completes; hand focus to
    // the card so keyboard users aren't dropped back to <body>.
    if (moveFocus) rootRef.current?.focus();
  };

  const headlineCount = typedCount(headline, t, timeline.headlineStart, timeline.headlineEnd);
  const typingHeadline = t > timeline.headlineStart && t < timeline.headlineEnd;

  const shown = (key) => t >= timeline.at[key].start;
  const typedProps = (key, text) => {
    const beat = timeline.at[key];
    return {
      text,
      count: typedCount(text, t, beat.typeStart, beat.end),
      typing: t > beat.typeStart && t < beat.end,
    };
  };
  const stagedClass = (key, extra) =>
    `issue-section issue-staged ${extra}${shown(key) ? " is-in" : ""}`;

  // Section numbers follow reveal order; the finding is always 01.
  const num = (key) => blocks.findIndex((b) => b.key === key) + 2;

  const variant = flagged ? "flagged" : "clear";
  const fileLabel = files.length === 1 ? "1 file implicated" : `${files.length} files implicated`;
  const notes = parts?.notes || {};
  const piecesLabel =
    files.length === 1
      ? "The piece involved"
      : `The ${NUMBER_WORDS[files.length] || files.length} pieces involved`;

  const filesSection = files.length > 0 && (
    <div className={stagedClass("files", "issue-where")}>
      <SectionLabel index={num("files")} reveal>
        {parts ? piecesLabel : flagged ? "Affected files" : "Files referenced"}
      </SectionLabel>
      <ul className="issue-files">
        {files.map((file, i) => (
          <li key={`${i}:${file}`} className="issue-file" style={{ "--i": i }}>
            <span className="issue-file-glyph" aria-hidden="true">
              ▸
            </span>
            <span className="issue-file-body">
              <code className="issue-file-path">
                <FilePath path={file} />
              </code>
              {notes[file] && <span className="issue-file-note">{notes[file]}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      className="issue-reveal"
      data-variant={variant}
      data-layout={parts ? "explained" : "plain"}
      data-done={done ? "true" : "false"}
      aria-labelledby={titleId}
      onClick={done ? undefined : () => skip()}
    >
      <p className="sr-only" role="status">
        {done
          ? flagged
            ? `Investigation complete. We found a problem: ${headline}`
            : `Investigation complete. ${NO_ISSUE_TEXT}`
          : ""}
      </p>

      <header className="issue-head">
        <span className="issue-kicker">
          <span className="issue-kicker-dot" aria-hidden="true" />
          Investigation complete
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
            {flagged ? "We found a problem" : "No problem found"}
          </h2>
        </div>

        <div className="issue-section issue-finding">
          <SectionLabel index={1}>{flagged ? "What Claude found" : "Result"}</SectionLabel>
          <p className="issue-headline">
            <Typed text={headline} count={headlineCount} typing={typingHeadline} />
          </p>
        </div>

        {parts ? (
          <>
            {parts.analogy && (
              <div className={stagedClass("analogy", "issue-analogy-section")}>
                <SectionLabel index={num("analogy")} reveal>
                  Think of it like this
                </SectionLabel>
                <Analogy text={parts.analogy} />
              </div>
            )}

            {(parts.what || parts.loop || parts.term) && (
              <div className={stagedClass("what", "issue-what")}>
                <SectionLabel index={num("what")} reveal>
                  What is happening in this project
                </SectionLabel>
                {parts.loop && <LoopDiagram steps={parts.loop} />}
                {parts.what && <Prose text={parts.what} className="issue-prose" />}
                {parts.term && (
                  <p className="issue-term">
                    <span className="issue-term-label">Technical name</span>
                    <span className="issue-term-value">{parts.term}</span>
                  </p>
                )}
              </div>
            )}

            {parts.why && (
              <div className={stagedClass("why", "issue-why")}>
                <SectionLabel index={num("why")} reveal>
                  Why should I care?
                </SectionLabel>
                <Prose text={parts.why} className="issue-prose" />
              </div>
            )}

            {filesSection}

            {(parts.fix || parts.techFix) && (
              <div className={stagedClass("fix", "issue-fix")}>
                <SectionLabel index={num("fix")} reveal>
                  Possible fix
                </SectionLabel>
                {parts.fix && <Prose text={parts.fix} className="issue-prose" />}
                {parts.techFix && (
                  <p className="issue-term">
                    <span className="issue-term-label">Technical fix</span>
                    <span className="issue-term-value">
                      <Inline text={parts.techFix} />
                    </span>
                  </p>
                )}
              </div>
            )}

            {parts.tech && (
              <div className={stagedClass("tech", "issue-tech")}>
                <SectionLabel index={num("tech")} reveal>
                  For developers — technical evidence
                </SectionLabel>
                <Prose text={parts.tech} className="issue-tech-text" />
              </div>
            )}
          </>
        ) : (
          <>
            {filesSection}

            {evidence && (
              <div className={stagedClass("evidence", "issue-evidence")}>
                <SectionLabel index={num("evidence")} reveal>
                  {flagged ? "Evidence" : "Notes"}
                </SectionLabel>
                <p className="issue-evidence-text">
                  <Typed {...typedProps("evidence", evidence)} />
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
