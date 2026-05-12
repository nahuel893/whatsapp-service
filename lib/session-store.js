/**
 * Session Store — Thin wrapper around Baileys multi-file auth state.
 *
 * Ensures the session directory exists before returning the auth state.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

/**
 * Initialize the auth state for a given session directory.
 *
 * @param {string} sessionDir — absolute path to the session directory
 * @returns {Promise<{state: object, saveCreds: function}>}
 */
async function initAuthState(sessionDir) {
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return useMultiFileAuthState(sessionDir);
}

module.exports = { initAuthState };
