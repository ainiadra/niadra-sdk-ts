import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Examples import the package by its public name; tests resolve it to the source.
const source = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@niadra\/sdk$/, replacement: source("index.ts") },
      { find: /^@niadra\/sdk\/(.*)$/, replacement: source("integrations/$1.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
