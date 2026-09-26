import { useEffect, useReducer } from "react";

/**
 * Event shapes: see shared/types.ts (owned by Member 1). Live stream order is
 *   node* -> done -> direction, then the server closes the stream.
 * GraphNode carries activity / authorCount / clusterId; ProjectDirection is
 *   { direction: string, staleFiles: string[], activeClusters: { files: string[], authorCount: number }[] }
 * Per the contract the client must not close on `done` (it would miss `direction`): it closes on
 * `direction` or `error`. Streams without a direction event (demo replay, older backends) end
 * when the server closes them, which arrives as an error event and is ignored once done.
 */

// State shape mirrors AppState in shared/types.ts, narrowed to what the stream drives.
const initialState = { nodes: [], issue: null, direction: null, status: "connecting", errorMessage: null, stalled: false };

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
    case "stall":
      return { ...state, stalled: true };
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
 * stallMs (optional): if no event arrives for this long (including the wait for `direction`
 * after `done`), the stream is closed and `stalled` becomes true. Server heartbeat comments
 * are not events, so they don't mask a stall.
 */
export function useSSE(url, { EventSourceImpl, stallMs = null } = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!url) return undefined;

    const ES = EventSourceImpl || window.EventSource;
    const source = new ES(url);

    let stallTimer = null;
    const stopStallTimer = () => clearTimeout(stallTimer);
    const armStallTimer = () => {
      stopStallTimer();
      if (!stallMs) return;
      stallTimer = setTimeout(() => {
        source.close(); // also tells the server to abort the (billed) run
        dispatch({ type: "stall" });
      }, stallMs);
    };
    armStallTimer();

    source.addEventListener("open", () => dispatch({ type: "open" }));

    source.addEventListener("node", (e) => {
      armStallTimer();
      const data = parse(e);
      if (data) dispatch({ type: "node", data });
    });

    source.addEventListener("done", (e) => {
      armStallTimer(); // still waiting for `direction`
      dispatch({ type: "done", data: parse(e) ?? { issue: null, evidence: "", files: [] } });
    });

    source.addEventListener("direction", (e) => {
      stopStallTimer();
      const data = parse(e);
      if (data && typeof data === "object") dispatch({ type: "direction", data });
      source.close(); // last event of a live run
    });

    // Fires for both server-sent `event: error` (has data) and connection failures (no data).
    // Always close: otherwise EventSource auto-reconnects and a replay stream would restart.
    source.addEventListener("error", (e) => {
      stopStallTimer(); // stream is over either way
      const data = e.data ? parse(e) : undefined;
      dispatch({ type: "error", message: data?.message || "Connection to the exploration stream failed." });
      source.close();
    });

    return () => {
      stopStallTimer();
      source.close();
    };
  }, [url, EventSourceImpl, stallMs]);

  return state;
}
