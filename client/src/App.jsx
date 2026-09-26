import { useState } from "react";
import LandingInput from "./LandingInput.jsx";
import ExploreView from "./ExploreView.jsx";

export default function App() {
  const [repoUrl, setRepoUrl] = useState(null);
  const [demo, setDemo] = useState(false);

  const reset = () => {
    setRepoUrl(null);
    setDemo(false);
  };

  return (
    <div className="app">
      {!repoUrl && !demo ? (
        <LandingInput onSubmit={setRepoUrl} onDemo={() => setDemo(true)} />
      ) : (
        <ExploreView repoUrl={repoUrl} demo={demo} onReset={reset} />
      )}
    </div>
  );
}
