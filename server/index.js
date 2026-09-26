import "./env.js";
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import exploreRouter from "./routes/explore.js";
import demoRouter from "./routes/demo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const liveAvailable = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

if (!liveAvailable) {
  console.warn(
    "WARNING: ANTHROPIC_API_KEY is not set. Live exploration is disabled; Demo Mode still works.\n" +
      "         Copy .env.example to server/.env and add your key to enable it."
  );
}

const app = express();
app.use(cors());
app.use(express.json());

// Without a key, refuse up front instead of cloning the repo and then failing
// on the first model call.
app.post("/api/explore/start", (_req, res, next) => {
  if (liveAvailable) return next();
  res.status(503).json({ error: "live_unavailable" });
});

app.use("/api/explore", exploreRouter);
app.use("/api/demo", demoRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true, live: liveAvailable }));

app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

// Serve the built client from the same origin, so the whole app is one URL.
const clientDist = path.resolve(__dirname, "../client/dist");
if (fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
} else {
  console.warn("WARNING: client/dist not found. Run `npm run dev` from the repo root to build it.");
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`CodeArchaeologist running on http://localhost:${PORT}`);
});
