/*
 * Golden (F0) — how a `to` / `group_name` becomes the JID handed to WhatsApp.
 * Every existing consumer addresses recipients through these rules, so any
 * new transport has to keep resolving them the same way. Do not edit to make
 * them pass.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startApp } = require("./_frozen-harness");

const PNG = { data: Buffer.from("p"), filename: "a.png", type: "image/png" };

async function sendImage(app, fields) {
  const res = await app.postMultipart("/send-image", { ...fields, image: PNG });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await app.drained();
  return (await app.get(`/queue/job/${res.body.job_id}`)).body.job;
}

const RESOLVED = [
  // [description, fields, expected JID]
  ["bare number", { to: "5490000000000" }, "5490000000000@s.whatsapp.net"],
  ["number with symbols", { to: "+54 9 000-000-0000" }, "5490000000000@s.whatsapp.net"],
  ["full DM JID, used as is", { to: "5490000000000@s.whatsapp.net" }, "5490000000000@s.whatsapp.net"],
  ["group JID, used as is", { to: "120363000000000000@g.us" }, "120363000000000000@g.us"],
  ["legacy group JID, used as is", { to: "5490000000001-1576247284@g.us" }, "5490000000001-1576247284@g.us"],
  ["@lid JID, passed through untouched", { to: "100000000000000@lid" }, "100000000000000@lid"],
  ["group name, exact case", { to: "Equipo Ventas" }, "123@g.us"],
  ["group name, case-insensitive", { to: "equipo VENTAS" }, "123@g.us"],
  ["legacy group_name field", { group_name: "Equipo Ventas" }, "123@g.us"],
];

for (const [description, fields, expected] of RESOLVED) {
  test(`target resolution: ${description}`, async (t) => {
    const app = await startApp();
    t.after(app.close);

    const job = await sendImage(app, fields);
    assert.equal(job.status, "sent");
    assert.equal(app.sent.length, 1);
    assert.equal(app.sent[0].jid, expected);
  });
}

test("target resolution: `to` wins over `group_name`", async (t) => {
  const app = await startApp();
  t.after(app.close);

  await sendImage(app, { to: "5490000000000", group_name: "Equipo Ventas" });
  assert.equal(app.sent[0].jid, "5490000000000@s.whatsapp.net");
});

test("target resolution: the job keeps the raw target as the caller sent it", async (t) => {
  const app = await startApp();
  t.after(app.close);

  const job = await sendImage(app, { to: "equipo VENTAS" });
  assert.equal(job.target, "equipo VENTAS");
});

for (const name of ["Grupo Fantasma", "Sucursal 5"]) {
  test(`target resolution: unknown group "${name}" fails the job instead of sending`, async (t) => {
    const app = await startApp();
    t.after(app.close);

    const job = await sendImage(app, { to: name });
    assert.equal(job.status, "error");
    assert.match(job.error, /No existe un grupo llamado/);
    assert.equal(app.sent.length, 0);
  });
}

test("target resolution: /send-text only accepts @s.whatsapp.net", async (t) => {
  const app = await startApp();
  t.after(app.close);

  for (const to of ["5490000000000", "123@g.us", "Equipo Ventas", "100000000000000@lid"]) {
    const res = await app.postJson("/send-text", { to, text: "hola" });
    assert.equal(res.status, 400, to);
    assert.deepEqual(res.body, {
      ok: false,
      error: "to debe terminar en @s.whatsapp.net (solo DMs)",
    });
  }
  await app.drained();
  assert.equal(app.sent.length, 0);
});
