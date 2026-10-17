# Pendientes

Todo lo abierto del servicio, por área. Cada ítem dice qué falta y por qué,
para poder retomarlo sin la sesión que lo originó. Marcar con `[x]` al cerrar y
anotar la versión o el commit.

Última actualización: 2026-10-16.

## Incidente del 2026-10-16 (OOM + disco lleno)

Cronología: 10:27 OOM de toda la máquina, el kernel mata procesos (entre ellos
la instancia de agentes `:3002` y un `uvicorn` de otro proyecto). 11:40 el
disco `/` llega al 100 %; Baileys estaba guardando la sesión y `creds.json`
quedó vacío en `:3002` y cortado en 4096 bytes en `:3001`. Los dos números
quedaron desvinculados.

- [x] Escritura atómica de la sesión + `creds.json.bak` (`lib/session-store.js`).
  v0.7.0 en `main`, backport v0.1.1 en `release/0.1.x` para producción.
- [x] Un `saveCreds` que falla se loguea en vez de tirar abajo el proceso.
- [x] `queue.db` de producción compactado (274 MB → 1 MB) y
  `BAILEYS_LOG_LEVEL` de producción bajado de `debug` a `warn`.
- [x] `:3002` (número de agentes) re-pareado, 16:10.
- [x] `:3001` (número de informes) re-pareado: `/health` muestra
  `connected: true`.
- [ ] **Disco al 89 %.** Tras la limpieza del incidente quedó en 85 % y
  volvió a subir en pocas horas; no está identificado qué crece. Medido el
  2026-10-16: journals 2,2 GB (1,2 GB de sistema + 1 GB de usuario), `/tmp`
  1,5 GB, volúmenes de Docker sin usar 1,5 GB, imágenes de Docker reclamables
  435 MB, `~/.cache` 911 MB. **Ninguno se borró: lo decide el dueño de la
  máquina.** Con el disco lleno la escritura atómica protege la sesión, pero
  la cola y el historial dejan de guardar.
- [ ] Ponerle techo al journal (`SystemMaxUse=` en `journald.conf`; pide
  `sudo`).
- [ ] Encontrar la causa del OOM. No fue este servicio, sino otros procesos
  (python/uvicorn). Sin causa, se puede repetir y volver a matar a `:3002`.
- [ ] Compactar `queue.db` periódicamente (`VACUUM` después del purgado diario,
  o `PRAGMA auto_vacuum = INCREMENTAL`). Los BLOB de los adjuntos se borran al
  enviarse, pero SQLite no devuelve el espacio: así llegó a 274 MB.
- [ ] Alerta cuando un número se desvincula (`/health` con
  `whatsapp.connected: false` por más de unos minutos). En el incidente se
  enteraron porque los empleados no recibían respuestas.
- [ ] Borrar las sesiones rotas `session.dead-20261016` (en el repo de
  producción y en `~/.local/share/whatsapp-agents`) cuando todo esté estable.
  **Contienen credenciales.**

## Operación y configuración

- [ ] Sacar `PRINT_QR=true` de producción (`qr.conf`) y de la unidad
  `whatsapp-agents.service` después de 24 h estables.
- [ ] Producción sin `API_KEY`. Escucha sólo en `127.0.0.1` (`bind.conf`),
  pero los scopes no se hacen cumplir. Activarla exige actualizar el pipeline
  de informes en la misma pasada.
- [ ] Producción sigue en la rama `release/0.1.x` (v0.1.1). Decidir cuándo
  pasa a la línea de `main`.
- [ ] Borrar `../whatsapp-service.gitbak-20260827-013101/`: backup del `.git`
  previo a la limpieza del historial; **todavía contiene credenciales**.
- [ ] Default de `HOST` a `127.0.0.1` en `lib/config.js`. Cambia el default
  (Docker publica el puerto y necesitaría `HOST=0.0.0.0` explícito):
  decisión de contrato.
- [ ] `markOnlineOnConnect: false`, para que el número no figure "en línea"
  todo el día (señal de bot).

## Anti-baneo

- [ ] Tope global de envíos por número (hoy el tope es por conversación y
  para conversaciones nuevas, no total).
- [ ] Rampa para un número nuevo: pocos envíos los primeros días.
- [ ] Lista de chats habilitados (allowlist): hoy sólo se excluyen los grupos
  (`INBOUND_GROUPS=false`).
- [ ] Race al enviar tras reconectar: la cola no re-chequea la conexión antes
  de `sendMessage` (AGENTS.md § Pendientes 1).

## Funcionalidad

- [x] Video y GIF animado en las respuestas (`video/mp4` y
  `gifPlayback=true`), pedido de badie-ai. v0.8.0.
- [x] Validación en vivo de `gifPlayback`: 4 mp4 de pixel-art (10–23 KB,
  384×336, H.264 `yuv420p`, sin audio) llegaron animados en el chat,
  2026-10-16.
- [ ] Media entrante: hoy de un adjunto llega sólo el caption.
- [ ] Convertir el markdown de los agentes al formato de WhatsApp (`**` → `*`,
  títulos, listas).
- [ ] F6: que los endpoints viejos (`/send-*`) pasen por el modelo de
  conversación.
- [ ] Advertencias de la revisión de F0 en `resolveLegacyTarget`: un nombre de
  grupo sin letras ASCII se trata como teléfono, y la caché de grupos no se
  invalida en un miss.
- [ ] Revisar las advertencias abiertas de la revisión del agente de
  referencia (`examples/claude-agent`) y del MCP (`packages/mcp`) antes de
  usarlos fuera de pruebas.

## Repo y documentación

- [ ] `AGENTS.md` desactualizado en partes: dice que el repo no tiene remote,
  que los logs están en `debug`, y que el MCP necesita el SDK (se hizo sin
  dependencias). § Pendientes 3, 5 y 7 ya están resueltos.
- [ ] `.env.example` no lista las variables nuevas; la tabla de § Config de
  `AGENTS.md` es la fuente de verdad.
- [ ] Borrar la rama local `feat/baileys-v7-lid` (ya mergeada en `main`).
- [ ] README del perfil de GitHub (`nahuel893/nahuel893`, líneas 64 y 130):
  muestra este repo como privado y ya es público. Falta la respuesta del dueño
  para corregirlo.
