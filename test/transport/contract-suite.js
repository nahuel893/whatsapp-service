/*
 * Shared contract suite for ChatTransport implementations.
 *
 * Every adapter runs this exact suite. If a test passes against one adapter
 * and fails against another, the abstraction leaks: fix the adapter, never
 * specialise the suite.
 *
 * `makeFixture()` must resolve to:
 *   transport            the ChatTransport under test
 *   addresses            URIs that must round-trip through parse/format
 *   foreignAddresses     URIs this transport must reject
 *   open()               makes the provider report the connection as open
 *   inject(uri, text)    makes the provider deliver an inbound text from uri
 *   lastSent()           { address, content } of the last provider-level send,
 *                        with content in domain shape
 */
"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { assertTransport } = require("../../lib/transport/contract");

const CAPABILITIES = ["media", "replyTo", "groups", "readReceipts", "typing"];

function runTransportContract(name, makeFixture) {
  describe(`ChatTransport contract: ${name}`, () => {
    test("implements every method of the port", async () => {
      const { transport } = await makeFixture();
      assert.doesNotThrow(() => assertTransport(transport));
    });

    test("status() is disconnected until the provider opens", async () => {
      const { transport, open } = await makeFixture();
      assert.deepEqual(transport.status(), { connected: false, identity: null });

      await transport.connect();
      await open();
      const status = transport.status();
      assert.equal(status.connected, true);
      assert.equal(typeof status.identity, "string");
      assert.ok(status.identity.length > 0);
    });

    test("disconnect() leaves the transport disconnected", async () => {
      const { transport, open } = await makeFixture();
      await transport.connect();
      await open();
      await transport.disconnect();
      assert.equal(transport.status().connected, false);
    });

    test("capabilities() declares every capability as a boolean", async () => {
      const { transport } = await makeFixture();
      const caps = transport.capabilities();
      assert.deepEqual(Object.keys(caps).sort(), [...CAPABILITIES].sort());
      for (const key of CAPABILITIES) {
        assert.equal(typeof caps[key], "boolean", key);
      }
    });

    test("addresses round-trip through parseAddress/formatAddress", async () => {
      const { transport, addresses } = await makeFixture();
      assert.ok(addresses.length > 0);
      for (const uri of addresses) {
        assert.equal(transport.formatAddress(transport.parseAddress(uri)), uri);
      }
    });

    test("parseAddress rejects other channels and malformed URIs", async () => {
      const { transport, foreignAddresses } = await makeFixture();
      for (const uri of [...foreignAddresses, "", "not-a-uri", 42, null]) {
        assert.throws(() => transport.parseAddress(uri), undefined, String(uri));
      }
    });

    test("send() delivers text and returns a provider message id", async () => {
      const { transport, open, addresses, lastSent } = await makeFixture();
      await transport.connect();
      await open();

      const [uri] = addresses;
      const result = await transport.send(transport.parseAddress(uri), { text: "hola" });
      assert.equal(typeof result.externalId, "string");
      assert.ok(result.externalId.length > 0);
      assert.deepEqual(lastSent(), { address: uri, content: { text: "hola" } });
    });

    test("send() returns a distinct id per message", async () => {
      const { transport, open, addresses } = await makeFixture();
      await transport.connect();
      await open();

      const addr = transport.parseAddress(addresses[0]);
      const a = await transport.send(addr, { text: "a" });
      const b = await transport.send(addr, { text: "b" });
      assert.notEqual(a.externalId, b.externalId);
    });

    test("send() delivers media when the channel supports it", async (t) => {
      const { transport, open, addresses, lastSent } = await makeFixture();
      if (!transport.capabilities().media) return t.skip("channel has no media");
      await transport.connect();
      await open();

      const addr = transport.parseAddress(addresses[0]);
      const image = { image: { data: Buffer.from("png"), mimetype: "image/png" }, caption: "c" };
      await transport.send(addr, image);
      assert.deepEqual(lastSent().content, image);

      const doc = {
        document: { data: Buffer.from("xlsx"), fileName: "a.xlsx", mimetype: "application/x" },
        caption: "",
      };
      await transport.send(addr, doc);
      assert.deepEqual(lastSent().content, doc);
    });

    test("onMessage() emits inbound messages in domain shape", async () => {
      const { transport, open, addresses, inject } = await makeFixture();
      await transport.connect();
      await open();

      const received = [];
      transport.onMessage((msg) => received.push(msg));
      await inject(addresses[0], "buenas");

      assert.equal(received.length, 1);
      const [msg] = received;
      assert.deepEqual(Object.keys(msg).sort(), [
        "address",
        "at",
        "author",
        "externalId",
        "status",
        "text",
      ]);
      assert.equal(msg.status, "received");
      assert.equal(msg.address, addresses[0]);
      assert.equal(typeof msg.author, "string");
      assert.equal(msg.text, "buenas");
      assert.equal(typeof msg.externalId, "string");
      assert.ok(msg.externalId.length > 0);
      assert.equal(Number.isNaN(Date.parse(msg.at)), false, "at must be an ISO date");
    });

    test("onMessage() returns an unsubscribe that stops delivery", async () => {
      const { transport, open, addresses, inject } = await makeFixture();
      await transport.connect();
      await open();

      const received = [];
      const unsubscribe = transport.onMessage((msg) => received.push(msg));
      assert.equal(typeof unsubscribe, "function");
      unsubscribe();
      await inject(addresses[0], "nadie escucha");
      assert.equal(received.length, 0);
    });
  });
}

module.exports = { runTransportContract };
