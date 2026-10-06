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

const { requireScope } = require("./auth");

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
  };
}

/**
 * @param {import("express").Router} router — already behind the auth middleware
 * @param {object} deps
 * @param {object} deps.conversations — conversation store
 * @param {object} deps.principals — principal store
 * @param {object} deps.transport — ChatTransport; validates addresses
 */
function mountChatApi(router, { conversations, principals, transport }) {
  const adminOnly = requireScope("all");

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
  // Opening a conversation means being able to write to that address, so it
  // is administration: an agent works only the conversations it is granted.
  router.post("/conversations", adminOnly, (req, res) => {
    const { address } = req.body || {};
    try {
      transport.parseAddress(address);
    } catch (err) {
      return invalid(res, `address no alcanzable por este servicio: ${err.message}`);
    }
    const existed = Boolean(conversations.findByAddress(address));
    const conversation = conversations.resolveConversation(address);
    res.status(existed ? 200 : 201).json({ ok: true, conversation: publicConversation(conversation) });
  });

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

module.exports = { mountChatApi, publicConversation };
