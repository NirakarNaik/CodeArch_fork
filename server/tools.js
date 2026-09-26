import fs from "node:fs";
import { resolveSafePath } from "./sandbox.js";

const MAX_FILE_CHARS = 4000;
const HIDDEN_DIRS = new Set([".git", "node_modules"]);

export function listDir(rootDir, userPath) {
  const target = resolveSafePath(rootDir, userPath);
  if (!fs.statSync(target).isDirectory()) {
    throw new Error(`Not a directory: ${userPath}`);
  }
  const entries = fs.readdirSync(target, { withFileTypes: true });
  return entries
    .filter((e) => !HIDDEN_DIRS.has(e.name) && !e.isSymbolicLink())
    .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
}

export function readFile(rootDir, userPath) {
  const target = resolveSafePath(rootDir, userPath);
  if (!fs.statSync(target).isFile()) {
    throw new Error(`Not a file: ${userPath}`);
  }
  const content = fs.readFileSync(target, "utf-8");
  if (content.length <= MAX_FILE_CHARS) return content;
  return content.slice(0, MAX_FILE_CHARS) + `\n\n[truncated — ${content.length} chars total]`;
}

export const TOOL_SCHEMAS = [
  {
    name: "list_dir",
    description: "List files/folders at a path, relative to the repo root. Use \".\" for the root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file's contents (truncated to 4000 chars), relative to the repo root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "emit_node",
    description: "Record one discovered file and its role in the architecture.",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string" },
        role: { type: "string" },
        imports: { type: "array", items: { type: "string" } },
        importance: { type: "string", enum: ["core", "support", "config"] },
      },
      required: ["file", "role", "imports", "importance"],
    },
  },
];
