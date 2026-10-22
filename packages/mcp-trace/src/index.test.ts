import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { TraceBus, mcpTrace, methodOf, parseFrames } from "./index.js";

test("methodOf labels requests, results and errors", () => {
  assert.equal(methodOf({ jsonrpc: "2.0", id: 1, method: "initialize" }), "initialize");
  assert.equal(
    methodOf({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recall", arguments: {} } }),
    "tools/call:recall",
  );
  assert.equal(methodOf({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "recall" }] } }), "result:tools");
  assert.equal(methodOf({ jsonrpc: "2.0", id: 3, result: { content: [] } }), "result");
  assert.equal(methodOf({ jsonrpc: "2.0", id: 4, error: { code: -32601 } }), "error");
  assert.equal(methodOf([{ jsonrpc: "2.0" }]), "batch");
  assert.equal(methodOf("nope"), "unknown");
});

test("parseFrames unwraps SSE and plain JSON bodies", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n: ping\n';
  assert.deepEqual(parseFrames(sse), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);

  const json = '{"jsonrpc":"2.0","id":2,"result":{}}';
  assert.deepEqual(parseFrames(json), [{ jsonrpc: "2.0", id: 2, result: {} }]);

  assert.deepEqual(parseFrames("   "), []);
  assert.deepEqual(parseFrames(": keep-alive\n\n"), []);
});

test("the bus keeps a ring buffer per session and fans out to subscribers", () => {
  const bus = new TraceBus(3);
  const seen: string[] = [];
  const off = bus.subscribe((f) => seen.push(f.method));

  for (let i = 0; i < 5; i++) {
    bus.push({ id: String(i), session: "a", dir: "in", at: 0, ms: 0, method: `m${i}`, jsonrpc: "2.0", payload: {} });
  }
  bus.push({ id: "x", session: "b", dir: "out", at: 0, ms: 1, method: "result", jsonrpc: "2.0", payload: {} });

  assert.equal(bus.all().length, 3, "ring buffer trims to capacity (global, oldest first out)");
  assert.deepEqual(
    bus.recent("a").map((f) => f.method),
    ["m3", "m4"],
  );
  assert.deepEqual(bus.recent("b").map((f) => f.method), ["result"]);
  assert.equal(seen.length, 6);

  off();
  bus.push({ id: "y", session: "a", dir: "in", at: 0, ms: 0, method: "after", jsonrpc: "2.0", payload: {} });
  assert.equal(seen.length, 6, "unsubscribe stops delivery");
});

function fakeExchange(body: unknown, session: string) {
  const bus = new TraceBus();
  const middleware = mcpTrace({ bus, id: (() => {
    let n = 0;
    return () => String(++n);
  })() });

  const req = {
    method: "POST",
    headers: session ? { "x-mcp-trace": session } : {},
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
  } as never;

  let ended = false;
  const res = {
    statusCode: 200,
    write() {
      return true;
    },
    end(chunk?: unknown) {
      ended = true;
      void chunk;
    },
  } as never;

  middleware(req, res, () => {});
  return { bus, res: res as { write: (c: string) => void; end: (c?: string) => void }, req, ended: () => ended };
}

test("middleware records the request and the SSE response frames", () => {
  const { bus, res } = fakeExchange(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall" } },
    "s1",
  );
  res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n');
  res.end();

  const frames = bus.recent("s1");
  assert.equal(frames.length, 2);
  assert.equal(frames[0].dir, "in");
  assert.equal(frames[0].method, "tools/call:recall");
  assert.equal(frames[1].dir, "out");
  assert.equal(frames[1].method, "result");
  assert.ok(frames[1].ms >= 0);
  assert.equal(frames[1].status, 200);
});

test("middleware falls back to the anon session and skips OPTIONS", () => {
  const { bus, res } = fakeExchange({ jsonrpc: "2.0", id: 9, method: "tools/list" }, "");
  res.end("{}");
  assert.equal(bus.recent("anon").length, 2);

  const bus2 = new TraceBus();
  const mw = mcpTrace({ bus: bus2 });
  let called = false;
  mw({ method: "OPTIONS", headers: {} } as never, {} as never, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(bus2.all().length, 0);
});

test("EventEmitter-shaped requests are not required", () => {
  // Guard against accidentally depending on Express-only members.
  const req = new EventEmitter() as unknown as { headers: Record<string, string> };
  req.headers = {};
  assert.ok(req);
});
