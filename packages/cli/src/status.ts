import { loadConfig, authHeaders } from "./config.js";

interface ClaimView {
  holder: string;
  kind: string;
  anchor: string;
  intent?: string;
  expires_in_ms?: number;
}
interface PresenceView {
  actorId: string;
  state: string;
  focus?: { pathHint?: string };
}

export async function status(): Promise<void> {
  const cfg = loadConfig();
  console.log(`server : ${cfg.serverUrl}`);
  console.log(`repo   : ${cfg.repo}`);
  console.log(`actor  : ${cfg.actor}`);
  console.log(`auth   : ${cfg.token ? "token set" : "none"}`);

  try {
    const h = await fetch(`${cfg.serverUrl}/healthz`, { signal: AbortSignal.timeout(4000) });
    console.log(`health : ${h.ok ? "ok" : "HTTP " + h.status}`);
    if (!h.ok) return;
  } catch (e) {
    console.log(`health : unreachable (${e instanceof Error ? e.message : String(e)})`);
    return;
  }

  try {
    const r = await fetch(`${cfg.serverUrl}/v1/whos_editing?repo=${encodeURIComponent(cfg.repo)}`, {
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      console.log(`\nwho    : HTTP ${r.status}${r.status === 401 ? " (bad/missing token)" : ""}`);
      return;
    }
    const data = (await r.json()) as { claims?: ClaimView[]; presence?: PresenceView[] };
    const claims = data.claims ?? [];
    console.log(`\nactive claims (${claims.length}):`);
    for (const c of claims) {
      const secs = c.expires_in_ms != null ? ` (${Math.ceil(c.expires_in_ms / 1000)}s left)` : "";
      console.log(`  ${c.holder} [${c.kind}] -> ${c.anchor}${c.intent ? `  "${c.intent}"` : ""}${secs}`);
    }
    const presence = data.presence ?? [];
    if (presence.length) {
      console.log(`presence (${presence.length}):`);
      for (const p of presence) {
        console.log(`  ${p.actorId} ${p.state}${p.focus?.pathHint ? ` @ ${p.focus.pathHint}` : ""}`);
      }
    }
  } catch (e) {
    console.log(`who    : error (${e instanceof Error ? e.message : String(e)})`);
  }
}
