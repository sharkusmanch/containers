// ESM loader hook: widen paseo's application socket lease.
//
// WHY: the daemon reaps any WebSocket that has not delivered an inbound DATA
// frame within APPLICATION_SOCKET_LEASE_MS (45_000), checked every 10s, via
// closePhysicalSocket() -> ws.terminate(). terminate() sends no close frame, so
// the client sees code 1006. Measured over the persisted daemon logs: 282 total
// 1006 disconnects, of which 129 (46%) were immediately preceded by a
// "Closing physical WebSocket with expired application lease" entry for the
// SAME connectionId. Every lease expiry produced a 1006.
//
// The client pings about every 25s (6452 pings across 5371 connected 30s metric
// windows), so the cushion is only ~1.8x. iOS Safari throttles JS timers
// whenever the page is not foreground-active, and a throttled 25s ping easily
// slips past 45s -- so the daemon kills a perfectly healthy connection and the
// UI sits in "reconnecting". This is server-side and network-independent, which
// is why forcing DERP and enabling permessage-deflate both changed nothing.
//
// Only `claim` is overridden. `renew` delegates to `claim`, and `listExpired` /
// `release` are untouched, so genuinely dead sockets are still reaped -- just
// after PASEO_SOCKET_LEASE_MS instead of 45s. Default 300_000 = 12x the ping
// interval.
//
// A loader hook is required because physical-socket.js is a real ESM module:
// the CJS `require`-and-mutate trick used for `ws` cannot reach it.

const TARGET = "/@getpaseo/server/dist/server/server/websocket/physical-socket.js";

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  if (!url.endsWith(TARGET) || result.format !== "module" || !result.source) {
    return result;
  }

  const leaseMs = Number(process.env.PASEO_SOCKET_LEASE_MS) || 300000;

  // Appended in module scope, so ApplicationSocketLease is in lexical scope.
  const patch = `
;(() => {
  try {
    ApplicationSocketLease.prototype.claim = function (socket) {
      this.deadlines.set(socket, this.clock() + ${leaseMs});
    };
    if (process.env.PASEO_LEASE_PATCH_DEBUG) {
      console.error("[lease-patch] ApplicationSocketLease TTL -> ${leaseMs}ms");
    }
  } catch (err) {
    // Never break daemon startup over a best-effort timeout widening.
  }
})();
`;

  return { ...result, source: result.source.toString() + patch };
}
