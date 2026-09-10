# Build context is REPO ROOT
FROM node:20-alpine AS build
WORKDIR /app/utradebot
COPY utradebot/package*.json ./
RUN npm ci || npm install
COPY utradebot/tsconfig.json ./
COPY utradebot/src ./src
RUN npm run build
# Copy schema.sql for runtime (ensureTables reads it if present)
COPY utradebot/src/db/schema.sql ./dist/db/schema.sql

FROM node:20-alpine
ENV NODE_ENV=production
ENV PORT=3003
WORKDIR /app/utradebot
RUN apk upgrade --no-cache && addgroup -S utrade && adduser -S utrade -G utrade
COPY utradebot/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
# Drop bundled npm/npx: unused at runtime, but ships vulnerable tar/brace-expansion copies that trip image scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/utradebot/dist ./dist
# Do NOT copy .env
RUN mkdir -p /app/utradebot/sessions && chown utrade:utrade /app/utradebot/sessions
EXPOSE 3003
USER utrade
HEALTHCHECK --interval=20s --timeout=3s --retries=5 --start-period=30s \
  CMD node -e "require('http').get('http://localhost:3003/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
