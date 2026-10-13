/*
 * Typing indicator and read receipts: what a conversational consumer shows the
 * person on the other side while it works. Neither counts as an outbound
 * message.
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { startChatApp } = require("./helpers/chat-app");

async function setup(t, options = {}) {
  const app = await startChatApp({ typingRenewMs: 30, ...options });
  t.after(app.close);
  const { principal, key } = app.principals.create({ name: "agente" });
  const conv = app.conversations.resolveConversation("whatsapp:+5491111111111");
  app.principals.grant(principal.id, conv.id);
  for (const n of [1, 2, 3]) {
    app.conversations.recordInbound({
      externalId: `IN-${n}`,
      address: conv.address,
      author: conv.address,
      text: `m${n}`,
      status: "received",
      kind: "direct",
      at: new Date().toISOString(),
    });
  }
  const other = app.conversations.resolveConversation("whatsapp:+5492222222222");
  return { app, key, conv, other };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JID = "5491111111111@s.whatsapp.net";

describe("POST /conversations/:id/typing", () => {
  test("composing is shown and kept alive until the TTL ends, then paused", async (t) => {
    const { app, key, conv } = await setup(t);
    const res = await app.call("POST", `/conversations/${conv.id}/typing`, {
      key,
      body: { state: "composing", ttlSeconds: 1 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.state, "composing");
    assert.equal(Number.isNaN(Date.parse(res.body.expiresAt)), false);

    await sleep(150);
    const renewals = app.control.presence.filter((p) => p.state === "composing").length;
    assert.ok(renewals >= 3, `kept alive (${renewals} composing updates)`);
    assert.ok(app.control.presence.every((p) => p.jid === JID));

    await sleep(1100);
    assert.equal(app.control.presence.at(-1).state, "paused", "expires on its own");
    const after = app.control.presence.length;
    await sleep(100);
    assert.equal(app.control.presence.length, after, "no renewals after expiry");
  });

  test("paused stops it immediately", async (t) => {
    const { app, key, conv } = await setup(t);
    await app.call("POST", `/conversations/${conv.id}/typing`, { key, body: { state: "composing" } });
    const res = await app.call("POST", `/conversations/${conv.id}/typing`, { key, body: { state: "paused" } });
    assert.deepEqual(res.body, { ok: true, state: "paused", expiresAt: null });
    const count = app.control.presence.length;
    await sleep(100);
    assert.equal(app.control.presence.at(-1).state, "paused");
    assert.equal(app.control.presence.length, count, "no renewals after paused");
  });

  test("sending a message to the conversation ends the typing", async (t) => {
    const { app, key, conv } = await setup(t);
    await app.call("POST", `/conversations/${conv.id}/typing`, { key, body: { state: "composing", ttlSeconds: 60 } });
    await app.call("POST", `/conversations/${conv.id}/messages`, { key, body: { text: "listo" } });
    await app.drained();
    const count = app.control.presence.length;
    await sleep(120);
    assert.equal(app.control.presence.length, count, "no renewals once the reply went out");
  });

  test("typing does not count as an outbound message", async (t) => {
    const { app, key, conv } = await setup(t, { maxRepliesPerMinute: 1 });
    for (let i = 0; i < 5; i++) {
      await app.call("POST", `/conversations/${conv.id}/typing`, { key, body: { state: "composing" } });
    }
    assert.equal((await app.call("POST", `/conversations/${conv.id}/messages`, { key, body: { text: "x" } })).status, 202);
    assert.deepEqual(app.conversations.listMessages(conv.id).filter((m) => m.direction === "out").length, 1);
  });

  test("validates state and ttlSeconds", async (t) => {
    const { app, key, conv } = await setup(t);
    for (const body of [{}, { state: "recording" }, { state: "composing", ttlSeconds: 0 }, { state: "composing", ttlSeconds: 121 }, { state: "composing", ttlSeconds: 1.5 }]) {
      const res = await app.call("POST", `/conversations/${conv.id}/typing`, { key, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("is 404 for a conversation without grant", async (t) => {
    const { app, key, other } = await setup(t);
    const res = await app.call("POST", `/conversations/${other.id}/typing`, { key, body: { state: "composing" } });
    assert.equal(res.status, 404);
    assert.deepEqual(app.control.presence, []);
  });
});

describe("POST /conversations/:id/receipts", () => {
  test("sends read receipts for inbound messages up to a seq, once each", async (t) => {
    const { app, key, conv } = await setup(t);
    const res = await app.call("POST", `/conversations/${conv.id}/receipts`, { key, body: { upToSeq: 2 } });
    assert.deepEqual(res, { status: 200, body: { ok: true, receipted: 2 } });
    assert.deepEqual(app.control.reads.map((k) => k.id), ["IN-1", "IN-2"]);
    assert.ok(app.control.reads.every((k) => k.remoteJid === JID && k.fromMe === false));

    const again = await app.call("POST", `/conversations/${conv.id}/receipts`, { key, body: { upToSeq: 3 } });
    assert.equal(again.body.receipted, 1);
    assert.deepEqual(app.control.reads.map((k) => k.id), ["IN-1", "IN-2", "IN-3"]);
  });

  test("does not move the server-side read marker", async (t) => {
    const { app, key, conv } = await setup(t);
    await app.call("POST", `/conversations/${conv.id}/receipts`, { key, body: { upToSeq: 3 } });
    const list = await app.call("GET", "/conversations", { key });
    assert.equal(list.body.conversations[0].unread, 3);
  });

  test("validates upToSeq and answers 404 without grant", async (t) => {
    const { app, key, conv, other } = await setup(t);
    for (const upToSeq of [-1, 1.5, "2", 99, undefined]) {
      const res = await app.call("POST", `/conversations/${conv.id}/receipts`, { key, body: { upToSeq } });
      assert.equal(res.status, 400, String(upToSeq));
    }
    const res = await app.call("POST", `/conversations/${other.id}/receipts`, { key, body: { upToSeq: 0 } });
    assert.equal(res.status, 404);
  });
});
