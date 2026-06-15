// Wires everything together: SSE event stream -> transcript + mascot + status.
import { Mascot } from "./mascot.js";
import { Transcript } from "./transcript.js";
import { Settings } from "./settings.js";
import { escapeHtml } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const api = (path, body) =>
  fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
    .then((r) => r.json());

const state = {
  config: null,
  busy: false,
  turnId: 0,
  step: -1,
  asstKey: null,
  totalIn: 0,
  totalOut: 0,
};

let mascot, transcript, settings;

function applyConfig(cfg) {
  state.config = cfg;
  document.documentElement.dataset.theme = cfg.theme || "dark";
  document.body.classList.toggle("no-mascot", cfg.mascot === false);
  const provLabel = (cfg.providersMeta && cfg.providersMeta[cfg.provider]?.label) || cfg.provider;
  $("provider-chip").textContent = provLabel;
  $("model-chip").textContent = cfg.model || "(no model)";
  $("status-provider").textContent = provLabel;
  $("status-model").textContent = cfg.model || "(no model)";
  $("status-approval").textContent = cfg.approvalMode === "yolo" ? "auto-approve" : "ask first";
  // first-run nudge
  const needsKey = cfg.providersMeta?.[cfg.provider]?.needsKey;
  if (needsKey && cfg.hasKey && !cfg.hasKey[cfg.provider]) {
    openSettings();
    transcript.notice("Pick a provider and paste an API key to begin.");
  }
}

function setBusy(b) {
  state.busy = b;
  $("send").disabled = b;
  $("stop").hidden = !b;
  $("input").classList.toggle("working", b);
}

function setMascot(activity, detail) {
  if (mascot) mascot.setActivity(activity);
  if (detail !== undefined) $("mascot-detail").textContent = detail;
  $("mascot-live").textContent = detail || "";
}

// ---- SSE handling ----
function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => ($("status-conn").textContent = "connected");
  es.onerror = () => ($("status-conn").textContent = "reconnecting…");
  const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch {} });

  on("user", (d) => { transcript.addUser(d.text); });

  on("run", (d) => {
    if (d.phase === "started") {
      setBusy(true);
      state.turnId = d.turnId;
      state.step = -1;
      state.asstKey = null;
      state.totalIn = 0; state.totalOut = 0;
      setMascot("thinking", "Thinking…");
      return;
    }
    // terminal phases: close any half-streamed assistant bubble cleanly
    if (state.asstKey) { transcript.assistantDone(state.asstKey); state.asstKey = null; }
    setBusy(false);
    if (d.phase === "finished") setMascot("success", "Done");
    else if (d.phase === "error") setMascot("error", "Something went wrong");
    else if (d.phase === "cancelled") setMascot("idle", "Stopped");
  });

  on("step_start", (d) => {
    state.step = d.step;
    state.asstKey = null;
    if (state.busy) setMascot("thinking", "Thinking…");
  });

  on("reasoning", () => setMascot("thinking", "Reasoning…"));

  on("message", (d) => {
    if (!state.asstKey) state.asstKey = `a-${d.turnId}-${state.step}`;
    transcript.assistantDelta(state.asstKey, d.delta);
    setMascot("typing", "Writing a reply…");
  });

  on("message_end", () => {
    if (state.asstKey) transcript.assistantDone(state.asstKey);
    state.asstKey = null;
  });

  on("tool_start", (d) => {
    transcript.toolStart(d.id, { title: d.title, name: d.name, activity: d.activity });
    setMascot(d.activity || "running", d.title);
  });

  on("tool_end", (d) => {
    transcript.toolEnd(d.id, { ok: d.ok, summary: d.summary, output: d.output, meta: d.meta });
  });

  on("approval_request", (d) => {
    transcript.approvalRequest(d.id, d);
    setMascot("thinking", "Waiting for your approval…");
  });

  on("approval_resolved", (d) => transcript.approvalResolved(d.id, d.decision));

  on("usage", (d) => {
    state.totalIn = d.totalInput; state.totalOut = d.totalOutput;
    $("status-tokens").textContent = `↑${fmt(d.totalInput)} ↓${fmt(d.totalOutput)}`;
  });

  on("error", (d) => transcript.error(d.message));
  on("notice", (d) => transcript.notice(d.message));
  on("reset", () => { transcript.clear(); welcome(); setMascot("idle", ""); });
  on("resync", () => transcript.notice("Reconnected. Some earlier activity may be missing; click New chat to start fresh if things look off."));
}

function fmt(n) {
  if (!n) return "0";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ---- actions ----
function send() {
  const input = $("input");
  const text = input.value.trim();
  if (!text || state.busy) return;
  input.value = "";
  input.style.height = "auto";
  api("/api/chat", { message: text });
}

function openSettings() {
  api("/api/state").then((s) => {
    // attach provider meta so settings + chips have labels
    s.config.providersMeta = s.providers;
    settings.open(s);
  });
}

function welcome() {
  const cfg = state.config || {};
  const div = document.createElement("div");
  div.className = "welcome";
  div.innerHTML = `
    <div class="welcome-glyph">✻</div>
    <div>
      <div class="welcome-title">Pixie is ready.</div>
      <div class="welcome-sub">Working in <code>${escapeHtml(cfg.cwd || "")}</code> · ${escapeHtml(cfg.model || "no model set")}</div>
      <div class="welcome-sub">Ask me to build, fix, explain, or run something. Watch the mascot to see what I'm doing.</div>
    </div>`;
  $("transcript").appendChild(div);
}

// ---- init ----
async function init() {
  transcript = new Transcript($("transcript"), {
    onApprove: (id, decision) => api("/api/approve", { id, decision }),
  });
  mascot = new Mascot($("mascot-canvas"), { onLabel: (l) => ($("mascot-label").textContent = l) });

  const s = await api("/api/state");
  const providersMeta = s.providers;
  const cwd = s.cwd;

  settings = new Settings($("settings-overlay"), {
    onSaved: (cfg) => applyConfig({ ...cfg, providersMeta, cwd }),
  });

  applyConfig({ ...s.config, providersMeta, cwd });
  $("cwd").textContent = cwd;
  welcome();
  connect();

  // composer
  const input = $("input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });
  $("send").addEventListener("click", send);
  $("stop").addEventListener("click", () => api("/api/stop", {}));
  $("new-chat").addEventListener("click", () => api("/api/reset", {}));
  $("settings-btn").addEventListener("click", openSettings);
  $("theme-btn").addEventListener("click", () => {
    const next = (state.config.theme === "dark" ? "light" : "dark");
    api("/api/config", { theme: next }).then((d) => applyConfig({ ...d.config, providersMeta, cwd }));
  });
  input.focus();
}

init();
