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

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ── Bootstrap ────────────────────────────────────────────────────────────
const app = express();
const baileysMgr = createManager({
  sessionDir: config.SESSION_DIR,
  printQR: config.printQR,
});

// ── Routes ───────────────────────────────────────────────────────────────
app.use(createRouter(baileysMgr));

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
