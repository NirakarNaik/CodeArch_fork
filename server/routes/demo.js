import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "../demo-log.json");
const router = Router();

router.get("/replay", (req, res) => {
  let log;
  try {
    log = JSON.parse(fs.readFileSync(LOG_PATH, "utf-8"));
  } catch (err) {
    return res.status(500).json({ error: "demo_log_unavailable" });
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let timer;
  let closed = false;
  req.on("close", () => {
    closed = true;
    clearTimeout(timer);
  });

  // delayMs is the gap before each event, matching when it arrived in the
  // original live run.
  let i = 0;
  const scheduleNext = () => {
    if (closed) return;
    if (i >= log.length) {
      res.end();
      return;
    }
    const evt = log[i];
    timer = setTimeout(() => {
      if (closed) return;
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
      i += 1;
      scheduleNext();
    }, evt.delayMs ?? 400);
  };
  scheduleNext();
});

export default router;
