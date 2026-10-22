import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type Memory = {
  id: string;
  text: string;
  subject: string | null;
  room: string | null;
  tags: string | null;
  kind: string;
  happened_at: string | null;
  created_at: string;
  score?: number;
};

export type Appliance = {
  id: string;
  name: string;
  room: string | null;
  brand: string | null;
  model: string | null;
  purchased_at: string | null;
  warranty_months: number | null;
  notes: string | null;
};

export type ServiceEvent = {
  id: string;
  appliance_name: string;
  performed_at: string;
  vendor: string | null;
  cost_cents: number | null;
  currency: string | null;
  notes: string | null;
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS appliances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  room TEXT,
  brand TEXT,
  model TEXT,
  purchased_at TEXT,
  warranty_months INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_events (
  id TEXT PRIMARY KEY,
  appliance_name TEXT NOT NULL,
  performed_at TEXT NOT NULL,
  vendor TEXT,
  cost_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  subject TEXT,
  room TEXT,
  tags TEXT,
  kind TEXT NOT NULL DEFAULT 'fact',
  happened_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  appliance_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  due_at TEXT,
  done_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  tools TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, subject, room, tags,
  content='memories', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, subject, room, tags)
  VALUES (new.rowid, new.text, new.subject, new.room, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, subject, room, tags)
  VALUES ('delete', old.rowid, old.text, old.subject, old.room, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, subject, room, tags)
  VALUES ('delete', old.rowid, old.text, old.subject, old.room, old.tags);
  INSERT INTO memories_fts(rowid, text, subject, room, tags)
  VALUES (new.rowid, new.text, new.subject, new.room, new.tags);
END;

CREATE INDEX IF NOT EXISTS idx_service_appliance ON service_events(appliance_name, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at DESC);
`;

let db: DatabaseSync | null = null;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const path = resolve(process.env.ATTIC_DB ?? "./data/attic.db");
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/* ------------------------------------------------------------------ memories */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "was", "were",
  "is", "are", "do", "did", "does", "we", "i", "you", "it", "that", "this", "when",
  "what", "who", "how", "much", "many", "last", "time", "about", "our", "my", "me",
  "at", "by", "from", "has", "have", "had", "there", "any", "please", "tell",
  "service", "serviced", "record", "records", "history", "again", "still", "need",
]);

const ALIASES: Record<string, string[]> = {
  fridge: ["refrigerator", "fridge"],
  freezer: ["refrigerator", "freezer"],
  ac: ["hvac", "air conditioner", "ac"],
  aircon: ["hvac", "air conditioner"],
  air: ["hvac"],
  heater: ["water heater", "heater"],
  boiler: ["water heater", "boiler"],
  washer: ["washing machine", "washer"],
  dish: ["dishwasher"],
  garage: ["garage door"],
  key: ["spare key", "key"],
  valve: ["water shutoff", "valve"],
  paint: ["paint colour", "paint"],
};

export type Hit = {
  type: "memory" | "service" | "issue" | "appliance" | "reminder";
  id: string;
  date: string | null;
  title: string;
  detail: string;
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contains(hay: string, term: string): boolean {
  return new RegExp(`\\b${escapeRe(term)}`, "i").test(hay);
}

/**
 * One search across everything a home knows. FTS finds the memory candidates,
 * everything else is scored by term overlap on small tables.
 */
export function searchAll(query: string, opts: { limit?: number; room?: string } = {}): Hit[] {
  const limit = opts.limit ?? 6;
  const base = termsOf(query);
  const expanded = new Set<string>(base);
  for (const t of base) for (const a of ALIASES[t] ?? []) expanded.add(a);
  const terms = [...expanded];
  if (terms.length === 0) terms.push(query.toLowerCase().trim());

  const scored: { hit: Hit; score: number }[] = [];
  const add = (hit: Hit, score: number) => {
    if (score > 0) scored.push({ hit, score });
  };

  // -- memories: FTS relevance, boosted when every query term is present
  const memories = searchMemories(query, { limit: 25, room: opts.room });
  memories.forEach((m, i) => {
    const hay = `${m.text} ${m.subject ?? ""} ${m.tags ?? ""} ${m.room ?? ""}`;
    const matched = terms.filter((t) => contains(hay, t)).length;
    add(
      {
        type: "memory",
        id: m.id,
        date: m.happened_at ?? m.created_at.slice(0, 10),
        title: m.subject ?? "note",
        detail: m.text,
      },
      1.0 + matched * 0.4 - i * 0.05,
    );
  });

  // -- appliances (with live warranty status folded into the haystack)
  for (const a of listAppliances()) {
    const w = warrantyStatus(a);
    const hay = `${a.name} ${a.room ?? ""} ${a.brand ?? ""} ${a.notes ?? ""} warranty`;
    const matched = terms.filter((t) => contains(hay, t)).length;
    if (!matched) continue;
    const detail = [
      [a.brand, a.model].filter(Boolean).join(" "),
      a.room ? `in the ${a.room}` : "",
      w.expires_at ? `warranty ends ${w.expires_at} (${w.days_left} days)` : "no warranty on file",
      a.notes ?? "",
    ]
      .filter(Boolean)
      .join(", ");
    add({ type: "appliance", id: a.id, date: a.purchased_at, title: a.name, detail }, 1.1 + matched * 0.35);
  }

  // -- service ledger
  for (const s of listServices({ limit: 100 })) {
    const hay = `${s.appliance_name} ${s.vendor ?? ""} ${s.notes ?? ""}`;
    const matched = terms.filter((t) => contains(hay, t)).length;
    if (!matched) continue;
    const cost = s.cost_cents == null ? null : `${s.currency ?? "USD"} ${(s.cost_cents / 100).toFixed(2)}`;
    add(
      {
        type: "service",
        id: s.id,
        date: s.performed_at,
        title: s.appliance_name,
        detail: [s.notes ?? "service", s.vendor ? `by ${s.vendor}` : "", cost ? `cost ${cost}` : ""]
          .filter(Boolean)
          .join(", "),
      },
      1.3 + matched * 0.4,
    );
  }

  // -- issues
  for (const i of listIssues()) {
    const hay = `${i.title} ${i.appliance_name ?? ""} ${i.notes ?? ""} ${i.resolution ?? ""}`;
    const matched = terms.filter((t) => contains(hay, t)).length;
    if (!matched) continue;
    add(
      {
        type: "issue",
        id: i.id,
        date: i.opened_at,
        title: i.title,
        detail: i.status === "open" ? `still open. ${i.notes ?? ""}` : `resolved ${i.resolved_at}. ${i.resolution ?? ""}`,
      },
      1.15 + matched * 0.4,
    );
  }

  // -- reminders
  for (const r of listReminders()) {
    const hay = `${r.title} ${r.notes ?? ""}`;
    const matched = terms.filter((t) => contains(hay, t)).length;
    if (!matched) continue;
    add(
      { type: "reminder", id: r.id, date: r.due_at, title: r.title, detail: r.notes ?? `due ${r.due_at ?? "no date"}` },
      0.9 + matched * 0.3,
    );
  }

  scored.sort((a, b) => b.score - a.score || String(b.hit.date ?? "").localeCompare(String(a.hit.date ?? "")));
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const s of scored) {
    const key = `${s.hit.type}:${s.hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.hit);
    if (out.length >= limit) break;
  }
  return out;
}


function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function ftsQuery(terms: string[], mode: "AND" | "OR"): string {
  return terms.map((t) => `"${t}"*`).join(mode === "AND" ? " AND " : " OR ");
}

export function searchMemories(query: string, opts: { room?: string; limit?: number } = {}): Memory[] {
  const limit = opts.limit ?? 5;
  const d = getDb();
  const terms = termsOf(query);
  let rows: Memory[] = [];
  // Precision first (every term must appear), then fall back to any term.
  for (const mode of ["AND", "OR"] as const) {
    if (rows.length >= Math.min(2, limit)) break;
    if (!terms.length) break;
    const q = ftsQuery(terms, mode);
    const found = d
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS score
           FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ?${opts.room ? " AND lower(m.room) = lower(?)" : ""}
          ORDER BY score ASC, m.created_at DESC
          LIMIT ?`,
      )
      .all(...(opts.room ? [q, opts.room, limit] : [q, limit])) as unknown as Memory[];
    const seen = new Set(rows.map((r) => r.id));
    rows = [...rows, ...found.filter((f) => !seen.has(f.id))].slice(0, limit);
  }
  if (rows.length === 0) {
    const like = `%${query.trim()}%`;
    rows = d
      .prepare(
        `SELECT *, 0 AS score FROM memories
          WHERE (text LIKE ? OR coalesce(subject,'') LIKE ? OR coalesce(tags,'') LIKE ?)
          ${opts.room ? "AND lower(room) = lower(?)" : ""}
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...(opts.room ? [like, like, like, opts.room, limit] : [like, like, like, limit])) as unknown as Memory[];
  }
  return rows;
}

export function insertMemory(input: {
  text: string;
  subject?: string | null;
  room?: string | null;
  tags?: string[] | null;
  kind?: string;
  happened_at?: string | null;
}): Memory {
  const d = getDb();
  const row: Memory = {
    id: randomUUID(),
    text: input.text.trim(),
    subject: input.subject?.trim() || null,
    room: input.room?.trim() || null,
    tags: input.tags?.length ? input.tags.join(",") : null,
    kind: input.kind ?? "fact",
    happened_at: input.happened_at ?? today(),
    created_at: nowIso(),
  };
  d.prepare(
    `INSERT INTO memories (id, text, subject, room, tags, kind, happened_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.text, row.subject, row.room, row.tags, row.kind, row.happened_at, row.created_at);
  return row;
}

export function deleteMemoriesByIds(ids: string[]): number {
  const d = getDb();
  const stmt = d.prepare(`DELETE FROM memories WHERE id = ?`);
  let n = 0;
  for (const id of ids) {
    const info = stmt.run(id);
    n += Number(info.changes ?? 0);
  }
  return n;
}

/* ---------------------------------------------------------------- appliances */

export function listAppliances(): Appliance[] {
  return getDb().prepare(`SELECT * FROM appliances ORDER BY name COLLATE NOCASE`).all() as unknown as Appliance[];
}

export function findAppliance(name: string): Appliance | undefined {
  const d = getDb();
  const exact = d.prepare(`SELECT * FROM appliances WHERE lower(name) = lower(?)`).get(name) as unknown as Appliance | undefined;
  if (exact) return exact;
  const fuzzy = d
    .prepare(`SELECT * FROM appliances WHERE lower(name) LIKE lower(?) ORDER BY name LIMIT 1`)
    .get(`%${name}%`) as unknown as Appliance | undefined;
  return fuzzy;
}

export function upsertAppliance(input: {
  name: string;
  room?: string | null;
  brand?: string | null;
  model?: string | null;
  purchased_at?: string | null;
  warranty_months?: number | null;
  notes?: string | null;
}): Appliance {
  const d = getDb();
  const existing = findAppliance(input.name);
  if (existing) {
    const merged = {
      ...existing,
      room: input.room ?? existing.room,
      brand: input.brand ?? existing.brand,
      model: input.model ?? existing.model,
      purchased_at: input.purchased_at ?? existing.purchased_at,
      warranty_months: input.warranty_months ?? existing.warranty_months,
      notes: input.notes ?? existing.notes,
    };
    d.prepare(
      `UPDATE appliances SET room=?, brand=?, model=?, purchased_at=?, warranty_months=?, notes=? WHERE id=?`,
    ).run(
      merged.room ?? null,
      merged.brand ?? null,
      merged.model ?? null,
      merged.purchased_at ?? null,
      merged.warranty_months ?? null,
      merged.notes ?? null,
      existing.id,
    );
    return { ...merged, id: existing.id };
  }
  const row: Appliance = {
    id: randomUUID(),
    name: input.name.trim(),
    room: input.room ?? null,
    brand: input.brand ?? null,
    model: input.model ?? null,
    purchased_at: input.purchased_at ?? null,
    warranty_months: input.warranty_months ?? null,
    notes: input.notes ?? null,
  };
  d.prepare(
    `INSERT INTO appliances (id, name, room, brand, model, purchased_at, warranty_months, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.name, row.room, row.brand, row.model, row.purchased_at, row.warranty_months, row.notes, nowIso());
  return row;
}

export function warrantyStatus(a: Appliance): { expires_at: string | null; days_left: number | null } {
  if (!a.purchased_at || a.warranty_months == null) return { expires_at: null, days_left: null };
  const expires = addMonths(a.purchased_at, a.warranty_months);
  return { expires_at: expires, days_left: daysBetween(today(), expires) };
}

/* ------------------------------------------------------------------- service */

export function insertService(input: {
  appliance_name: string;
  performed_at?: string;
  vendor?: string | null;
  cost_cents?: number | null;
  currency?: string | null;
  notes?: string | null;
}): ServiceEvent {
  const row: ServiceEvent = {
    id: randomUUID(),
    appliance_name: input.appliance_name.trim(),
    performed_at: input.performed_at ?? today(),
    vendor: input.vendor ?? null,
    cost_cents: input.cost_cents ?? null,
    currency: input.currency ?? "USD",
    notes: input.notes ?? null,
  };
  getDb()
    .prepare(
      `INSERT INTO service_events (id, appliance_name, performed_at, vendor, cost_cents, currency, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.appliance_name, row.performed_at, row.vendor, row.cost_cents, row.currency, row.notes, nowIso());
  return row;
}

export function listServices(opts: { appliance?: string; limit?: number } = {}): ServiceEvent[] {
  const limit = opts.limit ?? 20;
  if (opts.appliance) {
    return getDb()
      .prepare(
        `SELECT * FROM service_events WHERE lower(appliance_name) LIKE lower(?) ORDER BY performed_at DESC LIMIT ?`,
      )
      .all(`%${opts.appliance}%`, limit) as unknown as ServiceEvent[];
  }
  return getDb()
    .prepare(`SELECT * FROM service_events ORDER BY performed_at DESC LIMIT ?`)
    .all(limit) as unknown as ServiceEvent[];
}

/* -------------------------------------------------------------------- issues */

export type Issue = {
  id: string;
  title: string;
  appliance_name: string | null;
  status: string;
  opened_at: string;
  resolved_at: string | null;
  resolution: string | null;
  notes: string | null;
};

export function listIssues(status?: "open" | "resolved"): Issue[] {
  if (status) return getDb().prepare(`SELECT * FROM issues WHERE status=? ORDER BY opened_at DESC`).all(status) as unknown as Issue[];
  return getDb().prepare(`SELECT * FROM issues ORDER BY status, opened_at DESC`).all() as unknown as Issue[];
}

export function openIssue(input: { title: string; appliance_name?: string | null; notes?: string | null }): Issue {
  const row: Issue = {
    id: randomUUID(),
    title: input.title.trim(),
    appliance_name: input.appliance_name ?? null,
    status: "open",
    opened_at: today(),
    resolved_at: null,
    resolution: null,
    notes: input.notes ?? null,
  };
  getDb()
    .prepare(
      `INSERT INTO issues (id, title, appliance_name, status, opened_at, resolved_at, resolution, notes)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(row.id, row.title, row.appliance_name, row.status, row.opened_at, row.notes);
  return row;
}

export function resolveIssue(match: string, resolution: string | null): Issue | undefined {
  const d = getDb();
  const issue =
    (d.prepare(`SELECT * FROM issues WHERE id = ? AND status='open'`).get(match) as unknown as Issue | undefined) ??
    (d
      .prepare(`SELECT * FROM issues WHERE status='open' AND (lower(title) LIKE lower(?) OR lower(coalesce(appliance_name,'')) LIKE lower(?)) ORDER BY opened_at DESC LIMIT 1`)
      .get(`%${match}%`, `%${match}%`) as unknown as Issue | undefined);
  if (!issue) return undefined;
  d.prepare(`UPDATE issues SET status='resolved', resolved_at=?, resolution=? WHERE id=?`).run(today(), resolution, issue.id);
  return { ...issue, status: "resolved", resolved_at: today(), resolution };
}

/* ----------------------------------------------------------------- reminders */

export type Reminder = { id: string; title: string; due_at: string | null; done_at: string | null; notes: string | null };

export function listReminders(includeDone = false): Reminder[] {
  const sql = includeDone
    ? `SELECT * FROM reminders ORDER BY coalesce(due_at,'9999') ASC`
    : `SELECT * FROM reminders WHERE done_at IS NULL ORDER BY coalesce(due_at,'9999') ASC`;
  return getDb().prepare(sql).all() as unknown as Reminder[];
}

export function addReminder(input: { title: string; due_at?: string | null; notes?: string | null }): Reminder {
  const row: Reminder = {
    id: randomUUID(),
    title: input.title.trim(),
    due_at: input.due_at ?? null,
    done_at: null,
    notes: input.notes ?? null,
  };
  getDb()
    .prepare(`INSERT INTO reminders (id, title, due_at, done_at, notes, created_at) VALUES (?, ?, ?, NULL, ?, ?)`)
    .run(row.id, row.title, row.due_at, row.notes, nowIso());
  return row;
}

export function completeReminder(match: string): Reminder | undefined {
  const d = getDb();
  const rem =
    (d.prepare(`SELECT * FROM reminders WHERE id=? AND done_at IS NULL`).get(match) as unknown as Reminder | undefined) ??
    (d
      .prepare(`SELECT * FROM reminders WHERE done_at IS NULL AND lower(title) LIKE lower(?) ORDER BY coalesce(due_at,'9999') LIMIT 1`)
      .get(`%${match}%`) as unknown as Reminder | undefined);
  if (!rem) return undefined;
  d.prepare(`UPDATE reminders SET done_at=? WHERE id=?`).run(today(), rem.id);
  return { ...rem, done_at: today() };
}

/* -------------------------------------------------------------------- digest */

export type Brief = {
  generated_for: string;
  due_reminders: (Reminder & { days_left: number | null })[];
  expiring_warranties: (Appliance & { expires_at: string; days_left: number })[];
  overdue_service: { appliance: string; last_service: string | null; days_since: number | null }[];
  open_issues: Issue[];
};

export function homeBrief(): Brief {
  const t = today();
  const reminders = listReminders()
    .filter((r) => (r.due_at ? daysBetween(t, r.due_at) <= 45 : true))
    .map((r) => ({ ...r, days_left: r.due_at ? daysBetween(t, r.due_at) : null }))
    .slice(0, 6);

  const warranties = listAppliances()
    .map((a) => ({ ...a, ...warrantyStatus(a) }))
    .filter((a) => a.days_left != null && a.days_left >= 0 && a.days_left < 180)
    .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0))
    .slice(0, 5)
    .map((a) => ({ ...a, expires_at: a.expires_at as string, days_left: a.days_left as number }));

  const overdue = listAppliances()
    .map((a) => {
      const last = listServices({ appliance: a.name, limit: 1 })[0] ?? null;
      const days_since = last ? daysBetween(last.performed_at, t) : null;
      return { appliance: a.name, last_service: last?.performed_at ?? null, days_since };
    })
    .filter((x) => x.days_since == null || x.days_since > 180)
    .slice(0, 5);

  return {
    generated_for: t,
    due_reminders: reminders,
    expiring_warranties: warranties,
    overdue_service: overdue,
    open_issues: listIssues("open"),
  };
}

/* --------------------------------------------------------------------- turns */

export function logTurn(input: {
  session_id: string;
  role: "user" | "assistant";
  text: string;
  tools?: string;
  latency_ms?: number;
}): void {
  getDb()
    .prepare(`INSERT INTO turns (id, session_id, role, text, tools, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.session_id, input.role, input.text, input.tools ?? null, input.latency_ms ?? null, nowIso());
}

export function recentTurns(session_id: string, limit = 20): { role: string; text: string; created_at: string }[] {
  const rows = getDb()
    .prepare(`SELECT role, text, created_at FROM turns WHERE session_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(session_id, limit) as unknown as { role: string; text: string; created_at: string }[];
  return rows.reverse();
}

/* --------------------------------------------------------------------- state */

export function houseState() {
  const appliances = listAppliances().map((a) => ({ ...a, warranty: warrantyStatus(a) }));
  const services = listServices({ limit: 8 });
  const all = getDb().prepare(`SELECT * FROM memories ORDER BY created_at DESC LIMIT 12`).all() as unknown as Memory[];
  return {
    house: process.env.ATTIC_HOUSE_NAME ?? "Casa Wibowo",
    today: today(),
    appliances,
    services,
    issues: listIssues(),
    reminders: listReminders(),
    memories: all,
    brief: homeBrief(),
  };
}
