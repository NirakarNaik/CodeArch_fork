import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { listDir, readFile, TOOL_SCHEMAS } from "./tools.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are exploring an unfamiliar codebase to map its architecture live for an audience.
You have three tools:
- list_dir(path): lists files/folders at path, relative to the repo root
- read_file(path): returns file contents (truncated to 4000 chars)
- emit_node(file, role, imports, importance): records one discovery

Explore breadth-first from the root: list_dir first, then read files you judge to be
entry points or heavily-imported, then follow their imports. After reading each file
worth recording, call emit_node with:
- file: relative path
- role: one plain sentence describing what this file does
- imports: array of other files it imports (relative paths, only ones you've seen)
- importance: "core" | "support" | "config"

Stop after 25 emit_node calls or when you've covered the meaningful structure, whichever
comes first. Do not try to read every file.`;

const ISSUE_PROMPT = `Based on everything you explored, name exactly ONE specific, real issue in this repo —
a circular dependency, an unused/orphaned file, a god-file with excessive imports, a
naming inconsistency, or similar. Be concrete: name the exact file(s). If you genuinely
found nothing notable, say so honestly rather than inventing one.
Return ONLY strict JSON, no other text: {"issue": string|null, "evidence": string, "files": [string]}`;

const MAX_NODES = 25;
const MAX_MS = 90_000;

export async function runExploreLoop(rootDir, onEvent) {
  const seenPaths = new Set();
  let nodeCount = 0;
  const startedAt = Date.now();
  const messages = [
    { role: "user", content: "Begin exploring the repository at the root." },
  ];

  while (nodeCount < MAX_NODES && Date.now() - startedAt < MAX_MS) {
    const response = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOL_SCHEMAS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    const toolResults = [];
    for (const use of toolUses) {
      try {
        if (use.name === "list_dir") {
          seenPaths.add(use.input.path);
          const result = listDir(rootDir, use.input.path);
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify(result),
          });
        } else if (use.name === "read_file") {
          seenPaths.add(use.input.path);
          const result = readFile(rootDir, use.input.path);
          toolResults.push({ type: "tool_result", tool_use_id: use.id, content: result });
        } else if (use.name === "emit_node") {
          // Only keep import edges to files Claude actually looked at this run —
          // never render an edge invented without evidence.
          const verifiedImports = (use.input.imports || []).filter((i) =>
            seenPaths.has(i)
          );
          const node = {
            id: nanoid(8),
            file: use.input.file,
            role: use.input.role,
            imports: verifiedImports,
            importance: use.input.importance,
          };
          nodeCount += 1;
          onEvent({ type: "node", data: node });
          toolResults.push({ type: "tool_result", tool_use_id: use.id, content: "recorded" });
        }
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `error: ${err.message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });

    if (nodeCount >= MAX_NODES) break;
  }

  try {
    const finalResponse = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [...messages, { role: "user", content: ISSUE_PROMPT }],
    });
    const text = finalResponse.content.find((b) => b.type === "text")?.text || "{}";
    const parsed = JSON.parse(text.trim());
    onEvent({ type: "done", data: parsed });
  } catch (err) {
    onEvent({
      type: "done",
      data: { issue: null, evidence: "Could not determine an issue this run.", files: [] },
    });
  }
}
