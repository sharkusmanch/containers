import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { inflateSync } from "node:zlib";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..", "web-static");
const SCRIPT = join(import.meta.dirname, "..", "scripts", "make-icons.mjs");
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
}
const manifest = (): Manifest =>
  JSON.parse(readFileSync(join(WEB, "manifest.webmanifest"), "utf8")) as Manifest;

/** Reads a PNG written without interlacing, with filter type 0 on every row. */
function decode(file: Buffer): {
  width: number;
  height: number;
  rgb: (x: number, y: number) => number[];
} {
  expect(file.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9], body[12]]).toEqual([8, 2, 0]);
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const row = 1 + width * 3;
  expect(raw.length).toBe(row * height);
  for (let y = 0; y < height; y++) if (raw[y * row] !== 0) throw new Error(`row ${y} is filtered`);
  return {
    width,
    height,
    rgb: (x, y) => [...raw.subarray(y * row + 1 + x * 3, y * row + 4 + x * 3)],
  };
}

/** The header and the inflated pixel bytes of a PNG, so a different compressor cannot matter. */
function readPng(file: Buffer): { header: Buffer; pixels: Buffer } {
  expect(file.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  let header = Buffer.alloc(0);
  const data: Buffer[] = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = Buffer.from(body);
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  return { header, pixels: inflateSync(Buffer.concat(data)) };
}

describe("manifest", () => {
  it("has the fields the page needs, with relative URLs", () => {
    const m = manifest();
    expect(m.name).toBe("Game Companion");
    expect(m.short_name).toBe("Companion");
    expect(m.start_url).toBe("./");
    expect(m.scope).toBe("./");
    expect(m.id).toBe("./");
    expect(m.display).toBe("standalone");
    expect(m.display_override).toEqual(["fullscreen", "standalone"]);
    expect(m.orientation).toBe("any");
    expect(m.background_color).toBe("#111418");
    expect(m.theme_color).toBe("#111418");
    expect(m.icons).toEqual([
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
    for (const url of [m.id, m.start_url, m.scope, ...m.icons.map((i) => i.src)]) {
      expect(url.startsWith("/")).toBe(false);
      expect(url).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
  });
});

describe("icons", () => {
  it.each([192, 512])("icon-%i.png is a PNG of that size with an opaque background", (size) => {
    const png = decode(readFileSync(join(WEB, `icon-${size}.png`)));
    expect([png.width, png.height]).toEqual([size, size]);
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ] as const) {
      expect(png.rgb(x, y)).toEqual([0x11, 0x14, 0x18]);
    }
  });

  it.each([192, 512])("icon-%i.png draws its glyph inside the central 60%", (size) => {
    const png = decode(readFileSync(join(WEB, `icon-${size}.png`)));
    const lo = Math.floor(size * 0.2);
    const hi = Math.ceil(size * 0.8);
    let drawn = 0;
    let outside = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (png.rgb(x, y).join() === "17,20,24") continue;
        drawn += 1;
        if (!(x >= lo && x < hi && y >= lo && y < hi)) outside += 1;
      }
    }
    expect(outside).toBe(0);
    expect(drawn).toBeGreaterThan(size);
  });

  it("are reproduced, pixel for pixel, by the generator", () => {
    const out = mkdtempSync(join(tmpdir(), "gc-icons-"));
    execFileSync(process.execPath, [SCRIPT, out]);
    for (const [name, size] of [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
    ] as const) {
      const made = readPng(readFileSync(join(out, name)));
      const committed = readPng(readFileSync(join(WEB, name)));
      expect(made.header.equals(committed.header)).toBe(true);
      expect(made.header.readUInt32BE(0)).toBe(size);
      expect(made.pixels.equals(committed.pixels)).toBe(true);
    }
  });

  it("are the same on every run of the generator", () => {
    const first = mkdtempSync(join(tmpdir(), "gc-icons-"));
    const second = mkdtempSync(join(tmpdir(), "gc-icons-"));
    execFileSync(process.execPath, [SCRIPT, first]);
    execFileSync(process.execPath, [SCRIPT, second]);
    const a = readPng(readFileSync(join(first, "icon-512.png")));
    const b = readPng(readFileSync(join(second, "icon-512.png")));
    expect(a.pixels.equals(b.pixels)).toBe(true);
  });

  it("the generator exports nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "gc-icons-"));
    const saved = process.argv[2];
    process.argv[2] = out;
    try {
      const loaded = (await import(`${SCRIPT}?exports`)) as Record<string, unknown>;
      expect(Object.keys(loaded)).toEqual([]);
    } finally {
      if (saved === undefined) process.argv.length = 2;
      else process.argv[2] = saved;
    }
  });
});

describe("index.html", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");

  it("links the manifest and the icons and declares the page installable", () => {
    expect(html).toContain('<link rel="manifest" href="manifest.webmanifest" />');
    expect(html).toContain('<link rel="icon" href="icon-192.png" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="icon-192.png" />');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
  });

  it("declares the page an iOS home-screen app with a translucent status bar and a short title", () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    );
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Companion" />');
  });

  it("has no inline script or style", () => {
    expect(html).not.toMatch(/<style|style=|<script(?![^>]*\bsrc=)/);
  });
});

describe("build", () => {
  const COPY = join(import.meta.dirname, "..", "scripts", "copy-static.mjs");
  /** A scratch project holding the static files and the compiled service worker given. */
  const project = (worker: string | null): string => {
    const work = mkdtempSync(join(tmpdir(), "gc-build-"));
    cpSync(WEB, join(work, "web-static"), { recursive: true });
    if (worker !== null) {
      mkdirSync(join(work, "dist", "web"), { recursive: true });
      writeFileSync(join(work, "dist", "web", "sw.js"), worker);
    }
    return work;
  };
  const build = (work: string): void => {
    execFileSync(process.execPath, [COPY], { cwd: work, stdio: "pipe" });
  };
  /** The real service worker source, compiled the way tsc compiles it for the build. */
  const compiledWorker = (): string =>
    ts.transpileModule(
      readFileSync(join(import.meta.dirname, "..", "src", "web", "sw.ts"), "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ES2022,
          verbatimModuleSyntax: true,
        },
        fileName: "sw.ts",
      },
    ).outputText;

  it("copies the manifest, the icons and the page into dist/web", () => {
    const work = project("export function f() {}\n");
    build(work);
    for (const name of ["manifest.webmanifest", "icon-192.png", "icon-512.png", "index.html"]) {
      expect(existsSync(join(work, "dist", "web", name))).toBe(true);
    }
  });

  it("turns the compiled service worker into a classic script that installs itself", () => {
    const work = project(compiledWorker());
    expect(readFileSync(join(work, "dist", "web", "sw.js"), "utf8")).toMatch(/^export /m);
    build(work);
    const script = readFileSync(join(work, "dist", "web", "sw.js"), "utf8");
    expect(script).not.toMatch(/^\s*(?:import|export)\b/m);
    const types: string[] = [];
    const scope = {
      ServiceWorkerGlobalScope: function ServiceWorkerGlobalScope() {},
      location: { origin: "https://wiki.example.test" },
      addEventListener: (type: string) => types.push(type),
      URL,
    };
    runInNewContext(script, scope);
    expect(types.sort()).toEqual(["activate", "fetch", "install"]);
  });

  it("installs nothing when loaded outside a service worker", () => {
    const work = project(compiledWorker());
    build(work);
    const types: string[] = [];
    runInNewContext(readFileSync(join(work, "dist", "web", "sw.js"), "utf8"), {
      addEventListener: (type: string) => types.push(type),
    });
    expect(types).toEqual([]);
  });

  it("fails the build when the service worker is missing or still has a module statement", () => {
    expect(() => build(project(null))).toThrow();
    expect(() => build(project('import { x } from "./x.js";\nx();\n'))).toThrow();
    expect(() => build(project("const a = 1;\nexport { a };\n"))).toThrow();
  });
});
