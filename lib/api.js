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
 * @returns {express.Router}
 */
function createRouter(baileysMgr) {
  const router = express.Router();

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

  // ── GET /status ─────────────────────────────────────────────────────
  router.get("/status", (_req, res) => {
    res.json(baileysMgr.getStatus());
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

    try {
      const sock = baileysMgr.getSock();
      await sock.sendMessage(to, { text });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
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

    try {
      const sock = baileysMgr.getSock();
      const jid = await resolveJid(sock, target);
      await sock.sendMessage(jid, {
        image: req.file.buffer,
        caption,
        mimetype: req.file.mimetype || "image/png",
      });
      res.json({ success: true, message: `Imagen enviada a ${target}` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
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

    try {
      const sock = baileysMgr.getSock();
      const jid = await resolveJid(sock, target);
      await sock.sendMessage(jid, {
        document: req.file.buffer,
        fileName: req.file.originalname,
        caption,
        mimetype:
          req.file.mimetype ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      res.json({ success: true, message: `Archivo enviado a ${target}` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
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

    try {
      const sock = baileysMgr.getSock();
      const jid = await resolveJid(sock, target);
      await sock.sendMessage(jid, {
        document: req.file.buffer,
        fileName: req.file.originalname,
        caption,
        mimetype:
          req.file.mimetype ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createRouter };
