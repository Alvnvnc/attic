import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logTurn } from "./db.js";

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  result: unknown;
};

export type AskResult = {
  answer: string;
  tool_calls: ToolCall[];
  model: string;
  latency_ms: number;
  protocol: string;
  mcp_server: { name: string; version: string };
  session_id: string;
};

type ChatMessage = Record<string, unknown>;
type Part = Record<string, unknown>;

const SYSTEM = (house: string, todayIso: string) => `You are Attic, the memory of ${house}, speaking through Alexa+.
Today is ${todayIso}.

You are a voice assistant inside a home. People talk to you with their hands full, from another room.
Rules:
- Answer in one or two short sentences. No markdown, no lists, no URLs, no emoji.
- Always call a tool before you answer. Never answer a house question from the conversation alone — the durable facts live in Attic, not in the chat.
- Anything about this house — repairs, vendors, prices, warranties, where things are kept, what is still broken — must come from a tool result, never from imagination. Make one tool call, then answer.
- If the person tells you something happened (a repair, a purchase, a visit, a cost) or asks you to remember it, you MUST use log_service / remember / open_issue / resolve_issue / remind before answering. Never say it is saved unless the tool returned saved: true.
- If they say something is fixed or resolved, call BOTH log_service (the work and the cost) and resolve_issue (close the matching open issue).
- If a tool call fails or returns nothing, say so plainly and offer to save it. Never pretend a write succeeded.
- Ground answers in the dates and names you actually retrieved ("Budi Plumbing, 14 March").
- If a result contains an open issue or a warranty expiring soon that is relevant, add one short sentence about it.
- Never read ids aloud. Never mention JSON, MCP, tools, or databases.`;

/* ------------------------------------------------------------------ utility */

function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (["$schema", "additionalProperties", "default", "examples", "title", "$id", "const"].includes(k)) continue;
    if (k === "type" && Array.isArray(v)) {
      const first = v.find((t) => t !== "null");
      out.type = typeof first === "string" ? first : "string";
      continue;
    }
    out[k] =
      k === "properties" && v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, sanitizeSchema(pv)]))
        : sanitizeSchema(v);
  }
  return out;
}

function compact(value: unknown, limit = 2200): unknown {
  const s = JSON.stringify(value);
  if (!s || s.length <= limit) return value;
  return { truncated: true, preview: `${s.slice(0, limit)}…` };
}

/* ------------------------------------------------------------------ the LLM */

type Provider = { baseUrl: string; apiKey: string; model: string; extra: Record<string, unknown>; label: string };

function provider(): Provider | null {
  const apiKey = process.env.ATTIC_LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  const baseUrl = process.env.ATTIC_LLM_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4";
  const model = process.env.ATTIC_LLM_MODEL ?? "glm-4.5-flash";
  if (!apiKey) return null;
  let extra: Record<string, unknown> = { thinking: { type: "disabled" } };
  if (process.env.ATTIC_LLM_EXTRA) {
    try {
      extra = JSON.parse(process.env.ATTIC_LLM_EXTRA) as Record<string, unknown>;
    } catch {
      /* keep default */
    }
  }
  return { baseUrl, apiKey, model, extra, label: model };
}

async function chat(p: Provider, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: p.model, temperature: 0.2, ...p.extra, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`llm ${res.status}: ${text.slice(0, 280)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/* ------------------------------------------------------------- mcp session */

type McpConn = {
  client: Client;
  protocol: string;
  server: { name: string; version: string };
};

async function connectMcp(sessionId: string): Promise<McpConn> {
  const url = new URL(process.env.ATTIC_MCP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}/mcp`);
  const token = process.env.ATTIC_MCP_TOKEN ?? "attic-dev-token";
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "x-attic-trace": sessionId } },
  });
  const client = new Client({ name: "attic-alexa-sim", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const version = client.getServerVersion();
  return {
    client,
    protocol: (transport as unknown as { protocolVersion?: string }).protocolVersion ?? "2025-11-25",
    server: { name: version?.name ?? "attic", version: version?.version ?? "1.0.0" },
  };
}

/* --------------------------------------------------------------- the agent */

const histories = new Map<string, ChatMessage[]>();

export function resetSession(sessionId: string) {
  histories.delete(sessionId);
}

export async function ask(sessionId: string, userText: string): Promise<AskResult> {
  const started = Date.now();
  const p = provider();
  const house = process.env.ATTIC_HOUSE_NAME ?? "Casa Wibowo";
  const todayIso = new Date().toISOString().slice(0, 10);

  if (!p) throw new Error("no LLM configured (ATTIC_LLM_API_KEY)");

  const conn = await connectMcp(sessionId);
  const listed = await conn.client.listTools();
  const tools = listed.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} }),
    },
  }));

  const history = histories.get(sessionId) ?? [];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM(house, todayIso) },
    ...history,
    { role: "user", content: userText },
  ];
  const toolCalls: ToolCall[] = [];
  let answer = "";

  try {
    for (let step = 0; step < 4; step++) {
      const data = await chat(p, { messages, tools, tool_choice: "auto", max_tokens: 500 });
      const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const message = choice?.message as
        | { role: string; content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
        | undefined;
      if (!message) throw new Error("empty model response");

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        // Guard against a model that chats instead of acting: if the utterance
        // describes something that happened, force one grounded attempt.
        const actionish =
          /remember|note that|fixed|replaced|repaired|installed|bought|paid|coming|appointment|due|remind|serviced|leak|broken|warranty/i.test(
            userText,
          );
        if (step === 0 && actionish) {
          messages.push({ role: "assistant", content: message.content ?? "" });
          messages.push({
            role: "user",
            content:
              "Do not answer yet. Call the right Attic tool for what I just said, then answer from its result.",
          });
          continue;
        }
        answer = (message.content ?? "").trim();
        messages.push({ role: "assistant", content: answer });
        break;
      }

      messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });

      for (const call of calls) {
        const t0 = Date.now();
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        try {
          const result = await conn.client.callTool({ name: call.function.name, arguments: args });
          const blocks = (result as { content?: { type: string; text?: string }[] }).content ?? [];
          const spoken = blocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => String(b.text))
            .join("\n");
          const structured = (result as { structuredContent?: unknown }).structuredContent ?? blocks;
          toolCalls.push({ name: call.function.name, args, ms: Date.now() - t0, ok: true, result: compact(structured) });
          messages.push({ role: "tool", tool_call_id: call.id, content: spoken || JSON.stringify(compact(structured)) });
        } catch (err) {
          toolCalls.push({ name: call.function.name, args, ms: Date.now() - t0, ok: false, result: String(err) });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: String(err) }) });
        }
      }
    }

    // Guard: force a spoken answer if the loop exhausted its steps.
    if (!answer) {
      messages.push({ role: "user", content: "Answer from the tool results above in one spoken sentence." });
      const data = await chat(p, { messages, max_tokens: 220 });
      const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
      answer = String((choice?.message as { content?: string } | undefined)?.content ?? "").trim();
    }
  } finally {
    await conn.client.close().catch(() => {});
  }

  if (!answer) answer = "Sorry, I lost that thought. Ask me again?";

  const latency = Date.now() - started;
  histories.set(
    sessionId,
    [...history, { role: "user", content: userText }, { role: "assistant", content: answer }].slice(-12),
  );

  logTurn({ session_id: sessionId, role: "user", text: userText });
  logTurn({
    session_id: sessionId,
    role: "assistant",
    text: answer,
    tools: JSON.stringify(toolCalls.map((t) => t.name)),
    latency_ms: latency,
  });

  return {
    answer,
    tool_calls: toolCalls,
    model: p.label,
    latency_ms: latency,
    protocol: conn.protocol,
    mcp_server: conn.server,
    session_id: sessionId,
  };
}
