// The run_bash tool: execute a shell command in the working directory.
// Gating/blocking happens in safety.js before this ever runs.
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT = 120000;
const MAX_TIMEOUT = 600000;
const MAX_OUTPUT = 30000;

const DEBUG_RE = /\b(test|tests|jest|vitest|mocha|pytest|unittest|rspec|go test|cargo test|lint|eslint|tsc|typecheck|type-check|mypy|ruff|flake8|debug|gdb|lldb|pdb)\b/i;

// Keep the model-provider keys (and other secrets) out of executed commands so a
// command cannot print them. The shell still gets PATH, HOME, and the rest.
const SECRET_RE = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i;
function safeEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_RE.test(k)) out[k] = v;
  }
  return out;
}

function truncate(s) {
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  return s.slice(0, half) + `\n\n[... ${s.length - MAX_OUTPUT} chars trimmed ...]\n\n` + s.slice(-half);
}

export const bashTools = [
  {
    name: "run_bash",
    // Acting out: tests/lint/debug commands play the "debugging" animation.
    activity: (input) => (DEBUG_RE.test(String(input.command || "")) ? "debugging" : "running"),
    mutating: true,
    parallelSafe: false,
    description:
      "Run a shell command in the working directory and return its combined stdout/stderr and exit code. Use for builds, tests, installs, git, and running scripts. Read-only commands run without asking; commands that change things ask for approval first.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        timeout_ms: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).` },
      },
      required: ["command"],
    },
    run(input, ctx) {
      return new Promise((resolve) => {
        const command = String(input.command || "");
        if (!command.trim()) return resolve({ ok: false, output: "No command provided." });
        const timeout = Math.min(Number(input.timeout_ms) || DEFAULT_TIMEOUT, MAX_TIMEOUT);
        let out = "";
        let killed = false;
        let child;
        try {
          child = spawn(command, { shell: true, cwd: ctx.cwd, env: safeEnv() });
        } catch (e) {
          return resolve({ ok: false, output: `Failed to start command: ${e.message}` });
        }
        const onData = (d) => {
          out += d.toString();
          if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        const timer = setTimeout(() => {
          killed = true;
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
        }, timeout);

        // Allow the agent to cancel a running command.
        const abort = () => {
          killed = true;
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        };
        ctx.signal?.addEventListener?.("abort", abort, { once: true });

        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ ok: false, output: `${out}\nError: ${e.message}` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener?.("abort", abort);
          const text = truncate(out).trimEnd();
          const footer = killed
            ? `\n[command ${ctx.signal?.aborted ? "cancelled" : `timed out after ${timeout}ms`}]`
            : `\n[exit code ${code}]`;
          resolve({
            ok: !killed && code === 0,
            output: (text || "(no output)") + footer,
            summary: `${command.slice(0, 50)}${command.length > 50 ? "…" : ""} → ${killed ? "stopped" : "exit " + code}`,
            meta: { exitCode: code, killed },
          });
        });
      });
    },
  },
];
