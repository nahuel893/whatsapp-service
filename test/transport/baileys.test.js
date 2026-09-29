"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createBaileysTransport } = require("../../lib/transport/baileys");
const { runTransportContract } = require("./contract-suite");

const PHONE = "5490000000000";

/**
 * Stand-in for the manager returned by lib/baileys.js createManager(): the
 * adapter only ever sees this surface, never the Baileys module itself.
 */
function createFakeManager({ groups = { "123@g.us": { id: "123@g.us", subject: "Equipo Ventas" } } } = {}) {
  let connected = false;
  let phone = null;
  let counter = 0;
  const handlers = new Set();
  const sent = [];
  const calls = { connect: 0, disconnect: 0, groupFetch: 0 };

  const sock = {
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: `WA-${++counter}` } };
    },
    async groupFetchAllParticipating() {
      calls.groupFetch++;
      return groups;
    },
  };

  const manager = {
    async connect() {
      calls.connect++;
    },
    async disconnect() {
      calls.disconnect++;
      connected = false;
    },
    getStatus() {
      return { connected, phone, connectedAt: connected ? 1 : null };
    },
    getSock() {
      return sock;
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  return {
    manager,
    sent,
    calls,
    open() {
      connected = true;
      phone = PHONE;
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
    upsert(messages, type = "notify") {
      for (const handler of handlers) handler({ type: "messages.upsert", data: { messages, type } });
    },
  };
}

/** Provider-shaped content back to the domain shape, for the contract suite. */
function toDomainContent(content) {
  if ("text" in content) return { text: content.text };
  if ("image" in content) {
    return { image: { data: content.image, mimetype: content.mimetype }, caption: content.caption };
  }
  return {
    document: { data: content.document, fileName: content.fileName, mimetype: content.mimetype },
    caption: content.caption,
  };
}

let injected = 0;

/** Builds the upsert WhatsApp would deliver for a text coming from `uri`. */
function inboundFor(uri, text) {
  const id = `IN-${++injected}`;
  const messageTimestamp = 1_767_225_600; // 2026-01-01T00:00:00Z, in seconds
  if (uri.startsWith("whatsapp:group:")) {
    return {
      key: {
        id,
        fromMe: false,
        remoteJid: `${uri.slice("whatsapp:group:".length)}@g.us`,
        participant: "777@lid",
        participantAlt: "5491111111111@s.whatsapp.net",
      },
      message: { conversation: text },
      messageTimestamp,
    };
  }
  return {
    key: {
      id,
      fromMe: false,
      remoteJid: "100000000000000@lid",
      remoteJidAlt: `${uri.slice("whatsapp:+".length)}@s.whatsapp.net`,
    },
    message: { conversation: text },
    messageTimestamp,
  };
}

runTransportContract("BaileysTransport (mocked socket)", async () => {
  const fake = createFakeManager();
  const transport = createBaileysTransport(fake.manager);
  return {
    transport,
    addresses: [`whatsapp:+${PHONE}`, "whatsapp:group:120363000000000000", "whatsapp:lid:100000000000000"],
    foreignAddresses: ["memory:alice", "whatsapp:", "whatsapp:5490000000000", "whatsapp:+54 9", "whatsapp:group:"],
    open: async () => fake.open(),
    inject: async (uri, text) => fake.upsert([inboundFor(uri, text)]),
    lastSent: () => {
      const { jid, content } = fake.sent.at(-1);
      return { address: transport.formatAddress({ jid }), content: toDomainContent(content) };
    },
  };
});

describe("BaileysTransport — provider specifics", () => {
  test("status() reports the paired phone as a whatsapp: identity", () => {
    const fake = createFakeManager();
    const transport = createBaileysTransport(fake.manager);
    fake.open();
    assert.deepEqual(transport.status(), { connected: true, identity: `whatsapp:+${PHONE}` });
  });

  test("connect() and disconnect() delegate to the manager", async () => {
    const fake = createFakeManager();
    const transport = createBaileysTransport(fake.manager);
    await transport.connect();
    await transport.disconnect();
    assert.deepEqual([fake.calls.connect, fake.calls.disconnect], [1, 1]);
  });

  test("send() hands Baileys exactly the content shapes used today", async () => {
    const fake = createFakeManager();
    const transport = createBaileysTransport(fake.manager);
    const addr = { jid: `${PHONE}@s.whatsapp.net` };

    await transport.send(addr, { text: "hola" });
    await transport.send(addr, { image: { data: Buffer.from("p"), mimetype: "image/png" }, caption: "c" });
    await transport.send(addr, {
      document: { data: Buffer.from("x"), fileName: "a.xlsx", mimetype: "application/x" },
      caption: "d",
    });

    assert.deepEqual(fake.sent[0].content, { text: "hola" });
    assert.deepEqual(Object.keys(fake.sent[1].content).sort(), ["caption", "image", "mimetype"]);
    assert.deepEqual(Object.keys(fake.sent[2].content).sort(), ["caption", "document", "fileName", "mimetype"]);
  });

  test("send() still returns an id when Baileys resolves without a message", async () => {
    const fake = createFakeManager();
    fake.manager.getSock().sendMessage = async () => undefined;
    const transport = createBaileysTransport(fake.manager);
    const { externalId } = await transport.send({ jid: `${PHONE}@s.whatsapp.net` }, { text: "x" });
    assert.equal(typeof externalId, "string");
    assert.ok(externalId.length > 0);
  });

  test("send() rejects content it does not know", async () => {
    const transport = createBaileysTransport(createFakeManager().manager);
    await assert.rejects(transport.send({ jid: "1@s.whatsapp.net" }, { sticker: {} }));
  });

  test("formatAddress() drops the device suffix of a JID", () => {
    const transport = createBaileysTransport(createFakeManager().manager);
    assert.equal(transport.formatAddress({ jid: `${PHONE}:12@s.whatsapp.net` }), `whatsapp:+${PHONE}`);
  });

  describe("inbound mapping", () => {
    function setup() {
      const fake = createFakeManager();
      const transport = createBaileysTransport(fake.manager);
      const received = [];
      transport.onMessage((msg) => received.push(msg));
      return { fake, received };
    }

    test("a DM addressed by LID is reported by phone when WhatsApp provides it", () => {
      const { fake, received } = setup();
      fake.upsert([inboundFor(`whatsapp:+${PHONE}`, "hola")]);
      assert.equal(received[0].address, `whatsapp:+${PHONE}`);
      assert.equal(received[0].author, `whatsapp:+${PHONE}`);
      assert.equal(received[0].at, "2026-01-01T00:00:00.000Z");
    });

    test("a DM with no phone alternative keeps the LID address", () => {
      const { fake, received } = setup();
      fake.upsert([{ key: { id: "A", remoteJid: "100000000000000@lid" }, message: { conversation: "x" } }]);
      assert.equal(received[0].address, "whatsapp:lid:100000000000000");
    });

    test("a group message has the group as address and the sender as author", () => {
      const { fake, received } = setup();
      fake.upsert([inboundFor("whatsapp:group:123", "hola grupo")]);
      assert.equal(received[0].address, "whatsapp:group:123");
      assert.equal(received[0].author, "whatsapp:+5491111111111");
    });

    test("text is read from extended text and from media captions", () => {
      const { fake, received } = setup();
      fake.upsert([
        { key: { id: "A", remoteJid: `${PHONE}@s.whatsapp.net` }, message: { extendedTextMessage: { text: "link" } } },
        { key: { id: "B", remoteJid: `${PHONE}@s.whatsapp.net` }, message: { imageMessage: { caption: "foto" } } },
        { key: { id: "C", remoteJid: `${PHONE}@s.whatsapp.net` }, message: { documentMessage: { caption: "doc" } } },
        { key: { id: "D", remoteJid: `${PHONE}@s.whatsapp.net` }, message: { stickerMessage: {} } },
      ]);
      assert.deepEqual(received.map((m) => m.text), ["link", "foto", "doc", null]);
    });

    test("a Long-like timestamp is converted", () => {
      const { fake, received } = setup();
      fake.upsert([
        {
          key: { id: "A", remoteJid: `${PHONE}@s.whatsapp.net` },
          message: { conversation: "x" },
          messageTimestamp: { toNumber: () => 1_767_225_600 },
        },
      ]);
      assert.equal(received[0].at, "2026-01-01T00:00:00.000Z");
    });

    test("own messages, status broadcasts, history and non-message events are ignored", () => {
      const { fake, received } = setup();
      fake.upsert([
        { key: { id: "A", fromMe: true, remoteJid: `${PHONE}@s.whatsapp.net` }, message: { conversation: "eco" } },
        { key: { id: "B", remoteJid: "status@broadcast" }, message: { conversation: "estado" } },
        { key: { id: "C", remoteJid: `${PHONE}@s.whatsapp.net` } },
      ]);
      fake.upsert([{ key: { id: "D", remoteJid: `${PHONE}@s.whatsapp.net` }, message: { conversation: "viejo" } }], "append");
      fake.emit({ connection: "open" });
      assert.equal(received.length, 0);
    });

    test("a throwing handler does not stop the others", () => {
      const { fake, received } = setup();
      const transport = createBaileysTransport(fake.manager);
      transport.onMessage(() => {
        throw new Error("boom");
      });
      fake.upsert([inboundFor(`whatsapp:+${PHONE}`, "hola")]);
      assert.equal(received.length, 1);
    });
  });

  describe("resolveLegacyTarget() — addressing of the pre-port endpoints", () => {
    test("keeps the rules the golden tests freeze", async () => {
      const transport = createBaileysTransport(createFakeManager().manager);
      const cases = [
        ["5490000000000", `${PHONE}@s.whatsapp.net`],
        ["+54 9 000-000-0000", `${PHONE}@s.whatsapp.net`],
        ["120363000000000000@g.us", "120363000000000000@g.us"],
        ["100000000000000@lid", "100000000000000@lid"],
        ["equipo VENTAS", "123@g.us"],
      ];
      for (const [raw, jid] of cases) {
        assert.deepEqual(await transport.resolveLegacyTarget(raw), { jid }, raw);
      }
    });

    test("an unknown group name rejects instead of inventing a JID", async () => {
      const transport = createBaileysTransport(createFakeManager().manager);
      await assert.rejects(transport.resolveLegacyTarget("Grupo Fantasma"), /No existe un grupo llamado/);
    });

    test("a failed group fetch rejects with the reason", async () => {
      const fake = createFakeManager();
      fake.manager.getSock().groupFetchAllParticipating = async () => {
        throw new Error("rate-overlimit");
      };
      const transport = createBaileysTransport(fake.manager);
      await assert.rejects(
        transport.resolveLegacyTarget("Equipo Ventas"),
        /No se pudo leer la lista de grupos.*rate-overlimit/
      );
    });

    test("the group list is fetched once for a burst of sends", async () => {
      const fake = createFakeManager();
      const transport = createBaileysTransport(fake.manager);
      for (let i = 0; i < 5; i++) await transport.resolveLegacyTarget("Equipo Ventas");
      assert.equal(fake.calls.groupFetch, 1);
    });
  });
});
