/**
 * Subscription store — webhook endpoints registered by principals (F4b).
 *
 * The signing secret is stored in clear because the service needs it to sign
 * every delivery (HMAC). It is shown once at creation and never listed.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS subscriptions (
    id           TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    url          TEXT NOT NULL,
    secret       TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
`;

function toSubscription(row) {
  return { id: row.id, principalId: row.principal_id, url: row.url, createdAt: row.created_at };
}

/** Throws unless `url` is an absolute http(s) URL. */
function assertWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`url inválida: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`url debe ser http o https: ${url}`);
  }
}

function createSubscriptionStore({ dbPath }) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare(
      "INSERT INTO subscriptions (id, principal_id, url, secret, created_at) VALUES (?, ?, ?, ?, ?)"
    ),
    byId: db.prepare("SELECT * FROM subscriptions WHERE id = ?"),
    listFor: db.prepare("SELECT * FROM subscriptions WHERE principal_id = ? ORDER BY created_at, rowid"),
    all: db.prepare("SELECT * FROM subscriptions ORDER BY created_at, rowid"),
    remove: db.prepare("DELETE FROM subscriptions WHERE id = ?"),
  };

  /** @returns {{subscription: object, secret: string}} — the secret is shown once */
  function create({ principalId, url }) {
    assertWebhookUrl(url);
    const id = `sub_${crypto.randomBytes(8).toString("hex")}`;
    const secret = `whsec_${crypto.randomBytes(32).toString("hex")}`;
    stmts.insert.run(id, principalId, url, secret, new Date().toISOString());
    return { subscription: toSubscription(stmts.byId.get(id)), secret };
  }

  function listFor(principalId) {
    return stmts.listFor.all(principalId).map(toSubscription);
  }

  /** Every subscription, with its secret — for the dispatcher only. */
  function active() {
    return stmts.all.all().map((row) => ({ ...toSubscription(row), secret: row.secret }));
  }

  /**
   * @param {string} id
   * @param {{principalId?: string}} [options] — when set, only removes a
   *   subscription owned by that principal
   * @returns {boolean} whether a subscription was removed
   */
  function remove(id, { principalId } = {}) {
    const row = stmts.byId.get(id);
    if (!row) return false;
    if (principalId !== undefined && row.principal_id !== principalId) return false;
    return stmts.remove.run(id).changes > 0;
  }

  function close() {
    db.close();
  }

  return { create, listFor, active, remove, close };
}

module.exports = { createSubscriptionStore, assertWebhookUrl };
