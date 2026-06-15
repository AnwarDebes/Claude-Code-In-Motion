// Google Gemini provider. Uses generateContent streaming (alt=sse).
// Gemini has no tool-call IDs, so we synthesize them from name+index, and
// matches tool results to calls by function name.
import { parseSSE, readError } from "./index.js";

function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text) parts.push({ text: b.text });
      else if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      else if (b.type === "tool_result")
        parts.push({
          functionResponse: {
            name: b.name || "tool",
            response: { result: String(b.content), ...(b.is_error ? { error: true } : {}) },
          },
        });
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

export async function streamChat(opts) {
  const { apiKey, baseUrl, model, system, messages, tools, signal, onText, onReasoning } = opts;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages),
    tools: [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }],
  };

  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Gemini API error: ${await readError(response)}`);

  let text = "";
  const toolCalls = [];
  const usage = { input: 0, output: 0 };
  let stopReason = null;
  let idx = 0;

  for await (const { data } of parseSSE(response, signal)) {
    if (!data || data === "[DONE]") continue;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.usageMetadata) {
      usage.input = ev.usageMetadata.promptTokenCount || usage.input;
      usage.output = ev.usageMetadata.candidatesTokenCount || usage.output;
    }
    const cand = ev.candidates?.[0];
    if (!cand) continue;
    if (cand.finishReason) stopReason = cand.finishReason;
    for (const part of cand.content?.parts || []) {
      if (part.text && part.thought) {
        onReasoning?.(part.text);
      } else if (part.text) {
        text += part.text;
        onText?.(part.text);
      } else if (part.functionCall) {
        toolCalls.push({
          id: `${part.functionCall.name}-${idx++}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      }
    }
  }

  return { text, toolCalls, usage, stopReason };
}
