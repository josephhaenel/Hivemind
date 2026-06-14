# WorkingTogether — the coordination MCP layer (claims, presence, decisions)

**Status:** Hardened spec (v1). This is the layer agents actually call: the collision-avoidance + shared-memory surface that sits on top of the sync substrate in [`sync-loop.md`](./sync-loop.md). Read that first — this document depends on its model (epochs, nodeId/regionId, the strongly-consistent coordination store, the §4.3 landing-lease CAS, the local WAL, and the `[D-n]` defenses).

**How this was produced.** A multi-agent workflow (4 prior-art researchers → 7 dimension designers → 5 adversarial skeptics, 52 scenarios / 40 critical-high) produced and stress-tested this design; v1 folds the valid fixes in. Inline `(#n)` tags trace a mechanism to the adversarial scenario it defeats.

> **Why this layer is the product.** Agents rewrite whole functions atomically, so a char-CRDT silently merges two concurrent rewrites into convergent-but-broken code. The CRDT is transport + convergence only; **the value is the claim fired *before* the write.** Crucially, a claim is only worth anything if it is **fence-validated at the write path** — an advisory lease that always succeeds (the Agent-Mail model) is correct for human-mediated coordination and *fatal* for agent-vs-agent, where a lapsed lease that still permits a write produces exactly the broken-merge it was meant to prevent.

---

## 1. Overview & placement

- **One lock service, not two.** Claims reuse the *same* strongly-consistent conditional-write (CAS) primitive that mints the landing lease in `sync-loop.md` §4.3 Phase-0. One CP lock table holds the landing lease (key `repo+branch+laneId`) and per-region claims (key `repo+branch+regionId`), and fences are drawn from **one global monotonic counter family**, never a per-region counter (#26 — per-region counters let two partitions reissue numerically-equal fences).
- **Three consistency tiers**, each bound to one store:
  - **CP / linearizable** — claims and decisions. Granted by a single CAS; read-before-write. Cannot be acquired while partitioned (no split-brain).
  - **AP / ephemeral** — presence/awareness. A heartbeat-expired state map, **not** in the overlay CRDT (#keeps it out of the I6 byte budget and avoids zombie tombstones).
  - **AP / local-first** — the actual edits, on the sync layer's overlay + local WAL.
- **Tool surface:** a minimal namespaced `wt_*` set (§3). Resist sprawl — every extra tool degrades the agent's tool-selection accuracy.
- **The spine:** `wt_claim` mints a monotonic `fence` (u64); the fence is threaded hook → write path and **validated at the resource**, defeating the zombie-lease hazard (`sync-loop.md` §10.3). This is invariant **I12** (§10).

---

## 2. Region model & stable identity

### 2.1 Three claim grains (a containment lattice)

| Grain | Key | Use |
|---|---|---|
| **repo** | `repo+branch` | sweeping refactors, the cross-cutting `root-X` of `sync-loop.md` §13 |
| **node** | `nodeId` (§2.1 of sync spec) | whole-file / dir claim |
| **region** | `regionId` | a function/block — **the default grain for code edits** |

`overlaps(a,b)` is a pure containment predicate: `repo ⊃ node ⊃ region` by anchor-path prefix; a dir-node contains its descendants. A region claim conflicts with any enclosing node/repo claim and vice-versa.

### 2.2 Structural anchoring (never positional)

```
regionId = H(nodeId, structural-anchor-path, anchor-kind)
```
The anchor path is a tree-sitter/LSP **qualified symbol path** (`Foo::bar`, `module.handler`), ordinal-disambiguated for anonymous blocks. **Never a line/byte range** — the whole-function rewrite a claim guards is exactly what destroys positional anchors. `byteRange` is carried only as an **advisory overlap hint** (and a fallback — see #42 below). regionId is epoch-spanning and survives concurrent edits and rename of the *enclosing* file (it keys on the immutable nodeId).

**Deterministic, convergence-safe resolution (#5, #6, #42).**
- Hook and watcher MUST resolve a region against the **same committed bytes** — `RECONSTRUCT(epoch) ⊕ already-captured-ops` — never raw on-disk bytes, or two peers mint different regionIds for the same code.
- An **exclusive** claim is **not grantable while the claimant's file frontier is behind the region's converged frontier** — this closes the pre-convergence "two anonymous blocks get the same ordinal" skew.
- **Overlap fallback:** when two same-node region claims have non-comparable anchor paths *and* the peers' file frontiers differ, fall back to advisory `byteRange` overlap and treat as a conflict rather than granting both (a regionId fork would otherwise make the collision invisible — the soft-warn safety net assumes both target the same regionId).

### 2.3 Rename & reclassification are atomic with the fence

- **Symbol rename** that changes the anchor path (`parse → parseFast` inside the same edit) re-mints regionId. `wt_rename_region` is a **single CP op carrying both the old→new regionId and the content edit**, migrating the fence in one conditional-write (#7) — never a separate orphaning step.
- **Text→binary reclassification** (`sync-loop.md` §9) must **acquire/honor the node-grain fence before switching `contentRef`** from text-CRDT to BlobPointer, and the blob (LWW-with-claim) write path must check that fence (#8) — else an edit escapes its region fence onto the blob path.
- On a **forced `WT-Deferred` land** (`sync-loop.md` §4.1) of a still-held region, the holder's claim is **re-anchored into epoch N+1 with a fresh fence, atomic with the epoch-pointer CAS** (#12) — the holder cannot keep writing across the swap with a stale fence.

---

## 3. The tool surface

All tools return a uniform envelope. Errors are *successful* MCP responses with `isError:true` (so they enter the agent's context as a teaching signal) carrying:

```
{ code, class: "BLOCKED_RETRYABLE" | "TERMINAL", message,
  retry_after_ms?, queue_position?, holder?, fence_required_above?,
  remediation: [ <suggested tool call> ] }
```

The **load-bearing field is `class`**: `BLOCKED_RETRYABLE` (e.g. `REGION_CLAIMED`) → the agent may queue/retry/handoff; `TERMINAL` (`STALE_EPOCH`, `FENCE_REJECTED`, `PARTITIONED_CP`, `POLICY_DENIED`, `UNREGISTERED_ACTOR`) → re-sync or abort, **never spin-retry**.

**Core (9):**

```
wt_resolve_region(repo, path, symbol?, byteRange?)
  -> { regionId, nodeId, symbol, grain:"region"|"file" } | err REGION_UNRESOLVABLE
  // pure; resolves against committed bytes (§2.2). No side effects.

wt_claim(repo, target:{regionId}|{path,symbol?,byteRange?}, mode:"exclusive"|"shared",
         intent, origin:"agent"|"human", request_id,
         wait:"none"|"queue"="none", priority?, force?=false, all_or_nothing?=false)
  -> GRANTED { claim_id, fence:u64, ttl_ms, heartbeat_ms }
   | WARN_PROCEED { claim_id, fence, conflicts:[...] }     // human-involved soft path
   | err REGION_CLAIMED(BLOCKED_RETRYABLE){ holder, holder_contact, intent, retry_after_ms, queue_position }
   | err POLICY_DENIED | PARTITIONED_CP | UNREGISTERED_ACTOR (TERMINAL)
  // the denial payload is COMPLETE in one call (holder + contact + intent + remediation) — no second round-trip.

wt_release(repo, claim_id, fence, request_id) -> { released:true, woke_next:bool } | err FENCE_REJECTED
wt_heartbeat(repo, claim_id, fence_map:{regionId:fence}, progress_token)
  -> { renewals:[{regionId, ttl_ms}] } | { forced_land:true, marker } | err FENCE_REJECTED
  // progress_token is REQUIRED — see §4.3.
wt_upgrade(repo, claim_id, regionId, fence /*shared*/, request_id) -> GRANTED{ new_fence } | err REGION_CLAIMED
wt_downgrade(repo, claim_id, regionId, fence, request_id) -> GRANTED{ new_fence, mode:"shared" }
wt_handoff(repo, claim_id, regionId, fence, to_actor, note?, request_id) -> { handed_to, new_fence } | err
wt_whos_editing(repo, scope?:{nodeId?|regionId?|pathGlob?}, format?:"CONCISE"|"DETAILED", cursor?, limit?)
  -> { peers:[{actorId, kind, state, region, since}], next_cursor? }
wt_announce(repo, state, focus?, ttl_ms, progress_token, request_id) -> { ok:true }   // presence ping
```

**Decisions (3):**
```
wt_post_decision(repo, scope:{level:"repo"|"node"|"region"|"task", id?}, kind, title, body,
                 supersedes?, tags?, request_id) -> { decisionId, ord } | err SUPERSEDE_RACE(BLOCKED_RETRYABLE)
wt_get_decisions(repo, scope, include_superseded?=false, kinds?, format?="CONCISE", cursor?, limit?)
  -> { decisions:[...], next_cursor? }   // chain-heads only by default, scope-intersection filtered
wt_promote_decision(repo, decisionId, targetSection?, confirm) -> { promotedRef, claudeMdAnchor, commitIntent }
```

Every mutating call carries an idempotent `request_id` (guid); the CP store persists `request_id → effect` for the full claim lifetime so a retried create/release is a no-op, not a double-apply (#23).

---

## 4. Claim lifecycle & the fence

### 4.1 Lease, TTL, heartbeat

A grant returns `{fence, ttl_ms (~30s, shorter than the 60s landing lease), heartbeat_ms (~ttl/3)}`. A crashed holder is reclaimed on TTL expiry (ZooKeeper-ephemeral-node style). **Heartbeat extends the TTL but NEVER re-mints the fence** — only a fresh grant / upgrade / handoff mints a new (higher) fence.

### 4.2 The fence is enforced at LOCAL-ACK, not only at the relay (#1, #2, #3, #9, #24, #25, #27)

This is the single most important correction the adversarial pass forced — the exact analog of the sync spec's WAL lesson. The original design validated the fence at the relay (op-broadcast time), but the agent is told "success" at **local-ack** (local WAL fsync), *before* the relay ever sees the op. A zombie holder could therefore write to local disk + WAL and be told it succeeded.

Rules:
- The **daemon-local lease cache is authoritative for the fast path, and is liveness-gated.** A `GRANTED-from-cache` write is admitted only if a heartbeat-CAS against the CP store has succeeded within `(ttl − heartbeat_ms)`. A **missed/failed heartbeat is treated as immediate local lease loss** for enforcing (agent-vs-agent exclusive) claims — fail closed, no further local-acks for that region, the agent gets `FENCE_REJECTED`/`PARTITIONED_CP`.
- **maxFence is seeded synchronously from the CP store at the linearization point**, not lazily gossiped to relays. An op-journal admission for a regionId the relay hasn't seen consults the CP lock table's authoritative fence before admitting (#3, #24) — an under-propagated `maxFence` must never admit a zombie.
- **I12 (the invariant):** no op carrying a `(regionId, fence)` below the highest accepted fence for that region is ever applied — at local-ack, at the relay, and at landing.

### 4.3 Heartbeat requires proof of agent progress (#15, #53)

The heartbeat runs in the daemon, so a daemon that heartbeats for a **stuck, runaway, or dead** agent would hold a broad claim forever (and show it "editing" in presence). Therefore `wt_heartbeat`/`wt_announce` require a `progress_token` — a monotonically advancing op/broadcast count (or explicit agent keepalive) proving the *agent* (not just the daemon) is alive. Absent progress within a bound, the lease lapses and presence stops reporting `editing`.

### 4.4 Multi-region claims are deadlock-safe on the per-edit path (#14, #20)

The deadlock-freedom argument can't rest only on `all_or_nothing` up-front sets — real agents acquire incrementally. So:
- Every claim is a member of the actor's **claim-set**; acquiring a new region while holding others triggers **canonical-order (regionId-sorted) re-acquire** with **wait-die/wound-wait by `(lamport, actorId)`** (the older transaction wins; the younger backs off and retries) — standard deadlock-free contention.
- **All acquisitions within a single daemon** (the agent hook path, the watcher/human path `[D-46]`, and the daemon's own mv/re-projection `[D-18]`) funnel through **one intra-daemon lock manager** acquiring in canonical order, so the daemon can't deadlock against itself.

### 4.5 Upgrade / downgrade / handoff / reentrancy

- **upgrade** (shared→exclusive) succeeds only if the caller is the sole shared holder; mints a higher fence. Two shared holders racing to upgrade → the **lower `(lamport,actorId)` wins; the other is forced to downgrade/retry** (deterministic, no mutual-denial livelock) (#19).
- **downgrade** always succeeds, mints a fresh fence, wakes shared waiters.
- **handoff** CAS's the holder and mints a fresh fence for the recipient; the donor's later writes fail `FENCE_REJECTED` (#39 — a forced override may not demote a *live* fenced holder mid-write; it queues to the holder's next safe `PostToolUse` boundary).
- **reentrancy:** a re-claim by the same `(regionId, actorId)` returns the same fence and bumps a hold-count, **but still verifies lease liveness at the store when the lease age exceeds `heartbeat_ms`** (#11) — it may skip the CAS-acquire, never the liveness check.

### 4.6 Forced-land backpressure (#16, #17, #22)

A still-claimed region that must land to honor I6/I11 (`sync-loop.md` §4.1) lands its last-committed state with a `WT-Deferred` marker — but this is **not silent**: the holder's next `wt_heartbeat` returns a `forced_land` backpressure signal so the agent reaches a safe boundary and re-anchors (§2.3), rather than livelocking on perpetually-torn lands. Priority may **shorten a holder's lease to its next safe boundary** but never preempts mid-write; a hard fairness bound caps how many priority jump-aheads any queued waiter suffers.

---

## 5. Collision policy & identity

### 5.1 Party is an INPUT, never a runtime guess

The decision is a **pure deterministic function** `decide(claimants, region, policy) → GRANTED | BLOCKED | QUEUED | WARN_PROCEED`. "Party" (agent vs human) is derived in two stages:
1. **Edit origin** is tagged at the only two capture points the sync spec defines: the MCP/hook tool-call path stamps `origin=agent`; the watcher/external-edit path `[D-46]` and the daemon mv/re-projection path `[D-18]` stamp `origin=human`.
2. Origin is reconciled against the committed **identity table** (`actorId → declaredKind ∈ {human, agent, mixed}`).

### 5.2 Provenance must be unforgeable (#34, #35, #41, #43, #44)

- **Origin is not a self-declared plaintext field for mixed boxes.** It is bound to a provenance signal the agent process cannot forge — the hook runs inside the agent process, so origin is attested by the session/process key (PID/parent-process attestation), and **every claim is signed by the actor's session key**; the CP store rejects an origin the signature doesn't support. A pure-agent box cannot self-declare `human`.
- **Party for the *enforcing* decision keys on the op's ORIGINAL author kind** (carried in `refs/notes/wt-attribution`, `sync-loop.md` §4.2), **not** the kind of the local process re-projecting it — so the daemon's own `[D-18]` mv (tagged `human` so it doesn't lock the user out of their file) can't launder a real agent-vs-agent collision into a soft-warn.
- **Trust root:** identity-table writes are authenticated/authorized (a repo-admin-signed root, or SSO subject bound at enrollment); without it the whole anti-spoof layer is hollow. A reused `actorId` (DVV prune/rejoin, sync §2.1) does **not** inherit the prior occupant's `declaredKind` — kind is bound to `(actorId, role-epoch)`, re-attested on rejoin.

### 5.3 The fail-CLOSED default (#33) — the poisoned-default fix

The original "unknown actor → HUMAN (fail-safe)" is **inverted for enforcing regions**: an unregistered/unresolvable actor claiming a region whose policy is `block` gets `UNREGISTERED_ACTOR (TERMINAL)` and is **denied**, never silently downgraded to soft-warn. (A fresh CI runner or new dev must register before it can write enforcing regions — registration is cheap; silent interleave is catastrophic.) Non-enforcing regions may still soft-warn.

### 5.4 Per-glob policy, resolved authoritatively at the grant (#36, #37, #40)

Policy is a committed, git-converged per-glob config (`.working-together/policy.toml`), evaluated with gitignore precedence (deeper/later/negation). Each rule: `{ agent_vs_agent: block|queue, human_involved: warn|queue, ttl_ms, heartbeat_ms, claim_grain, priority }`. Default: **agent-vs-agent same region → HARD_BLOCK/serialize (enforcing); human-involved → SOFT_WARN + allow + conflict-mark-later (advisory).**

- The **effective policy is resolved at the single linearization point** — the grant CAS — from a policy copy the CP store holds and versions per epoch, so peers can't disagree across the config-edit window, and a peer's **local `decide()` is advisory-only and may never be *more* permissive than CP**: a tool call cannot reach a durable local-ack on an enforcing region that CP would deny.
- **Priority NEVER preempts a live fenced claim, and NEVER preempts a human-held claim** under any setting — it only orders the queue. (This resolves a direct contradiction between two of the source designs.)

### 5.5 Soft-warn escalates to soft-BLOCK under sustained human authorship (#21, #38)

A silently-ignored soft-warn lets a human clobber an agent (or vice-versa). So human-involved overlap starts advisory (Live-Share-style **auto-yield**: the agent's presence yields when a human shows active authorship) and **escalates to a real soft-block once the human's presence shows *sustained* active authorship on the exact overlapping region**. Auto-yield between two contending presences is **deterministic and one-sided** — the lower `(lamport, actorId)` keeps editing, the higher yields (#56, no symmetric ping-war). When a human is actively editing a hot region, agents **queue behind the human** rather than serializing only among themselves (#21).

---

## 6. The decisions bus (shared memory)

Durable, CP, append-only, content-addressed shared memory — lives in the coordination store (read-before-write), **not** the AP overlay. `wt_post_decision` / `wt_get_decisions` / `wt_promote_decision`.

- **Append-only + supersede-chains** (ADR immutability): a decision is immutable; "current truth" = chain heads; contradiction resolution is free (the head wins). `include_superseded=false` by default.
- **Two-ack durability, same contract as edits (#47):** `wt_post_decision` fsyncs to a local decisions-WAL before returning `created` (local-ack); CP append is the shared ack. A post issued while partitioned queues in the durable outbox and flushes on heal — it is never lost on a crash.
- **Offline supersede-fork (#45):** a buffered supersede whose `expected-old` is no longer the head on flush is **not silently re-parented** — it surfaces as a `SUPERSEDE_RACE` the agent (or a human) resolves; two live heads after a partition is a detected conflict, not a silent contradiction both peers follow.
- **Scoped retrieval, anti-flood (#49, #51):** decisions are scoped `repo | nodeId | regionId | task`. On a claim grant the hook **auto-injects the scope-intersection** — region + node + task decisions **plus all repo-scoped decisions whose path intersects the claimed region** (inclusion does *not* hinge on the author having tagged it `constraint`). `CONCISE` bodies by default; `DETAILED` on demand. A per-`(actor, scope)` token-bucket + **semantic (not byte-exact) dedup** stops a looping agent from flooding the bus.
- **Freshness by frontier (#50):** a region-scoped decision is stamped with the regionId's content frontier at post time; when the region's content advances past it, the decision is flagged `stale?` on retrieval so a moved-out-from-under-it decision isn't followed blindly.
- **Retention (#48):** bounded by the **same finite recovery window** as the sync layer (`sync-loop.md` open-decision #8 / I11) — not an unbounded "an offline peer might still need it." Past the window, dominated decisions are GC'd. This is invariant **I13**.
- **Promotion to `CLAUDE.md` (#52, #54):** one-way `wt_promote_decision` (human confirm required for agent-authored decisions). When a *promoted* decision is later superseded, raise a mandatory **promotion-drift event** so `CLAUDE.md` doesn't silently rot. For unattended agent runs, graduation-eligible decisions auto-**propose** promotion as a durable reviewable artifact (so a constraint that should reach `CLAUDE.md` isn't lost to GC before a human looks).

---

## 7. Presence / awareness

An **ephemeral state-CRDT** (Yjs-awareness-style), separate from durable claims, **not** in the overlay: `Map<actorId, {state, focus?, clock, lastUpdated}>`, observer-side TTL expiry, peers dropped on timeout, no tombstones.

- **Liveness is gated on AGENT activity, not the daemon heartbeat (#53):** `state=editing` requires a recent agent op/tool-call for that region, so a dead agent whose daemon still heartbeats its claim does not appear to be editing.
- **Secret suppression (#46, #55):** a focus on any node failing the I10 inbound filter (`sync-loop.md` §6.5) suppresses the **entire** focus object (nodeId, regionId, pathHint, intent) — published as state-only — because even a regionId/nodeId leaks the existence of a secret path. Free-text `intent`/`note` fields are **content-scanned** against the secret denylist (regex for `sk_live_`, `AKIA`, `-----BEGIN … KEY-----`, high-entropy tokens), not just path-filtered.
- **Enforcing decisions never derive party from presence (#28):** presence may *trigger* an agent to consider yielding, but the enforcing GRANTED/BLOCKED decision derives only from authoritative CP claim state + committed identity, so stale/zombie presence can't mislead it.

---

## 8. Consistency & failure

- **Claims/decisions are linearizable (CP).** A partitioned minority **cannot acquire a fresh exclusive claim** — no split-brain. Fences come from the one global landing-lease counter domain (#26), so equal-fence collisions across a partition are impossible.
- **Partition degrade (#9, #27, #29):** on heartbeat failure (store unreachable), an enforcing-capable machine **fails closed for agent-vs-agent exclusive** (stop granting from cache; deny further enforcing writes; agent gets `PARTITIONED_CP`). Human edits fall to the AP local-WAL path and reconcile on heal via the sync layer's S-matrix. While partitioned, a mixed box treats **all** writes to a contended region as enforcing (it can't trust per-edit origin to grant the looser path) (#29).
- **Crashed-holder reclaim** via TTL + fence: a returning zombie fails closed (its fence is below `maxFence`).
- **Wake-exactly-one is partition-robust (#31):** the woken FIFO waiter must CAS-confirm the grant within a bounded wake-ack window; if it doesn't (it was the unreachable party), the wakeup passes to the next waiter — no stranded queue.
- **Storms:** per-region FIFO with watch-next-lowest wakes exactly one waiter (no thundering herd); a `STALE_EPOCH` swap **auto-migrates still-valid claims to the new epoch** (re-seed `maxFence`, keep the holder) instead of mass-invalidating and triggering a re-resolve+re-claim storm (#18).
- **Never wall-clock** for queue or decision ordering — only `(lamport, actorId)` / store `ord`.

---

## 9. Hook integration

- **PreToolUse** (before an `Edit`/`Write`): the daemon resolves the regionId (§2.2) → `wt_claim(mode=exclusive, origin=agent)`.
  - **GRANTED** → stamp the `fence` into the edit envelope; the write proceeds; the fence is checked at local-ack (§4.2) and at the relay.
  - **BLOCKED** → **the hook fails the tool call** (it does *not* spin-wait inside the hook, which would block the agent's single tool slot) with the consolidated denial payload (holder, intent, `retry_after_ms`, `remediation`) so the agent does useful other work, queues, or requests a handoff — branching on `class`.
  - **WARN_PROCEED** (human-involved) → proceed but flag; on sustained human authorship this escalates (§5.5).
  - The hook also **auto-injects scope-relevant decisions** (§6) on grant.
- **PostToolUse:** `wt_broadcast(fence)` (carries the fence for I12 validation at the op-journal) + presence ping (with `progress_token`) + keep-or-release the claim. Keeping a claim across a multi-edit sequence is normal; the heartbeat (with progress proof) sustains it.
- **Watcher / external-edit path `[D-46]`** (a human/manual edit, no hook): the watcher takes a **provisional claim or intent beacon on the *first* raw FS event** for a path — *before* the ~300ms coalescing debounce — so an unfenced external write can't land before the claim is acquired (#10); it then resolves the region against committed bytes and claims `origin=human`, emitting conflict-as-data on overlap rather than a silent merge.
- **Codex parity:** the same contract behind Codex's hook mechanism; where Codex lacks a pre-write hook, the watcher provisional-claim path is the fallback (treated like the external path, with the latency caveat surfaced).
- **Latency:** `wt_claim` is on the hot path of every edit, so the GRANTED-from-cache fast path (liveness-gated, §4.2) keeps the common case sub-millisecond; only a cache miss / contended region pays the CP round-trip.

---

## 10. Invariants (extend the sync-spec set)

- **I12 — Fence monotonicity.** No op carrying a `(regionId, fence)` below the highest accepted fence for that region is ever applied — enforced at local-ack, at the relay, and at landing. (Defeats the zombie-lease hazard end-to-end.)
- **I13 — Decision durability & bounded retention.** A posted decision survives a crash (local decisions-WAL fsync before `created`) and is retained while not dominated by a durable promotion/supersession **within the finite recovery window**; past it, dominated decisions are GC'd.
- **I14 — Enforcement is authoritative, not advisory-overridable.** A peer's local `decide()` may never be more permissive than the CP-resolved policy; an enforcing (agent-vs-agent exclusive) write cannot reach a durable local-ack that CP would deny.
- **I15 — Provenance integrity.** Party (agent/human) for an enforcing decision derives from unforgeable session-key-attested origin + committed identity + the op's original author kind — never from a self-declared field, the re-projecting process, or ephemeral presence.
- These compose with the sync spec's I1–I11. In particular I12 strengthens I4 (convergence): collision *avoidance* via fences keeps two agents from ever producing the convergent-but-broken merge that I4 alone would happily converge on.

## 11. Threat scenarios → how the design handles them

| # | Failure class | Defense |
|---|---|---|
| 1,2,3,9,24,25,27 | Zombie/lapsed holder writes locally before relay fence-check | I12 fence checked at **local-ack**; liveness-gated cache; `maxFence` seeded synchronously from CP (§4.2) |
| 26 | Split-brain equal-fence collision | one global monotonic fence domain, not per-region counters (§1, §8) |
| 14,20 | Multi-region / intra-daemon deadlock | claim-set canonical-order acquire + wait-die; one intra-daemon lock manager (§4.4) |
| 15,53 | Stuck/dead agent holds claim; false "editing" presence | heartbeat requires `progress_token`; presence gated on agent activity (§4.3, §7) |
| 33,34,35,41,43,44 | Identity poisoned-default / origin spoof / laundered party | fail-closed for unregistered on enforcing; signed unforgeable origin; party from original author kind; trust root (§5.2, §5.3) |
| 36,37,40 | Policy divergence / local bypass / priority preempts | policy resolved at the grant CAS; local decide advisory-only; priority never preempts live/human claims (§5.4) |
| 21,38,56 | Soft-warn ignored → clobber; auto-yield ping-war | escalate to soft-block on sustained human authorship; one-sided deterministic yield (§5.5) |
| 7,8,12 | Rename/reclass/forced-land orphans the fence | atomic regionId+fence migration; node-fence before binary switch; re-anchor on WT-Deferred (§2.3) |
| 16,17,22 | Landing-deferral livelock / starvation | forced-land backpressure on heartbeat; lease-shorten to safe boundary; fairness cap (§4.6) |
| 5,6,42 | regionId fork hides a real collision | resolve against committed bytes; frontier-gated exclusive grant; byteRange overlap fallback (§2.2) |
| 45,47,48,50,51 | Decision loss / fork / flood / staleness | two-ack WAL; supersede-race surfaced; bounded retention; freshness-by-frontier; rate-limit + semantic dedup (§6) |
| 46,55 | Presence leaks secrets | full focus suppression on I10-failing nodes; content-scan of free-text (§7) |
| 18,31 | Epoch-swap / partition queue storms & stranded waiters | auto-migrate valid claims on swap; CAS-confirmed wake-one (§8) |
| 52,54 | CLAUDE.md promotion drift / lost graduation | promotion-drift event on supersede; auto-propose for unattended runs (§6) |

## 12. Open decisions (need a human call)

1. **Region resolution engine.** tree-sitter vs LSP vs the agent declaring its own symbol range — and the fallback when a file has no parser (treat as node-grain only?). Affects how often claims degrade from region to whole-file.
2. **Trust root for the identity table (§5.2).** Repo-admin-signed root vs SSO-bound enrollment vs the host's existing git auth. Security-critical; needs a concrete choice before enforcement can be relied on.
3. **Default `wait` behavior.** `none` (fail-fast, agent does other work) vs `queue` — and whether agents should default to requesting `handoff` on a blocked human-held region.
4. **Claim grain default per language/glob** — region for parseable code, node for the rest; confirm the threshold and the `.working-together/policy.toml` schema.
5. **Decision↔CLAUDE.md graduation policy** — when does a repeated/region decision auto-propose promotion, and is `refs/notes/wt-attribution` mandatory for decision authorship?
6. **Presence richness vs privacy** — how much focus/intent to expose by default; per-team config.
7. **Heartbeat/TTL tuning** (`~30s`/`~10s`) — static vs adaptive to latency, like the sync layer's trigger knobs.

---

*Provenance: synthesized by a multi-agent workflow (4 prior-art researchers → 7 dimension designers → 5 adversarial skeptics surfacing 52 scenarios) and hardened in v1 against the 40 critical/high findings. `(#n)` tags map mechanisms to the scenario they defeat. Depends on and extends [`sync-loop.md`](./sync-loop.md).*
