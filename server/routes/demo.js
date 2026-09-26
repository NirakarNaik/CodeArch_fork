import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

router.get("/replay", (_req, res) => {
  const log = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../demo-log.json"), "utf-8")
  );

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  let i = 0;
  const sendNext = () => {
    if (i >= log.length) {
      res.end();
      return;
    }
    const evt = log[i];
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    i += 1;
    setTimeout(sendNext, evt.delayMs || 400);
  };
  sendNext();
});

export default router;
