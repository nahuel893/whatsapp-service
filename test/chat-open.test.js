/*
 * An agent opening a conversation with someone who never wrote: opt-in per
 * instance, capped per hour, audited, and paced as an unsolicited send.
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ADMIN, startChatApp } = require("./helpers/chat-app");

async function setup(t, options = {}) {
  const app = await startChatApp(options);
  t.after(app.close);
  const agent = app.principals.create({ name: "bot", scope: "agent" });
  const open = (address, key = agent.key) => app.call("POST", "/conversations", { key, body: { address } });
  return { app, agent, open };
}

describe("disabled (default)", () => {
  test("an agent still cannot open conversations", async (t) => {
    const { open } = await setup(t);
    const res = await open("whatsapp:+5491111111111");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "forbidden");
  });
});

describe("enabled", () => {
  const enabled = { agentCanOpenConversations: true };

  test("an agent opens a conversation: 201 new, 200 existing, same id", async (t) => {
    const { agent, open } = await setup(t, enabled);
    const first = await open("whatsapp:+5491111111111");
    assert.equal(first.status, 201);
    assert.equal(first.body.conversation.openedBy, agent.principal.id);

    const again = await open("whatsapp:+5491111111111");
    assert.equal(again.status, 200);
    assert.equal(again.body.conversation.id, first.body.conversation.id);
  });

  test("the conversation records who opened it; one minted by an inbound message has null", async (t) => {
    const { app, agent, open } = await setup(t, enabled);
    const opened = (await open("whatsapp:+5491111111111")).body.conversation;
    const inbound = app.conversations.recordInbound({
      externalId: "x",
      address: "whatsapp:+5492222222222",
      author: "whatsapp:+5492222222222",
      text: "hola",
      status: "received",
      kind: "direct",
      at: new Date().toISOString(),
    }).conversation;

    const list = (await app.call("GET", "/conversations", { key: agent.key })).body.conversations;
    assert.equal(list.find((c) => c.id === opened.id).openedBy, agent.principal.id);
    assert.equal(list.find((c) => c.id === inbound.id).openedBy, null);
  });

  test("the first message to someone who never wrote goes through the bulk lane", async (t) => {
    const { app, agent, open } = await setup(t, enabled);
    const conv = (await open("whatsapp:+5491111111111")).body.conversation;
    const res = await app.call("POST", `/conversations/${conv.id}/messages`, {
      key: agent.key,
      body: { text: "Bienvenido" },
    });
    assert.equal(res.status, 202);
    assert.equal(app.jobs.get(res.body.job_id).lane, "bulk", "unsolicited: anti-spam pacing");
  });

  test("once the contact writes back, replies use the conversation lane", async (t) => {
    const { app, agent, open } = await setup(t, enabled);
    const conv = (await open("whatsapp:+5491111111111")).body.conversation;
    app.conversations.recordInbound({
      externalId: "r1",
      address: conv.address,
      author: conv.address,
      text: "gracias",
      status: "received",
      kind: "direct",
      at: new Date().toISOString(),
    });
    const res = await app.call("POST", `/conversations/${conv.id}/messages`, { key: agent.key, body: { text: "¡De nada!" } });
    assert.equal(app.jobs.get(res.body.job_id).lane, "conversation");
  });

  test("new conversations opened by agents are capped per hour; reopening does not count", async (t) => {
    const { open } = await setup(t, { ...enabled, agentOpenPerHour: 2 });
    assert.equal((await open("whatsapp:+5491111111111")).status, 201);
    assert.equal((await open("whatsapp:+5491111111111")).status, 200, "existing: not counted");
    assert.equal((await open("whatsapp:+5492222222222")).status, 201);

    const limited = await open("whatsapp:+5493333333333");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.ok(limited.body.retryAfterSeconds >= 1 && limited.body.retryAfterSeconds <= 3600);
  });

  test("the cap is shared by every agent of the instance — it protects the number", async (t) => {
    const { app, open } = await setup(t, { ...enabled, agentOpenPerHour: 1 });
    const other = app.principals.create({ name: "otro", scope: "agent" });
    assert.equal((await open("whatsapp:+5491111111111")).status, 201);
    assert.equal((await open("whatsapp:+5492222222222", other.key)).status, 429);
  });

  test("administrators are not capped and are audited too", async (t) => {
    const { app } = await setup(t, { ...enabled, agentOpenPerHour: 1 });
    for (const n of ["1", "2", "3"]) {
      const res = await app.call("POST", "/conversations", { key: ADMIN, body: { address: `whatsapp:+549000000000${n}` } });
      assert.equal(res.status, 201);
      assert.equal(res.body.conversation.openedBy, "legacy");
    }
  });

  test("the conversations scope still cannot open conversations", async (t) => {
    const { app, open } = await setup(t, enabled);
    const scoped = app.principals.create({ name: "limitado" });
    assert.equal((await open("whatsapp:+5491111111111", scoped.key)).status, 403);
  });

  test("an address the transport cannot reach is still 400", async (t) => {
    const { open } = await setup(t, enabled);
    assert.equal((await open("memory:alguien")).status, 400);
  });
});
