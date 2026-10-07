import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** Reads `relPath` under `root`. Returns null for anything outside root, unknown, or missing. */
export async function serveStatic(root: string, relPath: string): Promise<StaticFile | null> {
  // Reject before decoding tricks can matter: no encoded bytes, backslashes or NULs at all.
  if (relPath.includes("%") || relPath.includes("\\") || relPath.includes("\0")) return null;
  const contentType = TYPES[extname(relPath)];
  if (!contentType) return null;
  const base = resolve(root);
  const target = resolve(base, relPath);
  if (!target.startsWith(base + sep)) return null;
  try {
    return { body: await readFile(target), contentType };
  } catch {
    return null;
  }
}
