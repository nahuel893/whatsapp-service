"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createJobStore } = require("../lib/job-store");
const { createMessageQueue } = require("../lib/message-queue");

let tmpDir;
let store;
let queue;

function newQueue(options = {}) {
  return createMessageQueue({ store, minDelayMs: 0, maxDelayMs: 0, ...options });
}

/** Resolves once the queue has no pending jobs and is not processing. */
function drained(q) {
  return new Promise((resolve) => {
    const tick = () => {
      const status = q.getStatus();
      if (status.pending === 0 && !status.processing) return resolve();
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-queue-"));
  store = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createMessageQueue", () => {
  test("runs the handler registered for the job type with its payload", async () => {
    const seen = [];
    queue = newQueue();
    queue.registerHandler("text", async (job) => {
      seen.push({ target: job.target, payload: job.payload });
    });

    queue.enqueue({ type: "text", target: "t", payload: { text: "hola" } });
    await drained(queue);

    assert.deepEqual(seen, [{ target: "t", payload: { text: "hola" } }]);
  });

  test("hands the media buffer to the handler intact", async () => {
    const bytes = Buffer.from([1, 2, 3, 250]);
    let received = null;
    queue = newQueue();
    queue.registerHandler("file", async (job) => {
      received = job.media;
    });

    queue.enqueue({
      type: "file",
      target: "t",
      payload: {},
      media: { buffer: bytes, name: "r.xlsx", mimetype: "application/x" },
    });
    await drained(queue);

    assert.deepEqual(received.buffer, bytes);
    assert.equal(received.name, "r.xlsx");
  });

  test("processes jobs one at a time, in order", async () => {
    const order = [];
    let inFlight = 0;
    queue = newQueue();
    queue.registerHandler("text", async (job) => {
      inFlight += 1;
      assert.equal(inFlight, 1, "two jobs ran concurrently");
      await new Promise((r) => setTimeout(r, 5));
      order.push(job.payload.text);
      inFlight -= 1;
    });

    queue.enqueue({ type: "text", target: "t", payload: { text: "1" } });
    queue.enqueue({ type: "text", target: "t", payload: { text: "2" } });
    queue.enqueue({ type: "text", target: "t", payload: { text: "3" } });
    await drained(queue);

    assert.deepEqual(order, ["1", "2", "3"]);
  });

  test("marks the job sent once the handler resolves", async () => {
    queue = newQueue();
    queue.registerHandler("text", async () => {});
    const job = queue.enqueue({ type: "text", target: "t", payload: {} });
    await drained(queue);
    assert.equal(queue.getJob(job.id).status, "sent");
  });

  test("a failing handler marks that job error and does not stall the queue", async () => {
    queue = newQueue();
    queue.registerHandler("text", async (job) => {
      if (job.payload.text === "bad") throw new Error("send failed");
    });

    const bad = queue.enqueue({ type: "text", target: "t", payload: { text: "bad" } });
    const good = queue.enqueue({ type: "text", target: "t", payload: { text: "good" } });
    await drained(queue);

    assert.equal(queue.getJob(bad.id).status, "error");
    assert.equal(queue.getJob(bad.id).error, "send failed");
    assert.equal(queue.getJob(good.id).status, "sent");
  });

  test("a job whose type has no handler fails instead of blocking forever", async () => {
    queue = newQueue();
    const job = queue.enqueue({ type: "unknown", target: "t", payload: {} });
    await drained(queue);
    const stored = queue.getJob(job.id);
    assert.equal(stored.status, "error");
    assert.match(stored.error, /handler/i);
  });

  test("getStatus keeps the shape existing consumers already poll", async () => {
    queue = newQueue({ minDelayMs: 10, maxDelayMs: 20 });
    queue.registerHandler("text", async () => {});
    queue.enqueue({ type: "text", target: "t", payload: {} });
    await drained(queue);

    const status = queue.getStatus();
    assert.deepEqual(
      Object.keys(status).sort(),
      ["maxDelayMs", "minDelayMs", "pending", "processing", "recent"]
    );
    assert.equal(status.minDelayMs, 10);
    assert.equal(status.maxDelayMs, 20);
    assert.equal(status.recent[0].status, "sent");
  });

  test("getJob returns null for an unknown id", () => {
    queue = newQueue();
    assert.equal(queue.getJob(4242), null);
  });

  // ── The reason this module was rewritten ────────────────────────────
  test("start() drains jobs that were enqueued before a restart", async () => {
    const dbPath = path.join(tmpDir, "restart.db");
    const before = createJobStore({ dbPath });
    const pending = before.enqueue({ type: "text", target: "t", payload: { text: "queued" } });
    before.claimNext(); // left mid-flight, as a crash would
    before.close();

    const after = createJobStore({ dbPath });
    const revived = createMessageQueue({ store: after, minDelayMs: 0, maxDelayMs: 0 });
    const sent = [];
    revived.registerHandler("text", async (job) => sent.push(job.payload.text));

    revived.start();
    await drained(revived);

    assert.deepEqual(sent, ["queued"]);
    assert.equal(revived.getJob(pending.id).status, "sent");
    after.close();
  });

  test("waits the configured delay before each send", async () => {
    queue = newQueue({ minDelayMs: 40, maxDelayMs: 40 });
    let ranAt = null;
    const enqueuedAt = Date.now();
    queue.registerHandler("text", async () => {
      ranAt = Date.now();
    });
    queue.enqueue({ type: "text", target: "t", payload: {} });
    await drained(queue);
    assert.ok(ranAt - enqueuedAt >= 35, `sent after ${ranAt - enqueuedAt}ms, expected >= 35ms`);
  });
});
