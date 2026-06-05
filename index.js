/**
 * WhatsApp Service — Standalone Baileys abstraction.
 *
 * Pure HTTP API for sending WhatsApp messages.
 * No agent logic, no allowlist, no dedup.
 *
 * Usage:
 *   npm start                    # production
 *   PORT=3000 node index.js      # custom port
 */
"use strict";

const express = require("express");
const pino = require("pino");

const config = require("./lib/config");
const { createManager } = require("./lib/baileys");
const { createRouter } = require("./lib/api");
const { createMessageQueue } = require("./lib/message-queue");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ── Bootstrap ────────────────────────────────────────────────────────────
const app = express();
const baileysMgr = createManager({
  sessionDir: config.SESSION_DIR,
  printQR: config.printQR,
});
const messageQueue = createMessageQueue({
  minDelayMs: config.MESSAGE_QUEUE_MIN_DELAY_MS,
  maxDelayMs: config.MESSAGE_QUEUE_MAX_DELAY_MS,
});

// ── Routes ───────────────────────────────────────────────────────────────
app.use(createRouter(baileysMgr, messageQueue, {
  warmupMs: config.WHATSAPP_WARMUP_MS,
}));

// ── Listen ───────────────────────────────────────────────────────────────
app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "WhatsApp Service iniciado");
  logger.info(
    { sessionDir: config.SESSION_DIR },
    "Directorio de sesión"
  );

  baileysMgr.connect().catch((err) => {
    logger.error({ err }, "Error conectando WhatsApp");
  });
});
