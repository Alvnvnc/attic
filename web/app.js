const SESSION_KEY = "attic.session";
const sessionId = (() => {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
})();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  busy: false,
  tools: [],
  protocol: "2025-11-25",
  frames: 0,
};

const transcript = $("#transcript");
const emptyState = $("#empty");
const composer = $("#composer");
const promptInput = $("#prompt");
const presence = $("#presence");
const presenceLabel = $("#presence-label");
const presenceSub = $("#presence-sub");
const framesEl = $("#frames");
const frameCount = $("#frame-count");
const sendBtn = $(".send", composer);

/* ------------------------------------------------------------------- helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setPresence(mode, label, sub) {
  presence.dataset.state = mode;
  presenceLabel.textContent = label;
  presenceSub.textContent = sub;
}

function scrollTranscript() {
  transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
}

const MIC_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3Zm-6-3v1a6 6 0 0 0 12 0V7M12 17v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function typeOut(node, text) {
  return new Promise((resolve) => {
    node.classList.add("is-typing");
    let i = 0;
    const step = () => {
      // reveal a few characters per frame so long answers stay snappy
      i = Math.min(text.length, i + 2);
      node.textContent = text.slice(0, i);
      if (i < text.length) requestAnimationFrame(step);
      else {
        node.classList.remove("is-typing");
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

/* ---------------------------------------------------------------- the wire */

const seenFrames = new Set();

function addFrame(frame) {
  const key = `${frame.id}`;
  if (seenFrames.has(key)) return;
  seenFrames.add(key);

  const row = el("div", "frame");
  row.dataset.dir = frame.dir;
  row.dataset.id = frame.id;

  const arrow = el("span", "arrow", frame.dir === "in" ? ">" : "<");
  const method = el("span", "method", frame.method.replace(/:/g, " · "));
  if (frame.method.startsWith("tools/call")) method.dataset.tool = "1";
  if (frame.method === "initialize" || frame.method === "result:tools") row.dataset.handshake = "1";
  const ms = el("span", "ms", frame.dir === "out" ? `${frame.ms}ms` : "");
  row.append(arrow, method, ms);

  const payload = el("pre", "frame-payload", pretty(frame.payload));
  payload.hidden = true;
  row.append(payload);

  row.addEventListener("click", () => {
    const open = row.classList.toggle("is-open");
    payload.hidden = !open;
  });

  framesEl.append(row);
  while (framesEl.children.length > 160) framesEl.firstElementChild.remove();
  framesEl.scrollTop = framesEl.scrollHeight;

  state.frames += 1;
  frameCount.textContent = `${state.frames} frame${state.frames === 1 ? "" : "s"}`;
}

function connectWire() {
  const pill = $("#wire-pill");
  const source = new EventSource(`/api/trace/stream?session=${encodeURIComponent(sessionId)}`);
  source.onopen = () => {
    pill.textContent = "live";
    pill.classList.add("is-live");
  };
  source.onmessage = (event) => {
    if (!event.data) return;
    try {
      addFrame(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  source.onerror = () => {
    pill.textContent = "reconnecting";
    pill.classList.remove("is-live");
  };
}

/* ------------------------------------------------------------------- asking */

function startTurn(text) {
  if (emptyState && !emptyState.hidden) emptyState.hidden = true;
  const turn = el("article", "turn");

  const q = el("div", "q");
  q.innerHTML = MIC_SVG;
  q.append(el("span", null, text));

  const toolrow = el("div", "toolrow");
  const answer = el("p", "a");
  const meta = el("div", "meta");

  const thinking = el("div", "thinking");
  thinking.innerHTML = '<span class="bars"><i></i><i></i><i></i><i></i></span><span>reaching into the house…</span>';

  turn.append(q, toolrow, thinking, answer, meta);
  transcript.append(turn);
  scrollTranscript();
  return { turn, toolrow, answer, meta, thinking };
}

function addToolChip(toolrow, call) {
  const chip = el("button", `toolchip${call.ok ? "" : " is-error"}`);
  chip.type = "button";
  chip.innerHTML = `<span>${call.name}</span><em>${call.ms} ms</em>`;
  const detail = el("pre", "tool-detail", `args\n${pretty(call.args)}\n\nresult\n${pretty(call.result)}`);
  detail.hidden = true;
  chip.addEventListener("click", () => {
    detail.hidden = !detail.hidden;
  });
  toolrow.append(chip, detail);
}

async function ask(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true;
  sendBtn.disabled = true;
  promptInput.value = "";
  setPresence("thinking", "Listening closely", "Attic is searching the house memory.");

  const { toolrow, answer, meta, thinking } = startTurn(text.trim());

  const started = performance.now();
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-attic-session": sessionId },
      body: JSON.stringify({ text: text.trim() }),
    });
    const data = await res.json();
    thinking.remove();

    for (const call of data.tool_calls ?? []) addToolChip(toolrow, call);

    const elapsed = Math.round(performance.now() - started);
    const tools = data.tool_calls?.length ?? 0;
    meta.textContent = `${(elapsed / 1000).toFixed(1)}s · ${data.model ?? "model"} · ${tools} tool call${
      tools === 1 ? "" : "s"
    } · MCP ${data.protocol ?? state.protocol}`;

    setPresence("speaking", "Speaking", "Grounded in household memory.");
    await typeOut(answer, data.answer ?? "I could not reach the house memory.");
    setPresence("idle", "Ready when you are", "Every answer is a real MCP tool call over Streamable HTTP.");
    scrollTranscript();
    loadState();
  } catch (err) {
    thinking.remove();
    answer.textContent = "The house memory did not answer. Check the wire on the right.";
    answer.style.color = "var(--red)";
    meta.textContent = String(err);
    setPresence("idle", "Ready when you are", "Something interrupted the MCP session.");
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    promptInput.focus();
  }
}

/* -------------------------------------------------------------------- state */

function warrantyBar(appliance) {
  const wrap = el("div", "warranty");
  const bar = el("div", "bar");
  const fill = el("i");
  const days = appliance.warranty?.days_left;
  const months = appliance.warranty_months ?? 24;
  if (days == null) {
    fill.style.width = "0%";
  } else if (days < 0) {
    bar.classList.add("is-dead");
    fill.style.width = "100%";
  } else {
    const totalDays = Math.max(months * 30, 30);
    const pct = Math.max(4, Math.min(100, (days / totalDays) * 100));
    fill.style.width = `${pct}%`;
    if (days < 90) bar.classList.add("is-warn");
  }
  bar.append(fill);
  const label = days == null ? "no warranty on file" : days < 0 ? "warranty ended" : `${days} days left`;
  wrap.append(bar, el("span", null, label));
  return wrap;
}

function renderState(data) {
  state.protocol = data.protocol ?? data.server?.protocol ?? state.protocol;
  $("#protocol-chip").textContent = `MCP ${state.protocol}`;
  if (data.house) {
    const h1 = $("h1");
    if (h1 && h1.textContent !== data.house) h1.textContent = data.house;
  }

  const appliances = $("#appliances");
  if (appliances) {
    appliances.innerHTML = "";
    for (const a of data.appliances ?? []) {
      const row = el("div", "appliance");
      const top = el("div", "appliance-top");
      top.append(el("span", "appliance-name", a.name), el("span", "appliance-room", a.room ?? ""));
      row.append(top, warrantyBar(a));
      appliances.append(row);
    }
  }

  const services = $("#services");
  if (services) {
    services.innerHTML = "";
    for (const s of data.services ?? []) {
      const row = el("div", "service");
      row.append(el("time", null, s.performed_at));
      const body = el("div");
      body.append(el("p", null, `${s.appliance_name} — ${s.notes ?? "service"}`));
      const money = s.cost_cents == null ? null : `${s.currency ?? "USD"} ${(s.cost_cents / 100).toFixed(2)}`;
      const sub = [s.vendor, money].filter(Boolean).join(" · ");
      if (sub) body.append(el("span", "sub", sub));
      row.append(body);
      services.append(row);
    }
  }

  const issues = $("#issues");
  if (issues) {
    issues.innerHTML = "";
    const list = [...(data.issues ?? [])].sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
    for (const i of list) {
      const row = el("div", "issue");
      row.append(el("span", `tag ${i.status}`, i.status));
      const body = el("div");
      body.append(el("p", null, i.title));
      const note = i.status === "open" ? i.notes : i.resolution;
      if (note) body.append(el("span", "note", note));
      row.append(body);
      issues.append(row);
    }
    if (!list.length) issues.append(el("p", "muted", "Nothing broken. Rare."));
  }

  const memories = $("#memories");
  if (memories) {
    memories.innerHTML = "";
    for (const m of data.memories ?? []) {
      const row = el("div", "memory");
      row.append(el("time", null, (m.happened_at ?? m.created_at ?? "").slice(0, 10)));
      const body = el("div");
      body.append(el("p", null, m.text));
      const sub = [m.subject, m.room].filter(Boolean).join(" · ");
      if (sub) body.append(el("span", "sub", sub));
      row.append(body);
      memories.append(row);
    }
  }
}

async function loadState() {
  try {
    const res = await fetch("/api/state");
    renderState(await res.json());
  } catch {
    /* keep the last good state */
  }
}

async function loadManifest() {
  try {
    const res = await fetch("/api/manifest");
    const data = await res.json();
    state.tools = data.tools ?? [];
    $("#inspector-meta").textContent = `${data.server.name}@${data.server.version} · ${data.server.transport} · ${data.server.protocol} · ${
      state.tools.length
    } tools`;
    const list = $("#tools");
    if (list) {
      list.innerHTML = "";
      for (const t of state.tools) {
        const row = el("div", "tool");
        row.append(el("code", null, t.name), el("p", null, t.description ?? ""));
        list.append(row);
      }
    }
  } catch {
    /* manifest is a nicety, not a dependency */
  }
}

/* -------------------------------------------------------------------- views */

function showView(name) {
  const target = ["live", "ledger", "protocol"].includes(name) ? name : "live";
  for (const view of $$(".view")) view.hidden = view.id !== `view-${target}`;
  for (const btn of $$(".rail-btn")) btn.classList.toggle("is-active", btn.dataset.view === target);
  if (target === "live") setTimeout(() => promptInput.focus(), 30);
}

window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

/* -------------------------------------------------------------------- voice */

function wireMic() {
  const mic = $("#mic");
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    mic.addEventListener("click", () => {
      promptInput.focus();
      promptInput.placeholder = "Voice needs Chrome — type here instead";
    });
    return;
  }
  const recognition = new Recognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  let listening = false;
  recognition.onstart = () => {
    listening = true;
    mic.classList.add("is-live");
    setPresence("thinking", "Listening", "Speak naturally — the transcript is live.");
  };
  recognition.onresult = (event) => {
    const text = [...event.results].map((r) => r[0].transcript).join(" ");
    promptInput.value = text;
    if (event.results[event.results.length - 1].isFinal) {
      ask(text);
    }
  };
  recognition.onend = () => {
    listening = false;
    mic.classList.remove("is-live");
    if (!state.busy) setPresence("idle", "Ready when you are", "Every answer is a real MCP tool call over Streamable HTTP.");
  };
  recognition.onerror = () => {
    listening = false;
    mic.classList.remove("is-live");
    promptInput.placeholder = "Microphone unavailable — type instead";
  };

  mic.addEventListener("click", () => {
    if (listening) recognition.stop();
    else recognition.start();
  });
}

/* --------------------------------------------------------------------- init */

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  ask(promptInput.value);
});

$("#suggestions").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button) ask(button.textContent);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== promptInput) {
    event.preventDefault();
    promptInput.focus();
  }
});

connectWire();
wireMic();
loadManifest();
loadState();
showView(location.hash.slice(1) || "live");
setInterval(loadState, 30_000);
