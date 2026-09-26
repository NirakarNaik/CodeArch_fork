import { useEffect, useState } from "react";

export function useSSE(url) {
  const [nodes, setNodes] = useState([]);
  const [issue, setIssue] = useState(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    if (!url) return undefined;

    setNodes([]);
    setIssue(null);
    setStatus("connecting");

    const source = new EventSource(url);

    source.onopen = () => setStatus("streaming");

    source.addEventListener("node", (e) => {
      const data = JSON.parse(e.data);
      setNodes((prev) => [...prev, data]);
    });

    source.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      setIssue(data);
      setStatus("done");
      source.close();
    });

    source.addEventListener("error", () => {
      setStatus("error");
      source.close();
    });

    source.onerror = () => {
      setStatus((prev) => (prev === "done" ? prev : "error"));
      source.close();
    };

    return () => source.close();
  }, [url]);

  return { nodes, issue, status };
}
