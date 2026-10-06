/**
 * ChatTransport — the port between the service and a messaging channel.
 *
 * A transport owns one account on one channel. It translates between the
 * provider's addressing and the domain's, and never leaks provider types:
 * everything that crosses this boundary is a plain object in domain shape.
 *
 * Addresses are channel-qualified URIs ("whatsapp:+5490000000000",
 * "memory:alice"). Only the adapter knows what a ProviderAddress looks like;
 * callers obtain one from parseAddress() and hand it back to send().
 *
 * @typedef {object} ChatTransport
 * @property {() => Promise<void>} connect — starts the connection; the
 *   provider may report it open later
 * @property {() => Promise<void>} disconnect
 * @property {() => {connected: boolean, identity: string|null}} status —
 *   `identity` is this account's own address URI, once known
 * @property {() => Capabilities} capabilities — callers must degrade, not assume
 * @property {(uri: string) => ProviderAddress} parseAddress — throws on a URI
 *   of another channel or a malformed one
 * @property {(addr: ProviderAddress) => string} formatAddress
 * @property {(addr: ProviderAddress, content: OutboundContent) =>
 *   Promise<{externalId: string}>} send
 * @property {(handler: (msg: InboundMessage) => void) => () => void} onMessage
 *   — returns an unsubscribe
 *
 * @typedef {{media: boolean, replyTo: boolean, groups: boolean,
 *   readReceipts: boolean, typing: boolean}} Capabilities
 *
 * @typedef {object} ProviderAddress — opaque outside the adapter
 *
 * @typedef {{text: string}
 *   | {image: {data: Buffer, mimetype: string}, caption?: string}
 *   | {document: {data: Buffer, fileName: string, mimetype: string}, caption?: string}
 * } OutboundContent
 *
 * @typedef {object} InboundMessage
 * @property {string} externalId — the provider's message id; the dedup key
 * @property {string} address — URI of the conversation (the chat or group)
 * @property {string} author — URI of whoever wrote it
 * @property {string|null} text — null when the message carries no text
 * @property {"received"|"undecryptable"} status — "undecryptable" when the
 *   provider delivered the envelope but not the content. The provider may
 *   deliver the decrypted content later under the same externalId.
 * @property {"direct"|"group"} kind — a one-to-one chat, or a group where
 *   `author` is the member who wrote and `address` is the group
 * @property {string} at — ISO timestamp
 */
"use strict";

const METHODS = [
  "connect",
  "disconnect",
  "status",
  "capabilities",
  "parseAddress",
  "formatAddress",
  "send",
  "onMessage",
];

/**
 * Throws unless `transport` implements every method of the port.
 * Cheap enough to call when wiring a transport in.
 */
function assertTransport(transport) {
  if (!transport || typeof transport !== "object") {
    throw new TypeError("transport must be an object");
  }
  const missing = METHODS.filter((name) => typeof transport[name] !== "function");
  if (missing.length > 0) {
    throw new TypeError(`transport is missing: ${missing.join(", ")}`);
  }
  return transport;
}

module.exports = { assertTransport, METHODS };
