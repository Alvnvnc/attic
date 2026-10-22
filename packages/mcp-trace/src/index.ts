/**
 * mcp-trace — record MCP JSON-RPC traffic in both directions.
 *
 * Sits in front of an MCP Streamable HTTP endpoint, tees every JSON-RPC frame
 * in both directions, and publishes them on an in-process bus so a UI, a test,
 * or a log can show exactly what the model sent and what the server answered.
 *
 * Zero dependencies. Framework-light: the middleware only needs the small
 * subsets of the Node `IncomingMessage` / `ServerResponse` APIs shared by
 * Express, Connect, Fastify (via middie) and plain `http`.
 */

export type Direction = "in" | "out";

export type TraceFrame = {
  /** Unique frame id (uuid). */
  id: string;
  /** Caller-provided session key, e.g. a header or MCP session id. */
  session: string;
  dir: Direction;
  /** Epoch ms when the frame was observed. */
  at: number;
  /** For `out` frames: how long the request took end to end. */
  ms: number;
  /** `initialize`, `tools/call:recall`, `result`, `error`, … */
  method: string;
  jsonrpc: string;
  payload: unknown;
  status?: number;
};

type Listener = (frame: TraceFrame) => void;

const DEFAULT_RING = 400;

export class TraceBus {
  private frames: TraceFrame[] = [];
  private listeners = new Set<Listener>();

  constructor(private readonly ring: number = DEFAULT_RING) {}

  push(frame: TraceFrame): void {
    this.frames.push(frame);
    if (this.frames.length > this.ring) this.frames.shift();
    for (const listener of this.listeners) listener(frame);
  }

  /** Most recent frames for one session, oldest first. */
  recent(session: string, limit = 60): TraceFrame[] {
    return this.frames.filter((f) => f.session === session).slice(-limit);
  }

  all(): readonly TraceFrame[] {
    return this.frames;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.frames = [];
  }
}

/** Process-wide bus, used by {@link mcpTrace}'s default options. */
export const trace = new TraceBus();

/** Derive a readable method label from a JSON-RPC payload. */
export function methodOf(payload: unknown): string {
  if (Array.isArray(payload)) return "batch";
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.method === "string") {
      const params = (p.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === "string" ? params.name : undefined;
      return name ? `${p.method}:${name}` : p.method;
    }
    if ("result" in p) {
      const result = p.result as Record<string, unknown> | undefined;
      if (result && Array.isArray(result.tools)) return "result:tools";
      return "result";
    }
    if ("error" in p) return "error";
  }
  return "unknown";
}

/**
 * Parse a response body into JSON-RPC frames. Handles plain JSON bodies, SSE
 * streams (`data:` lines), and multi-line SSE payloads.
 */
export function parseFrames(raw: string): unknown[] {
  const out: unknown[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return out;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return [JSON.parse(trimmed)];
    } catch {
      /* fall through: could be an SSE stream that starts with a comment */
    }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      /* keep-alives and partial frames are ignored */
    }
  }
  return out;
}

/* ------------------------------- middleware ------------------------------- */

/* `any` is deliberate: the middleware must stay assignable to Express,
   Connect, Fastify and plain `http` handler types at once. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type MinimalRequest = {
  method?: string;
  headers: any;
  body?: any;
  rawBody?: Buffer | string;
};

type MinimalResponse = {
  statusCode: number;
  write: (chunk: any, ...rest: any[]) => any;
  end: (chunk?: any, ...rest: any[]) => any;
};

export type McpTraceOptions = {
  /** Bus to publish to. Defaults to the process-wide {@link trace}. */
  bus?: TraceBus;
  /** Header used as the session key. Defaults to `x-mcp-trace`, then `mcp-session-id`. */
  sessionHeader?: string;
  /** Include `initialize` / `notifications/initialized` frames. Default true. */
  includeHandshake?: boolean;
  /** Id generator, mostly for deterministic tests. */
  id?: () => string;
};

let counter = 0;
const fallbackId = () => `f${Date.now().toString(36)}-${(counter++).toString(36)}`;

function header(req: MinimalRequest, key: string): string | undefined {
  const value = req.headers[key] ?? req.headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/**
 * Middleware. Mount it in front of your MCP endpoint, after the JSON body
 * parser (it reuses the raw body when it can, otherwise it re-serialises
 * `req.body`).
 */
export function mcpTrace(options: McpTraceOptions = {}) {
  const bus = options.bus ?? trace;
  const sessionHeader = options.sessionHeader ?? "x-mcp-trace";
  const includeHandshake = options.includeHandshake ?? true;
  const nextId = options.id ?? fallbackId;

  return (req: MinimalRequest, res: MinimalResponse, next: (err?: any) => void): void => {
    const session = header(req, sessionHeader) ?? header(req, "mcp-session-id") ?? "anon";
    const started = Date.now();

    if (req.method === "OPTIONS") return next();

    const raw =
      typeof req.rawBody === "string" ? req.rawBody : req.rawBody ? req.rawBody.toString("utf8") : undefined;
    const inbound = raw ?? (req.body == null ? "" : JSON.stringify(req.body));

    for (const payload of parseFrames(inbound)) {
      const method = methodOf(payload);
      if (!includeHandshake && (method === "initialize" || method === "notifications/initialized")) continue;
      bus.push({
        id: nextId(),
        session,
        dir: "in",
        at: started,
        ms: 0,
        method,
        jsonrpc: (payload as { jsonrpc?: string })?.jsonrpc ?? "2.0",
        payload,
      });
    }

    const chunks: string[] = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).write = (chunk: any, ...rest: any[]) => {
      if (typeof chunk === "string") chunks.push(chunk);
      else if (chunk) chunks.push(Buffer.from(chunk).toString("utf8"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalWrite as any)(chunk, ...rest);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).end = (chunk?: any, ...rest: any[]) => {
      if (typeof chunk === "string") chunks.push(chunk);
      else if (chunk) chunks.push(Buffer.from(chunk).toString("utf8"));
      const elapsed = Date.now() - started;
      for (const payload of parseFrames(chunks.join(""))) {
        const method = methodOf(payload);
        if (!includeHandshake && (method === "initialize" || method === "result:tools")) continue;
        bus.push({
          id: nextId(),
          session,
          dir: "out",
          at: Date.now(),
          ms: elapsed,
          method,
          jsonrpc: (payload as { jsonrpc?: string })?.jsonrpc ?? "2.0",
          payload,
          status: res.statusCode,
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalEnd as any)(chunk, ...rest);
    };

    next();
  };
}

export default mcpTrace;
