/*
 * Golden (F0) — error statuses and bodies. The 400 bodies are inconsistent
 * across endpoints (`{error}` alone on /send-image and /send-file, `{ok:false,
 * error}` elsewhere); that inconsistency is part of the frozen contract. Do
 * not edit to make them pass.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startApp } = require("./_frozen-harness");

const SESSION_NOT_READY = {
  error: "session_not_ready",
  message: "WhatsApp no autenticado. Escanea el QR en consola.",
};

const PNG = { data: Buffer.from("p"), filename: "a.png", type: "image/png" };
const XLSX = { data: Buffer.from("x"), filename: "a.xlsx", type: "application/octet-stream" };

test("every session-gated endpoint answers 503 session_not_ready while disconnected", async (t) => {
  const app = await startApp({ connected: false });
  t.after(app.close);

  const responses = {
    "GET /groups": await app.get("/groups"),
    "POST /send-text": await app.postJson("/send-text", {
      to: "5490000000000@s.whatsapp.net",
      text: "hola",
    }),
    "POST /send-image": await app.postMultipart("/send-image", { to: "1", image: PNG }),
    "POST /send-file": await app.postMultipart("/send-file", { to: "1", file: XLSX }),
    "POST /send-file-dm": await app.postMultipart("/send-file-dm", { to: "1", file: XLSX }),
  };

  for (const [route, res] of Object.entries(responses)) {
    assert.equal(res.status, 503, route);
    assert.deepEqual(res.body, SESSION_NOT_READY, route);
  }
  assert.equal(app.queue.getStatus().pending, 0, "nothing may be queued while disconnected");
});

test("read endpoints other than /groups do not require a session", async (t) => {
  const app = await startApp({ connected: false });
  t.after(app.close);

  for (const path of ["/status", "/queue/status", "/health"]) {
    const res = await app.get(path);
    assert.equal(res.status, 200, path);
  }
});

test("POST /send-text 400 bodies", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const cases = [
    [{ text: "hola" }, "to es requerido (string)"],
    [{ to: 5490000000000, text: "hola" }, "to es requerido (string)"],
    [{ to: "5490000000000@s.whatsapp.net" }, "text es requerido (string)"],
    [{ to: "5490000000000@s.whatsapp.net", text: "" }, "text es requerido (string)"],
  ];
  for (const [body, error] of cases) {
    const res = await app.postJson("/send-text", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { ok: false, error });
  }
});

test("POST /send-image 400 bodies are a bare {error}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const noTarget = await app.postMultipart("/send-image", { image: PNG });
  assert.equal(noTarget.status, 400);
  assert.deepEqual(noTarget.body, { error: "to o group_name es requerido" });

  const noImage = await app.postMultipart("/send-image", { to: "5490000000000" });
  assert.equal(noImage.status, 400);
  assert.deepEqual(noImage.body, { error: "image es requerido" });
});

test("POST /send-file 400 bodies are a bare {error}", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const noTarget = await app.postMultipart("/send-file", { file: XLSX });
  assert.equal(noTarget.status, 400);
  assert.deepEqual(noTarget.body, { error: "to o group_name es requerido" });

  const noFile = await app.postMultipart("/send-file", { to: "5490000000000" });
  assert.equal(noFile.status, 400);
  assert.deepEqual(noFile.body, { error: "file es requerido" });
});

test("POST /send-file-dm 400 bodies carry ok:false", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const noTarget = await app.postMultipart("/send-file-dm", { file: XLSX });
  assert.equal(noTarget.status, 400);
  assert.deepEqual(noTarget.body, { ok: false, error: "to o group_name es requerido" });

  const noFile = await app.postMultipart("/send-file-dm", { to: "5490000000000" });
  assert.equal(noFile.status, 400);
  assert.deepEqual(noFile.body, { ok: false, error: "file es requerido" });
});

test("a rejected request never creates a job", async (t) => {
  const app = await startApp();
  t.after(app.close);

  await app.postJson("/send-text", { text: "hola" });
  await app.postMultipart("/send-image", { image: PNG });
  await app.postMultipart("/send-file-dm", { to: "1" });

  const status = await app.get("/queue/status");
  assert.equal(status.body.pending, 0);
  assert.deepEqual(status.body.recent, []);
});

test("with API_KEY set, requests without it get 401 {ok:false, error:'unauthorized', message}", async (t) => {
  const app = await startApp({ apiKey: "secret" });
  t.after(app.close);

  const denied = await app.postJson("/send-text", {
    to: "5490000000000@s.whatsapp.net",
    text: "hola",
  });
  assert.equal(denied.status, 401);
  assert.deepEqual(denied.body, {
    ok: false,
    error: "unauthorized",
    message: "Falta o es inválida la API key (header x-api-key o Authorization: Bearer).",
  });

  const allowed = await app.get("/status", { headers: { "x-api-key": "secret" } });
  assert.equal(allowed.status, 200);
});

test("with API_KEY empty the API stays open (current consumers send no key)", async (t) => {
  const app = await startApp({ apiKey: "" });
  t.after(app.close);

  const res = await app.postJson("/send-text", {
    to: "5490000000000@s.whatsapp.net",
    text: "hola",
  });
  assert.equal(res.status, 200);
  await app.drained();
});
