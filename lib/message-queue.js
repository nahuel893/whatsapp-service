/**
 * Message queue — serializes outbound WhatsApp sends with a configurable delay.
 *
 * The HTTP API returns immediately after enqueuing. Jobs are processed in-memory,
 * one at a time, waiting 1-2 minutes before each actual send by default.
 */
"use strict";

function parseIntEnv(name, fallback) {
  const value = parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function createMessageQueue(options = {}) {
  const minDelayMs = options.minDelayMs ?? parseIntEnv("MESSAGE_QUEUE_MIN_DELAY_MS", 60_000);
  const maxDelayMs = options.maxDelayMs ?? parseIntEnv("MESSAGE_QUEUE_MAX_DELAY_MS", 120_000);

  let nextId = 1;
  let processing = false;
  const queue = [];
  const recent = [];

  function delayMs() {
    const min = Math.max(0, Math.min(minDelayMs, maxDelayMs));
    const max = Math.max(min, Math.max(minDelayMs, maxDelayMs));
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function remember(job, status, error = null) {
    recent.unshift({
      id: job.id,
      type: job.type,
      target: job.target,
      status,
      error: error ? String(error.message || error) : null,
      finishedAt: new Date().toISOString(),
    });
    recent.splice(50);
  }

  async function processNext() {
    if (processing) return;
    processing = true;

    try {
      while (queue.length > 0) {
        const job = queue.shift();
        const wait = delayMs();
        console.log(JSON.stringify({
          event: "message_queue_wait",
          id: job.id,
          type: job.type,
          target: job.target,
          delay_ms: wait,
          pending: queue.length,
        }));
        await sleep(wait);

        try {
          await job.run();
          remember(job, "sent");
          console.log(JSON.stringify({
            event: "message_queue_sent",
            id: job.id,
            type: job.type,
            target: job.target,
            pending: queue.length,
          }));
        } catch (err) {
          remember(job, "error", err);
          console.error(JSON.stringify({
            event: "message_queue_error",
            id: job.id,
            type: job.type,
            target: job.target,
            error: String(err.message || err),
            pending: queue.length,
          }));
        }
      }
    } finally {
      processing = false;
    }
  }

  function enqueue({ type, target, run }) {
    const job = {
      id: nextId++,
      type,
      target,
      run,
      queuedAt: new Date().toISOString(),
    };
    queue.push(job);
    processNext().catch((err) => {
      console.error(JSON.stringify({
        event: "message_queue_fatal",
        error: String(err.message || err),
      }));
    });
    return job;
  }

  function getStatus() {
    return {
      pending: queue.length,
      processing,
      minDelayMs,
      maxDelayMs,
      recent,
    };
  }

  return { enqueue, getStatus };
}

module.exports = { createMessageQueue };
