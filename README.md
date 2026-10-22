# Attic — the memory of your house

**A self-hosted MCP server that gives Alexa+ a long-term memory for a home: repairs, vendors, prices,
warranties, where things are kept, and what is still broken.**

Built for the **Amazon Developer Hackathon 2026 — Alexa+ track** with a real MCP server speaking
**MCP `2025-11-25` over Streamable HTTP**. Attic also ships the simulated Alexa+ experience used to
demo it (voice-first UI + live MCP wire inspector).

- Live experience: <https://attic.54-254-226-82.sslip.io>
- Demo video (2:43): <https://www.youtube.com/watch?v=0eQjCyVg3dI>
- MCP endpoint: `POST https://attic.54-254-226-82.sslip.io/mcp` (bearer token, see *Testing*)
- Companion open-source contribution (Open Source mini challenge): <https://github.com/Alvnvnc/mcp-trace>
- Submission packet (all Devpost field text, testing instructions): [`docs/devpost-submission.md`](docs/devpost-submission.md)

---

## The problem

Every house accumulates facts that no app owns:

- Which plumber fixed the water heater, when, and what he charged.
- When the fridge warranty runs out (and where the receipt lives).
- That the spare key is with the neighbour, and that the main water shutoff is behind the laundry door.
- That the dishwasher leak was quoted at $210 and *never decided on*.

These facts live in WhatsApp threads, memory, and a drawer of receipts. They are needed at the worst
possible moment: hands wet, phone across the room, someone standing at the door. That is exactly the
Alexa+ moment — ambient, hands-free, and conversational.

Attic gives Alexa+ a durable, queryable memory of the house, exposed over MCP so the assistant stays
stateless and the home owns its own data.

## What it does

| Tool | What it's for |
| --- | --- |
| `recall` | One search across memories, service history, appliances/warranties, issues, reminders. |
| `remember` | Save a fact ("spare key is with Mrs. Chen"), deduplicated. |
| `log_service` | Record a repair or installation: vendor, cost, date, warranty terms. |
| `home_brief` | Proactive: reminders due, warranties expiring, appliances overdue for service, open issues. |
| `report_problem` / `mark_fixed` | Track a problem until it is actually fixed, with a resolution. |
| `remind` / `complete_reminder` | Maintenance reminders that outlive the conversation. |
| `forget` | Delete a memory by id or text — memory is only useful if it can be taken back. |

Plus one resource (`attic://house`) and one prompt (`weekly_brief`).

Answers are spoken-first: one or two sentences, grounded in retrieved dates and names, never a hoarded
id. Writes require a real tool result before the assistant is allowed to say "saved".

## How it works

```
Alexa+ (or the simulated experience)
        │  MCP 2025-11-25 · Streamable HTTP · bearer token
        ▼
  POST /mcp ──► Attic MCP server (this repo, Node 22)
                  │  tools/call
                  ▼
              SQLite (FTS5) ── memories · appliances · service events · issues · reminders
```

- **`src/mcp.ts`** builds the `McpServer` (official `@modelcontextprotocol/sdk`), registers the nine
  tools with zod schemas, annotations (`readOnlyHint`, `destructiveHint`) and server instructions.
- **`src/index.ts`** mounts a stateful Streamable HTTP transport at `/mcp`: `initialize` creates a
  session (`Mcp-Session-Id`), `POST` carries JSON-RPC, `GET` opens the SSE stream, `DELETE` ends it.
  Bearer auth is enforced in front of the transport.
- **`src/agent.ts`** is an MCP *client*: it connects to `/mcp`, lists tools, and runs a tool-use loop
  with an OpenAI-compatible model. This is the "Alexa+ side" of the demo — it holds no house data.
- **`src/trace.ts`** tees every JSON-RPC frame in both directions and streams it to the UI, so the
  demo shows the real protocol rather than a claim about it. (Extracted as
  [`mcp-trace`](https://github.com/Alvnvnc/mcp-trace).)
- **`web/`** is the simulated Alexa+ experience: voice-first transcript, live wire inspector, and the
  house ledger the assistant reads from.

## Quickstart

```bash
git clone https://github.com/Alvnvnc/attic.git && cd attic
npm install
npm run build
cp .env.example .env          # add an LLM key (any OpenAI-compatible endpoint)
node --env-file=.env dist/db/seed.js --reset
node --env-file=.env dist/index.js
# open http://localhost:8787
```

Talk to the MCP server directly:

```bash
curl -s http://localhost:8787/mcp \
  -H "Authorization: Bearer $ATTIC_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},
        "clientInfo":{"name":"curl","version":"1"}}}'
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port for the app and the MCP endpoint. |
| `ATTIC_DB` | `./data/attic.db` | SQLite file (WAL, FTS5). |
| `ATTIC_MCP_TOKEN` | `attic-dev-token` | Bearer token required by `/mcp`. |
| `ATTIC_OPEN_MCP` | unset | `1` disables auth (local demos only). |
| `ATTIC_HOUSE_NAME` | `Casa Wibowo` | Name the assistant uses for the home. |
| `ATTIC_MCP_URL` | `http://127.0.0.1:$PORT/mcp` | Where the agent client connects. |
| `ATTIC_LLM_BASE_URL` | `https://api.z.ai/api/coding/paas/v4` | Any OpenAI-compatible base URL. |
| `ATTIC_LLM_MODEL` | `glm-4.5-flash` | Model name. |
| `ATTIC_LLM_API_KEY` | — | Key for the model endpoint. |

The demo deployment runs the server behind a TLS-terminating Caddy on the same host
(`deploy/` has the exact unit, Caddyfile and compose file used).

## Testing

The public demo is open to judges; the MCP endpoint needs the bearer token, which is in the Devpost
testing instructions (also reproduced in [`docs/devpost-submission.md`](docs/devpost-submission.md)).

Talk to the deployed server:

```bash
curl -s https://attic.54-254-226-82.sslip.io/mcp \
  -H "Authorization: Bearer $ATTIC_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},
        "clientInfo":{"name":"curl","version":"1"}}}'
```

Keep the returned `Mcp-Session-Id` and send it on the following `tools/list` / `tools/call` requests.
`.well-known/mcp/server-card.json` and `/api/manifest` describe the server for discovery.

To run everything locally, `npm install && npm run build && npm start` plus the seed script is enough;
the database is synthetic demo data.

## Track requirements, mapped

- **Alexa+ — working self-hosted MCP server, spec `2025-11-25`, Streamable HTTP.** `src/index.ts`
  instantiates `StreamableHTTPServerTransport` with session management; `src/mcp.ts` registers the
  tools. The server answers `initialize` with `protocolVersion: "2025-11-25"` and the tool list on
  `tools/list` — visible in the repo and in the demo video's wire panel.
- **Simulated Alexa+ experience.** `web/` + `src/agent.ts`; the repo contains the simulation source.
- **Open Source mini challenge.** This repository is a new MIT-licensed project, and the reusable
  piece was extracted to <https://github.com/Alvnvnc/mcp-trace> (MIT, tested).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — request lifecycle, data model, protocol decisions.
- [`docs/product-feedback.md`](docs/product-feedback.md) — required feedback on every tool/API/SDK used.
- [`docs/friction-log.md`](docs/friction-log.md) — friction entries with severity and workarounds.
- [`docs/demo-script.md`](docs/demo-script.md) — the three-minute demo, shot by shot.

## License

MIT © 2026 Alvnvnc
