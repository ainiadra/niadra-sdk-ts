import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The SDK from its source, so the nodes are tested against the code in this repository.
const sdk = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@niadra\/sdk$/, replacement: sdk("index.ts") },
      { find: /^@niadra\/sdk\/(.*)$/, replacement: sdk("integrations/$1.ts") },
    ],
  },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
