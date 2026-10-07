/**
 * Chat API — conversations, principals and grants (bidirectional chat design).
 *
 * Mounted by createRouter() after authentication, so every handler can rely
 * on `req.principal`. Administration requires scope `all`; the reading and
 * replying endpoints of later phases check grants instead.
 *
 * Responses use `{ok, ...}` throughout. The pre-port endpoints keep their own
 * frozen shapes; nothing here touches them.
 */
"use strict";

const multer = require("multer");

const { requireScope } = require("./auth");
const { SEES_ALL_CONVERSATIONS } = require("./principal-store");

function invalid(res, message) {
  return res.status(400).json({ ok: false, error: "invalid_request", message });
}

function notFound(res) {
  return res.status(404).json({ ok: false, error: "not_found" });
}

/** The conversation as consumers see it: no internal counters. */
function publicConversation(c) {
  return {
    id: c.id,
    channel: c.channel,
    address: c.address,
    createdAt: c.createdAt,
    lastMessageAt: c.lastMessageAt,
    openedBy: c.openedBy ?? null,
  };
}

/** A message as consumers see it. The provider's externalId stays inside. */
function publicMessage(m) {
  return {
    id: m.id,
    seq: m.seq,
    direction: m.direction,
    author: m.author,
    text: m.text,
    status: m.status,
    at: m.at,
    media: m.media ?? null,
  };
}

/** Image types WhatsApp shows inline; any other file goes as a document. */
const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const MAX_TEXT_LENGTH = 4096;
const RATE_WINDOW_MS = 60_000;

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** Parses a non-negative integer query/body value; undefined stays undefined. */
function parseCount(value) {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * @param {import("express").Router} router — already behind the auth middleware
 * @param {object} deps
 * @param {object} deps.conversations — conversation store
 * @param {object} deps.principals — principal store
 * @param {object} deps.transport — ChatTransport; validates addresses, sends replies
 * @param {object} deps.messageQueue — replies go through the conversation lane
 * @param {function} [deps.beforeSend] — awaited before each send (warm-up)
 * @param {number} [deps.maxRepliesPerMinute] — per-conversation reply cap
 * @param {number} [deps.connectTimeoutMs] — how long a reply waits for a
 *   disconnected transport before failing
 * @param {object} [deps.subscriptions] — subscription store; mounts /subscriptions
 * @param {number} [deps.maxMediaBytes] — size cap of a file in a reply
 * @param {boolean} [deps.agentCanOpenConversations] — let scope `agent` open
 *   conversations with someone who never wrote. Off by default
 * @param {number} [deps.agentOpenPerHour] — cap on conversations agents open
 *   per hour, shared by every agent of the instance
 */
function mountChatApi(router, deps) {
  const { conversations, principals, transport, messageQueue } = deps;
  const beforeSend = deps.beforeSend || (async () => {});
  const maxRepliesPerMinute = deps.maxRepliesPerMinute ?? 20;
  const connectTimeoutMs = deps.connectTimeoutMs ?? 300_000;
  const maxMediaBytes = deps.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const uploadOne = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMediaBytes, files: 1 } })
    .single("file");

  /**
   * Waits for the transport to be connected. Replies are accepted while it is
   * down (the queue survives restarts, so there is no reason to refuse), and
   * delivered once it is back. Holding the single worker meanwhile costs
   * nothing: no send could go out anyway.
   */
  async function untilConnected() {
    const deadline = Date.now() + connectTimeoutMs;
    while (!transport.status().connected) {
      if (Date.now() >= deadline) {
        throw new Error(`transporte desconectado por más de ${connectTimeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, connectTimeoutMs)));
    }
  }
  const adminOnly = requireScope("all");
  const agentCanOpenConversations = deps.agentCanOpenConversations ?? false;
  const agentOpenPerHour = deps.agentOpenPerHour ?? 10;

  // A reply is data in the transcript; the job only points at it. The handler
  // is registered here, before the queue starts, so a reply accepted before a
  // restart is still delivered after it.
  async function deliverReply(job, buildContent) {
    const { messageId, conversationId } = job.payload;
    try {
      await untilConnected();
      await beforeSend();
      const message = conversations.getMessage(messageId);
      const conversation = conversations.getConversation(conversationId);
      const { externalId } = await transport.send(
        transport.parseAddress(conversation.address),
        buildContent(message)
      );
      conversations.markOutbound(messageId, { status: "sent", externalId });
    } catch (err) {
      conversations.markOutbound(messageId, { status: "error" });
      throw err;
    }
  }

  messageQueue.registerHandler("chat-text", (job) => deliverReply(job, (m) => ({ text: m.text })));

  // The bytes travel in the job (dropped once it finishes); the transcript
  // keeps only the file's metadata.
  messageQueue.registerHandler("chat-media", (job) =>
    deliverReply(job, (m) =>
      m.media.type === "image"
        ? { image: { data: job.media.buffer, mimetype: m.media.mimetype }, caption: m.text || "" }
        : {
            document: { data: job.media.buffer, fileName: m.media.name, mimetype: m.media.mimetype },
            caption: m.text || "",
          }
    )
  );

  /**
   * The conversation if this principal may see it, else null. A conversation
   * that exists but is not granted is indistinguishable from a missing one:
   * both answer 404, so a key cannot probe who the account talks to (D3).
   */
  function visible(req, id) {
    const conversation = conversations.getConversation(id);
    if (!conversation) return null;
    if (SEES_ALL_CONVERSATIONS.has(req.principal.scope)) return conversation;
    return principals.isGranted(req.principal.id, id) ? conversation : null;
  }

  /** Public conversation plus this principal's reading position. */
  function withReadState(conversation, principalId) {
    const readSeq = principals.getReadMarker(principalId, conversation.id);
    return {
      ...publicConversation(conversation),
      lastSeq: conversation.nextSeq - 1,
      readSeq,
      unread: conversations.countInboundAfter(conversation.id, readSeq),
    };
  }

  // ── Principals ──────────────────────────────────────────────────────
  router.post("/principals", adminOnly, (req, res) => {
    const { name, scope } = req.body || {};
    let created;
    try {
      created = principals.create({ name, scope });
    } catch (err) {
      return invalid(res, err.message);
    }
    // The key is returned here and never again.
    res.status(201).json({ ok: true, principal: created.principal, key: created.key });
  });

  router.get("/principals", adminOnly, (_req, res) => {
    res.json({ ok: true, principals: principals.list() });
  });

  router.delete("/principals/:id", adminOnly, (req, res) => {
    if (!principals.revoke(req.params.id)) return notFound(res);
    res.json({ ok: true });
  });

  // ── Conversations ───────────────────────────────────────────────────
  // Opening a conversation means being able to write to someone who never
  // wrote — the unsolicited send that gets numbers flagged. Administrators may;
  // scope `agent` only where the instance enables it, under an hourly cap
  // shared by all its agents. Every opening records who did it.
  router.post("/conversations", (req, res) => {
    const { scope } = req.principal;
    const allowed = scope === "all" || (scope === "agent" && agentCanOpenConversations);
    if (!allowed) return adminOnly(req, res);

    const { address } = req.body || {};
    try {
      transport.parseAddress(address);
    } catch (err) {
      return invalid(res, `address no alcanzable por este servicio: ${err.message}`);
    }
    const existed = Boolean(conversations.findByAddress(address));

    if (!existed && scope === "agent") {
      const windowStart = new Date(Date.now() - 3_600_000).toISOString();
      const { count, oldest } = conversations.openedSince("agent", windowStart);
      if (count >= agentOpenPerHour) {
        const retryAfterSeconds = Math.min(
          3600,
          Math.max(1, Math.ceil((Date.parse(oldest) + 3_600_000 - Date.now()) / 1000))
        );
        res.set("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({
          ok: false,
          error: "rate_limited",
          message: `Máximo ${agentOpenPerHour} conversaciones nuevas por hora abiertas por agentes.`,
          retryAfterSeconds,
        });
      }
    }

    const conversation = conversations.resolveConversation(address, {
      openedBy: req.principal.id,
      openedScope: scope,
    });
    res.status(existed ? 200 : 201).json({ ok: true, conversation: publicConversation(conversation) });
  });

  router.get("/conversations", (req, res) => {
    const ids = SEES_ALL_CONVERSATIONS.has(req.principal.scope)
      ? undefined
      : principals.grantedConversationIds(req.principal.id);
    const list = conversations.listConversations({ ids });
    res.json({ ok: true, conversations: list.map((c) => withReadState(c, req.principal.id)) });
  });

  router.get("/conversations/:id", (req, res) => {
    const conversation = visible(req, req.params.id);
    if (!conversation) return notFound(res);
    res.json({ ok: true, conversation: withReadState(conversation, req.principal.id) });
  });

  // ── Reading ─────────────────────────────────────────────────────────
  // Without `since`, reading resumes from this principal's read marker, so a
  // consumer that restarts between turns does not need to persist a cursor.
  router.get("/conversations/:id/messages", (req, res) => {
    const conversation = visible(req, req.params.id);
    if (!conversation) return notFound(res);

    const since = parseCount(req.query.since);
    const limit = parseCount(req.query.limit);
    if (since === null) return invalid(res, "since debe ser un entero >= 0");
    if (limit === null || limit === 0 || limit > MAX_LIMIT) {
      return invalid(res, `limit debe ser un entero entre 1 y ${MAX_LIMIT}`);
    }

    const page = conversations.readMessages(conversation.id, {
      since: since ?? principals.getReadMarker(req.principal.id, conversation.id),
      limit: limit ?? DEFAULT_LIMIT,
    });
    res.json({ ok: true, messages: page.messages.map(publicMessage), next: page.next, gap: page.gap });
  });

  router.post("/conversations/:id/read", (req, res) => {
    const conversation = visible(req, req.params.id);
    if (!conversation) return notFound(res);

    const seq = (req.body || {}).seq;
    if (!Number.isInteger(seq) || seq < 0 || seq > conversation.nextSeq - 1) {
      return invalid(res, `seq debe ser un entero entre 0 y ${conversation.nextSeq - 1}`);
    }
    const readSeq = principals.setReadMarker(req.principal.id, conversation.id, seq);
    res.json({ ok: true, readSeq });
  });

  // ── Replying ────────────────────────────────────────────────────────
  // Replies use the conversation lane: they overtake bulk sends and keep only
  // a short human-like floor (design D6). The per-conversation cap stops a
  // looping consumer from flooding a customer, which is what gets a number
  // flagged — it answers 429 instead of queueing the flood.
  // JSON {text}, or multipart with `file` and an optional `caption` (or
  // `text`). The grant is checked before the upload is read, so a file for a
  // conversation the caller cannot see is never buffered.
  router.post("/conversations/:id/messages", (req, res, next) => {
    if (!visible(req, req.params.id)) return notFound(res);
    uploadOne(req, res, (err) => {
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          ok: false,
          error: "file_too_large",
          message: `El archivo supera el máximo de ${maxMediaBytes} bytes.`,
        });
      }
      if (err) return invalid(res, `archivo inválido: ${err.message}`);
      next();
    });
  }, (req, res) => {
    const conversation = visible(req, req.params.id);
    if (!conversation) return notFound(res);

    const body = req.body || {};
    const file = req.file || null;
    const rawText = body.text ?? body.caption;
    const text = typeof rawText === "string" && rawText.trim() !== "" ? rawText : null;
    if (rawText !== undefined && typeof rawText !== "string") {
      return invalid(res, "text debe ser un string");
    }
    if (!file && text === null) {
      return invalid(res, `text es requerido (string de 1 a ${MAX_TEXT_LENGTH} caracteres) o un file`);
    }
    if (text !== null && text.length > MAX_TEXT_LENGTH) {
      return invalid(res, `text admite hasta ${MAX_TEXT_LENGTH} caracteres`);
    }

    const windowStart = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    if (conversations.countOutboundSince(conversation.id, windowStart) >= maxRepliesPerMinute) {
      const oldest = Date.parse(conversations.oldestOutboundSince(conversation.id, windowStart));
      const retryAfterSeconds = Math.min(60, Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - Date.now()) / 1000)));
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        message: `Máximo ${maxRepliesPerMinute} respuestas por minuto en esta conversación.`,
        retryAfterSeconds,
      });
    }

    const mimetype = file ? file.mimetype || "application/octet-stream" : null;
    const media = file
      ? {
          type: INLINE_IMAGE_TYPES.has(mimetype) ? "image" : "document",
          name: file.originalname || "archivo",
          mimetype,
          size: file.size,
        }
      : null;

    const message = conversations.recordOutbound(conversation.id, {
      text,
      author: transport.status().identity,
      media,
    });
    // The conversation lane is for answering someone who wrote. Writing to a
    // contact who never did is unsolicited, and takes the bulk lane's pacing
    // until they reply.
    const lane = conversations.countInboundAfter(conversation.id, 0) > 0 ? "conversation" : "bulk";
    const job = messageQueue.enqueue({
      type: media ? "chat-media" : "chat-text",
      target: conversation.address,
      payload: { messageId: message.id, conversationId: conversation.id },
      media: file ? { buffer: file.buffer, name: media.name, mimetype } : null,
      lane,
    });
    res.status(202).json({ ok: true, message: publicMessage(message), job_id: job.id });
  });

  // ── Webhook subscriptions ───────────────────────────────────────────
  // A principal manages its own webhooks. It only ever receives what it could
  // read anyway (see lib/webhooks.js), so no scope beyond identity is needed.
  if (deps.subscriptions) {
    const { subscriptions } = deps;

    router.post("/subscriptions", (req, res) => {
      let created;
      try {
        created = subscriptions.create({ principalId: req.principal.id, url: (req.body || {}).url });
      } catch (err) {
        return invalid(res, err.message);
      }
      // The signing secret is returned here and never again.
      res.status(201).json({ ok: true, subscription: created.subscription, secret: created.secret });
    });

    router.get("/subscriptions", (req, res) => {
      res.json({ ok: true, subscriptions: subscriptions.listFor(req.principal.id) });
    });

    router.delete("/subscriptions/:id", (req, res) => {
      const owner = req.principal.scope === "all" ? {} : { principalId: req.principal.id };
      if (!subscriptions.remove(req.params.id, owner)) return notFound(res);
      res.json({ ok: true });
    });
  }

  // ── Grants ──────────────────────────────────────────────────────────
  router.post("/conversations/:id/grants", adminOnly, (req, res) => {
    const principalId = (req.body || {}).principal_id;
    if (typeof principalId !== "string" || principalId === "") {
      return invalid(res, "principal_id es requerido (string)");
    }
    if (!conversations.getConversation(req.params.id) || !principals.get(principalId)) {
      return notFound(res);
    }
    const { created } = principals.grant(principalId, req.params.id);
    res.status(created ? 201 : 200).json({ ok: true });
  });

  router.delete("/conversations/:id/grants/:principalId", adminOnly, (req, res) => {
    if (!principals.revokeGrant(req.params.principalId, req.params.id)) return notFound(res);
    res.json({ ok: true });
  });
}

module.exports = { mountChatApi, publicConversation, publicMessage };
