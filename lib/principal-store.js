/**
 * Principal store — credentials with identity, and what each one may read.
 *
 * A principal is one consumer (typically one agent) with its own API key and
 * a scope:
 *   all            everything, as the single shared API_KEY always allowed
 *   conversations  only the conversations explicitly granted to it (D3)
 *
 * Keys are generated here, returned once at creation, and stored only as a
 * SHA-256 hash. They are high-entropy random tokens, so a plain hash is the
 * right tool: a slow password hash would only add latency to every request.
 *
 * Lives in chat.db next to the conversations it grants access to. Open the
 * conversation store first: it owns the `conversations` table.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCOPES = new Set(["all", "conversations"]);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS principals (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    key_hash   TEXT NOT NULL UNIQUE,
    scope      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  -- principal_id has no foreign key: the implicit "legacy" principal (the
  -- shared API_KEY) is not a row, and keeps read markers too.
  CREATE TABLE IF NOT EXISTS read_markers (
    principal_id    TEXT    NOT NULL,
    conversation_id TEXT    NOT NULL REFERENCES conversations (id),
    seq             INTEGER NOT NULL,
    updated_at      TEXT    NOT NULL,
    PRIMARY KEY (principal_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS grants (
    principal_id    TEXT NOT NULL REFERENCES principals (id),
    conversation_id TEXT NOT NULL REFERENCES conversations (id),
    granted_at      TEXT NOT NULL,
    PRIMARY KEY (principal_id, conversation_id)
  );
`;

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function toPrincipal(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * @param {object} options
 * @param {string} options.dbPath — chat.db, shared with the conversation store
 */
function createPrincipalStore({ dbPath }) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare(
      "INSERT INTO principals (id, name, key_hash, scope, created_at) VALUES (?, ?, ?, ?, ?)"
    ),
    byId: db.prepare("SELECT * FROM principals WHERE id = ?"),
    byHash: db.prepare("SELECT * FROM principals WHERE key_hash = ? AND revoked_at IS NULL"),
    list: db.prepare("SELECT * FROM principals ORDER BY created_at, rowid"),
    revoke: db.prepare("UPDATE principals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),
    conversationExists: db.prepare("SELECT 1 AS ok FROM conversations WHERE id = ?"),
    grant: db.prepare(
      "INSERT OR IGNORE INTO grants (principal_id, conversation_id, granted_at) VALUES (?, ?, ?)"
    ),
    revokeGrant: db.prepare("DELETE FROM grants WHERE principal_id = ? AND conversation_id = ?"),
    isGranted: db.prepare(
      "SELECT 1 AS ok FROM grants WHERE principal_id = ? AND conversation_id = ?"
    ),
    getMarker: db.prepare(
      "SELECT seq FROM read_markers WHERE principal_id = ? AND conversation_id = ?"
    ),
    setMarker: db.prepare(`
      INSERT INTO read_markers (principal_id, conversation_id, seq, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (principal_id, conversation_id) DO UPDATE
        SET seq = MAX(seq, excluded.seq), updated_at = excluded.updated_at
    `),
    granted: db.prepare(
      "SELECT conversation_id FROM grants WHERE principal_id = ? ORDER BY granted_at, rowid"
    ),
  };

  /**
   * @returns {{principal: object, key: string}} — the key is not stored and
   *   cannot be recovered later
   */
  function create({ name, scope = "conversations" } = {}) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("principal name is required");
    }
    if (!SCOPES.has(scope)) {
      throw new TypeError(`scope must be one of: ${[...SCOPES].join(", ")}`);
    }
    const id = `prn_${crypto.randomBytes(8).toString("hex")}`;
    const key = `wsk_${crypto.randomBytes(32).toString("hex")}`;
    stmts.insert.run(id, name.trim(), hashKey(key), scope, new Date().toISOString());
    return { principal: get(id), key };
  }

  function get(id) {
    return toPrincipal(stmts.byId.get(id));
  }

  /** The active principal owning `key`, or null. */
  function authenticate(key) {
    if (typeof key !== "string" || key === "") return null;
    return toPrincipal(stmts.byHash.get(hashKey(key)));
  }

  function list() {
    return stmts.list.all().map(toPrincipal);
  }

  /** @returns {boolean} whether an active principal was revoked */
  function revoke(id) {
    return stmts.revoke.run(new Date().toISOString(), id).changes > 0;
  }

  /** @returns {{created: boolean}} — false when the grant already existed */
  function grant(principalId, conversationId) {
    if (!get(principalId)) throw new Error(`unknown principal: ${principalId}`);
    if (!stmts.conversationExists.get(conversationId)) {
      throw new Error(`unknown conversation: ${conversationId}`);
    }
    const result = stmts.grant.run(principalId, conversationId, new Date().toISOString());
    return { created: result.changes > 0 };
  }

  /** @returns {boolean} whether a grant was removed */
  function revokeGrant(principalId, conversationId) {
    return stmts.revokeGrant.run(principalId, conversationId).changes > 0;
  }

  function isGranted(principalId, conversationId) {
    return Boolean(stmts.isGranted.get(principalId, conversationId));
  }

  function grantedConversationIds(principalId) {
    return stmts.granted.all(principalId).map((row) => row.conversation_id);
  }

  /** The last seq this principal marked as read in a conversation; 0 if none. */
  function getReadMarker(principalId, conversationId) {
    return stmts.getMarker.get(principalId, conversationId)?.seq ?? 0;
  }

  /**
   * Records how far a principal has read. Only moves forward: a lower seq
   * leaves the marker where it was, so a slow duplicate request cannot make
   * a consumer re-read. Returns the resulting marker.
   */
  function setReadMarker(principalId, conversationId, seq) {
    stmts.setMarker.run(principalId, conversationId, seq, new Date().toISOString());
    return getReadMarker(principalId, conversationId);
  }

  function close() {
    db.close();
  }

  return {
    create,
    get,
    authenticate,
    list,
    revoke,
    grant,
    revokeGrant,
    isGranted,
    grantedConversationIds,
    getReadMarker,
    setReadMarker,
    close,
  };
}

module.exports = { createPrincipalStore, SCOPES };
