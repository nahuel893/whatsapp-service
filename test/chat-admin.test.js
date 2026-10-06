/*
 * F3 — administration of principals, conversations and grants, and the scope
 * wall in front of the pre-port endpoints.
 */
"use strict";

const { test, describe } = require("node:test");
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

const ADMIN = "admin-key";

function fakeManager() {
  const sock = {
    async sendMessage() {
      return { key: { id: "WA-1" } };
    },
    async groupFetchAllParticipating() {
      return {};
    },
  };
  return {
    getStatus: () => ({ connected: true, phone: "5490000000000", connectedAt: 1 }),
    getSock: () => sock,
    onEvent: () => () => {},
    async connect() {},
  };
}

async function startApp({ apiKey = ADMIN } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-admin-"));
  const chatDb = path.join(tmpDir, "chat.db");
  const conversations = createConversationStore({ dbPath: chatDb });
  const principals = createPrincipalStore({ dbPath: chatDb });
  const store = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
  const queue = createMessageQueue({ store, minDelayMs: 0, maxDelayMs: 0 });

  const app = express();
  app.use(createRouter(fakeManager(), queue, { apiKey, principals, conversations }));
  queue.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, pathname, { key, body } = {}) {
    const headers = {};
    if (key) headers["x-api-key"] = key;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text; // Express' own 404 page is HTML
    }
    return { status: res.status, body: parsed };
  }

  return {
    call,
    principals,
    conversations,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      principals.close();
      conversations.close();
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function newAgent(app, name = "agente") {
  const res = await app.call("POST", "/principals", { key: ADMIN, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

describe("principals", () => {
  test("POST /principals creates a principal and returns its key once", async (t) => {
    const app = await startApp();
    t.after(app.close);

    const { ok, principal, key } = await newAgent(app, "ventas");
    assert.equal(ok, true);
    assert.equal(principal.name, "ventas");
    assert.equal(principal.scope, "conversations");
    assert.match(key, /^wsk_[0-9a-f]{64}$/);

    const list = await app.call("GET", "/principals", { key: ADMIN });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.principals.map((p) => p.id), [principal.id]);
    assert.equal(JSON.stringify(list.body).includes(key), false, "the key is never listed");
  });

  test("POST /principals accepts scope all and rejects bad input with 400", async (t) => {
    const app = await startApp();
    t.after(app.close);

    const admin = await app.call("POST", "/principals", { key: ADMIN, body: { name: "ops", scope: "all" } });
    assert.equal(admin.body.principal.scope, "all");

    for (const body of [{}, { name: "" }, { name: "x", scope: "root" }]) {
      const res = await app.call("POST", "/principals", { key: ADMIN, body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, "invalid_request");
    }
  });

  test("DELETE /principals/:id revokes the key", async (t) => {
    const app = await startApp();
    t.after(app.close);

    const { principal, key } = await newAgent(app);
    assert.equal((await app.call("GET", "/conversations-probe", { key })).status, 404, "key works before");

    const del = await app.call("DELETE", `/principals/${principal.id}`, { key: ADMIN });
    assert.deepEqual(del, { status: 200, body: { ok: true } });
    assert.equal((await app.call("GET", "/conversations-probe", { key })).status, 401);

    const again = await app.call("DELETE", `/principals/${principal.id}`, { key: ADMIN });
    assert.equal(again.status, 404);
    assert.deepEqual(again.body, { ok: false, error: "not_found" });
  });
});

describe("conversations and grants", () => {
  test("POST /conversations opens a conversation once per address", async (t) => {
    const app = await startApp();
    t.after(app.close);

    const first = await app.call("POST", "/conversations", {
      key: ADMIN,
      body: { address: "whatsapp:+5490000000000" },
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.ok, true);
    assert.deepEqual(Object.keys(first.body.conversation).sort(), [
      "address",
      "channel",
      "createdAt",
      "id",
      "lastMessageAt",
    ]);
    assert.equal(first.body.conversation.channel, "whatsapp");

    const again = await app.call("POST", "/conversations", {
      key: ADMIN,
      body: { address: "whatsapp:+5490000000000" },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.conversation.id, first.body.conversation.id);
  });

  test("POST /conversations rejects an address the transport cannot reach", async (t) => {
    const app = await startApp();
    t.after(app.close);

    for (const address of ["memory:alice", "5490000000000", "whatsapp:+54 9", undefined]) {
      const res = await app.call("POST", "/conversations", { key: ADMIN, body: { address } });
      assert.equal(res.status, 400, String(address));
      assert.equal(res.body.error, "invalid_request");
    }
  });

  test("grants are created, are idempotent, and can be revoked", async (t) => {
    const app = await startApp();
    t.after(app.close);

    const { principal } = await newAgent(app);
    const conv = (await app.call("POST", "/conversations", {
      key: ADMIN,
      body: { address: "whatsapp:+5490000000000" },
    })).body.conversation;
    const grantPath = `/conversations/${conv.id}/grants`;

    const created = await app.call("POST", grantPath, { key: ADMIN, body: { principal_id: principal.id } });
    assert.deepEqual(created, { status: 201, body: { ok: true } });
    const repeated = await app.call("POST", grantPath, { key: ADMIN, body: { principal_id: principal.id } });
    assert.deepEqual(repeated, { status: 200, body: { ok: true } });
    assert.equal(app.principals.isGranted(principal.id, conv.id), true);

    const removed = await app.call("DELETE", `${grantPath}/${principal.id}`, { key: ADMIN });
    assert.deepEqual(removed, { status: 200, body: { ok: true } });
    assert.equal(app.principals.isGranted(principal.id, conv.id), false);
    const gone = await app.call("DELETE", `${grantPath}/${principal.id}`, { key: ADMIN });
    assert.equal(gone.status, 404);
  });

  test("granting to an unknown conversation or principal is 404", async (t) => {
    const app = await startApp();
    t.after(app.close);

    const { principal } = await newAgent(app);
    const conv = (await app.call("POST", "/conversations", {
      key: ADMIN,
      body: { address: "whatsapp:+5490000000000" },
    })).body.conversation;

    const noConv = await app.call("POST", "/conversations/conv_0000000000000000/grants", {
      key: ADMIN,
      body: { principal_id: principal.id },
    });
    assert.deepEqual(noConv, { status: 404, body: { ok: false, error: "not_found" } });

    const noPrincipal = await app.call("POST", `/conversations/${conv.id}/grants`, {
      key: ADMIN,
      body: { principal_id: "prn_0000000000000000" },
    });
    assert.equal(noPrincipal.status, 404);

    const missing = await app.call("POST", `/conversations/${conv.id}/grants`, { key: ADMIN, body: {} });
    assert.equal(missing.status, 400);
  });
});

describe("the scope wall", () => {
  test("a conversations-scoped key cannot administer nor use the pre-port endpoints", async (t) => {
    const app = await startApp();
    t.after(app.close);
    const { key } = await newAgent(app);

    const attempts = [
      ["POST", "/principals", { name: "x" }],
      ["GET", "/principals"],
      ["DELETE", "/principals/prn_0000000000000000"],
      ["POST", "/conversations", { address: "whatsapp:+5490000000000" }],
      ["POST", "/conversations/conv_x/grants", { principal_id: "prn_x" }],
      ["DELETE", "/conversations/conv_x/grants/prn_x"],
      ["POST", "/send-text", { to: "5490000000000@s.whatsapp.net", text: "spam" }],
      ["POST", "/send-image"],
      ["POST", "/send-file"],
      ["POST", "/send-file-dm"],
      ["GET", "/groups"],
      ["GET", "/status"],
      ["GET", "/queue/status"],
      ["GET", "/queue/job/1"],
    ];
    for (const [method, pathname, body] of attempts) {
      const res = await app.call(method, pathname, { key, body });
      assert.equal(res.status, 403, `${method} ${pathname}`);
      assert.equal(res.body.error, "forbidden", `${method} ${pathname}`);
    }
  });

  test("/health stays open to everyone", async (t) => {
    const app = await startApp();
    t.after(app.close);
    assert.equal((await app.call("GET", "/health")).status, 200);
  });

  test("with API_KEY empty everything stays open, administration included", async (t) => {
    const app = await startApp({ apiKey: "" });
    t.after(app.close);
    const res = await app.call("POST", "/principals", { body: { name: "x" } });
    assert.equal(res.status, 201);
    assert.equal((await app.call("GET", "/status")).status, 200);
  });
});
