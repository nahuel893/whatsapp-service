"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { createJobStore } = require("../lib/job-store");
const { createMessageQueue } = require("../lib/message-queue");
const { createRouter } = require("../lib/api");

let tmpDir;
let store;
let queue;
let server;
let baseUrl;
let sent;

/** Minimal Baileys stand-in: records sends instead of touching WhatsApp. */
function fakeBaileys({ connected = true } = {}) {
  return {
    getStatus: () => ({ connected, phone: "5490000000000", connectedAt: 1 }),
    getSock: () => ({
      sendMessage: async (jid, content) => {
        sent.push({ jid, content });
      },
      groupFetchAllParticipating: async () => ({
        "123@g.us": { id: "123@g.us", subject: "Equipo Ventas", size: 4 },
      }),
    }),
    waitForWarmup: async () => {},
  };
}

async function startApp({ apiKey = "", connected = true } = {}) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-api-"));
  store = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
  queue = createMessageQueue({ store, minDelayMs: 0, maxDelayMs: 0 });

  const app = express();
  app.use(createRouter(fakeBaileys({ connected }), queue, { warmupMs: 0, apiKey }));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

function drained() {
  return new Promise((resolve) => {
    const tick = () => {
      const status = queue.getStatus();
      if (status.pending === 0 && !status.processing) return resolve();
      setTimeout(tick, 5);
    };
    tick();
  });
}

beforeEach(() => {
  sent = [];
});

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  if (store) store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /health", () => {
  test("reports ok and the WhatsApp connection state", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.whatsapp.connected, true);
    assert.equal(typeof body.uptimeSeconds, "number");
  });

  test("stays 200 with whatsapp disconnected — the process is alive either way", async () => {
    await startApp({ connected: false });
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).whatsapp.connected, false);
  });

  test("answers without credentials even when an API key is configured", async () => {
    await startApp({ apiKey: "s3cret" });
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  });
});

describe("authentication", () => {
  test("blocks /send-text without the key and lets it through with the key", async () => {
    await startApp({ apiKey: "s3cret" });

    const denied = await fetch(`${baseUrl}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "5491111@s.whatsapp.net", text: "hola" }),
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "s3cret" },
      body: JSON.stringify({ to: "5491111@s.whatsapp.net", text: "hola" }),
    });
    assert.equal(allowed.status, 200);
  });

  test("blocks /status without the key", async () => {
    await startApp({ apiKey: "s3cret" });
    assert.equal((await fetch(`${baseUrl}/status`)).status, 401);
  });

  test("with no key configured every endpoint stays open", async () => {
    await startApp();
    assert.equal((await fetch(`${baseUrl}/status`)).status, 200);
  });
});

describe("POST /send-text", () => {
  test("enqueues and actually delivers the text", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "5491111@s.whatsapp.net", text: "hola" }),
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.queued, true);
    assert.equal(typeof body.job_id, "number");

    await drained();
    assert.deepEqual(sent, [{ jid: "5491111@s.whatsapp.net", content: { text: "hola" } }]);
  });

  test("rejects a target that is not a DM jid", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "5491111", text: "hola" }),
    });
    assert.equal(res.status, 400);
  });

  test("returns 503 when WhatsApp is not connected", async () => {
    await startApp({ connected: false });
    const res = await fetch(`${baseUrl}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "5491111@s.whatsapp.net", text: "hola" }),
    });
    assert.equal(res.status, 503);
  });
});

describe("POST /send-file", () => {
  test("delivers the uploaded bytes as a document", async () => {
    await startApp();
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99]);
    const form = new FormData();
    form.set("to", "5491111");
    form.set("caption", "informe");
    form.set("file", new Blob([bytes], { type: "application/vnd.ms-excel" }), "informe.xlsx");

    const res = await fetch(`${baseUrl}/send-file`, { method: "POST", body: form });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);

    await drained();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, "5491111@s.whatsapp.net");
    assert.equal(sent[0].content.fileName, "informe.xlsx");
    assert.equal(sent[0].content.caption, "informe");
    assert.deepEqual(Buffer.from(sent[0].content.document), bytes);
  });

  test("resolves a group by its subject", async () => {
    await startApp();
    const form = new FormData();
    form.set("group_name", "equipo ventas");
    form.set("file", new Blob([Buffer.from("x")], { type: "text/plain" }), "a.txt");

    await fetch(`${baseUrl}/send-file`, { method: "POST", body: form });
    await drained();
    assert.equal(sent[0].jid, "123@g.us");
  });

  test("rejects a request with no file", async () => {
    await startApp();
    const form = new FormData();
    form.set("to", "5491111");
    const res = await fetch(`${baseUrl}/send-file`, { method: "POST", body: form });
    assert.equal(res.status, 400);
  });
});

describe("GET /queue/job/:id", () => {
  test("reports the job outcome so a consumer can confirm delivery", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "5491111@s.whatsapp.net", text: "hola" }),
    });
    const { job_id: jobId } = await res.json();
    await drained();

    const job = await (await fetch(`${baseUrl}/queue/job/${jobId}`)).json();
    assert.equal(job.ok, true);
    assert.equal(job.job.id, jobId);
    assert.equal(job.job.status, "sent");
  });

  test("returns 404 for an unknown job", async () => {
    await startApp();
    assert.equal((await fetch(`${baseUrl}/queue/job/999999`)).status, 404);
  });

  test("returns 400 for a non-numeric id", async () => {
    await startApp();
    assert.equal((await fetch(`${baseUrl}/queue/job/abc`)).status, 400);
  });
});

describe("GET /groups", () => {
  test("lists participating groups", async () => {
    await startApp();
    const body = await (await fetch(`${baseUrl}/groups`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.count, 1);
    assert.equal(body.groups[0].subject, "Equipo Ventas");
  });
});
