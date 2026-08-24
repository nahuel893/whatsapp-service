/**
 * Config — Centralized env var loader with defaults.
 *
 * All configuration comes from environment variables, so the same image runs
 * under systemd, Docker, or bare `node index.js`. A local `.env` is loaded
 * when present (Node's built-in loader — no dependency).
 * No hardcoded paths to any external project.
 */
"use strict";

const path = require("path");

// Optional local .env. Absent in production deployments, where the platform
// injects the environment directly.
try {
  process.loadEnvFile();
} catch {
  // No .env file — every value below falls back to its default.
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

module.exports = {
  /** HTTP port for the Express API */
  PORT: parseInt(process.env.PORT || "3001", 10),

  /**
   * Address to bind. Defaults to every interface, matching the previous
   * behaviour and what a container needs. Set 127.0.0.1 to restrict it.
   */
  HOST: process.env.HOST || "0.0.0.0",

  /** Directory for Baileys multi-file auth state (session persistence) */
  SESSION_DIR: path.resolve(process.env.SESSION_DIR || "./session"),

  /** Directory for service state that is not WhatsApp auth (the job database) */
  DATA_DIR,

  /** SQLite file backing the outbound message queue */
  QUEUE_DB_PATH: path.resolve(process.env.QUEUE_DB_PATH || path.join(DATA_DIR, "queue.db")),

  /** Days of finished jobs to keep before pruning */
  QUEUE_RETENTION_DAYS: parseInt(process.env.QUEUE_RETENTION_DAYS || "30", 10),

  /** Shared secret required by every endpoint except /health. Empty = open. */
  API_KEY: process.env.API_KEY || "",

  /** Runtime environment */
  NODE_ENV: process.env.NODE_ENV || "production",

  /** Delay bounds for outbound WhatsApp message queue */
  MESSAGE_QUEUE_MIN_DELAY_MS: parseInt(process.env.MESSAGE_QUEUE_MIN_DELAY_MS || "60000", 10),
  MESSAGE_QUEUE_MAX_DELAY_MS: parseInt(process.env.MESSAGE_QUEUE_MAX_DELAY_MS || "120000", 10),

  /** Delay after WhatsApp connection opens before first outbound send */
  WHATSAPP_WARMUP_MS: parseInt(process.env.WHATSAPP_WARMUP_MS || "0", 10),

  /** Whether to print QR to terminal on first auth */
  get printQR() {
    return this.NODE_ENV !== "production" || process.env.PRINT_QR === "true";
  },
};
