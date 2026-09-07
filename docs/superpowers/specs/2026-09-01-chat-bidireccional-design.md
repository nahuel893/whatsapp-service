# Diseño: chat bidireccional

> Fecha: 2026-09-01
> Estado: aprobado, sin implementar
> Reemplaza el principio *"NO incluye forwarding de mensajes entrantes"* de `AGENTS.md`

## Objetivo

Que un consumidor pueda **leer** los mensajes que llegan a una conversación y
**responder** dentro de ella, sin perder contexto en silencio, y viendo
únicamente las conversaciones que tiene permitidas.

El consumidor principal serán agentes atendiendo clientes, pero nada del diseño
asume que el consumidor sea un agente.

## Qué necesita un agente del servicio

El servicio no contiene lógica de agente, pero sí tiene que ofrecer lo que un
agente no puede resolver solo. Esta lista sale de mirar un consumidor real, y
cada punto está atado a una decisión de abajo.

| Necesidad | Por qué el consumidor no puede resolverla solo | Dónde |
|---|---|---|
| Enterarse de un mensaje entrante | Sólo el servicio tiene la conexión al canal | D4 |
| Ver únicamente lo permitido | No se puede desver lo que ya se recibió; filtrar del lado del cliente no es un permiso | D3 |
| Saber qué contexto perdió | Sólo el servicio sabe qué purgó la retención | D5 |
| Que un entrante no llegue dos veces | El proveedor reentrega. Un agente que procesa el duplicado **contesta dos veces**, y el cliente lo ve | `external_id` |
| Responder rápido | El pacing anti-spam vive en el servicio, no en el consumidor | D6 |
| Un id de conversación que sobreviva reinicios | El consumidor es efímero; el hilo no | D2 |

Lo que el servicio **no** ofrece, y es del consumidor: resumir, decidir cuándo
escalar a un humano, memoria de largo plazo, y a quién se le puede escribir
(D7).

## Restricciones

1. **El dominio no puede saber qué es WhatsApp.** Hoy dependemos de Baileys, que
   a su vez depende de WhatsApp Web — un protocolo no oficial que puede cambiar
   o desaparecer. Toda semántica del proveedor (JIDs, LIDs, `@g.us`, prekeys)
   queda detrás de un adaptador.
2. **Los consumidores actuales no se rompen.** El pipeline de reportes usa
   `/send-text`, `/send-image`, `/send-file` y `/send-file-dm`, y no manda API
   key. Siguen funcionando.
3. **Sin dependencias nuevas.** Rige el congelamiento por Shai-Hulud. `node:sqlite`
   y `node:test` son built-ins y alcanzan.
4. **Un solo proceso dueño de la sesión.** No cambia: el transporte sigue siendo
   propiedad exclusiva del daemon.

## Decisiones

### D1 — El puerto de transporte es multi-canal

El dominio habla de `Conversation`, `Participant` y `Message`. Baileys pasa a
ser un adaptador entre varios posibles.

Se descartó abstraer sólo Baileys (manteniendo JIDs en el dominio) porque no
protege del escenario que motiva todo esto: que el problema sea WhatsApp mismo,
no la librería.

### D2 — URI para abrir, id opaco para continuar

Un consumidor abre una conversación con una dirección calificada por canal y
recibe un identificador estable que usa de ahí en más.

```
POST /conversations   { "address": "whatsapp:+5490000000000" }
                   →  { "id": "conv_7f3a", "channel": "whatsapp" }
POST /conversations/conv_7f3a/messages
```

Cubre los dos sentidos de inicio: el consumidor que arranca conociendo un
teléfono, y el cliente que escribe primero sin que nadie lo haya dado de alta —
en ese caso el servicio mintea la conversación solo.

Se descartó direccionar siempre por URI porque ata al consumidor al canal para
siempre. Se descartó usar sólo ids opacos porque obliga a dar de alta cada
contacto antes de poder escribirle, y rompe a los consumidores actuales.

### D3 — El permiso se aplica en el servidor

Un consumidor sólo ve las conversaciones que le fueron concedidas.

Esto contradice en apariencia el principio *"NO incluye allowlist"* de
`AGENTS.md`, pero es otra cosa: aquella allowlist era **a quién le mandamos** —
política de negocio, del consumidor. Ésta es **qué puede leer una credencial** —
autorización. Un consumidor no puede filtrar lo que ya recibió: si el filtro
vive del lado del cliente no es un permiso, es una sugerencia.

### D4 — El almacén es la fuente de verdad; la entrega es una estrategia encima

Todo mensaje entrante se persiste **antes** de intentar entregarlo. Sobre ese
almacén se ofrecen dos formas de leer, y un consumidor puede usar las dos:

| Forma | Para quién | Latencia | Recuperación |
|---|---|---|---|
| Cursor (`?since=`) | consumidor efímero, que se reinicia entre turnos | la de su polling | es el caso normal |
| Webhook | servicio de larga vida que quiere baja latencia | inmediata | cae de vuelta al cursor |

El webhook **no reemplaza** al cursor: lo adelanta. Si el consumidor está caído,
el servicio reintenta con backoff acotado y después deja de insistir — el
mensaje sigue en el almacén, y el consumidor lo recupera por cursor con su
último `seq` cuando vuelve. Así ningún mensaje se pierde por una caída del
consumidor, sin construir una cola de entrega por suscriptor.

Una entrega por webhook puede duplicarse (reintento sobre una entrega que sí
había llegado). Cada mensaje lleva su `id` y su `seq`, que es lo que un
consumidor necesita para deduplicar.

**Corrección respecto de la primera versión de este documento**, que decía
"cursor, no webhook" y justificaba que todo agente es efímero. Es falso: el
primer consumidor real es un servicio de larga vida que ya expone un endpoint
de inbound y hace su propia deduplicación. Un servicio que sólo ofreciera
polling lo obligaría a degradarse.

SSE queda fuera de alcance.

### D5 — La pérdida de contexto se reporta, no se oculta

Cada mensaje lleva un `seq` monótono dentro de su conversación. La retención
borra mensajes viejos, pero deja una marca de agua. Si un consumidor pide desde
un punto ya purgado, la respuesta **declara el hueco**:

```json
{ "gap": { "from": 340, "to": 512, "reason": "retention" },
  "messages": [ ... ],
  "next": 530 }
```

El consumidor sabe que perdió 172 mensajes y cuáles. Puede seguir, escalar a un
humano, o pedir el historial por otra vía. Perder contexto es inevitable con
retención acotada; perderlo sin enterarse, no.

### D6 — Dos carriles en la cola

El pacing actual (60-120 s por default, 90-180 s en producción) existe para que
un envío masivo no haga que WhatsApp marque la cuenta como bot. Aplicado a una
respuesta en una conversación viva, es inservible.

| Carril | Pacing | Para qué |
|---|---|---|
| `bulk` | el actual | informes, notificaciones no solicitadas |
| `conversation` | sin delay, serializado igual | responder a alguien que escribió |

La distinción no es arbitraria: las heurísticas de spam apuntan al envío masivo
no solicitado, no a contestarle a quien te acaba de escribir.

### D7 — El servicio no resume ni interpreta

Entrega la transcripción y declara qué se perdió. Resumir, decidir cuándo
escalar y mantener memoria de largo plazo es del consumidor. Esa línea es la
misma que ya separa al servicio de la lógica de agente.

## Modelo de dominio

```
Conversation   id, channel, address, display_name, created_at,
               last_message_at, next_seq, pruned_through_seq

Message        id, conversation_id, seq, direction, external_id,
               author, text, media_id, reply_to, status, at

Principal      id, name, key_hash, scope, created_at
Grant          principal_id, conversation_id, granted_at
```

`direction` es `in` u `out`. Un mensaje saliente entra con `status: "queued"` y
avanza a `sent` o `error`, igual que un job hoy.

`external_id` es el id del mensaje en el proveedor. Es la clave de
deduplicación: WhatsApp reentrega, y sin esto un reintento del proveedor
generaría mensajes duplicados en la transcripción.

`pruned_through_seq` es la marca de agua que hace posible D5.

## El puerto

```js
/**
 * A transport owns one account on one channel. It translates between the
 * provider's addressing and the domain's, and never leaks provider types.
 */
interface ChatTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  status(): { connected: boolean, identity: string | null }

  /** What this channel can do. Callers must degrade, not assume. */
  capabilities(): {
    media: boolean, replyTo: boolean, groups: boolean,
    readReceipts: boolean, typing: boolean
  }

  /** 'whatsapp:+549...' ⇄ provider address. Only the adapter knows the shape. */
  parseAddress(uri: string): ProviderAddress
  formatAddress(addr: ProviderAddress): string

  send(addr: ProviderAddress, content: OutboundContent): Promise<{ externalId: string }>

  /** Emits domain-shaped inbound messages. Returns an unsubscribe. */
  onMessage(handler: (msg: InboundMessage) => void): () => void
}
```

Se implementan dos adaptadores desde el arranque:

- **`BaileysTransport`** — envuelve lo que hoy es `lib/baileys.js`.
- **`MemoryTransport`** — sin red, sin WhatsApp. No es sólo para tests: es lo
  que valida que la abstracción sirva. Una interfaz con un solo implementador no
  está probada, está supuesta.

`capabilities()` existe porque los canales difieren de verdad. Un consumidor que
asuma que todos soportan `reply_to` se rompe en el primer canal que no.

## Subsistemas y orden

Cada fase es entregable y verificable por separado.

| # | Fase | Qué deja funcionando | Depende de |
|---|---|---|---|
| F1 | Puerto de transporte | Nada nuevo hacia afuera; Baileys queda detrás de la interfaz y aparece `MemoryTransport` | — |
| F2 | Modelo de conversación y captura de inbound | Los mensajes entrantes se persisten y deduplican. Nadie los lee todavía | F1 |
| F3 | Credenciales con identidad | Varias API keys, cada una un principal con scope. La key única actual sigue andando como `scope: all` | — |
| F4 | Entrega: cursor, permisos y huecos | Un consumidor lee **sus** conversaciones y sabe qué perdió | F2, F3 |
| F4b | Entrega por webhook | Un consumidor de larga vida recibe el mensaje empujado, con el cursor como recuperación | F4 |
| F5 | Respuesta y carril conversacional | Un consumidor responde dentro de una conversación | F4 |
| F6 | Compatibilidad | Los endpoints viejos traducen al modelo nuevo; queda un solo camino de código | F5 |

F1 y F3 son independientes y se pueden hacer en cualquier orden.

## API

```
POST   /conversations                      abrir o resolver por address
GET    /conversations                      listar las concedidas
GET    /conversations/:id                  metadatos
GET    /conversations/:id/messages?since=  leer con cursor
POST   /conversations/:id/messages         responder
POST   /conversations/:id/read             marcar leído hasta un seq

POST   /subscriptions                      registrar webhook de un principal
GET    /subscriptions                      ver los propios
DELETE /subscriptions/:id

POST   /principals                         alta de credencial (scope: all)
POST   /conversations/:id/grants           conceder acceso a un principal
DELETE /conversations/:id/grants/:principal
```

Una conversación no concedida responde **404, no 403**. Un 403 confirma que
existe, y eso ya filtra información sobre con quién habla la cuenta.

## Errores y modos de fallo

| Situación | Comportamiento |
|---|---|
| Transporte caído | `POST .../messages` acepta y encola igual. La cola ya sobrevive reinicios; no hay razón para rechazar |
| Mensaje entrante que no descifra | Se persiste con `status: "undecryptable"` y sin texto. Ocupa su `seq`: el hueco queda visible en la transcripción en vez de desaparecer |
| Reentrega del proveedor | El `UNIQUE (conversation_id, external_id)` la absorbe. No genera duplicado |
| Media entrante que no baja | El mensaje se guarda con `media_id` nulo y una marca de error. El texto no se pierde por culpa del adjunto |
| Cursor anterior a la retención | Se responde con `gap` (D5) |
| Consumidor de webhook caído | Reintento con backoff acotado, después se abandona. El mensaje queda en el almacén y se recupera por cursor (D4) |
| Webhook entregado dos veces | El consumidor deduplica por `id` o `seq`, que van en cada mensaje (D4) |
| Conversación sin grant | 404 |

## Testing

`MemoryTransport` permite probar el ciclo bidireccional completo sin red, sin
WhatsApp y sin sesión — igual que hoy los tests de API corren contra un doble
de Baileys.

Cobertura mínima por fase:

- **F1** — el mismo test suite corre contra `MemoryTransport` y contra un
  `BaileysTransport` con el socket mockeado. Si un test pasa en uno y falla en
  el otro, la abstracción tiene una fuga.
- **F2** — dedup por `external_id`, `seq` monótono, mensaje que no descifra.
- **F3** — key inválida, key con scope, la key única de hoy sigue andando.
- **F4** — cursor, hueco por retención, 404 por falta de grant, aislamiento
  entre dos principals sobre la misma conversación.
- **F5** — respuesta encolada y entregada, carril conversacional sin delay,
  carril bulk con delay.
- **F6** — cada endpoint viejo produce el mismo resultado observable que antes.

## Fuera de alcance

Se dejan afuera a propósito, y ninguno requiere rediseñar lo de arriba:

- SSE — el cursor y el webhook cubren los dos perfiles de consumidor que existen
  hoy; un tercer mecanismo sin un consumidor que lo pida es especular
- Adaptador de Telegram u otro canal real — el puerto lo permite; construirlo
  sin necesidad concreta es especular
- Reacciones, hilos, edición y borrado de mensajes
- Presencia y typing
- Resumen o memoria de largo plazo (D7)
- Búsqueda en la transcripción

## Riesgos abiertos

1. **La abstracción se valida recién con un segundo canal real.**
   `MemoryTransport` prueba la forma, no la generalidad. Es probable que el
   primer adaptador de verdad obligue a mover el puerto.
2. **`capabilities()` puede no alcanzar.** Si las diferencias entre canales
   resultan más profundas que un conjunto de flags, hay que revisarlo.
3. **El carril conversacional asume una hipótesis sobre WhatsApp.** Que
   responder rápido a un inbound no dispara las heurísticas de spam es
   razonable, pero no está verificado. Conviene instrumentarlo antes de
   confiarse.
4. **Baileys sigue en release candidate.** El desacople reduce el costo de
   cambiarlo, no la probabilidad de que se rompa.
