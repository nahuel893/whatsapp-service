/**
 * Reference conversational agent for whatsapp-service.
 *
 * A complete consumer of the public contract, end to end:
 *   webhook (verified HMAC) → debounce per conversation → read new messages
 *   → recent transcript → model → reply → mark read
 *
 * The model only ever produces the text of a reply. It gets no tools, so a
 * customer message cannot steer it into acting elsewhere: whatever it writes
 * goes back to the same conversation and nowhere else.
 *
 * The model runner is injected. index.js wires it to `claude -p`; tests use a
 * stub.
 */
"use strict";

const crypto = require("node:crypto");

const MAX_SKEW_SECONDS = 300;

/**
 * Verifies an X-Webhook-Signature over the raw body. Constant-time compare,
 * and a timestamp window against replays.
 */
function verifySignature({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const a = Buffer.from(String(signature || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Transcript lines as the model reads them. */
function renderTranscript(messages) {
  return messages
    .map((m) => {
      const who = m.direction === "in" ? "Cliente" : "Vos";
      const body = m.text ?? (m.status === "undecryptable" ? "[mensaje que no se pudo leer]" : "[adjunto sin texto]");
      return `${who}: ${body}`;
    })
    .join("\n");
}

/**
 * @param {object} options
 * @param {string} options.serviceUrl
 * @param {string} options.apiKey — scope `agent`
 * @param {(prompt: string) => Promise<string>} options.runModel — returns the reply text
 * @param {number} [options.debounceMs] — wait for a burst of messages to end
 * @param {number} [options.contextMessages] — transcript size handed to the model
 * @param {{info: function, warn: function, error: function}} [options.logger]
 */
function createAgent({
  serviceUrl,
  apiKey,
  runModel,
  debounceMs = 3_000,
  contextMessages = 30,
  logger = console,
  fetch = globalThis.fetch,
}) {
  const base = serviceUrl.replace(/\/+$/, "");
  const timers = new Map();
  const busy = new Set();
  const dirty = new Set();

  async function api(method, pathname, body) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "x-api-key": apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`${method} ${pathname} → HTTP ${res.status} ${data?.error ?? ""}`);
      err.status = res.status;
      err.retryAfterSeconds = data?.retryAfterSeconds;
      throw err;
    }
    return data;
  }

  /** Answers everything new in one conversation. Safe to call repeatedly. */
  async function attend(conversationId) {
    const id = encodeURIComponent(conversationId);
    const page = await api("GET", `/conversations/${id}/messages`);
    if (!page.messages.some((m) => m.direction === "in")) {
      if (page.messages.length) await api("POST", `/conversations/${id}/read`, { seq: page.next });
      return { replied: false };
    }

    const { conversation } = await api("GET", `/conversations/${id}`);
    const since = Math.max(0, conversation.lastSeq - contextMessages);
    const recent = await api("GET", `/conversations/${id}/messages?since=${since}&limit=${contextMessages}`);
    const prompt =
      "Esta es la conversación de WhatsApp hasta ahora:\n\n" +
      `${renderTranscript(recent.messages)}\n\n` +
      (recent.gap ? "(Hay mensajes más viejos que ya no están disponibles.)\n\n" : "") +
      "Escribí únicamente el texto de tu próxima respuesta al cliente.";

    const text = (await runModel(prompt)).trim();
    if (!text) throw new Error("el modelo devolvió una respuesta vacía");

    await api("POST", `/conversations/${id}/messages`, { text: text.slice(0, 4096) });
    // Mark only what was read before answering: anything that arrived while
    // the model was thinking stays unread and triggers another turn.
    await api("POST", `/conversations/${id}/read`, { seq: page.next });
    logger.info(`respondida ${conversationId} (hasta seq ${page.next})`);
    return { replied: true };
  }

  async function run(conversationId) {
    if (busy.has(conversationId)) {
      dirty.add(conversationId);
      return;
    }
    busy.add(conversationId);
    try {
      do {
        dirty.delete(conversationId);
        await attend(conversationId);
      } while (dirty.has(conversationId));
    } catch (err) {
      logger.error(`no se pudo atender ${conversationId}: ${err.message}`);
      if (err.status === 429 && err.retryAfterSeconds) schedule(conversationId, err.retryAfterSeconds * 1000);
    } finally {
      busy.delete(conversationId);
    }
  }

  /** Debounced: a burst of messages becomes one turn of the agent. */
  function schedule(conversationId, delay = debounceMs) {
    clearTimeout(timers.get(conversationId));
    timers.set(
      conversationId,
      setTimeout(() => {
        timers.delete(conversationId);
        run(conversationId);
      }, delay)
    );
  }

  /** Handles a verified webhook payload. */
  function onEvent(payload) {
    if (payload?.message?.direction !== "in") return;
    if (payload.event !== "message.created" && payload.event !== "message.updated") return;
    schedule(payload.conversation.id);
  }

  /** Picks up whatever arrived while the agent was down. */
  async function catchUp() {
    const { conversations } = await api("GET", "/conversations");
    const pending = conversations.filter((c) => c.unread > 0);
    for (const c of pending) schedule(c.id, 0);
    return pending.length;
  }

  function stop() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { attend, onEvent, schedule, catchUp, stop, api };
}

module.exports = { createAgent, verifySignature, renderTranscript };
