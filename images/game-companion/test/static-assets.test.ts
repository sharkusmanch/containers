import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..", "web-static");
const SCRIPT = join(import.meta.dirname, "..", "scripts", "make-icons.mjs");
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
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

describe("manifest", () => {
  it("has the fields the page needs, with relative URLs", () => {
    const m = manifest();
    expect(m.name).toBe("Game Companion");
    expect(m.short_name).toBe("Companion");
    expect(m.start_url).toBe("./");
    expect(m.scope).toBe("./");
    expect(m.display).toBe("fullscreen");
    expect(m.background_color).toBe("#111418");
    expect(m.theme_color).toBe("#111418");
    expect(m.icons).toEqual([
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ]);
    for (const url of [m.start_url, m.scope, ...m.icons.map((i) => i.src)]) {
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

  it("are reproduced byte for byte by the generator", () => {
    const out = mkdtempSync(join(tmpdir(), "gc-icons-"));
    execFileSync(process.execPath, [SCRIPT, out]);
    for (const name of ["icon-192.png", "icon-512.png"]) {
      expect(readFileSync(join(out, name)).equals(readFileSync(join(WEB, name)))).toBe(true);
    }
    const again = mkdtempSync(join(tmpdir(), "gc-icons-"));
    execFileSync(process.execPath, [SCRIPT, again]);
    expect(
      readFileSync(join(again, "icon-512.png")).equals(readFileSync(join(out, "icon-512.png"))),
    ).toBe(true);
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

  it("has no inline script or style", () => {
    expect(html).not.toMatch(/<style|style=|<script(?![^>]*\bsrc=)/);
  });
});

describe("build", () => {
  it("copies the whole web-static directory, so the manifest and icons ship", () => {
    const script = readFileSync(
      join(import.meta.dirname, "..", "scripts", "copy-static.mjs"),
      "utf8",
    );
    expect(script).toContain('cp("web-static", "dist/web", { recursive: true })');
  });
});
