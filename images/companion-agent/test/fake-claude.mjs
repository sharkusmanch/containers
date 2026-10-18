#!/usr/bin/env node
// A stand-in for `claude` in the server tests. It records how it was started in
// `<cwd>/fake-<pid>.json`, then does what the question in its prompt (the last argument) says:
//   replay:<file>     print the file's stream-json lines and exit 0
//   replay-bg:<file>  the same, leaving a background grandchild running
//   sleep:<ms>        print an init line, wait, exit 0 without a result
//   hang              ignore SIGTERM, start a grandchild, never exit
//   hang-stubborn     the same, and the grandchild ignores SIGTERM too
// Grandchildren run in their own session, as claude 2.1.302 runs its Bash commands, so a
// signal to this process group does not reach them.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
const question = /Question: (.*)$/s.exec(prompt)?.[1] ?? "";
const colon = question.indexOf(":");
const mode = colon === -1 ? question : question.slice(0, colon);
const arg = colon === -1 ? "" : question.slice(colon + 1);

const record = { argv: args, env: process.env, cwd: process.cwd(), pid: process.pid };
const save = () =>
  writeFileSync(`${process.cwd()}/fake-${process.pid}.json`, JSON.stringify(record));
save();

const init = JSON.stringify({ type: "system", subtype: "init", tools: [] });

/** Starts a grandchild in its own session and records its pid. */
function grandchild(ignoreTerm) {
  const code = (ignoreTerm ? "process.on('SIGTERM',()=>{});" : "") + "setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true });
  child.unref();
  record.grandchild = child.pid;
  save();
}

if (mode === "replay" || mode === "replay-bg") {
  if (mode === "replay-bg") grandchild(false);
  process.stdout.write(readFileSync(arg, "utf8"));
} else if (mode === "sleep") {
  process.stdout.write(init + "\n");
  setTimeout(() => process.exit(0), Number(arg));
} else if (mode === "hang" || mode === "hang-stubborn") {
  process.on("SIGTERM", () => {});
  grandchild(mode === "hang-stubborn");
  process.stdout.write(init + "\n");
  setInterval(() => {}, 1000);
} else {
  process.exit(3);
}
