/**
 * Config — Centralized env var loader with defaults.
 *
 * All configuration comes from environment variables.
 * No hardcoded paths to any external project.
 */
"use strict";

const path = require("path");

module.exports = {
  /** HTTP port for the Express API */
  PORT: parseInt(process.env.PORT || "3001", 10),

  /** Directory for Baileys multi-file auth state (session persistence) */
  SESSION_DIR: path.resolve(process.env.SESSION_DIR || "./session"),

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
