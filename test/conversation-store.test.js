"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createConversationStore } = require("../lib/conversation-store");

let tmpDir;
let dbPath;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-conv-"));
  dbPath = path.join(tmpDir, "chat.db");
  store = createConversationStore({ dbPath });
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let counter = 0;
function inbound(overrides = {}) {
  return {
    externalId: `ext-${++counter}`,
    address: "whatsapp:+5490000000000",
    author: "whatsapp:+5490000000000",
    text: "hola",
    status: "received",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("resolveConversation mints a conversation once per address", () => {
  const a = store.resolveConversation("whatsapp:+5490000000000");
  const again = store.resolveConversation("whatsapp:+5490000000000");
  const other = store.resolveConversation("whatsapp:group:123");

  assert.match(a.id, /^conv_[0-9a-f]{16}$/);
  assert.equal(again.id, a.id);
  assert.notEqual(other.id, a.id);
  assert.deepEqual(
    { channel: a.channel, address: a.address, nextSeq: a.nextSeq, prunedThroughSeq: a.prunedThroughSeq },
    { channel: "whatsapp", address: "whatsapp:+5490000000000", nextSeq: 1, prunedThroughSeq: 0 }
  );
  assert.equal(a.lastMessageAt, null);
  assert.equal(Number.isNaN(Date.parse(a.createdAt)), false);
  assert.deepEqual(store.getConversation(a.id), a);
});

test("resolveConversation rejects an address with no channel", () => {
  for (const address of ["", "sin-canal", ":x", "whatsapp:", null]) {
    assert.throws(() => store.resolveConversation(address), undefined, String(address));
  }
});

test("getConversation returns null for an unknown id", () => {
  assert.equal(store.getConversation("conv_0000000000000000"), null);
});

test("recordInbound mints the conversation of an unknown sender", () => {
  const { conversation, message, outcome } = store.recordInbound(inbound());
  assert.equal(outcome, "created");
  assert.equal(conversation.address, "whatsapp:+5490000000000");
  assert.equal(message.conversationId, conversation.id);
});

test("recordInbound stores the message in domain shape", () => {
  const { message } = store.recordInbound(
    inbound({ externalId: "E1", author: "whatsapp:+5491111111111", text: "buenas" })
  );
  assert.match(message.id, /^msg_[0-9a-f]{16}$/);
  assert.deepEqual(
    { ...message, id: undefined, conversationId: undefined },
    {
      id: undefined,
      conversationId: undefined,
      seq: 1,
      direction: "in",
      externalId: "E1",
      author: "whatsapp:+5491111111111",
      text: "buenas",
      mediaId: null,
      replyTo: null,
      status: "received",
      at: "2026-01-01T00:00:00.000Z",
    }
  );
});

test("seq is monotonic within a conversation and independent across them", () => {
  const seqs = [
    store.recordInbound(inbound()).message.seq,
    store.recordInbound(inbound()).message.seq,
    store.recordInbound(inbound({ address: "whatsapp:group:123" })).message.seq,
    store.recordInbound(inbound()).message.seq,
  ];
  assert.deepEqual(seqs, [1, 2, 1, 3]);
});

test("a redelivered message is absorbed and does not consume a seq", () => {
  const first = store.recordInbound(inbound({ externalId: "DUP" }));
  const again = store.recordInbound(inbound({ externalId: "DUP", text: "otra cosa" }));
  const next = store.recordInbound(inbound());

  assert.equal(again.outcome, "duplicate");
  assert.equal(again.message.id, first.message.id);
  assert.equal(again.message.text, "hola", "the stored message is not overwritten");
  assert.equal(next.message.seq, 2);
  assert.equal(store.listMessages(first.conversation.id).length, 2);
});

test("the same externalId in two conversations is two messages", () => {
  store.recordInbound(inbound({ externalId: "SAME" }));
  const other = store.recordInbound(inbound({ externalId: "SAME", address: "whatsapp:group:123" }));
  assert.equal(other.outcome, "created");
});

test("an undecryptable message keeps its seq and text stays null", () => {
  const { message } = store.recordInbound(inbound({ status: "undecryptable", text: null }));
  assert.equal(message.seq, 1);
  assert.equal(message.status, "undecryptable");
  assert.equal(message.text, null);
});

test("the decrypted retry completes the undecryptable message in place", () => {
  const broken = store.recordInbound(inbound({ externalId: "R", status: "undecryptable", text: null }));
  store.recordInbound(inbound());
  const fixed = store.recordInbound(inbound({ externalId: "R", text: "ahora sí" }));

  assert.equal(fixed.outcome, "completed");
  assert.equal(fixed.message.id, broken.message.id);
  assert.equal(fixed.message.seq, 1);
  assert.equal(fixed.message.status, "received");
  assert.equal(fixed.message.text, "ahora sí");

  const messages = store.listMessages(broken.conversation.id);
  assert.deepEqual(messages.map((m) => [m.seq, m.status]), [[1, "received"], [2, "received"]]);
});

test("an undecryptable redelivery never degrades a received message", () => {
  store.recordInbound(inbound({ externalId: "OK", text: "legible" }));
  const again = store.recordInbound(inbound({ externalId: "OK", status: "undecryptable", text: null }));
  assert.equal(again.outcome, "duplicate");
  assert.equal(again.message.status, "received");
  assert.equal(again.message.text, "legible");
});

test("lastMessageAt follows the newest stored message", () => {
  store.recordInbound(inbound({ at: "2026-01-01T00:00:00.000Z" }));
  const { conversation } = store.recordInbound(inbound({ at: "2026-01-02T00:00:00.000Z" }));
  assert.equal(conversation.lastMessageAt, "2026-01-02T00:00:00.000Z");
  assert.equal(conversation.nextSeq, 3);
});

test("listMessages returns messages in seq order and [] for an unknown conversation", () => {
  const { conversation } = store.recordInbound(inbound({ text: "uno" }));
  store.recordInbound(inbound({ text: "dos" }));
  assert.deepEqual(store.listMessages(conversation.id).map((m) => m.text), ["uno", "dos"]);
  assert.deepEqual(store.listMessages("conv_0000000000000000"), []);
});

test("conversations and seq survive a reopen", () => {
  const { conversation } = store.recordInbound(inbound());
  store.close();

  store = createConversationStore({ dbPath });
  assert.equal(store.resolveConversation("whatsapp:+5490000000000").id, conversation.id);
  assert.equal(store.recordInbound(inbound()).message.seq, 2);
});

test("recordInbound rejects a message without externalId", () => {
  assert.throws(() => store.recordInbound(inbound({ externalId: "" })));
  assert.throws(() => store.recordInbound(inbound({ externalId: undefined })));
});
