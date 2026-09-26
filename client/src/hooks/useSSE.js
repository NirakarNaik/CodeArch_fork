import { useEffect, useReducer } from "react";

// State shape mirrors AppState in shared/types.ts, narrowed to what the stream drives.
const initialState = { nodes: [], issue: null, status: "connecting", errorMessage: null };

function reducer(state, action) {
  switch (action.type) {
    case "reset":
      return initialState;
    case "open":
      return state.status === "connecting" ? { ...state, status: "streaming" } : state;
    case "node": {
      const node = action.data;
      const i = state.nodes.findIndex((n) => n.id === node.id);
      // Re-emitted node ids replace in place so the graph doesn't duplicate boxes.
      const nodes = i === -1 ? [...state.nodes, node] : state.nodes.map((n, j) => (j === i ? node : n));
      return { ...state, nodes, status: "streaming" };
    }
    case "done":
      return { ...state, issue: action.data, status: "done" };
    case "error":
      if (state.status === "done") return state;
      return { ...state, status: "error", errorMessage: action.message };
    default:
      return state;
  }
}

function parse(e) {
  try {
    return JSON.parse(e.data);
  } catch {
    return undefined;
  }
}

/**
 * Subscribes to an SSE stream of SSEEvent messages (see shared/types.ts).
 * Pass url = null to stay idle in "connecting" (e.g. while the clone request is pending).
 * EventSourceImpl lets tests and ?mock mode swap in a fake EventSource.
 */
export function useSSE(url, { EventSourceImpl } = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!url) return undefined;

    const ES = EventSourceImpl || window.EventSource;
    const source = new ES(url);

    source.addEventListener("open", () => dispatch({ type: "open" }));

    source.addEventListener("node", (e) => {
      const data = parse(e);
      if (data) dispatch({ type: "node", data });
    });

    source.addEventListener("done", (e) => {
      dispatch({ type: "done", data: parse(e) ?? { issue: null, evidence: "", files: [] } });
      source.close();
    });

    // Fires for both server-sent `event: error` (has data) and connection failures (no data).
    // Always close: otherwise EventSource auto-reconnects and a replay stream would restart.
    source.addEventListener("error", (e) => {
      const data = e.data ? parse(e) : undefined;
      dispatch({ type: "error", message: data?.message || "Connection to the exploration stream failed." });
      source.close();
    });

    return () => source.close();
  }, [url, EventSourceImpl]);

  return state;
}
