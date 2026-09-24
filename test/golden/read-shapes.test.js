/*
 * Golden (F0) — shapes of the read endpoints: /status, /queue/status,
 * /health and /groups. Monitoring scripts and consumers read these fields
 * by name. Do not edit to make them pass.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startApp } = require("./_frozen-harness");

const JOB_TYPES = new Set(["text", "image", "file", "file-dm"]);
const JOB_STATUSES = new Set(["pending", "processing", "sent", "error"]);

test("GET /status → {connected, phone, connectedAt}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.get("/status");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { connected: true, phone: "5490000000000", connectedAt: 1 });
});

test("GET /queue/status → {pending, processing, minDelayMs, maxDelayMs, recent[]}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const empty = await app.get("/queue/status");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, {
    pending: 0,
    processing: false,
    minDelayMs: 0,
    maxDelayMs: 0,
    recent: [],
  });

  await app.postJson("/send-text", { to: "5490000000000@s.whatsapp.net", text: "a" });
  await app.postMultipart("/send-image", {
    to: "Grupo Fantasma",
    image: { data: Buffer.from("p"), filename: "a.png", type: "image/png" },
  });
  await app.drained();

  const res = await app.get("/queue/status");
  assert.deepEqual(Object.keys(res.body).sort(), [
    "maxDelayMs",
    "minDelayMs",
    "pending",
    "processing",
    "recent",
  ]);
  assert.equal(res.body.recent.length, 2);
  for (const item of res.body.recent) {
    assert.deepEqual(Object.keys(item).sort(), [
      "error",
      "finishedAt",
      "id",
      "status",
      "target",
      "type",
    ]);
    assert.equal(Number.isInteger(item.id), true);
    assert.ok(JOB_TYPES.has(item.type), `unexpected type ${item.type}`);
    assert.ok(JOB_STATUSES.has(item.status), `unexpected status ${item.status}`);
  }

  // Newest first.
  const [newest, oldest] = res.body.recent;
  assert.ok(newest.id > oldest.id);
  assert.equal(newest.status, "error");
  assert.equal(typeof newest.error, "string");
  assert.equal(oldest.status, "sent");
  assert.equal(oldest.error, null);
});

test("GET /health → {status, uptimeSeconds, whatsapp, queue{pending, processing}}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.get("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["queue", "status", "uptimeSeconds", "whatsapp"]);
  assert.equal(res.body.status, "ok");
  assert.equal(Number.isInteger(res.body.uptimeSeconds), true);
  assert.ok(res.body.uptimeSeconds >= 0);
  assert.deepEqual(res.body.whatsapp, { connected: true, phone: "5490000000000", connectedAt: 1 });
  assert.deepEqual(res.body.queue, { pending: 0, processing: false });
});

test("GET /health stays 200 with WhatsApp disconnected and needs no credentials", async (t) => {
  const app = await startApp({ connected: false, apiKey: "secret" });
  t.after(app.close);

  const res = await app.get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.whatsapp.connected, false);
});

test("GET /groups → {ok, count, groups[{id, subject, size}]}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.get("/groups");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true,
    count: 1,
    groups: [{ id: "123@g.us", subject: "Equipo Ventas", size: 4 }],
  });
});
