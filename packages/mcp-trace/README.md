# mcp-trace

**Record MCP JSON-RPC traffic in both directions — for any Streamable HTTP server, with zero dependencies.**

When you build an MCP server, the interesting question is rarely "did it respond?" — it is "what did the
model actually send, and what did my server actually answer?". `mcp-trace` mounts in front of your MCP
endpoint, tees every JSON-RPC frame in both directions, and publishes them on an in-process bus so a UI,
a test, or a log can show the real wire traffic.

```
client ──POST /mcp──► [ mcpTrace ] ──► StreamableHTTPServerTransport ──► your tools
                          │
                          └── frame {dir:"in",  method:"tools/call:recall", payload}
                              frame {dir:"out", method:"result", ms:12, status:200}
```

## Why another tracer

- **It reads both shapes.** Streamable HTTP responses come back as `text/event-stream`, even for a single
  request. `mcp-trace` parses plain JSON bodies *and* SSE `data:` frames, so the same middleware works for
  `POST`, `GET` (server→client stream) and `DELETE`.
- **It is honest.** The frames are the bytes that crossed the wire, not a reconstruction from your tool
  handlers.
- **It is dependency-free.** No Express, no Fastify, no OpenTelemetry. The middleware only needs
  `req.headers`, `req.body`/`req.rawBody`, and `res.write`/`res.end`.
- **It stays out of the way.** Errors in parsing are swallowed; tracing never breaks a request.

## Install

```bash
npm i mcp-trace
```

## Use

```ts
import express from "express";
import { mcpTrace, trace } from "mcp-trace";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      // lets mcp-trace record the exact bytes the client sent
      (req as any).rawBody = Buffer.from(buf);
    },
  }),
);

app.use("/mcp", mcpTrace());                    // after the body parser
app.post("/mcp", async (req, res) => { /* your SDK transport */ });

// stream what the wire sees to a UI, a log, or a test
app.get("/api/trace/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const frame of trace.recent(String(req.query.session ?? "anon"))) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  trace.subscribe((frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`));
});
```

### Sessions

`mcpTrace` tags frames with a session key, taken from `x-mcp-trace` and falling back to
`Mcp-Session-Id`, then `"anon"`. Send `x-mcp-trace` from your own client when one MCP session is shared
by several users or UI tabs:

```ts
new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { "x-mcp-trace": webSessionId } },
});
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `bus` | the process-wide `trace` | Publish somewhere else (e.g. a per-test bus). |
| `sessionHeader` | `x-mcp-trace` | Header used as the session key. |
| `includeHandshake` | `true` | Include `initialize` / `notifications/initialized`. |
| `id` | internal | Frame id generator (deterministic tests). |

### Frame shape

```ts
type TraceFrame = {
  id: string;
  session: string;
  dir: "in" | "out";
  at: number;        // epoch ms, when observed
  ms: number;        // for "out": end-to-end request time
  method: string;    // "initialize", "tools/call:recall", "result:tools", "error"
  jsonrpc: string;
  payload: unknown;  // the actual JSON-RPC frame
  status?: number;   // HTTP status of the response
};
```

## Test

```bash
npm run build && npm test
```

Six tests cover method labelling, SSE/JSON parsing, the ring buffer, subscription fan-out, middleware
recording, and the anonymised-session/`OPTIONS` paths.

## Used by

[Attic](https://github.com/Alvnvnc/attic) — a self-hosted MCP server that gives Alexa+ a long-term memory
for a home. The demo UI's wire panel is this package's bus, rendered.

## License

MIT © 2026 Alvnvnc
