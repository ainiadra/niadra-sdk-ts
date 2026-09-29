import { defineConfig } from "tsup";

/** One entry per integration, so `@niadra/sdk` itself never loads a framework. */
const integrations = [
  "livekit",
  "elevenlabs",
  "vapi",
  "whatsapp",
  "twilio",
  "ai-sdk",
  "mastra",
  "langchain",
  "openai-agents",
  "anthropic",
  "google-genai",
  "bedrock",
  "llamaindex",
  "retell",
  "genkit",
  "cloudflare-agents",
  "voltagent",
  "google-adk",
  "strands",
];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      ...Object.fromEntries(integrations.map((name) => [name, `src/integrations/${name}.ts`])),
    },
    format: ["esm", "cjs"],
    // Every entry stands alone: the core entry stays one file that any runtime loads as it is, and an
    // integration carries the few core helpers it needs instead of a shared chunk.
    splitting: false,
    dts: true,
    sourcemap: true,
    // Everything but the command, which the second build writes at the same time.
    clean: ["**/*", "!cli.js", "!cli.js.map"],
    target: "es2022",
    platform: "neutral",
    treeshake: true,
  },
  // The `niadra` command runs on Node only: its own entry, with Node's built-ins, never in the core bundle.
  {
    entry: { cli: "src/cli/bin.ts" },
    format: ["esm"],
    splitting: false,
    sourcemap: true,
    clean: false,
    target: "node20",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
