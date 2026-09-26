# CodeArchaeologist

Watch Claude Opus 5.5 explore an unfamiliar GitHub repo live — reading files,
deciding what matters, and flagging one real issue it found — instead of reading
a pre-built index.

Built for Bangalore | Claude Opus Build Day.

## Setup

```bash
npm run install-all
cp .env.example server/.env
# then edit server/.env and add your ANTHROPIC_API_KEY
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:8787 (proxied from the client via Vite, see client/vite.config.js)

## How it works

1. Paste a public GitHub repo URL on the landing screen.
2. The server clones it into a sandboxed temp directory and starts an agent loop:
   Claude Opus 5.5 calls `list_dir` / `read_file` tools to explore, and calls
   `emit_node` for each file it wants to record.
3. Each `emit_node` is streamed to the frontend over Server-Sent Events (SSE) as
   it happens, and rendered live as a graph node.
4. At the end, Claude names one specific real issue it found (or says honestly
   that it found nothing notable).
5. A "Demo Mode" toggle replays a pre-recorded run from `server/demo-log.json`
   instead of a live call — use this as your fallback if wifi/API is unreliable
   during the actual demo.

## File ownership (see the team build plan for full detail)

| Owner | Files |
|---|---|
| Member 1 (architecture / backend / Claude integration) | `server/**`, `shared/types.ts` |
| Member 2 (graph + SSE) | `client/src/ExploreView.jsx`, `client/src/GraphCanvas.jsx`, `client/src/hooks/useSSE.js` |
| Member 3 (input UI + polish + demo data) | `client/src/LandingInput.jsx`, `client/src/IssueReveal.jsx`, `client/src/styles.css`, `server/demo-log.json` (content) |

**Important before the real demo:** `server/demo-log.json` currently contains
placeholder sample data. Replace it with a real captured run against the actual
repo you'll use live, so a fallback mid-demo looks seamless rather than showing
a visibly different example.

## Security

- `ANTHROPIC_API_KEY` lives only in `server/.env` — never commit it, never put
  it in any client file.
- All file reads during exploration are sandboxed to the cloned repo's temp
  directory (`server/sandbox.js`) — path traversal and symlinks are rejected.
