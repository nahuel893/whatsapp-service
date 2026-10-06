/*
 * F4b — a principal registers, lists and removes its own webhooks.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ADMIN, startChatApp } = require("./helpers/chat-app");

async function setup(t) {
  const app = await startChatApp();
  t.after(app.close);
  const a = app.principals.create({ name: "a" });
  const b = app.principals.create({ name: "b" });
  return { app, a, b };
}

test("POST /subscriptions registers a webhook for the caller and returns the secret once", async (t) => {
  const { app, a } = await setup(t);
  const res = await app.call("POST", "/subscriptions", { key: a.key, body: { url: "http://localhost:9000/hook" } });

  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.match(res.body.secret, /^whsec_/);
  assert.equal(res.body.subscription.principalId, a.principal.id);
  assert.equal(res.body.subscription.url, "http://localhost:9000/hook");

  const list = await app.call("GET", "/subscriptions", { key: a.key });
  assert.deepEqual(list.body.subscriptions.map((s) => s.id), [res.body.subscription.id]);
  assert.equal(JSON.stringify(list.body).includes(res.body.secret), false);
});

test("POST /subscriptions rejects a URL that is not http(s) with 400", async (t) => {
  const { app, a } = await setup(t);
  for (const url of ["file:///etc/passwd", "ftp://x", "nada", undefined]) {
    const res = await app.call("POST", "/subscriptions", { key: a.key, body: { url } });
    assert.equal(res.status, 400, String(url));
    assert.equal(res.body.error, "invalid_request");
  }
});

test("a principal sees and removes only its own subscriptions", async (t) => {
  const { app, a, b } = await setup(t);
  const sub = (await app.call("POST", "/subscriptions", { key: a.key, body: { url: "http://a/hook" } })).body.subscription;

  assert.deepEqual((await app.call("GET", "/subscriptions", { key: b.key })).body.subscriptions, []);
  const foreign = await app.call("DELETE", `/subscriptions/${sub.id}`, { key: b.key });
  assert.deepEqual(foreign, { status: 404, body: { ok: false, error: "not_found" } });

  assert.deepEqual(await app.call("DELETE", `/subscriptions/${sub.id}`, { key: a.key }), {
    status: 200,
    body: { ok: true },
  });
  assert.equal((await app.call("DELETE", `/subscriptions/${sub.id}`, { key: a.key })).status, 404);
});

test("the admin key can remove anyone's subscription", async (t) => {
  const { app, a } = await setup(t);
  const sub = (await app.call("POST", "/subscriptions", { key: a.key, body: { url: "http://a/hook" } })).body.subscription;
  assert.equal((await app.call("DELETE", `/subscriptions/${sub.id}`, { key: ADMIN })).status, 200);
});
