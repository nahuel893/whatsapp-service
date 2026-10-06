"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createInboundCapture } = require("../lib/inbound-capture");
const { createConversationStore } = require("../lib/conversation-store");
const { createMemoryTransport } = require("../lib/transport/memory");

let tmpDir;
let store;
let transport;
let logs;
let logger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-capture-"));
  store = createConversationStore({ dbPath: path.join(tmpDir, "chat.db") });
  transport = createMemoryTransport();
  logs = [];
  logger = {
    info: (obj, msg) => logs.push({ level: "info", obj, msg }),
    error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  };
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("every inbound message from the transport is persisted", () => {
  createInboundCapture({ transport, store, logger });

  transport.receive({ address: "memory:alice", text: "hola", externalId: "A" });
  transport.receive({ address: "memory:alice", text: "sigo", externalId: "B" });
  transport.receive({ address: "memory:bob", text: "otro", externalId: "C" });

  const alice = store.resolveConversation("memory:alice");
  assert.deepEqual(store.listMessages(alice.id).map((m) => [m.seq, m.text]), [[1, "hola"], [2, "sigo"]]);
  assert.equal(store.listMessages(store.resolveConversation("memory:bob").id).length, 1);
});

test("a redelivery is absorbed, not stored twice", () => {
  createInboundCapture({ transport, store, logger });
  transport.receive({ address: "memory:alice", text: "hola", externalId: "A" });
  transport.receive({ address: "memory:alice", text: "hola", externalId: "A" });
  assert.equal(store.listMessages(store.resolveConversation("memory:alice").id).length, 1);
});

test("an undecryptable message is stored, then completed by its retry", () => {
  createInboundCapture({ transport, store, logger });
  transport.receive({ address: "memory:alice", externalId: "R", status: "undecryptable" });
  transport.receive({ address: "memory:alice", externalId: "R", text: "descifrado" });

  const [msg] = store.listMessages(store.resolveConversation("memory:alice").id);
  assert.deepEqual([msg.seq, msg.status, msg.text], [1, "received", "descifrado"]);
});

test("a storage failure is logged and never thrown into the transport", () => {
  const broken = {
    recordInbound() {
      throw new Error("disk full");
    },
  };
  createInboundCapture({ transport, store: broken, logger });

  assert.doesNotThrow(() => transport.receive({ address: "memory:alice", text: "x", externalId: "A" }));
  const errors = logs.filter((l) => l.level === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].obj.err.message, /disk full/);
  assert.equal(errors[0].obj.externalId, "A");
});

test("logs carry ids and outcome, never the message text", () => {
  createInboundCapture({ transport, store, logger });
  transport.receive({ address: "memory:alice", text: "dato sensible", externalId: "A" });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].obj.outcome, "created");
  assert.equal(JSON.stringify(logs).includes("dato sensible"), false);
});

test("stop() unsubscribes from the transport", () => {
  const capture = createInboundCapture({ transport, store, logger });
  capture.stop();
  transport.receive({ address: "memory:alice", text: "nadie", externalId: "A" });
  assert.equal(store.listMessages(store.resolveConversation("memory:alice").id).length, 0);
});

// Runs in a scratch cwd: config loads ./.env from the cwd, and a developer's
// local .env must not leak into this test.
function loadConfig(env) {
  const configPath = JSON.stringify(path.join(__dirname, "..", "lib", "config.js"));
  const out = execFileSync(
    process.execPath,
    ["-e", `const c=require(${configPath});console.log(JSON.stringify({i:c.INBOUND_CAPTURE,p:c.CHAT_DB_PATH,r:c.CHAT_RETENTION_DAYS}))`],
    { cwd: tmpDir, env: { PATH: process.env.PATH, ...env } }
  );
  return JSON.parse(out);
}

test("config: capture is off unless INBOUND_CAPTURE=true, and chat.db lives in DATA_DIR", () => {
  const dataDir = path.join(tmpDir, "data");
  assert.deepEqual(loadConfig({ DATA_DIR: dataDir }), { i: false, p: path.join(dataDir, "chat.db"), r: 90 });
  assert.equal(loadConfig({ CHAT_RETENTION_DAYS: "7" }).r, 7);
  assert.equal(loadConfig({ DATA_DIR: dataDir, INBOUND_CAPTURE: "1" }).i, false);
  assert.equal(loadConfig({ DATA_DIR: dataDir, INBOUND_CAPTURE: "true" }).i, true);
  assert.equal(loadConfig({ CHAT_DB_PATH: path.join(tmpDir, "x.db") }).p, path.join(tmpDir, "x.db"));
});

test("onStored is called for new and completed messages, never for a duplicate", () => {
  const stored = [];
  createInboundCapture({ transport, store, logger, onStored: (event) => stored.push(event) });

  transport.receive({ address: "memory:alice", externalId: "R", status: "undecryptable" });
  transport.receive({ address: "memory:alice", externalId: "R", status: "undecryptable" });
  transport.receive({ address: "memory:alice", externalId: "R", text: "ya" });

  assert.deepEqual(stored.map((e) => e.outcome), ["created", "completed"]);
  assert.equal(stored[1].message.text, "ya");
  assert.equal(stored[1].conversation.address, "memory:alice");
});

test("a failing onStored never breaks the capture", () => {
  createInboundCapture({
    transport,
    store,
    logger,
    onStored: () => {
      throw new Error("dispatcher down");
    },
  });
  assert.doesNotThrow(() => transport.receive({ address: "memory:alice", text: "x", externalId: "A" }));
  assert.equal(store.listMessages(store.resolveConversation("memory:alice").id).length, 1);
});
