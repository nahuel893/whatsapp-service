"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { startChatApp } = require("./helpers/chat-app");
const { createAgent, verifySignature, renderTranscript } = require("../examples/claude-agent/agent");

const silent = { info() {}, warn() {}, error() {} };

/** Waits until `count` provider-level sends happened, or fails. */
async function sends(app, count) {
  for (let i = 0; i < 400; i++) {
    if (app.sent.length >= count) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`expected ${count} sends, got ${app.sent.length}`);
}

async function setup(t, { runModel } = {}) {
  const app = await startChatApp();
  t.after(app.close);
  const { key } = app.principals.create({ name: "bot", scope: "agent" });
  const conv = app.conversations.resolveConversation("whatsapp:+5491111111111");
  const prompts = [];
  const agent = createAgent({
    serviceUrl: app.base,
    apiKey: key,
    runModel: runModel || (async (prompt) => {
      prompts.push(prompt);
      return "¡Hola! Sí, tenemos stock.";
    }),
    debounceMs: 20,
    logger: silent,
  });
  t.after(agent.stop);
  let n = 0;
  const receive = (text) =>
    app.conversations.recordInbound({
      externalId: `in-${++n}`,
      address: conv.address,
      author: conv.address,
      text,
      status: "received",
      at: new Date().toISOString(),
    });
  return { app, agent, conv, prompts, receive };
}

test("verifySignature accepts the service's signature and rejects tampering and replays", () => {
  const secret = "whsec_test";
  const rawBody = '{"event":"message.created"}';
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;

  assert.equal(verifySignature({ secret, timestamp, signature, rawBody, now }), true);
  assert.equal(verifySignature({ secret, timestamp, signature, rawBody: rawBody + " ", now }), false);
  assert.equal(verifySignature({ secret: "otro", timestamp, signature, rawBody, now }), false);
  assert.equal(verifySignature({ secret, timestamp, signature, rawBody, now: now + 301_000 }), false, "replay");
  assert.equal(verifySignature({ secret, timestamp: "abc", signature, rawBody, now }), false);
  assert.equal(verifySignature({ secret, timestamp, signature: undefined, rawBody, now }), false);
});

test("attend answers with the model's text, from the transcript, and marks read", async (t) => {
  const { app, agent, conv, prompts, receive } = await setup(t);
  receive("Hola");
  receive("¿tienen stock?");

  assert.deepEqual(await agent.attend(conv.id), { replied: true });
  await app.drained();

  assert.deepEqual(app.sent, [{ jid: "5491111111111@s.whatsapp.net", content: { text: "¡Hola! Sí, tenemos stock." } }]);
  assert.match(prompts[0], /Cliente: Hola\nCliente: ¿tienen stock\?/);
  assert.equal(app.principals.getReadMarker(app.principals.list()[0].id, conv.id), 2);
});

test("a burst of messages becomes a single turn of the agent", async (t) => {
  const { app, agent, conv, prompts, receive } = await setup(t);
  for (const text of ["hola", "quería consultar", "por un pedido"]) {
    receive(text);
    agent.onEvent({ event: "message.created", conversation: { id: conv.id }, message: { direction: "in" } });
  }
  await sends(app, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(prompts.length, 1);
  assert.equal(app.sent.length, 1);
});

test("nothing new from the customer means no model call", async (t) => {
  const { agent, conv, prompts } = await setup(t);
  assert.deepEqual(await agent.attend(conv.id), { replied: false });
  assert.equal(prompts.length, 0);
});

test("a failing model sends nothing and leaves the messages unread", async (t) => {
  const { app, agent, conv, receive } = await setup(t, {
    runModel: async () => {
      throw new Error("model down");
    },
  });
  receive("hola");
  await assert.rejects(agent.attend(conv.id), /model down/);
  await app.drained();
  assert.deepEqual(app.sent, []);
  assert.equal(app.principals.getReadMarker(app.principals.list()[0].id, conv.id), 0);
});

test("catchUp schedules every conversation with unread messages", async (t) => {
  const { app, agent, receive } = await setup(t);
  receive("¿hay alguien?");
  assert.equal(await agent.catchUp(), 1);
  await sends(app, 1);
});

test("renderTranscript labels both sides and placeholders", () => {
  assert.equal(
    renderTranscript([
      { direction: "in", text: "hola", status: "received" },
      { direction: "out", text: "buenas", status: "sent" },
      { direction: "in", text: null, status: "undecryptable" },
      { direction: "in", text: null, status: "received" },
    ]),
    "Cliente: hola\nVos: buenas\nCliente: [mensaje que no se pudo leer]\nCliente: [adjunto sin texto]"
  );
});
