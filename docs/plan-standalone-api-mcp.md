# Plan: servicio desplegable con API y MCP

> Redactado el 2026-08-24 desde el repo `the report pipeline`, para continuar en una
> sesion abierta sobre este repo. Todo el "estado actual" de abajo fue
> verificado contra el codigo y contra el servicio corriendo, no asumido.

## Objetivo

Convertir este repo en un **servicio desplegable** con API HTTP y servidor MCP,
consumible por otras aplicaciones y por otros agentes — no solo por el reporter
de Python de `the report pipeline`.

## Estado actual (verificado 2026-08-24)

| | |
|---|---|
| Repo | git propio, 6 commits desde 2026-05-12 |
| Remote | **ninguno** — nunca se pusheo, vive solo en esta maquina |
| Branch | `feat/baileys-v7-lid`, sin mergear |
| Sin commitear | `AGENTS.md` modificado; `.atl/` y dos `session.dead-*` untracked |
| Servicio | `systemd --user whatsapp-service`, activo, puerto `3001` |
| Baileys | `^7.0.0-rc13` (release candidate, inestable) |
| Codigo | 603 lineas, ya separado en capas |
| Documentacion | `AGENTS.md` (14 KB), completo y al dia |

```
index.js               50   arranque
lib/api.js            227   endpoints HTTP
lib/baileys.js        148   conexion
lib/message-queue.js  121   cola
lib/config.js          32
lib/session-store.js   25
```

No hay `CLAUDE.md`. Claude Code lee `AGENTS.md` igual, pero conviene el symlink
`CLAUDE.md -> AGENTS.md` (misma convencion que `the report pipeline`) para que ningun
agente lo pase por alto.

## Decision de arquitectura

**Un repo, dos procesos.** El MCP va como cliente delgado sobre la API HTTP,
NO dentro del mismo proceso que Baileys.

```
whatsapp-service/                  <- un repo, un deploy
  packages/server/     daemon: Baileys + HTTP API + cola   (unico dueno de session/)
  packages/mcp/        MCP: stdio + streamable HTTP        (cliente HTTP, sin estado)
  packages/shared/     tipos y cliente compartidos
```

### Por que separado

1. **Baileys es dueno de un estado unico.** La carpeta `session/` guarda las
   claves de la sesion de WhatsApp y solo un proceso puede tenerla abierta. Dos
   procesos Baileys contra el mismo directorio corrompen la sesion y obligan a
   re-pair por QR. Las tres carpetas `session.dead-*` del disco son justamente
   eso ya ocurrido.

2. **Los MCP por stdio se spawnean por cliente** — una instancia por cada agente
   que se conecta. Si el MCP viviera dentro del proceso de Baileys, cada agente
   intentaria arrancar un segundo Baileys y romperia la sesion. Con el MCP
   separado eso es estructuralmente imposible: no toca `session/`, solo hace
   HTTP contra `localhost:3001`.

3. **Ciclos de vida opuestos.** El servicio es un daemon de larga vida con auth
   por QR; un MCP stdio es efimero, spawneado y matado permanentemente.

4. **Radio de dano.** Un MCP que crashea o un agente que se porta mal no puede
   voltear la entrega de mensajes.

5. **Respeta el principio que ya declara `AGENTS.md`**: *"NO incluye logica de
   agente, allowlist, dedup, ni forwarding — eso queda del lado del consumidor."*
   El MCP **es** un consumidor, igual que el reporter de Python.

El costo es un hop HTTP en localhost. Despreciable.

### Transporte del MCP

Para que sea usable por otras **apps** y no solo por agentes locales, el MCP
necesita **Streamable HTTP** ademas de stdio. Stdio solo sirve para un agente en
la misma maquina.

## Bloqueantes antes de exponerlo

### 1. La API no tiene autenticacion — ninguna

Verificado: `rg -i "auth|token|apikey|bearer|secret" lib/api.js lib/config.js`
no devuelve nada fuera de comentarios sobre el auth state de Baileys.

Hoy no importa porque escucha en localhost detras de Tailscale. Pero
"desplegable y usable por otras apps" significa que **cualquiera que alcance el
puerto manda mensajes de WhatsApp con el numero personal** (`5490000000000`).
Esto va primero, antes que el MCP.

### 2. La cola es 100% en memoria

```js
// lib/message-queue.js
const queue = [];      // se pierde en cada restart
const recent = [];
recent.splice(50);     // solo los ultimos 50 jobs
```

Un restart tira los mensajes encolados y todo el historial. Para un servicio que
otros consumen, el `job_id` tiene que sobrevivir al restart: si no, ningun
consumidor puede confirmar si su mensaje salio.

Esto ya mordio en la practica: `/send-*` devuelve `{success, queued: true,
job_id}` de inmediato, y **`queued` no es `sent`**. Hay que pollear
`/queue/status` contra un historial de apenas 50 jobs para confirmar la entrega.

### 3. Secretos de sesion en el arbol de trabajo

`session/`, `session.bak-20260605-174520/`, `session.dead-174715/` y
`session.dead-20260822-090508/`. Hay `.gitignore` que cubre los backups, pero
las dos `session.dead-*` figuran untracked.

**Antes de crear el remote hay que confirmar que el patron las cubra a todas.**
Si eso se pushea, se regala la sesion de WhatsApp.

## Plan, en orden

1. **Higiene del repo** — parcial
   - [x] `.gitignore` ahora usa `session*/`, que cubre las cuatro carpetas
   - [x] symlink `CLAUDE.md -> AGENTS.md`
   - [ ] mergear `feat/baileys-v7-lid` — bloqueado, ver abajo
   - [ ] crear el remote y pushear — **bloqueado**, ver abajo
2. **Auth** — hecho. `lib/auth.js`, API key por `x-api-key` o
   `Authorization: Bearer`, comparacion en tiempo constante. Toda la config pasa
   por env (`process.loadEnvFile()` built-in), asi el mismo codigo corre bajo
   systemd, Docker o `node index.js`. `API_KEY` vacia deja la API abierta y el
   servicio lo avisa al arrancar — compatibilidad hacia atras con el reporter
3. **Persistencia de la cola** — hecho. `lib/job-store.js` sobre `node:sqlite`
   (built-in, cero dependencias nuevas). Los jobs son datos, no closures, asi
   sobreviven al restart; `GET /queue/job/:id` los consulta despues
4. **Deploy** — hecho. `Dockerfile` (node:24-slim), `.dockerignore`,
   endpoint `/health` abierto sin credenciales
5. **`packages/mcp`**: stdio + streamable HTTP — sin empezar

49 tests con `node:test` (built-in, sin framework instalado): `npm test`.

### Bloqueante nuevo, encontrado al hacer el paso 1

**Las credenciales de la sesion ya estan en el historial de git.** El commit
`a3f3bc4` agrego `session.bak-20260605-174520/creds.json` y ~8380 archivos de
sesion; `19d34e3` los borro, pero los blobs siguen en el historial. El repo no
tiene remote, asi que el dano esta contenido — pero pushear tal como esta
publica la sesion de WhatsApp.

Por eso el merge y el remote quedan frenados: si la salida elegida es
`rm -rf .git && git init`, mergear antes no sirve de nada.

Ver § Antes de crear el remote en `AGENTS.md` para las dos opciones.

### Lo que falta del paso 5

El MCP necesita `@modelcontextprotocol/sdk`, o sea `npm install`, o sea levantar
el congelamiento por Shai-Hulud. Es la primera dependencia nueva que pide este
plan: los pasos 2 a 4 se resolvieron enteros con built-ins de Node.

## Cuidados al trabajar en este repo

- **No correr `npm install` ni `npx` sin pin.** Esta vigente el congelamiento por
  Shai-Hulud/keyv. (Correccion respecto de la primera version de este documento:
  el repo **si** tiene `package-lock.json`, 83 KB, del 2026-07-28. El Dockerfile
  usa `npm ci`, que instala exactamente lo pineado.)
- **Baileys esta en release candidate** (`7.0.0-rc13`), inestable por
  definicion. Si reaparecen los errores *"Decrypted message with closed
  session"*, el primer intento es `systemctl --user restart whatsapp-service`;
  si no alcanza, re-pair borrando `session/` y escaneando QR.
- La copia del servicio que **corre** es esta, `~/projects/whatsapp-service/`.
  La carpeta `whatsapp-service/` dentro de `the report pipeline` quedo sin
  `package.json`: solo tiene `node_modules` y `session` residuales.

## Verificacion rapida

```bash
systemctl --user status whatsapp-service
curl -s localhost:3001/queue/status | python3 -m json.tool
git -C ~/projects/work/whatsapp-service status --porcelain
git -C ~/projects/work/whatsapp-service check-ignore -v session.dead-20260822-090508
```
