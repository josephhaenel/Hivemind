#!/usr/bin/env node
/**
 * Hivemind — combined MVP demo (collision avoidance + live file sync).
 *
 * Spins up the REAL components on one machine:
 *   - coordination MCP server (claims)            packages/coordination-mcp-server
 *   - sync relay (CRDT fan-out)                    packages/sync-relay
 *   - two sync daemons, one per "person's" dir     packages/sync-daemon
 * and drives the REAL Claude Code hooks (pre/post-tool-use.mjs) with piped
 * tool-call JSON, exactly as Claude Code would.
 *
 * Story it proves:
 *   1. alice claims shared.txt (her hook -> ALLOW), holds it.
 *   2. bob tries shared.txt (his hook -> DENY, REGION_CLAIMED) — collision avoided.
 *   3. bob edits a DIFFERENT file (his hook -> ALLOW) — disjoint work is fine.
 *   4. alice's edit to shared.txt SYNCS to bob's working dir — live multiplayer.
 *   5. alice's PostToolUse releases the claim; bob can now claim shared.txt.
 *
 * Prereq: build all three packages first (npm --prefix <pkg> run build).
 *   node examples/combined-demo.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COORD = path.join(root, "packages/coordination-mcp-server/dist/index.js");
const RELAY = path.join(root, "packages/sync-relay/dist/index.js");
const DAEMON = path.join(root, "packages/sync-daemon/dist/index.js");
const PRE = path.join(root, "packages/coordination-mcp-server/hooks/pre-tool-use.mjs");
const POST = path.join(root, "packages/coordination-mcp-server/hooks/post-tool-use.mjs");

const COORD_PORT = 4151;
const RELAY_PORT = 4251;
const COORD_URL = `http://localhost:${COORD_PORT}`;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const REPO = "demo-repo";

for (const f of [COORD, RELAY, DAEMON]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing build: ${f}\nBuild all packages first:\n  for p in coordination-mcp-server sync-relay sync-daemon; do npm --prefix packages/$p run build; done`);
    process.exit(2);
  }
}

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function spawnNode(entry, args, env, tag) {
  const c = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ...env } });
  c.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  c.stderr.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  children.push(c);
  return c;
}
function cleanup() {
  for (const c of children) {
    try { c.kill(); } catch { /* ignore */ }
  }
}

/** Run a hook script the way Claude Code does: env + cwd + tool-call JSON on stdin. */
function runHook(hookPath, { cwd, actor, toolName, filePath, content }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [hookPath], {
      cwd,
      env: {
        ...process.env,
        WT_SERVER_URL: COORD_URL,
        WT_ACTOR_ID: actor,
        WT_REPO: REPO,
        WT_ORIGIN: "agent",
      },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => {
      try {
        const parsed = JSON.parse(out || "{}");
        resolve(parsed?.hookSpecificOutput?.permissionDecision ?? "allow");
      } catch {
        resolve("allow");
      }
    });
    c.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath, content } }));
  });
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

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

async function main() {
  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-alice-"));
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-bob-"));
  await fsp.writeFile(path.join(dirA, "shared.txt"), "baseline");
  await fsp.writeFile(path.join(dirB, "shared.txt"), "baseline");

  spawnNode(COORD, [], { PORT: String(COORD_PORT) }, "coord");
  spawnNode(RELAY, [], { PORT: String(RELAY_PORT) }, "relay");
  await sleep(900);
  spawnNode(DAEMON, ["--dir", dirA, "--relay", RELAY_URL, "--room", REPO], {}, "daemonA");
  await sleep(1200);
  spawnNode(DAEMON, ["--dir", dirB, "--relay", RELAY_URL, "--room", REPO], {}, "daemonB");
  await sleep(1500);

  console.log("\n--- collision avoidance (real hooks) ---");
  const aliceX = await runHook(PRE, { cwd: dirA, actor: "alice", toolName: "Write", filePath: path.join(dirA, "shared.txt"), content: "alice edit" });
  check("alice PreToolUse on shared.txt -> allow", aliceX === "allow", aliceX);

  const bobX = await runHook(PRE, { cwd: dirB, actor: "bob", toolName: "Write", filePath: path.join(dirB, "shared.txt"), content: "bob edit" });
  check("bob PreToolUse on SAME file while alice holds it -> deny", bobX === "deny", bobX);

  const bobY = await runHook(PRE, { cwd: dirB, actor: "bob", toolName: "Write", filePath: path.join(dirB, "other.txt"), content: "bob edit" });
  check("bob PreToolUse on a DIFFERENT file -> allow", bobY === "allow", bobY);

  console.log("\n--- live file sync ---");
  await fsp.writeFile(path.join(dirA, "shared.txt"), "alice's actual edit");
  check("alice's edit to shared.txt syncs to bob's working dir", await waitFor(path.join(dirB, "shared.txt"), "alice's actual edit"));

  console.log("\n--- claim release frees the region ---");
  await runHook(POST, { cwd: dirA, actor: "alice", toolName: "Write", filePath: path.join(dirA, "shared.txt"), content: "" });
  const bobX2 = await runHook(PRE, { cwd: dirB, actor: "bob", toolName: "Write", filePath: path.join(dirB, "shared.txt"), content: "bob edit" });
  check("after alice releases, bob PreToolUse on shared.txt -> allow", bobX2 === "allow", bobX2);

  cleanup();
  await fsp.rm(dirA, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(dirB, { recursive: true, force: true }).catch(() => {});

  console.log(failures === 0 ? "\nALL PASS — collision avoidance + live sync working together." : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("demo error:", e);
  cleanup();
  process.exit(1);
});
