/*
 * F4 — reading conversations: listing with unread counts, cursor reads with a
 * server-side read marker, 404 for conversations not granted, and declared
 * retention gaps.
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ADMIN, startChatApp } = require("./helpers/chat-app");

let counter = 0;

/** An app with one agent granted one conversation holding `count` inbound messages. */
async function setup(t, { count = 3 } = {}) {
  const app = await startChatApp();
  t.after(app.close);

  const { principal, key } = app.principals.create({ name: "agente" });
  const conv = app.conversations.resolveConversation("whatsapp:+5490000000000");
  app.principals.grant(principal.id, conv.id);
  for (let i = 1; i <= count; i++) receive(app, conv.address, `m${i}`);

  const other = app.conversations.resolveConversation("whatsapp:+5491111111111");
  receive(app, other.address, "ajeno");

  return { app, key, principal, conv, other };
}

function receive(app, address, text, extra = {}) {
  return app.conversations.recordInbound({
    externalId: `ext-${++counter}`,
    address,
    author: address,
    text,
    status: "received",
    at: new Date().toISOString(),
    ...extra,
  });
}

describe("GET /conversations", () => {
  test("an agent lists only its granted conversations, with unread counts", async (t) => {
    const { app, key, conv } = await setup(t);

    const res = await app.call("GET", "/conversations", { key });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.conversations.length, 1);

    const [c] = res.body.conversations;
    assert.deepEqual(Object.keys(c).sort(), [
      "address",
      "channel",
      "createdAt",
      "id",
      "lastMessageAt",
      "lastSeq",
      "readSeq",
      "unread",
    ]);
    assert.deepEqual([c.id, c.lastSeq, c.readSeq, c.unread], [conv.id, 3, 0, 3]);
  });

  test("the admin key lists every conversation", async (t) => {
    const { app } = await setup(t);
    const res = await app.call("GET", "/conversations", { key: ADMIN });
    assert.equal(res.body.conversations.length, 2);
  });
});

describe("GET /conversations/:id", () => {
  test("returns a granted conversation", async (t) => {
    const { app, key, conv } = await setup(t);
    const res = await app.call("GET", `/conversations/${conv.id}`, { key });
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.id, conv.id);
  });

  test("a conversation without grant is 404, indistinguishable from a missing one", async (t) => {
    const { app, key, other } = await setup(t);
    const notGranted = await app.call("GET", `/conversations/${other.id}`, { key });
    const missing = await app.call("GET", "/conversations/conv_0000000000000000", { key });
    assert.deepEqual(notGranted, { status: 404, body: { ok: false, error: "not_found" } });
    assert.deepEqual(missing, notGranted);
  });
});

describe("GET /conversations/:id/messages", () => {
  test("returns messages in public shape, oldest first, with the next cursor", async (t) => {
    const { app, key, conv } = await setup(t);
    const res = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.next, 3);
    assert.equal(res.body.gap, null);
    assert.deepEqual(res.body.messages.map((m) => m.text), ["m1", "m2", "m3"]);
    for (const m of res.body.messages) {
      assert.deepEqual(Object.keys(m).sort(), ["at", "author", "direction", "id", "seq", "status", "text"]);
    }
  });

  test("since and limit page through the conversation", async (t) => {
    const { app, key, conv } = await setup(t, { count: 5 });
    const page = await app.call("GET", `/conversations/${conv.id}/messages?since=1&limit=2`, { key });
    assert.deepEqual(page.body.messages.map((m) => m.seq), [2, 3]);
    assert.equal(page.body.next, 3);
  });

  test("without since it reads from the principal's read marker", async (t) => {
    const { app, key, conv } = await setup(t);
    await app.call("POST", `/conversations/${conv.id}/read`, { key, body: { seq: 2 } });

    const res = await app.call("GET", `/conversations/${conv.id}/messages`, { key });
    assert.deepEqual(res.body.messages.map((m) => m.seq), [3]);
  });

  test("an undecryptable message is visible as such, without text", async (t) => {
    const { app, key, conv } = await setup(t, { count: 0 });
    receive(app, conv.address, null, { status: "undecryptable" });
    const res = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });
    assert.deepEqual([res.body.messages[0].status, res.body.messages[0].text], ["undecryptable", null]);
  });

  test("a purged range is declared as a gap", async (t) => {
    const { app, key, conv } = await setup(t, { count: 0 });
    receive(app, conv.address, "viejo", { at: "2020-01-01T00:00:00.000Z" });
    receive(app, conv.address, "viejo", { at: "2020-01-01T00:00:00.000Z" });
    receive(app, conv.address, "nuevo");
    app.conversations.prune(30);

    const res = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });
    assert.deepEqual(res.body.gap, { from: 1, to: 2, reason: "retention" });
    assert.deepEqual(res.body.messages.map((m) => m.text), ["nuevo"]);
  });

  test("rejects a malformed since or limit with 400", async (t) => {
    const { app, key, conv } = await setup(t);
    for (const query of ["since=-1", "since=abc", "since=1.5", "limit=0", "limit=501", "limit=x"]) {
      const res = await app.call("GET", `/conversations/${conv.id}/messages?${query}`, { key });
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error, "invalid_request", query);
    }
  });

  test("is 404 for a conversation without grant", async (t) => {
    const { app, key, other } = await setup(t);
    const res = await app.call("GET", `/conversations/${other.id}/messages`, { key });
    assert.equal(res.status, 404);
  });

  test("a revoked grant stops access immediately", async (t) => {
    const { app, key, principal, conv } = await setup(t);
    app.principals.revokeGrant(principal.id, conv.id);
    const res = await app.call("GET", `/conversations/${conv.id}/messages`, { key });
    assert.equal(res.status, 404);
  });
});

describe("POST /conversations/:id/read", () => {
  test("advances the marker, never rewinds it, and updates unread", async (t) => {
    const { app, key, conv } = await setup(t);

    const first = await app.call("POST", `/conversations/${conv.id}/read`, { key, body: { seq: 2 } });
    assert.deepEqual(first, { status: 200, body: { ok: true, readSeq: 2 } });
    const back = await app.call("POST", `/conversations/${conv.id}/read`, { key, body: { seq: 1 } });
    assert.equal(back.body.readSeq, 2);

    const list = await app.call("GET", "/conversations", { key });
    assert.deepEqual([list.body.conversations[0].readSeq, list.body.conversations[0].unread], [2, 1]);
  });

  test("rejects a seq that is not a non-negative integer or is past the last message", async (t) => {
    const { app, key, conv } = await setup(t);
    for (const seq of [-1, 1.5, "2", 4, undefined]) {
      const res = await app.call("POST", `/conversations/${conv.id}/read`, { key, body: { seq } });
      assert.equal(res.status, 400, String(seq));
    }
  });

  test("markers are per principal: two agents on one conversation do not interfere", async (t) => {
    const { app, key, conv } = await setup(t);
    const second = app.principals.create({ name: "otro" });
    app.principals.grant(second.principal.id, conv.id);

    await app.call("POST", `/conversations/${conv.id}/read`, { key, body: { seq: 3 } });
    const res = await app.call("GET", `/conversations/${conv.id}/messages`, { key: second.key });
    assert.equal(res.body.messages.length, 3, "the second agent still sees everything as unread");
  });

  test("is 404 for a conversation without grant", async (t) => {
    const { app, key, other } = await setup(t);
    const res = await app.call("POST", `/conversations/${other.id}/read`, { key, body: { seq: 1 } });
    assert.equal(res.status, 404);
  });
});
