/*
 * F5 — replying inside a conversation: queued in the conversation lane,
 * tracked in the transcript, capped per conversation.
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ADMIN, startChatApp } = require("./helpers/chat-app");

async function setup(t, options = {}) {
  const app = await startChatApp(options);
  t.after(app.close);
  const { principal, key } = app.principals.create({ name: "agente" });
  const conv = app.conversations.resolveConversation("whatsapp:+5491111111111");
  app.principals.grant(principal.id, conv.id);
  app.conversations.recordInbound({
    externalId: "IN-1",
    address: conv.address,
    author: conv.address,
    text: "hola, tienen stock?",
    status: "received",
    at: new Date().toISOString(),
  });
  const other = app.conversations.resolveConversation("whatsapp:+5492222222222");
  return { app, key, principal, conv, other };
}

const reply = (app, conv, key, body) =>
  app.call("POST", `/conversations/${conv.id}/messages`, { key, body });

describe("POST /conversations/:id/messages", () => {
  test("accepts a reply with 202, queued, in the transcript order", async (t) => {
    const { app, key, conv } = await setup(t);
    const res = await reply(app, conv, key, { text: "Sí, tenemos." });

    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(Number.isInteger(res.body.job_id), true);
    const { message } = res.body;
    assert.deepEqual(
      [message.seq, message.direction, message.status, message.text, message.author],
      [2, "out", "queued", "Sí, tenemos.", "whatsapp:+5490000000000"]
    );
  });

  test("the reply is delivered to the conversation's address and marked sent", async (t) => {
    const { app, key, conv } = await setup(t);
    const { body } = await reply(app, conv, key, { text: "Sí, tenemos." });
    await app.drained();

    assert.deepEqual(app.sent, [{ jid: "5491111111111@s.whatsapp.net", content: { text: "Sí, tenemos." } }]);
    const read = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });
    const out = read.body.messages.find((m) => m.id === body.message.id);
    assert.equal(out.status, "sent");

    const job = await app.call("GET", `/queue/job/${body.job_id}`, { key: ADMIN });
    assert.equal(job.body.job.status, "sent");
  });

  test("a failed delivery leaves the reply in error, visible to the agent", async (t) => {
    const { app, key, conv } = await setup(t);
    app.control.failSends = true;
    const { body } = await reply(app, conv, key, { text: "no va a salir" });
    await app.drained();

    const read = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });
    assert.equal(read.body.messages.find((m) => m.id === body.message.id).status, "error");
  });

  test("a reply does not count as unread", async (t) => {
    const { app, key, conv } = await setup(t);
    await app.call("POST", `/conversations/${conv.id}/read`, { key, body: { seq: 1 } });
    await reply(app, conv, key, { text: "listo" });
    const list = await app.call("GET", "/conversations", { key });
    assert.equal(list.body.conversations[0].unread, 0);
  });

  test("is 404 for a conversation without grant", async (t) => {
    const { app, key, other } = await setup(t);
    const res = await reply(app, other, key, { text: "intruso" });
    assert.equal(res.status, 404);
    await app.drained();
    assert.deepEqual(app.sent, []);
  });

  test("rejects an empty, non-string or oversized text with 400", async (t) => {
    const { app, key, conv } = await setup(t);
    for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: "x".repeat(4097) }]) {
      const res = await reply(app, conv, key, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(res.body.error, "invalid_request");
    }
  });

  test("caps replies per conversation per minute with 429 and a retry hint", async (t) => {
    const { app, key, conv, principal } = await setup(t, { maxRepliesPerMinute: 2 });

    assert.equal((await reply(app, conv, key, { text: "1" })).status, 202);
    assert.equal((await reply(app, conv, key, { text: "2" })).status, 202);
    const limited = await reply(app, conv, key, { text: "3" });

    assert.equal(limited.status, 429);
    assert.equal(limited.body.ok, false);
    assert.equal(limited.body.error, "rate_limited");
    assert.equal(Number.isInteger(limited.body.retryAfterSeconds), true);
    assert.ok(limited.body.retryAfterSeconds >= 1 && limited.body.retryAfterSeconds <= 60);

    // The cap is per conversation, not per principal.
    const second = app.conversations.resolveConversation("whatsapp:+5493333333333");
    app.principals.grant(principal.id, second.id);
    assert.equal((await reply(app, second, key, { text: "otro cliente" })).status, 202);
  });

  test("the legacy endpoints keep working alongside replies", async (t) => {
    const { app, key, conv } = await setup(t);
    await reply(app, conv, key, { text: "respuesta" });
    const legacy = await app.call("POST", "/send-text", {
      key: ADMIN,
      body: { to: "5490000000001@s.whatsapp.net", text: "informe" },
    });
    assert.deepEqual(Object.keys(legacy.body).sort(), ["job_id", "ok", "queued"]);
    await app.drained();
    assert.equal(app.sent.length, 2);
  });
});
