/**
 * BaileysTransport — the WhatsApp adapter of the ChatTransport port.
 *
 * Wraps the connection manager from lib/baileys.js. It is the only place that
 * knows what a JID is: everything it emits or accepts through the port is a
 * "whatsapp:" URI or a domain-shaped object.
 *
 * Address URIs:
 *   whatsapp:+<digits>     a contact, by phone number
 *   whatsapp:group:<id>    a group
 *   whatsapp:lid:<id>      a contact WhatsApp only identified by LID
 *
 * An inbound message addressed by LID is reported by phone whenever WhatsApp
 * supplies the alternative (remoteJidAlt / participantAlt): the phone is what
 * a consumer already knows, and it is stable across LID migrations.
 */
"use strict";

const crypto = require("node:crypto");

const PN_SUFFIX = "@s.whatsapp.net";
const GROUP_SUFFIX = "@g.us";
const LID_SUFFIX = "@lid";

const GROUP_CACHE_MS = 60_000;

// proto.WebMessageInfo.StubType.CIPHERTEXT: Baileys could not decrypt the
// message. It asks the sender to retry, and the decrypted message arrives
// later with the same key id.
const STUB_CIPHERTEXT = 2;

/** "5490000000000:12@s.whatsapp.net" → "5490000000000" */
function userPart(jid) {
  return jid.slice(0, jid.indexOf("@")).split(":")[0];
}

function jidToUri(jid) {
  if (typeof jid === "string") {
    if (jid.endsWith(PN_SUFFIX)) return `whatsapp:+${userPart(jid)}`;
    if (jid.endsWith(GROUP_SUFFIX)) return `whatsapp:group:${userPart(jid)}`;
    if (jid.endsWith(LID_SUFFIX)) return `whatsapp:lid:${userPart(jid)}`;
  }
  throw new TypeError(`JID with no whatsapp: address form: ${jid}`);
}

function parseAddress(uri) {
  if (typeof uri === "string") {
    let match = /^whatsapp:\+(\d+)$/.exec(uri);
    if (match) return { jid: `${match[1]}${PN_SUFFIX}` };
    match = /^whatsapp:group:([0-9-]+)$/.exec(uri);
    if (match) return { jid: `${match[1]}${GROUP_SUFFIX}` };
    match = /^whatsapp:lid:(\d+)$/.exec(uri);
    if (match) return { jid: `${match[1]}${LID_SUFFIX}` };
  }
  throw new TypeError(`not a whatsapp address: ${uri}`);
}

function formatAddress(addr) {
  return jidToUri(addr.jid);
}

/** Domain OutboundContent → the content object Baileys' sendMessage takes. */
function toProviderContent(content) {
  if (content && typeof content.text === "string") {
    return { text: content.text };
  }
  if (content && content.image) {
    return {
      image: content.image.data,
      caption: content.caption || "",
      mimetype: content.image.mimetype,
    };
  }
  if (content && content.document) {
    return {
      document: content.document.data,
      fileName: content.document.fileName,
      caption: content.caption || "",
      mimetype: content.document.mimetype,
    };
  }
  throw new TypeError("unsupported outbound content");
}

function textOf(message) {
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    null
  );
}

function isoFrom(timestamp) {
  if (timestamp == null) return new Date().toISOString();
  const seconds = typeof timestamp.toNumber === "function" ? timestamp.toNumber() : Number(timestamp);
  return new Date(seconds * 1000).toISOString();
}

/**
 * Maps one Baileys WAMessage to an InboundMessage, or null when it is not a
 * message a consumer should see (own echo, status broadcast, no content).
 */
function toInbound(waMessage) {
  const key = waMessage?.key;
  const undecryptable = waMessage?.messageStubType === STUB_CIPHERTEXT;
  if (!key || key.fromMe || (!waMessage.message && !undecryptable)) return null;
  if (!key.remoteJid || key.remoteJid === "status@broadcast") return null;

  const isGroup = key.remoteJid.endsWith(GROUP_SUFFIX);
  const chatJid = isGroup ? key.remoteJid : key.remoteJidAlt ?? key.remoteJid;
  const authorJid = isGroup ? key.participantAlt ?? key.participant ?? chatJid : chatJid;

  try {
    return {
      externalId: key.id,
      address: jidToUri(chatJid),
      author: jidToUri(authorJid),
      text: undecryptable ? null : textOf(waMessage.message),
      status: undecryptable ? "undecryptable" : "received",
      kind: isGroup ? "group" : "direct",
      at: isoFrom(waMessage.messageTimestamp),
    };
  } catch {
    // An addressing form the port has no URI for (e.g. a newsletter).
    return null;
  }
}

/**
 * @param {object} manager — the connection manager from createManager()
 * @param {object} [options]
 * @param {{warn: function}} [options.logger]
 * @returns {import("./contract").ChatTransport & {resolveLegacyTarget: function}}
 */
function createBaileysTransport(manager, { logger = console } = {}) {
  const handlers = new Set();
  let unsubscribeProvider = null;
  let groupCache = { at: 0, byName: new Map() };

  function dispatch(event) {
    if (event?.type !== "messages.upsert" || event.data?.type !== "notify") return;
    for (const waMessage of event.data.messages || []) {
      const msg = toInbound(waMessage);
      if (!msg) continue;
      for (const handler of handlers) {
        const fail = (err) => logger.warn(`inbound handler failed: ${err?.message ?? err}`);
        try {
          // An async handler's rejection would otherwise be unhandled, which
          // Node's default policy turns into a process crash.
          Promise.resolve(handler(msg)).catch(fail);
        } catch (err) {
          fail(err);
        }
      }
    }
  }

  // The group list is a network call to WhatsApp. Fetching it once per
  // message saturates it during a batch (the daily sends dozens of images in
  // seconds), so it is cached briefly.
  async function groupsByName(sock) {
    if (Date.now() - groupCache.at < GROUP_CACHE_MS && groupCache.byName.size) {
      return groupCache.byName;
    }
    const groups = await sock.groupFetchAllParticipating();
    const byName = new Map();
    for (const g of Object.values(groups)) {
      byName.set(String(g.subject).toLowerCase(), g.id);
    }
    groupCache = { at: Date.now(), byName };
    return byName;
  }

  return {
    async connect() {
      await manager.connect();
    },

    async disconnect() {
      if (typeof manager.disconnect === "function") await manager.disconnect();
    },

    status() {
      const { connected, phone } = manager.getStatus();
      return { connected: Boolean(connected), identity: phone ? `whatsapp:+${phone}` : null };
    },

    capabilities() {
      return { media: true, replyTo: true, groups: true, readReceipts: true, typing: true };
    },

    parseAddress,
    formatAddress,

    async send(addr, content) {
      const providerContent = toProviderContent(content);
      const result = await manager.getSock().sendMessage(addr.jid, providerContent);
      // Baileys may resolve without the sent message; the id is then ours.
      return { externalId: result?.key?.id || `local-${crypto.randomUUID()}` };
    },

    onMessage(handler) {
      handlers.add(handler);
      if (!unsubscribeProvider) {
        unsubscribeProvider = manager.onEvent(dispatch) || (() => {});
      }
      return () => {
        handlers.delete(handler);
      };
    },

    /**
     * Resolves a target as the pre-port endpoints accept it: a JID, a phone
     * number, or a group name. WhatsApp-specific and NOT part of the port —
     * the conversation endpoints address by URI instead.
     *
     * Never invents a JID. An earlier version, when it could not find the
     * group, stripped the letters from the name and built a phone number out
     * of what was left: the job was marked "sent" towards nobody.
     *
     * @returns {Promise<{jid: string}>}
     */
    async resolveLegacyTarget(target) {
      const raw = String(target);
      if (raw.includes("@")) return { jid: raw };

      const digits = raw.replace(/[^0-9]/g, "");
      if (digits && !/[a-zA-Z]/.test(raw)) return { jid: `${digits}${PN_SUFFIX}` };

      let byName;
      try {
        byName = await groupsByName(manager.getSock());
      } catch (err) {
        throw new Error(`No se pudo leer la lista de grupos para resolver "${raw}": ${err.message}`);
      }
      const jid = byName.get(raw.toLowerCase());
      if (!jid) {
        throw new Error(
          `No existe un grupo llamado "${raw}" entre los ${byName.size} que este numero integra`
        );
      }
      return { jid };
    },
  };
}

module.exports = { createBaileysTransport };
