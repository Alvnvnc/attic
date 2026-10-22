# Friction log

Each entry: the task attempted, steps, expected vs actual, severity, workaround, and what would fix it.
Severity: **S1** blocks the task, **S2** costs significant time, **S3** annoying.

---

### F1 — First `tools/call` with curl returns `406 Not Acceptable`
**Task:** verify the MCP server from the shell before writing any client.
**Steps:** `initialize` (works) → `tools/list` with `Content-Type: application/json` only.
**Expected:** JSON-RPC response.
**Actual:** `406 Not Acceptable: Client must accept both application/json and text/event-stream`.
**Severity:** S2.
**Workaround:** send `Accept: application/json, text/event-stream` on every request, including `initialize`.
**Suggestion:** put the full header set in the very first curl example of the "build a server" page, not in a transport sub-page.

---

### F2 — `curl | jq` breaks on a valid response
**Task:** inspect a `tools/call` result.
**Steps:** pipe the response into `jq`.
**Expected:** parsed JSON.
**Actual:** `jq: parse error` — the body is `event: message` + `data: {"jsonrpc":…}` SSE framing, even for a single response.
**Severity:** S2.
**Workaround:** `sed -n 's/^data: //p' | jq`.
**Suggestion:** document a one-line "unwrap SSE" snippet next to the curl example; mention that this is expected on Streamable HTTP.

---

### F3 — Reusing one `McpServer` across sessions mixes state
**Task:** support multiple concurrent MCP sessions.
**Steps:** create one `McpServer`, connect it to a new `StreamableHTTPServerTransport` per pending session.
**Expected:** independent sessions.
**Actual:** SDK error / shared handlers; state leaked between sessions (`Bad Request: Server already initialized`).
**Severity:** S1.
**Workaround:** build a fresh `McpServer` per transport, register it in `onsessioninitialized`, delete it in `onclose`.
**Suggestion:** make the one-server-per-transport rule explicit in the `StreamableHTTPServerTransport` API docs, with the exact map pattern.

---

### F4 — No session expiry for abandoned sessions
**Task:** keep a long-running deployment healthy.
**Steps:** clients disconnect without `DELETE /mcp`.
**Expected:** an idle timeout.
**Actual:** transports stay in memory until process restart.
**Severity:** S3.
**Workaround:** added a reaper that drops transports idle for 30 minutes (not in the SDK).
**Suggestion:** ship an `idleTimeoutMs` option, or an example of a reaper in the server docs.

---

### F5 — SDK ↔ protocol version mapping is implicit
**Task:** prove the server negotiates `2025-11-25` (a hard requirement of the track).
**Steps:** read the SDK changelog; grep `types.js`.
**Expected:** a compatibility table.
**Actual:** had to `import { LATEST_PROTOCOL_VERSION }` at runtime to confirm.
**Severity:** S2.
**Workaround:** printed it and pinned the SDK version in `package.json`.
**Suggestion:** a table on the docs landing page: SDK version → supported protocol versions.

---

### F6 — Tool-calling quirks in three LLM providers
**Task:** drive the simulated Alexa+ experience with an OpenAI-compatible model.
**Steps:** tried Gemini 2.5/3.x flash, GLM-4.6, GLM-4.5-Flash.
**Expected:** identical tool-calling behaviour.
**Actual:** Gemini's free tier rate-limits at 15 requests/minute (a demo dies mid-recording); GLM's reasoning models spend the whole token budget on reasoning and return an empty `content` unless thinking is disabled; one model emitted a tool argument that did not exist in the schema and the call was rejected by zod.
**Severity:** S2.
**Workaround:** default to a fast non-reasoning model (`glm-4.5-flash`), disable thinking explicitly, keep tool schemas narrow, and treat a failed tool call as data the model can recover from instead of an exception.
**Suggestion:** for the track, publish one "known-good model + exact request body" for the simulated-experience path.

---

### F7 — Certificate issuance on a VPS whose port 80 is already used
**Task:** serve `/mcp` over HTTPS on one small box that already hosts another site on port 80.
**Steps:** Caddy automatic HTTPS; HTTP-01 challenge needs port 80.
**Expected:** a certificate without touching the other site.
**Actual:** the challenge could not use port 80, and Cloudflare DNS was not mine to edit.
**Severity:** S2.
**Workaround:** a second Caddy instance bound only to 443 with `tls { issuer acme { disable_http_challenge } }`, which forces TLS-ALPN-01, on a `sslip.io` hostname.
**Suggestion:** a short "MCP over TLS on a single small VPS" recipe covering TLS-ALPN-01 and reverse-proxy headers.

---

### F8 — Voice demo without a device
**Task:** show an Alexa+ style interaction truthfully.
**Steps:** browser SpeechRecognition is available, but a headless screen recording cannot speak into a microphone.
**Expected:** a recorded voice conversation.
**Actual:** had to record typed transcripts and say so, rather than fake a wake-word moment.
**Severity:** S3.
**Workaround:** the demo uses the transcript surface (typed), and the video states that the transcript is what a voice turn produces.
**Suggestion:** an Alexa+ simulator that accepts an audio file or a text turn and returns the tool calls would let entrants record honest voice demos on any machine.
