"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createSubscriptionStore } = require("../lib/subscription-store");

let tmpDir;
let dbPath;
let subs;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-subs-"));
  dbPath = path.join(tmpDir, "chat.db");
  subs = createSubscriptionStore({ dbPath });
});

afterEach(() => {
  subs.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("create returns the subscription and its signing secret once", () => {
  const { subscription, secret } = subs.create({ principalId: "prn_a", url: "http://localhost:8080/hook" });
  assert.match(subscription.id, /^sub_[0-9a-f]{16}$/);
  assert.match(secret, /^whsec_[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(subscription).sort(), ["createdAt", "id", "principalId", "url"]);
  assert.equal(subscription.url, "http://localhost:8080/hook");
});

test("create accepts only http and https URLs", () => {
  for (const url of ["ftp://x/hook", "file:///etc/passwd", "javascript:alert(1)", "not a url", "", undefined]) {
    assert.throws(() => subs.create({ principalId: "prn_a", url }), undefined, String(url));
  }
  assert.doesNotThrow(() => subs.create({ principalId: "prn_a", url: "https://agent.example/hook" }));
});

test("listFor returns a principal's subscriptions; active returns every live one with its secret", () => {
  const a = subs.create({ principalId: "prn_a", url: "http://a/hook" });
  subs.create({ principalId: "prn_b", url: "http://b/hook" });

  assert.deepEqual(subs.listFor("prn_a").map((s) => s.id), [a.subscription.id]);
  assert.equal(JSON.stringify(subs.listFor("prn_a")).includes(a.secret), false, "listing never shows the secret");

  const active = subs.active();
  assert.equal(active.length, 2);
  assert.equal(active.find((s) => s.id === a.subscription.id).secret, a.secret);
});

test("remove deletes a subscription, optionally only if it belongs to a principal", () => {
  const a = subs.create({ principalId: "prn_a", url: "http://a/hook" });
  assert.equal(subs.remove(a.subscription.id, { principalId: "prn_b" }), false, "not someone else's");
  assert.equal(subs.remove(a.subscription.id, { principalId: "prn_a" }), true);
  assert.equal(subs.remove(a.subscription.id), false);
  assert.deepEqual(subs.active(), []);
});

test("subscriptions survive a reopen", () => {
  const a = subs.create({ principalId: "prn_a", url: "http://a/hook" });
  subs.close();
  subs = createSubscriptionStore({ dbPath });
  assert.equal(subs.active()[0].secret, a.secret);
});
