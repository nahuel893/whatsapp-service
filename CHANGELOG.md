# Changelog

Versiones según [SemVer](https://semver.org/lang/es/). Mientras la versión sea
`0.x`, la API nueva puede cambiar entre versiones menores; los endpoints
anteriores al chat bidireccional (`/send-*`, `/status`, `/queue/*`, `/groups`,
`/health`) **no**: su contrato está congelado en `test/golden/`.

## Sin publicar

### Documentación

- Detalles del contrato del webhook en `AGENTS.md` (§ Detalles del contrato
  del webhook): nombres exactos de headers, unidad del timestamp, tolerancia
  a cargo del receptor, dedup de `message.updated`, ausencia de eco de mensajes
  propios y de media.

## [0.2.0] — 2026-10-06

Chat bidireccional: un agente puede leer los mensajes que llegan a una
conversación y responder dentro de ella. Diseño en
`docs/superpowers/specs/2026-09-01-chat-bidireccional-design.md`; contrato para
consumidores en `AGENTS.md`.

**Todavía no probado contra WhatsApp real.** Validado con tests contra dobles
de Baileys y con arranques reales sin sesión.

### Agregado

- **Contrato congelado (F0).** `test/golden/`: formas de respuesta, `job_id`,
  resolución de targets, errores y pacing de los endpoints existentes.
- **Puerto de transporte (F1).** `ChatTransport` con dos adaptadores:
  `BaileysTransport` (único lugar que conoce los JID) y `MemoryTransport`.
  Direcciones `whatsapp:+<E.164>`, `whatsapp:group:<id>`, `whatsapp:lid:<id>`.
- **Captura de entrantes (F2).** `chat.db`, opt-in con `INBOUND_CAPTURE=true`.
  Dedup por id del proveedor; un mensaje que no se pudo descifrar se completa
  en su mismo `seq` cuando llega el reintento.
- **Credenciales por consumidor (F3).** `POST/GET/DELETE /principals`, scopes
  `all` y `conversations`, grants por conversación. Los endpoints anteriores
  piden scope `all`.
- **Lectura (F4).** `GET /conversations` (con `unread`),
  `GET /conversations/:id/messages` con cursor guardado en el servidor y
  `gap` declarado cuando la retención purgó historial, `POST .../read`.
  `CHAT_RETENTION_DAYS` (90).
- **Respuesta (F5).** `POST /conversations/:id/messages` por el carril
  `conversation`: adelanta a los envíos masivos sin acortar su pacing, piso
  humano de 1,5–4 s, tope de 20 respuestas/min por conversación (429).
- **Webhook (F4b).** `POST/GET/DELETE /subscriptions`; entrega firmada con
  HMAC-SHA256, reintentos 1/5/25 s y recuperación por cursor.

### Cambiado

- `queue.db` gana la columna `lane`; los archivos existentes se migran solos al
  arrancar y sus jobs quedan en el carril `bulk`.
- `chat.db` se abre siempre (la API de chat la necesita aunque la captura esté
  apagada).

### Corregido

- Un nombre de grupo que no se resuelve hace fallar el job en vez de darse por
  enviado a un destinatario vacío.
- `disconnect()` ya no se deshace por un reconectar pendiente.

### Seguridad

- Los scopes sólo se aplican con `API_KEY` seteada.
- Los webhooks hacen POST a la URL que registre cualquier key, incluidas
  direcciones internas. Pendiente: no seguir redirecciones.

## [0.1.0] — 2026-08-27

Primera versión publicable: API HTTP de envío sobre Baileys v7, cola
persistente en SQLite, autenticación por API key, `/health` y Dockerfile.

[0.2.0]: https://github.com/nahuel893/whatsapp-service/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nahuel893/whatsapp-service/releases/tag/v0.1.0
