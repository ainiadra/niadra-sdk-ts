// Runs test/runtimes/smoke.mjs inside the Edge Runtime that Vercel publishes: a V8 context with
// web APIs only. The context evaluates scripts, so the CommonJS build goes in with a module shim.
//   pnpm build && node test/runtimes/edge.mjs
import { readFile } from "node:fs/promises";
import { EdgeVM } from "@edge-runtime/vm";

const here = new URL(".", import.meta.url);
const sdk = await readFile(new URL("../../dist/index.cjs", here), "utf8");
const smoke = (await readFile(new URL("smoke.mjs", here), "utf8"))
  .replace(/^import \{([^}]*)\} from "\.\.\/\.\.\/dist\/index\.js";$/m, "const {$1} = globalThis.__niadra;")
  .replace("export async function smoke()", "globalThis.__smoke = async function smoke()");
const standalone = smoke.indexOf("const standalone");

const vm = new EdgeVM();
if (typeof vm.evaluate("globalThis.process") !== "undefined") throw new Error("the edge context exposes process");
vm.evaluate(`(() => { const module = { exports: {} }; const exports = module.exports; ${sdk}\nglobalThis.__niadra = module.exports; })()`);
vm.evaluate(smoke.slice(0, standalone));
const count = await vm.evaluate("globalThis.__smoke()");
console.log(`ok edge-runtime: ${count} requests`);
