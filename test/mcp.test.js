/*
 * MCP server — the agent-facing adapter. It is a plain consumer of the public
 * HTTP API, so these tests run it against the real chat stack.
 */
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { startChatApp } = require("./helpers/chat-app");
const { createMcpServer } = require("../packages/mcp/server");

async function setup(t, options) {
  const app = await startChatApp(options);
  t.after(app.close);
  const { key } = app.principals.create({ name: "bot", scope: "agent" });
  const conv = app.conversations.resolveConversation("whatsapp:+5491111111111");
  for (const [i, text] of ["Hola", "¿tienen stock del modelo X?"].entries()) {
    app.conversations.recordInbound({
      externalId: `in-${i}`,
      address: conv.address,
      author: conv.address,
      text,
      status: "received",
      at: new Date(Date.UTC(2026, 0, 1, 12, i)).toISOString(),
    });
  }
  const server = createMcpServer({ baseUrl: app.base, apiKey: key });
  let id = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: "2.0", id: ++id, method, params });
  const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  return { app, conv, server, rpc, call, key };
}

const text = (result) => result.content.map((c) => c.text).join("\n");

describe("protocol", () => {
  test("initialize advertises tools and echoes a supported protocol version", async (t) => {
    const { rpc } = await setup(t);
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.result.protocolVersion, "2025-06-18");
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.equal(res.result.serverInfo.name, "whatsapp-service");
  });

  test("an unknown protocol version gets the latest supported one", async (t) => {
    const { rpc } = await setup(t);
    const res = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    assert.match(res.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(res.result.protocolVersion, "1999-01-01");
  });

  test("notifications get no response; ping answers; unknown methods are -32601", async (t) => {
    const { server, rpc } = await setup(t);
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    assert.deepEqual((await rpc("ping")).result, {});
    assert.equal((await rpc("resources/list")).error.code, -32601);
  });

  test("tools/list describes every tool with a JSON schema", async (t) => {
    const { rpc } = await setup(t);
    const { tools } = (await rpc("tools/list")).result;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "get_transcript",
      "list_inbox",
      "mark_read",
      "read_new_messages",
      "reply",
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string");
      assert.equal(tool.inputSchema.type, "object");
    }
  });
});

describe("tools", () => {
  test("list_inbox shows conversations waiting for an answer", async (t) => {
    const { call, conv } = await setup(t);
    const inbox = JSON.parse(text(await call("list_inbox")));
    assert.deepEqual(inbox, [
      { conversation_id: conv.id, contact: "+5491111111111", unread: 2, last_message_at: "2026-01-01T12:01:00.000Z" },
    ]);
  });

  test("read_new_messages returns compact messages and can mark them read", async (t) => {
    const { call, conv } = await setup(t);
    const first = JSON.parse(text(await call("read_new_messages", { conversation_id: conv.id, mark_read: true })));
    assert.deepEqual(first.messages, [
      { seq: 1, from: "customer", text: "Hola", at: "2026-01-01T12:00:00.000Z" },
      { seq: 2, from: "customer", text: "¿tienen stock del modelo X?", at: "2026-01-01T12:01:00.000Z" },
    ]);
    assert.equal(first.gap, undefined);

    const again = JSON.parse(text(await call("read_new_messages", { conversation_id: conv.id })));
    assert.deepEqual(again.messages, [], "marked read, nothing new");
    assert.deepEqual(JSON.parse(text(await call("list_inbox"))), [], "the inbox is empty");
  });

  test("reply sends through the conversation lane and appears in the transcript", async (t) => {
    const { app, call, conv } = await setup(t);
    const res = await call("reply", { conversation_id: conv.id, text: "Sí, hay 5." });
    assert.equal(res.isError, undefined);
    await app.drained();
    assert.deepEqual(app.sent, [{ jid: "5491111111111@s.whatsapp.net", content: { text: "Sí, hay 5." } }]);

    const transcript = JSON.parse(text(await call("get_transcript", { conversation_id: conv.id, last: 2 })));
    assert.deepEqual(
      transcript.messages.map((m) => [m.seq, m.from, m.text]),
      [[2, "customer", "¿tienen stock del modelo X?"], [3, "you", "Sí, hay 5."]]
    );
  });

  test("mark_read moves the marker", async (t) => {
    const { call, conv } = await setup(t);
    await call("mark_read", { conversation_id: conv.id, seq: 1 });
    const page = JSON.parse(text(await call("read_new_messages", { conversation_id: conv.id })));
    assert.deepEqual(page.messages.map((m) => m.seq), [2]);
  });

  test("a rate limit comes back as an error the agent can act on", async (t) => {
    const { call, conv } = await setup(t, { maxRepliesPerMinute: 1 });
    await call("reply", { conversation_id: conv.id, text: "uno" });
    const limited = await call("reply", { conversation_id: conv.id, text: "dos" });
    assert.equal(limited.isError, true);
    assert.match(text(limited), /esperá \d+ s/i);
  });

  test("an unknown conversation and bad arguments are tool errors, not crashes", async (t) => {
    const { call } = await setup(t);
    const missing = await call("read_new_messages", { conversation_id: "conv_0000000000000000" });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /no existe o no tenés acceso/);

    const bad = await call("reply", { text: "sin conversación" });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /conversation_id/);
  });

  test("an unknown tool is an error result", async (t) => {
    const { call } = await setup(t);
    const res = await call("send_spam");
    assert.equal(res.isError, true);
  });
});

test("runs over stdio: one JSON-RPC message per line", async (t) => {
  const { app, key } = await setup(t);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "packages", "mcp", "index.js")], {
    env: { PATH: process.env.PATH, WA_SERVICE_URL: app.base, WA_SERVICE_API_KEY: key },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());

  const lines = [];
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  const waitFor = async (n) => {
    for (let i = 0; i < 400 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write("{ not json\n");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_inbox", arguments: {} } })}\n`);
  await waitFor(3);

  // JSON-RPC responses may arrive in any order; clients correlate by id.
  assert.equal(lines.length, 3, "the notification gets no response");
  const byId = (id) => lines.find((l) => l.id === id);
  assert.equal(byId(1).result.serverInfo.name, "whatsapp-service");
  assert.equal(byId(null).error.code, -32700, "a malformed line is a parse error, and the server keeps going");
  assert.equal(JSON.parse(byId(2).result.content[0].text).length, 1);
});

test("refuses to start without an API key", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "packages", "mcp", "index.js")], {
    env: { PATH: process.env.PATH, WA_SERVICE_URL: "http://127.0.0.1:1" },
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /WA_SERVICE_API_KEY/);
});
