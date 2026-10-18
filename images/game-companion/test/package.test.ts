import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("runtime dependencies", () => {
  it("has none in package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it("has none in the lockfile's root package", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };
    expect(Object.keys(lock.packages[""]?.dependencies ?? {})).toEqual([]);
    expect(Object.keys(lock.packages)).not.toContain("node_modules/@anthropic-ai/sdk");
  });

  it("leaves no Anthropic SDK code in src", () => {
    for (const file of filesUnder("src")) {
      expect(read(file), file).not.toContain("@anthropic-ai/sdk");
    }
  });

  it("installs nothing in the runtime image, but still ships package.json", () => {
    const runtime = read("Dockerfile").split("AS runtime")[1] ?? "";
    expect(runtime).not.toContain("npm ci");
    expect(runtime).toContain("no runtime dependencies");
    // The server reads its version from package.json at startup.
    expect(runtime).toMatch(/^COPY package\.json \.\/$/m);
  });
});
