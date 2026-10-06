#!/usr/bin/env node
/**
 * whatsapp-service MCP server over stdio.
 *
 *   WA_SERVICE_URL=http://127.0.0.1:3001 WA_SERVICE_API_KEY=wsk_… node packages/mcp/index.js
 *
 * WA_MCP_FILES_DIR (optional) enables send_file, restricted to that directory.
 *
 * One JSON-RPC message per line on stdin; responses one per line on stdout.
 * stdout carries only protocol messages — diagnostics go to stderr.
 */
"use strict";

const readline = require("node:readline");

const { createMcpServer } = require("./server");

const baseUrl = process.env.WA_SERVICE_URL || "http://127.0.0.1:3001";
const apiKey = process.env.WA_SERVICE_API_KEY || "";
if (!apiKey) {
  process.stderr.write("WA_SERVICE_API_KEY es requerida (una key con scope agent).\n");
  process.exit(1);
}

const server = createMcpServer({ baseUrl, apiKey, filesDir: process.env.WA_MCP_FILES_DIR || undefined });
const send = (response) => process.stdout.write(`${JSON.stringify(response)}\n`);

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (line.trim() === "") return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const response = await server.handle(msg);
  if (response) send(response);
});
lines.on("close", () => process.exit(0));
