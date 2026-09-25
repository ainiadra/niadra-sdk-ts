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
];

export default defineConfig({
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
  clean: true,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
});
