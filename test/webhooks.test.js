"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { createWebhookDispatcher } = require("../lib/webhooks");

const conversation = { id: "conv_1", channel: "whatsapp", address: "whatsapp:+5491111111111" };
const message = {
  id: "msg_1",
  conversationId: "conv_1",
  seq: 7,
  direction: "in",
  externalId: "WA-PROVIDER-ID",
  author: "whatsapp:+5491111111111",
  text: "hola",
  mediaId: null,
  replyTo: null,
  status: "received",
  at: "2026-01-01T00:00:00.000Z",
};

function subscription(id, principalId, url = `http://agent/${id}`) {
  return { id, principalId, url, secret: `whsec_${id}`, createdAt: "2026-01-01T00:00:00.000Z" };
}

/** fetch stand-in: `responses` is consumed per call (status number, "throw", or "hang"). */
function fakeFetch(responses = []) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length ? responses.shift() : 200;
    if (next === "throw") throw new Error("ECONNREFUSED");
    if (next === "hang") {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    }
    return { ok: next >= 200 && next < 300, status: next };
  };
  fn.calls = calls;
  return fn;
}

function setup({ subs, canSee = () => true, responses, retryDelaysMs = [5, 10], timeoutMs = 1000 } = {}) {
  const fetch = fakeFetch(responses);
  const logs = [];
  const logger = {
    info: (obj, msg) => logs.push({ level: "info", obj, msg }),
    warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
  };
  const dispatcher = createWebhookDispatcher({
    subscriptions: { active: () => subs },
    canSee,
    fetch,
    logger,
    retryDelaysMs,
    timeoutMs,
  });
  return { dispatcher, fetch, logs };
}

test("delivers a new message to every subscriber that can see the conversation", async () => {
  const { dispatcher, fetch } = setup({
    subs: [subscription("a", "prn_a"), subscription("b", "prn_b")],
    canSee: (principalId) => principalId === "prn_a",
  });
  await dispatcher.dispatch({ conversation, message, outcome: "created" });

  assert.deepEqual(fetch.calls.map((c) => c.url), ["http://agent/a"]);
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.event, "message.created");
  assert.match(body.deliveryId, /^dlv_[0-9a-f]{16}$/);
  assert.deepEqual(body.conversation, conversation);
  assert.deepEqual(body.message, {
    id: "msg_1",
    seq: 7,
    direction: "in",
    author: "whatsapp:+5491111111111",
    text: "hola",
    status: "received",
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(fetch.calls[0].init.body.includes("WA-PROVIDER-ID"), false, "provider ids stay inside");
});

test("a completed undecryptable message is delivered as message.updated; a duplicate is not delivered", async () => {
  const { dispatcher, fetch } = setup({ subs: [subscription("a", "prn_a")] });
  await dispatcher.dispatch({ conversation, message, outcome: "completed" });
  await dispatcher.dispatch({ conversation, message, outcome: "duplicate" });
  assert.equal(fetch.calls.length, 1);
  assert.equal(JSON.parse(fetch.calls[0].init.body).event, "message.updated");
});

test("every delivery is signed with HMAC-SHA256 over timestamp and body", async () => {
  const sub = subscription("a", "prn_a");
  const { dispatcher, fetch } = setup({ subs: [sub] });
  await dispatcher.dispatch({ conversation, message, outcome: "created" });

  const { headers, body, method } = fetch.calls[0].init;
  assert.equal(method, "POST");
  assert.equal(headers["content-type"], "application/json");
  const timestamp = headers["x-webhook-timestamp"];
  assert.match(timestamp, /^\d+$/);
  assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 5);
  const expected = crypto.createHmac("sha256", sub.secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(headers["x-webhook-signature"], `sha256=${expected}`);
  assert.equal(headers["x-webhook-id"], JSON.parse(body).deliveryId);
});

test("retries a failed delivery with the same deliveryId, and stops at the first success", async () => {
  const { dispatcher, fetch } = setup({
    subs: [subscription("a", "prn_a")],
    responses: [500, "throw", 200],
  });
  await dispatcher.dispatch({ conversation, message, outcome: "created" });

  assert.equal(fetch.calls.length, 3);
  const ids = fetch.calls.map((c) => JSON.parse(c.init.body).deliveryId);
  assert.equal(new Set(ids).size, 1, "a retry is the same delivery, so the consumer can dedup");
});

test("gives up after the bounded retries and logs it without the message text", async () => {
  const { dispatcher, fetch, logs } = setup({
    subs: [subscription("a", "prn_a")],
    responses: [500, 500, 500, 500],
  });
  await dispatcher.dispatch({ conversation, message, outcome: "created" });

  assert.equal(fetch.calls.length, 3, "one attempt plus two retries");
  const warn = logs.find((l) => l.level === "warn");
  assert.ok(warn, "abandoning a delivery is logged");
  assert.equal(warn.obj.subscriptionId, "a");
  assert.equal(warn.obj.messageId, "msg_1");
  assert.equal(JSON.stringify(logs).includes("hola"), false);
});

test("an endpoint that hangs is timed out and retried", async () => {
  const { dispatcher, fetch } = setup({
    subs: [subscription("a", "prn_a")],
    responses: ["hang", 200],
    timeoutMs: 30,
  });
  await dispatcher.dispatch({ conversation, message, outcome: "created" });
  assert.equal(fetch.calls.length, 2);
});

test("one failing subscriber does not delay or block another", async () => {
  const { dispatcher, fetch } = setup({
    subs: [subscription("slow", "prn_a"), subscription("ok", "prn_b")],
    responses: [500, 200, 200],
    retryDelaysMs: [50],
  });
  await dispatcher.dispatch({ conversation, message, outcome: "created" });
  assert.deepEqual(fetch.calls.map((c) => c.url).slice(0, 2).sort(), ["http://agent/ok", "http://agent/slow"]);
});

test("visibility is checked per subscription with the conversation id", async () => {
  const seen = [];
  const { dispatcher } = setup({
    subs: [subscription("a", "prn_a")],
    canSee: (principalId, conversationId) => {
      seen.push([principalId, conversationId]);
      return false;
    },
  });
  await dispatcher.dispatch({ conversation, message, outcome: "created" });
  assert.deepEqual(seen, [["prn_a", "conv_1"]]);
});
