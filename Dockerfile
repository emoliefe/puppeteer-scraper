# Chrome yüklü resmi Puppeteer imajı
FROM ghcr.io/puppeteer/puppeteer:latest

# Healthcheck için curl ekle
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# Chrome’u elle kur (bazı sürümlerde eksik olabiliyor)
RUN npx puppeteer browsers install chrome

# Uygulama dosyaları
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000

# Healthcheck (isteğe bağlı)
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
  CMD curl -fs http://localhost:${PORT}/health || exit 1

# Puppeteer kullanıcısına geri dön
USER pptruser

CMD ["node", "server.js"]
