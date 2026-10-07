/**
 * Conversation store — the source of truth for chat traffic (design D4).
 *
 * Every inbound message is persisted here before anything tries to deliver
 * it; cursor reads and webhooks (later phases) are strategies on top of this
 * table, never a replacement for it.
 *
 * Lives in its own SQLite file, separate from the job queue, so the queue's
 * schema and rollback path stay untouched.
 *
 * Domain only: addresses are channel-qualified URIs, never provider ids.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id                 TEXT    PRIMARY KEY,
    channel            TEXT    NOT NULL,
    address            TEXT    NOT NULL UNIQUE,
    display_name       TEXT,
    created_at         TEXT    NOT NULL,
    last_message_at    TEXT,
    next_seq           INTEGER NOT NULL DEFAULT 1,
    pruned_through_seq INTEGER NOT NULL DEFAULT 0,
    opened_by          TEXT,
    opened_scope       TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL REFERENCES conversations (id),
    seq             INTEGER NOT NULL,
    direction       TEXT    NOT NULL,
    external_id     TEXT,
    author          TEXT,
    text            TEXT,
    media_id        TEXT,
    media_type      TEXT,
    media_name      TEXT,
    media_mimetype  TEXT,
    media_size      INTEGER,
    reply_to        TEXT,
    status          TEXT    NOT NULL,
    at              TEXT    NOT NULL,
    UNIQUE (conversation_id, seq),
    UNIQUE (conversation_id, external_id)
  );
`;

const ADDRESS_PATTERN = /^([a-z][a-z0-9+.-]*):(.+)$/;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function toConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    address: row.address,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    nextSeq: row.next_seq,
    prunedThroughSeq: row.pruned_through_seq,
    // Who opened it through the API (a principal id), or null when an inbound
    // message minted it. Audit trail for conversations started by consumers.
    openedBy: row.opened_by ?? null,
  };
}

function toMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    direction: row.direction,
    externalId: row.external_id,
    author: row.author,
    text: row.text,
    mediaId: row.media_id,
    // Metadata only: the bytes never live in this table.
    media: row.media_type
      ? { type: row.media_type, name: row.media_name, mimetype: row.media_mimetype, size: row.media_size }
      : null,
    replyTo: row.reply_to,
    status: row.status,
    at: row.at,
  };
}

/**
 * @param {object} options
 * @param {string} options.dbPath — path to the SQLite file
 */
function createConversationStore({ dbPath }) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // chat.db files created before these columns existed: add them in place.
  const convColumns = new Set(db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name));
  for (const name of ["opened_by", "opened_scope"]) {
    if (!convColumns.has(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} TEXT`);
  }
  const columns = new Set(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
  for (const [name, type] of [
    ["media_type", "TEXT"],
    ["media_name", "TEXT"],
    ["media_mimetype", "TEXT"],
    ["media_size", "INTEGER"],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }

  const stmts = {
    convByAddress: db.prepare("SELECT * FROM conversations WHERE address = ?"),
    convById: db.prepare("SELECT * FROM conversations WHERE id = ?"),
    insertConv: db.prepare(
      "INSERT INTO conversations (id, channel, address, created_at, opened_by, opened_scope) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    openedSince: db.prepare(
      "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM conversations WHERE opened_scope = ? AND created_at >= ?"
    ),
    msgByExternal: db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND external_id = ?"
    ),
    msgById: db.prepare("SELECT * FROM messages WHERE id = ?"),
    insertMsg: db.prepare(`
      INSERT INTO messages (id, conversation_id, seq, direction, external_id, author, text, status, at)
      VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?)
    `),
    completeMsg: db.prepare(
      "UPDATE messages SET text = ?, author = ?, status = 'received' WHERE id = ?"
    ),
    advanceConv: db.prepare(`
      UPDATE conversations
      SET next_seq = next_seq + 1,
          last_message_at = CASE
            WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
            ELSE last_message_at
          END
      WHERE id = ?
    `),
    listMessages: db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq"),
    messagesAfter: db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?"
    ),
    countInboundAfter: db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND direction = 'in' AND seq > ?"
    ),
    listConversations: db.prepare(`
      SELECT * FROM conversations
      ORDER BY last_message_at IS NULL, last_message_at DESC, created_at, rowid
    `),
    convsWithOld: db.prepare("SELECT DISTINCT conversation_id AS id FROM messages WHERE at < ?"),
    firstRecentSeq: db.prepare(
      "SELECT MIN(seq) AS seq FROM messages WHERE conversation_id = ? AND at >= ?"
    ),
    maxSeq: db.prepare("SELECT MAX(seq) AS seq FROM messages WHERE conversation_id = ?"),
    deleteThrough: db.prepare("DELETE FROM messages WHERE conversation_id = ? AND seq <= ?"),
    insertOutbound: db.prepare(`
      INSERT INTO messages (id, conversation_id, seq, direction, author, text,
                            media_type, media_name, media_mimetype, media_size, status, at)
      VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, 'queued', ?)
    `),
    markOutbound: db.prepare(
      "UPDATE messages SET status = ?, external_id = COALESCE(?, external_id) WHERE id = ? AND direction = 'out'"
    ),
    countOutboundSince: db.prepare(
      "SELECT COUNT(*) AS n, MIN(at) AS oldest FROM messages WHERE conversation_id = ? AND direction = 'out' AND at >= ?"
    ),
    raiseWatermark: db.prepare(
      "UPDATE conversations SET pruned_through_seq = MAX(pruned_through_seq, ?) WHERE id = ?"
    ),
  };

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Returns the conversation for `address`, creating it the first time the
   * address is seen. This is how a customer who writes first gets a
   * conversation without anyone registering them (design D2).
   */
  function resolveConversation(address, { openedBy = null, openedScope = null } = {}) {
    const match = typeof address === "string" ? ADDRESS_PATTERN.exec(address) : null;
    if (!match) throw new TypeError(`address must be "<channel>:<id>": ${address}`);

    const existing = stmts.convByAddress.get(address);
    if (existing) return toConversation(existing);

    stmts.insertConv.run(newId("conv"), match[1], address, new Date().toISOString(), openedBy, openedScope);
    return toConversation(stmts.convByAddress.get(address));
  }

  function getConversation(id) {
    return toConversation(stmts.convById.get(id));
  }

  /** The conversation for `address`, or null — never creates one. */
  function findByAddress(address) {
    return toConversation(stmts.convByAddress.get(address));
  }

  /**
   * Persists an InboundMessage (see lib/transport/contract.js).
   *
   * Idempotent per (conversation, externalId): a provider redelivery returns
   * the stored message with outcome "duplicate" and consumes no seq. The one
   * exception is an undecryptable message whose decrypted retry arrives
   * later under the same id: it is completed in place, keeping its seq, with
   * outcome "completed".
   *
   * @returns {{conversation: object, message: object,
   *   outcome: "created"|"duplicate"|"completed"}}
   */
  function recordInbound(msg) {
    if (!msg || typeof msg.externalId !== "string" || msg.externalId === "") {
      throw new TypeError("inbound message needs an externalId");
    }

    return transaction(() => {
      const conversation = resolveConversation(msg.address);
      const existing = stmts.msgByExternal.get(conversation.id, msg.externalId);

      if (existing) {
        const completes = existing.status === "undecryptable" && msg.status === "received";
        if (!completes) {
          return { conversation, message: toMessage(existing), outcome: "duplicate" };
        }
        stmts.completeMsg.run(msg.text ?? null, msg.author ?? existing.author, existing.id);
        return {
          conversation: getConversation(conversation.id),
          message: toMessage(stmts.msgById.get(existing.id)),
          outcome: "completed",
        };
      }

      const id = newId("msg");
      stmts.insertMsg.run(
        id,
        conversation.id,
        conversation.nextSeq,
        msg.externalId,
        msg.author ?? null,
        msg.status === "undecryptable" ? null : msg.text ?? null,
        msg.status === "undecryptable" ? "undecryptable" : "received",
        msg.at
      );
      stmts.advanceConv.run(msg.at, msg.at, conversation.id);
      return {
        conversation: getConversation(conversation.id),
        message: toMessage(stmts.msgById.get(id)),
        outcome: "created",
      };
    });
  }

  /**
   * Cursor read (design D4/D5). Returns the messages after `since`, oldest
   * first, and `next`, the cursor to pass on the following call.
   *
   * When `since` falls before the retention watermark, the purged range is
   * declared in `gap` instead of silently skipped: the consumer learns what
   * context it lost.
   *
   * @returns {{messages: object[], next: number,
   *   gap: {from: number, to: number, reason: "retention"}|null}}
   */
  function readMessages(conversationId, { since = 0, limit = 100 } = {}) {
    const conversation = getConversation(conversationId);
    if (!conversation) return { messages: [], next: since, gap: null };

    const watermark = conversation.prunedThroughSeq;
    const gap = since < watermark ? { from: since + 1, to: watermark, reason: "retention" } : null;
    const from = Math.max(since, watermark);
    const messages = stmts.messagesAfter.all(conversationId, from, limit).map(toMessage);
    return { messages, next: messages.length ? messages.at(-1).seq : from, gap };
  }

  /** Inbound messages after `seq` — what a consumer has not read yet. */
  function countInboundAfter(conversationId, seq) {
    return stmts.countInboundAfter.get(conversationId, seq).n;
  }

  /**
   * Conversations, most recently active first. `ids` restricts the result to
   * those conversations (a principal's grants).
   */
  function listConversations({ ids } = {}) {
    const all = stmts.listConversations.all().map(toConversation);
    if (!ids) return all;
    const wanted = new Set(ids);
    return all.filter((c) => wanted.has(c.id));
  }

  /**
   * Deletes messages older than `days`, per conversation, as the contiguous
   * prefix of old messages only: a recent message is never deleted because a
   * later one carries an older provider timestamp. Raises each conversation's
   * `pruned_through_seq`, which is what readMessages() reports as a gap.
   *
   * @returns {{messages: number}} how many messages were deleted
   */
  function prune(days) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let deleted = 0;
    transaction(() => {
      for (const { id } of stmts.convsWithOld.all(cutoff)) {
        const firstRecent = stmts.firstRecentSeq.get(id, cutoff).seq;
        const through = firstRecent != null ? firstRecent - 1 : stmts.maxSeq.get(id).seq;
        if (!through) continue;
        deleted += stmts.deleteThrough.run(id, through).changes;
        stmts.raiseWatermark.run(through, id);
      }
    });
    return { messages: deleted };
  }

  /**
   * Records a reply as `queued`, taking the next seq of the conversation, so
   * the transcript shows it in order even before it is delivered.
   */
  function recordOutbound(conversationId, { text = null, author = null, media = null }) {
    return transaction(() => {
      const conversation = getConversation(conversationId);
      if (!conversation) throw new Error(`unknown conversation: ${conversationId}`);
      const id = newId("msg");
      const at = new Date().toISOString();
      stmts.insertOutbound.run(
        id,
        conversationId,
        conversation.nextSeq,
        author,
        text,
        media ? media.type : null,
        media ? media.name : null,
        media ? media.mimetype : null,
        media ? media.size : null,
        at
      );
      stmts.advanceConv.run(at, at, conversationId);
      return toMessage(stmts.msgById.get(id));
    });
  }

  /** Delivery outcome of a reply: "sent" (with the provider id) or "error". */
  function markOutbound(messageId, { status, externalId = null }) {
    stmts.markOutbound.run(status, externalId, messageId);
  }

  function getMessage(id) {
    return toMessage(stmts.msgById.get(id));
  }

  /** Replies in a conversation since an ISO time — the rate limit's window. */
  function countOutboundSince(conversationId, sinceIso) {
    return stmts.countOutboundSince.get(conversationId, sinceIso).n;
  }

  /** The earliest reply since an ISO time, or null — when the window frees up. */
  function oldestOutboundSince(conversationId, sinceIso) {
    return stmts.countOutboundSince.get(conversationId, sinceIso).oldest;
  }

  /**
   * Conversations opened through the API by principals of `scope` since an
   * ISO time, and the oldest of them — the window of the opening cap.
   */
  function openedSince(scope, sinceIso) {
    const row = stmts.openedSince.get(scope, sinceIso);
    return { count: row.n, oldest: row.oldest };
  }

  /** Every stored message of a conversation, oldest first. */
  function listMessages(conversationId) {
    return stmts.listMessages.all(conversationId).map(toMessage);
  }

  function close() {
    db.close();
  }

  return {
    resolveConversation,
    getConversation,
    findByAddress,
    listConversations,
    recordInbound,
    readMessages,
    countInboundAfter,
    recordOutbound,
    markOutbound,
    getMessage,
    countOutboundSince,
    oldestOutboundSince,
    openedSince,
    prune,
    listMessages,
    close,
  };
}

module.exports = { createConversationStore };
