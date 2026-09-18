/*
 * These are golden compatibility tests for phase F0.
 * They capture observable behavior of the current implementation; they start
 * green. Making them pass by editing them hides a break in a real consumer
 * instead of fixing it. They are only changed when a contract change is an
 * explicit, documented decision.
 *
 * This harness is shared ONLY among test/golden/*. It is deliberately not
 * shared with test/api.test.js, so that a future refactor of that file cannot
 * silently change what the golden tests mean.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { createJobStore } = require("../../lib/job-store");
const { createMessageQueue } = require("../../lib/message-queue");
const { createRouter } = require("../../lib/api");

const DEFAULT_PHONE = "5490000000000";
const DEFAULT_GROUP = {
  id: "123@g.us",
  subject: "Equipo Ventas",
  size: 4,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates an isolated Baileys stand-in. The returned `sent` array is owned by
 * this instance and records every call as `{ jid, content }`.
 */
function createFakeBaileys({ connected = true, warmupMs = 0 } = {}) {
  const sent = [];
  const connectedAt = connected ? 1 : 1;
  const warmupStartedAt = Date.now();

  const sock = {
    async sendMessage(jid, content) {
      sent.push({ jid, content });
    },

    async groupFetchAllParticipating() {
      return {
        [DEFAULT_GROUP.id]: { ...DEFAULT_GROUP },
      };
    },
  };

  const baileys = {
    getStatus() {
      return {
        connected,
        phone: DEFAULT_PHONE,
        connectedAt,
      };
    },

    getSock() {
      return sock;
    },

    async waitForWarmup(requestedWarmupMs = warmupMs) {
      const duration = Number(requestedWarmupMs) || 0;
      const remaining = duration - (Date.now() - warmupStartedAt);
      if (connected && remaining > 0) await sleep(remaining);
    },
  };

  return { baileys, sent };
}

function resolveUrl(baseUrl, pathname) {
  if (/^https?:\/\//.test(pathname)) return pathname;
  return `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

async function parseResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    status: response.status,
    body,
    headers: response.headers,
  };
}

function normalizeRequestOptions(options) {
  if (!options) return {};
  if (typeof options === "object") return options;
  throw new TypeError("request options must be an object");
}

function fileSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value.data ?? value.bytes ?? value.content;
  const filename = value.filename ?? value.name;
  if (data === undefined || filename === undefined) return null;
  return {
    data,
    filename: String(filename),
    type: value.type ?? value.mimetype ?? "application/octet-stream",
  };
}

/**
 * Starts one fully isolated Express/API/SQLite instance.
 *
 * Options: `apiKey` (default ""), `connected` (default true),
 * `minDelayMs`/`maxDelayMs` (default 0), and `warmupMs` (default 0).
 * The resolved instance exposes `baseUrl`, `sent`, `baileys`, `queue`,
 * `store`, `drained(timeout)`, `postJson`, `postMultipart`, `get`, and
 * `close`.
 */
async function startApp({
  apiKey = "",
  connected = true,
  minDelayMs = 0,
  maxDelayMs = 0,
  warmupMs = 0,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-golden-"));
  const store = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
  const queue = createMessageQueue({ store, minDelayMs, maxDelayMs });
  const { baileys, sent } = createFakeBaileys({ connected, warmupMs });

  const app = express();
  app.use(createRouter(baileys, queue, { warmupMs, apiKey }));
  queue.start();

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let closed = false;

  async function request(method, pathname, body, options = {}) {
    const requestOptions = normalizeRequestOptions(options);
    const headers = { ...(requestOptions.headers || {}) };
    const init = {
      ...requestOptions,
      method,
      headers,
    };
    if (body !== undefined) init.body = body;
    delete init.baseUrl;
    return parseResponse(await fetch(resolveUrl(baseUrl, pathname), init));
  }

  async function postJson(pathname, body, options = {}) {
    const requestOptions = normalizeRequestOptions(options);
    const headers = {
      "content-type": "application/json",
      ...(requestOptions.headers || {}),
    };
    return request("POST", pathname, JSON.stringify(body), {
      ...requestOptions,
      headers,
    });
  }

  /**
   * Posts multipart data. Scalar `fields` become text fields. A file can be
   * supplied as the third argument `{ field, filename, data|bytes|content,
   * type }`, or embedded as a field value with the same shape.
   *
   * Options are the fourth argument when a separate file is supplied, or the
   * third argument when the file is embedded. Supported options include
   * `headers` and the normal fetch RequestInit fields.
   */
  async function postMultipart(pathname, fields = {}, file, options = {}) {
    let requestOptions = options;
    let separateFile = file;
    if (separateFile && !fileSpec(separateFile)) {
      requestOptions = separateFile;
      separateFile = null;
    }

    const form = new FormData();
    for (const [name, value] of Object.entries(fields || {})) {
      const embeddedFile = fileSpec(value);
      if (embeddedFile) {
        form.append(
          name,
          new Blob([embeddedFile.data], { type: embeddedFile.type }),
          embeddedFile.filename
        );
      } else if (value !== undefined && value !== null) {
        form.append(name, String(value));
      }
    }

    if (separateFile) {
      const normalized = fileSpec(separateFile);
      if (!normalized) {
        throw new TypeError("multipart file must include data and filename");
      }
      const field = separateFile.field ?? separateFile.fieldName;
      if (!field) throw new TypeError("multipart file must include field");
      form.append(
        field,
        new Blob([normalized.data], { type: normalized.type }),
        normalized.filename
      );
    }

    const normalizedOptions = normalizeRequestOptions(requestOptions);
    return request("POST", pathname, form, {
      ...normalizedOptions,
      headers: { ...(normalizedOptions.headers || {}) },
    });
  }

  async function get(pathname, options = {}) {
    return request("GET", pathname, undefined, options);
  }

  /** Resolves when this instance's queue is idle, or rejects on timeout. */
  function drained(timeout = 5000) {
    const timeoutMs = typeof timeout === "object" ? timeout.timeoutMs : timeout;
    const limit = Number(timeoutMs);
    if (!Number.isFinite(limit) || limit < 0) {
      throw new TypeError("drained timeout must be a non-negative number");
    }

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + limit;
      let timer;
      const check = () => {
        const status = queue.getStatus();
        if (status.pending === 0 && !status.processing) {
          if (timer) clearTimeout(timer);
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          if (timer) clearTimeout(timer);
          reject(new Error(`queue did not drain within ${limit}ms`));
          return;
        }
        timer = setTimeout(check, 5);
      };
      check();
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    app,
    server,
    baseUrl,
    tmpDir,
    store,
    queue,
    baileys,
    sent,
    request,
    postJson,
    postMultipart,
    get,
    drained,
    close,
    teardown: close,
  };
}

module.exports = {
  createFakeBaileys,
  startApp,
};
