#!/usr/bin/env node
// Pixie - entry point. Parses CLI flags, starts the local server, opens the browser.
import { spawn } from "node:child_process";
import process from "node:process";
import { startServer } from "../src/server.js";

const COLORS = {
  reset: "\x1b[0m",
  coral: "\x1b[38;5;209m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PIXIE_PORT) || 4317,
    host: process.env.PIXIE_HOST || "127.0.0.1",
    open: true,
    yolo: false,
    dir: process.cwd(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--no-open") opts.open = false;
    else if (a === "--yolo") opts.yolo = true;
    else if (a === "--port" || a === "-p") opts.port = Number(argv[++i]);
    else if (a === "--host") opts.host = argv[++i];
    else if (a === "--dir" || a === "-d") opts.dir = argv[++i];
    else if (a.startsWith("--port=")) opts.port = Number(a.slice(7));
    else if (a.startsWith("--dir=")) opts.dir = a.slice(6);
  }
  return opts;
}

function printHelp() {
  const c = COLORS;
  console.log(`
${c.coral}${c.bold}Pixie${c.reset} ${c.dim}- Claude Code, in motion, for any model.${c.reset}

A local coding agent with a bring-your-own-key backend (Claude, OpenAI, Gemini,
OpenRouter, Ollama, or any OpenAI-compatible endpoint) and an animated pixel
mascot that acts out what the agent is doing.

${c.bold}Usage${c.reset}
  pixie [options]

${c.bold}Options${c.reset}
  -p, --port <n>     Port to listen on            (default 4317)
      --host <addr>  Address to bind              (default 127.0.0.1)
  -d, --dir <path>   Working directory the agent  (default current directory)
                     can read/edit
      --yolo         Auto-approve every tool call except catastrophic ones
      --no-open      Do not open the browser automatically
  -h, --help         Show this help

${c.bold}Getting started${c.reset}
  1. Run ${c.coral}pixie${c.reset} inside the project folder you want to work on.
  2. Your browser opens. Click the gear, pick a provider and paste an API key.
  3. Start chatting. Watch the mascot type, search, and debug as it works.

Keys are stored only on this machine in ~/.pixie/config.json and are sent
only to the provider you choose.
`);
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore - we already printed the URL */
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  const c = COLORS;
  try {
    const { url } = await startServer(opts);
    console.log(`
${c.coral}${c.bold}  ✻ Pixie is awake.${c.reset}

  ${c.dim}Working in${c.reset}  ${opts.dir}
  ${c.dim}Open${c.reset}        ${c.coral}${url}${c.reset}
  ${c.dim}Stop${c.reset}        Ctrl+C
${opts.yolo ? `\n  ${c.coral}⚠ --yolo: tool calls auto-approve (catastrophic commands still blocked).${c.reset}\n` : ""}`);
    if (opts.open) openBrowser(url);
  } catch (err) {
    console.error(`\n  Pixie could not start: ${err.message}\n`);
    if (err.code === "EADDRINUSE") {
      console.error(`  Port ${opts.port} is in use. Try: pixie --port ${opts.port + 1}\n`);
    }
    process.exit(1);
  }
}

main();
