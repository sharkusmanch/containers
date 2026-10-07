import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { serveStatic } from "../src/server/static.js";

let root: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "gc-static-"));
  root = join(base, "web");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "index.html"), "<p>hi</p>");
  await writeFile(join(root, "sub", "a.js"), "export {}");
  await writeFile(join(root, "notes.txt"), "x");
  await writeFile(join(root, "manifest.webmanifest"), "{}");
  await writeFile(join(root, "icon.png"), "png");
  await writeFile(join(base, "secret.js"), "nope");
});

describe("serveStatic", () => {
  it("serves a file with its content type", async () => {
    const f = await serveStatic(root, "index.html");
    expect(f?.contentType).toBe("text/html; charset=utf-8");
    expect(f?.body.toString()).toBe("<p>hi</p>");
  });

  it("serves nested modules as JavaScript", async () => {
    expect((await serveStatic(root, "sub/a.js"))?.contentType).toBe(
      "text/javascript; charset=utf-8",
    );
  });

  it("serves a web app manifest as application/manifest+json", async () => {
    expect((await serveStatic(root, "manifest.webmanifest"))?.contentType).toBe(
      "application/manifest+json",
    );
  });

  it("serves a PNG as image/png", async () => {
    expect((await serveStatic(root, "icon.png"))?.contentType).toBe("image/png");
  });

  it.each([
    "../secret.js",
    "sub/../../secret.js",
    "..%2fsecret.js",
    "%2e%2e/secret.js",
    "/etc/passwd",
    "/tmp/outside.js",
    "sub\\..\\..\\secret.js",
    "a\0.js",
  ])("refuses traversal: %s", async (p) => {
    expect(await serveStatic(root, p)).toBeNull();
  });

  it("refuses unknown extensions and directories", async () => {
    expect(await serveStatic(root, "notes.txt")).toBeNull();
    expect(await serveStatic(root, "sub")).toBeNull();
  });

  it("returns null for a missing file", async () => {
    expect(await serveStatic(root, "missing.js")).toBeNull();
  });
});
