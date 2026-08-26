# Build context is the REPO ROOT (see docker-compose.yml build.context),
# so all COPY paths below are relative to the repository root.

# ---------- Stage 1: compile TypeScript ----------
FROM node:20-alpine AS build

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci || npm install

COPY backend/tsconfig.json ./
COPY backend/src ./src

RUN npm run build

# ---------- Stage 2: slim runtime ----------
FROM node:20-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --from=build /app/backend/dist ./dist

# index.ts serves the Mini App from ../../webapp/public relative to dist/,
# i.e. /app/webapp/public in this image.
COPY webapp/public /app/webapp/public

EXPOSE 3000

# Health checking is handled by docker-compose (node http one-liner).
HEALTHCHECK NONE

CMD ["node", "dist/index.js"]
