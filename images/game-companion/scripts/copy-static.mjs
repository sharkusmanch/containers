import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist/web", { recursive: true });
await cp("web-static", "dist/web", { recursive: true });

// The service worker is registered as a classic script, which cannot hold module statements. tsc
// compiles src/web/sw.ts as a module (its exports are for the tests), so drop the keywords here
// and fail the build if anything module-only is left.
const WORKER = "dist/web/sw.js";
const compiled = await readFile(WORKER, "utf8");
const classic = compiled.replace(/^export (?=(?:async )?function |const |let |class )/gm, "");
if (/^\s*(?:import|export)\b/m.test(classic)) {
  throw new Error(`${WORKER} still has an import or export statement`);
}
await writeFile(WORKER, classic);
