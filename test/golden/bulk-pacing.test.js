/*
 * Golden (F0) — sends through the existing endpoints keep the configured
 * pacing. No response-shape test notices if a later phase routes these
 * endpoints through an unpaced lane: the bodies stay identical while a daily
 * batch of reports goes out in a burst and WhatsApp flags the account as a
 * bot. This test is what catches that. Do not edit to make it pass.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { startApp } = require("./_frozen-harness");

const DELAY_MS = 300;

test("old send endpoints wait the configured delay before every send", async (t) => {
  const app = await startApp({ minDelayMs: DELAY_MS, maxDelayMs: DELAY_MS });
  t.after(app.close);

  const sentAt = [];
  const sock = app.baileys.getSock();
  const originalSend = sock.sendMessage;
  sock.sendMessage = async (...args) => {
    sentAt.push(Date.now());
    return originalSend.apply(sock, args);
  };

  const startedAt = Date.now();
  await app.postJson("/send-text", { to: "5490000000000@s.whatsapp.net", text: "a" });
  await app.postMultipart("/send-file-dm", {
    to: "5490000000000",
    file: { data: Buffer.from("x"), filename: "a.xlsx", type: "application/octet-stream" },
  });
  await app.postMultipart("/send-image", {
    to: "5490000000000",
    image: { data: Buffer.from("p"), filename: "a.png", type: "image/png" },
  });

  await app.drained(DELAY_MS * 3 + 2000);

  assert.equal(sentAt.length, 3);
  // Timers may fire a millisecond early; allow a small tolerance.
  const tolerance = 20;
  assert.ok(sentAt[0] - startedAt >= DELAY_MS - tolerance, "first send was not delayed");
  for (let i = 1; i < sentAt.length; i++) {
    assert.ok(
      sentAt[i] - sentAt[i - 1] >= DELAY_MS - tolerance,
      `sends ${i - 1} and ${i} were only ${sentAt[i] - sentAt[i - 1]}ms apart`
    );
  }
});

test("old send endpoints process one job at a time", async (t) => {
  const app = await startApp({ minDelayMs: 50, maxDelayMs: 50 });
  t.after(app.close);

  let inFlight = 0;
  let maxInFlight = 0;
  const sock = app.baileys.getSock();
  const originalSend = sock.sendMessage;
  sock.sendMessage = async (...args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return originalSend.apply(sock, args);
  };

  for (let i = 0; i < 4; i++) {
    await app.postJson("/send-text", { to: "5490000000000@s.whatsapp.net", text: String(i) });
  }
  await app.drained(3000);

  assert.equal(app.sent.length, 4);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    app.sent.map((s) => s.content.text),
    ["0", "1", "2", "3"],
    "jobs must go out in the order they were accepted"
  );
});
