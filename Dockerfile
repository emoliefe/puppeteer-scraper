# Chrome yüklü resmi Puppeteer imajı
FROM ghcr.io/puppeteer/puppeteer:latest

# Healthcheck için curl ekle (root ile)
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Uygulama dosyaları
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000

# Docker native healthcheck (Coolify de kullanabilir)
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
  CMD curl -fs http://localhost:${PORT}/health || exit 1

# Güvenlik için tekrar pptruser'a dön
USER pptruser

CMD ["node", "server.js"]
