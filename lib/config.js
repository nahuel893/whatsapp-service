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

  /** Whether to print QR to terminal on first auth */
  get printQR() {
    return this.NODE_ENV !== "production" || process.env.PRINT_QR === "true";
  },
};
