#!/usr/bin/env node
/**
 * Verifies relay persistence: a file written through the relay survives a relay
 * RESTART. We write via daemon A, kill A + the relay, restart the relay against
 * the same data dir, then connect a FRESH daemon B (empty dir) — it should
 * receive the file from the restored CRDT doc.
 *
 *   node examples/relay-persistence-check.mjs   (build packages first)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELAY = path.join(root, "packages/sync-relay/dist/index.js");
const DAEMON = path.join(root, "packages/sync-daemon/dist/index.js");
const PORT = 4271;
const RELAY_URL = `ws://localhost:${PORT}`;
const ROOM = "persist-repo";

for (const f of [RELAY, DAEMON]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing build: ${f}. Run: npm run build`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();
function spawnNode(entry, args, env, tag) {
  const c = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ...env } });
  c.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  c.stderr.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  procs.add(c);
  c.on("close", () => procs.delete(c));
  return c;
}
async function kill(c) {
  if (!c) return;
  c.kill();
  await sleep(300);
}
async function waitFor(file, expected, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fsp.readFile(file, "utf8")) === expected) return true;
    } catch { /* not yet */ }
    await sleep(150);
  }
  return false;
}

async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-relaydata-"));
  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-pA-"));
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-pB-"));

  let relay = spawnNode(RELAY, [], { PORT: String(PORT), WT_RELAY_DATA_DIR: dataDir }, "relay1");
  await sleep(800);
  const daemonA = spawnNode(DAEMON, ["--dir", dirA, "--relay", RELAY_URL, "--room", ROOM], {}, "A");
  await sleep(1500);

  await fsp.writeFile(path.join(dirA, "persist-test.txt"), "survives restart");
  await sleep(1500); // let it reach the relay and the relay debounce-save to disk

  console.log("--- killing daemon A and the relay ---");
  await kill(daemonA);
  await kill(relay);
  await sleep(500);

  const saved = fs.existsSync(path.join(dataDir, `${ROOM}.ydoc.bin`));
  console.log(`${saved ? "PASS" : "FAIL"}  relay wrote a persisted doc file`);

  console.log("--- restarting relay against the same data dir ---");
  relay = spawnNode(RELAY, [], { PORT: String(PORT), WT_RELAY_DATA_DIR: dataDir }, "relay2");
  await sleep(800);
  spawnNode(DAEMON, ["--dir", dirB, "--relay", RELAY_URL, "--room", ROOM], {}, "B");

  const got = await waitFor(path.join(dirB, "persist-test.txt"), "survives restart");
  console.log(`${got ? "PASS" : "FAIL"}  fresh daemon B received the file from the restored doc`);

  for (const c of procs) { try { c.kill(); } catch { /* */ } }
  await Promise.all([dataDir, dirA, dirB].map((d) => fsp.rm(d, { recursive: true, force: true }).catch(() => {})));

  const ok = saved && got;
  console.log(ok ? "\nPASS — relay state persists across restart." : "\nFAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("check error:", e);
  for (const c of procs) { try { c.kill(); } catch { /* */ } }
  process.exit(1);
});
