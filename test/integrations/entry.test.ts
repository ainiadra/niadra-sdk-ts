import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const IMPORT = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;

/** Every module `entry` loads at run time, following relative imports; type-only imports are skipped. */
function runtimeGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      if (/^\s*(?:import|export)\s+type\s/.test(match[0])) continue;
      const target = match[1]!;
      if (target.startsWith(".")) visit(resolve(dirname(file), target.replace(/\.js$/, ".ts")));
      else packages.add(target);
    }
  };
  visit(entry);
  return { files, packages };
}

describe("entries", () => {
  it("keeps the core entry free of any package and of the integrations", () => {
    const { files, packages } = runtimeGraph(resolve(SRC, "index.ts"));
    expect([...packages]).toEqual([]);
    expect([...files].filter((file) => file.includes("/integrations/"))).toEqual([]);
  });

  it("lets each integration load only its own framework, and the webhook adapters none", () => {
    const expected: Record<string, string[]> = {
      livekit: ["@livekit/agents"],
      elevenlabs: [],
      vapi: [],
      whatsapp: [],
      twilio: [],
      "ai-sdk": ["ai"],
      mastra: ["@mastra/core/tools"],
      langchain: ["@langchain/core/callbacks/base", "@langchain/core/messages", "@langchain/core/runnables", "@langchain/core/tools"],
      "openai-agents": ["@openai/agents"],
      anthropic: [],
      "google-genai": [],
      bedrock: [],
    };
    for (const [name, packages] of Object.entries(expected)) {
      expect([...runtimeGraph(resolve(SRC, `integrations/${name}.ts`)).packages].sort(), name).toEqual(packages);
    }
  });
});
