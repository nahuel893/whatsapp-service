# WhatsApp Service

API HTTP para enviar mensajes, imágenes y archivos por WhatsApp. Envuelve
[Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web) detrás de
unos pocos endpoints, así cualquier aplicación puede mandar un mensaje sin
manejar la conexión, la sesión Signal ni el pareo por QR.

**No** trae lógica de agente, allowlist, deduplicación ni forwarding de mensajes
entrantes. Eso es del consumidor.

```bash
curl -X POST http://localhost:3001/send-file-dm \
  -H "x-api-key: $API_KEY" \
  -F "to=5490000000000" \
  -F "caption=Informe diario" \
  -F "file=@informe.xlsx"
# {"ok":true,"queued":true,"job_id":42}
```

---

## Por qué existe

Baileys es una biblioteca con estado: mantiene una sesión Signal, claves que
rotan y una conexión WebSocket de larga vida. Meterla adentro de cada aplicación
que necesite mandar un WhatsApp trae dos problemas.

El primero es que **sólo un proceso puede ser dueño de la carpeta de sesión**.
Dos procesos Baileys contra el mismo directorio corrompen las claves y obligan a
re-parear escaneando un QR.

El segundo es el ritmo. WhatsApp marca como bot a las cuentas que mandan
ráfagas. Este servicio serializa todo en una cola con un delay aleatorio entre
envíos, y ese cuidado se escribe una vez en vez de repetirse en cada consumidor.

## Qué garantiza

- **Un solo dueño de la sesión.** Un proceso, una carpeta `session/`.
- **Los mensajes aceptados no se pierden.** La cola vive en SQLite: si el
  servicio se reinicia, los jobs pendientes se reencolan solos.
- **La entrega es verificable.** Cada envío devuelve un `job_id` consultable
  después, incluso pasado un restart.
- **Envíos secuenciales y espaciados**, con delay configurable.

Lo que **no** garantiza: exactly-once. Un job interrumpido por una caída se
reintenta, así que un mensaje puede salir dos veces si el proceso murió justo
entre el envío y el marcado en base. Es deliberado — preferimos un duplicado
ocasional a un informe que nunca llega. Si te molesta, deduplicá del lado
consumidor.

---

## Requisitos

- **Node.js >= 24** — la cola usa `node:sqlite`, que viene sin flag desde esa
  versión. No hay dependencias de base de datos ni de testing: son built-ins.
- Un número de WhatsApp para parear, y un celular a mano para escanear el QR.

## Arranque

```bash
npm ci
cp .env.example .env      # ajustá los valores
PRINT_QR=true npm start
```

En el primer arranque imprime un QR en los logs. Escanealo desde el celular:
**Configuración → Dispositivos vinculados → Vincular dispositivo**. La sesión
queda en `session/` y sobrevive a los reinicios.

```bash
npm test    # 49 tests, sin red y sin WhatsApp real
```

---

## Configuración

Todo entra por variables de entorno, así el mismo código corre bajo systemd,
Docker o `node index.js` pelado. Si existe un `.env` en la raíz, Node lo carga
solo.

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
| `WHATSAPP_WARMUP_MS` | `0` | Espera tras conectar, antes del primer envío |
| `PRINT_QR` | `false` | Imprime el QR de pareo en los logs |
| `LOG_LEVEL` / `BAILEYS_LOG_LEVEL` | `info` / `warn` | Verbosidad |

### Autenticación

> [!WARNING]
> **Con `API_KEY` vacía no hay autenticación.** Cualquiera que alcance el puerto
> manda mensajes de WhatsApp desde tu número. El servicio lo avisa al arrancar.
> Dejala vacía sólo si el puerto está restringido a una red de confianza.

Con `API_KEY` configurada, todos los endpoints menos `/health` piden la key, en
cualquiera de los dos headers:

```bash
curl -H "x-api-key: $API_KEY"          localhost:3001/status
curl -H "Authorization: Bearer $API_KEY" localhost:3001/status
```

Para generar una: `openssl rand -hex 32`.

---

## Endpoints

| Método | Endpoint | Devuelve | Para qué |
|---|---|---|---|
| `GET` | `/health` | `{status, uptimeSeconds, whatsapp{}, queue{}}` | Liveness. **Sin credenciales** |
| `GET` | `/status` | `{connected, phone, connectedAt}` | Estado de la sesión de WhatsApp |
| `GET` | `/groups` | `{ok, count, groups[]}` | Listar grupos, para resolver su nombre exacto |
| `GET` | `/queue/status` | `{pending, processing, minDelayMs, maxDelayMs, recent[]}` | Estado de la cola |
| `GET` | `/queue/job/:id` | `{ok, job{...}}` | Confirmar la entrega de un `job_id` |
| `POST` | `/send-text` | `{ok, queued, job_id}` | JSON `{to, text}` — `to` requiere `@s.whatsapp.net` |
| `POST` | `/send-image` | `{success, queued, job_id}` | multipart `to`, `caption`, `image` |
| `POST` | `/send-file` | `{success, queued, job_id}` | multipart `to`, `caption`, `file` |
| `POST` | `/send-file-dm` | `{ok, queued, job_id}` | Igual que `/send-file`, más confiable para DMs |

`/health` queda abierto a propósito, para que los health checks de Docker o del
orquestador funcionen sin credenciales. Devuelve 200 mientras el proceso viva:
un WhatsApp desconectado se reporta en el body, no como probe fallida. Si no, el
orquestador reiniciaría en loop un servicio que sólo está esperando el QR.

### Formato de targets

```
Individual:  5490000000000@s.whatsapp.net   # o sólo el número, salvo en /send-text
Grupo:       5490000000001-1576247284@g.us
```

`/send-text` exige el JID completo. El resto acepta el número pelado, el JID de
grupo, o el nombre del grupo (que resuelve contra `/groups`).

> [!CAUTION]
> **Nunca mandes a un JID `@lid`.** Es addressing interno que Baileys maneja
> solo. Para targets, siempre número o ID de grupo.

### `queued` no es `sent`

Los `POST /send-*` devuelven apenas el job queda **persistido**, no entregado.
Para confirmar la entrega hay que pollear:

```bash
curl -s -H "x-api-key: $API_KEY" localhost:3001/queue/job/42
# {"ok":true,"job":{"id":42,"status":"sent","finishedAt":"...","error":null,...}}
```

`status` puede ser `pending`, `processing`, `sent` o `error`. Con los delays de
producción, un job puede tardar minutos en salir: es a propósito.

---

## La cola

Secuencial, un job a la vez, con un delay aleatorio en `[MIN, MAX]` antes de
cada envío. Todo persiste en SQLite vía `node:sqlite`.

Los jobs son **datos, no closures**: cada uno guarda `{type, target, payload,
media}`, y el `type` mapea a un handler que se registra al montar las rutas. Eso
es lo que permite que un job aceptado antes de un restart se entregue después —
el proceso nuevo lee la fila y despacha por tipo.

Los bytes de imágenes y archivos van en una columna BLOB y se borran cuando el
job termina. Las filas viejas se purgan al arrancar según
`QUEUE_RETENTION_DAYS`.

### Qué delay usar

| Escenario | min/max | warmup |
|---|---|---|
| Test individual (1-3 jobs a 1 número) | `0` / `0` | `0` |
| Operación normal (5-20 jobs) | `10000` / `30000` | `30000` |
| Envío masivo (30-100+ jobs) | `90000` / `180000` | `120000` |
| Cuenta ya marcada como spam | `180000` / `360000` | `180000` |

> [!WARNING]
> Con delays bajos en envíos masivos, WhatsApp puede marcar la cuenta como bot.
> Para producción, **90s o más**.

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

> [!IMPORTANT]
> **`session/` y `data/` tienen que ser volúmenes.** Sin volumen, cada
> `docker run` arranca sin sesión (QR de nuevo) y sin cola (jobs perdidos).

El primer pareo necesita el QR:

```bash
docker run --rm -it -e PRINT_QR=true -v whatsapp-session:/app/session whatsapp-service
```

> [!CAUTION]
> **Nunca dos procesos Baileys contra la misma sesión.** Corrompe las claves y
> obliga a re-parear. Si levantás el contenedor, parás primero cualquier otra
> instancia.

---

## Estructura

```
index.js                 arranque, montaje de rutas, shutdown ordenado
lib/
  baileys.js             conexión, reconexión, QR, estado de sesión
  api.js                 endpoints HTTP y handlers por tipo de job
  auth.js                middleware de API key
  job-store.js           persistencia de la cola (node:sqlite)
  message-queue.js       cola secuencial con delay y warmup
  session-store.js       wrapper de useMultiFileAuthState
  config.js              variables de entorno
test/                    49 tests con node:test
```

---

## Estado

Baileys está fijado en `7.0.0-rc13`, un **release candidate**. La versión 7 es
la que trajo el soporte real de LID addressing, sin el cual los mensajes le
quedaban al receptor como *"Esperando este mensaje"* de forma permanente. Vale
el RC, pero conviene saberlo.

El servidor MCP (stdio + streamable HTTP) todavía no está: es el paso que falta
de `docs/plan-standalone-api-mcp.md`.

## Documentación

- **[`AGENTS.md`](AGENTS.md)** — briefing operativo completo: troubleshooting,
  re-pareo, drop-ins de systemd, rollback, gotchas conocidos.
- **[`docs/plan-standalone-api-mcp.md`](docs/plan-standalone-api-mcp.md)** —
  decisiones de arquitectura y trabajo pendiente.
