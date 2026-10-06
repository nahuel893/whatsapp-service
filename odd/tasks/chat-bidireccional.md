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

## Camino a agentes funcionales (autorizado 2026-10-06)

Pedido: "que tengamos agentes funcionales, utilizando la asincronía y las
funciones anti-ratelimit". Orden: **F3 → F4 → F5 → F4b**. Con F5 un agente ya
atiende (lee por cursor y responde); F4b agrega la entrega empujada.

## F3 — Credenciales con identidad

Rama `feat/f3-principals`, apilada sobre F2. TDD estricto, runner `npm test`.

**Decisiones:**
- Principals y grants viven en `chat.db`. La base se abre **siempre**;
  `INBOUND_CAPTURE` sólo decide si se suscribe la captura.
- Key `wsk_<64 hex>`, guardada como SHA-256; se muestra una sola vez al crearla.
- Scopes: `all` (todo, como hoy) y `conversations` (sólo lo concedido; default).
- `API_KEY` sigue siendo un principal `all` implícito (`id: "legacy"`). Con
  `API_KEY` vacía la API sigue abierta: un request sin key es `legacy/all`.
  **Los scopes sólo se hacen cumplir con `API_KEY` seteada.**
- Endpoints viejos, `/groups`, `/queue/*`, `/status` y la administración
  (`/principals`, grants, `POST /conversations`) piden `scope: all` → 403
  `forbidden` si no. Un agente no puede escribirle a quien quiera.
- 401 sin cambios (golden).

- [x] **F3.1 — `lib/principal-store.js`** `2818ce2`.: create/authenticate/list/revoke,
      grant/revokeGrant/isGranted/grantedConversationIds.
- [x] **F3.2 — Auth con identidad** `0eea5b2`.: `req.principal`, `requireScope("all")`.
- [x] **F3.3 — Endpoints de administración** `0b187ac`.: `POST/GET/DELETE /principals`,
      `POST /conversations`, `POST/DELETE /conversations/:id/grants`.
- [x] **F3.4 — Cableado en `index.js`** + docs. Smoke real con `API_KEY`: key de agente → 403 en `/send-text`, admin → 200.

## F4 — Lectura: cursor, permisos y huecos

Rama `feat/f4-cursor-read`, apilada sobre F3. TDD estricto.

**Decisiones:**
- **Retención = prefijo contiguo de mensajes viejos.** Con timestamps fuera de
  orden, purgar "hasta el seq viejo más alto" borraría un mensaje reciente.
- **Cursor guardado en el servidor** (`read_markers`, por principal y
  conversación). Un agente efímero no necesita persistir su `seq`: lee sin
  `since`, procesa, y hace `POST /read`. `since` explícito sigue disponible.
  El marcador sólo avanza (un `seq` menor no retrocede).
- `GET /conversations` incluye `lastSeq`, `readSeq` y `unread` (entrantes
  después del marcador) — lo que un agente necesita para saber a quién atender.
- Sin grant → **404** (no 403): no se confirma que la conversación exista.
- **Retención** (`CHAT_RETENTION_DAYS`, default 90): borra por antigüedad en
  bloque contiguo desde el inicio y sube `pruned_through_seq`. Un pedido que
  arranca antes de la marca recibe `gap: {from, to, reason: "retention"}`.
- Forma pública de un mensaje: `{id, seq, direction, author, text, status, at}`.
  El `externalId` del proveedor no sale.

- [x] **F4.1 — Store:** `9bd08be`. `listConversations`, `readMessages` (con gap),
      `prune`, `lastInboundSeq`/`countInboundAfter`; `read_markers` en el
      principal store.
- [x] **F4.2 — API:** `ac8c9ce`. `GET /conversations`, `GET /conversations/:id`,
      `GET /conversations/:id/messages`, `POST /conversations/:id/read`.
- [x] **F4.3 — Retención al arranque** + config + docs. Además una vez por día (`setInterval` con `unref`).

## F5 — Responder, con el carril conversacional

Rama `feat/f5-reply-lanes`, apilada sobre F4. TDD estricto.

**Decisiones:**
- Carril en `jobs.lane` (`bulk` default). Migración en el lugar de `queue.db`:
  los jobs existentes quedan `bulk`. `lane` no sale por `/queue/job/:id`
  (forma congelada).
- La cola **mira antes de esperar y toma después**: un job esperando su delay
  sigue `pending`. Una respuesta interrumpe la espera de un bulk; el bulk
  reinicia su delay completo (el golden T8 sigue protegiendo el pacing).
- Carril conversacional **no instantáneo**: piso 1,5–4 s desde el envío
  anterior (riesgo abierto 3 del diseño: no está verificado que responder en
  0 s sea seguro).
- Tope 20 respuestas/min **por conversación** → 429 + `Retry-After`.
- El job de respuesta (`chat-text`) sólo apunta al mensaje; el texto vive en
  la transcripción.
- Con el transporte caído, la respuesta se acepta y espera la reconexión
  (5 min, `connectTimeoutMs`).

- [x] **F5.1 — Carriles en `job-store`** `fee529e`.
- [x] **F5.2 — Planificador por carril** `3162f9f`.
- [x] **F5.3 — Salientes en la transcripción** (store).
- [x] **F5.4 — `POST /conversations/:id/messages`** + tope + config.
- [x] **F5.5 — Espera de reconexión** `2233256`.
- [x] **F5.6 — Ciclo completo de un agente** (`test/agent-loop.test.js`).

## F4b — Webhook

Rama `feat/f4b-webhooks`, apilada sobre F5. TDD estricto.

**Decisiones:**
- Suscripciones por principal (`subscriptions` en `chat.db`). El secreto se
  guarda en claro porque hace falta para firmar; se muestra una sola vez.
- Firma `X-Webhook-Signature: sha256=HMAC(secret, "<timestamp>.<body>")` con
  `X-Webhook-Timestamp`: verificable y resistente a replay.
- Eventos `message.created` y `message.updated` (un `undecryptable` que se
  completó). Un duplicado del proveedor no dispara nada.
- Visibilidad igual que la lectura: grant o scope `all`.
- Reintentos en memoria 1 s / 5 s / 25 s, timeout 5 s por intento; después se
  abandona — el cursor es la recuperación (D4). Sin cola de entrega.
- Sólo `http`/`https`. **SSRF aceptado y documentado**: el caso principal es un
  agente en `localhost`, así que no se bloquean hosts internos; las keys las da
  el operador.

- [x] **F4b.1 — `lib/subscription-store.js`** `9f0a01e`
- [x] **F4b.2 — `lib/webhooks.js`** (dispatcher con firma y reintentos) `c21bb0f`
- [x] **F4b.3 — Endpoints** `POST/GET/DELETE /subscriptions`
- [x] **F4b.4 — Captura → dispatcher** + `index.js` + docs. E2E con servidor HTTP real y firma verificada.

## Estado: agentes funcionales (2026-10-06)

F0–F5 + F4b hechos. Un agente con su key puede: ver qué conversaciones tienen
`unread`, leer desde su marcador, responder por el carril conversacional, y
recibir cada entrante por webhook firmado. 265/265 tests.

## Próximo paso

- **F6** — que los endpoints viejos traduzcan al modelo nuevo (un solo camino).
- Probar contra WhatsApp real (parear una sesión de prueba, no la de producción).
- Pendientes de revisión: warnings de `resolveLegacyTarget` (#2842).
Pendiente aparte: los dos warnings de `resolveLegacyTarget` de la revisión de F0
(nombre de grupo sin letras ASCII tratado como teléfono; cache de grupos sin
invalidar en un miss).

## Fases siguientes (no autorizadas todavía)

F1 puerto de transporte · F2 inbound · F3 principals · F4 cursor · F4b webhook ·
F5 carril conversacional · F6 compatibilidad. Ver el diseño para dependencias.
