/**
 * Claude Code Edit/Write hooks, exposed as `wt hook pre` / `wt hook post` so
 * `.claude/settings.json` only needs `wt hook pre` (no script paths to manage).
 * Reads config from .wt/config.json or env. Fails OPEN — if the coordination
 * server is unreachable, editing is never blocked.
 */
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig, authHeaders } from "./config.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function decide(permission: "allow" | "deny" | "ask", reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: permission,
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function relPath(filePath: string): string {
  const rel = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
  return rel.split(path.sep).join("/");
}

export async function hookPre(): Promise<void> {
  const cfg = loadConfig();
  let input: { tool_name?: string; tool_input?: { file_path?: string } } = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    decide("allow", "wt: could not parse hook input; failing open");
  }
  const filePath = input?.tool_input?.file_path;
  if (!filePath) decide("allow", "wt: no file_path; nothing to claim");
  const posixRel = relPath(filePath!);

  try {
    const resp = await fetch(`${cfg.serverUrl}/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(cfg) },
      body: JSON.stringify({
        repo: cfg.repo,
        actorId: cfg.actor,
        path: posixRel,
        origin: "agent",
        intent: `${input.tool_name} ${posixRel}`,
        request_id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(1500),
    });
    const out = (await resp.json()) as {
      result?: string;
      claim?: { fence: number };
      conflicts?: Array<{ holder: string }>;
      error?: { holder?: string; holder_kind?: string; intent?: string; retry_after_ms?: number };
    };
    if (out.result === "GRANTED") decide("allow", `wt: claimed ${posixRel} (fence ${out.claim?.fence})`);
    if (out.result === "WARN_PROCEED")
      decide("ask", `wt: ${out.conflicts?.[0]?.holder ?? "someone"} is also working on ${posixRel}. Proceed?`);
    if (out.result === "BLOCKED") {
      const e = out.error ?? {};
      decide(
        "deny",
        `wt: ${posixRel} is held by ${e.holder} (${e.holder_kind}): "${e.intent}". Retry in ~${Math.ceil(
          (e.retry_after_ms ?? 0) / 1000
        )}s or work elsewhere.`
      );
    }
    decide("allow", "wt: unexpected response; failing open");
  } catch (e) {
    decide("allow", `wt: coordination server unreachable (${e instanceof Error ? e.message : String(e)}); failing open`);
  }
}

export async function hookPost(): Promise<void> {
  const cfg = loadConfig();
  let input: { tool_input?: { file_path?: string } } = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    process.exit(0);
  }
  const filePath = input?.tool_input?.file_path;
  if (!filePath) process.exit(0);
  const posixRel = relPath(filePath);
  try {
    await fetch(`${cfg.serverUrl}/v1/release_by_region`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(cfg) },
      body: JSON.stringify({ repo: cfg.repo, actorId: cfg.actor, path: posixRel }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* best effort; lease TTL reclaims it */
  }
  process.exit(0);
}
