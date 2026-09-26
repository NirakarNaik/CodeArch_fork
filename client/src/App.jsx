import { useState } from "react";
import LandingInput from "./LandingInput.jsx";
import ExploreView from "./ExploreView.jsx";

export default function App() {
  const [repoUrl, setRepoUrl] = useState(null);

  return (
    <div className="app">
      {!repoUrl ? (
        <LandingInput onSubmit={setRepoUrl} />
      ) : (
        <ExploreView repoUrl={repoUrl} onReset={() => setRepoUrl(null)} />
      )}
    </div>
  );
}
