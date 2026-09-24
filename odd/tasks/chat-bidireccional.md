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

## Próximo paso

F1 — puerto de transporte (`ChatTransport` + `MemoryTransport`, Baileys detrás
de la interfaz). No autorizado todavía.

## Fases siguientes (no autorizadas todavía)

F1 puerto de transporte · F2 inbound · F3 principals · F4 cursor · F4b webhook ·
F5 carril conversacional · F6 compatibilidad. Ver el diseño para dependencias.
