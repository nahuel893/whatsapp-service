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
      media: null,
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

// ── F4: reading ──────────────────────────────────────────────────────────

function seed(n, overrides = {}) {
  let last;
  for (let i = 0; i < n; i++) last = store.recordInbound(inbound({ text: `m${i + 1}`, ...overrides }));
  return last.conversation;
}

test("readMessages returns messages after `since`, oldest first, with the next cursor", () => {
  const conv = seed(5);
  const page = store.readMessages(conv.id, { since: 2 });
  assert.deepEqual(page.messages.map((m) => m.seq), [3, 4, 5]);
  assert.equal(page.next, 5);
  assert.equal(page.gap, null);
});

test("readMessages honours limit and the cursor resumes where it stopped", () => {
  const conv = seed(5);
  const first = store.readMessages(conv.id, { since: 0, limit: 2 });
  assert.deepEqual(first.messages.map((m) => m.seq), [1, 2]);
  const second = store.readMessages(conv.id, { since: first.next, limit: 2 });
  assert.deepEqual(second.messages.map((m) => m.seq), [3, 4]);
});

test("readMessages with nothing new keeps the cursor where it was", () => {
  const conv = seed(2);
  assert.deepEqual(store.readMessages(conv.id, { since: 2 }), { messages: [], next: 2, gap: null });
});

test("prune deletes old messages as a contiguous block and declares the gap", () => {
  const old = "2020-01-01T00:00:00.000Z";
  const recent = new Date().toISOString();
  const conv = seed(3, { at: old });
  seed(2, { at: recent });

  const result = store.prune(30);
  assert.deepEqual(result, { messages: 3 });
  assert.equal(store.getConversation(conv.id).prunedThroughSeq, 3);

  const page = store.readMessages(conv.id, { since: 0 });
  assert.deepEqual(page.gap, { from: 1, to: 3, reason: "retention" });
  assert.deepEqual(page.messages.map((m) => m.seq), [4, 5]);

  const after = store.readMessages(conv.id, { since: 3 });
  assert.equal(after.gap, null, "a cursor at or past the watermark has no gap");

  const empty = store.readMessages(conv.id, { since: 1 });
  assert.deepEqual(empty.gap, { from: 2, to: 3, reason: "retention" });
});

test("prune only removes the old prefix: a recent message is never deleted", () => {
  const conv = seed(1, { at: "2020-01-01T00:00:00.000Z" });
  seed(1, { at: new Date().toISOString() });
  seed(1, { at: "2020-01-02T00:00:00.000Z" }); // late, out-of-order provider timestamp

  assert.deepEqual(store.prune(30), { messages: 1 });
  assert.equal(store.getConversation(conv.id).prunedThroughSeq, 1);
  assert.deepEqual(store.readMessages(conv.id, { since: 1 }).messages.map((m) => m.seq), [2, 3]);
});

test("prune with nothing old changes nothing", () => {
  const conv = seed(2, { at: new Date().toISOString() });
  assert.deepEqual(store.prune(30), { messages: 0 });
  assert.equal(store.getConversation(conv.id).prunedThroughSeq, 0);
});

test("countInboundAfter counts inbound messages past a seq", () => {
  const conv = seed(4);
  assert.equal(store.countInboundAfter(conv.id, 0), 4);
  assert.equal(store.countInboundAfter(conv.id, 3), 1);
  assert.equal(store.countInboundAfter(conv.id, 4), 0);
});

test("listConversations orders by latest activity and can filter by id", () => {
  const a = seed(1, { address: "whatsapp:+1", at: "2026-01-01T00:00:00.000Z" });
  const b = seed(1, { address: "whatsapp:+2", at: "2026-01-03T00:00:00.000Z" });
  const quiet = store.resolveConversation("whatsapp:+3");

  assert.deepEqual(store.listConversations().map((c) => c.id), [b.id, a.id, quiet.id]);
  assert.deepEqual(store.listConversations({ ids: [a.id, quiet.id] }).map((c) => c.id), [a.id, quiet.id]);
  assert.deepEqual(store.listConversations({ ids: [] }), []);
});

// ── F5: outbound ─────────────────────────────────────────────────────────

test("recordOutbound stores a queued reply in the conversation's sequence", () => {
  const conv = seed(2);
  const out = store.recordOutbound(conv.id, { text: "respuesta", author: "whatsapp:+5499999999999" });

  assert.deepEqual(
    [out.seq, out.direction, out.status, out.text, out.externalId, out.author],
    [3, "out", "queued", "respuesta", null, "whatsapp:+5499999999999"]
  );
  assert.equal(store.getConversation(conv.id).nextSeq, 4);
  assert.equal(store.countInboundAfter(conv.id, 2), 0, "a reply is not unread");
});

test("markOutbound records the delivery outcome and the provider id", () => {
  const conv = seed(1);
  const out = store.recordOutbound(conv.id, { text: "x" });
  store.markOutbound(out.id, { status: "sent", externalId: "WA-9" });
  const sent = store.getMessage(out.id);
  assert.deepEqual([sent.status, sent.externalId], ["sent", "WA-9"]);

  const failed = store.recordOutbound(conv.id, { text: "y" });
  store.markOutbound(failed.id, { status: "error" });
  assert.equal(store.getMessage(failed.id).status, "error");
});

test("recordOutbound rejects an unknown conversation", () => {
  assert.throws(() => store.recordOutbound("conv_0000000000000000", { text: "x" }), /conversation/);
});

test("countOutboundSince counts the replies of a conversation in a window", () => {
  const conv = seed(1);
  const other = seed(1, { address: "whatsapp:+2" });
  store.recordOutbound(conv.id, { text: "a" });
  store.recordOutbound(conv.id, { text: "b" });
  store.recordOutbound(other.id, { text: "c" });

  const aMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  assert.equal(store.countOutboundSince(conv.id, aMinuteAgo), 2);
  assert.equal(store.countOutboundSince(conv.id, new Date(Date.now() + 1000).toISOString()), 0);
});

test("recordOutbound stores media metadata, never the bytes", () => {
  const conv = seed(1);
  const out = store.recordOutbound(conv.id, {
    text: "el informe",
    media: { type: "document", name: "informe.pdf", mimetype: "application/pdf", size: 1234 },
  });
  assert.deepEqual(out.media, { type: "document", name: "informe.pdf", mimetype: "application/pdf", size: 1234 });
  assert.equal(store.getMessage(out.id).media.name, "informe.pdf");
  assert.equal(store.recordOutbound(conv.id, { text: "solo texto" }).media, null);
});

test("a chat.db created before media columns existed is migrated in place", () => {
  const { DatabaseSync } = require("node:sqlite");
  const legacyPath = path.join(tmpDir, "legacy-chat.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
      display_name TEXT, created_at TEXT NOT NULL, last_message_at TEXT,
      next_seq INTEGER NOT NULL DEFAULT 1, pruned_through_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
      direction TEXT NOT NULL, external_id TEXT, author TEXT, text TEXT, media_id TEXT, reply_to TEXT,
      status TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (conversation_id, seq), UNIQUE (conversation_id, external_id));
    INSERT INTO conversations (id, channel, address, created_at, next_seq) VALUES ('conv_old', 'whatsapp', 'whatsapp:+1', '2026-01-01', 2);
    INSERT INTO messages (id, conversation_id, seq, direction, text, status, at) VALUES ('msg_old', 'conv_old', 1, 'in', 'viejo', 'received', '2026-01-01');
  `);
  legacy.close();

  const migrated = createConversationStore({ dbPath: legacyPath });
  try {
    assert.equal(migrated.getMessage("msg_old").media, null);
    const out = migrated.recordOutbound("conv_old", {
      text: "",
      media: { type: "image", name: "a.png", mimetype: "image/png", size: 3 },
    });
    assert.equal(out.media.type, "image");
  } finally {
    migrated.close();
  }
});
