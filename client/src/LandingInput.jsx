import { useState } from "react";

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;

export default function LandingInput({ onSubmit }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const isValid = GITHUB_URL_RE.test(value.trim());

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!isValid) {
      setError("Enter a valid GitHub repo URL, e.g. https://github.com/owner/repo");
      return;
    }
    setError("");
    onSubmit(value.trim());
  };

  return (
    <div className="landing">
      <h1>CodeArchaeologist</h1>
      <p className="subtitle">Watch Claude Opus 5.5 explore a codebase live.</p>
      <form onSubmit={handleSubmit} className="landing-form">
        <input
          type="text"
          placeholder="https://github.com/owner/repo"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" disabled={!isValid}>
          Explore
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
