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

RUN apk upgrade --no-cache && addgroup -S backend && adduser -S backend -G backend

COPY backend/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Drop bundled npm/npx: unused at runtime, but ships vulnerable tar/brace-expansion copies that trip image scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/backend/dist ./dist

# Backend is API-only microservice — frontend is separate (webapp:80 nginx).
# No static webapp copy needed. For local dev without frontend, set SERVE_STATIC=true.

RUN chown -R backend:backend /app

EXPOSE 3000

USER backend

# Health checking is handled by docker-compose (node http one-liner).
HEALTHCHECK NONE

CMD ["node", "dist/index.js"]
