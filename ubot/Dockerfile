# Build context is REPO ROOT
FROM node:20-alpine AS build
WORKDIR /app/ubot
COPY ubot/package*.json ./
RUN npm ci || npm install
COPY ubot/tsconfig.json ./
COPY ubot/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
ENV PORT=3002
WORKDIR /app/ubot
RUN addgroup -S ubot && adduser -S ubot -G ubot
COPY ubot/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/ubot/dist ./dist
# Do NOT copy .env — injected via env_file
RUN mkdir -p /app/ubot/sessions && chown ubot:ubot /app/ubot/sessions
EXPOSE 3002
USER ubot
HEALTHCHECK --interval=20s --timeout=3s --retries=5 --start-period=30s \
  CMD node -e "require('http').get('http://localhost:3002/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
