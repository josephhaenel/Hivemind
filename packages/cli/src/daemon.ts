/**
 * `wt up` / `wt down` — start/stop the sync daemon as a managed background
 * process, using the saved config (no long flag string to remember).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const PID_FILE = path.join(process.cwd(), ".wt", "daemon.pid");
const LOG_FILE = path.join(process.cwd(), ".wt", "daemon.log");

function findDaemonEntry(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@workingtogether/sync-daemon/dist/index.js");
  } catch {
    /* not installed as a dep; try the monorepo sibling */
  }
  const sibling = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "sync-daemon",
    "dist",
    "index.js"
  );
  if (fs.existsSync(sibling)) return sibling;
  throw new Error("sync-daemon not found. Install @workingtogether/sync-daemon or build the monorepo.");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function up(): void {
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    if (isRunning(pid)) {
      console.log(`daemon already running (pid ${pid})`);
      return;
    }
  }
  const cfg = loadConfig();
  const entry = findDaemonEntry();
  const args = [entry, "--dir", process.cwd(), "--room", cfg.repo, "--actor", cfg.actor, "--coord", cfg.serverUrl];
  if (cfg.relayUrl) args.push("--relay", cfg.relayUrl);
  if (cfg.token) args.push("--token", cfg.token);

  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`daemon started (pid ${child.pid}) — syncing ${cfg.repo} via ${cfg.relayUrl ?? "default relay"}`);
  console.log(`logs: .wt/daemon.log`);
}

export function down(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.log("no running daemon (no .wt/daemon.pid)");
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
  try {
    process.kill(pid);
    console.log(`daemon ${pid} stopped`);
  } catch {
    console.log(`daemon ${pid} was not running`);
  }
  fs.rmSync(PID_FILE, { force: true });
}
