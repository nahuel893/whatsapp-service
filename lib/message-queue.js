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
 *
 * Two lanes (design D6), still one send at a time:
 *   bulk          unsolicited sends (reports, notifications). Waits the full
 *                 [min, max] delay before every send — the anti-spam pacing.
 *   conversation  replies to someone who just wrote. Goes first, and only
 *                 keeps a short human-like floor since the previous send.
 * A reply that arrives while a bulk job is waiting interrupts that wait and
 * goes out; the bulk job then starts its full delay over, so bulk spacing is
 * never shortened by a reply.
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
 * @param {number} [options.conversationMinDelayMs] — floor between a reply and
 *   the previous send
 * @param {number} [options.conversationMaxDelayMs]
 */
function createMessageQueue(options = {}) {
  const store = options.store;
  if (!store) throw new Error("createMessageQueue requiere un store");

  const minDelayMs = options.minDelayMs ?? parseIntEnv("MESSAGE_QUEUE_MIN_DELAY_MS", 60_000);
  const maxDelayMs = options.maxDelayMs ?? parseIntEnv("MESSAGE_QUEUE_MAX_DELAY_MS", 120_000);

  const conversationMinDelayMs =
    options.conversationMinDelayMs ?? parseIntEnv("CONVERSATION_MIN_DELAY_MS", 1_500);
  const conversationMaxDelayMs =
    options.conversationMaxDelayMs ?? parseIntEnv("CONVERSATION_MAX_DELAY_MS", 4_000);

  const handlers = new Map();
  let processing = false;
  let lastSendAt = 0;
  // While the worker waits on a bulk job, a reply may cut the wait short.
  let interruptBulkWait = null;

  function randomBetween(a, b) {
    const min = Math.max(0, Math.min(a, b));
    const max = Math.max(min, Math.max(a, b));
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /** How long to wait before sending `job`, given its lane. */
  function waitFor(job) {
    if (job.lane === "conversation") {
      const floor = randomBetween(conversationMinDelayMs, conversationMaxDelayMs);
      return Math.max(0, lastSendAt + floor - Date.now());
    }
    return randomBetween(minDelayMs, maxDelayMs);
  }

  /** Sleeps `ms`; resolves true if a reply interrupted a bulk wait. */
  function waitInterruptibly(ms, lane) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        interruptBulkWait = null;
        resolve(false);
      }, ms);
      if (lane === "bulk") {
        interruptBulkWait = () => {
          clearTimeout(timer);
          interruptBulkWait = null;
          resolve(true);
        };
      }
    });
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
        // Look first, take after the wait: a job waiting its delay stays
        // pending, so a reply can overtake it and a crash leaves it intact.
        const next = store.peekNext();
        if (!next) break;

        const wait = waitFor(next);
        if (wait > 0) {
          log("message_queue_wait", {
            id: next.id,
            type: next.type,
            lane: next.lane,
            target: next.target,
            delay_ms: wait,
            pending: store.pendingCount(),
          });
          if (await waitInterruptibly(wait, next.lane)) continue;
        }

        const job = store.claim(next.id);
        if (!job) continue;

        try {
          const handler = handlers.get(job.type);
          if (!handler) {
            throw new Error(`No hay handler registrado para el tipo "${job.type}"`);
          }
          await handler(job);
          lastSendAt = Date.now();
          store.markSent(job.id);
          log("message_queue_sent", {
            id: job.id,
            type: job.type,
            target: job.target,
            pending: store.pendingCount(),
          });
        } catch (err) {
          lastSendAt = Date.now();
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
  function enqueue({ type, target, payload = {}, media = null, lane = "bulk" }) {
    const job = store.enqueue({ type, target, payload, media, lane });
    if (lane === "conversation" && interruptBulkWait) interruptBulkWait();
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
