/**
 * Baileys — Connection manager for WhatsApp Web.
 *
 * Pure connection logic: init, reconnect, QR display, session persistence.
 * NO agent logic, NO allowlist, NO forwardToAgent.
 */
"use strict";

const pino = require("pino");
const { initAuthState } = require("./session-store");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/**
 * Creates and manages a Baileys WhatsApp socket connection.
 *
 * @param {object} config — { sessionDir, printQR }
 * @returns {{ getSock: function, getStatus: function, onEvent: function }}
 */
function createManager(config) {
  let sock = null;
  let sessionReady = false;
  let phoneNumber = null;
  const eventHandlers = [];

  /**
   * Initialize or reconnect the WhatsApp socket.
   * Prints QR to terminal on first auth.
   */
  async function connect() {
    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = await import("@whiskeysockets/baileys");

    const { state, saveCreds } = await initAuthState(config.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: config.printQR,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr && config.printQR) {
        logger.info("Escanea el QR con WhatsApp para autenticar.");
        try {
          const { default: qrcodeTerminal } = await import("qrcode-terminal");
          qrcodeTerminal.generate(qr, { small: true });
        } catch {
          console.log("\nQR (escanea con WhatsApp):\n" + qr + "\n");
        }
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        sessionReady = false;
        logger.warn(
          { statusCode: lastDisconnect?.error?.output?.statusCode },
          "Conexión cerrada. Reconectando: %s",
          shouldReconnect
        );
        if (shouldReconnect) {
          setTimeout(connect, 5000);
        }
      }

      if (connection === "open") {
        sessionReady = true;
        phoneNumber = sock.user?.id?.split(":")[0] || null;
        logger.info(
          { phone: phoneNumber },
          "WhatsApp conectado"
        );
      }

      // Notify external event handlers (e.g., inbound message listeners)
      for (const handler of eventHandlers) {
        handler({ connection, lastDisconnect, qr });
      }
    });

    // Forward messages.upsert events to registered handlers
    sock.ev.on("messages.upsert", (data) => {
      for (const handler of eventHandlers) {
        handler({ type: "messages.upsert", data });
      }
    });
  }

  /**
   * Register a callback for connection and message events.
   * Used externally to wire up inbound message handling.
   *
   * @param {function} handler — receives { connection, lastDisconnect, qr } or { type: "messages.upsert", data }
   */
  function onEvent(handler) {
    eventHandlers.push(handler);
  }

  /** Returns the current sock (may be null if not connected). */
  function getSock() {
    return sock;
  }

  /** Returns current connection status. */
  function getStatus() {
    return { connected: sessionReady, phone: phoneNumber };
  }

  return { connect, getSock, getStatus, onEvent };
}

module.exports = { createManager };
