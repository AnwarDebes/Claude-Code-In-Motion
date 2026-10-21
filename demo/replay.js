// Pixie live demo. Loaded before web/js/app.js, it stands in for the local
// server: the /api endpoints answer from a recorded session (session.js) and
// the event stream is replayed in real time. The UI itself is the unmodified
// code from web/, so what you see is exactly what Pixie renders.
(() => {
  const DEMO = window.__PIXIE_DEMO;
  if (!DEMO) return;
  const state = JSON.parse(JSON.stringify(DEMO.state));
  const REPO = "https://github.com/AnwarDebes/Claude-Code-In-Motion";
  const INSTALL = "npm i -g github:AnwarDebes/Claude-Code-In-Motion";

  // ---- event stream ----
  let es = null;
  class DemoEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      es = this;
      setTimeout(() => this.onopen && this.onopen(), 30);
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    close() {}
  }
  window.EventSource = DemoEventSource;
  let turn = 0;
  function emit(type, data) {
    const payload = { type, t: Date.now(), turnId: turn, ...data };
    for (const fn of (es && es.listeners[type]) || []) fn({ data: JSON.stringify(payload) });
  }

  // ---- player ----
  let run = 0; // bumps on reset/stop so stale timers do nothing
  let idx = 0;
  let gate = null;
  let busy = false;
  let hintTimer = 0, autoTimer = 0;
  let allowAll = false; // "Allow, don't ask again" skips later prompts, like the real harness

  function later(ms, fn) {
    const mine = run;
    setTimeout(() => { if (mine === run) fn(); }, ms);
  }

  function next() {
    if (idx >= DEMO.program.length) return;
    const s = DEMO.program[idx];
    if (s.gate && allowAll) { idx++; next(); return; }
    later(s.gap, () => {
      emit(s.type, s.data);
      idx++;
      if (s.type === "run" && s.data.phase !== "started") { busy = false; finished(); return; }
      if (s.gate) { gate = s.data; waitForYou(); return; }
      next();
    });
  }

  function playRecording() {
    busy = true;
    idx = 0;
    turn = 1;
    allowAll = false;
    banner.setState("playing");
    next();
  }

  function cannedReply(message) {
    busy = true;
    turn++;
    emit("user", { text: message });
    emit("run", { phase: "started", provider: state.config.provider, model: state.config.model });
    emit("step_start", { step: 0 });
    const text = "This is a recorded demo running in your browser, so there is no model behind it. " +
      "Install Pixie and bring your own key to really chat:\n\n```bash\n" + INSTALL + "\npixie\n```";
    const pieces = text.match(/\S+\s*|\s+/g) || [];
    let t = 500;
    for (const p of pieces) { const piece = p; later(t, () => emit("message", { role: "assistant", delta: piece })); t += 18; }
    later(t + 50, () => {
      emit("message_end", { role: "assistant" });
      emit("run", { phase: "finished" });
      busy = false;
    });
  }

  function waitForYou() {
    clearTimeout(hintTimer); clearTimeout(autoTimer);
    const id = gate.id;
    hintTimer = setTimeout(() => { if (gate && gate.id === id) showHint(); }, 3500);
    autoTimer = setTimeout(() => { if (gate && gate.id === id) autoAllow(); }, 14000);
  }

  function resolveGate(id, decision) {
    if (!gate || gate.id !== id) return;
    const g = gate;
    gate = null;
    hideHint();
    clearTimeout(hintTimer); clearTimeout(autoTimer);
    const allow = decision !== "deny";
    if (decision === "always") allowAll = true;
    emit("approval_resolved", { id, decision: allow ? "allow" : "deny" });
    if (allow) { next(); return; }
    // Denied: the harness reports it and the agent stops, as the real one would.
    const msg = "The user denied this action. Do not retry it; consider another approach or ask what to do.";
    later(200, () => {
      emit("tool_end", { id, name: g.name, ok: false, output: msg, summary: "denied", activity: g.activity });
      emit("step_start", { step: 99 });
      const text = "Understood, I left `src/config.js` untouched. Press **Replay** to watch the full run.";
      let t = 600;
      for (const p of text.match(/\S+\s*|\s+/g)) { const piece = p; later(t, () => emit("message", { role: "assistant", delta: piece })); t += 40; }
      later(t + 50, () => { emit("message_end", { role: "assistant" }); emit("run", { phase: "finished" }); busy = false; finished(); });
    });
  }

  function stop() {
    run++;
    gate = null;
    hideHint();
    if (busy) { emit("run", { phase: "cancelled" }); busy = false; }
    banner.setState("idle");
  }

  function reset() {
    stop();
    emit("reset", {});
  }

  function finished() { banner.setState("done"); }

  // ---- fake local API ----
  const realFetch = window.fetch.bind(window);
  const reply = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
  window.fetch = (url, opts = {}) => {
    const path = typeof url === "string" ? url : url.url;
    if (!path.startsWith("/api/")) return realFetch(url, opts);
    let body = {};
    try { body = JSON.parse(opts.body || "{}"); } catch { body = {}; }
    if (path === "/api/state") return reply(state);
    if (path === "/api/config") {
      if (opts.method === "POST") {
        const { keys, ...rest } = body; // never keep keys, even fake ones
        Object.assign(state.config, rest);
        if (rest.baseUrls) state.config.baseUrls = { ...state.config.baseUrls, ...rest.baseUrls };
      }
      return reply({ ok: true, config: state.config });
    }
    if (path === "/api/chat") {
      const m = String(body.message || "").trim();
      if (busy) { emit("notice", { message: "Pixie is still working on the previous message." }); return reply({ ok: true }); }
      if (m === DEMO.prompt) playRecording(); else cannedReply(m);
      return reply({ ok: true });
    }
    if (path === "/api/approve") { resolveGate(body.id, body.decision); return reply({ ok: true }); }
    if (path === "/api/stop") { stop(); return reply({ ok: true }); }
    if (path === "/api/reset") { reset(); return reply({ ok: true }); }
    return reply({ ok: true });
  };

  // ---- typing the prompt like a person ----
  function typePrompt() {
    const input = document.getElementById("input");
    if (!input) return;
    const text = DEMO.prompt;
    input.value = "";
    let t = 0;
    for (let k = 1; k <= text.length; k++) {
      t += 28 + Math.random() * 40;
      const n = k;
      later(t, () => { input.value = text.slice(0, n); input.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    later(t + 450, () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  }

  // ---- approval hint + auto-allow cursor ----
  let hint = null;
  function allowButton() {
    const cards = document.querySelectorAll(".approval:not(.resolved)");
    const card = cards[cards.length - 1];
    return card && card.querySelector(".btn.allow");
  }
  function showHint() {
    const btn = allowButton();
    if (!btn) return;
    hint = document.createElement("div");
    hint.className = "demo-hint";
    hint.textContent = "Your call: Allow or Deny";
    btn.parentElement.appendChild(hint);
  }
  function hideHint() { if (hint) { hint.remove(); hint = null; } }
  function autoAllow() {
    const btn = allowButton();
    if (!btn) return;
    const cur = document.createElement("div");
    cur.className = "demo-cursor";
    const r = btn.getBoundingClientRect();
    cur.style.left = window.innerWidth - 40 + "px";
    cur.style.top = window.innerHeight - 60 + "px";
    document.body.appendChild(cur);
    requestAnimationFrame(() => {
      cur.style.left = r.left + r.width * 0.55 + "px";
      cur.style.top = r.top + r.height * 0.6 + "px";
    });
    setTimeout(() => { cur.classList.add("press"); btn.click(); }, 900);
    setTimeout(() => cur.remove(), 1600);
  }

  // ---- demo banner ----
  const banner = {
    el: null,
    setState(s) {
      if (!this.el) return;
      this.el.dataset.state = s;
      this.el.querySelector(".demo-replay").textContent = s === "playing" ? "Restart" : "Replay";
    },
  };
  function mountBanner() {
    const style = document.createElement("style");
    style.textContent = `
      .demo-bar { width: 100%; max-width: 288px; margin-top: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
        padding: 10px 12px; border-radius: 12px; font-size: 11.5px; line-height: 1.45; color: var(--muted);
        background: color-mix(in srgb, var(--accent) 7%, var(--bg)); border: 1px solid var(--accent); }
      .demo-bar b { color: var(--accent-deep); font-weight: 600; }
      .demo-bar .demo-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
      .demo-bar .demo-label { flex: 1 1 200px; }
      .demo-bar[data-state="playing"] .demo-dot { animation: pulse 1s ease-in-out infinite; }
      .demo-bar a, .demo-bar button { font: inherit; font-size: 11.5px; border-radius: 999px; padding: 4px 12px; cursor: pointer; text-decoration: none; }
      .demo-bar button { background: var(--accent); color: #fff; border: 1px solid var(--accent); margin-left: 16px; }
      .demo-bar .demo-label { text-align: left; }
      .demo-bar a { color: var(--text); border: 1px solid var(--border); background: var(--bg); }
      .demo-hint { display: inline-block; margin-left: 6px; align-self: center; font-size: 12px; color: var(--accent-deep);
        animation: pulse 1.2s ease-in-out infinite; }
      .demo-cursor { position: fixed; z-index: 99; width: 22px; height: 22px; pointer-events: none; transition: left .8s cubic-bezier(.65,0,.35,1), top .8s cubic-bezier(.65,0,.35,1), transform .1s;
        background: no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 26 26'%3E%3Cpath d='M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.6 15 Z' fill='%23fff' stroke='%23111' stroke-width='1.6' stroke-linejoin='round'/%3E%3C/svg%3E"); }
      .demo-cursor.press { transform: scale(0.85); }
      @media (max-width: 820px) { .stage .demo-bar { width: auto; max-width: none; margin: 0 0 0 auto; padding: 6px 8px; flex-wrap: nowrap; align-self: center; }
        .demo-bar .demo-label .demo-more, .demo-bar a { display: none; } .demo-bar button { margin-left: 0; } }
      @media (prefers-reduced-motion: reduce) { .demo-bar .demo-dot, .demo-hint { animation: none; } .demo-cursor { transition: none; } }`;
    document.head.appendChild(style);
    const el = document.createElement("div");
    el.className = "demo-bar";
    el.dataset.state = "idle";
    el.innerHTML = `<span class="demo-dot"></span><span class="demo-label"><b>Live demo</b><span class="demo-more">: a recorded session, replayed in your browser by the real UI.</span></span>
      <button class="demo-replay" type="button">Replay</button><a href="${REPO}" target="_blank" rel="noopener">Get Pixie</a>`;
    el.querySelector(".demo-replay").addEventListener("click", () => {
      reset();
      setTimeout(typePrompt, 400);
    });
    (document.querySelector(".stage") || document.body).appendChild(el);
    banner.el = el;
  }

  window.addEventListener("DOMContentLoaded", () => {
    mountBanner();
    setTimeout(typePrompt, 1300);
  });
})();
