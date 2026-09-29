"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createMemoryTransport } = require("../../lib/transport/memory");
const { runTransportContract } = require("./contract-suite");

runTransportContract("MemoryTransport", async () => {
  const transport = createMemoryTransport();
  return {
    transport,
    addresses: ["memory:alice", "memory:team-42"],
    foreignAddresses: ["whatsapp:+5490000000000", "memory:", "memory"],
    open: async () => {},
    inject: async (uri, text) => transport.receive({ address: uri, text }),
    lastSent: () => {
      const { address, content } = transport.outbox.at(-1);
      return { address, content };
    },
  };
});

test("MemoryTransport.receive() fills defaults and keeps what the caller gave", () => {
  const transport = createMemoryTransport();
  const received = [];
  transport.onMessage((msg) => received.push(msg));

  transport.receive({
    address: "memory:team",
    author: "memory:bob",
    text: "hola",
    externalId: "ext-1",
    at: "2026-01-01T00:00:00.000Z",
  });
  transport.receive({ address: "memory:alice", text: "sin autor" });

  assert.deepEqual(received[0], {
    externalId: "ext-1",
    address: "memory:team",
    author: "memory:bob",
    text: "hola",
    status: "received",
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(received[1].author, "memory:alice", "author defaults to the conversation address");
});

test("MemoryTransport.receive() rejects an address of another channel", () => {
  const transport = createMemoryTransport();
  assert.throws(() => transport.receive({ address: "whatsapp:+1", text: "x" }));
});

test("MemoryTransport.receive() can simulate a message that could not be decrypted", () => {
  const transport = createMemoryTransport();
  const received = [];
  transport.onMessage((msg) => received.push(msg));

  transport.receive({ address: "memory:alice", text: "ignored", status: "undecryptable" });

  assert.equal(received[0].status, "undecryptable");
  assert.equal(received[0].text, null, "an undecryptable message carries no text");
});
