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
 * @returns {{stop: function}}
 */
function createInboundCapture({ transport, store, logger }) {
  const unsubscribe = transport.onMessage((msg) => {
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
