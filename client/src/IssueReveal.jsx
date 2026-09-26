import { useEffect, useState } from "react";

export default function IssueReveal({ issue }) {
  const [displayed, setDisplayed] = useState("");
  const fullText = issue.issue
    ? `⚠ ${issue.issue} — ${issue.evidence}`
    : "No notable issue flagged this run.";

  useEffect(() => {
    setDisplayed("");
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      setDisplayed(fullText.slice(0, i));
      if (i >= fullText.length) clearInterval(interval);
    }, 15);
    return () => clearInterval(interval);
  }, [fullText]);

  return (
    <div className="issue-reveal">
      <p>{displayed}</p>
      {issue.files?.length > 0 && (
        <div className="issue-files">{issue.files.join(", ")}</div>
      )}
    </div>
  );
}
