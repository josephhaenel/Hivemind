# @workingtogether/coordination-mcp-server

The coordination layer for **WorkingTogether** — collision avoidance + shared memory for multiple people coding the same repo with AI agents (Claude Code / Codex). It implements the MVP slice of [`docs/design/coordination-mcp.md`](../../docs/design/coordination-mcp.md).

> **The point:** AI agents rewrite whole functions atomically, so two agents editing the same function silently merge into broken code. This server lets an agent **claim a region before it writes** — and refuses the claim when another agent holds it.

## What it does (MVP)

- **Claims with fence tokens.** `wt_claim` grants an exclusive lease on a region (file or `path#Symbol`) and returns a monotonic `fence`. The fence is the spine: the write path validates it so a lapsed holder can't clobber a new one (invariant I12).
- **Party-dependent policy.** Two **agents** on the same region → hard block. A **human** involved → soft-warn-and-proceed. (Humans have judgment; agents don't.)
- **Leases that self-heal.** TTL + heartbeat; a heartbeat only extends the lease if it carries an *advancing* `progress_token`, so a stalled/dead agent auto-releases.
- **Presence** (`wt_announce` / `wt_whos_editing`) — ephemeral who's-editing-what awareness.
- **Decisions bus** (`wt_post_decision` / `wt_get_decisions`) — an append-only, supersede-chained shared memory scoped to repo/file/region so teammates' agents pick up the few decisions that matter.

### Not yet (deferred, see the design doc)
Real CRDT file sync, cryptographic identity/trust-root, region anchoring via tree-sitter, distributed (multi-node) CP store, shared read-locks, queueing/handoff. The store is a single in-memory process (which *is* the linearizable CP store for a single deployment).

## Run it

```bash
npm install
npm run build
npm start            # listens on http://localhost:4100  (PORT to override)
# or: npm run dev    # watch mode
npm test             # unit tests for the claim/decisions core
```

Endpoints:
- `POST /mcp` — the MCP (Streamable HTTP) endpoint agents connect to (tools `wt_*`).
- `POST /v1/claim`, `POST /v1/release`, `GET /v1/whos_editing` — thin REST shims for hooks/daemons.
- `GET /healthz` — liveness + store stats.

It must run as **one shared process** that every machine connects to — that single process is the coordination store.

## Wire it into Claude Code

Point Claude Code at the MCP server (e.g. in `.mcp.json` / settings) at `http://localhost:4100/mcp`, and add the PreToolUse hook so edits are gated automatically:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command",
                    "command": "node /abs/path/to/packages/coordination-mcp-server/hooks/pre-tool-use.mjs" }] }
    ]
  }
}
```

Set `WT_ACTOR_ID` (unique per person/machine) and `WT_REPO` (shared repo id) in each collaborator's environment. The hook **fails open** — if the server is down, your editing is never blocked.

## Demo (two collaborators, one file)

1. Start the server.
2. Person A's agent edits `src/app.ts` → the hook claims it → allowed.
3. Person B's agent tries to edit `src/app.ts` while A holds it → the hook gets `REGION_CLAIMED` → the edit is **denied** with "held by A: <intent>, retry in ~Ns."
4. A finishes (claim released or lease expires) → B's next attempt is allowed.

## Tools

| Tool | Purpose |
|---|---|
| `wt_resolve_region` | (repo, path[, symbol]) → stable regionId |
| `wt_register` | declare an actor as agent/human |
| `wt_claim` | claim a region before editing → `{fence, claim_id, ttl}` or `REGION_CLAIMED` |
| `wt_release` | release a held claim (fence-checked) |
| `wt_heartbeat` | extend a lease (requires advancing progress) |
| `wt_whos_editing` | active claims + presence |
| `wt_announce` | publish presence |
| `wt_post_decision` | append a scoped, supersede-chained decision |
| `wt_get_decisions` | retrieve relevant chain-head decisions |
