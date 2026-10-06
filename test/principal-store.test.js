"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createConversationStore } = require("../lib/conversation-store");
const { createPrincipalStore } = require("../lib/principal-store");

let tmpDir;
let dbPath;
let conversations;
let principals;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-prn-"));
  dbPath = path.join(tmpDir, "chat.db");
  conversations = createConversationStore({ dbPath });
  principals = createPrincipalStore({ dbPath });
});

afterEach(() => {
  principals.close();
  conversations.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("create returns the principal and its key exactly once", () => {
  const { principal, key } = principals.create({ name: "agente-ventas" });

  assert.match(principal.id, /^prn_[0-9a-f]{16}$/);
  assert.match(key, /^wsk_[0-9a-f]{64}$/);
  assert.deepEqual(
    { name: principal.name, scope: principal.scope, revokedAt: principal.revokedAt },
    { name: "agente-ventas", scope: "conversations", revokedAt: null }
  );
  assert.equal(Number.isNaN(Date.parse(principal.createdAt)), false);
  assert.equal("key" in principal, false);
  assert.equal("keyHash" in principal, false);
});

test("the key is stored hashed, never in clear", () => {
  const { key } = principals.create({ name: "a" });
  principals.close();
  const raw = fs.readFileSync(dbPath).toString("latin1") +
    (fs.existsSync(`${dbPath}-wal`) ? fs.readFileSync(`${dbPath}-wal`).toString("latin1") : "");
  assert.equal(raw.includes(key), false);
  principals = createPrincipalStore({ dbPath });
});

test("create accepts scope all and rejects unknown scopes and empty names", () => {
  assert.equal(principals.create({ name: "admin", scope: "all" }).principal.scope, "all");
  assert.throws(() => principals.create({ name: "x", scope: "root" }));
  assert.throws(() => principals.create({ name: "" }));
  assert.throws(() => principals.create({ name: "   " }));
  assert.throws(() => principals.create({}));
});

test("authenticate resolves a valid key and nothing else", () => {
  const { principal, key } = principals.create({ name: "a" });
  assert.equal(principals.authenticate(key).id, principal.id);
  assert.equal(principals.authenticate(`${key}x`), null);
  assert.equal(principals.authenticate("wsk_nope"), null);
  assert.equal(principals.authenticate(""), null);
  assert.equal(principals.authenticate(null), null);
});

test("a revoked principal no longer authenticates", () => {
  const { principal, key } = principals.create({ name: "a" });
  assert.equal(principals.revoke(principal.id), true);
  assert.equal(principals.authenticate(key), null);
  assert.equal(principals.revoke(principal.id), false, "revoking twice reports nothing changed");
  assert.equal(principals.revoke("prn_0000000000000000"), false);
  assert.notEqual(principals.get(principal.id).revokedAt, null);
});

test("list returns every principal without secrets", () => {
  principals.create({ name: "a" });
  principals.create({ name: "b", scope: "all" });
  const list = principals.list();
  assert.deepEqual(list.map((p) => p.name), ["a", "b"]);
  for (const p of list) {
    assert.deepEqual(Object.keys(p).sort(), ["createdAt", "id", "name", "revokedAt", "scope"]);
  }
});

test("grants give a principal access to specific conversations", () => {
  const { principal } = principals.create({ name: "a" });
  const conv = conversations.resolveConversation("whatsapp:+5490000000000");
  const other = conversations.resolveConversation("whatsapp:+5491111111111");

  assert.equal(principals.isGranted(principal.id, conv.id), false);
  assert.deepEqual(principals.grant(principal.id, conv.id), { created: true });
  assert.deepEqual(principals.grant(principal.id, conv.id), { created: false }, "granting twice is idempotent");

  assert.equal(principals.isGranted(principal.id, conv.id), true);
  assert.equal(principals.isGranted(principal.id, other.id), false);
  assert.deepEqual(principals.grantedConversationIds(principal.id), [conv.id]);
});

test("grants are per principal", () => {
  const a = principals.create({ name: "a" }).principal;
  const b = principals.create({ name: "b" }).principal;
  const conv = conversations.resolveConversation("whatsapp:+5490000000000");
  principals.grant(a.id, conv.id);
  assert.equal(principals.isGranted(b.id, conv.id), false);
});

test("revokeGrant removes access", () => {
  const { principal } = principals.create({ name: "a" });
  const conv = conversations.resolveConversation("whatsapp:+5490000000000");
  principals.grant(principal.id, conv.id);
  assert.equal(principals.revokeGrant(principal.id, conv.id), true);
  assert.equal(principals.isGranted(principal.id, conv.id), false);
  assert.equal(principals.revokeGrant(principal.id, conv.id), false);
});

test("grant rejects an unknown principal or conversation", () => {
  const { principal } = principals.create({ name: "a" });
  const conv = conversations.resolveConversation("whatsapp:+5490000000000");
  assert.throws(() => principals.grant("prn_0000000000000000", conv.id), /principal/);
  assert.throws(() => principals.grant(principal.id, "conv_0000000000000000"), /conversation/);
});

test("principals and grants survive a reopen", () => {
  const { principal, key } = principals.create({ name: "a" });
  const conv = conversations.resolveConversation("whatsapp:+5490000000000");
  principals.grant(principal.id, conv.id);
  principals.close();

  principals = createPrincipalStore({ dbPath });
  assert.equal(principals.authenticate(key).id, principal.id);
  assert.equal(principals.isGranted(principal.id, conv.id), true);
});

test("read markers start at 0, only move forward, and are per principal", () => {
  const a = principals.create({ name: "a" }).principal;
  const b = principals.create({ name: "b" }).principal;
  const conv = conversations.resolveConversation("whatsapp:+5490000000000");

  assert.equal(principals.getReadMarker(a.id, conv.id), 0);
  assert.equal(principals.setReadMarker(a.id, conv.id, 5), 5);
  assert.equal(principals.setReadMarker(a.id, conv.id, 3), 5, "a lower seq does not rewind");
  assert.equal(principals.getReadMarker(a.id, conv.id), 5);
  assert.equal(principals.getReadMarker(b.id, conv.id), 0);
});

test("the implicit legacy principal can keep read markers too", () => {
  const conv = conversations.resolveConversation("whatsapp:+5490000000000");
  assert.equal(principals.setReadMarker("legacy", conv.id, 2), 2);
  assert.equal(principals.getReadMarker("legacy", conv.id), 2);
});
