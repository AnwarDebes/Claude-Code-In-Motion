// Anthropic (Claude) provider. Uses the Messages API directly over fetch.
// Rules baked in for Claude 4.x: no temperature/top_p/top_k, no budget_tokens,
// stream always, output_config.effort on supporting models, server-side
// fallbacks for Fable 5, and refusal handling.
import { parseSSE, readError } from "./index.js";

const EFFORT_MODELS = /(opus-4-(5|6|7|8)|sonnet-4-6|fable-5|mythos-5)/;
const FALLBACK_MODELS = /(fable-5|mythos-5)/;

function toAnthropicMessages(messages) {
  return messages.map((m) => {
    const content = m.content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input || {} };
      if (b.type === "tool_result")
        return {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: b.content,
          ...(b.is_error ? { is_error: true } : {}),
        };
      return { type: "text", text: "" };
    });
    return { role: m.role, content };
  });
}

export async function streamChat(opts) {
  const { apiKey, baseUrl, model, system, messages, tools, signal, onText, onReasoning, effort } = opts;

  const body = {
    model,
    max_tokens: 32000,
    stream: true,
    system,
    messages: toAnthropicMessages(messages),
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  };
  if (EFFORT_MODELS.test(model) && effort) {
    body.output_config = { effort };
  }
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (FALLBACK_MODELS.test(model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-06-01";
    body.fallbacks = [{ model: "claude-opus-4-8" }];
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Claude API error: ${await readError(response)}`);

  const blocks = []; // index -> {type, text, name, id, json}
  let text = "";
  const usage = { input: 0, output: 0 };
  let stopReason = null;

  for await (const { data } of parseSSE(response, signal)) {
    if (!data || data === "[DONE]") continue;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    switch (ev.type) {
      case "message_start":
        usage.input = ev.message?.usage?.input_tokens || 0;
        break;
      case "content_block_start": {
        const cb = ev.content_block || {};
        blocks[ev.index] = cb.type === "tool_use"
          ? { type: "tool_use", id: cb.id, name: cb.name, json: "" }
          : { type: cb.type, text: "" };
        break;
      }
      case "content_block_delta": {
        const d = ev.delta || {};
        const blk = blocks[ev.index] || (blocks[ev.index] = { type: "text", text: "" });
        if (d.type === "text_delta") {
          blk.text += d.text;
          text += d.text;
          onText?.(d.text);
        } else if (d.type === "input_json_delta") {
          blk.json += d.partial_json || "";
        } else if (d.type === "thinking_delta") {
          onReasoning?.(d.thinking || "");
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
        break;
      case "error":
        throw new Error(`Claude API error: ${ev.error?.message || "stream error"}`);
      default:
        break;
    }
  }

  const toolCalls = [];
  for (const b of blocks) {
    if (b && b.type === "tool_use") {
      let input = {};
      try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = {}; }
      toolCalls.push({ id: b.id, name: b.name, input });
    }
  }

  if (stopReason === "refusal" && !text) {
    text = "(The model declined to respond to this request.)";
  }

  return { text, toolCalls, usage, stopReason };
}
