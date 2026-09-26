# CodeArchaeologist

Watch Claude Opus 5.5 explore an unfamiliar GitHub repo live — reading files,
deciding what matters, and flagging one real issue it found — instead of reading
a pre-built index.

Built for Bangalore | Claude Opus Build Day.

## Setup

```bash
cp .env.example server/.env   # optional: add ANTHROPIC_API_KEY for live mode
npm run dev
```

Then open **http://localhost:8787**. That one command installs dependencies,
builds the client and starts the Express server, which serves both the app and
`/api/*` from the same origin.

- **Demo mode** needs no API key: click _Try interactive demo_ on the landing page.
- **Live mode** needs `ANTHROPIC_API_KEY` in `server/.env`. Without it, the app
  explains that live mode is unavailable and offers the demo.
- **Hot reload while developing UI:** `npm install && npm run dev:hmr`, then open
  http://localhost:5173 (Vite proxies `/api` to the server on 8787).

## How it works

1. Paste a public GitHub repo URL on the landing screen.
2. The server clones it into a sandboxed temp directory and starts an agent loop:
   Claude Opus 5.5 calls `list_dir` / `read_file` tools to explore, and calls
   `emit_node` for each file it wants to record.
3. Each `emit_node` is streamed to the frontend over Server-Sent Events (SSE) as
   it happens, and rendered live as a graph node.
4. At the end, Claude names one specific real issue it found (or says honestly
   that it found nothing notable).
5. "Try interactive demo" (landing page, or the error screen) replays a
   pre-recorded run from `server/demo-log.json` instead of a live call — use
   this as your fallback if wifi/API is unreliable during the actual demo.

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
