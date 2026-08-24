/**
 * Message queue — serializes outbound WhatsApp sends with a configurable delay.
 *
 * The HTTP API returns immediately after enqueuing. Jobs live in SQLite
 * (see lib/job-store.js), are processed one at a time, and wait a randomized
 * delay before each actual send.
 *
 * Jobs are data, not closures: each carries a `type` that maps to a handler
 * registered by the API layer. That is what lets a job outlive the process
 * that accepted it — a restart replays whatever was still pending.
 */
"use strict";

const RECENT_LIMIT = 50;

function parseIntEnv(name, fallback) {
  const value = parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * @param {object} options
 * @param {object} options.store — a job store from createJobStore()
 * @param {number} [options.minDelayMs]
 * @param {number} [options.maxDelayMs]
 */
function createMessageQueue(options = {}) {
  const store = options.store;
  if (!store) throw new Error("createMessageQueue requiere un store");

  const minDelayMs = options.minDelayMs ?? parseIntEnv("MESSAGE_QUEUE_MIN_DELAY_MS", 60_000);
  const maxDelayMs = options.maxDelayMs ?? parseIntEnv("MESSAGE_QUEUE_MAX_DELAY_MS", 120_000);

  const handlers = new Map();
  let processing = false;

  function delayMs() {
    const min = Math.max(0, Math.min(minDelayMs, maxDelayMs));
    const max = Math.max(min, Math.max(minDelayMs, maxDelayMs));
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Registers the function that performs a send for one job type.
   *
   * @param {string} type
   * @param {function(object): Promise<void>} handler — receives the stored job
   */
  function registerHandler(type, handler) {
    handlers.set(type, handler);
  }

  async function processNext() {
    if (processing) return;
    processing = true;

    try {
      for (;;) {
        const job = store.claimNext();
        if (!job) break;

        const wait = delayMs();
        log("message_queue_wait", {
          id: job.id,
          type: job.type,
          target: job.target,
          delay_ms: wait,
          pending: store.pendingCount(),
        });
        await sleep(wait);

        try {
          const handler = handlers.get(job.type);
          if (!handler) {
            throw new Error(`No hay handler registrado para el tipo "${job.type}"`);
          }
          await handler(job);
          store.markSent(job.id);
          log("message_queue_sent", {
            id: job.id,
            type: job.type,
            target: job.target,
            pending: store.pendingCount(),
          });
        } catch (err) {
          store.markError(job.id, err);
          console.error(JSON.stringify({
            event: "message_queue_error",
            id: job.id,
            type: job.type,
            target: job.target,
            error: String(err.message || err),
            pending: store.pendingCount(),
          }));
        }
      }
    } finally {
      processing = false;
    }
  }

  function kick() {
    processNext().catch((err) => {
      console.error(JSON.stringify({
        event: "message_queue_fatal",
        error: String(err.message || err),
      }));
    });
  }

  /**
   * Persists a job and starts processing. Returns as soon as it is durable —
   * the id is safe to hand back to the caller and poll later.
   *
   * @returns {{id: number}}
   */
  function enqueue({ type, target, payload = {}, media = null }) {
    const job = store.enqueue({ type, target, payload, media });
    kick();
    return job;
  }

  /**
   * Recovers jobs interrupted by a crash and resumes processing.
   * Call once at startup, after every handler is registered.
   */
  function start() {
    const recovered = store.recoverInterrupted();
    if (recovered > 0) {
      log("message_queue_recovered", { jobs: recovered });
    }
    kick();
    return { recovered };
  }

  function getStatus() {
    return {
      pending: store.pendingCount(),
      processing,
      minDelayMs,
      maxDelayMs,
      recent: store.recent(RECENT_LIMIT),
    };
  }

  /** Full record of a single job, including its terminal status. */
  function getJob(id) {
    const job = store.get(id);
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      target: job.target,
      status: job.status,
      error: job.error,
      attempts: job.attempts,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  return { registerHandler, enqueue, start, getStatus, getJob };
}

module.exports = { createMessageQueue };
