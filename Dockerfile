# Agent Desk: one small Node process (no native modules; SQLite is node:sqlite).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY web ./web
# Runs as the image's unprivileged "node" user; /app/data is the only writable path (a volume).
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "--no-warnings", "--import", "tsx", "src/main.ts"]
