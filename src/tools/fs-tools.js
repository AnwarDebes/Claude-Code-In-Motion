// Filesystem tools: read_file, write_file, edit_file, list_dir.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSafePath } from "../safety.js";

const MAX_READ_BYTES = 400 * 1024;

function clip(str, max = 60) {
  str = String(str).replace(/\s+/g, " ").trim();
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

export const fsTools = [
  {
    name: "read_file",
    activity: "reading",
    mutating: false,
    parallelSafe: true,
    description:
      "Read a UTF-8 text file from the working directory and return its contents. Call this before editing a file so you know its exact current content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
      },
      required: ["path"],
    },
    async run(input, ctx) {
      const r = resolveSafePath(ctx.cwd, input.path);
      if (!r.ok) return { ok: false, output: r.error };
      try {
        const stat = await fs.stat(r.path);
        if (stat.isDirectory())
          return { ok: false, output: `${input.path} is a directory. Use list_dir instead.` };
        const buf = await fs.readFile(r.path);
        let text = buf.toString("utf8");
        let note = "";
        if (buf.length > MAX_READ_BYTES) {
          text = buf.slice(0, MAX_READ_BYTES).toString("utf8");
          note = `\n\n[truncated: showing first ${MAX_READ_BYTES} of ${buf.length} bytes]`;
        }
        const lines = text.split("\n").length;
        if (ctx.readTimes) ctx.readTimes.set(r.path, stat.mtimeMs);
        return {
          ok: true,
          output: text + note,
          summary: `${input.path} (${lines} lines)`,
        };
      } catch (e) {
        return { ok: false, output: `Could not read ${input.path}: ${e.message}` };
      }
    },
  },

  {
    name: "write_file",
    activity: "writing",
    mutating: true,
    parallelSafe: false,
    description:
      "Create a new file or overwrite an existing one with the given content. Parent directories are created automatically. Prefer edit_file for small changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
    async run(input, ctx) {
      const r = resolveSafePath(ctx.cwd, input.path, { forWrite: true });
      if (!r.ok) return { ok: false, output: r.error };
      try {
        await fs.mkdir(path.dirname(r.path), { recursive: true });
        const content = input.content ?? "";
        await fs.writeFile(r.path, content, "utf8");
        try {
          const stat = await fs.stat(r.path);
          if (ctx.readTimes) ctx.readTimes.set(r.path, stat.mtimeMs);
        } catch { /* ignore */ }
        const lines = String(content).split("\n").length;
        return {
          ok: true,
          output: `Wrote ${input.path} (${lines} lines, ${Buffer.byteLength(content)} bytes).`,
          summary: `${input.path} (${lines} lines)`,
        };
      } catch (e) {
        return { ok: false, output: `Could not write ${input.path}: ${e.message}` };
      }
    },
  },

  {
    name: "edit_file",
    activity: "writing",
    mutating: true,
    parallelSafe: false,
    description:
      "Replace an exact string in an existing file. old_string must match the file's current content exactly (including whitespace) and be unique unless replace_all is true. Read the file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        old_string: { type: "string", description: "Exact text to find. Include enough surrounding context to be unique." },
        new_string: { type: "string", description: "Text to replace it with." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(input, ctx) {
      const r = resolveSafePath(ctx.cwd, input.path, { forWrite: true });
      if (!r.ok) return { ok: false, output: r.error };
      const { old_string, new_string, replace_all } = input;
      if (old_string === new_string)
        return { ok: false, output: "old_string and new_string are identical; nothing to change." };
      try {
        const before = await fs.readFile(r.path, "utf8");
        const count = before.split(old_string).length - 1;
        if (count === 0)
          return { ok: false, output: `old_string was not found in ${input.path}. Read the file again and copy the exact text.` };
        if (count > 1 && !replace_all)
          return { ok: false, output: `old_string appears ${count} times in ${input.path}. Add surrounding context to make it unique, or set replace_all: true.` };
        const after = replace_all
          ? before.split(old_string).join(new_string)
          : before.replace(old_string, new_string);
        await fs.writeFile(r.path, after, "utf8");
        try {
          const stat = await fs.stat(r.path);
          if (ctx.readTimes) ctx.readTimes.set(r.path, stat.mtimeMs);
        } catch { /* ignore */ }
        const n = replace_all ? count : 1;
        return {
          ok: true,
          output: `Edited ${input.path}: ${n} replacement${n === 1 ? "" : "s"}.`,
          summary: `${input.path} (${clip(old_string, 30)} → ${clip(new_string, 30)})`,
          meta: { diff: { path: r.rel, old: old_string, new: new_string } },
        };
      } catch (e) {
        if (e.code === "ENOENT")
          return { ok: false, output: `${input.path} does not exist. Use write_file to create it.` };
        return { ok: false, output: `Could not edit ${input.path}: ${e.message}` };
      }
    },
  },

  {
    name: "list_dir",
    activity: "searching",
    mutating: false,
    parallelSafe: true,
    description: "List the entries (files and folders) in a directory within the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the working directory. Defaults to the working directory." },
      },
    },
    async run(input, ctx) {
      const target = input.path && input.path.length ? input.path : ".";
      const r = resolveSafePath(ctx.cwd, target);
      if (!r.ok) return { ok: false, output: r.error };
      try {
        const entries = await fs.readdir(r.path, { withFileTypes: true });
        entries.sort((a, b) => {
          const da = a.isDirectory() ? 0 : 1;
          const db = b.isDirectory() ? 0 : 1;
          return da - db || a.name.localeCompare(b.name);
        });
        const lines = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
        return {
          ok: true,
          output: lines.length ? lines.join("\n") : "(empty directory)",
          summary: `${target} (${entries.length} entries)`,
        };
      } catch (e) {
        return { ok: false, output: `Could not list ${target}: ${e.message}` };
      }
    },
  },
];
