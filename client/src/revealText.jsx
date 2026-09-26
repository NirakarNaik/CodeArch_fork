// Shared by IssueReveal and DirectionReveal so both panels type and render text
// the same way. Kept in its own module so neither component imports the other.

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

// `backtick` spans become code segments; everything else is plain text.
const segmentsOf = (text) =>
  text
    .split(/`([^`]+)`/)
    .map((chunk, i) => ({ text: chunk, code: i % 2 === 1 }))
    .filter((seg) => seg.text);

// Text as a reader sees it (no backticks) — what gets typed and announced.
export const plainText = (text) => text.replace(/`([^`]+)`/g, "$1");

export function typedCount(text, t, start, end) {
  const length = plainText(text).length;
  if (t <= start) return 0;
  if (t >= end) return length;
  return Math.round(((t - start) / (end - start)) * length);
}

// The untyped remainder stays in the DOM as `visibility: hidden`, so the card
// is laid out at its final size from the first frame and never jumps. Code
// segments type in as <code>, so backticks never show.
export function Typed({ text, count, typing }) {
  const shown = [];
  const rest = [];
  let remaining = count;
  segmentsOf(text).forEach((seg, i) => {
    const take = Math.max(0, Math.min(seg.text.length, remaining));
    remaining -= take;
    const Tag = seg.code ? "code" : "span";
    if (take) shown.push(<Tag key={`s${i}`}>{seg.text.slice(0, take)}</Tag>);
    if (take < seg.text.length) rest.push(<Tag key={`r${i}`}>{seg.text.slice(take)}</Tag>);
  });
  return (
    <>
      {shown}
      {typing && <span className="typed-caret" aria-hidden="true" />}
      <span className="typed-rest">{rest}</span>
    </>
  );
}

export function FilePath({ path }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <>
      {cut > 0 && <span className="issue-file-dir">{path.slice(0, cut)}</span>}
      <span className="issue-file-name">{path.slice(cut)}</span>
    </>
  );
}
