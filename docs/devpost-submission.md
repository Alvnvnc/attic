# Devpost submission packet — Attic

Everything the Devpost form asks for, written out so it can be pasted field by field.

- Hackathon: **Build, Ship, Shape: Amazon Developer Hackathon** (30992)
- Deadline: Fri Oct 23, 2026, 12:00 pm PT → **Oct 24, 2026, 02:00 WIB**
- Repo: <https://github.com/Alvnvnc/attic> (public, MIT)
- Video: <https://www.youtube.com/watch?v=0eQjCyVg3dI> (2:43, public, English)
- Live demo: <https://attic.54-254-226-82.sslip.io>
- MCP endpoint: `POST https://attic.54-254-226-82.sslip.io/mcp` — bearer `70f8caeee85207e6c9f7190083cb59e9c3112c7eb7dc8f0a`

---

## 1. Project name

```
Attic
```

## 2. Elevator pitch / tagline

```
The memory of your house — a self-hosted MCP server that gives Alexa+ long-term household memory.
```

## 3. Thumbnail

`docs/thumbnail.png` if present, otherwise a frame from the video at 1:20.

## 4. "About the project" — the story

### Inspiration

Every house accumulates facts that no app owns. Which plumber fixed the water heater, what he charged,
when the fridge warranty runs out, that the spare key is with the neighbour, that the dishwasher leak
was quoted at $210 and never decided on. Those facts live in WhatsApp threads, memory, and a drawer of
receipts, and they are needed at the worst possible moment: hands wet, phone across the room, someone
standing at the door. That is exactly the Alexa+ moment — ambient, hands-free, conversational. None of
that memory is reachable by a voice assistant today, because the assistant has nowhere to keep it and
no reason to be trusted with it.

### What it does

Attic is a self-hosted MCP server that gives Alexa+ a durable, queryable memory of the house. It exposes
nine voice-native tools over **MCP `2025-11-25` / Streamable HTTP**:

| Tool | What it is for |
| --- | --- |
| `recall` | One search across memories, service history, appliances and warranties, open problems, reminders. |
| `remember` | Save a fact ("the spare key is with Mrs. Chen"), deduplicated. |
| `log_service` | Record a repair or installation: vendor, cost, date, warranty terms. |
| `home_brief` | Proactive summary: reminders due, warranties expiring, appliances overdue, what is still broken. |
| `report_problem` / `mark_fixed` | Track a problem until it is actually fixed, with a resolution. |
| `remind` / `complete_reminder` | Maintenance reminders that outlive the conversation. |
| `forget` | Delete a memory by id or text — memory is only useful if it can be taken back. |

Plus one resource (`attic://house`) and one prompt (`weekly_brief`).

Answers are spoken-first: one or two sentences, grounded in retrieved dates, names and prices, never a
hoarded id. Writes are only confirmed after a tool result comes back, so "saved" is a fact, not a hope.
The repository also contains the **simulated Alexa+ experience** used in the demo — a voice-first web
client with the real JSON-RPC traffic streaming beside it, so a judge can watch the protocol rather than
take it on faith.

### How we built it

One Node 22 process, one SQLite file, no native modules.

- `src/mcp.ts` builds the `McpServer` with the official `@modelcontextprotocol/sdk` 1.32.1, registers the
  nine tools with zod input schemas, titles, `readOnlyHint` / `destructiveHint` annotations, and server
  instructions written for a speech-first client.
- `src/index.ts` mounts a stateful `StreamableHTTPServerTransport` at `/mcp`: `initialize` creates a
  session and returns `Mcp-Session-Id`, `POST` carries JSON-RPC, `GET` opens the server→client SSE
  stream, `DELETE` ends the session. Bearer auth is enforced in front of the transport.
- `src/db.ts` is a small data layer over `node:sqlite` with FTS5. Search is hybrid: FTS5 with AND, then a
  relaxed OR pass, an alias map (`fridge` → `refrigerator`, `ac` → `hvac`), and cross-entity scoring, so
  "when does the fridge warranty expire" finds an appliance row while "the dishwasher leak" finds both
  the issue and the service history.
- `src/agent.ts` is the other half of the demo: a real MCP client that lists tools and runs a tool-use
  loop against an OpenAI-compatible model. It holds **no** house data — every fact in an answer arrives
  as a tool result.
- The wire panel is `mcp-trace`, a zero-dependency middleware that tees JSON-RPC in both directions and
  publishes the frames on an in-process bus. It was extracted into its own MIT package during the
  hackathon (<https://github.com/Alvnvnc/mcp-trace>, six tests).
- Deployment is Caddy in front of the Node process on a $5 Lightsail box, HTTPS-only, with Let's Encrypt
  issuing over TLS-ALPN-01 because port 80 was already spoken for.

### Challenges we ran into

- **Streamable HTTP is SSE even for one request.** The first `curl` looked broken until the `Accept:
  application/json, text/event-stream` header and the `event: message / data:` framing were handled
  properly — which is also why `mcp-trace` parses both plain JSON and SSE frames.
- **One transport, one server.** Sharing a single `McpServer` across sessions silently mixes state. The
  correct pattern is a new server and transport per session, keyed by `Mcp-Session-Id`.
- **Writes are the hard part of a memory product, not reads.** Early versions let the model say "saved"
  before the tool had returned. The fix was structural: the system prompt forbids confirming a write
  until a tool result exists, and the trace panel proves it in the demo.
- **Certificates on a box with a busy port 80.** Solved with a second Caddy container on host networking,
  443 only, `auto_https disable_redirects`, and TLS-ALPN-01.
- **Making tool names speakable.** `open_issue` / `resolve_issue` read badly in a conversation; they
  became `report_problem` / `mark_fixed`, which a voice client can route on far more reliably.

### Accomplishments that we're proud of

- The demo is honest: the right-hand panel is the actual JSON-RPC, frame by frame, not a mockup. What the
  judge sees is what the server sent.
- The model cannot invent a price or a date. Every number on screen is traceable to a SQLite row, and the
  ledger tab shows those rows.
- A complete, self-hosted Alexa+ skill in one process and one file, deployable to the smallest VPS, with
  no vendor lock-in: any MCP-capable assistant can use it unchanged.
- The tracing piece was generalised and released: `mcp-trace` is reusable by any Streamable HTTP MCP
  server, with tests.

### What we learned

MCP itself is boring in the best way — the interesting engineering is in the *shape of the tools*. A
voice assistant needs few tools, unambiguous names, one-call answers, and writes that are verifiable.
Most of the work went into retrieval quality and into refusing to let the model speak before the data
arrived, not into the protocol.

### What's next for Attic

- A conformance harness against a real Alexa+ client, so "works with Alexa+" stops being a claim about a
  spec and becomes a test.
- Multi-house and multi-user scoping with per-user tokens, so a household can share one memory without
  sharing every memory.
- Photo and receipt capture (a photo of an invoice becomes a service record with a warranty date).
- Proactive briefs pushed on a schedule, not only when asked.

### Built with

```
node.js, typescript, express, @modelcontextprotocol/sdk, mcp (model context protocol), sqlite, fts5,
streamable-http, json-rpc, zod, caddy, lets-encrypt, playwright, z.ai glm-4.5-flash, html, css, javascript
```

---

## 5. Video demo link

```
https://www.youtube.com/watch?v=0eQjCyVg3dI
```

## 6. Repository / "Try it out" links

```
https://github.com/Alvnvnc/attic
https://attic.54-254-226-82.sslip.io
```

## 7. Primary track

```
Alexa+
```

## 8. Mini challenge

```
Open Source
```

### Open Source answers

- **Contribution URL:** `https://github.com/Alvnvnc/mcp-trace`
- **Project repository URL:** `https://github.com/Alvnvnc/attic`
- **GitHub username:** `Alvnvnc`
- **Description:**

```
Attic is a new MIT-licensed project, released in full: server, client, web UI, tests and deploy files.
The reusable piece is mcp-trace (https://github.com/Alvnvnc/mcp-trace), extracted from Attic's wire
panel and published as its own MIT package.

What it does: mcp-trace mounts in front of any MCP Streamable HTTP endpoint, tees JSON-RPC frames in both
directions, parses both plain JSON bodies and SSE `data:` frames (POST, GET and DELETE), tags frames with
a session key (configurable header, falling back to Mcp-Session-Id), and publishes them on an in-process
bus with a per-session ring buffer and subscribers.

How it works: a single middleware function with no dependencies — it wraps res.write/res.end, records
the request body (or rawBody when the host app kept it), labels the frame from the JSON-RPC method
("tools/call:recall", "result:tools", "error"), and never lets a parse failure break a request. Six
node:test cases cover labelling, SSE/JSON parsing, the ring buffer, fan-out and the anonymised-session /
OPTIONS paths; `npm run build && npm test` passes from a clean clone.

Why it matters: MCP servers are usually debugged from the tool handler down, which hides the actual
wire traffic. mcp-trace makes the protocol the observable thing — the same reason Attic's demo can show
its own JSON-RPC live instead of describing it. It is useful to anyone building an Alexa+ skill, an MCP
server, or a client that has to prove what it sent.
```

## 9. Product feedback (required: every tool, API and SDK)

```
Which developer tools, APIs and SDKs did I use, and for what?
- MCP specification 2025-11-25 and @modelcontextprotocol/sdk 1.32.1 (TypeScript): the whole Alexa+
  surface — McpServer, registerTool, registerResource, registerPrompt, and on the client side Client +
  StreamableHTTPClientTransport.
- Alexa+ developer docs / modelcontextprotocol.io: protocol shape, Streamable HTTP semantics, sessions.
- Node.js 22.23 (node:sqlite with FTS5, fetch, AbortSignal.timeout): storage and outbound model calls,
  with no native modules to compile.
- Z.AI GLM-4.5-Flash over an OpenAI-compatible chat-completions API with tool calling: the model behind
  the simulated Alexa+ experience. It is not part of the MCP server; the server has no LLM dependency.
- Caddy 2: TLS termination and reverse proxy for /mcp over HTTPS.
- Playwright (Chromium): driving the demo UI while recording the video, and screenshot review.
- mcp-trace (my own MIT package, extracted from this project): capturing JSON-RPC frames in both
  directions for the wire panel and for debugging.

What worked well?
- The MCP TypeScript SDK is genuinely good. registerTool(name, {title, description, inputSchema: {…zod…},
  annotations}, handler) produced a correct JSON Schema, picked up readOnlyHint/destructiveHint, and the
  server instructions arrived intact at the client. I did not have to hand-write JSON-RPC.
- Streamable HTTP is the right transport for a self-hosted skill: one endpoint, one token, no inbound
  webhook to babysit.
- Tool annotations paid off immediately: marking recall readOnlyHint and forget destructiveHint gave the
  model a usable prior about which calls are safe, and made the trace readable at a glance.
- Local dev was near-zero: node:sqlite with FTS5 compiled in meant the demo database was one file I could
  copy to the server and inspect with any SQLite client.

What needs work?
- Streamable HTTP responses are SSE even for a single request. curl … | jq on /mcp returns
  "event: message\ndata: {...}" and looks broken. A short "your first tools/call with curl" page —
  including the required Accept: application/json, text/event-stream header (406 without it) — would
  save an hour.
- Stateful transport plus server lifetime is under-documented. StreamableHTTPServerTransport can only be
  connected to one McpServer; my first version reused one server across sessions and silently mixed
  session state. The correct pattern (new McpServer per transport, onsessioninitialized for the map) is
  only discoverable by reading the SDK source.
- Session cleanup: there is no built-in expiry for abandoned sessions, and DELETE is client-initiated. A
  server-side idle timeout helper would prevent slow leaks on long-running deployments.
- No official "MCP over TLS on a small box" recipe. For a hackathon, the hard part was not the protocol
  but certificate issuance on a VPS where port 80 was already in use; TLS-ALPN-01 solved it, but I had
  to reason that out.
- The Alexa+ surface is described in prose, not as a schema. "Implement 2025-11-25 over Streamable HTTP"
  leaves real questions: does Alexa+ send initialize per utterance or hold a session? Must tools/list be
  stable across sessions? A reference sequence diagram, or a captured initialize from a real client,
  would remove the guesswork.
- Spec version is not SDK version. I had to print LATEST_PROTOCOL_VERSION from the installed SDK to be
  certain it negotiated 2025-11-25. A compatibility table ("SDK 1.32 → protocol 2025-11-25") on the docs
  landing page would settle it.

How was the onboarding experience (zero to hello world)?
Fast, with one cliff. Copying the SDK snippet got a server answering initialize in about ten minutes. The
cliff was the first real client call: 406s from a missing Accept header, then SSE framing that broke my
jq pipeline, then the one-server-per-transport rule. After that, tools, resources, prompts and
annotations behaved exactly as documented. Roughly: 10 minutes to hello world, 90 minutes to a correct
stateful Streamable HTTP server.

Would I build with these devices and services again?
Yes. The MCP server I built is the artifact I would actually deploy in a real home: one Node process, one
SQLite file, no vendor lock-in, and any MCP-capable assistant can use it without changes to my code. The
protocol is boring in the best way. What would make me hesitate is not MCP but the Alexa+ side: until I
can test against a real Alexa+ client (or a published conformance suite), I am integrating against a
spec, not a system. A hosted "Alexa+ MCP sandbox" that sends real initialize/tools/call traffic would be
the single highest-value thing Amazon could ship for this track.
```

## 10. Friction log (bonus, up to 10%)

Paste-ready version of `docs/friction-log.md` (severity S1 = blocks, S2 = costs time, S3 = annoying):

```
1. First tools/call with curl returns 406 Not Acceptable (S2). initialize works, then tools/list with only
   Content-Type: application/json fails: "406: Client must accept both application/json and
   text/event-stream". Workaround: send Accept: application/json, text/event-stream on every request.
   Fix: put the full header set in the first curl example of the "build a server" page.

2. curl | jq breaks on a valid response (S2). A single tools/call comes back as SSE: "event: message" +
   'data: {...}', so jq fails to parse. Workaround: sed -n 's/^data: //p' | jq. Fix: document the one-line
   "unwrap SSE" snippet next to the curl example.

3. Reusing one McpServer across sessions mixes state (S1). Connecting one server to a new
   StreamableHTTPServerTransport per session fails with "Bad Request: Server already initialized" and
   leaks state. Workaround: a fresh McpServer per transport, kept in a map filled by onsessioninitialized
   and emptied by onclose. Fix: make the one-server-per-transport rule explicit, with that map pattern.

4. No session expiry for abandoned sessions (S3). Clients that disconnect without DELETE /mcp leave
   transports in memory until restart. Workaround: a reaper that drops transports idle for 30 minutes.
   Fix: an idleTimeoutMs option, or a reaper example.

5. SDK-to-protocol version mapping is implicit (S2). To prove the server negotiates 2025-11-25 (a track
   requirement) I had to import LATEST_PROTOCOL_VERSION at runtime and grep the SDK. Fix: a compatibility
   table (SDK version to supported protocol versions) on the docs landing page.

6. Tool-calling quirks across three model providers (S2). Gemini's free tier rate-limits at 15 rpm and
   kills a demo mid-recording; GLM's reasoning models spend the whole token budget on reasoning and return
   empty content unless thinking is disabled; one model emitted a tool argument absent from the schema and
   zod rejected the call. Workaround: default to a fast non-reasoning model, disable thinking explicitly,
   keep schemas narrow, and treat a failed tool call as recoverable data.

7. Certificate issuance on a VPS whose port 80 is already used (S2). HTTP-01 needs port 80, which another
   site owns, and the DNS zone was not mine to edit. Workaround: a second Caddy bound only to 443 with
   disable_http_challenge, forcing TLS-ALPN-01, on an sslip.io hostname. Fix: a short "MCP over TLS on a
   single small VPS" recipe.

8. Voice demo without a device (S3). Browser SpeechRecognition exists, but a headless screen recording
   cannot speak into a microphone. Workaround: type into the transcript surface and label it a simulated
   Alexa+ experience in both the video and the README; nothing is dressed up as microphone input. Fix: an
   Alexa+ simulator that takes an audio file or a text turn and returns the tool calls.
```


## 11. Testing instructions (for judges)

```
Live experience: https://attic.54-254-226-82.sslip.io  — click the microphone (or type) and ask
"When did we last service the water heater?". The right panel streams the real JSON-RPC frames.

MCP endpoint: POST https://attic.54-254-226-82.sslip.io/mcp
Authorization: Bearer 70f8caeee85207e6c9f7190083cb59e9c3112c7eb7dc8f0a

curl -s https://attic.54-254-226-82.sslip.io/mcp \
  -H "Authorization: Bearer 70f8caeee85207e6c9f7190083cb59e9c3112c7eb7dc8f0a" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

The response carries Mcp-Session-Id; reuse it in an Mcp-Session-Id header for tools/list and tools/call.
Server card: https://attic.54-254-226-82.sslip.io/.well-known/mcp/server-card.json
The database is synthetic demo data and is reseeded for judging.

Local run: npm install && npm run build && cp .env.example .env (add any OpenAI-compatible key)
&& node --env-file=.env dist/db/seed.js --reset && node --env-file=.env dist/index.js
```

---

## Checklist before submitting

- [x] Repo public with detectable MIT licence in the About section
- [x] Video under 3 minutes, public on YouTube, English, shows the working project
- [x] MCP server speaks `2025-11-25` over Streamable HTTP, verified against the deployed instance
- [x] Runtime use of the track technology in code (`StreamableHTTPServerTransport`, `McpServer`)
- [x] Product feedback covering every tool/API/SDK
- [x] Open Source mini challenge fields (contribution URL, repo URL, username, description)
- [x] Join the hackathon and submit the project on Devpost — **submitted 5/5**, entry 1255329
  (`https://devpost.com/software/attic-ahotyg`, submitted as Devpost user `alvnvnc`)
- [x] Friction log attached (the Devpost field only accepts a URL, so it points at `docs/friction-log.md`)
- [ ] Optional: replace the generated project card with a real thumbnail (the upload throws a JS error in the
  automation browser; cosmetic only, the gallery is not published yet)

---

## Manual path — ten minutes in the Devpost UI

1. <https://amazonappdev2026.devpost.com/> → **Join hackathon** (Cloudflare may ask for one click).
2. **Submit project** (or My projects → Submit project).
3. Step 1: name `Attic`, tagline from §2, thumbnail, then *Save and continue*.
4. Step 2: paste the sections from §4 into the story boxes; add the **Built with** tags; add the video
   link from §5 and the two links from §6 (*Try it out*).
5. Step 3: primary track **Alexa+**; mini challenge **Open Source** with the four answers from §8; paste
   the product feedback from §9 and the friction log from §10 into the custom questions.
6. Submit, then reopen the project page and check the video plays and the repo link resolves.

