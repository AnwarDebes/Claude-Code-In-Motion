// Renders the conversation: user/assistant messages, tool-call cards with
// collapsible output and diffs, and inline approval prompts.
import { renderMarkdown, escapeHtml } from "./markdown.js";

const BULLET = "⏺";

function diffHtml(diff) {
  const del = String(diff.old).split("\n").map((l) => `<span class="diff-del">- ${escapeHtml(l)}</span>`).join("\n");
  const add = String(diff.new).split("\n").map((l) => `<span class="diff-add">+ ${escapeHtml(l)}</span>`).join("\n");
  return `<pre class="diff"><code>${del}\n${add}</code></pre>`;
}

export class Transcript {
  constructor(container, { onApprove } = {}) {
    this.el = container;
    this.onApprove = onApprove || (() => {});
    this.nodes = new Map();
  }

  _stick() {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 120;
  }
  _scroll() {
    this.el.scrollTop = this.el.scrollHeight;
  }
  _append(node) {
    const stick = this._stick();
    this.el.appendChild(node);
    if (stick) this._scroll();
  }

  clear() {
    this.el.innerHTML = "";
    this.nodes.clear();
  }

  addUser(text) {
    const div = document.createElement("div");
    div.className = "msg user";
    div.innerHTML = `<span class="prompt">❯</span><div class="bubble">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
    this._append(div);
  }

  assistantDelta(key, text) {
    let node = this.nodes.get(key);
    if (!node) {
      const div = document.createElement("div");
      div.className = "msg assistant";
      div.innerHTML = `<span class="marker">${BULLET}</span><div class="md"></div>`;
      this._append(div);
      node = { el: div, body: div.querySelector(".md"), raw: "" };
      this.nodes.set(key, node);
    }
    node.raw += text;
    node.body.textContent = node.raw; // fast path while streaming
    if (this._stick()) this._scroll();
  }

  assistantDone(key) {
    const node = this.nodes.get(key);
    if (node) {
      node.body.innerHTML = renderMarkdown(node.raw);
      this.nodes.delete(key); // node is fully rendered; no longer referenced
    }
    if (this._stick()) this._scroll();
  }

  toolStart(id, { title, activity }) {
    const div = document.createElement("div");
    div.className = "tool running";
    div.innerHTML = `
      <div class="tool-head">
        <span class="bullet"></span>
        <span class="tool-title">${escapeHtml(title)}</span>
        <span class="tool-summary"><span class="spin"></span></span>
      </div>
      <div class="tool-body"></div>`;
    div.querySelector(".tool-head").addEventListener("click", () => div.classList.toggle("open"));
    this._append(div);
    this.nodes.set("tool:" + id, { el: div });
  }

  toolEnd(id, { ok, summary, output, meta }) {
    const node = this.nodes.get("tool:" + id);
    if (!node) return;
    const div = node.el;
    div.classList.remove("running");
    div.classList.add(ok ? "ok" : "err");
    div.querySelector(".tool-summary").textContent = summary || (ok ? "done" : "failed");
    const body = div.querySelector(".tool-body");
    let html = "";
    if (meta && meta.diff) html += diffHtml(meta.diff);
    if (output) html += `<pre class="tool-out"><code>${escapeHtml(output.slice(0, 6000))}</code></pre>`;
    body.innerHTML = html;
    if (!ok) div.classList.add("open");
    this.nodes.delete("tool:" + id);
    if (this._stick()) this._scroll();
  }

  approvalRequest(id, info) {
    const div = document.createElement("div");
    div.className = "approval";
    let preview = "";
    if (info.name === "run_bash") {
      preview = `<pre class="approval-cmd"><code>${escapeHtml(info.input.command || "")}</code></pre>`;
    } else if (info.name === "edit_file") {
      preview = diffHtml({ old: info.input.old_string || "", new: info.input.new_string || "" });
    } else if (info.name === "write_file") {
      const c = String(info.input.content || "");
      preview = `<div class="approval-file">${escapeHtml(info.input.path || "")}</div>` +
        `<pre class="tool-out"><code>${escapeHtml(c.slice(0, 1500))}${c.length > 1500 ? "\n…" : ""}</code></pre>`;
    }
    div.innerHTML = `
      <div class="approval-head">✋ Allow this action?</div>
      <div class="approval-title">${escapeHtml(info.title)}</div>
      ${preview}
      <div class="approval-actions">
        <button class="btn allow" data-d="allow">Allow</button>
        <button class="btn always" data-d="always">Allow, don't ask again</button>
        <button class="btn deny" data-d="deny">Deny</button>
      </div>
      <div class="approval-status"></div>`;
    div.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => this.onApprove(id, b.dataset.d));
    });
    this._append(div);
    this.nodes.set("appr:" + id, { el: div });
  }

  approvalResolved(id, decision) {
    const node = this.nodes.get("appr:" + id);
    if (!node) return;
    const div = node.el;
    div.classList.add("resolved", decision === "deny" ? "denied" : "allowed");
    div.querySelectorAll("button").forEach((b) => (b.disabled = true));
    div.querySelector(".approval-status").textContent = decision === "deny" ? "Denied" : "Allowed";
    this.nodes.delete("appr:" + id);
  }

  error(text) {
    const div = document.createElement("div");
    div.className = "msg error";
    div.innerHTML = `<span class="marker">⚠</span><div class="bubble">${escapeHtml(text)}</div>`;
    this._append(div);
  }

  notice(text) {
    const div = document.createElement("div");
    div.className = "msg notice";
    div.textContent = text;
    this._append(div);
  }
}
