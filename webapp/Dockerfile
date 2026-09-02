# Webapp — Telegram Mini App frontend (Vite + nginx)
# Build context is REPO ROOT (docker-compose.yml context: .)
FROM node:20-alpine AS build
WORKDIR /app
COPY webapp/package.json webapp/package-lock.json* ./
RUN npm ci
COPY webapp/ ./
# Build Vite dist (fallback to static public if build fails)
RUN npm run build || (echo "vite build failed, falling back to public" && mkdir -p dist && cp -r public/* dist/ 2>/dev/null || true)

FROM nginx:alpine
# Built Vite output
COPY --from=build /app/dist /usr/share/nginx/html
# Fallback: if dist missing, will be empty — but public copy ensures minimal
# Nginx config (SPA fallback + /api proxy to backend)
COPY webapp/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=5 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:80/health >/dev/null 2>&1 || exit 1
