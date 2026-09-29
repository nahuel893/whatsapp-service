# Chat bidireccional — tareas

> Diseño fuente: `docs/superpowers/specs/2026-09-01-chat-bidireccional-design.md` (aprobado, congelado)
> Alcance autorizado en esta sesión: **F0 únicamente**
> Proceso: TDD directo sobre el diseño. Sin SDD/OpenSpec.

## Qué es F0 y qué no es

F0 son **tests golden de compatibilidad**. Se escriben contra el código actual y
**arrancan en verde**: no es RED/GREEN, es captura de comportamiento observable.

De ahí en más son el detector de regresiones: si F1..F6 los ponen en rojo, esa
fase rompió a un consumidor. **Ponerlos en verde editándolos es tapar la rotura.**
Sólo se tocan si el cambio de contrato es una decisión explícita anotada en el
diseño.

### Decisión: el archivo golden es autocontenido

`test/golden-compat.test.js` no comparte helpers con `test/api.test.js`. Duplica
el doble de Baileys y el arranque del server a propósito: un golden que depende de
un helper que otra fase puede editar deja de ser golden. La duplicación acá es la
característica, no el descuido.

## Estado de partida (verificado 2026-09-14)

- 49/49 tests en verde.
- Servicio `active`, WhatsApp conectado, corriendo código nuevo.
- Implementación del chat bidireccional: cero.

### Brechas de cobertura encontradas

| Contrato congelado | Hoy |
|---|---|
| `POST /send-image` → `{success, queued, job_id, message}` | **sin ningún test** |
| `POST /send-file-dm` → `{ok, queued, job_id}` | **sin ningún test** |
| `POST /send-file` → campo `message` | sólo se afirma `success` |
| `GET /status` → `{connected, phone, connectedAt}` | forma nunca afirmada |
| `GET /queue/status` → `{pending, processing, minDelayMs, maxDelayMs, recent[]}` | forma nunca afirmada |
| `job_id` entero `AUTOINCREMENT` | sólo `typeof === "number"` |
| `/queue/job/:id` rechaza no-enteros | sólo el caso `"abc"` |
| `503 session_not_ready` | sólo el status en `/send-text`, nunca el body |
| 400 sin target → `{error}` *sin* `ok`/`success` | no cubierto |
| Carril `bulk` por default (pacing) | el queue tiene su test; **el camino HTTP no** |

`auth.test.js` cubre el middleware completo (ambos headers, key vacía, longitud
distinta, `publicPaths`). No hay brecha ahí.

## Tareas

> Cambio de layout respecto del plan original: en vez de un único
> `test/golden-compat.test.js`, los golden viven en `test/golden/` (un archivo
> por tarea) y comparten sólo `test/golden/_frozen-harness.js`, que a su vez no
> comparte nada con `test/api.test.js`. La regla de aislamiento se mantiene.

- [x] **T1 — Limpiar el working tree.** `201b931`, `4a135d3`, `90019c0`.
- [x] **T2 — Scaffolding golden.** `51fd12f` (glob recursivo), `6ae489c` (harness).
- [x] **T3 — Formas de respuesta de los 4 endpoints de envío.** `933b007` —
      `test/golden/send-responses.test.js`. Incluye qué contenido recibe Baileys.
- [x] **T4 — Identidad de `job_id`.** `274abf3` — `test/golden/job-id.test.js`.
- [x] **T5 — Formas de lectura.** `37a5b2f` — `test/golden/read-shapes.test.js`.
- [x] **T6 — Resolución de targets.** `5543d68` — `test/golden/target-resolution.test.js`.
- [x] **T7 — Errores.** `516028a` — `test/golden/errors.test.js`. Hallazgo: el
      401 de auth trae también `message`; congelado tal cual.
- [x] **T8 — Carril `bulk` por default.** `aad4783` — `test/golden/bulk-pacing.test.js`.
      Delay antes de cada envío, un job a la vez, orden FIFO.
- [x] **T9 — Suite completa en verde.** `npm test`: 92/92, tres corridas
      seguidas sin flakes (2026-09-24).
- [x] **T10 — Anotar F0 como hecho** en el diseño y en `AGENTS.md`.

## Verificación de F0

- Modo: captura de comportamiento (los golden arrancan en verde, no hay RED).
- Runner: `npm test` → `node --test 'test/**/*.test.js'`.
- Rama: `test/f0-golden-compat`. Sin pushear.

## F1 — Puerto de transporte

Autorizado el 2026-09-29 ("continua"). Rama `feat/f1-transport-port`, apilada
sobre `test/f0-golden-compat`. TDD estricto (RED → GREEN), runner `npm test`.

**Qué deja:** nada nuevo hacia afuera. Los envíos de los endpoints viejos pasan
por un `ChatTransport`; Baileys queda detrás de la interfaz y aparece
`MemoryTransport` como segundo implementador.

**Restricción de compatibilidad:** `test/golden/_frozen-harness.js` le pasa a
`createRouter` un doble del *manager* de Baileys (`getStatus`, `getSock`,
`waitForWarmup`). Por eso `createRouter(baileysMgr, queue, opts)` conserva su
firma: el transporte se construye adentro a partir del manager, salvo que llegue
uno en `opts.transport`. Los golden no se tocan.

**Decisión — resolución de targets viejos:** números sueltos y nombres de grupo
son addressing de WhatsApp, no del dominio. Se mueven a
`BaileysTransport.resolveLegacyTarget()`, una extensión del adaptador que **no**
es parte del puerto. F6 la reemplaza por URIs.

**Formato de direcciones (`whatsapp:`):** `whatsapp:+<dígitos>` para un contacto,
`whatsapp:group:<id>` para un grupo, `whatsapp:lid:<id>` cuando WhatsApp no da
el teléfono. En un entrante se prefiere `remoteJidAlt`/`participantAlt` (el
teléfono) sobre el `@lid`.

- [x] **F1.1 — Contrato del puerto.** `54408c3`. `lib/transport/contract.js`: typedefs y
      `assertTransport()`. Suite de contrato reutilizable en
      `test/transport/contract-suite.js`.
- [x] **F1.2 — `MemoryTransport`.** `54408c3`. `lib/transport/memory.js`, pasa la suite.
- [x] **F1.3 — `BaileysTransport`.** `0b6a5ed`. `lib/transport/baileys.js` sobre el manager,
      pasa la misma suite con el socket mockeado. Incluye mapeo de entrantes y
      `resolveLegacyTarget`. `manager.onEvent` pasa a devolver un unsubscribe.
- [x] **F1.4 — El router envía por el transporte.** `b6a3ce3`. `lib/api.js` deja de llamar a
      `sock.sendMessage`. Golden en verde sin tocarlos.
- [x] **F1.5 — Docs.** Diseño, `AGENTS.md`.

### Verificación de F1

- RED observado antes de cada implementación (módulos inexistentes; router que
  ignoraba `options.transport`).
- `npm test`: 135/135, dos corridas seguidas. Los 41 golden, sin editar.
- `index.js` no cambió: sigue conectando por el manager.
- Revisión RDD aprobada (lineage `review-0dd194c22e125bdf`). Hallazgos propios
  de F1 corregidos en `041e443`: `disconnect()` cancela el reconectar pendiente
  e ignora eventos de sockets reemplazados; handlers async de entrantes que
  rechazan quedan contenidos. **Sin test unitario** para el fix del manager
  (`lib/baileys.js` importa Baileys dinámicamente y no hay doble para eso).

## F2 — Modelo de conversación y captura de inbound

Autorizado el 2026-09-29 ("si"). Rama `feat/f2-inbound-capture`, apilada sobre
F1. TDD estricto, runner `npm test`.

**Qué deja:** los mensajes entrantes se persisten y deduplican. Nadie los lee
todavía (eso es F4).

**Decisiones:**
- **Base separada** (`data/chat.db`, `CHAT_DB_PATH`), no `queue.db`: la cola no
  cambia de esquema y el rollback de la cola sigue intacto.
- **Captura opt-in** (`INBOUND_CAPTURE=true`). Hoy el servicio no guarda nada de
  lo que llega; prenderla por default empezaría a escribir a disco los mensajes
  de todos los chats del número sin que nadie lo pidiera.
- **`undecryptable` se completa, no se duplica.** Baileys emite un stub
  `CIPHERTEXT`, pide reintento y el mensaje real llega con el mismo id. El
  almacén actualiza la fila existente en su mismo `seq`.
- `InboundMessage` gana `status: "received" | "undecryptable"` (cambio del
  contrato de F1, que todavía no tiene consumidores).

- [x] **F2.1 — `InboundMessage.status`** `89657ac`. en el contrato, en ambos adaptadores y
      en la suite. Baileys mapea `messageStubType === CIPHERTEXT` a
      `undecryptable` con `text: null`.
- [x] **F2.2 — `lib/conversation-store.js`.** `5886288`. Esquema `conversations` +
      `messages`, `resolveConversation`, `recordInbound` (dedup por
      `(conversation_id, external_id)`, `seq` monótono, upgrade de
      `undecryptable`), `listMessages`.
- [x] **F2.3 — `lib/inbound-capture.js`** `6c764ad`. + cableado en `index.js` detrás de
      `INBOUND_CAPTURE`. Config nueva en `lib/config.js`.
- [x] **F2.4 — Docs.**

### Verificación de F2

- RED observado antes de cada implementación.
- `npm test`: 161/161. Golden sin editar.
- Smoke real de `index.js` con sesión vacía temporal, puerto 3099 y captura
  prendida: arranca, crea `chat.db`, `/health` 200, apagado ordenado. No se
  probó la captura contra WhatsApp real (requiere parear otra sesión).

## Próximo paso

F3 (credenciales con identidad) y luego F4 (lectura por cursor + retención).
Pendiente aparte: los dos warnings de `resolveLegacyTarget` de la revisión de F0
(nombre de grupo sin letras ASCII tratado como teléfono; cache de grupos sin
invalidar en un miss).

## Fases siguientes (no autorizadas todavía)

F1 puerto de transporte · F2 inbound · F3 principals · F4 cursor · F4b webhook ·
F5 carril conversacional · F6 compatibilidad. Ver el diseño para dependencias.
