/**
 * Auth — API key middleware.
 *
 * The service sends WhatsApp messages from a real personal number, so anyone
 * who can reach the port can impersonate that number. This gates every
 * endpoint behind a shared key.
 *
 * When `API_KEY` is empty the middleware is a pass-through, which keeps the
 * localhost-behind-Tailscale deployment working unchanged. Any deployment
 * reachable from elsewhere must set it.
 */
"use strict";

const crypto = require("node:crypto");

/** Constant-time comparison that does not leak length through early return. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Extracts the presented key from either supported header. */
function presentedKey(headers) {
  const direct = headers["x-api-key"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * Builds the API key middleware.
 *
 * @param {object} options
 * @param {string} [options.apiKey] — shared secret; empty disables the check
 * @param {string[]} [options.publicPaths] — paths that never require the key
 * @returns {function & {enabled: boolean}}
 */
function createAuthMiddleware({ apiKey = "", publicPaths = [] } = {}) {
  const key = String(apiKey || "");
  const enabled = key.length > 0;
  const open = new Set(publicPaths);

  function middleware(req, res, next) {
    if (!enabled) return next();
    if (open.has(req.path)) return next();

    const presented = presentedKey(req.headers || {});
    if (presented && safeEqual(presented, key)) return next();

    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Falta o es inválida la API key (header x-api-key o Authorization: Bearer).",
    });
  }

  middleware.enabled = enabled;
  return middleware;
}

module.exports = { createAuthMiddleware };
