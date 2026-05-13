# WhatsApp Service — Contexto del Proyecto

## Descripción

Abstracción genérica de Baileys (WhatsApp Web) como API HTTP standalone. Cualquier aplicación del sistema puede enviar mensajes, imágenes y archivos de WhatsApp sin tener que manejar la conexión Baileys directamente.

**NO** incluye lógica de agente, allowlist, dedup, ni forwarding de mensajes entrantes — eso queda del lado del consumidor.

## Stack

- **Node.js** 20+
- **Express** 4.19 (HTTP API)
- **Baileys** 6.7 (@whiskeysockets/baileys — WebSocket de WhatsApp)
- **multer** (multipart/form-data para archivos)
- **pino** (logging JSON estructurado)
- **qrcode-terminal** (QR en consola para auth inicial)

## Estructura

```
~/projects/work/whatsapp-service/
├── index.js                # Entry point: Express + bootstrap
├── lib/
│   ├── config.js           # Env vars con defaults (PORT, SESSION_DIR, NODE_ENV)
│   ├── session-store.js    # useMultiFileAuthState wrapper
│   ├── baileys.js          # Connection manager (init, reconnect, QR, eventos)
│   └── api.js              # Route handlers (5 endpoints)
├── session/                # Auth state persistente (GITIGNORED)
├── package.json
├── .env                    # Config local (GITIGNORED)
├── .env.example
├── .gitignore
└── AGENTS.md               # Este archivo
```

## API Reference

| Endpoint | Método | Content-Type | Body | Respuesta |
|----------|--------|-------------|------|-----------|
| `GET /status` | GET | — | — | `{connected: bool, phone: string}` |
| `POST /send-text` | POST | JSON | `{to: "@s.whatsapp.net", text: string}` | `{ok: true}` |
| `POST /send-image` | POST | multipart | `to`/`group_name`, `caption?`, `image` (file) | `{success, message}` |
| `POST /send-file` | POST | multipart | `to`/`group_name`, `caption?`, `file` | `{success, message}` |
| `POST /send-file-dm` | POST | multipart | `to`/`group_name`, `caption?`, `file` | `{ok: true}` |

### Notas sobre la API

- **`to`** puede ser:
  - Un número de teléfono (ej. `5490000000000`) — se resuelve a `5490000000000@s.whatsapp.net`
  - Un JID completo (ej. `5490000000000@s.whatsapp.net`) — se usa directo
  - Un nombre de grupo (ej. `Grupo Ventas`) — se busca en los grupos del usuario
- **`group_name`** se acepta como alias de `to` para backward compatibility con clientes viejos
- Los endpoints multipart aceptan archivos de hasta ~50MB (default de multer memoryStorage)
- Si la sesión no está autenticada, devuelve `503` con `error: session_not_ready`

## Configuración (env vars)

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3001` | Puerto del servidor HTTP |
| `SESSION_DIR` | `./session` | Directorio de persistencia de auth |
| `NODE_ENV` | `production` | `development` imprime QR en consola |
| `PRINT_QR` | `false` en prod | Forzar impresión de QR |
| `LOG_LEVEL` | `info` | Nivel de logging pino |

## Systemd

```ini
[Unit]
Description=WhatsApp Service — standalone Baileys abstraction
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node ~/projects/whatsapp-service/index.js
WorkingDirectory=~/projects/whatsapp-service
Restart=always
RestartSec=10s
Environment=NODE_ENV=production
Environment=SESSION_DIR=~/projects/whatsapp-service/session
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

### Comandos útiles

```bash
# Estado
systemctl --user status whatsapp-service

# Logs en tiempo real
journalctl --user -u whatsapp-service -f

# Logs con filtro JSON
journalctl --user -u whatsapp-service --since "1 hour ago" | grep "msg"

# Reiniciar
systemctl --user restart whatsapp-service
```

## Consumidores actuales

### 1. the report pipeline (Python, puerto 3001)
- `WhatsAppClient` en `src/core/whatsapp_client.py`
- `SendWhatsAppStep` en `src/delivery/steps/send_whatsapp.py`
- Envía imágenes de reportes y archivos xlsx a grupos/contactos

### 2. BD Agent (Python, puerto 3001)
- `WhatsAppMessagingGateway` en `an older consumer/integrations/messaging.py`
- Envía respuestas de texto via `/send-text`
- Envía archivos via `/send-file-dm`

### Cómo consumir desde cualquier app

```python
# Python
import httpx

client = httpx.Client(base_url="http://localhost:3001")

# Enviar texto
client.post("/send-text", json={"to": "5490000000000@s.whatsapp.net", "text": "Hola!"})

# Enviar archivo
with open("reporte.xlsx", "rb") as f:
    client.post("/send-file", data={"to": "5490000000000"}, files={"file": f})
```

```bash
# curl
curl -X POST http://localhost:3001/send-text \
  -H "Content-Type: application/json" \
  -d '{"to":"5490000000000@s.whatsapp.net","text":"Hola desde curl"}'

curl -X POST http://localhost:3001/send-image \
  -F "to=5490000000000" \
  -F "image=@foto.png" \
  -F "caption=Mirá esto"
```

## Arquitectura

```
App externa (Python, curl, etc.)
  │
  │ POST /send-text, /send-image, /send-file
  ▼
┌─────────────────────┐
│  Express API (api.js)│
│  - Valida request    │
│  - Resuelve JID      │
│  - Delega a Baileys  │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Baileys (baileys.js)│
│  - Socket Manager    │
│  - Auto-reconnect    │
│  - Event system      │
└────────┬────────────┘
         │
         ▼
   WhatsApp Web (WebSocket)
```

## Seguridad

- Sin autenticación entre servicios (corren en localhost)
- La sesión (`session/`) contiene credenciales de WhatsApp — **NUNCA** subir a git
- El `.gitignore` protege: `session/`, `node_modules/`, `.env`
- `SESSION_DIR` configurable por env var para aislar sesiones

## Sesión (autenticación)

La primera vez hay que escanear el QR con WhatsApp:

```bash
# Si PRINT_QR=true o NODE_ENV=development
journalctl --user -u whatsapp-service -f
# Buscar "Escanea el QR" y escanear con WhatsApp
```

La sesión persiste en `session/` automáticamente (multi-file auth state de Baileys).

## Primer uso en ambiente nuevo

```bash
git clone <repo-url> ~/projects/work/whatsapp-service
cd ~/projects/work/whatsapp-service
cp .env.example .env
npm install
PRINT_QR=true node index.js
# Escanear QR con WhatsApp
^C
# Arrancar como servicio
systemctl --user daemon-reload
systemctl --user start whatsapp-service
systemctl --user status whatsapp-service
```

## MCP (Model Context Protocol)

> Idea para desarrollo futuro.

Este servicio podría exponerse como un **MCP Server** para que asistentes AI (Claude, Cline, etc.) puedan enviar mensajes de WhatsApp directamente como herramienta.

El MCP Server sería un proceso aparte que:
1. Expone herramientas `send_whatsapp_text`, `send_whatsapp_image`, `send_whatsapp_file`
2. Cada herramienta llama internamente a `http://localhost:3001/...`
3. Los asistentes AI pueden invocar estas herramientas cuando el usuario pide enviar algo por WhatsApp

No implementado aún — ver `MCP_SERVER.md` cuando se cree.
