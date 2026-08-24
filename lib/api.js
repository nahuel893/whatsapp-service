/**
 * API — Express route handlers for the WhatsApp service.
 *
 * Pure HTTP API: receives requests, persists a job, delegates to Baileys.
 * NO agent logic, NO allowlist, NO dedup.
 *
 * Handlers are registered by job type rather than closed over per request, so
 * a job accepted before a restart can still be delivered after it.
 */
"use strict";

const express = require("express");
const multer = require("multer");

const { createAuthMiddleware } = require("./auth");

const upload = multer({ storage: multer.memoryStorage() });

/** Endpoints that must answer without credentials, for liveness probes. */
const PUBLIC_PATHS = ["/health"];

const startedAt = Date.now();

/**
 * Creates an Express Router with all WhatsApp endpoints.
 *
 * @param {object} baileysMgr — the manager returned by createManager()
 * @param {object} messageQueue — queue returned by createMessageQueue()
 * @param {object} options
 * @param {number} options.warmupMs — delay after connection before outbound sends
 * @param {string} options.apiKey — shared secret; empty leaves the API open
 * @returns {express.Router}
 */
function createRouter(baileysMgr, messageQueue, options = {}) {
  const router = express.Router();
  const warmupMs = options.warmupMs || 0;

  // JSON body parser for /send-text
  router.use(express.json());
  router.use(createAuthMiddleware({ apiKey: options.apiKey, publicPaths: PUBLIC_PATHS }));

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

  /** Turns an uploaded multer file into the store's media shape. */
  function toMedia(file, fallbackMimetype) {
    return {
      buffer: file.buffer,
      name: file.originalname,
      mimetype: file.mimetype || fallbackMimetype,
    };
  }

  // ── Job handlers ────────────────────────────────────────────────────
  // Registered once; each receives the persisted job, never a closure.

  messageQueue.registerHandler("text", async (job) => {
    await waitForOutboundReadiness();
    const sock = baileysMgr.getSock();
    await sock.sendMessage(job.target, { text: job.payload.text });
  });

  messageQueue.registerHandler("image", async (job) => {
    await waitForOutboundReadiness();
    const sock = baileysMgr.getSock();
    const jid = await resolveJid(sock, job.target);
    await sock.sendMessage(jid, {
      image: job.media.buffer,
      caption: job.payload.caption || "",
      mimetype: job.media.mimetype || "image/png",
    });
  });

  async function sendDocument(job) {
    await waitForOutboundReadiness();
    const sock = baileysMgr.getSock();
    const jid = await resolveJid(sock, job.target);
    await sock.sendMessage(jid, {
      document: job.media.buffer,
      fileName: job.media.name,
      caption: job.payload.caption || "",
      mimetype:
        job.media.mimetype ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  messageQueue.registerHandler("file", sendDocument);
  // Kept as a distinct type so historical job rows still dispatch correctly.
  messageQueue.registerHandler("file-dm", sendDocument);

  // ── GET /health ─────────────────────────────────────────────────────
  // Liveness probe. Always 200 while the process is up — a disconnected
  // WhatsApp session is reported in the body, not as a failed probe, so a
  // container orchestrator does not restart a service that is merely
  // waiting to be re-paired.
  router.get("/health", (_req, res) => {
    const queue = messageQueue.getStatus();
    res.json({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      whatsapp: baileysMgr.getStatus(),
      queue: { pending: queue.pending, processing: queue.processing },
    });
  });

  // ── GET /status ─────────────────────────────────────────────────────
  router.get("/status", (_req, res) => {
    res.json(baileysMgr.getStatus());
  });

  router.get("/queue/status", (_req, res) => {
    res.json(messageQueue.getStatus());
  });

  // ── GET /queue/job/:id ──────────────────────────────────────────────
  // Lets a consumer confirm delivery of a specific job_id — including after
  // a service restart, which the in-memory queue could never answer.
  router.get("/queue/job/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "job id inválido" });
    }
    const job = messageQueue.getJob(id);
    if (!job) {
      return res.status(404).json({ ok: false, error: "job no encontrado" });
    }
    res.json({ ok: true, job });
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

    const job = messageQueue.enqueue({ type: "text", target: to, payload: { text } });
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

    const job = messageQueue.enqueue({
      type: "image",
      target,
      payload: { caption },
      media: toMedia(req.file, "image/png"),
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

    const job = messageQueue.enqueue({
      type: "file",
      target,
      payload: { caption },
      media: toMedia(
        req.file,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ),
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

    const job = messageQueue.enqueue({
      type: "file-dm",
      target,
      payload: { caption },
      media: toMedia(
        req.file,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ),
    });
    res.json({ ok: true, queued: true, job_id: job.id });
  });

  return router;
}

module.exports = { createRouter };
