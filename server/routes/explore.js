import { Router } from "express";
import { nanoid } from "nanoid";
import simpleGit from "simple-git";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runExploreLoop } from "../agent.js";
import { getCommitStats, clampCommitDepth, DEFAULT_COMMIT_DEPTH } from "../gitHistory.js";
import { computeClusters } from "../clustering.js";

const router = Router();
const sessions = new Map(); // sessionId -> { rootDir, running, timer }

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/;
const CLONE_TIMEOUT_MS = 30_000;
const MAX_REPO_FILES = 5000;
const SESSION_TTL_MS = 10 * 60_000;

function removeDir(dir) {
  fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
}

function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  sessions.delete(sessionId);
  removeDir(session.rootDir);
}

// Editors (VS Code etc.) inject GIT_EDITOR/GIT_ASKPASS, which simple-git
// refuses to pass through and which could pop a credentials prompt. Strip
// them and never let git block on a prompt for private/missing repos.
function cloneEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(GIT_|EDITOR$|VISUAL$|PAGER$|SSH_ASKPASS)/.test(k)) env[k] = v;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}

function countFiles(dir, limit) {
  let count = 0;
  const stack = [dir];
  while (stack.length && count <= limit) {
    const current = stack.pop();
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      if (e.isDirectory()) stack.push(path.join(current, e.name));
      else count += 1;
    }
  }
  return count;
}

// Express 4 doesn't catch rejected promises from async handlers: an uncaught
// throw becomes an unhandledRejection and kills the whole server. Any
// unexpected error here answers with clone_failed instead.
router.post("/start", async (req, res) => {
  try {
    await startSession(req, res);
  } catch (err) {
    console.error("Start failed unexpectedly:", err);
    if (!res.headersSent) res.status(500).json({ error: "clone_failed" });
  }
});

async function startSession(req, res) {
  const repoUrl = typeof req.body?.repoUrl === "string" ? req.body.repoUrl.trim() : "";
  if (!GITHUB_URL_RE.test(repoUrl)) {
    return res.status(400).json({ error: "invalid_url" });
  }

  const commitDepth = clampCommitDepth(req.body?.commitDepth ?? DEFAULT_COMMIT_DEPTH);
  const sessionId = nanoid(10);
  const rootDir = path.join(os.tmpdir(), `codearch-${sessionId}`);

  try {
    // Clone depth choice: clone commitDepth + 1 commits in one go rather than a
    // depth-1 clone plus a second `git fetch --deepen` (one network round trip,
    // one failure point). The +1 matters: in a shallow clone the oldest commit
    // has no parent, so `git log --name-only` would list every file in the repo
    // as touched by it. With one extra commit of history, all commitDepth
    // commits we analyze have their real parent. Repos with fewer commits just
    // clone whole.
    // A large global http.postBuffer (e.g. 500MB) makes git malloc that much
    // up front and fail under memory pressure; override it for our clones.
    await simpleGit({ timeout: { block: CLONE_TIMEOUT_MS }, config: ["http.postBuffer=10485760"] })
      .env(cloneEnv())
      .clone(repoUrl, rootDir, ["--depth", String(commitDepth + 1), "--single-branch", "--no-tags"]);
  } catch (err) {
    console.error("Clone failed:", err.message);
    removeDir(rootDir);
    return res.status(502).json({ error: "clone_failed" });
  }

  // git has reported success yet left no checkout (seen under memory
  // pressure), so verify before touching the folder.
  let fileCount;
  try {
    if (!fs.existsSync(path.join(rootDir, ".git"))) throw new Error("checkout missing after clone");
    fileCount = countFiles(rootDir, MAX_REPO_FILES);
  } catch (err) {
    console.error("Clone failed:", err.message);
    removeDir(rootDir);
    return res.status(502).json({ error: "clone_failed" });
  }
  if (fileCount > MAX_REPO_FILES) {
    removeDir(rootDir);
    return res.status(413).json({ error: "repo_too_large" });
  }

  // Commit history is computed once here, before the explore loop. A failure
  // is not fatal: exploration still runs, and the stream sends the
  // sparse-history fallback "direction" event instead of calling Claude.
  let history = null;
  try {
    const { commitStats, commitsAnalyzed, authorCount } = await getCommitStats(rootDir, commitDepth);
    if (commitsAnalyzed === 0) throw new Error("no commits found");
    history = { commitStats, commitsAnalyzed, authorCount, analysis: computeClusters(commitStats) };
    console.log(
      `[${sessionId}] history: ${commitsAnalyzed}/${commitDepth} commits, ${authorCount} authors, ` +
        `${commitStats.length} files, ${history.analysis.clusters.length} clusters`
    );
  } catch (err) {
    console.error(`[${sessionId}] Commit history unavailable, skipping direction analysis:`, err.message);
  }

  // Sessions whose stream is never opened are cleaned up after a while.
  const timer = setTimeout(() => endSession(sessionId), SESSION_TTL_MS);
  sessions.set(sessionId, { rootDir, running: false, timer, history });
  res.json({ sessionId, sseUrl: `/api/explore/stream/${sessionId}` });
}

router.get("/stream/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown_session" });
  }
  // One run per session: an EventSource auto-reconnect must not start a
  // second (billed) agent loop over the same checkout.
  if (session.running) {
    return res.status(409).json({ error: "already_running" });
  }
  session.running = true;
  clearTimeout(session.timer);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const controller = new AbortController();
  let closed = false;
  req.on("close", () => {
    closed = true;
    controller.abort();
  });

  const send = (event) => {
    if (closed) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  const heartbeat = setInterval(() => !closed && res.write(": ping\n\n"), 15_000);

  try {
    const h = session.history;
    await runExploreLoop(session.rootDir, send, h?.commitStats ?? null, {
      signal: controller.signal,
      analysis: h?.analysis,
      commitsAnalyzed: h?.commitsAnalyzed,
      authorCount: h?.authorCount,
    });
  } catch (err) {
    console.error("Explore loop failed:", err.message);
    send({ type: "error", data: { message: "Exploration failed: " + err.message } });
  } finally {
    clearInterval(heartbeat);
    endSession(sessionId);
    if (!closed) res.end();
  }
});

export default router;
