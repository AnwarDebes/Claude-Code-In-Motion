// The provider-agnostic agent loop. Drives the model, runs tools through the
// permission gate, and emits normalized events that the UI and mascot react to.
import { chat, toolShimParse } from "./providers/index.js";
import { toolSpecs, getTool, resolveActivity } from "./tools/index.js";
import { decide } from "./safety.js";
import { buildSystemPrompt } from "./prompt.js";

const MAX_STEPS = 60;

function titleFor(name, input) {
  switch (name) {
    case "read_file": return `Read ${input.path}`;
    case "write_file": return `Write ${input.path}`;
    case "edit_file": return `Edit ${input.path}`;
    case "list_dir": return `List ${input.path || "."}`;
    case "glob": return `Find ${input.pattern}`;
    case "grep": return `Search ${input.pattern}`;
    case "run_bash": return `Run ${String(input.command || "").slice(0, 80)}`;
    default: return name;
  }
}

export class Agent {
  constructor({ hub, cwd, getConfig }) {
    this.hub = hub;
    this.cwd = cwd;
    this.getConfig = getConfig;
    this.history = [];
    this.busy = false;
    this.controller = null;
    this.turnCount = 0;
    this.pendingApprovals = new Map();
    this.readTimes = new Map();
    this.sessionAllowAll = false;
    this.toolSeq = 0;
  }

  get isBusy() {
    return this.busy;
  }

  reset() {
    if (this.busy) this.stop();
    this.history = [];
    this.readTimes.clear();
    this.hub.emit("reset", {});
  }

  stop() {
    if (this.controller) this.controller.abort();
  }

  approve(id, decision) {
    const p = this.pendingApprovals.get(id);
    if (!p) return false;
    this.pendingApprovals.delete(id);
    if (decision === "always") this.sessionAllowAll = true;
    const allow = decision === "allow" || decision === "always" || decision === true;
    this.hub.emit("approval_resolved", { id, decision: allow ? "allow" : "deny" });
    p.resolve(allow);
    return true;
  }

  #askApproval(info, signal) {
    return new Promise((resolve) => {
      this.pendingApprovals.set(info.id, { resolve });
      this.hub.emit("approval_request", info);
      signal.addEventListener("abort", () => {
        if (this.pendingApprovals.delete(info.id)) resolve(false);
      }, { once: true });
    });
  }

  async run(userText) {
    if (this.busy) {
      this.hub.emit("notice", { message: "Pixie is still working on the previous message." });
      return;
    }
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const turnId = ++this.turnCount;
    const config = this.getConfig();
    const system = buildSystemPrompt(this.cwd, { approvalMode: config.approvalMode });

    this.history.push({ role: "user", content: [{ type: "text", text: userText }] });
    this.hub.emit("user", { text: userText, turnId });
    this.hub.emit("run", { phase: "started", turnId, provider: config.provider, model: config.model });

    let totalIn = 0, totalOut = 0;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) break;
        this.hub.emit("step_start", { turnId, step });

        let assistantText = "";
        const onText = (chunk) => {
          assistantText += chunk;
          this.hub.emit("message", { role: "assistant", delta: chunk, turnId });
        };
        const onReasoning = (chunk) => this.hub.emit("reasoning", { delta: chunk, turnId });

        let result;
        try {
          result = await chat(config, {
            system,
            messages: this.history,
            tools: toolSpecs(),
            signal,
            onText,
            onReasoning,
          });
        } catch (e) {
          if (signal.aborted) break;
          throw e;
        }

        totalIn += result.usage?.input || 0;
        totalOut += result.usage?.output || 0;
        this.hub.emit("usage", {
          input: result.usage?.input || 0,
          output: result.usage?.output || 0,
          totalInput: totalIn,
          totalOutput: totalOut,
          turnId,
        });

        if (result.text) this.hub.emit("message_end", { role: "assistant", turnId });

        // Native tool calls, or shim fallback for models without function calling.
        let toolCalls = result.toolCalls || [];
        if (!toolCalls.length) {
          const shim = toolShimParse(result.text);
          if (shim) toolCalls = shim;
        }
        // Reassign every tool-call id to a session-unique value. Providers vary
        // (Gemini has none, the shim/OpenAI fallback reset per call) and a
        // collision across steps would corrupt tool_use/tool_result matching.
        for (const tc of toolCalls) tc.id = `tc_${++this.toolSeq}`;

        const content = [];
        if (result.text) content.push({ type: "text", text: result.text });
        for (const tc of toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        this.history.push({ role: "assistant", content });

        if (!toolCalls.length) break; // turn complete

        const resultBlocks = [];
        for (const tc of toolCalls) {
          if (signal.aborted) break;
          const tool = getTool(tc.name);
          const activity = tool ? resolveActivity(tool, tc.input) : "thinking";
          const title = titleFor(tc.name, tc.input);
          this.hub.emit("tool_start", { id: tc.id, name: tc.name, activity, title, input: tc.input, turnId });

          if (!tool) {
            const msg = `Unknown tool: ${tc.name}.`;
            this.hub.emit("tool_end", { id: tc.id, name: tc.name, ok: false, output: msg, summary: msg, turnId });
            resultBlocks.push({ type: "tool_result", tool_use_id: tc.id, name: tc.name, content: msg, is_error: true });
            continue;
          }

          const d = decide({
            toolName: tc.name,
            input: tc.input,
            mutating: tool.mutating && !this.sessionAllowAll,
            approvalMode: config.approvalMode,
          });

          if (d.decision === "deny") {
            const msg = d.reason;
            this.hub.emit("tool_end", { id: tc.id, name: tc.name, ok: false, output: msg, summary: "refused", activity, turnId });
            resultBlocks.push({ type: "tool_result", tool_use_id: tc.id, name: tc.name, content: msg, is_error: true });
            continue;
          }

          if (d.decision === "ask") {
            const approved = await this.#askApproval(
              { id: tc.id, name: tc.name, title, input: tc.input, reason: d.reason, activity, turnId },
              signal,
            );
            if (signal.aborted) break;
            if (!approved) {
              const msg = "The user denied this action. Do not retry it; consider another approach or ask what to do.";
              this.hub.emit("tool_end", { id: tc.id, name: tc.name, ok: false, output: msg, summary: "denied", activity, turnId });
              resultBlocks.push({ type: "tool_result", tool_use_id: tc.id, name: tc.name, content: msg, is_error: true });
              continue;
            }
          }

          let res;
          try {
            res = await tool.run(tc.input, {
              cwd: this.cwd,
              signal,
              readTimes: this.readTimes,
              emit: this.hub.emit.bind(this.hub),
            });
          } catch (e) {
            res = { ok: false, output: `Tool crashed: ${e.message}` };
          }
          this.hub.emit("tool_end", {
            id: tc.id, name: tc.name, ok: res.ok, output: res.output,
            summary: res.summary || "", meta: res.meta, activity, turnId,
          });
          resultBlocks.push({ type: "tool_result", tool_use_id: tc.id, name: tc.name, content: res.output, is_error: !res.ok });
        }

        // Invariant: every tool_use must get exactly one tool_result, or the
        // next request is malformed. Fill any calls skipped by a cancel/abort.
        for (const tc of toolCalls) {
          if (!resultBlocks.some((b) => b.tool_use_id === tc.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: tc.id, name: tc.name, content: "Cancelled before running.", is_error: true });
          }
        }
        this.history.push({ role: "user", content: resultBlocks });
        if (signal.aborted) break;
      }

      if (signal.aborted) this.hub.emit("run", { phase: "cancelled", turnId });
      else this.hub.emit("run", { phase: "finished", turnId, totalInput: totalIn, totalOutput: totalOut });
    } catch (e) {
      this.hub.emit("error", { message: e.message, turnId });
      this.hub.emit("run", { phase: "error", turnId, error: e.message });
    } finally {
      this.busy = false;
      this.controller = null;
      for (const [, p] of this.pendingApprovals) p.resolve(false);
      this.pendingApprovals.clear();
    }
  }
}
