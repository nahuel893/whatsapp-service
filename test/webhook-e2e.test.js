/*
 * F4b end to end: a message arrives on the transport, is captured, and a real
 * HTTP endpoint receives a signed webhook it can verify — only if its
 * principal may see that conversation.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createConversationStore } = require("../lib/conversation-store");
const { createPrincipalStore } = require("../lib/principal-store");
const { createSubscriptionStore } = require("../lib/subscription-store");
const { createInboundCapture } = require("../lib/inbound-capture");
const { createWebhookDispatcher, canSeeWith } = require("../lib/webhooks");
const { createMemoryTransport } = require("../lib/transport/memory");

test("an agent's endpoint receives a verifiable webhook for its conversation only", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-hook-"));
  const chatDb = path.join(tmpDir, "chat.db");
  const conversations = createConversationStore({ dbPath: chatDb });
  const principals = createPrincipalStore({ dbPath: chatDb });
  const subscriptions = createSubscriptionStore({ dbPath: chatDb });

  const received = [];
  const agentServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  agentServer.listen(0);
  await new Promise((resolve) => agentServer.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => agentServer.close(resolve));
    subscriptions.close();
    principals.close();
    conversations.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const { principal } = principals.create({ name: "agente" });
  const mine = conversations.resolveConversation("memory:cliente");
  principals.grant(principal.id, mine.id);
  const { secret } = subscriptions.create({
    principalId: principal.id,
    url: `http://127.0.0.1:${agentServer.address().port}/hook`,
  });

  const silent = { info() {}, warn() {}, error() {} };
  const pending = [];
  const dispatcher = createWebhookDispatcher({
    subscriptions,
    canSee: canSeeWith(principals),
    logger: silent,
    retryDelaysMs: [10],
  });
  const transport = createMemoryTransport();
  createInboundCapture({
    transport,
    store: conversations,
    logger: silent,
    onStored: (event) => pending.push(dispatcher.dispatch(event)),
  });

  transport.receive({ address: "memory:cliente", text: "hola", externalId: "c1" });
  transport.receive({ address: "memory:otro", text: "ajeno", externalId: "o1" });
  await Promise.all(pending);

  assert.equal(received.length, 1, "only the granted conversation is pushed");
  const [{ headers, body }] = received;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headers["x-webhook-timestamp"]}.${body}`)
    .digest("hex");
  assert.equal(headers["x-webhook-signature"], `sha256=${expected}`);

  const payload = JSON.parse(body);
  assert.equal(payload.event, "message.created");
  assert.equal(payload.conversation.id, mine.id);
  assert.equal(payload.message.text, "hola");
});

test("canSeeWith: legacy and scope all see everything; others need a grant; revoked see nothing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-cansee-"));
  const chatDb = path.join(tmpDir, "chat.db");
  const conversations = createConversationStore({ dbPath: chatDb });
  const principals = createPrincipalStore({ dbPath: chatDb });
  try {
    const conv = conversations.resolveConversation("memory:x");
    const admin = principals.create({ name: "admin", scope: "all" }).principal;
    const agent = principals.create({ name: "agent" }).principal;
    const canSee = canSeeWith(principals);

    const bot = principals.create({ name: "bot", scope: "agent" }).principal;
    assert.equal(canSee(bot.id, conv.id), true, "scope agent sees every conversation");
    assert.equal(canSee("legacy", conv.id), true);
    assert.equal(canSee(admin.id, conv.id), true);
    assert.equal(canSee(agent.id, conv.id), false);
    principals.grant(agent.id, conv.id);
    assert.equal(canSee(agent.id, conv.id), true);
    principals.revoke(agent.id);
    assert.equal(canSee(agent.id, conv.id), false, "a revoked key stops receiving webhooks");
    assert.equal(canSee("prn_unknown", conv.id), false);
  } finally {
    principals.close();
    conversations.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
