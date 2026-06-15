// Loads and saves Pixie's local config (~/.pixie/config.json).
// API keys live here on the user's machine only, with 0600 permissions, and are
// sent only to the provider the user selected. Env vars are used as a fallback.
import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";

const CONFIG_DIR = join(homedir(), ".pixie");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const ENV_KEYS = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  ollama: [],
  custom: ["PIXIE_API_KEY"],
};

const DEFAULTS = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  keys: {},
  baseUrls: {
    ollama: "http://localhost:11434",
    custom: "",
  },
  approvalMode: "default", // "default" = approve writes/bash, "yolo" = auto-approve
  effort: "high", // for Anthropic: low | medium | high | xhigh | max
  theme: "dark",
  mascot: true,
};

function ensureDir() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore */
  }
}

export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      keys: { ...DEFAULTS.keys, ...(parsed.keys || {}) },
      baseUrls: { ...DEFAULTS.baseUrls, ...(parsed.baseUrls || {}) },
    };
  } catch {
    return { ...DEFAULTS, keys: {}, baseUrls: { ...DEFAULTS.baseUrls } };
  }
}

export function saveConfig(partial) {
  ensureDir();
  const current = loadConfig();
  const next = {
    ...current,
    ...partial,
    keys: { ...current.keys, ...(partial.keys || {}) },
    baseUrls: { ...current.baseUrls, ...(partial.baseUrls || {}) },
  };
  // Drop empty key strings so we fall back to env vars cleanly.
  for (const k of Object.keys(next.keys)) {
    if (!next.keys[k]) delete next.keys[k];
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return next;
}

// Resolve the key for a provider: explicit config first, then env vars.
export function getApiKey(config, provider) {
  if (config.keys && config.keys[provider]) return config.keys[provider];
  for (const envName of ENV_KEYS[provider] || []) {
    if (process.env[envName]) return process.env[envName];
  }
  return "";
}

// A view of the config safe to send to the browser: keys become booleans.
export function publicConfig(config) {
  const hasKey = {};
  for (const p of Object.keys(ENV_KEYS)) {
    hasKey[p] = Boolean(getApiKey(config, p));
  }
  const { keys, ...rest } = config;
  return {
    ...rest,
    hasKey,
    envKeys: ENV_KEYS,
    configPath: CONFIG_PATH,
  };
}

export { CONFIG_PATH, ENV_KEYS };
