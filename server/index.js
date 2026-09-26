import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import exploreRouter from "./routes/explore.js";
import demoRouter from "./routes/demo.js";

dotenv.config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "WARNING: ANTHROPIC_API_KEY is not set. Copy .env.example to server/.env and add your key."
  );
}

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/explore", exploreRouter);
app.use("/api/demo", demoRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`CodeArchaeologist server running on http://localhost:${PORT}`);
});
