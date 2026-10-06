/**
 * Inbound capture — persists every message the transport receives.
 *
 * The store is the source of truth (design D4): a message is written here
 * before anything tries to deliver it, so a consumer that is down loses
 * nothing. Nobody reads these messages yet; cursor reads arrive in F4.
 *
 * Logs carry ids and the outcome, never the message text.
 */
"use strict";

/**
 * @param {object} deps
 * @param {import("./transport/contract").ChatTransport} deps.transport
 * @param {{recordInbound: function}} deps.store — a conversation store
 * @param {{info: function, error: function}} deps.logger — pino-style
 * @param {function} [deps.onStored] — called with {conversation, message,
 *   outcome} once a message is stored or completed (not for a duplicate).
 *   The webhook dispatcher hangs here; it must not throw into the capture.
 * @param {boolean} [deps.includeGroups] — capture group messages. Off by
 *   default: a number used by an agent is often also in groups of people who
 *   never addressed the agent, and a group message dropped here is never
 *   stored, listed or pushed to any consumer.
 * @returns {{stop: function}}
 */
function createInboundCapture({ transport, store, logger, onStored = null, includeGroups = false }) {
  const unsubscribe = transport.onMessage((msg) => {
    if (msg?.kind === "group" && !includeGroups) {
      logger.info({ externalId: msg.externalId, reason: "group" }, "Mensaje entrante descartado");
      return;
    }
    try {
      const { conversation, message, outcome } = store.recordInbound(msg);
      logger.info(
        {
          conversationId: conversation.id,
          messageId: message.id,
          seq: message.seq,
          status: message.status,
          outcome,
        },
        "Mensaje entrante registrado"
      );
      if (onStored && outcome !== "duplicate") {
        try {
          onStored({ conversation, message, outcome });
        } catch (err) {
          logger.error({ err, messageId: message.id }, "Falló la notificación de un mensaje entrante");
        }
      }
    } catch (err) {
      // Never throw into the transport: a storage failure must not take the
      // connection down. The provider id is logged so the gap is traceable.
      logger.error(
        { err, externalId: msg?.externalId, address: msg?.address },
        "No se pudo registrar un mensaje entrante"
      );
    }
  });

  return { stop: unsubscribe };
}

module.exports = { createInboundCapture };
