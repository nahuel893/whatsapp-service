"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createJobStore } = require("../lib/job-store");

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-job-store-"));
  store = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createJobStore", () => {
  test("creates the database file and its parent directory", () => {
    const nested = path.join(tmpDir, "deep", "nested", "queue.db");
    const s = createJobStore({ dbPath: nested });
    assert.ok(fs.existsSync(nested));
    s.close();
  });

  test("enqueue returns an incrementing numeric id", () => {
    const a = store.enqueue({ type: "text", target: "5491111@s.whatsapp.net", payload: { text: "a" } });
    const b = store.enqueue({ type: "text", target: "5491111@s.whatsapp.net", payload: { text: "b" } });
    assert.equal(typeof a.id, "number");
    assert.equal(b.id, a.id + 1);
  });

  test("enqueue persists the payload and marks the job pending", () => {
    const { id } = store.enqueue({ type: "text", target: "t", payload: { text: "hola" } });
    const job = store.get(id);
    assert.equal(job.status, "pending");
    assert.equal(job.type, "text");
    assert.equal(job.target, "t");
    assert.deepEqual(job.payload, { text: "hola" });
    assert.equal(job.error, null);
  });

  test("enqueue round-trips a media buffer byte for byte", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const { id } = store.enqueue({
      type: "image",
      target: "t",
      payload: { caption: "c" },
      media: { buffer: bytes, name: "chart.png", mimetype: "image/png" },
    });
    const job = store.get(id);
    assert.ok(Buffer.isBuffer(job.media.buffer));
    assert.deepEqual(job.media.buffer, bytes);
    assert.equal(job.media.name, "chart.png");
    assert.equal(job.media.mimetype, "image/png");
  });

  test("get returns null for an unknown id", () => {
    assert.equal(store.get(9999), null);
  });

  test("claimNext returns jobs in FIFO order and marks them processing", () => {
    const first = store.enqueue({ type: "text", target: "t", payload: { text: "1" } });
    store.enqueue({ type: "text", target: "t", payload: { text: "2" } });

    const claimed = store.claimNext();
    assert.equal(claimed.id, first.id);
    assert.equal(store.get(first.id).status, "processing");
  });

  test("claimNext skips jobs already processing", () => {
    store.enqueue({ type: "text", target: "t", payload: { text: "1" } });
    const second = store.enqueue({ type: "text", target: "t", payload: { text: "2" } });

    store.claimNext();
    assert.equal(store.claimNext().id, second.id);
    assert.equal(store.claimNext(), null);
  });

  test("markSent and markError are terminal and record the error text", () => {
    const a = store.enqueue({ type: "text", target: "t", payload: {} });
    const b = store.enqueue({ type: "text", target: "t", payload: {} });
    store.claimNext();
    store.claimNext();

    store.markSent(a.id);
    store.markError(b.id, new Error("boom"));

    assert.equal(store.get(a.id).status, "sent");
    assert.equal(store.get(a.id).error, null);
    assert.ok(store.get(a.id).finishedAt);
    assert.equal(store.get(b.id).status, "error");
    assert.equal(store.get(b.id).error, "boom");
  });

  test("markSent drops the media blob so the database does not grow unbounded", () => {
    const { id } = store.enqueue({
      type: "file",
      target: "t",
      payload: {},
      media: { buffer: Buffer.alloc(1024, 7), name: "r.xlsx", mimetype: "application/x" },
    });
    store.claimNext();
    store.markSent(id);
    assert.equal(store.get(id).media, null);
  });

  test("pendingCount counts only jobs still waiting", () => {
    store.enqueue({ type: "text", target: "t", payload: {} });
    store.enqueue({ type: "text", target: "t", payload: {} });
    assert.equal(store.pendingCount(), 2);
    store.claimNext();
    assert.equal(store.pendingCount(), 1);
  });

  test("recent lists finished jobs newest first, capped by limit", () => {
    for (let i = 0; i < 5; i += 1) {
      const { id } = store.enqueue({ type: "text", target: `t${i}`, payload: {} });
      store.claimNext();
      store.markSent(id);
    }
    const recent = store.recent(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].target, "t4");
    assert.deepEqual(Object.keys(recent[0]).sort(), ["error", "finishedAt", "id", "status", "target", "type"]);
  });

  // ── The whole point of persisting: surviving a restart ──────────────
  test("a pending job survives reopening the database", () => {
    const dbPath = path.join(tmpDir, "restart.db");
    const first = createJobStore({ dbPath });
    const { id } = first.enqueue({ type: "text", target: "t", payload: { text: "survive" } });
    first.close();

    const second = createJobStore({ dbPath });
    const job = second.get(id);
    assert.equal(job.status, "pending");
    assert.deepEqual(job.payload, { text: "survive" });
    second.close();
  });

  test("recoverInterrupted returns jobs left processing by a crash back to pending", () => {
    const dbPath = path.join(tmpDir, "crash.db");
    const first = createJobStore({ dbPath });
    const { id } = first.enqueue({ type: "text", target: "t", payload: {} });
    first.claimNext();
    first.close(); // simulates a crash mid-flight

    const second = createJobStore({ dbPath });
    assert.equal(second.recoverInterrupted(), 1);
    assert.equal(second.get(id).status, "pending");
    assert.equal(second.pendingCount(), 1);
    second.close();
  });

  test("prune deletes finished jobs older than the retention window", () => {
    const { id } = store.enqueue({ type: "text", target: "t", payload: {} });
    store.claimNext();
    store.markSent(id);
    assert.equal(store.prune(30), 0, "a job finished now must not be pruned");
    assert.equal(store.prune(0), 1);
    assert.equal(store.get(id), null);
  });

  test("prune never deletes pending jobs", () => {
    store.enqueue({ type: "text", target: "t", payload: {} });
    assert.equal(store.prune(0), 0);
    assert.equal(store.pendingCount(), 1);
  });
});
