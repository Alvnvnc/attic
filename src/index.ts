import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./mcp.js";
import { ask, resetSession } from "./agent.js";
import { mcpTrace, trace } from "./trace.js";
import * as store from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.ATTIC_MCP_TOKEN ?? "attic-dev-token";
const OPEN = process.env.ATTIC_OPEN_MCP === "1";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

/* ------------------------------------------------------------------- meta */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "attic", version: "1.0.0", mcp: "2025-11-25", open: OPEN });
});

app.get("/api/manifest", async (_req, res) => {
  const { client, close } = await probe();
  try {
    const tools = await client.listTools();
    res.json({
      server: { name: "attic", version: "1.0.0", transport: "streamable-http", protocol: "2025-11-25" },
      endpoint: "/mcp",
      auth: OPEN ? "none (demo)" : "Authorization: Bearer <ATTIC_MCP_TOKEN>",
      tools: tools.tools.map((t) => ({ name: t.name, title: t.title, description: t.description })),
    });
  } finally {
    await close();
  }
});

app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.json({
    serverInfo: { name: "attic", version: "1.0.0" },
    transport: { type: "streamable-http", endpoint: "/mcp" },
    protocolVersion: "2025-11-25",
  });
});

/* --------------------------------------------------------- mcp (the core) */

const transports: Record<string, StreamableHTTPServerTransport> = {};

function authorized(req: express.Request): boolean {
  if (OPEN) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${TOKEN}`;
}

app.use("/mcp", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, x-attic-trace, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  if (!authorized(req)) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  next();
});

app.post("/mcp", mcpTrace({ sessionHeader: "x-attic-trace" }), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  try {
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport as StreamableHTTPServerTransport;
        },
      });
      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id && transports[id]) delete transports[id];
      };
      const server = buildMcpServer();
      await server.connect(transport);
    } else if (!transport) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing or expired Mcp-Session-Id" },
        id: null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp post error", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

async function handleSession(req: express.Request, res: express.Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    return res.status(400).send("Invalid or missing Mcp-Session-Id");
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", mcpTrace({ sessionHeader: "x-attic-trace" }), handleSession);
app.delete("/mcp", handleSession);

/* ---------------------------------------------------------------- the app */

app.get("/api/state", (_req, res) => {
  const state = store.houseState();
  res.json({
    ...state,
    protocol: "2025-11-25",
    tools: ["recall", "remember", "log_service", "home_brief", "report_problem", "mark_fixed", "remind", "complete_reminder", "forget"],
  });
});

app.post("/api/ask", async (req, res) => {
  const text = String((req.body?.text ?? "").toString()).slice(0, 600).trim();
  const sessionId = String(req.headers["x-attic-session"] ?? req.body?.session ?? "demo");
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    const result = await ask(sessionId, text);
    res.json(result);
  } catch (err) {
    console.error("ask error", err);
    res.status(500).json({ error: String(err), answer: "Something went wrong reaching the house memory." });
  }
});

app.post("/api/reset", (req, res) => {
  resetSession(String(req.body?.session ?? "demo"));
  res.json({ ok: true });
});

app.get("/api/trace/stream", (req, res) => {
  const session = String(req.query.session ?? "anon");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\n\n`);
  for (const frame of trace.recent(session, 80)) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  const unsubscribe = trace.subscribe((frame) => {
    if (frame.session !== session) return;
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  });
  const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
    res.end();
  });
});

/* ----------------------------------------------------------------- server */

async function probe() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "attic-probe", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => {}) };
}

app.use(
  express.static(webRoot, {
    extensions: ["html"],
    setHeaders: (res, path) => {
      if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
      else res.setHeader("Cache-Control", "public, max-age=300");
    },
  }),
);

app.use((_req, res) => res.status(404).send("Not found"));

store.getDb();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[attic] http://0.0.0.0:${PORT} — MCP 2025-11-25 at /mcp (${OPEN ? "open" : "bearer"})`);
});
