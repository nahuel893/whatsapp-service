/*
 * Starts the full HTTP stack (router + chat API) over temporary stores, for
 * the chat tests. Not used by test/golden/*, which keeps its own frozen harness.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { createJobStore } = require("../../lib/job-store");
const { createMessageQueue } = require("../../lib/message-queue");
const { createRouter } = require("../../lib/api");
const { createConversationStore } = require("../../lib/conversation-store");
const { createPrincipalStore } = require("../../lib/principal-store");

const ADMIN = "admin-key";

function fakeManager() {
  const sock = {
    async sendMessage() {
      return { key: { id: "WA-1" } };
    },
    async groupFetchAllParticipating() {
      return {};
    },
  };
  return {
    getStatus: () => ({ connected: true, phone: "5490000000000", connectedAt: 1 }),
    getSock: () => sock,
    onEvent: () => () => {},
    async connect() {},
  };
}

async function startChatApp({ apiKey = ADMIN } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-admin-"));
  const chatDb = path.join(tmpDir, "chat.db");
  const conversations = createConversationStore({ dbPath: chatDb });
  const principals = createPrincipalStore({ dbPath: chatDb });
  const store = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
  const queue = createMessageQueue({ store, minDelayMs: 0, maxDelayMs: 0 });

  const app = express();
  app.use(createRouter(fakeManager(), queue, { apiKey, principals, conversations }));
  queue.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, pathname, { key, body } = {}) {
    const headers = {};
    if (key) headers["x-api-key"] = key;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text; // Express' own 404 page is HTML
    }
    return { status: res.status, body: parsed };
  }

  return {
    call,
    principals,
    conversations,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      principals.close();
      conversations.close();
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

module.exports = { ADMIN, startChatApp };
