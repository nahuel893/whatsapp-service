/**
 * Session Store — the WhatsApp auth state on disk, written safely.
 *
 * Same directory layout and file format as Baileys' useMultiFileAuthState, so
 * existing sessions load unchanged. What differs is how files are written:
 *
 *   - Atomically: write a temp file, fsync it, rename it over the target. A
 *     full disk can make a save fail, but never leaves a truncated or empty
 *     file. (Incident 2026-10-16: Baileys' plain writeFile left creds.json
 *     cut at 4096 bytes on one instance and empty on the other; both numbers
 *     had to be re-paired.)
 *   - With a last-known-good copy of creds.json (creds.json.bak, a hardlink
 *     that costs no space). If creds.json is unreadable at startup, the
 *     backup is used and restored.
 *   - Serialized per file, so concurrent writes of one key never interleave.
 *
 * A corrupt key file reads as missing, as Baileys does: Signal re-negotiates
 * a session; it cannot re-negotiate lost credentials.
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { BufferJSON, initAuthCreds, proto } = require("@whiskeysockets/baileys");

const CREDS = "creds.json";
const CREDS_BACKUP = "creds.json.bak";

/** Same mapping Baileys uses, so file names stay compatible. */
function fixFileName(file) {
  return file?.replace(/\//g, "__")?.replace(/:/g, "-");
}

/**
 * @param {string} sessionDir — absolute path to the session directory
 * @param {object} [options]
 * @param {{warn: function, error: function}} [options.logger]
 * @param {() => Error|null} [options.failWrites] — test hook: an error to
 *   throw while writing the temp file, as a full disk would
 * @returns {Promise<{state: object, saveCreds: function}>}
 */
async function initAuthState(sessionDir, { logger = console, failWrites = null } = {}) {
  fs.mkdirSync(sessionDir, { recursive: true });

  const locks = new Map();
  let tmpCounter = 0;

  /** Runs `fn` after every previous operation on the same file. */
  function withLock(file, fn) {
    const previous = locks.get(file) || Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(file, next.catch(() => {}));
    return next;
  }

  async function writeAtomic(name, data) {
    const target = path.join(sessionDir, fixFileName(name));
    const tmp = `${target}.tmp-${process.pid}-${++tmpCounter}`;
    const json = JSON.stringify(data, BufferJSON.replacer);
    return withLock(target, async () => {
      let handle;
      try {
        handle = await fsp.open(tmp, "w");
        const injected = failWrites?.();
        if (injected) throw injected;
        await handle.writeFile(json);
        await handle.sync();
        await handle.close();
        handle = null;
        if (name === CREDS) await keepBackup(target);
        await fsp.rename(tmp, target);
      } catch (err) {
        await handle?.close().catch(() => {});
        await fsp.rm(tmp, { force: true });
        throw err;
      }
    });
  }

  /**
   * Hardlinks the current creds.json as the backup before it is replaced —
   * only if it is readable, so a broken file never overwrites a good backup.
   */
  async function keepBackup(target) {
    const backup = path.join(sessionDir, CREDS_BACKUP);
    if (!parseFile(target)) return;
    try {
      await fsp.rm(backup, { force: true });
      await fsp.link(target, backup);
    } catch (err) {
      if (err.code !== "ENOENT") logger.warn({ err }, "No se pudo actualizar el backup de creds.json");
    }
  }

  function parseFile(file) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      return raw.trim() === "" ? null : JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  async function readData(name) {
    const file = path.join(sessionDir, fixFileName(name));
    return withLock(file, async () => parseFile(file));
  }

  async function removeData(name) {
    const file = path.join(sessionDir, fixFileName(name));
    return withLock(file, () => fsp.rm(file, { force: true }));
  }

  async function loadCreds() {
    const creds = parseFile(path.join(sessionDir, CREDS));
    if (creds) return creds;

    const credsExists = fs.existsSync(path.join(sessionDir, CREDS));
    const backup = parseFile(path.join(sessionDir, CREDS_BACKUP));
    if (backup) {
      logger.warn(
        { sessionDir },
        "creds.json ilegible o ausente: se recupera la sesión desde el backup creds.json.bak"
      );
      await writeAtomic(CREDS, backup);
      return backup;
    }
    if (credsExists) {
      logger.error(
        { sessionDir },
        "creds.json está dañado y no hay backup utilizable: la sesión arranca de cero y hay que re-parear (QR)"
      );
    }
    return initAuthCreds();
  }

  const creds = await loadCreds();

  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        async set(data) {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const name = `${category}-${id}.json`;
              tasks.push(value ? writeAtomic(name, value) : removeData(name));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeAtomic(CREDS, creds),
  };
}

module.exports = { initAuthState };
