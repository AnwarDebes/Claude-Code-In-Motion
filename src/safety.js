// Safety / permission layer. The harness (not the model) decides whether a tool
// call runs, asks the user, or is refused. Order is deny -> ask -> allow.
//
// Design note: the read-only "fast path" (auto-approving harmless commands) is a
// convenience only. It is deliberately conservative: anything that could hide a
// mutating action (redirection, command substitution, backgrounding, a flag that
// writes) drops out of the fast path and requires explicit approval.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Absolute roots whose recursive deletion / permission change is catastrophic.
const CRITICAL_PATHS = ["/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
  "/var", "/boot", "/opt", "/sys", "/proc", "/root", "/home", "~", "$HOME", "${HOME}"];

// Non-path catastrophes. Blocked outright, even in --yolo mode.
const CATASTROPHIC_RE = [
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|disk|mmcblk|vd)/,
  /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/,
  />\s*\/dev\/(sd|nvme|hd|vd)[a-z]/,
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/, // pipe-remote-to-shell
];

const READONLY_BINS = new Set([
  "ls", "cat", "echo", "pwd", "head", "tail", "wc", "which", "type", "file",
  "stat", "du", "df", "date", "whoami", "id", "uname", "hostname", "tree",
  "tr", "cut", "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd",
  "diff", "printenv", "basename", "dirname", "realpath", "readlink",
  "true", "false", "test", "seq", "tac", "nl", "column", "jq",
]);
// Note: sort (-o writes), find (-delete/-exec), yes, tee, yq (-i) are deliberately
// NOT here because they can mutate via flags without a redirection operator.

const READONLY_SUBCOMMANDS = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files",
    "rev-parse", "describe", "blame", "shortlog", "tag"]),
  npm: new Set(["ls", "list", "view", "outdated", "ping", "why"]),
  pip: new Set(["list", "show", "freeze", "check"]),
  cargo: new Set(["tree", "metadata"]),
  go: new Set(["version", "list"]),
  docker: new Set(["ps", "images", "version", "info", "logs"]),
};

const WRAPPERS = new Set(["timeout", "nice", "nohup", "time", "stdbuf", "env", "command"]);

const TOP_SEP = /\n|&&|\|\||;|\|&|\||&/; // includes single & (background)
const SAFE_SEP = /\n|&&|\|\||;|\|&|\|/; // for splitting an already-metachar-free command

// Pull out subcommands AND the bodies of command/process substitution so a
// destructive command cannot hide inside `$(...)`, backticks, or <(...)/>(...).
function extractCommands(command, depth = 0) {
  const parts = [];
  if (depth > 4) return parts;
  const subRe = /\$\(([^()]*)\)|`([^`]*)`|[<>]\(([^()]*)\)/g;
  let m;
  while ((m = subRe.exec(command))) {
    const inner = m[1] || m[2] || m[3];
    if (inner) parts.push(...extractCommands(inner, depth + 1));
  }
  for (const p of command.split(TOP_SEP).map((s) => s.trim()).filter(Boolean)) parts.push(p);
  return parts;
}

function leadingTokens(sub) {
  let tokens = sub.split(/\s+/).filter(Boolean);
  while (tokens.length) {
    if (WRAPPERS.has(tokens[0])) {
      tokens = tokens.slice(1);
      while (tokens.length && /^(\d+m?s?|[A-Z_][A-Z0-9_]*=.*|-\w+)$/.test(tokens[0])) tokens = tokens.slice(1);
    } else break;
  }
  return tokens;
}

function targetsCritical(tok) {
  const t = tok.replace(/^["']|["']$/g, "");
  if (t === "/*" || t === "/") return true;
  for (const p of CRITICAL_PATHS) {
    if (p === "/") continue;
    if (t === p || t.startsWith(p + "/")) return true;
  }
  return false;
}

// Recursive delete / permission change of a critical path = catastrophic.
function dangerousFileOp(sub) {
  const tokens = leadingTokens(sub);
  if (!tokens.length) return false;
  const bin = path.basename(tokens[0].replace(/^["']|["']$/g, ""));
  const rest = tokens.slice(1);
  const flags = rest.filter((t) => t.startsWith("-"));
  const args = rest.filter((t) => !t.startsWith("-"));
  const hasRecursive = flags.some((f) => /^--recursive$/.test(f) || (/^-[a-zA-Z]+$/.test(f) && /r/i.test(f)));
  if (bin === "rm") {
    if (flags.some((f) => /no-preserve-root/.test(f))) return true;
    if (hasRecursive && args.some(targetsCritical)) return true;
    if (args.some((a) => a.replace(/^["']|["']$/g, "") === "/")) return true;
  }
  if ((bin === "chmod" || bin === "chown" || bin === "chgrp") && hasRecursive && args.some(targetsCritical)) return true;
  return false;
}

export function isCatastrophic(command) {
  if (CATASTROPHIC_RE.some((re) => re.test(command))) return true;
  return extractCommands(command).some(dangerousFileOp);
}

export function splitCommands(command) {
  return command.split(SAFE_SEP).map((s) => s.trim()).filter(Boolean);
}

// Anything that could hide a mutating action disqualifies the read-only fast path.
function hasUnsafeMeta(command) {
  if (/[<>]/.test(command)) return true; // redirections
  if (/\$\(|`|<\(|>\(/.test(command)) return true; // substitution
  if (/(^|[^&])&(?!&)/.test(command)) return true; // single & background
  return false;
}

function isReadonlySub(sub) {
  const tokens = leadingTokens(sub);
  if (!tokens.length) return true;
  const bin = path.basename(tokens[0].replace(/^["']|["']$/g, ""));
  if (READONLY_BINS.has(bin)) return true;
  if (READONLY_SUBCOMMANDS[bin]) {
    const subcmd = tokens[1];
    return subcmd ? READONLY_SUBCOMMANDS[bin].has(subcmd) : false;
  }
  return false;
}

export function classifyBash(command) {
  const catastrophic = isCatastrophic(command);
  let readonlyOnly = false;
  if (!hasUnsafeMeta(command)) {
    const subs = splitCommands(command);
    readonlyOnly = subs.length > 0 && subs.every(isReadonlySub);
  }
  return { catastrophic, readonlyOnly, subcommands: splitCommands(command) };
}

// Path sandbox: resolve against cwd, refuse to escape it (lexically AND through
// symlinks), and block reads of obvious secret files.
const SENSITIVE = [/(^|\/)\.env(\.|$)/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/, /id_rsa/, /id_ed25519/, /(^|\/)\.netrc$/,
  /(^|\/)\.pixie(\/|$)/, /credentials(\.json)?$/];

export function resolveSafePath(cwd, p, { forWrite = false } = {}) {
  if (typeof p !== "string" || !p.length) return { ok: false, error: "A file path is required." };
  let expanded = p;
  if (expanded === "~" || expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(1));
  const abs = path.resolve(cwd, expanded);
  const rel = path.relative(cwd, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return { ok: false, error: `Path is outside the working directory (${cwd}). Pixie can only touch files inside it.` };
  }
  if (!forWrite && SENSITIVE.some((re) => re.test(rel))) {
    return { ok: false, error: "Reading credential/secret files is blocked for safety." };
  }
  // Symlink-aware containment: resolve the real path (the existing target for
  // reads, the existing parent for writes to a new file) and re-check.
  let realCwd;
  try { realCwd = fs.realpathSync(cwd); } catch { realCwd = abs ? path.resolve(cwd) : cwd; }
  const checkTarget = forWrite ? path.dirname(abs) : abs;
  let real;
  try { real = fs.realpathSync(checkTarget); } catch { real = null; }
  if (real) {
    const relReal = path.relative(realCwd, real);
    if (relReal === ".." || relReal.startsWith(".." + path.sep) || path.isAbsolute(relReal)) {
      return { ok: false, error: "Path resolves (via a symlink) outside the working directory." };
    }
  }
  return { ok: true, path: abs, rel };
}

// The central decision. Returns "allow" | "ask" | "deny" with a reason.
export function decide({ toolName, input, mutating, approvalMode }) {
  if (toolName === "run_bash") {
    const { catastrophic, readonlyOnly } = classifyBash(String(input.command || ""));
    // Catastrophic is checked first, so it holds even when mutating is false
    // (session "allow always") or in --yolo mode.
    if (catastrophic) {
      return { decision: "deny", reason: "This looks like a destructive command (deleting a system or home path, formatting a disk, or piping the internet into a shell). Pixie refuses to run it." };
    }
    if (!mutating) return { decision: "allow" };
    if (readonlyOnly) return { decision: "allow" };
    if (approvalMode === "yolo") return { decision: "allow" };
    return { decision: "ask" };
  }

  if (!mutating) return { decision: "allow" };
  if (approvalMode === "yolo") return { decision: "allow" };
  return { decision: "ask" };
}
