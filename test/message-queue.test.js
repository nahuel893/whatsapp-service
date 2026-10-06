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

describe("lanes", () => {
  function recordSends(q) {
    const sends = [];
    q.registerHandler("text", async (job) => sends.push({ lane: "bulk", target: job.target, at: Date.now() }));
    q.registerHandler("chat", async (job) => sends.push({ lane: "conversation", target: job.target, at: Date.now() }));
    return sends;
  }

  test("a reply jumps ahead of a bulk job that is still waiting its delay", async () => {
    queue = newQueue({ minDelayMs: 400, maxDelayMs: 400, conversationMinDelayMs: 0, conversationMaxDelayMs: 0 });
    const sends = recordSends(queue);
    const start = Date.now();

    queue.enqueue({ type: "text", target: "informe", payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    queue.enqueue({ type: "chat", target: "cliente", payload: {}, lane: "conversation" });
    await drained(queue);

    assert.deepEqual(sends.map((s) => s.target), ["cliente", "informe"]);
    assert.ok(sends[0].at - start < 200, `reply waited ${sends[0].at - start}ms behind the bulk delay`);
  });

  test("after a reply, the bulk job waits its full delay again", async () => {
    queue = newQueue({ minDelayMs: 300, maxDelayMs: 300, conversationMinDelayMs: 0, conversationMaxDelayMs: 0 });
    const sends = recordSends(queue);

    queue.enqueue({ type: "text", target: "informe", payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    queue.enqueue({ type: "chat", target: "cliente", payload: {}, lane: "conversation" });
    await drained(queue);

    const gap = sends[1].at - sends[0].at;
    assert.ok(gap >= 280, `bulk went out only ${gap}ms after the reply`);
  });

  test("consecutive replies keep the conversation floor between them", async () => {
    queue = newQueue({ conversationMinDelayMs: 120, conversationMaxDelayMs: 120 });
    const sends = recordSends(queue);

    queue.enqueue({ type: "chat", target: "a", payload: {}, lane: "conversation" });
    queue.enqueue({ type: "chat", target: "b", payload: {}, lane: "conversation" });
    await drained(queue);

    const gap = sends[1].at - sends[0].at;
    assert.ok(gap >= 110, `replies only ${gap}ms apart`);
  });

  test("a reply after a quiet period goes out without an extra wait", async () => {
    queue = newQueue({ conversationMinDelayMs: 300, conversationMaxDelayMs: 300 });
    const sends = recordSends(queue);
    const start = Date.now();

    queue.enqueue({ type: "chat", target: "a", payload: {}, lane: "conversation" });
    await drained(queue);
    assert.ok(sends[0].at - start < 100, `first reply waited ${sends[0].at - start}ms`);
  });

  test("a job waiting its delay is still pending, so a crash then does not mark it processing", async () => {
    queue = newQueue({ minDelayMs: 300, maxDelayMs: 300 });
    recordSends(queue);
    const { id } = queue.enqueue({ type: "text", target: "t", payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(queue.getJob(id).status, "pending");
    await drained(queue);
    assert.equal(queue.getJob(id).status, "sent");
  });

  test("getStatus keeps its frozen shape with lanes in play", () => {
    queue = newQueue();
    assert.deepEqual(Object.keys(queue.getStatus()).sort(), [
      "maxDelayMs",
      "minDelayMs",
      "pending",
      "processing",
      "recent",
    ]);
  });
});
