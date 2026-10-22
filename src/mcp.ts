import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as store from "./db.js";

const SERVER_NAME = "attic";
const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `Attic is the long-term memory layer for a home, exposed to Alexa+ over MCP.

Use Attic whenever a person asks about their home: what was fixed, who fixed it, what it cost,
when the warranty runs out, where something is kept, which issue is still open, or what needs
attention soon. Prefer calling a tool over guessing — every answer should be traceable to a
memory, a service record, an appliance, an issue, or a reminder.

Voice conventions:
- Answers are spoken. One or two short sentences, no markdown, no lists unless asked.
- Always ground facts in dates ("last March", "on 14 March 2026").
- If a tool returns nothing, say so plainly and offer to remember it now.
- Never invent a vendor, price, or date.`;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function both(summary: string, structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: structured,
  };
}

function money(cents: number | null, currency: string | null): string {
  if (cents == null) return "no cost recorded";
  return `${currency ?? "USD"} ${(cents / 100).toFixed(2)}`;
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Attic — household memory" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: INSTRUCTIONS,
    },
  );

  /* ---------------------------------------------------------------- recall */
  server.registerTool(
    "recall",
    {
      title: "Recall from household memory",
      description:
        "Search everything Attic remembers about this home: notes, where things are kept, service and repair history, vendors, prices, appliances and past issues. Use this for any question about what happened, who did it, what it cost, or where something is.",
      inputSchema: {
        query: z.string().describe("Natural-language question or keywords, e.g. 'water heater service' or 'spare key'."),
        room: z.string().optional().describe("Optional room filter, e.g. 'kitchen'."),
        limit: z.number().int().min(1).max(10).optional().describe("How many matches to return (default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, room, limit }) => {
      const hits = store.searchAll(query, { room, limit: limit ?? 6 });
      if (hits.length === 0) {
        return both(`No match in household memory for "${query}".`, { query, count: 0, hits: [] });
      }
      const summary = hits.map((h) => `[${h.type} ${h.date ?? "undated"}] ${h.title} — ${h.detail}`).join("\n");
      return both(summary, { query, count: hits.length, hits });
    },
  );

  /* -------------------------------------------------------------- remember */
  server.registerTool(
    "remember",
    {
      title: "Remember a household fact",
      description:
        "Save something worth remembering about this home: where an object is kept, a paint colour, a wifi detail, a landord rule, a plumber's advice, anything a person would otherwise forget. Deduplicates near-identical notes.",
      inputSchema: {
        text: z.string().min(3).describe("The fact, in one clear sentence."),
        subject: z.string().optional().describe("What the fact is about, e.g. 'spare key', 'water heater'."),
        room: z.string().optional().describe("Room, e.g. 'kitchen'."),
        tags: z.array(z.string()).optional().describe("Short tags for later search."),
        happened_at: z.string().optional().describe("ISO date the fact happened, defaults to today."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ text, subject, room, tags, happened_at }) => {
      const existing = store.searchMemories(subject ?? text, { limit: 3 });
      const dupe = existing.find((m) => m.text.toLowerCase().trim() === text.toLowerCase().trim());
      if (dupe) {
        return both(`Already remembered: ${dupe.text}`, { saved: false, duplicate: true, id: dupe.id });
      }
      const row = store.insertMemory({ text, subject, room, tags, kind: "fact", happened_at });
      return both(`Saved to Attic: ${row.text}`, { saved: true, memory: row });
    },
  );

  /* ------------------------------------------------------------ log_service */
  server.registerTool(
    "log_service",
    {
      title: "Log a service or repair",
      description:
        "Record maintenance, a repair, or an installation for an appliance: date, vendor, cost, what was done, and warranty terms. Creates the appliance if Attic has not seen it yet. This is the ledger that answers 'when did we last…' questions.",
      inputSchema: {
        appliance: z.string().describe("Appliance name, e.g. 'water heater', 'dishwasher', 'HVAC'."),
        notes: z.string().optional().describe("What was done, e.g. 'replaced anode rod'."),
        performed_at: z.string().optional().describe("ISO date (YYYY-MM-DD). Defaults to today."),
        vendor: z.string().optional().describe("Who did the work."),
        cost: z.number().optional().describe("Amount paid in major currency units, e.g. 85.5."),
        currency: z.string().optional().describe("ISO currency code, default USD."),
        room: z.string().optional().describe("Where the appliance lives."),
        warranty_months: z.number().int().optional().describe("Warranty length in months, if new or extended."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ appliance, notes, performed_at, vendor, cost, currency, room, warranty_months }) => {
      store.upsertAppliance({ name: appliance, room, warranty_months });
      const row = store.insertService({
        appliance_name: appliance,
        performed_at,
        vendor,
        notes,
        cost_cents: cost != null ? Math.round(cost * 100) : null,
        currency: currency ?? "USD",
      });
      const total = store.listServices({ appliance, limit: 50 });
      const spent = total.reduce((acc, s) => acc + (s.cost_cents ?? 0), 0);
      return both(
        `Logged ${row.performed_at}: ${appliance}${notes ? ` — ${notes}` : ""}${vendor ? ` by ${vendor}` : ""} (${money(
          row.cost_cents,
          row.currency,
        )}).`,
        { logged: row, appliance_service_count: total.length, lifetime_cost_cents: spent },
      );
    },
  );

  /* ------------------------------------------------------------ home_brief */
  server.registerTool(
    "home_brief",
    {
      title: "Proactive house brief",
      description:
        "What needs attention in this home right now: reminders coming due, warranties about to expire, appliances that have not been serviced in a long time, and unresolved issues. Use proactively after a greeting, or when asked 'anything I should know about the house?'",
      inputSchema: {
        horizon_days: z.number().int().min(1).max(365).optional().describe("How far ahead to look, default 45 days."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ horizon_days }) => {
      const b = store.homeBrief();
      const lines: string[] = [];
      if (b.open_issues.length) {
        lines.push(
          `${b.open_issues.length} open issue${b.open_issues.length === 1 ? "" : "s"}: ` +
            b.open_issues.map((i) => `${i.title} (since ${i.opened_at})`).join("; "),
        );
      }
      if (b.due_reminders.length) {
        lines.push(
          `Due soon: ` +
            b.due_reminders
              .slice(0, 3)
              .map((r) => `${r.title}${r.due_at ? ` on ${r.due_at}` : ""}`)
              .join("; "),
        );
      }
      if (b.expiring_warranties.length) {
        lines.push(
          `Warranties ending: ` +
            b.expiring_warranties
              .slice(0, 3)
              .map((w) => `${w.name} on ${w.expires_at} (${w.days_left} days)`)
              .join("; "),
        );
      }
      if (b.overdue_service.length) {
        lines.push(
          `Overdue for service: ` +
            b.overdue_service
              .slice(0, 3)
              .map((o) => `${o.appliance}${o.last_service ? ` (last ${o.last_service})` : " (never logged)"}`)
              .join("; "),
        );
      }
      return both(lines.length ? `House brief. ${lines.join(". ")}.` : "Nothing pressing in the house right now.", {
        horizon_days: horizon_days ?? 45,
        ...b,
      });
    },
  );

  /* ------------------------------------------------------------ open_issue */
  server.registerTool(
    "report_problem",
    {
      title: "Report a new problem",
      description: "Report a NEW household problem that the person has just described and that is not fixed yet (something rattling, leaking, broken). Never use this to answer a question about problems that already exist — use home_brief for that.",
      inputSchema: {
        title: z.string().describe("Short description, e.g. 'dishwasher leaks under the door'."),
        appliance: z.string().optional().describe("Appliance involved."),
        notes: z.string().optional().describe("Diagnosis, quote, or next step."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, appliance, notes }) => {
      const row = store.openIssue({ title, appliance_name: appliance, notes });
      return both(`Opened issue: ${row.title}.`, { issue: row });
    },
  );

  /* --------------------------------------------------------- resolve_issue */
  server.registerTool(
    "mark_fixed",
    {
      title: "Mark a problem fixed",
      description: "Close a tracked household problem once it is actually fixed, recording how it was resolved. Use together with log_service when a repair happened.",
      inputSchema: {
        issue: z.string().describe("Issue id, or words from the title, e.g. 'dishwasher'."),
        resolution: z.string().optional().describe("How it was fixed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ issue, resolution }) => {
      const row = store.resolveIssue(issue, resolution ?? null);
      if (!row) return both(`No open issue matched "${issue}".`, { resolved: false });
      return both(`Resolved: ${row.title}${resolution ? ` — ${resolution}` : ""}.`, { resolved: true, issue: row });
    },
  );

  /* ----------------------------------------------------------------- remind */
  server.registerTool(
    "remind",
    {
      title: "Set a home reminder",
      description: "Add a maintenance reminder with an optional due date, e.g. 'change HVAC filter'.",
      inputSchema: {
        title: z.string().describe("What to remember to do."),
        due_at: z.string().optional().describe("ISO date (YYYY-MM-DD)."),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, due_at, notes }) => {
      const row = store.addReminder({ title, due_at, notes });
      return both(`Reminder set: ${row.title}${row.due_at ? ` for ${row.due_at}` : ""}.`, { reminder: row });
    },
  );

  /* --------------------------------------------------------------- complete */
  server.registerTool(
    "complete_reminder",
    {
      title: "Complete a reminder",
      description: "Mark a maintenance reminder as done.",
      inputSchema: { reminder: z.string().describe("Reminder id, or words from the title.") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ reminder }) => {
      const row = store.completeReminder(reminder);
      if (!row) return both(`No open reminder matched "${reminder}".`, { completed: false });
      return both(`Done: ${row.title}.`, { completed: true, reminder: row });
    },
  );

  /* ----------------------------------------------------------------- forget */
  server.registerTool(
    "forget",
    {
      title: "Forget a memory",
      description:
        "Delete household memories by id or by matching text. Use when a person asks Attic to forget something — memory is only useful if it can be taken back.",
      inputSchema: {
        id: z.string().optional().describe("Exact memory id."),
        query: z.string().optional().describe("Words to match against memory text."),
        confirm: z.boolean().describe("Must be true; guards against accidental deletion."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, query, confirm }) => {
      if (!confirm) return both("Not deleted: confirmation required.", { deleted: 0 });
      const targets = id ? [{ id }] : query ? store.searchMemories(query, { limit: 10 }) : [];
      const deleted = store.deleteMemoriesByIds(targets.map((t) => t.id));
      return both(`Forgot ${deleted} memory item(s).`, { deleted, ids: targets.map((t) => t.id) });
    },
  );

  /* -------------------------------------------------------------- resource */
  server.registerResource(
    "house",
    "attic://house",
    {
      title: "House profile",
      description: "Appliances, warranty status, open issues and maintenance reminders for this home.",
      mimeType: "application/json",
    },
    async (uri) => {
      const state = store.houseState();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                house: state.house,
                today: state.today,
                appliances: state.appliances,
                open_issues: state.issues.filter((i) => i.status === "open"),
                reminders: state.reminders,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  /* ---------------------------------------------------------------- prompt */
  server.registerPrompt(
    "weekly_brief",
    {
      title: "Weekly home brief",
      description: "Spoken summary of what matters in the house this week.",
      argsSchema: { tone: z.string().optional().describe("e.g. 'warm', 'urgent'") },
    },
    ({ tone }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Call home_brief and give me this week's house brief in a ${tone ?? "warm, concise"} voice. Open issues first, then anything due in the next 14 days.`,
          },
        },
      ],
    }),
  );

  return server;
}
