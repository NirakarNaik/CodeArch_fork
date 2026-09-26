// Imported first by index.js. ES module imports are evaluated before the
// importing module's body, so calling dotenv.config() inside index.js ran
// *after* agent.js had already constructed its Anthropic client without a key.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// server/.env is the documented location; a repo-root .env also works.
// dotenv never overrides variables that are already set.
dotenv.config({ path: path.join(here, ".env") });
dotenv.config({ path: path.join(here, "..", ".env") });
