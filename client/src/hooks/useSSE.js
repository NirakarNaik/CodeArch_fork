import { useEffect, useReducer } from "react";

/**
 * Event shapes (see shared/types.ts, owned by Member 1). GraphNode may also carry
 *   activity: "active" | "stale", authorCount: number, clusterId: string | null
 * and the stream may send a final `direction` event. ProjectDirection isn't pinned down in
 * shared/types.ts yet; the frontend only relies on these fields and treats the rest as optional:
 *   { staleFiles?: string[], activeClusters?: { id?: string, label?: string, files: string[] }[] }
 */

// State shape mirrors AppState in shared/types.ts, narrowed to what the stream drives.
const initialState = { nodes: [], issue: null, direction: null, status: "connecting", errorMessage: null };

// `direction` may arrive after `done`, so the stream stays open after `done` until the server
// ends it (which surfaces as an error event, ignored once done). This is only a backstop.
export const DONE_GRACE_MS = 5000;

function reducer(state, action) {
  switch (action.type) {
    case "reset":
      return initialState;
    case "open":
      return state.status === "connecting" ? { ...state, status: "streaming" } : state;
    case "node": {
      const node = action.data;
      // Ids aren't guaranteed stable across backends (the first one minted a random id per
      // emit_node), so match on id or path and replace in place, keeping the original id so
      // the box keeps its slot and doesn't re-fade.
      const key = normalizeFile(node.file);
      const i = state.nodes.findIndex((n) => n.id === node.id || normalizeFile(n.file) === key);
      const nodes =
        i === -1
          ? [...state.nodes, node]
          : state.nodes.map((n, j) => (j === i ? { ...node, id: n.id } : n));
      // A late node after `done` (the stream stays open for `direction`) must not reopen the run.
      return { ...state, nodes, status: state.status === "done" ? "done" : "streaming" };
    }
    case "done":
      return { ...state, issue: action.data, status: "done" };
    case "direction":
      return { ...state, direction: action.data };
    case "error":
      if (state.status === "done") return state;
      return { ...state, status: "error", errorMessage: action.message };
    default:
      return state;
  }
}

const normalizeFile = (p) => (p || "").replace(/^\.?\//, "");

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
    let graceTimer = null;

    source.addEventListener("open", () => dispatch({ type: "open" }));

    source.addEventListener("node", (e) => {
      const data = parse(e);
      if (data) dispatch({ type: "node", data });
    });

    source.addEventListener("done", (e) => {
      dispatch({ type: "done", data: parse(e) ?? { issue: null, evidence: "", files: [] } });
      graceTimer = setTimeout(() => source.close(), DONE_GRACE_MS);
    });

    source.addEventListener("direction", (e) => {
      const data = parse(e);
      if (data && typeof data === "object") dispatch({ type: "direction", data });
    });

    // Fires for both server-sent `event: error` (has data) and connection failures (no data).
    // Always close: otherwise EventSource auto-reconnects and a replay stream would restart.
    source.addEventListener("error", (e) => {
      const data = e.data ? parse(e) : undefined;
      dispatch({ type: "error", message: data?.message || "Connection to the exploration stream failed." });
      source.close();
    });

    return () => {
      clearTimeout(graceTimer);
      source.close();
    };
  }, [url, EventSourceImpl]);

  return state;
}
