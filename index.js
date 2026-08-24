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
const { createJobStore } = require("./lib/job-store");
const { createMessageQueue } = require("./lib/message-queue");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ── Bootstrap ────────────────────────────────────────────────────────────
const app = express();
const baileysMgr = createManager({
  sessionDir: config.SESSION_DIR,
  printQR: config.printQR,
});
const jobStore = createJobStore({ dbPath: config.QUEUE_DB_PATH });
const messageQueue = createMessageQueue({
  store: jobStore,
  minDelayMs: config.MESSAGE_QUEUE_MIN_DELAY_MS,
  maxDelayMs: config.MESSAGE_QUEUE_MAX_DELAY_MS,
});

// ── Routes ───────────────────────────────────────────────────────────────
// Registers the queue handlers as a side effect, so this must run before
// messageQueue.start() replays anything left pending by the last run.
app.use(createRouter(baileysMgr, messageQueue, {
  warmupMs: config.WHATSAPP_WARMUP_MS,
  apiKey: config.API_KEY,
}));

// ── Listen ───────────────────────────────────────────────────────────────
const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ port: config.PORT, host: config.HOST }, "WhatsApp Service iniciado");
  logger.info({ sessionDir: config.SESSION_DIR }, "Directorio de sesión");
  logger.info({ queueDb: config.QUEUE_DB_PATH }, "Base de datos de la cola");

  if (!config.API_KEY) {
    logger.warn(
      "API_KEY sin configurar: la API acepta cualquier request y puede enviar " +
      "mensajes desde este número. Configurala salvo que el puerto esté " +
      "restringido a una red de confianza."
    );
  }

  const pruned = jobStore.prune(config.QUEUE_RETENTION_DAYS);
  if (pruned > 0) {
    logger.info({ jobs: pruned, days: config.QUEUE_RETENTION_DAYS }, "Jobs antiguos purgados");
  }

  // Replay jobs the previous run accepted but never delivered.
  const { recovered } = messageQueue.start();
  if (recovered > 0) {
    logger.warn({ jobs: recovered }, "Jobs interrumpidos reencolados");
  }

  baileysMgr.connect().catch((err) => {
    logger.error({ err }, "Error conectando WhatsApp");
  });
});

// ── Shutdown ─────────────────────────────────────────────────────────────
// Stop accepting requests and close the database cleanly. Jobs still pending
// stay pending on disk and are replayed on the next start.
function shutdown(signal) {
  logger.info({ signal }, "Apagando");
  server.close(() => {
    try {
      jobStore.close();
    } catch (err) {
      logger.error({ err }, "Error cerrando la base de datos de la cola");
    }
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
