// Provider dispatch + shared streaming helpers.
// Every provider implements the same streamChat() contract and returns a
// normalized { text, toolCalls, usage, stopReason }.
import { getApiKey } from "../config.js";
import { streamChat as anthropic } from "./anthropic.js";
import { streamChat as openaiCompatible } from "./openai.js";
import { streamChat as gemini } from "./gemini.js";

export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", needsKey: true, fn: anthropic, defaultModel: "claude-opus-4-8" },
  openai: { label: "OpenAI", needsKey: true, fn: openaiCompatible, defaultModel: "gpt-4.1" },
  gemini: { label: "Google Gemini", needsKey: true, fn: gemini, defaultModel: "gemini-2.5-pro" },
  openrouter: { label: "OpenRouter", needsKey: true, fn: openaiCompatible, defaultModel: "anthropic/claude-opus-4-8" },
  ollama: { label: "Ollama (local)", needsKey: false, fn: openaiCompatible, defaultModel: "llama3.1" },
  custom: { label: "Custom (OpenAI-compatible)", needsKey: true, fn: openaiCompatible, defaultModel: "" },
};

function resolveBaseUrl(config, provider) {
  // An explicit override (proxy/gateway/self-host) wins for any provider.
  const override = config.baseUrls && config.baseUrls[provider];
  if (override && provider !== "ollama") return override.replace(/\/$/, "");
  switch (provider) {
    case "anthropic": return "https://api.anthropic.com";
    case "openai": return "https://api.openai.com/v1";
    case "gemini": return "https://generativelanguage.googleapis.com";
    case "openrouter": return "https://openrouter.ai/api/v1";
    case "ollama": return (config.baseUrls.ollama || "http://localhost:11434").replace(/\/$/, "") + "/v1";
    case "custom": return (config.baseUrls.custom || "").replace(/\/$/, "");
    default: return "";
  }
}

// Single entry point used by the agent loop.
export async function chat(config, opts) {
  const provider = config.provider;
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`Unknown provider: ${provider}`);
  const apiKey = getApiKey(config, provider);
  if (def.needsKey && !apiKey) {
    throw new Error(`No API key for ${def.label}. Open settings (the gear) and paste your key.`);
  }
  const baseUrl = resolveBaseUrl(config, provider);
  if (provider === "custom" && !baseUrl) {
    throw new Error("Custom provider needs a Base URL. Set it in settings.");
  }
  return def.fn({
    provider,
    apiKey,
    baseUrl,
    model: config.model,
    effort: config.effort,
    ...opts,
  });
}

// ---- Shared streaming utilities ----

// Parse a fetch SSE response into {event, data} objects.
export async function* parseSSE(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let dataLines = [];
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (dataLines.length) {
            yield { event, data: dataLines.join("\n") };
          }
          event = "message";
          dataLines = [];
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
      }
    }
    // Flush a final line that arrived without a terminating blank line.
    if (buffer) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
    if (dataLines.length) yield { event, data: dataLines.join("\n") };
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

export async function readError(response) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || json.message || json.error || text;
    } catch {
      detail = text;
    }
  } catch { /* ignore */ }
  return `${response.status} ${response.statusText}${detail ? ` - ${String(detail).slice(0, 400)}` : ""}`;
}

// Fallback for models without native tool calling: pull a fenced tool block out
// of the assistant text. Format taught in the system prompt.
export function toolShimParse(text) {
  if (!text) return null;
  const re = /```(?:tool_use|tool_call|json)?\s*(\{[\s\S]*?\})\s*```/g;
  const calls = [];
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1]);
      const name = obj.tool || obj.name;
      const input = obj.input || obj.arguments || obj.args || {};
      if (name && typeof name === "string") {
        calls.push({ id: `shim_${i++}`, name, input });
      }
    } catch { /* not a tool block */ }
  }
  return calls.length ? calls : null;
}
