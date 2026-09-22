// Enable WebSocket permessage-deflate in the Paseo daemon.
//
// WHY: paseo's daemon constructs its WebSocketServer with no `perMessageDeflate`
// (see @getpaseo/server/dist/server/server/websocket-server.js, `new
// WebSocketServer({ server, path: "/ws", ... })`), and the `ws` library defaults
// compression OFF. Its outbound `session_message` frames are therefore
// uncompressed JSON. Measured effect: a sustained 143-167 KB (peak 413 KB) send
// buffer backlog, which a cellular link cannot drain -> socket stalls -> code
// 1006 -> reconnect -> same payload replays -> permanent "reconnecting".
//
// Rather than patch the vendored bundle (root-owned in the image, and re-applied
// on every Renovate bump), this preload wraps whatever `ws` the daemon loads. It
// is version-tolerant: it patches by behaviour, not by pinning a copy of an
// 86 KB minified file that would silently go stale.
//
// NOTE: hooking Module._load does NOT work here -- the daemon reaches `ws` via
// an ESM `import`, which bypasses the CJS loader hook entirely on Node 24
// (verified empirically: the hook never fired). Instead we eagerly require `ws`
// and mutate its exports object. Node's ESM->CJS interop reuses the same CJS
// module cache entry and reads named exports off `module.exports` when the
// synthetic module is evaluated, so the daemon's `import` sees this mutation.
//
// Loaded via NODE_OPTIONS=--require=/opt/paseo-patches/deflate.cjs, set in the
// image's Dockerfile. Disable by overriding NODE_OPTIONS to empty in the pod spec
// and restarting the pod. Nothing else changes.

// Tuned per the ws docs' guidance on memory use. Context takeover is left
// ENABLED (the default): it costs a zlib context per connection but gives a far
// better ratio on repetitive JSON, and this daemon serves single-digit sockets.
// `threshold` avoids spending CPU on frames too small to benefit.
const DEFLATE_OPTIONS = {
  zlibDeflateOptions: { level: 6, memLevel: 8 },
  zlibInflateOptions: { chunkSize: 16 * 1024 },
  concurrencyLimit: 10,
  threshold: 1024,
};

// Resolve `ws` from the daemon's own install tree, not from this file's
// location (/opt/paseo-patches has no node_modules of its own).
const WS_SEARCH_PATHS = [
  "/usr/local/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/node_modules",
  "/usr/local/lib/node_modules/@getpaseo/cli/node_modules",
  "/usr/local/lib/node_modules/@getpaseo/cli",
];

function log(msg) {
  if (process.env.PASEO_DEFLATE_PATCH_DEBUG) console.error("[deflate-patch]", msg);
}

// Register the ESM loader hook that widens the application socket lease. This
// must happen from a --require preload, before the daemon's ESM graph loads.
// physical-socket.js is a real ESM module, so the require-and-mutate trick used
// below for `ws` (a CJS package) cannot reach it -- see lease-hook.mjs.
try {
  const { register } = require("node:module");
  const { pathToFileURL } = require("node:url");
  register("./lease-hook.mjs", pathToFileURL(__filename));
  log("registered lease-hook.mjs");
} catch (err) {
  log(`failed to register lease hook: ${err && err.message}`);
}

try {
  const wsEntry = require.resolve("ws", { paths: WS_SEARCH_PATHS });
  const ws = require(wsEntry);

  const OriginalServer = ws.WebSocketServer || ws.Server;
  if (typeof OriginalServer !== "function") {
    throw new Error("ws.WebSocketServer is not a constructor");
  }

  if (!OriginalServer.prototype.__paseoDeflatePatched) {
    // Do NOT swap the export: the daemon uses `import { WebSocketServer } from
    // "ws"`, and Node snapshots CJS named exports when the module is first
    // evaluated -- a later reassignment is only visible via the default export
    // (verified empirically). So patch the class IN PLACE via its prototype;
    // every import style then shares the same patched object.
    //
    // ws 8.x applies `this.options.perMessageDeflate` inside completeUpgrade
    // (lib/websocket-server.js ~L299), i.e. per upgrade rather than at
    // construction -- so setting it here, before delegating, is honoured.
    const originalHandleUpgrade = OriginalServer.prototype.handleUpgrade;
    if (typeof originalHandleUpgrade !== "function") {
      throw new Error("ws.WebSocketServer.prototype.handleUpgrade missing");
    }

    OriginalServer.prototype.handleUpgrade = function (req, socket, head, cb) {
      // ws defaults this to `false` (lib/websocket-server.js L76). Only fill it
      // in when the app left it off, so an explicit app setting always wins.
      if (this.options && !this.options.perMessageDeflate) {
        this.options.perMessageDeflate = DEFLATE_OPTIONS;
      }
      return originalHandleUpgrade.call(this, req, socket, head, cb);
    };

    Object.defineProperty(OriginalServer.prototype, "__paseoDeflatePatched", {
      value: true,
      enumerable: false,
    });
    log(`patched ws.WebSocketServer.prototype.handleUpgrade from ${wsEntry}`);
  }
} catch (err) {
  // Never take the daemon down over a best-effort optimisation. Stay SILENT by
  // default: NODE_OPTIONS is inherited by every node process in the container,
  // including spawned Claude Code agents that have no `ws` on their resolution
  // path -- logging here would pollute their stderr on every invocation.
  log(`failed to patch ws: ${err && err.message}`);
}
