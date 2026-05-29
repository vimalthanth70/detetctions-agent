FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002
ENV ANTHROPIC_MODEL=claude-sonnet-4-6

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY detections-context-agent.md ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

CMD ["node", "scripts/server.mjs"]
