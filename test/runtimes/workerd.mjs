// Runs test/runtimes/smoke.mjs inside workerd, the runtime of Cloudflare Workers, through Miniflare.
//   pnpm build && node test/runtimes/workerd.mjs
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const here = new URL(".", import.meta.url);
const smoke = (await readFile(new URL("smoke.mjs", here), "utf8")).replace("../../dist/index.js", "./index.js");
const sdk = await readFile(new URL("../../dist/index.js", here), "utf8");
const worker = `
import { smoke } from "./smoke.mjs";
export default {
  async fetch() {
    try {
      return new Response("ok workerd: " + (await smoke()) + " requests");
    } catch (error) {
      return new Response(String((error && error.stack) || error), { status: 500 });
    }
  },
};
`;

const mf = new Miniflare({
  modules: [
    { type: "ESModule", path: "worker.mjs", contents: worker },
    { type: "ESModule", path: "smoke.mjs", contents: smoke },
    { type: "ESModule", path: "index.js", contents: sdk },
  ],
  compatibilityDate: "2025-09-01",
});
try {
  const response = await mf.dispatchFetch("http://localhost/");
  const body = await response.text();
  console.log(body);
  if (!response.ok) process.exitCode = 1;
} finally {
  await mf.dispose();
}
