#!/usr/bin/env node
/**
 * End-to-end demo: one relay + two daemons on two separate working dirs.
 * Proves that an edit in dir A propagates to dir B (and back) through the CRDT.
 *
 *   node demo/run-demo.mjs
 *
 * Requires both packages built:
 *   npm --prefix ../sync-relay run build && npm run build
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.join(here, "..", "dist", "index.js");
const relayEntry = path.join(here, "..", "..", "sync-relay", "dist", "index.js");
const PORT = 4231;
const RELAY = `ws://localhost:${PORT}`;
const ROOM = "demo-repo";

for (const f of [daemonEntry, relayEntry]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing build: ${f}\nRun the builds first (see header).`);
    process.exit(2);
  }
}

const children = [];
function spawnNode(entry, args, env, tag) {
  const c = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ...env } });
  c.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  c.stderr.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  children.push(c);
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(file, expected, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fsp.readFile(file, "utf8")) === expected) return true;
    } catch {
      /* not there yet */
    }
    await sleep(150);
  }
  return false;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
}

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

async function main() {
  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-A-"));
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-B-"));
  // identical baseline in both working dirs
  await fsp.writeFile(path.join(dirA, "hello.txt"), "v1");
  await fsp.writeFile(path.join(dirB, "hello.txt"), "v1");

  spawnNode(relayEntry, [], { PORT: String(PORT) }, "relay");
  await sleep(800);
  spawnNode(daemonEntry, ["--dir", dirA, "--relay", RELAY, "--room", ROOM], {}, "A");
  await sleep(1200); // let A seed the room
  spawnNode(daemonEntry, ["--dir", dirB, "--relay", RELAY, "--room", ROOM], {}, "B");
  await sleep(1500); // let B sync

  // 1) edit in A -> B
  await fsp.writeFile(path.join(dirA, "hello.txt"), "v2 edited by A");
  check("A edits hello.txt -> B sees it", await waitFor(path.join(dirB, "hello.txt"), "v2 edited by A"));

  // 2) new file in A -> B
  await fsp.writeFile(path.join(dirA, "notes.md"), "# created by A\n");
  check("A creates notes.md -> B sees it", await waitFor(path.join(dirB, "notes.md"), "# created by A\n"));

  // 3) edit in B -> A (reverse direction)
  await fsp.writeFile(path.join(dirB, "hello.txt"), "v3 edited by B");
  check("B edits hello.txt -> A sees it", await waitFor(path.join(dirA, "hello.txt"), "v3 edited by B"));

  cleanup();
  await fsp.rm(dirA, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(dirB, { recursive: true, force: true }).catch(() => {});

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("demo error:", e);
  cleanup();
  process.exit(1);
});
