import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FilePath, Typed, plainText, prefersReducedMotion, typedCount } from "./revealText.jsx";

// Presents a ProjectDirection (shared/types.ts): where recent commits are
// concentrated, which files were untouched in the commit window, and which
// groups of files several people worked on. Everything shown comes from the
// payload; nothing is inferred beyond it. "Stale" only means "not changed in
// the period checked", so the copy never suggests anything is wrong with a file.

const isText = (v) => typeof v === "string" && v.trim() !== "";

function normalize(direction) {
  if (!direction || typeof direction !== "object") return null;
  const text = isText(direction.direction) ? direction.direction.trim() : "";
  const stale = Array.isArray(direction.staleFiles) ? direction.staleFiles.filter(isText) : [];
  const clusters = (Array.isArray(direction.activeClusters) ? direction.activeClusters : [])
    .map((c) => ({
      files: Array.isArray(c?.files) ? c.files.filter(isText) : [],
      authorCount: Number.isFinite(c?.authorCount) && c.authorCount > 0 ? c.authorCount : null,
    }))
    .filter((c) => c.files.length > 0);
  if (!text && stale.length === 0 && clusters.length === 0) return null;
  return { text, stale, clusters };
}

const contributors = (n) =>
  n === 1
    ? "1 contributor has recently changed files around these parts."
    : `${n} contributors have recently changed files around these parts.`;

function FileList({ files }) {
  return (
    <ul className="direction-files">
      {files.map((file, i) => (
        <li key={`${i}:${file}`} className="direction-file">
          <code>
            <FilePath path={file} />
          </code>
        </li>
      ))}
    </ul>
  );
}

// One rAF loop drives the beats, same approach as IssueReveal.
function buildTimeline(text) {
  const typeStart = 450;
  const typeEnd = text
    ? typeStart + Math.min(1300, Math.max(400, plainText(text).length * 7))
    : typeStart;
  return { titleAt: 150, typeStart, typeEnd, listsAt: typeEnd + 150, end: typeEnd + 550 };
}

export default function DirectionReveal({ direction }) {
  const data = useMemo(() => normalize(direction), [direction]);
  const timeline = useMemo(() => buildTimeline(data?.text || ""), [data]);
  const [t, setT] = useState(() => (prefersReducedMotion() ? Infinity : 0));
  const frameRef = useRef(0);
  const titleId = useId();

  useEffect(() => {
    if (!data) return undefined;
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
  }, [data, timeline]);

  // No direction (or an unusable payload): render nothing, never an empty panel.
  if (!data) return null;

  const done = t >= timeline.end;
  const skip = () => {
    cancelAnimationFrame(frameRef.current);
    setT(Infinity);
  };
  const sparse = data.stale.length === 0 && data.clusters.length === 0;

  return (
    <section
      className="direction-reveal"
      data-sparse={sparse ? "true" : "false"}
      data-done={done ? "true" : "false"}
      aria-labelledby={titleId}
      onClick={done ? undefined : skip}
    >
      <p className="sr-only" role="status">
        {done ? `Where the project is moving. ${plainText(data.text)}` : ""}
      </p>

      <header className="direction-head">
        <span className="direction-kicker">
          <span className="direction-kicker-mark" aria-hidden="true" />
          Project history
        </span>
        <span className="direction-head-meta">From its recent changes (commits)</span>
      </header>

      <div className="direction-body" aria-hidden={done ? undefined : "true"}>
        <h2 className={t >= timeline.titleAt ? "direction-title is-in" : "direction-title"} id={titleId}>
          Where the project is moving
        </h2>

        {data.text && (
          <p className="direction-text">
            <Typed
              text={data.text}
              count={typedCount(data.text, t, timeline.typeStart, timeline.typeEnd)}
              typing={t > timeline.typeStart && t < timeline.typeEnd}
            />
          </p>
        )}

        <div className={t >= timeline.listsAt ? "direction-groups is-in" : "direction-groups"}>
          <div className="direction-group" data-kind="active">
            <h3 className="direction-group-title">
              Busy areas <span className="direction-tag">active clusters</span>
            </h3>
            {data.clusters.length > 0 ? (
              <>
                <p className="direction-group-help">
                  Parts of the project that changed recently, often worked on together.
                </p>
                {data.clusters.map((cluster, i) => (
                  <div key={i} className="direction-cluster">
                    <FileList files={cluster.files} />
                    {cluster.authorCount && (
                      <p className="direction-people">{contributors(cluster.authorCount)}</p>
                    )}
                  </div>
                ))}
              </>
            ) : (
              <p className="direction-empty">No concentrated area of recent work stood out.</p>
            )}
          </div>

          <div className="direction-group" data-kind="quiet">
            <h3 className="direction-group-title">
              Quiet parts <span className="direction-tag">stale</span>
            </h3>
            {data.stale.length > 0 ? (
              <>
                <p className="direction-group-help">
                  These parts haven't been changed during the period we checked. That doesn't mean
                  anything is wrong with them.
                </p>
                <FileList files={data.stale} />
              </>
            ) : (
              <p className="direction-empty">
                Nothing stood out as quiet during the period we checked.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
