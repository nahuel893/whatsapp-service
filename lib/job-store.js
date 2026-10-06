/**
 * Job store — durable persistence for the outbound message queue.
 *
 * Backed by node:sqlite (built into Node >= 22.5), so the service gains
 * crash-safe jobs without adding a dependency.
 *
 * A job is a serializable description of a send — never a closure — so it can
 * be written to disk, survive a restart, and be replayed by whichever handler
 * owns its type. Media bytes live in a BLOB column and are dropped once the
 * job reaches a terminal state.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    type           TEXT    NOT NULL,
    target         TEXT    NOT NULL,
    payload        TEXT    NOT NULL,
    media          BLOB,
    media_name     TEXT,
    media_mimetype TEXT,
    status         TEXT    NOT NULL DEFAULT 'pending',
    lane           TEXT    NOT NULL DEFAULT 'bulk',
    error          TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    queued_at      TEXT    NOT NULL,
    started_at     TEXT,
    finished_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_pending  ON jobs (status, id);
  CREATE INDEX IF NOT EXISTS idx_jobs_finished ON jobs (finished_at DESC);
`;

/**
 * Lanes (design D6). `bulk` keeps the anti-spam pacing of unsolicited sends;
 * `conversation` carries replies to someone who just wrote and goes first.
 */
const LANES = new Set(["bulk", "conversation"]);

/** Jobs to look at next: the conversation lane first, FIFO within a lane. */
const NEXT_ORDER = "ORDER BY CASE lane WHEN 'conversation' THEN 0 ELSE 1 END, id";

/** Maps a raw database row to the shape the rest of the service works with. */
function toJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    target: row.target,
    payload: JSON.parse(row.payload),
    media: row.media
      ? {
          buffer: Buffer.from(row.media),
          name: row.media_name,
          mimetype: row.media_mimetype,
        }
      : null,
    status: row.status,
    lane: row.lane,
    error: row.error,
    attempts: row.attempts,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Opens (creating if needed) the job database.
 *
 * @param {object} options
 * @param {string} options.dbPath — path to the SQLite file
 * @returns {object} the store API
 */
function createJobStore({ dbPath }) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new DatabaseSync(dbPath);
  // WAL keeps reads (status polling) from blocking the writer.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  // queue.db files created before lanes existed: add the column in place.
  // Every job already queued keeps the bulk pacing it was accepted under.
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
  if (!columns.includes("lane")) {
    db.exec("ALTER TABLE jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'bulk'");
  }

  const stmts = {
    insert: db.prepare(`
      INSERT INTO jobs (type, target, payload, media, media_name, media_mimetype, lane, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    byId: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    nextPending: db.prepare(`SELECT * FROM jobs WHERE status = 'pending' ${NEXT_ORDER} LIMIT 1`),
    claim: db.prepare("UPDATE jobs SET status = 'processing', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'"),
    markSent: db.prepare("UPDATE jobs SET status = 'sent', error = NULL, finished_at = ?, media = NULL WHERE id = ?"),
    markError: db.prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ?, media = NULL WHERE id = ?"),
    pendingCount: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'"),
    recent: db.prepare(`
      SELECT id, type, target, status, error, finished_at
      FROM jobs
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC, id DESC
      LIMIT ?
    `),
    recover: db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'processing'"),
    prune: db.prepare(`
      DELETE FROM jobs
      WHERE finished_at IS NOT NULL AND finished_at <= ?
    `),
  };

  /**
   * Persists a new job in `pending` state.
   *
   * @param {object} job
   * @param {string} job.type — dispatch key, e.g. "text" | "image" | "file"
   * @param {string} job.target — raw target as the caller supplied it
   * @param {object} [job.payload] — JSON-serializable send parameters
   * @param {{buffer: Buffer, name: string, mimetype: string}} [job.media]
   * @param {"bulk"|"conversation"} [job.lane]
   * @returns {{id: number}}
   */
  function enqueue({ type, target, payload = {}, media = null, lane = "bulk" }) {
    if (!LANES.has(lane)) throw new TypeError(`unknown lane: ${lane}`);
    const result = stmts.insert.run(
      type,
      target,
      JSON.stringify(payload),
      media ? media.buffer : null,
      media ? media.name ?? null : null,
      media ? media.mimetype ?? null : null,
      lane,
      new Date().toISOString()
    );
    return { id: Number(result.lastInsertRowid) };
  }

  function get(id) {
    return toJob(stmts.byId.get(id));
  }

  /** The job that would run next, without taking it. Null when idle. */
  function peekNext() {
    return toJob(stmts.nextPending.get());
  }

  /**
   * Takes a specific pending job, marking it `processing`. Returns null if it
   * is no longer pending (already claimed, or finished).
   */
  function claim(id) {
    const claimed = stmts.claim.run(new Date().toISOString(), id);
    return claimed.changes === 0 ? null : get(id);
  }

  /**
   * Atomically takes the next pending job and marks it `processing`.
   * Returns null when nothing is waiting.
   */
  function claimNext() {
    const row = stmts.nextPending.get();
    if (!row) return null;
    const claimed = stmts.claim.run(new Date().toISOString(), row.id);
    // Lost the race against another claimer — try again.
    if (claimed.changes === 0) return claimNext();
    return get(row.id);
  }

  function markSent(id) {
    stmts.markSent.run(new Date().toISOString(), id);
  }

  function markError(id, error) {
    stmts.markError.run(String(error?.message || error), new Date().toISOString(), id);
  }

  function pendingCount() {
    return stmts.pendingCount.get().n;
  }

  /** Finished jobs, newest first — the shape `/queue/status` has always returned. */
  function recent(limit = 50) {
    return stmts.recent.all(limit).map((row) => ({
      id: row.id,
      type: row.type,
      target: row.target,
      status: row.status,
      error: row.error,
      finishedAt: row.finished_at,
    }));
  }

  /**
   * Returns jobs abandoned mid-flight by a crash back to `pending`.
   * Called once at startup, before processing resumes.
   *
   * @returns {number} how many jobs were recovered
   */
  function recoverInterrupted() {
    return stmts.recover.run().changes;
  }

  /**
   * Deletes finished jobs older than `days`, keeping the database bounded.
   * Pending jobs are never touched.
   *
   * @returns {number} how many rows were deleted
   */
  function prune(days) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return stmts.prune.run(cutoff).changes;
  }

  function close() {
    db.close();
  }

  return {
    enqueue,
    get,
    peekNext,
    claim,
    claimNext,
    markSent,
    markError,
    pendingCount,
    recent,
    recoverInterrupted,
    prune,
    close,
  };
}

module.exports = { createJobStore, LANES };
