// Shared contract reference. This project runs as plain JS, so this file is
// documentation of the exact shapes everyone should match — not compiled.
// Owner: Member 1. Frozen after the first 15 minutes unless a real bug is found.

export interface GraphNode {
  id: string;
  file: string;
  role: string;
  imports: string[];
  importance: "core" | "support" | "config";
}

export interface FlaggedIssue {
  issue: string | null;
  evidence: string;
  files: string[];
}

export interface StartExploreRequest {
  repoUrl: string;
}

export interface StartExploreResponse {
  sessionId: string;
  sseUrl: string;
}

export type SSEEvent =
  | { type: "node"; data: GraphNode }
  | { type: "done"; data: FlaggedIssue }
  | { type: "error"; data: { message: string } };

export interface AppState {
  status: "idle" | "cloning" | "exploring" | "done" | "error";
  nodes: GraphNode[];
  issue: FlaggedIssue | null;
  errorMessage: string | null;
}
