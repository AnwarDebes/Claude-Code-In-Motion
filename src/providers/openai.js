// OpenAI-compatible provider: OpenAI, OpenRouter, Ollama, and any custom
// /v1/chat/completions endpoint. Translates the normalized message format to
// OpenAI's roles (assistant tool_calls + role:"tool" results).
import { parseSSE, readError } from "./index.js";

function toOpenAIMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolUses = m.content.filter((b) => b.type === "tool_use");
      const msg = { role: "assistant", content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      }
      out.push(msg);
    } else {
      // user role: emit tool results as role:"tool", and any text as user.
      const results = m.content.filter((b) => b.type === "tool_result");
      for (const r of results) {
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: String(r.content) });
      }
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

export async function streamChat(opts) {
  const { provider, apiKey, baseUrl, model, system, messages, tools, signal, onText, onReasoning } = opts;

  const headers = { "content-type": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/AnwarDebes/Claude-Code-In-Motion";
    headers["X-Title"] = "Pixie";
  }

  const body = {
    model,
    stream: true,
    messages: toOpenAIMessages(system, messages),
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
    stream_options: { include_usage: true },
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`${provider} API error: ${await readError(response)}`);

  let text = "";
  const toolAcc = new Map(); // index -> {id, name, args}
  const usage = { input: 0, output: 0 };
  let stopReason = null;

  for await (const { data } of parseSSE(response, signal)) {
    if (!data || data === "[DONE]") continue;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.usage) {
      usage.input = ev.usage.prompt_tokens || usage.input;
      usage.output = ev.usage.completion_tokens || usage.output;
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.reasoning_content || delta.reasoning) {
      onReasoning?.(delta.reasoning_content || delta.reasoning);
    }
    if (delta.content) {
      text += delta.content;
      onText?.(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolAcc.get(idx) || { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolAcc.set(idx, cur);
      }
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  }

  const toolCalls = [];
  let i = 0;
  for (const [, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    let input = {};
    if (tc.args) {
      try { input = JSON.parse(tc.args); } catch { input = {}; }
    }
    toolCalls.push({ id: tc.id || `call_${i++}`, name: tc.name, input });
  }

  return { text, toolCalls, usage, stopReason };
}
