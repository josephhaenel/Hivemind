/**
 * Resolve WorkingTogether client config from `.wt/config.json` (in the repo) and
 * environment variables. Env always wins, so CI / one-off overrides work.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WtConfig {
  serverUrl: string; // coordination server, e.g. https://host
  relayUrl?: string; // sync relay, e.g. wss://host/sync
  token?: string;
  repo: string;
  actor: string;
}

export const CONFIG_PATH = path.join(process.cwd(), ".wt", "config.json");

export function loadConfig(): WtConfig {
  let file: Partial<WtConfig> = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* no config file yet */
  }
  const serverUrl = process.env.WT_SERVER_URL || file.serverUrl || "http://localhost:4100";
  return {
    serverUrl,
    relayUrl: process.env.WT_RELAY || file.relayUrl,
    token: process.env.WT_TOKEN || file.token,
    repo: process.env.WT_REPO || file.repo || path.basename(process.cwd()),
    actor: process.env.WT_ACTOR_ID || file.actor || os.hostname(),
  };
}

export function saveConfig(cfg: WtConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function authHeaders(cfg: WtConfig): Record<string, string> {
  return cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
}
