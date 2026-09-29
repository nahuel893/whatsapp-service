/**
 * MemoryTransport — a ChatTransport with no network and no provider.
 *
 * Not only a test double: it is the second implementation of the port, and
 * the proof that the port does not secretly assume WhatsApp. An interface
 * with a single implementer is not tested, it is assumed.
 *
 * Addresses look like "memory:<id>". Outbound sends are recorded in `outbox`;
 * inbound messages are simulated with `receive()`.
 */
"use strict";

const PREFIX = "memory:";
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function createMemoryTransport({ identity = "memory:self" } = {}) {
  let connected = false;
  let counter = 0;
  const handlers = new Set();
  const outbox = [];

  function parseAddress(uri) {
    if (typeof uri !== "string" || !uri.startsWith(PREFIX)) {
      throw new TypeError(`not a memory address: ${uri}`);
    }
    const id = uri.slice(PREFIX.length);
    if (!ID_PATTERN.test(id)) {
      throw new TypeError(`malformed memory address: ${uri}`);
    }
    return { id };
  }

  function formatAddress(addr) {
    return `${PREFIX}${addr.id}`;
  }

  return {
    outbox,

    async connect() {
      connected = true;
    },

    async disconnect() {
      connected = false;
    },

    status() {
      return { connected, identity: connected ? identity : null };
    },

    capabilities() {
      return { media: true, replyTo: false, groups: false, readReceipts: false, typing: false };
    },

    parseAddress,
    formatAddress,

    async send(addr, content) {
      const externalId = `mem-out-${++counter}`;
      outbox.push({ address: formatAddress(addr), content, externalId });
      return { externalId };
    },

    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    /**
     * Simulates an inbound message. `address` is the conversation; `author`
     * defaults to it, as in a one-to-one chat.
     */
    receive({ address, author, text = null, externalId, at }) {
      parseAddress(address);
      const msg = {
        externalId: externalId ?? `mem-in-${++counter}`,
        address,
        author: author ?? address,
        text,
        at: at ?? new Date().toISOString(),
      };
      for (const handler of handlers) handler(msg);
      return msg;
    },
  };
}

module.exports = { createMemoryTransport };
