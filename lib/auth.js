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
 *
 * Every authenticated request carries `req.principal`, the identity behind
 * the key. The shared API_KEY is the implicit `legacy` principal with scope
 * `all`; per-consumer keys come from the principal store. Scopes are only
 * enforced while API_KEY is set: with it empty, a request without a key is
 * `legacy` and the API stays as open as it always was.
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

/** The identity behind the shared API_KEY, or behind no key when it is unset. */
const LEGACY_PRINCIPAL = Object.freeze({ id: "legacy", name: "legacy", scope: "all" });

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
 * @param {{authenticate: function}} [options.principals] — resolves
 *   per-consumer keys; without it only the shared key exists
 * @returns {function & {enabled: boolean}}
 */
function createAuthMiddleware({ apiKey = "", publicPaths = [], principals = null } = {}) {
  const key = String(apiKey || "");
  const enabled = key.length > 0;
  const open = new Set(publicPaths);

  function middleware(req, res, next) {
    req.principal = null;
    if (open.has(req.path)) return next();

    const presented = presentedKey(req.headers || {});
    if (enabled && presented && safeEqual(presented, key)) {
      req.principal = LEGACY_PRINCIPAL;
      return next();
    }
    const principal = presented && principals ? principals.authenticate(presented) : null;
    if (principal) {
      req.principal = principal;
      return next();
    }
    if (!enabled) {
      req.principal = LEGACY_PRINCIPAL;
      return next();
    }

    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Falta o es inválida la API key (header x-api-key o Authorization: Bearer).",
    });
  }

  middleware.enabled = enabled;
  return middleware;
}

/**
 * Gates a route to principals holding `scope`. Answers 403, not 401: the
 * caller is identified, it just may not do this.
 */
function requireScope(scope) {
  return function scopeGuard(req, res, next) {
    if (req.principal && req.principal.scope === scope) return next();
    return res.status(403).json({
      ok: false,
      error: "forbidden",
      message: `Esta credencial no tiene el scope "${scope}" que requiere esta operación.`,
    });
  };
}

module.exports = { createAuthMiddleware, requireScope, LEGACY_PRINCIPAL };
