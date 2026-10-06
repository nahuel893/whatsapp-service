/**
 * MCP server — the agent-facing adapter of whatsapp-service.
 *
 * Exposes the conversation API as MCP tools, shaped for how an agent works:
 * compact outputs that do not burn context, errors phrased as what to do next
 * ("esperá 30 s") instead of raw HTTP codes, and the read cursor handled for
 * the agent.
 *
 * It is a plain consumer of the public HTTP API — the same contract any
 * other consumer uses — authenticated with an API key (scope `agent` is the
 * intended one). It has no access to the service's internals.
 *
 * Protocol: MCP over JSON-RPC 2.0, implemented without the SDK so the
 * service keeps its zero-new-dependency rule. Only the server side of
 * `initialize`, `ping`, `tools/list` and `tools/call` is needed.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// The MCP server ships with the service, so it reports the service's version.
const SERVER_INFO = { name: "whatsapp-service", version: require("../../package.json").version };

const TOOLS = [
  {
    name: "list_inbox",
    description:
      "Conversations that have unread customer messages, most recent first. " +
      "Start here to know who is waiting for an answer.",
    inputSchema: {
      type: "object",
      properties: {
        include_read: { type: "boolean", description: "Also list conversations with nothing unread." },
      },
    },
  },
  {
    name: "read_new_messages",
    description:
      "Messages of a conversation you have not marked as read yet, oldest first. " +
      "Set mark_read to true once you have taken them into account.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        mark_read: { type: "boolean", description: "Mark everything returned as read." },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "reply",
    description:
      "Send a text message to the customer of a conversation. It is queued and " +
      "delivered within seconds; replies are paced like a human typing.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        text: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["conversation_id", "text"],
    },
  },
  {
    name: "send_file",
    description:
      "Send a file to the customer of a conversation: images (jpg, png, webp) " +
      "show inline, anything else arrives as a document. `path` is relative to " +
      "the directory this server is allowed to read from.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        path: { type: "string", description: "File path inside the allowed directory." },
        caption: { type: "string", maxLength: 4096 },
      },
      required: ["conversation_id", "path"],
    },
  },
  {
    name: "mark_read",
    description: "Mark the conversation as read up to a message seq.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        seq: { type: "integer", minimum: 0 },
      },
      required: ["conversation_id", "seq"],
    },
  },
  {
    name: "get_transcript",
    description:
      "The last messages of a conversation, both sides, to recover context. " +
      "Does not change what is marked as read.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        last: { type: "integer", minimum: 1, maximum: 500, description: "How many messages (default 20)." },
      },
      required: ["conversation_id"],
    },
  },
];

/** A failure the agent should read and act on; becomes an isError result. */
class ToolError extends Error {}

/** "whatsapp:+549…" → "+549…"; any "<channel>:<id>" → "<id>". */
function contactOf(address) {
  const i = address.indexOf(":");
  return i === -1 ? address : address.slice(i + 1);
}

const MIME_BY_EXTENSION = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

/** Message in the compact shape agents get. Status only when it is news. */
function compact(m) {
  const out = { seq: m.seq, from: m.direction === "in" ? "customer" : "you", text: m.text, at: m.at };
  if (m.media) out.file = { type: m.media.type, name: m.media.name };
  const routine = m.direction === "in" ? "received" : "sent";
  if (m.status !== routine) out.status = m.status;
  return out;
}

function gapNote(gap) {
  if (!gap) return undefined;
  return `Messages ${gap.from}–${gap.to} were deleted by retention and are not available.`;
}

function requireString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new ToolError(`Falta ${name} (string).`);
  return value;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl — whatsapp-service base URL
 * @param {string} options.apiKey — a principal key (scope `agent`)
 * @param {string} [options.filesDir] — the only directory send_file may read
 *   from. Unset, send_file is disabled: an agent must never be able to send a
 *   customer an arbitrary file from this machine.
 * @param {function} [options.fetch]
 */
function createMcpServer({ baseUrl, apiKey, filesDir, fetch = globalThis.fetch }) {
  const base = baseUrl.replace(/\/+$/, "");

  /**
   * Resolves `requested` inside filesDir, following symlinks, and refuses
   * anything that ends up outside it.
   */
  function resolveAllowedFile(requested) {
    if (!filesDir) {
      throw new ToolError("send_file no está habilitado: el servidor necesita WA_MCP_FILES_DIR.");
    }
    const root = fs.realpathSync(filesDir);
    let real;
    try {
      real = fs.realpathSync(path.resolve(root, requested));
    } catch {
      throw new ToolError(`El archivo no existe: ${requested}`);
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new ToolError(`El archivo está fuera del directorio permitido: ${requested}`);
    }
    if (!fs.statSync(real).isFile()) throw new ToolError(`No es un archivo: ${requested}`);
    return real;
  }

  async function api(method, pathname, body) {
    const isForm = body instanceof FormData;
    let res;
    try {
      res = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          "x-api-key": apiKey,
          ...(body === undefined || isForm ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch (err) {
      throw new ToolError(`No se pudo contactar al servicio de WhatsApp (${err.message}).`);
    }
    const data = await res.json().catch(() => null);
    if (res.ok) return data;

    if (res.status === 404) throw new ToolError("La conversación no existe o no tenés acceso a ella.");
    if (res.status === 401 || res.status === 403) {
      throw new ToolError("La API key no tiene permiso para esta operación.");
    }
    if (res.status === 413) throw new ToolError("El archivo es demasiado grande para enviarlo.");
    if (res.status === 429) {
      const seconds = data?.retryAfterSeconds ?? 60;
      throw new ToolError(
        `Límite de respuestas en esta conversación: esperá ${seconds} s antes de volver a responder.`
      );
    }
    throw new ToolError(data?.message || data?.error || `Error del servicio (HTTP ${res.status}).`);
  }

  const handlers = {
    async list_inbox(args) {
      const { conversations } = await api("GET", "/conversations");
      return conversations
        .filter((c) => args.include_read || c.unread > 0)
        .map((c) => ({
          conversation_id: c.id,
          contact: contactOf(c.address),
          unread: c.unread,
          last_message_at: c.lastMessageAt,
        }));
    },

    async read_new_messages(args) {
      const id = requireString(args, "conversation_id");
      const limit = Number.isInteger(args.limit) ? `?limit=${args.limit}` : "";
      const page = await api("GET", `/conversations/${encodeURIComponent(id)}/messages${limit}`);
      if (args.mark_read && page.messages.length > 0) {
        await api("POST", `/conversations/${encodeURIComponent(id)}/read`, { seq: page.next });
      }
      return { messages: page.messages.map(compact), gap: gapNote(page.gap) };
    },

    async reply(args) {
      const id = requireString(args, "conversation_id");
      const text = requireString(args, "text");
      const { message } = await api("POST", `/conversations/${encodeURIComponent(id)}/messages`, { text });
      return { queued: true, seq: message.seq };
    },

    async send_file(args) {
      const id = requireString(args, "conversation_id");
      const file = resolveAllowedFile(requireString(args, "path"));
      const mimetype = MIME_BY_EXTENSION[path.extname(file).toLowerCase()] || "application/octet-stream";
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(file)], { type: mimetype }), path.basename(file));
      if (typeof args.caption === "string" && args.caption !== "") form.append("caption", args.caption);
      const { message } = await api("POST", `/conversations/${encodeURIComponent(id)}/messages`, form);
      return { queued: true, seq: message.seq, file: { type: message.media.type, name: message.media.name } };
    },

    async mark_read(args) {
      const id = requireString(args, "conversation_id");
      if (!Number.isInteger(args.seq) || args.seq < 0) throw new ToolError("Falta seq (entero >= 0).");
      const { readSeq } = await api("POST", `/conversations/${encodeURIComponent(id)}/read`, { seq: args.seq });
      return { read_through: readSeq };
    },

    async get_transcript(args) {
      const id = requireString(args, "conversation_id");
      const last = Number.isInteger(args.last) && args.last > 0 ? Math.min(args.last, 500) : 20;
      const { conversation } = await api("GET", `/conversations/${encodeURIComponent(id)}`);
      const since = Math.max(0, conversation.lastSeq - last);
      const page = await api(
        "GET",
        `/conversations/${encodeURIComponent(id)}/messages?since=${since}&limit=${last}`
      );
      return { contact: contactOf(conversation.address), messages: page.messages.map(compact), gap: gapNote(page.gap) };
    },
  };

  async function callTool(name, args) {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) return { content: [{ type: "text", text: `Herramienta desconocida: ${name}` }], isError: true };
    try {
      const result = await handler(args || {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
      throw err;
    }
  }

  /**
   * Handles one JSON-RPC message. Returns the response object, or null for a
   * notification (no id), which must not be answered.
   */
  async function handle(msg) {
    const isRequest = msg && Object.hasOwn(msg, "id") && msg.id !== null;
    const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id: isRequest ? msg.id : null, error: { code, message } });

    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return fail(-32600, "Invalid Request");
    }
    if (!isRequest) return null;

    try {
      switch (msg.method) {
        case "initialize": {
          const requested = msg.params?.protocolVersion;
          return reply({
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions:
              "WhatsApp conversations. Typical loop: list_inbox → read_new_messages " +
              "(mark_read) → reply. Use get_transcript to recover earlier context.",
          });
        }
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call":
          return reply(await callTool(msg.params?.name, msg.params?.arguments));
        default:
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      return fail(-32603, `Internal error: ${err.message}`);
    }
  }

  return { handle, tools: TOOLS };
}

module.exports = { createMcpServer, SUPPORTED_PROTOCOL_VERSIONS };
