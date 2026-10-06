/**
 * Webhook dispatcher — pushes inbound messages to subscribed consumers (F4b).
 *
 * The webhook does not replace the cursor, it gets ahead of it (design D4):
 * the message is already in the store when this runs. A delivery is retried
 * a bounded number of times and then abandoned; the consumer recovers what it
 * missed by reading from its cursor. No per-subscriber delivery queue.
 *
 * Every delivery is signed so the consumer can verify it came from this
 * service and reject replays:
 *
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *   X-Webhook-Id:        <deliveryId, the same across retries — dedup key>
 */
"use strict";

const crypto = require("node:crypto");

const { publicMessage } = require("./chat-api");

const EVENTS = { created: "message.created", completed: "message.updated" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} deps
 * @param {{active: function}} deps.subscriptions — subscription store
 * @param {(principalId: string, conversationId: string) => boolean} deps.canSee
 *   — the same visibility rule as reading: a grant, or scope all
 * @param {function} [deps.fetch] — defaults to the global fetch
 * @param {{info: function, warn: function}} deps.logger
 * @param {number[]} [deps.retryDelaysMs] — waits before each retry
 * @param {number} [deps.timeoutMs] — per attempt
 */
function createWebhookDispatcher({
  subscriptions,
  canSee,
  fetch = globalThis.fetch,
  logger,
  retryDelaysMs = [1_000, 5_000, 25_000],
  timeoutMs = 5_000,
}) {
  async function attempt(sub, body) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac("sha256", sub.secret).update(`${timestamp}.${body}`).digest("hex");
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-id": JSON.parse(body).deliveryId,
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async function deliver(sub, payload) {
    const body = JSON.stringify(payload);
    const ids = { subscriptionId: sub.id, deliveryId: payload.deliveryId, messageId: payload.message.id };
    let lastError;
    for (let i = 0; i <= retryDelaysMs.length; i++) {
      if (i > 0) await sleep(retryDelaysMs[i - 1]);
      try {
        await attempt(sub, body);
        logger.info({ ...ids, attempts: i + 1 }, "Webhook entregado");
        return;
      } catch (err) {
        lastError = err;
      }
    }
    // Abandoned, not lost: the message is in the store and the consumer
    // reads it from its cursor.
    logger.warn(
      { ...ids, attempts: retryDelaysMs.length + 1, error: String(lastError?.message || lastError) },
      "Webhook abandonado; el consumidor lo recupera por cursor"
    );
  }

  /**
   * Delivers one stored message to every subscriber allowed to see it.
   * Resolves when every delivery finished or was abandoned; never rejects.
   * Callers that must not wait (the inbound capture) simply do not await it.
   */
  async function dispatch({ conversation, message, outcome }) {
    const event = EVENTS[outcome];
    if (!event) return;

    const targets = subscriptions.active().filter((sub) => canSee(sub.principalId, conversation.id));
    await Promise.all(
      targets.map((sub) =>
        deliver(sub, {
          event,
          deliveryId: `dlv_${crypto.randomBytes(8).toString("hex")}`,
          conversation: { id: conversation.id, channel: conversation.channel, address: conversation.address },
          message: publicMessage(message),
        })
      )
    );
  }

  return { dispatch };
}

/**
 * The visibility rule for webhooks, built on the principal store — the same
 * rule reading applies: the implicit legacy key and scope `all` see every
 * conversation, any other principal only the ones granted to it, and a
 * revoked principal sees nothing.
 */
function canSeeWith(principals) {
  return (principalId, conversationId) => {
    if (principalId === "legacy") return true;
    const principal = principals.get(principalId);
    if (!principal || principal.revokedAt) return false;
    return principal.scope === "all" || principals.isGranted(principalId, conversationId);
  };
}

module.exports = { createWebhookDispatcher, canSeeWith };
