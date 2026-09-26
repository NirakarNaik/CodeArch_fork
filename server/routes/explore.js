import { Router } from "express";
import { nanoid } from "nanoid";
import simpleGit from "simple-git";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runExploreLoop } from "../agent.js";

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

router.post("/start", async (req, res) => {
  const repoUrl = typeof req.body?.repoUrl === "string" ? req.body.repoUrl.trim() : "";
  if (!GITHUB_URL_RE.test(repoUrl)) {
    return res.status(400).json({ error: "invalid_url" });
  }

  const sessionId = nanoid(10);
  const rootDir = path.join(os.tmpdir(), `codearch-${sessionId}`);

  try {
    await simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } })
      .env(cloneEnv())
      .clone(repoUrl, rootDir, ["--depth", "1", "--single-branch", "--no-tags"]);
  } catch (err) {
    console.error("Clone failed:", err.message);
    removeDir(rootDir);
    return res.status(502).json({ error: "clone_failed" });
  }

  if (countFiles(rootDir, MAX_REPO_FILES) > MAX_REPO_FILES) {
    removeDir(rootDir);
    return res.status(413).json({ error: "repo_too_large" });
  }

  // Sessions whose stream is never opened are cleaned up after a while.
  const timer = setTimeout(() => endSession(sessionId), SESSION_TTL_MS);
  sessions.set(sessionId, { rootDir, running: false, timer });
  res.json({ sessionId, sseUrl: `/api/explore/stream/${sessionId}` });
});

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
    await runExploreLoop(session.rootDir, send, { signal: controller.signal });
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
