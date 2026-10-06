import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/web", { recursive: true });
await cp("web-static", "dist/web", { recursive: true });
