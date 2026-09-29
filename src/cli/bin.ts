/** The `niadra` executable: runs one command and exits with its code. */
import { main } from "./index.js";

process.exitCode = await main(process.argv.slice(2));
