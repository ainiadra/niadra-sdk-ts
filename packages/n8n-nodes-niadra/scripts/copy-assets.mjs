// n8n reads a node's icon and codex file next to its compiled JavaScript.
import { copyFile } from "node:fs/promises";

for (const file of ["nodes/Niadra/niadra.svg", "nodes/Niadra/Niadra.node.json", "credentials/niadra.svg"]) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url));
}
