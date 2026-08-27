# WhatsApp Service — Contexto del Proyecto

> Briefing técnico para agentes (humanos o IA) que tomen operación del servicio sin sesión previa.

---

## Descripción

Abstracción genérica de Baileys (WhatsApp Web) como API HTTP standalone. Cualquier aplicación del sistema puede enviar mensajes, imágenes y archivos de WhatsApp sin tener que manejar la conexión Baileys directamente.

**NO** incluye lógica de agente, allowlist, dedup, ni forwarding de mensajes entrantes — eso queda del lado del consumidor.

## Stack actual

- **Node.js** 20+
- **Express** 4.19 (HTTP API)
- **`@whiskeysockets/baileys` ^7.0.0-rc13** (post-upgrade — ver § Migración)
- **multer** (multipart/form-data para archivos)
- **pino** (logging JSON estructurado)
- **qrcode-terminal** (QR en consola para auth inicial)

## Estado y contexto

- **Puerto**: `localhost:3001` (HTTP, sin TLS — detrás de Tailscale)
- **Repo**: `~/projects/whatsapp-service/`
- **Systemd**: `whatsapp-service.service` (user unit)
- **Número conectado**: `5490000000000` (the operator)
- **Branch actual**: `feat/baileys-v7-lid` (commits sin pushear todavía)
- **Tag de rollback pre-v7**: `pre-baileys-v7-20260605-174520`
- **Backup de sesión pre-v7**: `session.bak-20260605-174520/`

## Migración Baileys 6.7.16 → 7.0.0-rc13 (2026-06-05)

### Por qué se hizo

WhatsApp completó la migración a **LID addressing** (Linked Identifiers) como identificador canónico de sesión Signal. La 6.x mandaba mensajes vía PN (`@s.whatsapp.net`) — el receptor buscaba la sesión por LID y no la encontraba → veía permanentemente "Esperando este mensaje. Esto puede demorar un poco." Los delays/warmup mitigaban throttling anti-spam pero no resolvían el problema de protocolo.

### Síntomas confirmados en logs (pre-fix)
- `attrs.to = "...@lid"` en mensajes salientes
- `PreKeyError: Invalid PreKey ID` masivo
- `MessageCounterError: Key used already or never filled`
- `Bad MAC Error` en libsignal `verifyMAC`
- `sent ack` con `error: "487"` (server rechazo por sesión inválida)

### Qué cambió en v7
- `WAMessageAddressingMode` enum con soporte real LID/PN dual
- `enableAutoSessionRecreation: true` **por default** — auto re-key en MAC failures
- `enableRecentMessageCache` para evitar decrypt loops
- Manejo correcto de `peer_recipient_pn` (mapping LID↔PN)
- Auto-retry receipts cuando un mensaje no se puede descifrar
- libsignal migrado de git a npm (rc11+) — elimina fallos environment-específicos en VPS Linux
- `printQRInTerminal` deprecado — QR se renderiza manual en `connection.update`

### Cambios en `lib/baileys.js`

```js
// ❌ ANTES (v6.7.16, roto):
sock = makeWASocket({
  version, auth: state,
  logger: pino({ level: "silent" }),          // ocultaba TODOS los errores Signal
  printQRInTerminal: config.printQR,
});

// ✅ DESPUÉS (v7, fix):
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "warn" });

sock = makeWASocket({
  version,
  auth: {
    creds: state.creds,
    // CRÍTICO: makeCacheableSignalKeyStore mantiene coherencia de claves
    // Signal entre assertSessions + sendMessage. Sin esto: "Invalid PreKey
    // ID" floods + stale-session collisions.
    keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
  },
  logger: baileysLogger,
  // printQRInTerminal removido: deprecado en v7. QR se renderiza en
  // connection.update handler con qrcode-terminal manualmente.
});
```

### Re-pair vía QR

Durante el upgrade se hizo **reset completo de sesión**. La sesión vieja (con prekeys/sessions formato v6.7.16 incompatibles con LID) está en `session.dead-{hora}/`. El re-pair generó prekeys frescos con formato v7.

---

## Estructura del repo

```
whatsapp-service/
├── index.js                  # Express server, mounts routes, shutdown ordenado
├── lib/
│   ├── baileys.js            # Connection manager (createManager) — MODIFICADO para v7
│   ├── api.js                # Routes HTTP + handlers por tipo de job
│   ├── auth.js               # Middleware de API key
│   ├── job-store.js          # Persistencia de la cola (node:sqlite)
│   ├── message-queue.js      # Cola persistente con delay/warmup
│   ├── session-store.js      # useMultiFileAuthState wrapper (official Baileys)
│   └── config.js             # Env vars + getters
├── test/                     # node:test — sin dependencias de testing
├── Dockerfile                # Imagen node:24-slim
├── session/                  # Auth state actual (gitignored)
├── session.bak-*/            # Backups previos (gitignored)
├── session.dead-*/           # Sesiones invalidadas (gitignored)
├── data/                     # queue.db — base SQLite de la cola (gitignored)
├── package.json              # Baileys ^7.0.0-rc13
├── CLAUDE.md                 # symlink → AGENTS.md
└── AGENTS.md                 # Este archivo
```

⚠️ `.gitignore` usa el patrón `session*/`, que cubre `session/`, `session.bak-*/`
y `session.dead-*/` de una sola vez. **No lo angostes.**

### Tests

```bash
npm test        # node --test 'test/*.test.js'
```

Corren sin red y sin WhatsApp: los tests de API levantan Express contra un doble
de Baileys que registra los envíos en vez de mandarlos. No hay framework de
testing instalado — todo es `node:test`, built-in.

---

## Config

Toda la configuración entra por variables de entorno, así el mismo código corre
bajo systemd, Docker o `node index.js` pelado. Si existe un `.env` en la raíz,
Node lo carga solo (`process.loadEnvFile()`, sin dependencia).

| Variable | Default | Qué hace |
|---|---|---|
| `PORT` | `3001` | Puerto HTTP |
| `HOST` | `0.0.0.0` | Interfaz de bind. `127.0.0.1` lo restringe a esta máquina |
| `API_KEY` | *(vacío)* | Secreto compartido. **Vacío = API abierta** |
| `SESSION_DIR` | `./session` | Claves de auth de WhatsApp |
| `DATA_DIR` | `./data` | Estado del servicio (base de la cola) |
| `QUEUE_DB_PATH` | `$DATA_DIR/queue.db` | Archivo SQLite de la cola |
| `QUEUE_RETENTION_DAYS` | `30` | Días de jobs terminados que se conservan |
| `MESSAGE_QUEUE_MIN_DELAY_MS` | `60000` | Piso del delay entre envíos |
| `MESSAGE_QUEUE_MAX_DELAY_MS` | `120000` | Techo del delay entre envíos |
| `WHATSAPP_WARMUP_MS` | `0` | Espera tras `connection: open` antes del primer envío |
| `PRINT_QR` | `false` | Imprime el QR de pareo en los logs |
| `LOG_LEVEL` / `BAILEYS_LOG_LEVEL` | `info` / `warn` | Verbosidad |

### Autenticación

Todos los endpoints menos `/health` piden la key cuando `API_KEY` está seteada,
en cualquiera de los dos headers:

```bash
curl -H "x-api-key: $API_KEY" localhost:3001/status
curl -H "Authorization: Bearer $API_KEY" localhost:3001/status
```

⚠️ **Con `API_KEY` vacía no hay autenticación**: cualquiera que alcance el puerto
manda mensajes de WhatsApp desde este número. El servicio lo avisa al arrancar.
Dejala vacía sólo si el puerto está restringido a una red de confianza.

Para activarla:

```bash
KEY=$(openssl rand -hex 32)
cat > ~/.config/systemd/user/whatsapp-service.service.d/auth.conf <<EOF
[Service]
Environment=API_KEY=$KEY
EOF
systemctl --user daemon-reload && systemctl --user restart whatsapp-service.service
echo "$KEY"   # guardalo: los consumidores lo necesitan
```

⚠️ Activarla **rompe a todo consumidor que no mande el header** — el reporter de
`the report pipeline` incluido. Actualizá los consumidores en la misma pasada.

### Config via systemd drop-ins

`~/.config/systemd/user/whatsapp-service.service.d/`:

| Archivo | Variables | Notas |
|---|---|---|
| `fast.conf` | `MESSAGE_QUEUE_MIN_DELAY_MS`, `MAX`, `WHATSAPP_WARMUP_MS` | Default actual: `0/0/0` (modo test rápido). Para producción → `90000/180000/120000` |
| `diagnostics.conf` | `BAILEYS_LOG_LEVEL` | `silent`/`warn`/`debug`. Actual: `debug`. Para producción estable: `warn` |
| `qr.conf` | `PRINT_QR=true` | Activo actualmente. Quitar cuando esté pareado y estable |

Comandos:
```bash
# editar
$EDITOR ~/.config/systemd/user/whatsapp-service.service.d/fast.conf

# aplicar sin restart (cambios NO se aplican hasta restart)
systemctl --user daemon-reload

# aplicar con restart
systemctl --user restart whatsapp-service.service
```

✅ **Reiniciar el service ya no pierde la cola.** Los jobs viven en SQLite: los que quedaron pendientes se reencolan solos en el próximo arranque.

### Volver a delays de producción

```bash
cat > ~/.config/systemd/user/whatsapp-service.service.d/fast.conf <<'EOF'
[Service]
Environment=MESSAGE_QUEUE_MIN_DELAY_MS=90000
Environment=MESSAGE_QUEUE_MAX_DELAY_MS=180000
Environment=WHATSAPP_WARMUP_MS=120000
EOF
systemctl --user daemon-reload && systemctl --user restart whatsapp-service.service
```

---

## Endpoints HTTP

Todos piden la API key cuando está configurada, **menos `/health`**, que queda
abierto a propósito para que los health checks de Docker o del orquestador
funcionen sin credenciales.

| Método | Endpoint | Body | Response | Uso |
|---|---|---|---|---|
| GET | `/health` | — | `{status, uptimeSeconds, whatsapp{}, queue{}}` | Liveness. **Siempre 200 con el proceso vivo**, incluso con WhatsApp desconectado — sin credenciales |
| GET | `/status` | — | `{connected, phone, connectedAt}` | Estado de la sesión de WhatsApp |
| GET | `/queue/status` | — | `{pending, processing, minDelayMs, maxDelayMs, recent[]}` | Estado de cola (últimos 50 terminados) |
| GET | `/queue/job/:id` | — | `{ok, job{id, type, target, status, error, attempts, queuedAt, startedAt, finishedAt}}` | Confirmar la entrega de un `job_id`. **Sobrevive al restart** |
| POST | `/send-text` | JSON `{to, text}` | `{ok, queued, job_id}` | `to` requiere `@s.whatsapp.net` |
| POST | `/send-image` | multipart `to`, `caption`, `image` | `{success, queued, job_id}` | `to` = número sin sufijo, o `@g.us` para grupo |
| POST | `/send-file` | multipart `to`, `caption`, `file` | `{success, queued, job_id}` | Archivo a contacto (DM o grupo) |
| POST | `/send-file-dm` | multipart `to`, `caption`, `file` | `{ok, queued, job_id}` | DM file — más confiable que `/send-file` para individuales |

### Ejemplos

```bash
# Texto (requiere JID completo)
curl -X POST http://localhost:3001/send-text \
  -H "Content-Type: application/json" \
  -d '{"to":"5490000000000@s.whatsapp.net","text":"Hola"}'

# Imagen
curl -X POST http://localhost:3001/send-image \
  -F "to=5490000000000" \
  -F "caption=Texto opcional" \
  -F "image=@/ruta/al/archivo.png"

# Archivo
curl -X POST http://localhost:3001/send-file-dm \
  -F "to=5490000000000" \
  -F "caption=Texto opcional" \
  -F "file=@/ruta/al/archivo.xlsx"

# A grupo
curl -X POST http://localhost:3001/send-image \
  -F "to=120363000000000000@g.us" \
  -F "image=@captura.png"
```

### Resolución de targets (`api.js:resolveJid`)

- Si `to` contiene `@`: se usa tal cual (asume JID válido)
- Si es solo numérico: se mappea a `<num>@s.whatsapp.net`
- Para grupo: pasar `<id>-<timestamp>@g.us` tal cual

### Formato de JIDs

```
Individual:  5490000000000@s.whatsapp.net
Grupo:       5490000000001-1576247284@g.us
LID interno: 100000000000000@lid     ← internal addressing (no usar para enviar)
```

⚠️ **NUNCA mandes a `@lid` desde la API** — eso es addressing interno que Baileys maneja solo. Para targets siempre PN (número) o ID de grupo.

---

## Cola: comportamiento

- **Persistente en SQLite** (`lib/job-store.js`, `node:sqlite` built-in — cero dependencias). Restart del service **no** pierde jobs.
- Procesa **secuencial** (1 job a la vez). Espera `delay_ms` random en `[MIN, MAX]` entre jobs.
- **Warmup**: tras `connection: open`, espera `WHATSAPP_WARMUP_MS` antes del primer send.
- Re-check de `sessionReady` antes del send **NO** está implementado (race condition pendiente — ver § Pendientes).

`/queue/status` devuelve los últimos 50 jobs terminados en `recent[]`. Cada uno: `{id, type, target, status, error, finishedAt}`. Status posibles: `pending`, `processing`, `sent`, `error`.

### Por qué los jobs son datos y no closures

Un job guarda `{type, target, payload, media}` — nunca una función. El `type`
("text", "image", "file", "file-dm") mapea a un handler que `lib/api.js`
registra al montar las rutas. **Eso es lo que permite que un job aceptado antes
de un restart se entregue después**: el proceso nuevo lee la fila y despacha por
tipo.

Consecuencia práctica: si agregás un endpoint que encola, tenés que registrar su
handler con `messageQueue.registerHandler(type, fn)` **antes** de
`messageQueue.start()`. Un job cuyo tipo no tiene handler falla con
`status: "error"` en vez de trabar la cola.

Los bytes de imágenes y archivos van en una columna BLOB y se borran cuando el
job termina, así la base no crece sin techo. Los jobs terminados se purgan al
arrancar según `QUEUE_RETENTION_DAYS`.

### Recuperación tras una caída

Un job que quedó en `processing` cuando el proceso murió vuelve a `pending` en
el próximo arranque (`recoverInterrupted()`). **Puede reenviarse un mensaje que
ya había salido** si el crash ocurrió justo entre el `sendMessage` y el marcado
en base. Es la decisión deliberada: preferimos un duplicado ocasional a un
informe que nunca llega. La deduplicación es del consumidor — el servicio no la
hace, igual que no hace allowlist.

### Cuándo cambiar delays

| Escenario | min/max delay | warmup |
|---|---|---|
| Test individual (1-3 jobs a 1 número) | 0 / 0 | 0 |
| Operación normal (5-20 jobs a varios) | 10000 / 30000 | 30000 |
| Daily masivo (30-100+ jobs) | 90000 / 180000 | 120000 |
| Cuenta etiquetada como spam | 180000 / 360000 | 180000 |

⚠️ Con delays bajos en envíos masivos, WhatsApp puede flaggear la cuenta como bot. Para producción **siempre 90s+**.

---

## Deploy con Docker

```bash
docker build -t whatsapp-service .

docker run -d --name whatsapp-service \
  -p 3001:3001 \
  -e API_KEY="$API_KEY" \
  -v whatsapp-session:/app/session \
  -v whatsapp-data:/app/data \
  whatsapp-service
```

⚠️ **`session/` y `data/` tienen que ser volúmenes.** Sin volumen, cada
`docker run` arranca sin sesión (QR de nuevo) y sin cola (jobs perdidos).

El primer pareo necesita el QR, que sale por los logs:

```bash
docker run --rm -it -e PRINT_QR=true -v whatsapp-session:/app/session whatsapp-service
```

⚠️ **Nunca dos procesos Baileys contra el mismo `session/`.** Corrompe la sesión
y obliga a re-parear. Las carpetas `session.dead-*` del disco son justamente eso
ya ocurrido. Si levantás el contenedor, parás el service de systemd primero.

El `HEALTHCHECK` de la imagen pega a `/health`, que devuelve 200 mientras el
proceso viva. Un WhatsApp desconectado se reporta en el body, **no** como probe
fallida: si no, el orquestador reiniciaría en loop un servicio que sólo está
esperando que lo pareen.

---

## Troubleshooting

### "Esperando este mensaje" en receptor

```bash
journalctl --user -u whatsapp-service.service --since "5 min ago" \
  | grep -iE "prekey|MAC|decrypt|fail|level\":50"
```

Si ves `PreKeyError` / `Bad MAC` / errores Signal masivos:

1. **Si afecta a UN receptor solo**: probablemente reinstaló WhatsApp o cambió de cel. Borrar `session/session-{jid_receptor}.json` y reiniciar el service. La sesión Signal se re-establece sola al próximo send.
2. **Si afecta a TODOS los receptores**: regresión LID. Verificar:
   - `package.json` tiene baileys >= 7.0.0-rc13
   - `lib/baileys.js` wraps `state.keys` con `makeCacheableSignalKeyStore`
   - Re-pair vía QR (sesión corrupta global)

### Cola atascada

```bash
journalctl --user -u whatsapp-service.service --since "1 min ago" | tail -20
```

Patrones a buscar:
- `"Esperando warm-up WhatsApp antes de enviar"` → normal, esperar
- `connection.close` → reconectando, esperar 5-10s
- `Stream errored: Error 515` → desconectado por WhatsApp (otro dispositivo se vinculó, revisar device manager en cel)
- Sin actividad → service colgado, hacer `systemctl --user restart whatsapp-service.service`

### Re-pair completo (sesión inutilizable)

```bash
systemctl --user stop whatsapp-service.service
mv ~/projects/work/whatsapp-service/session ~/projects/work/whatsapp-service/session.dead-$(date +%s)
mkdir ~/projects/work/whatsapp-service/session

# habilitar QR en logs
cat > ~/.config/systemd/user/whatsapp-service.service.d/qr.conf <<'EOF'
[Service]
Environment=PRINT_QR=true
EOF
systemctl --user daemon-reload && systemctl --user start whatsapp-service.service

# esperar ~15 seg, ver QR
sleep 15
journalctl --user -u whatsapp-service.service --since "30 sec ago" | grep -A 35 "Escanea el QR"
```

Escanear desde el cel: **Configuración → Dispositivos vinculados → Vincular dispositivo**.

### Logs verbose / silencioso

```bash
# debug (mucho output)
echo 'Environment=BAILEYS_LOG_LEVEL=debug' > ~/.config/systemd/user/whatsapp-service.service.d/diagnostics.conf
systemctl --user daemon-reload && systemctl --user restart whatsapp-service.service

# warn (producción estable)
echo 'Environment=BAILEYS_LOG_LEVEL=warn' > ~/.config/systemd/user/whatsapp-service.service.d/diagnostics.conf
systemctl --user daemon-reload && systemctl --user restart whatsapp-service.service
```

---

## Comandos operativos rápidos

```bash
# Estado del servicio
systemctl --user is-active whatsapp-service.service

# Logs en vivo
journalctl --user -u whatsapp-service.service -f

# Conexión OK?
curl -s http://localhost:3001/status | jq

# Cola
curl -s http://localhost:3001/queue/status | jq

# Reiniciar
systemctl --user restart whatsapp-service.service
```

---

## Integración con el pipeline de reportes

El sistema `report-pipeline` (Python) en `~/projects/the report pipeline/` usa este service via HTTP desde `src/delivery/steps/send_whatsapp.py`. URL configurada en `.env`:

```
WHATSAPP_SERVICE_URL=http://localhost:3001
```

El daily corre 07:00 Mon-Sat (timer `report-pipeline-daily.timer`). Cada reporte define sus recipients en su `configs/{servicio}.json` → el pipeline resuelve el contacto en `configs/contactos.json` → encola jobs via el service.

---

## Rollback completo a v6.7.16

Si v7 introduce bugs no detectados en producción:

```bash
systemctl --user stop whatsapp-service.service
cd ~/projects/work/whatsapp-service
git checkout pre-baileys-v7-20260605-174520
npm install
rm -rf session && cp -r session.bak-20260605-174520 session
systemctl --user start whatsapp-service.service
```

Con esto volvés al estado pre-upgrade en ~1 minuto. El problema "Esperando este mensaje" reaparece, pero el service funciona en lo demás.

---

## Pendientes / Gotchas conocidos

1. **Race condition al enviar tras reconnect** (Finding #2 del análisis original) — `lib/message-queue.js` no re-checkea `sessionReady` antes de `sock.sendMessage`. Si la conexión se cae durante el sleep del queue y se reconecta justo antes del send, podría mandar a un socket roto.

   **Fix sugerido**: en el `run()` callback del queue, llamar `baileysMgr.getStatus()` y abortar (re-queue) si no está conectado.

2. **`addressingMode` per-message no especificado** — v7 expone `WAMessageAddressingMode = { PN, LID }` pero la implementación actual no lo setea en `sendMessage`. Baileys auto-resuelve via signal repository, OK para 99% de casos. Si aparecen problemas con contactos nuevos: investigar pasar `{addressingMode: WAMessageAddressingMode.LID}` en `sendMessage`.

3. **Branch `feat/baileys-v7-lid` sin PR** — falta abrir el PR para review y merge a `main`. Tag de rollback creado.

3b. ~~**Credenciales de sesión en el historial de git.**~~ **Resuelto el
   2026-08-27** con `git filter-repo --path-glob 'session*' --invert-paths`.
   El historial ya no contiene ningún archivo de sesión; los 9 commits, la
   branch `main` y el tag de rollback sobrevivieron. Todos los hashes
   cambiaron. Backup del `.git` previo en
   `../whatsapp-service.gitbak-20260827-013101/`. Ver § Antes de crear el
   remote.

4. **`PRINT_QR=true` drop-in activo** — remover después de validar 24h de operación estable.

5. **`BAILEYS_LOG_LEVEL=debug` activo** — bajar a `warn` después de validar estabilidad post-upgrade.

6. **`.env.example` desactualizado** — no lista `API_KEY`, `HOST`, `DATA_DIR`,
   `QUEUE_DB_PATH` ni `QUEUE_RETENTION_DAYS`. La tabla de § Config es la fuente
   de verdad mientras tanto.

7. **MCP sin empezar** — `packages/mcp` (stdio + streamable HTTP) es el paso 5
   de `docs/plan-standalone-api-mcp.md`. Requiere `@modelcontextprotocol/sdk`,
   o sea `npm install`, o sea levantar el congelamiento por Shai-Hulud.

---

## Antes de crear el remote

✅ **El historial ya está limpio.** El 2026-08-27 se corrió:

```bash
git filter-repo --path-glob 'session*' --invert-paths --force
```

Qué pasó: los ~8380 archivos de sesión que `a3f3bc4` había commiteado
desaparecieron del historial. `.git` bajó de 2.8 MB a 276 KB. Se conservaron los
9 commits, la branch `main` y el tag `pre-baileys-v7-20260605-174520`, así que el
rollback a v6.7.16 sigue funcionando. **Todos los hashes cambiaron** — los que
aparezcan en documentos viejos ya no existen.

Se eligió reescribir en vez de `rm -rf .git && git init` justamente por el tag:
es el camino de rollback documentado en § Rollback completo a v6.7.16, y un
historial nuevo lo habría borrado.

Backup del `.git` anterior en `../whatsapp-service.gitbak-20260827-013101/`
(todavía **contiene las credenciales** — borralo cuando estés tranquilo, y no lo
copies a ningún lado).

Verificación, para repetir después de cualquier cambio de historial:

```bash
git log --all --name-only --pretty=format: | grep -c '^session'   # tiene que dar 0
```

Con eso ya se puede crear el remote (**privado**) y pushear.

---

## Referencias

- Engram `id=1594` — fix completo del bug "Esperando este mensaje" (Baileys v6→v7 + LID + cacheable key store)
- Engram `id=1545` — mitigaciones originales (queue delays + warmup) que mitigaban pero no resolvían
- Engram `id=1559` — session summary del 2026-06-05 con detalle de la migración
- Issues upstream confirmando el patrón LID: [#1924](https://github.com/WhiskeySockets/Baileys/issues/1924), [#1964](https://github.com/WhiskeySockets/Baileys/issues/1964), [#2297](https://github.com/WhiskeySockets/Baileys/issues/2297)
- [Baileys v7 migration guide](https://baileys.wiki/docs/migration/to-v7.0.0/)
- [DeepWiki — message reception and decryption](https://deepwiki.com/WhiskeySockets/Baileys/5.3-message-reception-and-decryption)
