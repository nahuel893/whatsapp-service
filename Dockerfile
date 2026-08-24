# WhatsApp Service — Baileys HTTP API
#
# Node 24 is the floor: the message queue uses node:sqlite, which ships
# unflagged from that release. No native build step, no extra dependency.
#
# Build:
#   docker build -t whatsapp-service .
#
# Run — session/ and data/ MUST be volumes. session/ holds the WhatsApp auth
# keys (losing it forces a QR re-pair) and data/ holds the job database
# (losing it drops queued messages).
#
#   docker run -d --name whatsapp-service \
#     -p 3001:3001 \
#     -e API_KEY=... \
#     -v whatsapp-session:/app/session \
#     -v whatsapp-data:/app/data \
#     whatsapp-service
#
# First auth needs the QR, which is printed to the logs:
#   docker run --rm -it -e PRINT_QR=true -v whatsapp-session:/app/session ...
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
# `npm ci` installs exactly what package-lock.json pins — never a floating range.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY lib ./lib

# Written to at runtime; declared so a missing volume does not silently write
# into the container's writable layer without anyone noticing. Owned by `node`
# because the process drops to that user below.
RUN mkdir -p /app/session /app/data && chown -R node:node /app/session /app/data
VOLUME ["/app/session", "/app/data"]

ENV PORT=3001 \
    HOST=0.0.0.0 \
    SESSION_DIR=/app/session \
    DATA_DIR=/app/data

EXPOSE 3001

# /health stays open without credentials precisely so this works.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "index.js"]
