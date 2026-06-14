# WorkingTogether — the git-baseline ↔ CRDT-overlay synchronization loop

**Status:** Hardened spec (v2). This is the foundation document for WorkingTogether — a distributed, real-time "multiplayer for coding agents" layer over Claude Code / Codex. It specifies the spine of the product: how a durable git baseline and a live CRDT overlay stay in sync across distributed peers.

**How this was produced.** A multi-agent workflow grounded the design in prior art (jujutsu, GitButler, Automerge/Yjs, Zed/Figma, Syncthing), designed each dimension in parallel, synthesized a draft, then ran six adversarial skeptics that surfaced 57 failure scenarios (46 critical/high). This v2 folds the valid fixes in. Where a mechanism exists specifically to defeat an attack, it is tagged `[D-n]` (defends scenario n) so the rationale is traceable.

> **The product thesis, restated.** AI agents don't type character-by-character — they rewrite whole functions/files atomically. A char-level CRDT will *silently interleave* two concurrent whole-function rewrites into convergent-but-broken code (convergence ≠ correctness). Therefore the CRDT is **transport + convergence only**; the actual product value is **collision avoidance** — claims fired *before* the write. This document specifies the sync substrate that collision avoidance sits on top of.

---

## 1. Overview & source-of-truth model

The system runs as a **sequence of epochs**. An epoch is the device that makes "shrink a CRDT" tractable: you never shrink a live doc in place, you **swap to a brand-new empty one** at a coordinated cut. Within an epoch, four layers coexist with strict precedence:

1. **git baseline commit (a SHA)** — the durable, immutable *floor*: the agreed state up to a known CRDT frontier. Never edited; only superseded by a newer baseline commit that is its descendant on a linear chain.
2. **CRDT overlay doc** — the single source of convergent truth for *all uncommitted divergence* from the baseline: content edits, the structural tree, binary pointers. One doc per epoch, `docId = hash(baselineSHA)`.
3. **local op-journal / WAL (per daemon)** — a **local-first durable log** of every locally-authored op, fsync'd before the originating tool call is told it succeeded. **This is the source-durability layer the draft lacked.** Relay-ack provides *convergence* durability; the local WAL provides *source* durability so an op survives a crash, an offline window, or a clobbering `git checkout` before it ever reaches the relay. `[D-11][D-36][D-45][D-54][D-58]`
4. **on-disk working files** — a **per-machine projection (cache)** of `RECONSTRUCT(epoch) = baselineCommit ⊕ overlayDoc`. Authoritative for a synced path only in the narrow *dirty window* between a tool write and its WAL capture, and for gitignored paths (each dev's own `.env`).

**Precedence at instant *t* for a synced path *p*:** overlay wins; disk is truth for *p* only inside the dirty window until WAL-captured; baseline is truth only as the `⊕` floor.

**Two durability acks, never conflated** `[D-45][D-54]`:
- **`local-ack`** = op is fsync'd to the daemon WAL. The edit hook returns success to the agent **only after local-ack**. This is what "saved" means to the user/agent.
- **`relay-ack`** = op is durably appended to the shared op-journal at the relay. This is what "shared/converged" means.
Locally-authored ops live in a persistent **outbox** between local-ack and relay-ack and are retransmitted on reconnect.

### Roles

- **Daemon** (one per machine): sole *intended* local disk-writer; owns the local WAL + outbox; watches the gitignore-bounded working tree and `.git`; applies remote ops; performs epoch swaps locally. Writes the shared durable baseline only through the lease-gated landing protocol.
- **Sync relay** (cloud): CRDT transport + convergence + the **durable op-journal** (the relay's append is the relay-ack; it must fsync before acking). Holds no authority over the epoch pointer.
- **Coordination store** (cloud, strongly consistent — e.g. conditional-write KV / lock table): authoritative for the **epoch tuple** `{epochN, baselineSHA, docId}` and the **landing lease**; also hosts claims / `whos_editing` / decisions.
- **Landing Coordinator (LC)** (cloud service co-located with relay + git remote): executes landings. A dedicated cloud service, not an elected peer — removes leader-election failure modes and gives one obvious home for the single-writer lease. (Throughput objection → §12.)

**The one non-eventually-consistent moment** is the landing/epoch-swap. Everything else is local-first and eventually consistent. **CAP stance:** the durable baseline is **CP** (you cannot land while partitioned from the strongly-consistent store); live editing within an epoch is **AP** (you keep editing offline; convergence is eventual; local-WAL guarantees no loss).

---

## 2. Data model

A single shared model. The structural tree-CRDT is canonical; content and binary layers join it by `nodeId`.

### 2.1 Identity & keys

- **`nodeId`** — 128-bit, minted once at file/dir creation, **immutable across rename, move, and landing** (the jj change-id / Dolt primary-key analog). The cross-peer join key. *Not* an OS inode.
- **`regionId`** (optional, finer grain) — stable id for an editable region (function/block) for claim and conflict scoping.
- **`actorId`** — per *machine*, reused and pruned DVV-style across reconnects, never minted per process (prevents actor-set growth and false concurrency on reconnect).
- **`docId = hash(baselineSHA)`** — the CRDT room for an epoch's overlay.
- **`epochN`** — monotonic integer generation counter.

**Deterministic minting for reconciliation-born nodes** `[D-48][D-56]`: any nodeId created as part of a *convergent reconciliation* (unignore-into-scope, revive-after-delete, conflict-copy, lost+found rehome) MUST be derived, not random: `nodeId = H(epochN, originating-op-id | canonical-path | rule-tag)`. All peers compute the identical id, so reconciliation never forks identity per-peer.

### 2.2 The tree-CRDT (structure)

A Lamport-ordered **tree-CRDT with an atomic move op** (Kleppmann/Loro):

```
TreeNode = {
  nodeId,                 // immutable, epoch-spanning
  kind: file | dir | symlink,
  parent: nodeId | ROOT | TRASH | NIL,
  name,                   // single path segment, NFC-normalized
  mode: regular(0644) | exec(0755) | symlink(120000) | dir(040000),
  symlinkTarget?,         // link text, never followed
  contentRef,             // -> text-CRDT id (text) OR BlobPointer (binary)
  epoch,
  deleted: bool           // tombstone
}
```

- **Path is derived** by walking `parent` links — never stored as identity. Rename/move is a single field mutation, not a path rewrite.
- One op unifies everything: `Move { nodeId, newParent, newName, newMode?, lamport, actorId }`. Create = from `NIL`; delete = to `TRASH`; rename = new `(parent,name)`; chmod = `newMode`.

**Structure is compacted at every landing** `[D-23]`. nodeId is epoch-spanning, but the Move-log/tombstones are NOT. Each epoch swap seeds a **fresh tree-CRDT** whose live nodes are re-anchored to the just-landed baseline tree (nodeIds preserved, but the operation history and `TRASH` tombstones do not carry across). Otherwise structural history would grow unbounded despite content compaction.

### 2.3 Content

- **Text:** a per-node text-CRDT keyed by `contentRef`. Structure and content are **separate CRDTs joined by nodeId** — this orthogonality is what makes "rename + concurrent edit" both apply (edit targets `contentRef(nodeId)`, rename targets `(parent,name)` of the same nodeId).
- **Overlay is budgeted by serialized bytes, not op-count** `[D-30]`. Because agents rewrite whole files (each rewrite tombstones the prior run in a sequence CRDT), op-count understates real cost; the bounded-overlay trigger (§4.1) measures `encodeStateAsUpdate` bytes. A per-region replace/LWW representation is preferred over fine-grained char ops for agent-authored whole-file rewrites.
- **Binary/large:** `contentRef` is a `BlobPointer { size, hash, mode }`; the blob is out-of-band, content-addressed in the git object store. No CRDT merge.

### 2.4 The version/causality token (the spine)

| Level | Token | Order | Source |
|---|---|---|---|
| **Global** | `epochN` (chain of baseline SHAs) | **total** (linearizable) | advanced only by the landing CAS |
| **Local** | CRDT **frontier** (Yjs state-vector / Automerge heads) | **partial** | the live doc |
| **Per-op** | `(lamport, actorId)` | tiebreak | every op |

**Hard rule:** cross-epoch states are **incomparable by frontier** (an epoch swap mints a causally-unrelated doc). The only valid cross-epoch relation is the epoch order. *This is why a missed landing forces a hard re-baseline, never a delta-sync.*

**The recovery token** is `(epochN, frontier)`, embedded verbatim in every baseline commit (§4.2). Wall-clock is used **only** for human-readable labels — never for any ordering or resolution decision.

---

## 3. The steady-state edit loop

Within an epoch, no landing in progress:

1. **Agent issues an Edit/Write tool call.** The edit hook intercepts *before the write hits disk*.
2. **Claim.** The hook calls `claim(regionId | nodeId)`. Per the committed per-glob collision policy: agent-vs-agent on the same region → hard-block/serialize; human-involved → soft-warn + allow, conflict-mark later. **Claims are enforced on the CRDT write path, not only the hook** `[D-46]`: the watcher capture path (for external/manual edits) must also acquire a claim before emitting content ops; if the region is already claimed it emits a conflict-as-data object rather than a silent merge.
3. **Capture → local-ack.** On claim grant the write proceeds. The hook (preferred — tool calls carry explicit `old_path`/`new_path`/region intent) or the watcher (fallback) produces typed ops; raw FS events are coalesced first (§6.2). The op is **fsync'd to the local WAL before the hook returns success to the agent** `[D-11]`. The op enters the outbox.
4. **Broadcast → relay-ack.** Ops flow to the relay, which converges them into the live overlay and **fsync-appends them to the durable op-journal before acking** `[D-54]`. On relay-ack the op leaves the outbox. Unacked ops are retransmitted on reconnect by `(lamport,actorId)` identity (idempotent).
5. **Apply remote ops.** The daemon applies others' ops to its replica and re-projects disk for affected synced paths (sole writer). It backs off on `.git/index.lock` / in-progress git markers (§8) — but **disk projection is decoupled from the epoch swap** `[D-42]`: a daemon locked out of its own `.git` defers only its local projection; it never blocks the shared pointer advance.
6. **Release claim** when the region settles.

Quiescence (no new ops for `T_idle`) is measured at the LC from the relay's **durable frontier** using Lamport ordering, never wall clock.

---

## 4. Snapshot / landing

Landing is a **coordinated, leader-driven, linearizable epoch swap** — never a best-effort background flush, never a per-peer race. The LC is the sole baseline writer. **Edits never block during landing**; atomicity comes from snapshotting an immutable causal cut, not from pausing writers.

### 4.1 Trigger policy (hybrid, bounded)

Landing fires on the **first** of:

1. **Quiescence debounce** — overlay idle for `T_idle` (default 5s). Lands a settled state.
2. **Hard ceiling** — `T_max` (default 30s) OR overlay **serialized-byte budget** `B_max` exceeded (§2.3). This makes "bounded overlay" a monitored hard invariant (I6).
3. **Explicit** — `land(repo)` (before risky ops, before going offline, checkpoint-now).
4. **Green-tests gate (optional, per-glob).** Greenness gates **promotion to the human integration branch, never the bounded-overlay landing** `[D-32]`. Tests run **asynchronously against already-landed baseline SHAs**; promotion is an independent, retroactive fast-forward of `refs/wt/integration` to the latest baseline that tested green. A red or slow test suite never stalls landing.

**Claim-deferral cannot starve the bounded-overlay invariant** `[D-13][D-50]`. A region under an active claim at cut time is normally deferred to the next landing — but if deferring it would breach `B_max`/`T_max`, the bounded-overlay invariant wins: the landing proceeds, and the still-claimed region is landed as its last consistent committed state with a `WT-Deferred` marker (never a torn mid-tool-call rewrite — see §4.3). "Empty landing" is computed **after** claim-deferral and distinguishes *truly empty* (no ops since anchor → short-circuit) from *everything-deferred* (NOT empty — must still land to honor retention).

### 4.2 Baseline commit format

Every baseline commit embeds its recovery token, both as trailers (human-readable only) and in a machine-readable, SHA-keyed note:

```
WT-Epoch: 43
WT-Baseline-Parent: <prevBaselineSHA>
WT-Frontier: base64(<frontier at the cut>)
WT-New-DocId: <hash(thisCommitSHA)>
WT-Overlay-Oplog: <content-addressed ref to the landed op-batch>
WT-Tests: green | red | pending
```

- `refs/notes/wt-landings[SHA]` is the **authoritative, cryptographically-bound** landing record. Classification of "is this our own landing?" uses **only this note keyed by the exact commit SHA — never the message trailer** `[D-41]` (trailers are user-editable and survive rebase with stale values).
- Companion notes: `refs/notes/wt-attribution` (regionId→actorId, so blame survives squash), `refs/notes/wt-conflicts` (structured conflict sides).
- Landings live on `refs/wt/landings/<epoch>`. Their relationship to the user's working branch is **explicit** (§8.5), not left ambiguous.

### 4.3 The landing transaction (corrected ordering)

The Phase-4 ordering is **inverted from the draft** to make the epoch-pointer CAS the single linearization point and prevent a two-store fork between the git remote and the coordination store `[D-12][D-37][D-47]`.

**Phase 0 — Acquire lease.** Strongly-consistent conditional write on `repo+branch` (lane key per §12 if sharded): `cond: current_epoch==N AND lease_holder==null`; `set: lease_holder=LC, fence=f++`. Lease TTL ~60s, **fenced with a monotonic token**. CAS fail → abort (no-op).

**Phase 1 — Capture the cut (atomic, causally-closed).** `CUT = relay.durableFrontier()` — a single synchronous call to the relay returning a CRDT-native, **downward-closed** snapshot of only ops it has fsync'd `[D-15][D-28][D-55]`. Not a field-by-field state-vector read (which could include an effect whose cause is residual), and not a stop-the-world drain. Everything causally ≤ CUT lands; everything > CUT becomes residual. Because CUT is a causal frontier, it is identical on every replica.

**Phase 2 — Materialize overlay@CUT → tree, against the ANCHOR baseline.** Reconstruct doc state as of CUT; walk the tree-CRDT resolving moves by `(lamport,actorId)` with ancestor/cycle check (§6.3). **Incremental tree build** `[D-21][D-29]`: maintain a persistent materialized git tree per epoch and rebuild only the dirty subtree (reusing unchanged subtree SHAs) so landing cost is O(changed), not O(repo). Build as a child of the **anchor** baseline (`WT-Baseline-Parent`), never a concurrently-arrived external baseline (committing onto a moved base manufactures spurious conflicts). Binary blobs must already be durable (they are uploaded **out-of-band during steady state** `[D-33]`, not inside the lease-held critical section).

**Phase 3 — Author the landing commit.** Squash to ONE commit. Multi-author attribution from CRDT metadata → deterministically-ordered `Co-authored-by:` trailers (config `attribution: per-author` emits one commit per author). Per-hunk authorship is preserved in `refs/notes/wt-attribution` regardless, so blame survives squash. **Build the commit as a loose orphan object — do NOT advance any human-visible ref yet** `[D-47]`.

**Phase 3.5 — Persist landing intent (crash-recoverability).** Before the CAS, durably record `{F_cut, docId(N), residual-op-id list, candidate SHA C}` in a landing-intent record `[D-12]`. This makes Phase 5 (residual rebase) deterministically re-runnable after an LC crash between CAS and publish.

**Phase 4 — The linearization point.** Re-read the remote branch tip under the lease; **if tip ≠ `WT-Baseline-Parent`, the anchor was rewritten mid-landing (e.g. CI force-push) → ABORT** (orphan C is harmless) and re-baseline `[D-37]`. Else CAS the epoch pointer `cond: current_epoch==N AND fence==f`; `set: epoch=N+1, baseline=C, docId=hash(C)`. **This CAS — and only this CAS — makes epoch N+1 exist.** `refs/wt/integration` and `refs/wt/landings/<N+1>` are fast-forwarded to C **as followers of the pointer, after the CAS succeeds**, never before.

**Phase 5 — Mint new epoch + rebase residual + publish.** Mint a fresh empty doc `docId=hash(C)` (from typed values, never JSON round-trip). For each residual op (clock > CUT), replay **by stable nodeId/regionId** onto the new doc — but run the **full 3-way S-matrix (§7.2), not a blind replay** `[D-22][D-40]`: if a residual region and the just-landed region produce byte-identical (git-normalized) content, it is a **no-op absorb** (not a conflict); only genuine overlap emits a conflict-as-data object. Conflict objects are **written as immutable content-addressed git objects under `refs/wt/conflicts/<epoch>/<nodeId>` at creation, before any in-tree marker** `[D-16][D-56]`, so an external `git checkout`/`clean` can't destroy the loser side. The on-disk diff3 marker is a deterministic *render* of that one shared object. Finally **publish `{N+1, C, docId}` via the coordination store and release the lease.**

### 4.4 Daemon-side epoch swap

On receiving `{N+1, baselineSHA, docId}`:
1. `git fetch` + fast-forward working baseline to `newBaselineSHA`.
2. Switch active replica `docId(N) → docId(N+1)`; seed from empty + pull residual via state-vector delta (cheap).
3. Re-project disk to baseline+residual (usually a no-op since the daemon authored its local ops). Conflict regions rendered from the shared conflict objects; surfaced via `whos_editing`. If locked out of `.git`, defer only this step (`[D-42]`).

---

## 5. Baseline advance + overlay rebase (the spine)

Exact end-to-end sequence with tokens.

**Pre-state:** epoch N, `baselineSHA=B_N`, `docId=hash(B_N)`, anchor frontier `F_anchor` (embedded in `B_N`). Peers editing live; overlay frontier `F_live ⊒ F_anchor`.

```
T0  LC trigger fires (§4.1).

T1  Phase 0: CAS lease on repo+branch
      cond: epoch==N AND lease_holder==null ; set: holder=LC, fence=f++
    FAIL -> abort.

T2  Phase 1: CUT = relay.durableFrontier()   // atomic, downward-closed, fsync'd
            // (causal frontier; identical on every replica)

T3  Phase 2: tree T = materialize(doc @ CUT) onto parent B_N (ANCHOR)
      - resolve Move log by (lamport,actorId), ancestor/cycle check
      - incremental: rebuild only dirty subtree, reuse unchanged subtree SHAs
      - binary blobs already durable (uploaded out-of-band in steady state)

T4  Phase 3: C = orphan-commit(tree=T, parent=B_N, trailers..., co-authors...)
      write refs/notes/wt-landings[C], wt-attribution[C]   // SHA-bound
      // C is a loose object; NO human-visible ref advanced yet

T4.5 Phase 3.5: persist landing-intent {F_cut, docId(N), residual-op-ids, C}

T5  Phase 4: re-read remote tip
      if tip != B_N -> ABORT (anchor rewritten; orphan C harmless), re-baseline
      CAS epoch pointer  cond: epoch==N AND fence==f
                         set : epoch=N+1, baseline=C, docId=hash(C)
      stale-fence FAIL -> ROLLBACK (nothing published)
      ── LINEARIZATION POINT: epoch N+1 now exists ──
      FF refs/wt/integration, refs/wt/landings/N+1 -> C   // followers, after CAS

T6  Phase 5: mint empty doc D' (docId=hash(C)) from typed values
    for each residual op o (clock(o) > CUT), keyed by nodeId:
        run S-matrix vs landed(N):
          byte-identical result      -> ABSORB (no-op)        [D-22][D-40]
          disjoint                   -> apply as fresh op on D'
          overlapping                -> conflict-as-data object
                                        (write to refs/wt/conflicts FIRST,
                                         then render diff3 marker in-tree)
    publish {epoch=N+1, baseline=C, docId=hash(C)}   // commit point
    release lease (fence stays monotonic)

T7  each daemon (on publish): git fetch; FF -> C; switch docId; pull residual
    delta; re-project disk (defer if .git locked); render conflicts; notify.
```

**Why each guarantee holds:**
- *No fork (I1):* only the fenced CAS at T5 mutates the durable pointer; integration ref is a follower; a concurrent second LC fails CAS and orphans its commit; an anchor rewritten mid-landing is caught by the tip re-read.
- *No double-apply / no loss (I2/I3):* `WT-Frontier=CUT`, captured as a downward-closed snapshot, partitions every op into exactly one epoch — none in both, none in neither. Local WAL + outbox guarantee source durability before any of this.
- *No spurious conflicts:* commit against `B_N`, rebase residual onto `D'`, absorb byte-identical results.
- *Deterministic:* conflict loser, marker order, move resolution, co-author order, and reconciliation-born nodeIds are all pure functions of `(lamport, actorId)` + op identity.
- *Crash-recoverable:* the landing-intent record (T4.5) makes Phase 5 re-runnable; the orphan commit is content-addressed so a re-run yields the same SHA.

---

## 6. Structural FS ops

### 6.1 Model

Structure is the tree-CRDT of §2.2. Renames/moves/creates/deletes/chmods are all `Move` ops; content rides through structure because both key on the same `nodeId`. Naive path-keyed sync (delete-old + create-new) is rejected — it loses concurrent edits and re-transmits whole files on every refactor.

### 6.2 Coalescing raw FS events

The watcher (Watchman / fsmonitor / ReadDirectoryChangesW) and edit hooks emit raw events. A debounce window (default ~300ms) batches them; the coalescer classifies:

1. **Editor atomic-save** → CONTENT-EDIT of the existing nodeId, never delete+create. **Detection does not rely on the time window** `[D-39]`: it triggers on any rename whose *source* matches a known editor temp pattern (`.swp`, `~`, `.tmp`, hex, `.goutputstream-*`, `.#*`) OR whose source is a file created recently that no tracked nodeId has read, and whose *dest* is an existing tracked path. (A slow disk that pushes temp+rename past 300ms must still be classified as a save.)
2. **Refactor/move** (DELETE old + CREATE new) → git-diffcore heuristics: exact content-hash → MOVE; same basename diff dir → MOVE; similarity ≥ threshold (default 50%) → MOVE + delta; else genuine delete+create.
3. **Pure rename** (rename syscall, both paths tracked) → MOVE.
4. **Hook over watcher:** Claude Code/Codex tool calls carry `old_path`/`new_path` → first-class MOVE without heuristics. Watcher is the fallback for external/manual changes.

**Rename classification is never a divergent per-peer heuristic on shared state** `[D-53]`. Only ONE peer authors the structural op for a given FS change — the origin peer (hook is authoritative; for purely-external manual changes, the daemon that owns that working tree). Other peers receive the authored MOVE op, never re-derive it from similarity locally. All hashing/classification is on **git-normalized bytes** (after `.gitattributes` EOL normalization) `[D-7]`, so a CRLF peer and an LF peer agree on content-hash and rename detection.

**Watcher overflow → tree-level reconcile** `[D-29]`. On a watcher overflow/rescan signal (common on Windows under a formatter storm or large checkout), do NOT classify event-by-event. Diff the on-disk tree against `RECONSTRUCT(epoch)` (git-status-style crawl) and emit one coalesced structural delta.

### 6.3 Move operation & cycle safety

Process moves in `(lamport, actorId)` total order. Before each move, an **ancestor check**: if `newParent` is a descendant of `nodeId` (cycle) or is tombstoned → SKIP. Every peer computes the identical result (pure function of ops).

- **Concurrent rename + edit (same node):** both apply (orthogonal). Renamed path containing the edit. Nothing lost.
- **Concurrent rename to two names:** LWW on `(name,parent)` by `(lamport,actorId)`; loser's intent surfaced as a notice; content unaffected.
- **Delete-vs-edit / create-inside-deleted-dir:** orphan whose ancestor is tombstoned → re-home to `lost+found`. The re-home Move is a **dedicated rescue-class op assigned a lamport that dominates the tombstoning delete** `[D-19]`, so it is durable across the landing that tombstoned the dir and never overridden. lost+found surfaces on disk under `.working-together/lost-found/`.
- **Daemon disk mutations are serialized against the local editor via the same claim** `[D-18]`: the daemon takes the node/region claim (or a path-level advisory lock) before performing a `mv` / re-projection, so a concurrent atomic save can't interleave with a remote rename.

### 6.4 Directory, mode, symlink

- **MKDIR/RMDIR** = create/tombstone a `kind=dir` node; deleting a non-empty dir tombstones dir + each live descendant in one Lamport-batched transaction. Empty dirs live in the CRDT; `.gitkeep` policy at landing.
- **mode** = LWW-register by `(lamport,actorId)`; git's four modes only. The mode bit is materialized into the git tree by the LC **from the CRDT field, not from a working-copy stat** `[D-57]`, so `core.fileMode=false` on a Windows lander never drops a Linux peer's exec bit from the durable baseline.
- **symlinks** = `kind=symlink`, `symlinkTarget` a tiny LWW blob, never followed. On Windows without privilege: record git representation correctly, write a placeholder + warn.

### 6.5 Gitignore as sync scope — enforced at capture time

A path is in the shared CRDT **iff** not ignored by the effective shared ignore set. **The decisive correction: scope is enforced inbound, at capture, not deferred to landing** `[D-1][D-2][D-3][D-4][D-9][D-10]`.

**Inbound capture filter** (evaluated by the hook/daemon before any op is journaled or broadcast):
```
admit(path) = NOT ignored_by( baseline_ignore_set
                               ∪ pending_overlay_ADD_ignore_rules   // safe direction: suppress immediately
                               ∪ builtin_secret_denylist )          // .env*, *.pem, id_rsa*, *.key, .aws/, etc.
              AND NOT locally_excluded_by_originating_peer(path)     // local excludes = a protective CEILING
              AND size(path) < large_threshold                      // large/generated files never enter the text CRDT
```
- **Pending ADD-ignore rules take effect immediately** (safe — suppresses capture); pending REMOVE-ignore rules (unignore) take effect only at a landing, and never auto-seed (below).
- **Local excludes (`.git/info/exclude`, local `.gitignore`) are authoritative only in the protective direction**: a peer never captures/broadcasts a path it locally ignores. There is no "shared `.git/info/exclude`" — it has no convergent representation; shared scope comes exclusively from committed `.gitignore`.
- **Built-in secret deny-list** is always applied regardless of gitignore state, closing the brand-new-repo / `.gitignore`-still-in-overlay race.
- **Large/generated files** (`dist/`, `build/`, `target/`, `*.bundle.*`, over size threshold) are classified at capture and routed to the blob path (§9), never flooding the text CRDT.

**Ignore transitions** (debounced like any edit `[D-34]`, applied at the next normal landing — not forced immediate):
- **Becomes ignored:** drop the node from the new-epoch CRDT; mirror git (already-tracked file stays on disk locally; don't delete the user's file).
- **Becomes unignored:** mint **deterministic** nodeIds; seed from the authoritative disk copy **only if it does not match the secret deny-list and does not differ across peers** `[D-3][D-5]`. A file that differs across peers (the signature of per-peer secrets) requires explicit per-peer human confirmation before it is ever shared; default is to keep it local.
- **Force-added secret in an external commit** (`git add -f .env`): at AUTO-LAND adoption (§8) the candidate tree is scanned against the deny-list/ignore set; a force-added secret **blocks the landing and surfaces a warning** `[D-5]`, never silently adopts.

**Purge protocol (defense in depth)** `[D-4][D-8]`: if a path is retroactively determined to have been a secret (deny-list match or ignore-transition-to-ignored after the fact), trigger an explicit purge — drop the ops from the journal, rewrite affected overlay snapshots, and alert. Quarantine commits and offline replay run the same inbound filter so a secret never enters `Q` either.

---

## 7. Initial sync & offline reconnect

The coordination store is the single source of truth for the epoch tuple. Every join/reconnect is a function of **my epoch vs. authoritative epoch**.

### 7.1 Late-join

```
1. P -> coord: JOIN(repoId, auth)
2. coord -> P: {epochN, baselineSHA, docId, frontier}        // strongly-consistent
3. P: git fetch && checkout --detach <baselineSHA>           // PINNED SHA, partial/sparse
4. P: open replica room = docId
5. P -> relay: SUBSCRIBE(docId) + sync-step-1 (state-vector)
6. relay -> P: sync-step-2 = ONLY the overlay ops P lacks    // small <= frequent landings
7. P (daemon): project disk = baseline ⊕ overlay
8. P -> coord: ANNOUNCE_LIVE(epochN, actorId)
```

**Baseline-join cost is bounded explicitly** `[D-26]`: use partial/blobless/treeless clone + sparse-checkout scoped to the gitignore-bounded set, so a 5 GB / 200k-file monorepo doesn't materialize fully. Do **not** instantiate a text-CRDT per file at join — build CRDT content lazily on first edit of a node.

**Epoch-race guard:** a landing between steps 2 and 5 → relay refuses SUBSCRIBE to the stale docId (`STALE_EPOCH`); P loops to step 2. Cheap re-fetch, never a cross-epoch merge.

### 7.2 Offline reconnect (the scary path)

**The hinge rule:** if `localEpoch < authoritativeEpoch`, P **cannot delta-sync** (no common CRDT ancestor across a swap) → **mandatory hard re-baseline**. Detect by comparing `epochN`, not elapsed time (a long-offline peer with no landing in between just does a normal same-epoch delta-sync).

Setup: P offline at `{B1, D1}`; others landed `B1→B2→B3`; P kept editing. The 5-phase reconnect (deterministic throughout):

```
R0 FREEZE: pause local agent Edit/Write; release P's claims.

R1 QUARANTINE (never lose work; git-stash-branch semantics):
   quarantine = EVERY op in P's replica (local OR remote-received) whose effect
                is NOT dominated by B3's WT-Frontier               [D-14][D-49]
   (do NOT discard received-but-unlanded remote ops by category — some never landed)
   run the inbound secret/ignore filter over the set                [D-8]
   Q = commit-tree(B1 ⊕ quarantined-edits); tag each file with nodeId; fsync.

R2 ADVANCE & SWAP: git fetch; FF checkout B3 (pinned); open D3; late-join 5-7.

R3 REPLAY Q AS FRESH OPS, per-file, BY NODE-ID, IDEMPOTENTLY:
   for each quarantined op o:
     first query D3/B3 for o's identity (lamport,actorId)           [D-51]
     if already present -> skip (idempotent; survives a crash mid-replay)
     else resolve via the S-matrix below.

R4 PUBLISH & RESUME: broadcast replays on D3; conflicts -> conflict-as-data;
   lift FREEZE; ANNOUNCE_LIVE(epoch=3).

R5 IDEMPOTENCY: Q + epoch token persisted before R3 mutates the live doc;
   replay is by op-identity, not a lamport watermark, so a stale/ crashed
   last-relay-ack pointer is safe (re-query, never blind-replay).   [D-51]
   Retain Q until all replays acked.
```

**Per-file S-matrix (R3).** `base = B1 content of nodeId N`; `ours = P's offline content`; `theirs = B3+overlay content`. All tiebreaks `(lamport,actorId)`.

| # | Situation | Resolution |
|---|---|---|
| **S1** | `theirs == base` | Apply `ours` as a fresh edit on D3. |
| **S2** | both edited, disjoint hunks | 3-way auto-merge; apply. |
| **S2′** | both edited, overlapping | **Never interleave.** Conflict-as-data `{N, base, theirs, ours, diff3}`; written to `refs/wt/conflicts` first, then rendered. Loop stays live for other files. |
| **S3** | renamed remotely | Replay by nodeId → apply `ours` at N's current path. If P also renamed → move-log LWW; content edit still applies; cycle-check. |
| **S4** | deleted remotely, P edited | Revive `ours` under a **deterministic new nodeId** at path `f` (don't fight the tombstone) + decision record. |
| **S5** | `ours ⊆ theirs` (byte-identical / absorbed) | No-op absorb — drop replay to avoid echo. |
| **S6** | binary/large | No 3-way. Equal hash → no-op; differ → LWW-with-claim; concurrent no-claim → conflict-copy `f.conflict-<actor>-<lamport>.<ext>`. |
| **S7** | P created new file | Pure add; NFC + case-fold collision check → deterministic suffixed conflict-copy if collision. |
| **S8** | P deleted, edited remotely | Conflict; default keep the edited content, record P's delete intent. |
| **S9** | directory-level concurrency | Lamport-ordered move-log + ancestor/cycle check. |

**Ordering:** when a node is both moved (S3) and content-conflicted (S2′/S4), resolve the tree move first (by nodeId), then the content conflict — else markers attach to the wrong path.

---

## 8. External git coexistence

**Unifying rule:** every external git mutation is a candidate **baseline event**, never a stream of user edits. The daemon is the *preferred* sole disk-writer but **never assumes exclusive ownership** (jj colocated pattern). **Rooms are keyed `repo + branch`** so a branch switch is *leaving one room and joining another*, not yanking the baseline from every peer.

**Before classifying any local git event, the daemon does a strongly-consistent epoch read and refuses to act on a stale anchor** `[D-35]` (drain to current epoch first). This closes the window where a manual commit lands between Phase-5 publish and the daemon's fetch and gets reconciled against a stale anchor.

### 8.1 Detection

Watch `.git` as a special, never-broadcast zone: `HEAD`, `refs/heads/*` + `packed-refs`, `index` (mtime+hash), in-progress markers (`MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `ORIG_HEAD`, `*.lock`), `logs/HEAD`. **Structural delta (HEAD + refs + index + object graph) is the primary classifier; the reflog verb is corroboration only** (reflog format is locale-dependent). Act only on the **quiesced state**: no lockfiles, no in-progress markers, refs stable. **The quiesce window is adaptive** `[D-43]` — extended when an interactive rebase/reset verb is seen — so a multi-command human git sequence collapses into one reconciliation instead of firing on a transient mid-rebase state.

### 8.2 Own-landing vs external

A commit whose **SHA-keyed `refs/notes/wt-landings` note** has `WT-Epoch == current epoch` → our own landing echoing back; ignore. Older epoch → history; ignore. **No SHA-bound note → genuine external commit** → reconcile. (Message trailers are never trusted for this `[D-41]`.)

### 8.3 Reconciliation classes

| Class | Trigger | Handling |
|---|---|---|
| **AUTO-LAND** | manual commit on the branch, content == or ⊆ overlay (and passes the deny-list scan) | Adopt as baseline: lease + epoch swap with this commit as `C(N+1)`; rebase residual by id. |
| **AUTO + NOTIFY** | manual commit diverging from overlay for a shared file | Baseline wins for durable bytes; overlay's competing region → conflict-as-data; notify. **Runs the full per-node S-matrix, not blind replay** `[D-40]`. |
| **ROOM-SWITCH** | checkout changing HEAD's branch | Leave room(repo,A), join room(repo,B). Peers on A unaffected. **Always durably capture the departing overlay locally first** (§8.4). |
| **REBASE-OVERLAY** | ff-pull / merge-pull / fetch+rebase advancing the tip | New tip = baseline; rebase residual by **stable id** (rebase-pull rewrites SHAs → never key by commit hash); per-node S-matrix. Merge stopped-on → quiesce on `MERGE_HEAD`. |
| **PAUSE+PROMPT / GUARD** | history-destroying ops | below |

**Detached HEAD:** no branch ref → sync-suspended/read-only for that worktree; re-attaching resumes.

**`reset`/force:** `--soft`/`--mixed` → baseline re-point + rebase by id. `--hard` to an ancestor → PAUSE+PROMPT; preserve overlay as a `wt-stash` first. `--hard`/force rewriting a **published baseline peers built on** (incl. CI force-push) → lease + epoch swap + **mandatory peer hard-re-baseline, behind confirmation**, never silent. Non-descendant moves (FF impossible) → treat like a missed-landing reconnect for all peers.

**CI pushes** touch the remote, not local `.git`: watch the remote branch ref via **webhook with poll fallback**. Normal push → REBASE-OVERLAY; force-push → PAUSE+PROMPT re-baseline. (The Phase-4 tip re-read `[D-37]` independently catches a force-push that races an in-flight landing.)

### 8.4 Room-switch & branch-switch durability `[D-17][D-25][D-36][D-42][D-58]`

A branch switch must **never** require a synchronous full land and must **never** strand divergence — even offline:
- The overlay is **continuously persisted to the local WAL** (§1), so room-A divergence survives a clobbering `checkout` independent of the cloud.
- On switch, snapshot the overlay as a cheap content-addressed **local `wt-stash`** (one dirty-subtree tree-write) and detach it from the room **without** advancing the shared baseline. No blocking full land on the UI path.
- If a force-land is genuinely needed and the cloud is unreachable (partition), the daemon still writes the local `wt-stash` and proceeds; reconciliation happens on reconnect via the §7.2 path. PAUSE+PROMPT is a last resort that **still guarantees the local durable capture happened first**.

### 8.5 The branch-tip ↔ baseline-chain relationship — two tracks, adaptive promotion cadence `[D-38]`

**Resolved (v3).** Rather than choosing "working branch *is* the chain" vs. "branch hand-curated," the model is **two structurally-static tracks with an adaptive promotion *cadence*.** This dissolves the either/or — you get the fresh track's currency *and* the clean track's tidiness, tuned by one knob — and it is strictly safer than either static default because all fork-prevention lives on the fine track and never moves.

- **FINE track (always on, never toggled):** every landing fast-forwards `refs/wt/landings/<N+1>` and the always-followed `refs/wt/integration`. **The baseline chain and the epoch pointer live here.** This is what peers and CI follow; it is the real-time durable floor. It is the I1/I3 substrate and is identical regardless of mode.
- **COARSE track (the human working branch, e.g. `main`):** a **promotion follower**, never the epoch-pointer CAS target. It advances only by *promotion* — a cheap fast-forward (or squash) to an already-landed, already-durable baseline SHA — exactly as `refs/wt/integration` already follows the pointer.

The only adaptive element is **promotion cadence** (how eagerly the coarse follower catches up), governed by the same dead-band + cooldown hysteresis as §13. **Do not** build a mode that physically moves the firehose between `refs/wt/*` and `main` and back — that toggle is the genuine fork hazard and is explicitly rejected; the chain stays permanently on the fine track.

**Promotion triggers** (first of, mirroring §4.1): **green-tests** (primary — promote to the latest green baseline; this *is* the existing §4.1 #4 mechanism generalized), **quiescence** (`T_promote_idle ≫` landing `T_idle`), **interval/explicit** (`T_promote_max` ceiling so `main` never drifts unboundedly stale; plus `promote(repo)`). **Greenness gates promotion, never the bounded-overlay landing (I6)** — a red or slow suite freezes `main` but the firehose keeps the overlay bounded.

**Promotion protocol (hardened against the race scenarios).** Promotion introduces no second linearization point — it moves a follower ref under discipline:
1. Strongly-consistent epoch read; pick `promotionTarget` per trigger.
2. **Acquire the SAME `repo+branch` landing lease** — *not* a separate promotion lease — so promotion and landing can never both hold authority (closes the double-promote two-lock gap).
3. Re-read `HUMAN_REF` under the lease and **CAS `HUMAN_REF` against its exact observed old value** (`update-ref … expected-old`):
   - **Clean** (tip == last `promotedSHA`): FF, or author a squash commit (`parent=tip, tree=promotionTarget.tree`) and FF. Then CAS the `promotedBaseline` watermark. The `HUMAN_REF` move is a follower of that watermark CAS.
   - **Raced** (a human commit landed on `HUMAN_REF`): **abort and yield to the §8.1/§8.3 external-commit detector** — promotion never classifies or adopts a manual commit itself (prevents double-counting). The manual commit becomes a normal AUTO-LAND / AUTO+NOTIFY baseline event through the Phase-4 CAS, after which promotion resumes.
   - **Ambiguous** (squash boundary unclear): graceful-degrade — skip this cycle, retry next trigger. Safe because `HUMAN_REF` is only ever a follower.
4. Release the lease.

**No echo loop / no mode-mixing:**
- Promotion squash commits carry a note in a **distinct namespace `refs/notes/wt-promotions[SHA]`**, which §8.1 treats as a never-reconcile zone like `refs/wt/*`. The §8.2 classifier recognizes a promotion commit as its own and never re-adopts it as an external human commit (still note-based, never trailers `[D-41]`).
- **FF and squash cannot be mixed within one coarse lineage** without an explicit re-anchor (once squashed, `HUMAN_REF` lineage has diverged from the chain, so subsequent promotions must also squash, or re-anchor deliberately).

**CI / PR base default points at the FINE track** (`refs/wt/integration`), not the lagging `HUMAN_REF`, so a force-push or PR-merge never races a stale promoted branch. **Promotion lag** (`currentEpoch − promotedEpoch`) is surfaced as a first-class machine-readable signal; PR tooling warns when lag exceeds a threshold.

**GC:** once `HUMAN_REF`/the green watermark has promoted past a baseline, `refs/wt/landings/<older>` commits dominated by the promoted-and-durable commit are pruned (jj op-journal-style), gated by I11's dominated-AND-durable rule + the recovery window — never pruning a landing an un-converged offline peer might still replay.

*(Per-glob config exists for teams that want the legacy behaviors: `promote: every-landing` collapses to the old "working branch is the chain" default; `promote: manual` gives a fully hand-curated branch where every human commit is an AUTO-LAND.)*

---

## 9. Binary / large files

- **Classification** by `.gitattributes`, size threshold, or content sniff — on **git-normalized bytes**, **at capture time** (§6.5) so large/generated files never enter the text CRDT `[D-6]`.
- **Overlay holds only a pointer** `{size, hash, mode}`; the blob is out-of-band, content-addressed in the git object store (or LFS pointer). No CRDT merge.
- **Blobs upload out-of-band during steady state** `[D-33]`, content-addressed as they appear, so a landing referencing them never blocks inside the lease.
- **Every blob referenced by ANY acked overlay pointer is pinned** under `refs/wt/blobs/*` until a landing supersedes it AND the superseding blob is confirmed durable `[D-20]` — never GC a blob that is the value of an acked pointer.
- **Policy:** LWW-with-claim; concurrent claim → conflict-copy `file.<actor>.<ext>`, recorded in the landing.
- **Reclassification mid-session** (a text file crosses the threshold) is a **barrier that conflict-checks all concurrent content ops** `[D-52]`: capture the text-CRDT frontier at migration; valid only if no concurrent (clock > migration-cut) text op exists, else emit a conflict — never a silent migration that drops edits.

---

## 10. Consistency, invariants & recovery

### 10.1 Invariants (must always hold)

- **I1 — No fork.** Baseline commits form a linear chain; ≤ one baseline child per epoch. Enforced by lease + fenced CAS + anchor tip re-read; integration ref is a follower of the pointer.
- **I2 — Snapshot↔journal token integrity.** Every baseline embeds the exact `WT-Frontier` (a downward-closed snapshot) it captured; recovery replays exactly the ops not dominated by it.
- **I3 — No acknowledged edit is lost.** Once an op is **local-ack'd** (WAL fsync) its effect survives crash/offline/checkout; once **relay-ack'd** it appears in the current overlay or a landed baseline for all peers after convergence — including across landings for offline peers (replayed by identity, never dropped).
- **I4 — Convergence.** Same epoch + same frontier ⇒ byte-identical synced trees. All resolution (loser, move-cycle, marker placement, co-author order, reconciliation-born nodeIds) is a pure function of ops + `(lamport,actorId)` + op identity; never arrival order or wall clock.
- **I5 — Eventual quiescent agreement.** Absent new edits, all live peers converge to the same `(epochN, frontier)` and on-disk projection.
- **I6 — Bounded overlay.** Overlay serialized-byte size is monitored; crossing threshold forces a land or degrades to read-only — never unbounded. **Claim-deferral cannot breach this** (§4.1).
- **I7 — Disk is reconcilable.** For any synced path, the daemon can recompute `RECONSTRUCT(currentEpoch)[p]` and overwrite disk; a crash never leaves disk as the only copy of acked state.
- **I8 — Epoch isolation.** An epoch-N peer can't inject ops into the epoch-N+1 room (docId mismatch rejected at the relay).
- **I9 — Source durability (new).** The edit hook returns success to the agent only after the op is fsync'd to the local WAL; the op stays in the outbox until relay-ack'd.
- **I10 — Capture-time scope (new).** No path failing the §6.5 inbound filter (ignore/secret/size) is ever journaled, broadcast, quarantined, or written to a durable object — scope is enforced before durability, not after.
- **I11 — Retention (new).** The op-journal retains every acked op whose effect is not yet dominated by a durable baseline `WT-Frontier`, regardless of epoch age or overlay-size targets; dominated ops are pruned behind a configurable recovery window.

### 10.2 Crash / failure recovery

| Scenario | What happened | Recovery |
|---|---|---|
| **A** | LC crash after Phase 1, before Phase 4 CAS | Orphan commit C (no pointer advance). Landing-intent record lets a re-run reproduce the same SHA and adopt via CAS (idempotent), else discard + re-land. No peer advanced → no loss. (I1, I3) |
| **B** | LC crash after CAS, before publish | Cloud truth already N+1; peers learn from the coordination store independently of the dead LC. Phase 5 re-runs from the landing-intent record deterministically. (I3) `[D-12]` |
| **C** | Relay restart / loss | Durable truth = git object store (baselines + op-journal, fsync'd) + epoch pointer in the strongly-consistent store, **separate from the relay**. Reload latest baseline; replay journal ops with clock > captured frontier; peers reconnect and delta-sync. (I2, I3) |
| **D** | Network partition | Minority edits locally (AP, local-WAL safe) but **cannot land** (lease + CAS need the quorum-side store) → no split-brain baseline. On heal: same epoch → delta-sync; landing happened → hard-re-baseline (replay un-acked ops by identity). (I1, I3) |
| **E** | Corrupted/forked local replica | Detect via docId mismatch / frontier-validation / reconstructed-tree-hash ≠ peers'. **Quarantine, don't merge.** Salvage = diff disk vs `RECONSTRUCT(epoch)`, replay diffs as fresh ops (conflict-mark overlaps), then re-clone + fresh doc. (I4, I8; I3 via salvage) |
| **F** | Daemon crash with ops in WAL/outbox | On restart, replay WAL into the local replica, retransmit outbox by identity (idempotent at relay). No local-ack'd edit is lost. (I9, I3) |
| **G** | External git op | Detected via §8 (after a strongly-consistent epoch read); treated as a baseline advance, not edits. (I1) |

### 10.3 Adversary-bait edge cases (explicitly handled)

- **Concurrent land of the same `fromEpoch`:** both build orphan commits; exactly one wins the Phase-4 CAS; loser discards its orphan and rebases residual onto the winner.
- **Op straddling the cut:** the downward-closed `CUT` snapshot guarantees an op is assigned to N only if its full causal history is ≤ CUT; an effect whose cause is residual can't land. (I2) `[D-55]`
- **Offline across two landings (N→N+1→N+2):** jump straight to N+2; replay un-acked ops **once** by identity, not N-step chained.
- **Zombie lease holder:** TTL + fence token; a paused-then-resumed LC fails the fenced CAS, can't double-publish.
- **Manual commit between publish and daemon fetch:** the daemon's mandatory strongly-consistent epoch read before reconciling closes the stale-anchor window. `[D-35]`
- **CI force-push racing a landing:** Phase-4 anchor tip re-read aborts the landing. `[D-37]`
- **Cross-OS path collision** (`README.md` vs `readme.md`; NFC vs NFD): tree-CRDT normalizes to NFC + detects case-fold collisions before commit → deterministic conflict-copy, never clobber.
- **Empty vs all-deferred landing:** computed after claim-deferral; truly-empty short-circuits before the lease; all-deferred still lands (I11). `[D-50]`
- **`index.lock` backoff vs a long user git op:** epoch swap doesn't require each daemon's disk projection; a locked-out daemon defers only its projection, overlay still bounded by the cloud. `[D-42]`

---

## 11. Threat scenarios → how the design handles them

| # | Failure class | Defense in this spec |
|---|---|---|
| 11, 45, 54 | Edit believed-saved lost on crash/relay-gap | I9 local WAL + outbox; hook returns only after local-ack; dual ack model (§1, §3) |
| 1–10 | Secret / ignored-file leakage | I10 capture-time inbound filter + secret deny-list + local-exclude ceiling + purge protocol (§6.5) |
| 22, 40 | Formatter-storm spurious conflicts | byte-identical absorb in live rebase; full S-matrix on REBASE-OVERLAY (§4.3 Ph5, §8.3) |
| 15, 28, 55 | Cut includes effect of residual cause | downward-closed `relay.durableFrontier()` snapshot (§4.3 Ph1) |
| 12, 37, 47 | Two-store baseline fork | orphan-commit + pointer CAS as sole linearization point + anchor tip re-read + landing-intent record (§4.3 Ph3–4) |
| 14, 49, 51 | Reconnect drops/double-applies ops | quarantine = all non-dominated ops; idempotent replay by op-identity (§7.2) |
| 48, 56 | Per-peer nodeId / conflict fork | deterministic minting; conflict objects immutable + content-addressed, disk is a render (§2.1, §4.3) |
| 46, 53 | Bypassed claim / divergent rename heuristic | claims on the CRDT write path; single-author structural ops; normalized-byte hashing (§3, §6.2) |
| 21,23,24,26,27,29,30,31,33 | Scale / unbounded growth | incremental tree build, byte-budget overlay, structure compaction, partial clone, journal pruning, out-of-band blobs, watcher-overflow reconcile |
| 17, 25, 35, 36, 42, 58 | Branch-switch strands/loses overlay | local-WAL + local `wt-stash`; never synchronous land; epoch read before reconcile (§8.4) |
| 39 | Slow atomic-save misclassified | pattern-based, time-window-independent detection (§6.2) |
| 13, 20, 50 | Claim-starvation / blob GC / false-empty | I11 retention; blob pinning by acked pointer; empty-vs-deferred distinction |
| 38 | Branch-tip vs baseline-chain skew | two static tracks: chain on `refs/wt/*`, human branch a promotion follower; adaptive cadence only (§8.5) |
| promo 38–44 | Promotion races (double-promote, echo loop, lost-update on HUMAN_REF, CI force-push, lag, FF/squash mix) | same landing lease; CAS HUMAN_REF on expected-old; distinct `wt-promotions` note namespace; yield manual commits to §8; CI/PR base on fine track (§8.5) |
| lease 1–37 | Adaptive-shard transition forks/loss/torn reads | deferred (§13): static single-writer + seam now; escalation blueprint records the global-cut-per-stitch + disjointness + freeze-all rules those attacks forced |
| 41 | Spoofed/stale WT-Epoch trailer | classify only by SHA-bound git note (§8.2) |
| 32 | Green-tests/landing deadlock | tests async vs landed SHAs; gate promotion, not landing (§4.1) |

---

## 12. Open decisions (genuinely unresolved — need a human call)

1. **Lease sharding vs single-writer — RESOLVED (v3, see §13).** Ship **static single-writer** as the resting state, add a one-field **`LaneMap` seam** + two cheap throughput wins (pipeline the critical section; runtime-tunable `B_max`/`T_max`), and build runtime escalation only when telemetry proves the lease binds. The full adaptive escalation blueprint and its hard preconditions are recorded in §13 as deferred work.
2. **Branch-tip model — RESOLVED (v3, see §8.5).** Two static tracks (fine = the chain on `refs/wt/*`; coarse = the human branch as a promotion follower) with an adaptive promotion *cadence*. The static defaults remain available as per-glob config.
3. **Hard-cut vs soft-cut.** Spec uses a non-blocking causal snapshot (soft). A hard sub-second quiesce gives a provably clean cut at the cost of a blip. *Acceptable to never block, or want an optional hard-cut for critical landings?*
4. **Trigger tuning** (`T_idle`/`T_max`/`B_max`): static config vs auto-tune to overlay growth + team size.
5. **Attribution policy** as a per-PR (not just per-repo) setting; whether `refs/notes/wt-attribution` is mandatory.
6. **"Too stale to FF" boundary** (overlay-snapshot GC'd / baseline force-pushed) → when to fall back to a full fresh clone.
7. **Rename similarity threshold** (default 50%) — per-glob configurable like the collision policy?
8. **Quarantine (`Q`) retention/GC** under `refs/working-together/quarantine/*`.
9. **Special files** (hardlinks, named pipes, sockets, device files) — current stance: refuse-and-warn; confirm that's acceptable.

---

## 13. Adaptive landing throughput (lease escalation) — DEFERRED, seam now

**Decision.** Ship **static single-writer** per `repo+branch` (the proven §4 design). Do **not** build runtime adaptive sharding yet — but design a clean seam so it can be added later as a config flip, and take two cheap throughput wins now. This is asymmetric with §8.5 on purpose: adaptive *promotion* rides an existing idempotent FF/squash with no new linearization point (cheap, reversible), whereas adaptive *sharding* introduces new linearization-path transitions (expensive, dangerous — see the caveats below).

### 13.1 Why single-writer doesn't bind (the load math)

Edits never block during landing (§4.3); the serializing resource is only the lease-held coordination sequence (lease CAS + intent write + anchor tip re-read + pointer CAS) — ~4–8 round-trips to the strongly-consistent store / git remote, ~150–400 ms with a co-located LC. That sustains **~2–4 landings/sec** on the serial path. But landing is debounced (`T_idle`, `T_max`, `B_max`) and batches the *whole room* into one commit, so a room emits at most roughly one landing every few seconds. To saturate single-writer you need sustained demand > ~4 landings/sec — i.e. **dozens of concurrently-writing agents on one branch with non-overlapping work.** And the product's own collision-avoidance layer (claims before writes) throttles same-branch contention *upstream* of the lease, so the bottleneck is gated before it binds. (A single **hot file** — the likely real contention shape given whole-file agent rewrites — *cannot* be lane-split anyway, which further weakens the case for sharding as the first investment.)

### 13.2 The two cheap wins (do these now)

1. **Pipeline the critical section.** Phase 2 (the O(changed) incremental tree build) runs against the *anchor* `B_N` as a loose orphan and only Phase 4 needs the lease + current tip — so build landing K+1's tree *while* K holds the lease. If K commits first, K+1's existing Phase-4 tip re-read (`[D-37]`) sees `tip ≠ B_N` and aborts/rebuilds. The speculation is validated by machinery already in the spec; worst case is wasted background CPU on a discarded orphan (cap in-flight speculation depth to 1–2). Free throughput, zero new invariants.
2. **Make `B_max`/`T_max` runtime-tunable** (open-decision #4). Bigger batches → fewer, fatter landings → fewer CAS sequences per unit of change → strictly less lease pressure. Cost is overlay memory (I6) and a slightly staler floor — both tunable, neither correctness.

### 13.3 The seam (build now, costs nothing)

Model the lease key and epoch pointer as a **`LaneMap { generation, lanes:[…] }`**, defaulting to `{ generation: 0, lanes: [ROOT] }` — a single lane over the whole tree. Phase 0 keys the lease `repo+branch+laneId` (always `ROOT`); Phase 4 CAS reads/writes `laneMap.generation` in the *same* conditional write (no second store, no second linearization point). With one lane this is byte-for-byte equivalent to today's single-writer CAS. Activating sharding later means a `splitLaneMap` op that bumps the generation in that same CAS — confined to a place already designed for it.

### 13.4 Telemetry gate (when to actually build escalation)

Instrument per room: `lease_wait` (eligible → lease-acquired) and `landing_build_time` (Phase 2 duration). **Build sharding only if `lease_wait_p99 > landing_build_time_p50` sustained** (e.g. > 5 min) on a real room — i.e. landings demonstrably queue on the *lease*, not on their own O(changed) work. Until that fires in production, sharding solves a hypothetical.

### 13.5 Escalation blueprint (deferred — the design for *when* it binds)

If the gate fires, the adaptive scheme below is the blueprint. It was designed and adversarially stress-tested (41 transition-moment scenarios surfaced); the **hard rules** below are the ones those attacks forced, and skipping any of them reintroduces a fork/loss the base spec killed.

- **Composite pointer = a META-EPOCH over lanes.** The coordination tuple becomes `{ metaEpoch, baselineSHA, docId, laneMapGen, lanes[…], rootFence }`. `baselineSHA`/`docId` stay **whole-repo and singular at all times.** A lane never owns a pointer — it holds an **IX intent on the root** and only *prepares* a subtree SHA (a loose object). The whole-repo baseline advances by **one root CAS** that 2PC-stitches prepared lane subtrees + unchanged subtrees into one root tree (Spanner-style prepare/commit). This is the *only* mutating pointer write — so I1's single linearization point survives. (Independent per-lane `baselineSHA`s are **rejected** — that is exactly the two-store fork Phase-4 killed.)
- **Every transition behaves like a real landing.** Split and merge each capture a **real downward-closed cut** (`relay.durableFrontier()`), install `C0` as a **real orphan commit whose parent == `B_N`**, and re-read the anchor tip before their CAS. No transition may strand ops written between materialize and CAS.
- **The killer caveat (erodes the benefit):** cross-lane *causal* edges exist even when lanes are nodeId-disjoint, so **every stitch needs ONE global downward-closed cut across all lane rooms**, not independent per-lane cuts — otherwise the stitched baseline is non-causally-closed (I2 violation a reader inherits). Net: escalation is **"parallel materialize + claim-locality, serial commit"** — lanes parallelize the *build* and reduce *claim* contention, but the linearizing CAS is still global. Size the expected win accordingly.
- **Disjointness is a hard precondition, not a heuristic** (Gray/HBase): lanes are disjoint **and non-ancestor** subtrees by nodeId (no lane root is an ancestor of another; the shared ancestor dir chain to ROOT belongs to no lane). Re-validate disjointness **at the cut**, not just at carve time. If no clean carve exists (straddling op in flight, hot file, ambiguous boundary) → **graceful-degrade to single-writer**, with *negative hysteresis* (a split-suppressed cooldown) so a broad/hot workload doesn't livelock retrying.
- **Merge = freeze-all-lanes first.** Bump `laneMapGen` to a MERGING generation via one root CAS *before* any lane drains; lane "final landings" then only prepare subtree SHAs + record residual into one **global** `F_merge` cut; one merge CAS collapses to single-writer. All collapse initiators (load-driven de-escalation *and* a cross-cutting `root-X`) serialize through that one freeze token. Raft-joint-style overlapping quorum + per-ref CAS (not blind FF) kills zombie-lane LCs.
- **Cross-cutting changes drain to single-writer.** A change spanning lanes requests `root-X` (incompatible with lane-IX), pre-declaring its full lane set (conservative 2PL, deadlock-free); it forces a merge, lands atomically, then optionally re-splits. A **cross-cutting-required** merge **bypasses the predictive-merge guard** (else it can livelock behind sustained load). Straddling renames route to one deterministic authority or escalate.
- **Readers only ever read the strongly-consistent composite pointer's last stitched meta-epoch baseline.** No live multi-lane subscription (that read is torn). Reads are `laneMapGen`-validated at both ends (optimistic, gen as version stamp). CI/RECONSTRUCT resolve the baseline from the coordination-store pointer, never the best-effort follower ref.
- **Hysteresis** measures escalation pressure from **layout-invariant** quantities (overlay byte-arrival rate, distinct-nodeId edit rate at the relay frontier) — *not* lease-queue depth or landing latency, which the split itself perturbs (cost-amplification feedback). Dual asymmetric thresholds (`T_split ≫ T_merge`), split eagerly / merge reluctantly, per-layout cooldown `D_dwell`, predictive merge-guard with a force-merge escape when `B_max` is breached (I6 wins). All thresholds are coordination-store policy values.

---

*Provenance: synthesized by a multi-agent workflow (4 prior-art researchers → 8 dimension designers → synthesis → 6 adversarial skeptics surfacing 57 scenarios), hardened in v2 against the 46 critical/high findings. §8.5 and §13 added in v3 from a second workflow (3 researchers → adaptive-lease / adaptive-branch-tip / complexity-skeptic designs → 5 transition-moment skeptics surfacing 41 scenarios). Tags `[D-n]` map mechanisms to the specific scenario they defeat.*

