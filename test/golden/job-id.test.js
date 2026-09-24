/*
 * Golden (F0) — identity of `job_id` and the contract of /queue/job/:id.
 * Consumers store the id and poll it later, so it stays a positive integer
 * that grows with every accepted send. Do not edit to make them pass.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startApp } = require("./_frozen-harness");

const XLSX = { data: Buffer.from("x"), filename: "a.xlsx", type: "application/octet-stream" };

test("job_id is a positive integer that increases across every send endpoint", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const responses = [
    await app.postJson("/send-text", { to: "5490000000000@s.whatsapp.net", text: "a" }),
    await app.postMultipart("/send-image", {
      to: "5490000000000",
      image: { data: Buffer.from("p"), filename: "a.png", type: "image/png" },
    }),
    await app.postMultipart("/send-file", { to: "5490000000000", file: XLSX }),
    await app.postMultipart("/send-file-dm", { to: "5490000000000", file: XLSX }),
    await app.postJson("/send-text", { to: "5490000000000@s.whatsapp.net", text: "b" }),
  ];
  await app.drained();

  const ids = responses.map((r) => r.body.job_id);
  for (const id of ids) {
    assert.equal(Number.isInteger(id), true, `job_id ${id} is not an integer`);
    assert.ok(id > 0);
  }
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `job_id did not grow: ${ids}`);
  }
});

test("GET /queue/job/:id → {ok, job} with exactly the documented fields", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const { body } = await app.postJson("/send-text", {
    to: "5490000000000@s.whatsapp.net",
    text: "hola",
  });
  await app.drained();

  const res = await app.get(`/queue/job/${body.job_id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["job", "ok"]);
  assert.equal(res.body.ok, true);

  const { job } = res.body;
  assert.deepEqual(Object.keys(job).sort(), [
    "attempts",
    "error",
    "finishedAt",
    "id",
    "queuedAt",
    "startedAt",
    "status",
    "target",
    "type",
  ]);
  assert.equal(job.id, body.job_id);
  assert.equal(job.type, "text");
  assert.equal(job.target, "5490000000000@s.whatsapp.net");
  assert.equal(job.status, "sent");
  assert.equal(job.attempts, 1);
  for (const field of ["queuedAt", "startedAt", "finishedAt"]) {
    assert.equal(Number.isNaN(Date.parse(job[field])), false, `${field} is not a date`);
  }
});

test("GET /queue/job/:id reports the stored type of each endpoint", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const png = { data: Buffer.from("p"), filename: "a.png", type: "image/png" };
  const cases = [
    ["text", await app.postJson("/send-text", { to: "1@s.whatsapp.net", text: "a" })],
    ["image", await app.postMultipart("/send-image", { to: "1", image: png })],
    ["file", await app.postMultipart("/send-file", { to: "1", file: XLSX })],
    ["file-dm", await app.postMultipart("/send-file-dm", { to: "1", file: XLSX })],
  ];
  await app.drained();

  for (const [type, res] of cases) {
    const job = await app.get(`/queue/job/${res.body.job_id}`);
    assert.equal(job.body.job.type, type);
  }
});

test("GET /queue/job/:id rejects anything that is not a positive integer with 400", async (t) => {
  const app = await startApp();
  t.after(app.close);

  for (const id of ["abc", "0", "-1", "1.5"]) {
    const res = await app.get(`/queue/job/${id}`);
    assert.equal(res.status, 400, `id ${id}`);
    assert.deepEqual(res.body, { ok: false, error: "job id inválido" }, `id ${id}`);
  }
});

test("GET /queue/job/:id answers 404 for an unknown id", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const res = await app.get("/queue/job/999999");
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { ok: false, error: "job no encontrado" });
});
