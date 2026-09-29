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
    pruned_through_seq INTEGER NOT NULL DEFAULT 0
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

  const stmts = {
    convByAddress: db.prepare("SELECT * FROM conversations WHERE address = ?"),
    convById: db.prepare("SELECT * FROM conversations WHERE id = ?"),
    insertConv: db.prepare(
      "INSERT INTO conversations (id, channel, address, created_at) VALUES (?, ?, ?, ?)"
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
  function resolveConversation(address) {
    const match = typeof address === "string" ? ADDRESS_PATTERN.exec(address) : null;
    if (!match) throw new TypeError(`address must be "<channel>:<id>": ${address}`);

    const existing = stmts.convByAddress.get(address);
    if (existing) return toConversation(existing);

    stmts.insertConv.run(newId("conv"), match[1], address, new Date().toISOString());
    return toConversation(stmts.convByAddress.get(address));
  }

  function getConversation(id) {
    return toConversation(stmts.convById.get(id));
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

  /** Every stored message of a conversation, oldest first. */
  function listMessages(conversationId) {
    return stmts.listMessages.all(conversationId).map(toMessage);
  }

  function close() {
    db.close();
  }

  return { resolveConversation, getConversation, recordInbound, listMessages, close };
}

module.exports = { createConversationStore };
