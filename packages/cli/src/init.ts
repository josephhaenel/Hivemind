/**
 * `wt init` — one-command onboarding. Saves .wt/config.json, wires the pre/post
 * hooks into .claude/settings.json (calling this CLI, so no script paths to
 * manage), and makes sure the token-bearing config never gets committed.
 *
 * Flags (all optional; prompts fill the rest when run interactively):
 *   --server <url> --token <t> --repo <id> --actor <id> --relay <wss-url>
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, CONFIG_PATH, type WtConfig } from "./config.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function ask(rl: readline.Interface | null, question: string, def: string): Promise<string> {
  if (!rl) return def;
  const a = (await rl.question(`${question}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def;
}

function deriveRelay(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}/sync`;
  } catch {
    return serverUrl.replace(/^http/, "ws") + "/sync";
  }
}

/** Absolute path to this CLI's entry, so settings.json works regardless of PATH. */
function cliEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

function wireHooks(): void {
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    /* new file */
  }
  const entry = cliEntry();
  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};
  for (const [event, sub] of [["PreToolUse", "pre"], ["PostToolUse", "post"]] as const) {
    const list = (hooks[event] as Array<{ hooks?: Array<{ command?: string }> }>) ?? [];
    const already = list.some((g) => g.hooks?.some((h) => h.command?.includes("wt") && h.command?.includes(`hook ${sub}`)));
    if (!already) {
      list.push({
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: `node "${entry}" hook ${sub}` }],
      } as never);
    }
    hooks[event] = list as never;
  }
  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/** Keep the token-bearing config out of git. */
function protectConfig(): void {
  const gi = path.join(process.cwd(), ".gitignore");
  let body = "";
  try {
    body = fs.readFileSync(gi, "utf8");
  } catch {
    /* none */
  }
  if (!body.split(/\r?\n/).some((l) => l.trim() === ".wt/")) {
    fs.writeFileSync(gi, (body && !body.endsWith("\n") ? body + "\n" : body) + ".wt/\n");
  }
}

export async function init(): Promise<void> {
  const existing = loadConfig();
  const interactive = process.stdin.isTTY && !flag("server");
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  const serverUrl = flag("server") ?? (await ask(rl, "Coordination server URL", existing.serverUrl));
  const token = flag("token") ?? (await ask(rl, "Shared token (blank for none)", existing.token ?? ""));
  const repo = flag("repo") ?? (await ask(rl, "Repo id (same for everyone on this repo)", existing.repo));
  const actor = flag("actor") ?? (await ask(rl, "Your actor id (unique per person)", existing.actor));
  const relayUrl = flag("relay") ?? deriveRelay(serverUrl);
  rl?.close();

  const cfg: WtConfig = { serverUrl, relayUrl, token: token || undefined, repo, actor };
  saveConfig(cfg);
  protectConfig();
  wireHooks();

  console.log(`\n✓ wrote ${path.relative(process.cwd(), CONFIG_PATH)} (gitignored)`);
  console.log(`✓ wired PreToolUse/PostToolUse hooks into .claude/settings.json`);
  console.log(`\n  server : ${serverUrl}`);
  console.log(`  relay  : ${relayUrl}`);
  console.log(`  repo   : ${repo}`);
  console.log(`  actor  : ${actor}`);
  console.log(`\nNext:  wt up      # start syncing this folder`);
  console.log(`       wt status  # see who's editing`);
}
