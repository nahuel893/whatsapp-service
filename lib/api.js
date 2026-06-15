/**
 * API — Express route handlers for the WhatsApp service.
 *
 * Pure HTTP API: receives requests, delegates to Baileys socket.
 * NO agent logic, NO allowlist, NO dedup.
 */
"use strict";

const express = require("express");
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage() });

/**
 * Creates an Express Router with all WhatsApp endpoints.
 *
 * @param {object} baileysMgr — the manager returned by createManager()
 * @param {object} messageQueue — queue returned by createMessageQueue()
 * @param {object} options
 * @param {number} options.warmupMs — delay after connection before outbound sends
 * @returns {express.Router}
 */
function createRouter(baileysMgr, messageQueue, options = {}) {
  const router = express.Router();
  const warmupMs = options.warmupMs || 0;

  // JSON body parser for /send-text
  router.use(express.json());

  // ── Session middleware ──────────────────────────────────────────────
  function requireSession(req, res, next) {
    const status = baileysMgr.getStatus();
    if (!status.connected) {
      return res.status(503).json({
        error: "session_not_ready",
        message: "WhatsApp no autenticado. Escanea el QR en consola.",
      });
    }
    next();
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Resolve the target identifier from the request body.
   * Accepts `to` (preferred) or `group_name` (backward compat).
   */
  function resolveTarget(body) {
    return body.to || body.group_name || null;
  }

  async function resolveJid(sock, groupName) {
    // Try group by name first
    try {
      const groups = await sock.groupFetchAllParticipating();
      const match = Object.values(groups).find(
        (g) => g.subject.toLowerCase() === groupName.toLowerCase()
      );
      if (match) return match.id;
    } catch {
      // Fall through to contact individual
    }

    // Assume phone number (without @s.whatsapp.net)
    const cleaned = String(groupName).replace(/[^0-9]/g, "");
    return `${cleaned}@s.whatsapp.net`;
  }

  async function waitForOutboundReadiness() {
    if (typeof baileysMgr.waitForWarmup === "function") {
      await baileysMgr.waitForWarmup(warmupMs);
    }
  }

  // ── GET /status ─────────────────────────────────────────────────────
  router.get("/status", (_req, res) => {
    res.json(baileysMgr.getStatus());
  });

  router.get("/queue/status", (_req, res) => {
    res.json(messageQueue.getStatus());
  });

  // ── GET /groups ─────────────────────────────────────────────────────
  // Lists all participating groups (subject + jid). Read-only helper for
  // resolving the exact group subject expected by resolveJid().
  router.get("/groups", requireSession, async (_req, res) => {
    try {
      const sock = baileysMgr.getSock();
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups)
        .map((g) => ({ id: g.id, subject: g.subject, size: g.size }))
        .sort((a, b) => a.subject.localeCompare(b.subject));
      res.json({ ok: true, count: list.length, groups: list });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── POST /send-text ─────────────────────────────────────────────────
  // Body: { to: string, text: string }
  router.post("/send-text", requireSession, async (req, res) => {
    const { to, text } = req.body || {};

    if (!to || typeof to !== "string") {
      return res.status(400).json({ ok: false, error: "to es requerido (string)" });
    }
    if (!text || typeof text !== "string") {
      return res.status(400).json({ ok: false, error: "text es requerido (string)" });
    }
    if (!to.endsWith("@s.whatsapp.net")) {
      return res.status(400).json({
        ok: false,
        error: "to debe terminar en @s.whatsapp.net (solo DMs)",
      });
    }

    const job = messageQueue.enqueue({
      type: "text",
      target: to,
      run: async () => {
        await waitForOutboundReadiness();
        const sock = baileysMgr.getSock();
        await sock.sendMessage(to, { text });
      },
    });
    res.json({ ok: true, queued: true, job_id: job.id });
  });

  // ── POST /send-image ────────────────────────────────────────────────
  router.post("/send-image", requireSession, upload.single("image"), async (req, res) => {
    const target = resolveTarget(req.body);
    const caption = req.body.caption || "";
    if (!target) {
      return res.status(400).json({ error: "to o group_name es requerido" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "image es requerido" });
    }

    const file = req.file;
    const job = messageQueue.enqueue({
      type: "image",
      target,
      run: async () => {
        await waitForOutboundReadiness();
        const sock = baileysMgr.getSock();
        const jid = await resolveJid(sock, target);
        await sock.sendMessage(jid, {
          image: file.buffer,
          caption,
          mimetype: file.mimetype || "image/png",
        });
      },
    });
    res.json({ success: true, queued: true, job_id: job.id, message: `Imagen encolada para ${target}` });
  });

  // ── POST /send-file ─────────────────────────────────────────────────
  router.post("/send-file", requireSession, upload.single("file"), async (req, res) => {
    const target = resolveTarget(req.body);
    const caption = req.body.caption || "";
    if (!target) {
      return res.status(400).json({ error: "to o group_name es requerido" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "file es requerido" });
    }

    const file = req.file;
    const job = messageQueue.enqueue({
      type: "file",
      target,
      run: async () => {
        await waitForOutboundReadiness();
        const sock = baileysMgr.getSock();
        const jid = await resolveJid(sock, target);
        await sock.sendMessage(jid, {
          document: file.buffer,
          fileName: file.originalname,
          caption,
          mimetype:
            file.mimetype ||
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      },
    });
    res.json({ success: true, queued: true, job_id: job.id, message: `Archivo encolado para ${target}` });
  });

  // ── POST /send-file-dm ──────────────────────────────────────────────
  // Alias of /send-file kept for backward compatibility with an older consumer.
  router.post("/send-file-dm", requireSession, upload.single("file"), async (req, res) => {
    const target = resolveTarget(req.body);
    const caption = req.body.caption || "";
    if (!target) {
      return res.status(400).json({ ok: false, error: "to o group_name es requerido" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "file es requerido" });
    }

    const file = req.file;
    const job = messageQueue.enqueue({
      type: "file-dm",
      target,
      run: async () => {
        await waitForOutboundReadiness();
        const sock = baileysMgr.getSock();
        const jid = await resolveJid(sock, target);
        await sock.sendMessage(jid, {
          document: file.buffer,
          fileName: file.originalname,
          caption,
          mimetype:
            file.mimetype ||
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      },
    });
    res.json({ ok: true, queued: true, job_id: job.id });
  });

  return router;
}

module.exports = { createRouter };
