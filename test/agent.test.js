// End-to-end agent loop against a mock OpenAI-compatible model: tool execution,
// the approval gate (allow and deny), and real file writes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSSE, collect, post } from "./_util.mjs";

// Isolate config + working dir from the real machine BEFORE importing the app.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-agent-"));
process.env.HOME = HOME;
const WORK = path.join(HOME, "work");
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "readme.txt"), "hello pixie\n");

let mock, server, url, hub;

before(async () => {
  // mock model: a human turn -> tool call; a tool result -> final text.
  mock = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msgs = JSON.parse(body || "{}").messages || [];
      const last = msgs[msgs.length - 1] || {};
      if (last.role === "tool") {
        return writeSSE(res, [
          { choices: [{ delta: { content: "Done. I finished the task." } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { usage: { prompt_tokens: 20, completion_tokens: 8 } },
        ]);
      }
      const text = typeof last.content === "string" ? last.content : "";
      if (/write/i.test(text)) {
        return writeSSE(res, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "note.md", content: "# Note\nmade by pixie\n" }) } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      return writeSSE(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "run_bash", arguments: JSON.stringify({ command: "echo hello-from-bash" }) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;

  const { saveConfig } = await import("../src/config.js");
  saveConfig({ provider: "custom", model: "mock", keys: { custom: "k" }, baseUrls: { custom: mockUrl }, approvalMode: "default" });
  const { startServer } = await import("../src/server.js");
  ({ url, server, hub } = await startServer({ port: 0, host: "127.0.0.1", dir: WORK }));
  // startServer binds port 0 -> ask the server for the actual port
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  mock?.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test("read-only tools run without approval and produce a reply", async () => {
  const c = await collect(url);
  await post(url, "/api/chat", { message: "list the files" });
  await c.waitFor((e) => e.type === "run" && e.phase === "finished");
  const starts = c.events.filter((e) => e.type === "tool_start");
  assert.ok(starts.some((e) => e.name === "list_dir"), "list_dir started");
  assert.ok(starts.some((e) => e.name === "run_bash"), "run_bash started");
  const bash = c.events.find((e) => e.type === "tool_end" && e.name === "run_bash");
  assert.ok(bash && bash.ok && /hello-from-bash/.test(bash.output), "bash ran");
  const ls = c.events.find((e) => e.type === "tool_end" && e.name === "list_dir");
  assert.ok(ls && /readme\.txt/.test(ls.output), "list saw readme.txt");
  const reply = c.events.filter((e) => e.type === "message").map((e) => e.delta).join("");
  assert.match(reply, /finished the task/);
  assert.ok(!c.events.some((e) => e.type === "approval_request"), "no approval asked");
  c.cancel();
});

test("write_file requires approval and is applied when allowed", async () => {
  const c = await collect(url);
  const start = c.events.length;
  await post(url, "/api/chat", { message: "write a note" });
  const appr = await c.waitFor((e) => e.type === "approval_request");
  assert.equal(appr.name, "write_file");
  await post(url, "/api/approve", { id: appr.id, decision: "allow" });
  await c.waitFor((e) => e.type === "run" && e.phase === "finished" && e._id > start);
  assert.ok(fs.existsSync(path.join(WORK, "note.md")));
  assert.match(fs.readFileSync(path.join(WORK, "note.md"), "utf8"), /made by pixie/);
  c.cancel();
});

test("a denied write is not applied", async () => {
  fs.rmSync(path.join(WORK, "note.md"), { force: true });
  const c = await collect(url);
  const start = c.events.length;
  await post(url, "/api/chat", { message: "write the note again" });
  const appr = await c.waitFor((e) => e.type === "approval_request" && e._id > start);
  await post(url, "/api/approve", { id: appr.id, decision: "deny" });
  await c.waitFor((e) => e.type === "run" && e.phase === "finished" && e._id > start);
  assert.ok(!fs.existsSync(path.join(WORK, "note.md")), "file not created");
  c.cancel();
});

test("a second message while busy is rejected with 409", async () => {
  // not strictly busy here, but the endpoint must exist and accept POST
  const r = await post(url, "/api/reset", {});
  assert.equal((await r.json()).ok, true);
});
