/*
 * F5 — replying inside a conversation: queued in the conversation lane,
 * tracked in the transcript, capped per conversation.
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ADMIN, startChatApp } = require("./helpers/chat-app");

async function setup(t, options = {}) {
  const app = await startChatApp(options);
  t.after(app.close);
  const { principal, key } = app.principals.create({ name: "agente" });
  const conv = app.conversations.resolveConversation("whatsapp:+5491111111111");
  app.principals.grant(principal.id, conv.id);
  app.conversations.recordInbound({
    externalId: "IN-1",
    address: conv.address,
    author: conv.address,
    text: "hola, tienen stock?",
    status: "received",
    at: new Date().toISOString(),
  });
  const other = app.conversations.resolveConversation("whatsapp:+5492222222222");
  return { app, key, principal, conv, other };
}

const reply = (app, conv, key, body) =>
  app.call("POST", `/conversations/${conv.id}/messages`, { key, body });

describe("POST /conversations/:id/messages", () => {
  test("accepts a reply with 202, queued, in the transcript order", async (t) => {
    const { app, key, conv } = await setup(t);
    const res = await reply(app, conv, key, { text: "Sí, tenemos." });

    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(Number.isInteger(res.body.job_id), true);
    const { message } = res.body;
    assert.deepEqual(
      [message.seq, message.direction, message.status, message.text, message.author],
      [2, "out", "queued", "Sí, tenemos.", "whatsapp:+5490000000000"]
    );
  });

  test("the reply is delivered to the conversation's address and marked sent", async (t) => {
    const { app, key, conv } = await setup(t);
    const { body } = await reply(app, conv, key, { text: "Sí, tenemos." });
    await app.drained();

    assert.deepEqual(app.sent, [{ jid: "5491111111111@s.whatsapp.net", content: { text: "Sí, tenemos." } }]);
    const read = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });
    const out = read.body.messages.find((m) => m.id === body.message.id);
    assert.equal(out.status, "sent");

    const job = await app.call("GET", `/queue/job/${body.job_id}`, { key: ADMIN });
    assert.equal(job.body.job.status, "sent");
  });

  test("a failed delivery leaves the reply in error, visible to the agent", async (t) => {
    const { app, key, conv } = await setup(t);
    app.control.failSends = true;
    const { body } = await reply(app, conv, key, { text: "no va a salir" });
    await app.drained();

    const read = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });
    assert.equal(read.body.messages.find((m) => m.id === body.message.id).status, "error");
  });

  test("a reply does not count as unread", async (t) => {
    const { app, key, conv } = await setup(t);
    await app.call("POST", `/conversations/${conv.id}/read`, { key, body: { seq: 1 } });
    await reply(app, conv, key, { text: "listo" });
    const list = await app.call("GET", "/conversations", { key });
    assert.equal(list.body.conversations[0].unread, 0);
  });

  test("is 404 for a conversation without grant", async (t) => {
    const { app, key, other } = await setup(t);
    const res = await reply(app, other, key, { text: "intruso" });
    assert.equal(res.status, 404);
    await app.drained();
    assert.deepEqual(app.sent, []);
  });

  test("rejects an empty, non-string or oversized text with 400", async (t) => {
    const { app, key, conv } = await setup(t);
    for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: "x".repeat(4097) }]) {
      const res = await reply(app, conv, key, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(res.body.error, "invalid_request");
    }
  });

  test("caps replies per conversation per minute with 429 and a retry hint", async (t) => {
    const { app, key, conv, principal } = await setup(t, { maxRepliesPerMinute: 2 });

    assert.equal((await reply(app, conv, key, { text: "1" })).status, 202);
    assert.equal((await reply(app, conv, key, { text: "2" })).status, 202);
    const limited = await reply(app, conv, key, { text: "3" });

    assert.equal(limited.status, 429);
    assert.equal(limited.body.ok, false);
    assert.equal(limited.body.error, "rate_limited");
    assert.equal(Number.isInteger(limited.body.retryAfterSeconds), true);
    assert.ok(limited.body.retryAfterSeconds >= 1 && limited.body.retryAfterSeconds <= 60);

    // The cap is per conversation, not per principal.
    const second = app.conversations.resolveConversation("whatsapp:+5493333333333");
    app.principals.grant(principal.id, second.id);
    assert.equal((await reply(app, second, key, { text: "otro cliente" })).status, 202);
  });

  test("the legacy endpoints keep working alongside replies", async (t) => {
    const { app, key, conv } = await setup(t);
    await reply(app, conv, key, { text: "respuesta" });
    const legacy = await app.call("POST", "/send-text", {
      key: ADMIN,
      body: { to: "5490000000001@s.whatsapp.net", text: "informe" },
    });
    assert.deepEqual(Object.keys(legacy.body).sort(), ["job_id", "ok", "queued"]);
    await app.drained();
    assert.equal(app.sent.length, 2);
  });

  test("a reply accepted while disconnected goes out once the transport is back", async (t) => {
    const { app, key, conv } = await setup(t);
    app.control.connected = false;
    const res = await reply(app, conv, key, { text: "te respondo apenas vuelva" });
    assert.equal(res.status, 202, "accepted even with the transport down");

    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(app.sent, [], "nothing is sent while disconnected");
    app.control.connected = true;
    await app.drained();

    assert.equal(app.sent.length, 1);
    const msg = app.conversations.getMessage(res.body.message.id);
    assert.equal(msg.status, "sent");
  });

  test("a reply whose transport never comes back ends in error, not stuck", async (t) => {
    const { app, key, conv } = await setup(t, { connectTimeoutMs: 100 });
    app.control.connected = false;
    const res = await reply(app, conv, key, { text: "x" });
    await app.drained();
    assert.equal(app.conversations.getMessage(res.body.message.id).status, "error");
  });

  describe("with a file", () => {
    async function upload(app, conv, key, { file, caption, extra = {} } = {}) {
      const form = new FormData();
      if (file) form.append("file", new Blob([file.data], { type: file.type }), file.name);
      if (caption !== undefined) form.append("caption", caption);
      for (const [k, v] of Object.entries(extra)) form.append(k, v);
      const res = await fetch(`${app.base}/conversations/${conv.id}/messages`, {
        method: "POST",
        headers: { "x-api-key": key },
        body: form,
      });
      return { status: res.status, body: await res.json() };
    }

    test("an image goes out as an image, with its caption", async (t) => {
      const { app, key, conv } = await setup(t);
      const res = await upload(app, conv, key, {
        file: { data: Buffer.from("png-bytes"), type: "image/png", name: "foto.png" },
        caption: "acá está",
      });
      assert.equal(res.status, 202);
      assert.deepEqual(res.body.message.media, { type: "image", name: "foto.png", mimetype: "image/png", size: 9 });
      assert.equal(res.body.message.text, "acá está");
      await app.drained();

      const [{ jid, content }] = app.sent;
      assert.equal(jid, "5491111111111@s.whatsapp.net");
      assert.deepEqual(Object.keys(content).sort(), ["caption", "image", "mimetype"]);
      assert.equal(Buffer.from(content.image).toString(), "png-bytes");
      assert.equal(content.caption, "acá está");
      assert.equal(app.conversations.getMessage(res.body.message.id).status, "sent");
    });

    test("any other file goes out as a document with its name", async (t) => {
      const { app, key, conv } = await setup(t);
      const res = await upload(app, conv, key, {
        file: { data: Buffer.from("%PDF"), type: "application/pdf", name: "presupuesto.pdf" },
      });
      assert.equal(res.status, 202);
      assert.equal(res.body.message.media.type, "document");
      assert.equal(res.body.message.text, null, "a file without caption has no text");
      await app.drained();

      const { content } = app.sent[0];
      assert.deepEqual(Object.keys(content).sort(), ["caption", "document", "fileName", "mimetype"]);
      assert.equal(content.fileName, "presupuesto.pdf");
      assert.equal(content.mimetype, "application/pdf");
      assert.equal(content.caption, "");
    });

    test("an image mimetype WhatsApp cannot show inline is sent as a document", async (t) => {
      const { app, key, conv } = await setup(t);
      const res = await upload(app, conv, key, {
        file: { data: Buffer.from("gif"), type: "image/gif", name: "anim.gif" },
      });
      assert.equal(res.body.message.media.type, "document");
    });

    test("the transcript shows the file, never its bytes", async (t) => {
      const { app, key, conv } = await setup(t);
      await upload(app, conv, key, { file: { data: Buffer.from("x"), type: "image/jpeg", name: "a.jpg" } });
      const read = await app.call("GET", `/conversations/${conv.id}/messages?since=0`, { key });
      const out = read.body.messages.at(-1);
      assert.deepEqual(out.media, { type: "image", name: "a.jpg", mimetype: "image/jpeg", size: 1 });
    });

    test("a file over the size limit is rejected with 413 and nothing is queued", async (t) => {
      const { app, key, conv } = await setup(t, { maxMediaBytes: 10 });
      const res = await upload(app, conv, key, {
        file: { data: Buffer.alloc(11), type: "application/pdf", name: "grande.pdf" },
      });
      assert.equal(res.status, 413);
      assert.equal(res.body.error, "file_too_large");
      await app.drained();
      assert.deepEqual(app.sent, []);
    });

    test("multipart without file nor text is 400; text alone in multipart works", async (t) => {
      const { app, key, conv } = await setup(t);
      assert.equal((await upload(app, conv, key, { caption: "" })).status, 400);
      const textOnly = await upload(app, conv, key, { extra: { text: "hola" } });
      assert.equal(textOnly.status, 202);
      assert.equal(textOnly.body.message.media, null);
    });

    test("files count toward the per-conversation cap", async (t) => {
      const { app, key, conv } = await setup(t, { maxRepliesPerMinute: 1 });
      await reply(app, conv, key, { text: "uno" });
      const res = await upload(app, conv, key, { file: { data: Buffer.from("x"), type: "image/png", name: "a.png" } });
      assert.equal(res.status, 429);
    });

    test("a file for a conversation without grant is 404", async (t) => {
      const { app, key, other } = await setup(t);
      const res = await upload(app, other, key, { file: { data: Buffer.from("x"), type: "image/png", name: "a.png" } });
      assert.equal(res.status, 404);
    });
  });
});
