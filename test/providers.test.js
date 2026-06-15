// The Anthropic and Gemini providers parse their own streaming formats and
// translate the normalized message shape correctly (tool call -> result -> text).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRaw, collect, post } from "./_util.mjs";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-prov-"));
process.env.HOME = HOME;
const WORK = path.join(HOME, "work");
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "readme.txt"), "hi\n");

let anthropic, gemini, server, url, saveConfig;

before(async () => {
  // mock Anthropic Messages API stream
  anthropic = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      const hasResult = json.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
      const ev = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;
      if (hasResult) {
        return writeRaw(res, [
          ev("message_start", { message: { usage: { input_tokens: 30 } } }),
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "All done via Claude." } }),
          ev("content_block_stop", { index: 0 }),
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
          ev("message_stop", {}),
        ]);
      }
      return writeRaw(res, [
        ev("message_start", { message: { usage: { input_tokens: 12 } } }),
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "list_dir", input: {} } }),
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\".\"}" } }),
        ev("content_block_stop", { index: 0 }),
        ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } }),
      ]);
    });
  });
  await new Promise((r) => anthropic.listen(0, "127.0.0.1", r));

  // mock Gemini streamGenerateContent (alt=sse)
  gemini = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      const hasFn = (json.contents || []).some((c) => (c.parts || []).some((p) => p.functionResponse));
      const d = (o) => `data: ${JSON.stringify(o)}\n\n`;
      if (hasFn) {
        return writeRaw(res, [
          d({ candidates: [{ content: { parts: [{ text: "All done via Gemini." }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 } }),
          d({ candidates: [{ finishReason: "STOP" }] }),
        ]);
      }
      return writeRaw(res, [
        d({ candidates: [{ content: { parts: [{ functionCall: { name: "list_dir", args: { path: "." } } }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } }),
        d({ candidates: [{ finishReason: "STOP" }] }),
      ]);
    });
  });
  await new Promise((r) => gemini.listen(0, "127.0.0.1", r));

  ({ saveConfig } = await import("../src/config.js"));
  const { startServer } = await import("../src/server.js");
  ({ server } = await startServer({ port: 0, host: "127.0.0.1", dir: WORK }));
  url = `http://127.0.0.1:${server.address().port}`;
  globalThis.__ports = { anthropic: anthropic.address().port, gemini: gemini.address().port };
});

after(() => {
  server?.close();
  anthropic?.close();
  gemini?.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

async function runProvider(provider, model, port, expect) {
  // Clear history so a prior provider's tool result does not leak into this turn.
  await post(url, "/api/reset", {});
  saveConfig({ provider, model, keys: { [provider]: "k" }, baseUrls: { [provider]: `http://127.0.0.1:${port}` }, approvalMode: "yolo" });
  const c = await collect(url);
  const start = c.events.length;
  await post(url, "/api/chat", { message: "list files" });
  await c.waitFor((e) => e.type === "run" && e.phase === "finished" && e._id > start);
  const ls = c.events.find((e) => e.type === "tool_end" && e.name === "list_dir" && e._id > start);
  assert.ok(ls && ls.ok && /readme\.txt/.test(ls.output), `${provider}: list_dir ran`);
  const reply = c.events.filter((e) => e.type === "message" && e._id > start).map((e) => e.delta).join("");
  assert.match(reply, new RegExp(expect), `${provider}: final text`);
  assert.ok(c.events.some((e) => e.type === "usage" && e._id > start && e.totalOutput > 0), `${provider}: usage tracked`);
  c.cancel();
}

test("Anthropic provider drives a tool turn end to end", async () => {
  await runProvider("anthropic", "claude-opus-4-8", globalThis.__ports.anthropic, "done via Claude");
});

test("Gemini provider drives a tool turn end to end", async () => {
  await runProvider("gemini", "gemini-2.5-pro", globalThis.__ports.gemini, "done via Gemini");
});
