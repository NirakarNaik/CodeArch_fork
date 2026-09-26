import { useState } from "react";
import LandingInput from "./LandingInput.jsx";
import ExploreView from "./ExploreView.jsx";

export default function App() {
  const [repoUrl, setRepoUrl] = useState(null);
  // How many recent commits to analyse (StartExploreRequest.commitDepth).
  // null = not chosen, so ExploreView omits it and the server uses its default.
  const [commitDepth, setCommitDepth] = useState(null);
  const [demo, setDemo] = useState(false);

  const start = (url, depth) => {
    setRepoUrl(url);
    setCommitDepth(Number.isInteger(depth) ? depth : null);
  };

  const reset = () => {
    setRepoUrl(null);
    setCommitDepth(null);
    setDemo(false);
  };

  return (
    <div className="app">
      {!repoUrl && !demo ? (
        <LandingInput onSubmit={start} onDemo={() => setDemo(true)} />
      ) : (
        <ExploreView
          repoUrl={repoUrl}
          commitDepth={commitDepth ?? undefined}
          demo={demo}
          onReset={reset}
        />
      )}
    </div>
  );
}
