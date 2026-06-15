// Tool registry. Collects every tool and exposes provider-neutral specs.
import { fsTools } from "./fs-tools.js";
import { searchTools } from "./search-tools.js";
import { bashTools } from "./bash-tool.js";

export const TOOLS = [...fsTools, ...searchTools, ...bashTools];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name) {
  return BY_NAME.get(name);
}

// The shape providers translate into their own tool schema.
export function toolSpecs() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

// Mascot activity for a tool call (run_bash decides debug vs run from the command).
export function resolveActivity(tool, input) {
  return typeof tool.activity === "function" ? tool.activity(input) : tool.activity;
}
