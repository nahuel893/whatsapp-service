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

- [ ] **T1 — Limpiar el working tree.** Commit de `.gitignore` (agrega `.atl/`) y
      commit separado de `engineering-workflow.md`. Deja el diff de F0 legible.
- [ ] **T2 — Scaffolding golden.** Crear `test/golden-compat.test.js` autocontenido:
      doble de Baileys, arranque de Express sobre store temporal, helper `drained()`,
      y el encabezado que declara la regla de "no se editan". Un test trivial que
      pase, para fijar la infraestructura.
- [ ] **T3 — Formas de respuesta de los 4 endpoints de envío.** Congelar
      `ok` vs `success`, la presencia de `message` en image/file y su ausencia en
      file-dm, y `queued: true`. Cubre las dos brechas totales (`/send-image`,
      `/send-file-dm`). **Esta es la tarea de mayor valor.**
- [ ] **T4 — Identidad de `job_id`.** Entero positivo, `Number.isInteger`, monótono
      creciente entre envíos sucesivos. Y `/queue/job/:id`: 400 para `abc`, `0`,
      negativo, `1.5`; 404 para un entero inexistente.
- [ ] **T5 — Formas de lectura.** `/status`, `/queue/status` (incluida la forma de
      cada elemento de `recent[]` y los valores válidos de `type` y `status`),
      `/health` (incluido `queue{}`), `/groups`.
- [ ] **T6 — Resolución de targets.** Tabla completa de `resolveJid`: con `@` se usa
      tal cual (`@s.whatsapp.net`, `@g.us`, `@lid`), numérico con símbolos va a
      `@s.whatsapp.net`, nombre de grupo case-insensitive, grupo inexistente falla el
      job en vez de darse por enviado.
- [ ] **T7 — Errores.** `503 session_not_ready` con su body en los 5 endpoints que
      pasan por `requireSession`; 400 por target faltante y por archivo faltante, con
      la forma exacta de cada uno (la inconsistencia `{error}` pelado se congela).
- [ ] **T8 — Carril `bulk` por default.** La regresión que ningún test de forma
      detecta: un envío por los endpoints viejos tiene que respetar el pacing
      configurado. Con `minDelayMs` alto, el segundo job no sale antes de ese
      tiempo. Es el test que impide que F5/F6 dejen al daily sin espaciado.
- [ ] **T9 — Suite completa en verde + commit de F0.**
- [ ] **T10 — Anotar F0 como hecho** en el diseño y en `AGENTS.md`.

## Fases siguientes (no autorizadas todavía)

F1 puerto de transporte · F2 inbound · F3 principals · F4 cursor · F4b webhook ·
F5 carril conversacional · F6 compatibilidad. Ver el diseño para dependencias.
