import { Router } from "express";
import { nanoid } from "nanoid";
import simpleGit from "simple-git";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { runExploreLoop } from "../agent.js";

const router = Router();
const sessions = new Map(); // sessionId -> rootDir

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;

router.post("/start", async (req, res) => {
  const { repoUrl } = req.body || {};
  if (!repoUrl || !GITHUB_URL_RE.test(repoUrl)) {
    return res.status(400).json({ error: "invalid_url" });
  }

  const sessionId = nanoid(10);
  const tempDir = path.join(os.tmpdir(), `codearch-${sessionId}`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    await simpleGit().clone(repoUrl, tempDir, ["--depth", "1"]);
    sessions.set(sessionId, tempDir);
    res.json({ sessionId, sseUrl: `/api/explore/stream/${sessionId}` });
  } catch (err) {
    res.status(500).json({ error: "clone_failed" });
  }
});

router.get("/stream/:sessionId", async (req, res) => {
  const rootDir = sessions.get(req.params.sessionId);
  if (!rootDir) {
    res.status(404).end();
    return;
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  };

  try {
    await runExploreLoop(rootDir, send);
  } catch (err) {
    send({ type: "error", data: { message: err.message } });
  }
  res.end();
});

export default router;
