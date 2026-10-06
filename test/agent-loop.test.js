/*
 * The whole loop an agent runs, end to end, over MemoryTransport: a customer
 * writes, the message is captured, the agent finds it unread, reads it,
 * replies, the reply reaches the customer, and the agent marks its place.
 *
 * Running it on MemoryTransport is the point: the agent-facing flow must not
 * depend on WhatsApp.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { createJobStore } = require("../lib/job-store");
const { createMessageQueue } = require("../lib/message-queue");
const { createRouter } = require("../lib/api");
const { createConversationStore } = require("../lib/conversation-store");
const { createPrincipalStore } = require("../lib/principal-store");
const { createInboundCapture } = require("../lib/inbound-capture");
const { createMemoryTransport } = require("../lib/transport/memory");

const ADMIN = "admin-key";

test("an agent attends a customer from first message to reply", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-loop-"));
  const chatDb = path.join(tmpDir, "chat.db");
  const conversations = createConversationStore({ dbPath: chatDb });
  const principals = createPrincipalStore({ dbPath: chatDb });
  const jobs = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
  const queue = createMessageQueue({
    store: jobs,
    minDelayMs: 0,
    maxDelayMs: 0,
    conversationMinDelayMs: 0,
    conversationMaxDelayMs: 0,
  });
  const transport = createMemoryTransport({ identity: "memory:shop" });
  await transport.connect();

  const silent = { info() {}, error() {} };
  createInboundCapture({ transport, store: conversations, logger: silent });

  const manager = { getStatus: () => ({ connected: true, phone: null, connectedAt: 1 }) };
  const app = express();
  app.use(createRouter(manager, queue, { apiKey: ADMIN, transport, principals, conversations }));
  queue.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    principals.close();
    conversations.close();
    jobs.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, key, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "x-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const drained = async () => {
    for (let i = 0; i < 1000; i++) {
      const s = queue.getStatus();
      if (s.pending === 0 && !s.processing) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("queue did not drain");
  };

  // ── Operator: create the agent, open the customer's conversation, grant it.
  const agent = (await call("POST", "/principals", ADMIN, { name: "agente-ventas" })).body;
  const conv = (await call("POST", "/conversations", ADMIN, { address: "memory:cliente" })).body.conversation;
  assert.equal((await call("POST", `/conversations/${conv.id}/grants`, ADMIN, {
    principal_id: agent.principal.id,
  })).status, 201);

  // ── Customer writes (twice — the provider redelivers the first message).
  transport.receive({ address: "memory:cliente", text: "Hola, ¿tienen stock del modelo X?", externalId: "c1" });
  transport.receive({ address: "memory:cliente", text: "Hola, ¿tienen stock del modelo X?", externalId: "c1" });
  transport.receive({ address: "memory:cliente", text: "Necesito 3 unidades", externalId: "c2" });
  // Someone the agent was not granted also writes.
  transport.receive({ address: "memory:otro", text: "privado", externalId: "o1" });

  // ── Agent: what needs attention?
  const inbox = (await call("GET", "/conversations", agent.key)).body.conversations;
  assert.deepEqual(inbox.map((c) => [c.id, c.unread]), [[conv.id, 2]], "only its conversation, redelivery absorbed");

  // ── Agent: read what is new (no cursor kept on the agent's side).
  const page = (await call("GET", `/conversations/${conv.id}/messages`, agent.key)).body;
  assert.deepEqual(page.messages.map((m) => m.text), ["Hola, ¿tienen stock del modelo X?", "Necesito 3 unidades"]);
  assert.equal(page.gap, null);

  // ── Agent: reply, then mark its place.
  const sent = await call("POST", `/conversations/${conv.id}/messages`, agent.key, {
    text: "¡Hola! Sí, tenemos 5 unidades del modelo X.",
  });
  assert.equal(sent.status, 202);
  await call("POST", `/conversations/${conv.id}/read`, agent.key, { seq: page.next });
  await drained();

  // ── The customer got the reply, through the transport.
  assert.deepEqual(
    transport.outbox.map((o) => [o.address, o.content.text]),
    [["memory:cliente", "¡Hola! Sí, tenemos 5 unidades del modelo X."]]
  );

  // ── Nothing left unread; the transcript shows both sides in order.
  const after = (await call("GET", "/conversations", agent.key)).body.conversations[0];
  assert.equal(after.unread, 0);
  const transcript = (await call("GET", `/conversations/${conv.id}/messages?since=0`, agent.key)).body.messages;
  assert.deepEqual(
    transcript.map((m) => [m.seq, m.direction, m.status]),
    [[1, "in", "received"], [2, "in", "received"], [3, "out", "sent"]]
  );
  assert.equal(transcript[2].author, "memory:shop");

  // ── The customer answers; the agent picks it up from its marker.
  transport.receive({ address: "memory:cliente", text: "Perfecto, las reservo", externalId: "c3" });
  const next = (await call("GET", `/conversations/${conv.id}/messages`, agent.key)).body;
  assert.deepEqual(next.messages.map((m) => m.text), ["¡Hola! Sí, tenemos 5 unidades del modelo X.", "Perfecto, las reservo"]);
});
