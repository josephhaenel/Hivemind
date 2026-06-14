import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinationStore } from "./store.js";

function mkReq(store: CoordinationStore, over: Partial<Parameters<CoordinationStore["claim"]>[0]> = {}) {
  const repo = over.repo ?? "demo";
  const path = over.path ?? "src/app.ts";
  const r = store.resolveRegion(repo, path, over.regionId ? undefined : undefined);
  return {
    repo,
    regionId: r.regionId,
    anchor: r.anchor,
    grain: r.grain,
    path,
    actorId: "A",
    origin: "agent" as const,
    mode: "exclusive" as const,
    intent: "edit",
    requestId: Math.random().toString(36).slice(2),
    ...over,
  };
}

test("first claim is granted with a fence", () => {
  const s = new CoordinationStore();
  const o = s.claim(mkReq(s));
  assert.equal(o.result, "GRANTED");
  if (o.result === "GRANTED") assert.ok(o.claim.fence > 0);
});

test("agent-vs-agent on the same region is BLOCKED", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A" }));
  const o = s.claim(mkReq(s, { actorId: "B" }));
  assert.equal(o.result, "BLOCKED");
  if (o.result === "BLOCKED") {
    assert.equal(o.error.code, "REGION_CLAIMED");
    assert.equal(o.error.class, "BLOCKED_RETRYABLE");
    assert.equal(o.error.holder, "A");
  }
});

test("human involved -> WARN_PROCEED, not blocked", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A", origin: "agent" }));
  const o = s.claim(mkReq(s, { actorId: "H", origin: "human" }));
  assert.equal(o.result, "WARN_PROCEED");
});

test("disjoint regions don't collide", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A", path: "src/a.ts" }));
  const o = s.claim(mkReq(s, { actorId: "B", path: "src/b.ts" }));
  assert.equal(o.result, "GRANTED");
});

test("fence is monotonic across regions (one global domain)", () => {
  const s = new CoordinationStore();
  const o1 = s.claim(mkReq(s, { actorId: "A", path: "src/a.ts" }));
  const o2 = s.claim(mkReq(s, { actorId: "B", path: "src/b.ts" }));
  assert.ok(o1.result === "GRANTED" && o2.result === "GRANTED");
  if (o1.result === "GRANTED" && o2.result === "GRANTED") assert.ok(o2.claim.fence > o1.claim.fence);
});

test("release frees the region for another actor; stale fence rejected", () => {
  const s = new CoordinationStore();
  const o = s.claim(mkReq(s, { actorId: "A" }));
  assert.equal(o.result, "GRANTED");
  if (o.result !== "GRANTED") return;
  const bad = s.release(o.claim.claimId, o.claim.fence + 999);
  assert.equal(bad.ok, false);
  const good = s.release(o.claim.claimId, o.claim.fence);
  assert.equal(good.ok, true);
  const o2 = s.claim(mkReq(s, { actorId: "B" }));
  assert.equal(o2.result, "GRANTED");
});

test("reentrant claim by same actor returns same fence", () => {
  const s = new CoordinationStore();
  const o1 = s.claim(mkReq(s, { actorId: "A" }));
  const o2 = s.claim(mkReq(s, { actorId: "A" }));
  assert.ok(o1.result === "GRANTED" && o2.result === "GRANTED");
  if (o1.result === "GRANTED" && o2.result === "GRANTED") assert.equal(o1.claim.fence, o2.claim.fence);
});

test("idempotent claim: same request_id replays the same outcome", () => {
  const s = new CoordinationStore();
  const req = mkReq(s, { actorId: "A" });
  const o1 = s.claim(req);
  const o2 = s.claim(req);
  assert.deepEqual(o1, o2);
});

test("heartbeat without progress does NOT extend; with progress does", () => {
  const s = new CoordinationStore();
  const o = s.claim(mkReq(s, { actorId: "A", progressToken: 1 }));
  assert.equal(o.result, "GRANTED");
  if (o.result !== "GRANTED") return;
  const noProg = s.heartbeat(o.claim.claimId, o.claim.fence, 1); // not advanced
  assert.ok(noProg.ok && noProg.value.extended === false);
  const prog = s.heartbeat(o.claim.claimId, o.claim.fence, 2); // advanced
  assert.ok(prog.ok && prog.value.extended === true);
});

test("decisions: supersede chain hides the old head", () => {
  const s = new CoordinationStore();
  const d1 = s.postDecision({
    repo: "demo",
    scope: { level: "repo" },
    kind: "convention",
    title: "use tabs",
    body: "...",
    author: "A",
    authorKind: "agent",
    requestId: "r1",
  });
  assert.ok(d1.ok);
  if (!d1.ok) return;
  const d2 = s.postDecision({
    repo: "demo",
    scope: { level: "repo" },
    kind: "convention",
    title: "use spaces",
    body: "...",
    author: "A",
    authorKind: "agent",
    supersedes: d1.value.decisionId,
    requestId: "r2",
  });
  assert.ok(d2.ok);
  const heads = s.getDecisions("demo", { level: "repo" }, false);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].title, "use spaces");
});

test("enforceRegistration: unregistered agent fails closed on enforcing region", () => {
  const s = new CoordinationStore({ enforceRegistration: true });
  const o = s.claim(mkReq(s, { actorId: "ghost", origin: "agent" }));
  assert.equal(o.result, "ERROR");
  if (o.result === "ERROR") assert.equal(o.error.code, "UNREGISTERED_ACTOR");
});
