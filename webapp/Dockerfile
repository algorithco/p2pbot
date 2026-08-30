# Webapp — Telegram Mini App frontend (static + nginx reverse proxy to backend)
# Build context is REPO ROOT (docker-compose.yml context: .)
FROM nginx:alpine

# Static Mini App
COPY webapp/public /usr/share/nginx/html

# Nginx config (SPA fallback + /api proxy to backend)
COPY webapp/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=5 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:80/health >/dev/null 2>&1 || exit 1
