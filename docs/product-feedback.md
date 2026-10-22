# Product feedback — Amazon Developer Hackathon 2026

Track: **Alexa+**. Mini challenge: **Open Source**.
Everything below is from building Attic (a self-hosted MCP server for household memory) between
22–23 October 2026, on a 2 vCPU Lightsail box running Node 22 behind Caddy.

## Which developer tools, APIs and SDKs did I use, and for what?

| Tool / API / SDK | Used for |
| --- | --- |
| **MCP specification 2025-11-25** + **`@modelcontextprotocol/sdk` 1.32.1** (TypeScript) | The whole Alexa+ surface: `McpServer`, `registerTool`, `registerResource`, `registerPrompt`, and on the client side `Client` + `StreamableHTTPClientTransport`. |
| **Alexa+ developer docs / modelcontextprotocol.io** | Protocol shape, Streamable HTTP semantics, session handling. |
| **Node.js 22.23** (`node:sqlite`, `fetch`, `AbortSignal.timeout`) | Storage (SQLite + FTS5) and outbound model calls, with no native modules. |
| **Z.AI GLM-4.5-Flash** (OpenAI-compatible chat completions with tool calling) | The model behind the *simulated* Alexa+ experience. Not part of the MCP server; the server has no LLM dependency. |
| **Caddy 2** | TLS termination and reverse proxy for `/mcp` over HTTPS. |
| **Playwright (Chromium)** | Driving the demo UI while recording the video, and screenshot review during design. |
| **`mcp-trace`** (my own MIT package, extracted from this project) | Capturing JSON-RPC frames in both directions for the wire panel and for debugging. |

## What worked well

- **The MCP TypeScript SDK is genuinely good.** `registerTool(name, {title, description, inputSchema: {…zod…}, annotations}, handler)` produced a correct JSON Schema, picked up `readOnlyHint`/`destructiveHint`, and the server's `instructions` field arrived intact at the client. I did not have to hand-write JSON-RPC.
- **Streamable HTTP is the right transport for a self-hosted skill.** One endpoint, one token, no inbound webhook to babysit. Sessions (`Mcp-Session-Id`) meant the server could stay stateless-in-prompt and stateful-in-storage.
- **Tool annotations paid off immediately.** Marking `recall` as `readOnlyHint` and `forget` as `destructiveHint` gave the model a usable prior about which calls are safe, and made the trace readable at a glance.
- **Local dev was near-zero.** `node:sqlite` with FTS5 compiled in meant the demo database was a file I could copy to the server and inspect with any SQLite client.

## What needs work

- **Streamable HTTP responses are SSE, even for a single request.** `curl … | jq` on `/mcp` returns `event: message\ndata: {...}` and looks broken. Docs show this, but every first-time integration hits it. A short "your first `tools/call` with curl" page — including the required `Accept: application/json, text/event-stream` header (406 without it) — would save an hour.
- **Stateful transport + server lifetime is under-documented.** `StreamableHTTPServerTransport` can only be connected to one `McpServer`; my first version reused one server across sessions and silently mixed session state. The correct pattern (new `McpServer` per transport, `onsessioninitialized` for the map) is only discoverable by reading the SDK source.
- **Session cleanup.** There is no built-in expiry for abandoned sessions; `DELETE` is client-initiated. A server-side idle timeout helper would prevent slow leaks on long-running deployments.
- **No official "MCP over TLS on a small box" recipe.** For a hackathon, the hard part was not the protocol but certificate issuance on a VPS with port 80 spoken for — TLS-ALPN-01 solved it, but I had to reason that out.
- **The Alexa+ surface is described in prose, not as a schema.** "Implement `2025-11-25` over Streamable HTTP" leaves real questions: does Alexa+ send `initialize` per utterance or hold a session? Does it require `tools/list` to be stable across sessions? A reference sequence diagram (or a sample `initialize` capture from a real client) would remove the guesswork.
- **Spec version != SDK version.** I had to print `LATEST_PROTOCOL_VERSION` from the installed SDK to be certain it negotiated `2025-11-25`. A compatibility table ("SDK 1.32 → protocol 2025-11-25") on the docs landing page would settle it.

## Onboarding experience (zero → hello world)

Fast, with one cliff. Copying the SDK snippet got a server answering `initialize` in about ten minutes.
The cliff was the first real client call: 406s from a missing `Accept` header, then SSE framing that
broke my `jq` pipeline, then the one-server-per-transport rule. Once past that, everything else —
tools, resources, prompts, annotations — behaved exactly as documented. **Roughly: 10 minutes to hello
world, 90 minutes to a correct stateful Streamable HTTP server.**

## Would I build with these devices and services again?

**Yes.** The MCP server I built is the artifact I would actually deploy in a real home: it is a single
Node process, a single SQLite file, no vendor lock-in, and any MCP-capable assistant can use it without
changes to my code. The protocol is boring in the best way.

What would make me hesitate is not MCP but the Alexa+ side: until I can test against a real Alexa+
client (or a published conformance suite), I am integrating against a spec, not a system. A hosted
"Alexa+ MCP sandbox" that sends real `initialize`/`tools/call` traffic would be the single highest-value
thing Amazon could ship for this track.
