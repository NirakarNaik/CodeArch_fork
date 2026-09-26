// Shared contract reference. This project runs as plain JS, so this file is
// documentation of the exact shapes everyone should match — not compiled.
// Owner: Member 1. Frozen after the first 15 minutes unless a real bug is found.

export interface GraphNode {
  id: string;
  file: string;
  role: string;
  imports: string[];
  importance: "core" | "support" | "config";
  // Computed server-side from git history, never supplied by Claude.
  activity: "active" | "stale";
  authorCount: number;
  clusterId: string | null;
}

export interface CommitStats {
  file: string;
  touchCount: number;
  distinctAuthors: number;
  lastTouchedDaysAgo: number;
}

export interface ProjectDirection {
  direction: string;
  staleFiles: string[];
  activeClusters: { files: string[]; authorCount: number }[];
}

export interface FlaggedIssue {
  issue: string | null;
  evidence: string;
  files: string[];
}

export interface StartExploreRequest {
  repoUrl: string;
  commitDepth?: number; // default 25, clamped to 10-50
}

export interface StartExploreResponse {
  sessionId: string;
  sseUrl: string;
}

// Live stream order: node* -> done -> direction, then the server closes the
// stream. Clients must not close the EventSource on "done" or they will miss
// "direction"; close on "direction" (or "error") instead.
export type SSEEvent =
  | { type: "node"; data: GraphNode }
  | { type: "done"; data: FlaggedIssue }
  | { type: "direction"; data: ProjectDirection }
  | { type: "error"; data: { message: string } };

export interface AppState {
  status: "idle" | "cloning" | "exploring" | "done" | "error";
  nodes: GraphNode[];
  issue: FlaggedIssue | null;
  errorMessage: string | null;
}
