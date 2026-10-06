#!/usr/bin/env node
/**
 * Runs the reference agent: a webhook receiver plus `claude -p` as the model.
 *
 *   WA_SERVICE_URL=http://127.0.0.1:3002 WA_SERVICE_API_KEY=wsk_… \
 *     node examples/claude-agent/index.js
 *
 * On start it registers its own webhook subscription and removes it on exit.
 *
 * Env:
 *   WA_SERVICE_URL, WA_SERVICE_API_KEY (scope agent)   required
 *   AGENT_PORT            webhook port, 127.0.0.1 (default 3100)
 *   AGENT_MODEL           claude model alias (default sonnet)
 *   AGENT_SYSTEM_PROMPT   who the agent is (default: a generic assistant)
 *   AGENT_DEBOUNCE_MS     quiet window before answering a burst (default 3000)
 *   CLAUDE_BIN            path to the claude CLI (default "claude")
 */
"use strict";

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { createAgent, verifySignature } = require("./agent");

const serviceUrl = process.env.WA_SERVICE_URL || "http://127.0.0.1:3001";
const apiKey = process.env.WA_SERVICE_API_KEY || "";
const port = parseInt(process.env.AGENT_PORT || "3100", 10);
const model = process.env.AGENT_MODEL || "sonnet";
const claudeBin = process.env.CLAUDE_BIN || "claude";
const systemPrompt =
  process.env.AGENT_SYSTEM_PROMPT ||
  "Sos un asistente que atiende por WhatsApp. Respondé en el idioma del cliente, " +
    "breve y cordial, como en un chat: sin markdown, sin títulos, sin listas largas. " +
    "Si no sabés algo, decilo; no inventes datos.";

if (!apiKey) {
  console.error("WA_SERVICE_API_KEY es requerida (una key con scope agent).");
  process.exit(1);
}

const log = {
  info: (m) => console.log(`[agent] ${m}`),
  warn: (m) => console.warn(`[agent] ${m}`),
  error: (m) => console.error(`[agent] ${m}`),
};

// An empty working directory, so the model run picks up no project context.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-agent-"));

/**
 * One model turn with `claude -p`: no tools, no session kept, no user or
 * project settings, no MCP servers. Only text in, text out.
 */
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      claudeBin,
      [
        "-p",
        "--model", model,
        "--system-prompt", systemPrompt,
        "--tools", "",
        "--restricted",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format", "text",
      ],
      { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude salió con ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

const agent = createAgent({ serviceUrl, apiKey, runModel: runClaude, logger: log,
  debounceMs: parseInt(process.env.AGENT_DEBOUNCE_MS || "3000", 10) });

let secret = null;
let subscriptionId = null;

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const ok = secret && verifySignature({
      secret,
      timestamp: req.headers["x-webhook-timestamp"],
      signature: req.headers["x-webhook-signature"],
      rawBody,
    });
    if (!ok) {
      res.writeHead(401).end();
      log.warn("webhook con firma inválida, descartado");
      return;
    }
    // Acknowledge first; the work happens after the response.
    res.writeHead(204).end();
    try {
      agent.onEvent(JSON.parse(rawBody));
    } catch (e) {
      log.error(`payload inválido: ${e.message}`);
    }
  });
});

async function main() {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}/webhook`;
  const created = await agent.api("POST", "/subscriptions", { url });
  secret = created.secret;
  subscriptionId = created.subscription.id;
  log.info(`escuchando en ${url} (suscripción ${subscriptionId}, modelo ${model})`);
  const pending = await agent.catchUp();
  if (pending) log.info(`${pending} conversación(es) con mensajes sin leer`);
}

async function shutdown() {
  agent.stop();
  if (subscriptionId) {
    await agent.api("DELETE", `/subscriptions/${subscriptionId}`).catch(() => {});
  }
  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
