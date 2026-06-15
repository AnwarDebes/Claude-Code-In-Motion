// Search tools: glob (find files by pattern) and grep (search file contents).
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "../safety.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".nuxt",
  ".cache", "__pycache__", ".venv", "venv", "target", ".idea", ".vscode",
  "coverage", ".pixie",
]);
const MAX_FILES = 20000;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // **/ matches any number of dirs, including none
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const opts = glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        re += "(?:" + opts.join("|") + ")";
        i = end;
      } else re += "\\{";
    } else if (".+^$()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

async function* walk(root, base = root, depth = 0) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") && depth === 0 && e.name !== ".") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full, base, depth + 1);
    } else if (e.isFile()) {
      yield path.relative(base, full).split(path.sep).join("/");
    }
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const searchTools = [
  {
    name: "glob",
    activity: "searching",
    mutating: false,
    parallelSafe: true,
    description:
      "Find files whose path matches a glob pattern (supports **, *, ?, {a,b}). Example: \"src/**/*.js\". Use this to locate files by name.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern relative to the search root, e.g. **/*.ts" },
        path: { type: "string", description: "Directory to search in (relative to working dir). Defaults to working dir." },
      },
      required: ["pattern"],
    },
    async run(input, ctx) {
      const rootRel = input.path && input.path.length ? input.path : ".";
      const r = resolveSafePath(ctx.cwd, rootRel);
      if (!r.ok) return { ok: false, output: r.error };
      let re;
      try {
        re = globToRegExp(input.pattern);
      } catch {
        return { ok: false, output: `Invalid glob pattern: ${input.pattern}` };
      }
      const results = [];
      let count = 0;
      for await (const rel of walk(r.path)) {
        if (++count > MAX_FILES) break;
        if (re.test(rel)) {
          results.push(rel);
          if (results.length >= MAX_GLOB_RESULTS) break;
        }
      }
      const prefix = rootRel === "." ? "" : rootRel.replace(/\/$/, "") + "/";
      const out = results.map((p) => prefix + p);
      return {
        ok: true,
        output: out.length ? out.join("\n") : "No files matched.",
        summary: `${input.pattern} (${out.length}${out.length >= MAX_GLOB_RESULTS ? "+" : ""} files)`,
      };
    },
  },

  {
    name: "grep",
    activity: "searching",
    mutating: false,
    parallelSafe: true,
    description:
      "Search file contents for a regular expression and return matching lines as path:line:text. Optionally restrict to files matching a glob.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Directory to search (relative to working dir). Defaults to working dir." },
        glob: { type: "string", description: "Only search files whose path matches this glob (e.g. **/*.py)." },
        ignore_case: { type: "boolean", description: "Case-insensitive search." },
      },
      required: ["pattern"],
    },
    async run(input, ctx) {
      const rootRel = input.path && input.path.length ? input.path : ".";
      const r = resolveSafePath(ctx.cwd, rootRel);
      if (!r.ok) return { ok: false, output: r.error };
      let re, fileRe = null;
      try {
        re = new RegExp(input.pattern, input.ignore_case ? "i" : "");
      } catch (e) {
        return { ok: false, output: `Invalid regular expression: ${e.message}` };
      }
      if (input.glob) {
        try { fileRe = globToRegExp(input.glob); } catch { /* ignore bad glob filter */ }
      }
      const matches = [];
      const filesWithMatches = new Set();
      let scanned = 0;
      for await (const rel of walk(r.path)) {
        if (matches.length >= MAX_GREP_MATCHES || scanned > MAX_FILES) break;
        if (fileRe && !fileRe.test(rel)) continue;
        scanned++;
        let buf;
        try { buf = await fs.readFile(path.join(r.path, rel)); } catch { continue; }
        if (looksBinary(buf)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const prefix = rootRel === "." ? "" : rootRel.replace(/\/$/, "") + "/";
            matches.push(`${prefix}${rel}:${i + 1}:${lines[i].slice(0, 300)}`);
            filesWithMatches.add(rel);
            if (matches.length >= MAX_GREP_MATCHES) break;
          }
        }
      }
      return {
        ok: true,
        output: matches.length ? matches.join("\n") : "No matches found.",
        summary: `${input.pattern} (${matches.length}${matches.length >= MAX_GREP_MATCHES ? "+" : ""} in ${filesWithMatches.size} files)`,
      };
    },
  },
];
