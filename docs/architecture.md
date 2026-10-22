# Architecture

## One request, end to end

```
browser ──POST /api/ask {"text"}──► src/index.ts
                                     │
                                     ▼
                              src/agent.ts  (MCP client)
                                     │  1. initialize          ─┐
                                     │  2. notifications/initialized
                                     │  3. tools/list           │ every frame is
                                     │  4. tools/call {recall}  │ captured by
                                     │  5. <answer>             ─┘ src/trace.ts
                                     ▼
                              src/mcp.ts (MCP server) ──► src/db.ts (SQLite + FTS5)
                                     │
                                     ▼
                            streamed frames ──SSE──► browser wire panel
```

Two things matter for the Alexa+ requirement:

1. The **server** is the product. It is a standalone MCP server; the assistant carries no house state.
2. The **client** is replaceable. `src/agent.ts` is one MCP client (used by the simulated experience);
   a real Alexa+ integration would connect to the same `/mcp` endpoint with the same token.

## Transport and protocol

`StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` 1.32:

- `POST /mcp` with `initialize` creates a session and returns `Mcp-Session-Id`
  (`sessionIdGenerator` + `onsessioninitialized`).
- Later `POST`s carry JSON-RPC requests/notifications; responses come back as `text/event-stream`
  frames.
- `GET /mcp` opens the server-to-client SSE stream for a session; `DELETE /mcp` closes it.
- The negotiated version is `2025-11-25` (the SDK's `LATEST_PROTOCOL_VERSION`), and `tools/list`
  reports it in `initialize`.

Auth is a bearer token checked before the transport sees the request. CORS preflight is handled so
browser-based MCP clients and inspectors can talk to it.

## Why SQLite (and why FTS5)

The dataset is one household: tens to thousands of rows, single writer, must survive container
restarts and be backup-able by a human. `node:sqlite` (Node 22) removes a native build step entirely.

`searchAll()` is deliberately hybrid:

- FTS5 with `porter unicode61` and a `MATCH` query built from the utterance, **AND first, OR as
  fallback** — precision before recall.
- Small tables (appliances, services, issues, reminders) are scored directly by term overlap, because
  BM25 over eleven memories is not the interesting problem; cross-entity ranking is.
- A tiny alias table maps how people actually speak to how data is stored: *fridge → refrigerator*,
  *AC/aircon → HVAC*, *washer → washing machine*, *boiler → water heater*.
- Score orders hits; ties break on date, so "last time" questions land on the newest record.

## Speech-first response rules

The system prompt is part of the engineering, not decoration:

- one or two sentences, no markdown (a TTS engine reads markdown out loud),
- every house fact must come from a tool result in this turn,
- a write is only confirmed after the tool returns success — the model is explicitly forbidden from
  claiming a save it did not perform,
- ids are never read aloud; dates and vendor names are.

## Failure behaviour

- Tool errors are returned to the model as tool results (`{error}`), not thrown away, so it can say
  what went wrong instead of inventing success.
- If the model answers without calling a tool on an action-shaped utterance ("the leak is fixed"),
  the agent re-prompts once with a nudge before accepting the answer.
- If the tool loop exhausts its four steps, one final completion without tools forces a spoken answer.

## Trace and observability

`mcpTrace()` wraps `res.write`/`res.end`, parses both plain JSON bodies and SSE `data:` frames, and
publishes `{dir, method, payload, ms, status}` on an in-process bus. The UI subscribes over SSE and
renders the wire. This is the cheapest honest way to prove an MCP integration: the frames are the
trace of the actual bytes.
