FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.125.0 \
  && npm cache clean --force

WORKDIR /app

ENV NODE_ENV=production
ENV CODEX_HOME=/app/.codex
ENV CODEX_BRIDGE_HOST=0.0.0.0
ENV CODEX_BRIDGE_PORT=18080

RUN mkdir -p /app/.codex

COPY package.json ./
COPY src ./src

EXPOSE 18080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18080/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
