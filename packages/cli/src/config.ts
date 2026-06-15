/**
 * Resolve Hivemind client config from `.hive/config.json` (in the repo) and
 * environment variables. Env always wins, so CI / one-off overrides work.
 * The legacy `.wt/` dir and `WT_*` env vars are still honored for back-compat.
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

// Write to .hive/; read from .hive/ then fall back to the legacy .wt/ dir.
export const CONFIG_PATH = path.join(process.cwd(), ".hive", "config.json");
const LEGACY_CONFIG_PATH = path.join(process.cwd(), ".wt", "config.json");

function readConfigFile(): Partial<WtConfig> {
  for (const p of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      /* try the next location */
    }
  }
  return {};
}

export function loadConfig(): WtConfig {
  const file = readConfigFile();
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
