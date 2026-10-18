import { readdirSync, readFileSync } from "node:fs";

/**
 * Signals every process whose environment has `HOME=<home>`, and returns how many it signalled.
 * Each run's HOME is unique, and every process claude starts inherits it, including the Bash
 * commands claude 2.1.302 runs in their own session, out of reach of a process-group kill.
 * Only processes of this user can be read; on a system without /proc this finds nothing.
 */
export function signalByHome(home: string, signal: NodeJS.Signals, procDir = "/proc"): number {
  const needle = `HOME=${home}`;
  let pids: string[];
  try {
    pids = readdirSync(procDir).filter((name) => /^\d+$/.test(name));
  } catch {
    return 0;
  }
  let signalled = 0;
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`${procDir}/${pid}/environ`, "latin1");
    } catch {
      continue; // gone, or another user's
    }
    if (!environ.split("\0").includes(needle)) continue;
    try {
      process.kill(Number(pid), signal);
      signalled += 1;
    } catch {
      // Exited in the meantime.
    }
  }
  return signalled;
}
