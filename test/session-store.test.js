/*
 * Session store — the WhatsApp auth state on disk.
 *
 * Incident 2026-10-16: the disk filled up mid-write and Baileys' writeFile
 * left creds.json truncated (4096 bytes) on one instance and empty on the
 * other. Both numbers had to be re-paired. These tests pin the guarantees
 * that prevent it: writes are atomic, the last good creds survive, and a
 * broken file never takes the session down by itself.
 */
"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BufferJSON } = require("@whiskeysockets/baileys");
const { initAuthState } = require("../lib/session-store");

let dir;
const logs = [];
const logger = { warn: (obj, msg) => logs.push({ obj, msg }), error: (obj, msg) => logs.push({ obj, msg }) };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-session-"));
  logs.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const parse = (name) => JSON.parse(read(name), BufferJSON.reviver);

test("a fresh directory gets new creds that save and reload", async () => {
  const { state, saveCreds } = await initAuthState(dir, { logger });
  assert.ok(state.creds.noiseKey, "fresh creds");
  state.creds.me = { id: "5490000000000:1@s.whatsapp.net" };
  await saveCreds();

  const again = await initAuthState(dir, { logger });
  assert.deepEqual(again.state.creds.me, { id: "5490000000000:1@s.whatsapp.net" });
  assert.ok(Buffer.isBuffer(again.state.creds.noiseKey.private), "Buffers survive the round trip");
});

test("keys use the same file names and format as Baileys", async () => {
  const { state } = await initAuthState(dir, { logger });
  await state.keys.set({ session: { "1234:5@s.whatsapp.net": { a: Buffer.from([1, 2, 3]) } } });
  assert.ok(fs.existsSync(path.join(dir, "session-1234-5@s.whatsapp.net.json")));
  assert.deepEqual(parse("session-1234-5@s.whatsapp.net.json").a, Buffer.from([1, 2, 3]));

  const got = await state.keys.get("session", ["1234:5@s.whatsapp.net", "missing"]);
  assert.deepEqual(got["1234:5@s.whatsapp.net"].a, Buffer.from([1, 2, 3]));
  assert.equal(got.missing, null);

  await state.keys.set({ session: { "1234:5@s.whatsapp.net": null } });
  assert.equal(fs.existsSync(path.join(dir, "session-1234-5@s.whatsapp.net.json")), false, "null deletes");
});

test("an existing Baileys session directory is read as is", async () => {
  const { initAuthCreds } = require("@whiskeysockets/baileys");
  const creds = initAuthCreds();
  creds.me = { id: "existing" };
  fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify(creds, BufferJSON.replacer));
  fs.writeFileSync(path.join(dir, "pre-key-7.json"), JSON.stringify({ k: Buffer.from("x") }, BufferJSON.replacer));

  const { state } = await initAuthState(dir, { logger });
  assert.deepEqual(state.creds.me, { id: "existing" });
  assert.deepEqual((await state.keys.get("pre-key", ["7"]))["7"].k, Buffer.from("x"));
});

test("a failed write leaves the previous file intact and no temp files behind", async () => {
  const { state, saveCreds } = await initAuthState(dir, { logger });
  state.creds.me = { id: "v1" };
  await saveCreds();

  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const failing = await initAuthState(dir, { logger, failWrites: () => enospc });
  failing.state.creds.me = { id: "v2" };
  await assert.rejects(failing.saveCreds(), /ENOSPC/);

  assert.equal(parse("creds.json").me.id, "v1", "creds.json untouched");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);
});

test("saving keeps the previous creds as creds.json.bak", async () => {
  const { state, saveCreds } = await initAuthState(dir, { logger });
  state.creds.me = { id: "v1" };
  await saveCreds();
  state.creds.me = { id: "v2" };
  await saveCreds();
  assert.equal(parse("creds.json").me.id, "v2");
  assert.equal(parse("creds.json.bak").me.id, "v1");
});

for (const [label, corrupt] of [
  ["truncated", (f) => fs.writeFileSync(f, fs.readFileSync(f, "utf8").slice(0, 40))],
  ["empty", (f) => fs.writeFileSync(f, "")],
  ["missing", (f) => fs.rmSync(f)],
]) {
  test(`a ${label} creds.json is recovered from the backup`, async () => {
    const { state, saveCreds } = await initAuthState(dir, { logger });
    state.creds.me = { id: "v1" };
    await saveCreds();
    state.creds.me = { id: "v2" };
    await saveCreds();
    corrupt(path.join(dir, "creds.json"));

    const recovered = await initAuthState(dir, { logger });
    assert.equal(recovered.state.creds.me.id, "v1", "last good version");
    assert.equal(parse("creds.json").me.id, "v1", "restored on disk too");
    assert.equal(parse("creds.json.bak").me.id, "v1", "the backup is never replaced by the broken file");
    assert.ok(logs.some((l) => /backup/i.test(l.msg)), "the recovery is logged");
  });
}

test("a broken creds.json without a usable backup starts fresh, loudly", async () => {
  fs.writeFileSync(path.join(dir, "creds.json"), "");
  const { state } = await initAuthState(dir, { logger });
  assert.ok(state.creds.noiseKey, "fresh creds instead of a crash");
  assert.ok(logs.some((l) => /re-?pair|QR/i.test(l.msg)), "says a re-pair is needed");
});

test("an empty or corrupt key file reads as missing", async () => {
  fs.writeFileSync(path.join(dir, "pre-key-9.json"), "");
  fs.writeFileSync(path.join(dir, "pre-key-10.json"), '{"broken":');
  const { state } = await initAuthState(dir, { logger });
  assert.deepEqual(await state.keys.get("pre-key", ["9", "10"]), { 9: null, 10: null });
});

test("concurrent writes to the same file never interleave", async () => {
  const { state } = await initAuthState(dir, { logger });
  await Promise.all(
    Array.from({ length: 30 }, (_, i) => state.keys.set({ session: { same: { n: i, pad: "x".repeat(5000) } } }))
  );
  const final = parse("session-same.json");
  assert.equal(final.pad.length, 5000, "a whole, valid file");
  assert.ok(Number.isInteger(final.n));
});
