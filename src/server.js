// Zero-dependency HTTP + SSE server. Serves the web UI and the small JSON API,
// and streams agent events to the browser.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "./events.js";
import { Agent } from "./agent.js";
import { loadConfig, saveConfig, publicConfig } from "./config.js";
import { PROVIDERS } from "./providers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");
const VERSION = "0.1.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function readJsonBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.resolve(WEB_DIR, "." + path.posix.normalize("/" + rel));
  // Prevent path traversal outside web dir (guard against sibling-prefix matches).
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

export async function startServer(opts = {}) {
  const port = Number.isInteger(opts.port) ? opts.port : 4317; // allow 0 (ephemeral)
  const host = opts.host || "127.0.0.1";
  const cwd = path.resolve(opts.dir || process.cwd());

  const hub = new EventHub();

  // Live config getter; if --yolo was passed, force approvalMode at read time.
  const getConfig = () => {
    const cfg = loadConfig();
    if (opts.yolo) cfg.approvalMode = "yolo";
    return cfg;
  };

  const agent = new Agent({ hub, cwd, getConfig });

  const server = http.createServer(async (req, res) => {
    const { method } = req;
    const url = req.url || "/";

    try {
      // ---- SSE stream ----
      if (url === "/api/events" && method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        hub.addClient(res, req.headers["last-event-id"]);
        const ping = setInterval(() => {
          try { res.write(": ping\n\n"); } catch { clearInterval(ping); }
        }, 25000);
        req.on("close", () => clearInterval(ping));
        return;
      }

      // ---- API ----
      if (url.startsWith("/api/")) {
        if (url === "/api/state" && method === "GET") {
          const cfg = getConfig();
          return sendJson(res, 200, {
            version: VERSION,
            cwd,
            busy: agent.isBusy,
            yolo: Boolean(opts.yolo),
            config: publicConfig(cfg),
            providers: Object.fromEntries(
              Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, needsKey: v.needsKey, defaultModel: v.defaultModel }]),
            ),
          });
        }

        if (url === "/api/config" && method === "GET") {
          return sendJson(res, 200, { config: publicConfig(getConfig()) });
        }

        if (url === "/api/config" && method === "POST") {
          const body = await readJsonBody(req);
          const saved = saveConfig(body);
          return sendJson(res, 200, { ok: true, config: publicConfig(saved) });
        }

        if (url === "/api/chat" && method === "POST") {
          const body = await readJsonBody(req);
          const message = String(body.message || "").trim();
          if (!message) return sendJson(res, 400, { ok: false, error: "Empty message." });
          if (agent.isBusy) return sendJson(res, 409, { ok: false, error: "Pixie is still working on the previous message." });
          // Fire and forget; results stream over SSE.
          agent.run(message);
          return sendJson(res, 202, { ok: true });
        }

        if (url === "/api/approve" && method === "POST") {
          const body = await readJsonBody(req);
          const ok = agent.approve(body.id, body.decision);
          return sendJson(res, 200, { ok });
        }

        if (url === "/api/stop" && method === "POST") {
          agent.stop();
          return sendJson(res, 200, { ok: true });
        }

        if (url === "/api/reset" && method === "POST") {
          agent.reset();
          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 404, { ok: false, error: "Unknown endpoint" });
      }

      // ---- Static files ----
      if (method === "GET") return serveStatic(req, res, url);

      res.writeHead(405); res.end("Method not allowed");
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return { url: `http://${host}:${port}`, server, hub, agent };
}
