/*
 * The pre-port endpoints must send through the ChatTransport, never by
 * calling the Baileys socket directly. That is what lets a different adapter
 * take over without touching the HTTP layer.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { createJobStore } = require("../../lib/job-store");
const { createMessageQueue } = require("../../lib/message-queue");
const { createRouter } = require("../../lib/api");
const { createBaileysTransport } = require("../../lib/transport/baileys");

function createManagerWithoutDirectSends() {
  const sock = {
    async sendMessage() {
      throw new Error("the router must not call sock.sendMessage directly");
    },
    async groupFetchAllParticipating() {
      return { "123@g.us": { id: "123@g.us", subject: "Equipo Ventas" } };
    },
  };
  return {
    getStatus: () => ({ connected: true, phone: "5490000000000", connectedAt: 1 }),
    getSock: () => sock,
    onEvent: () => () => {},
    async connect() {},
  };
}

async function start(transport, manager) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-wiring-"));
  const store = createJobStore({ dbPath: path.join(tmpDir, "queue.db") });
  const queue = createMessageQueue({ store, minDelayMs: 0, maxDelayMs: 0 });
  const app = express();
  app.use(createRouter(manager, queue, { transport }));
  queue.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    queue,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function drained(queue) {
  for (let i = 0; i < 500; i++) {
    const s = queue.getStatus();
    if (s.pending === 0 && !s.processing) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("queue did not drain");
}

test("every send endpoint delivers through transport.send()", async (t) => {
  const manager = createManagerWithoutDirectSends();
  const base = createBaileysTransport(manager);
  const calls = [];
  const transport = {
    ...base,
    async send(addr, content) {
      calls.push({ addr, content });
      return { externalId: `T-${calls.length}` };
    },
  };
  const app = await start(transport, manager);
  t.after(app.close);

  const post = (p, init) => fetch(`${app.url}${p}`, { method: "POST", ...init });
  const form = (fields) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    return f;
  };

  await post("/send-text", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "5490000000000@s.whatsapp.net", text: "hola" }),
  });
  await post("/send-image", {
    body: form({ to: "Equipo Ventas", caption: "c", image: new Blob(["p"], { type: "image/png" }) }),
  });
  await post("/send-file", {
    body: form({ to: "5490000000000", file: new File(["x"], "a.xlsx", { type: "application/x" }) }),
  });
  await post("/send-file-dm", {
    body: form({ to: "5490000000000", file: new File(["y"], "b.xlsx", { type: "application/y" }) }),
  });
  await drained(app.queue);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], { addr: { jid: "5490000000000@s.whatsapp.net" }, content: { text: "hola" } });

  assert.deepEqual(calls[1].addr, { jid: "123@g.us" });
  assert.equal(Buffer.from(calls[1].content.image.data).toString(), "p");
  assert.equal(calls[1].content.image.mimetype, "image/png");
  assert.equal(calls[1].content.caption, "c");

  for (const [call, name, body, mimetype] of [
    [calls[2], "a.xlsx", "x", "application/x"],
    [calls[3], "b.xlsx", "y", "application/y"],
  ]) {
    assert.deepEqual(call.addr, { jid: "5490000000000@s.whatsapp.net" });
    assert.equal(call.content.document.fileName, name);
    assert.equal(call.content.document.mimetype, mimetype);
    assert.equal(Buffer.from(call.content.document.data).toString(), body);
    assert.equal(call.content.caption, "");
  }
});

test("createRouter rejects a transport that does not implement the port", () => {
  const manager = createManagerWithoutDirectSends();
  const queue = { registerHandler() {} };
  assert.throws(() => createRouter(manager, queue, { transport: { send() {} } }), /missing/);
});
