/*
 * Golden (F0) — response shapes of the four send endpoints, and what each one
 * hands to WhatsApp. Consumers parse these bodies today: `ok` vs `success` and
 * the presence of `message` are frozen exactly as they are, inconsistency
 * included. Do not edit to make them pass. See _frozen-harness.js.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startApp } = require("./_frozen-harness");

const PNG = { data: Buffer.from("fake-png"), filename: "chart.png", type: "image/png" };
const XLSX = {
  data: Buffer.from("fake-xlsx"),
  filename: "informe.xlsx",
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

test("POST /send-text → {ok, queued, job_id}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.postJson("/send-text", {
    to: "5490000000000@s.whatsapp.net",
    text: "hola",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["job_id", "ok", "queued"]);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.queued, true);

  await app.drained();
  assert.deepEqual(app.sent, [
    { jid: "5490000000000@s.whatsapp.net", content: { text: "hola" } },
  ]);
});

test("POST /send-image → {success, queued, job_id, message}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.postMultipart("/send-image", {
    to: "5490000000000",
    caption: "Ventas",
    image: PNG,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["job_id", "message", "queued", "success"]);
  assert.equal(res.body.success, true);
  assert.equal(res.body.queued, true);
  assert.equal(res.body.message, "Imagen encolada para 5490000000000");
  assert.equal("ok" in res.body, false);

  await app.drained();
  assert.equal(app.sent.length, 1);
  const { jid, content } = app.sent[0];
  assert.equal(jid, "5490000000000@s.whatsapp.net");
  assert.deepEqual(Object.keys(content).sort(), ["caption", "image", "mimetype"]);
  assert.equal(Buffer.from(content.image).toString(), "fake-png");
  assert.equal(content.caption, "Ventas");
  assert.equal(content.mimetype, "image/png");
});

test("POST /send-file → {success, queued, job_id, message}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.postMultipart("/send-file", {
    to: "5490000000000",
    caption: "Informe",
    file: XLSX,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["job_id", "message", "queued", "success"]);
  assert.equal(res.body.success, true);
  assert.equal(res.body.queued, true);
  assert.equal(res.body.message, "Archivo encolado para 5490000000000");
  assert.equal("ok" in res.body, false);

  await app.drained();
  assert.equal(app.sent.length, 1);
  const { jid, content } = app.sent[0];
  assert.equal(jid, "5490000000000@s.whatsapp.net");
  assert.deepEqual(Object.keys(content).sort(), ["caption", "document", "fileName", "mimetype"]);
  assert.equal(Buffer.from(content.document).toString(), "fake-xlsx");
  assert.equal(content.fileName, "informe.xlsx");
  assert.equal(content.caption, "Informe");
  assert.equal(content.mimetype, XLSX.type);
});

test("POST /send-file-dm → {ok, queued, job_id} with no message", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.postMultipart("/send-file-dm", {
    to: "5490000000000",
    caption: "Informe",
    file: XLSX,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["job_id", "ok", "queued"]);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.queued, true);
  assert.equal("success" in res.body, false);
  assert.equal("message" in res.body, false);

  await app.drained();
  assert.equal(app.sent.length, 1);
  const { jid, content } = app.sent[0];
  assert.equal(jid, "5490000000000@s.whatsapp.net");
  assert.deepEqual(Object.keys(content).sort(), ["caption", "document", "fileName", "mimetype"]);
  assert.equal(content.fileName, "informe.xlsx");
});

test("caption is optional and defaults to an empty string", async (t) => {
  const app = await startApp();
  t.after(app.close);

  await app.postMultipart("/send-image", { to: "5490000000000", image: PNG });
  await app.postMultipart("/send-file", { to: "5490000000000", file: XLSX });
  await app.drained();

  assert.equal(app.sent.length, 2);
  assert.equal(app.sent[0].content.caption, "");
  assert.equal(app.sent[1].content.caption, "");
});

test("a job becomes `sent` in /queue/job/:id once delivered", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const { body } = await app.postJson("/send-text", {
    to: "5490000000000@s.whatsapp.net",
    text: "hola",
  });
  await app.drained();

  const job = await app.get(`/queue/job/${body.job_id}`);
  assert.equal(job.status, 200);
  assert.equal(job.body.ok, true);
  assert.equal(job.body.job.status, "sent");
  assert.equal(job.body.job.error, null);
});
