# Resmi Puppeteer imajı (Chromium yüklü gelir)
FROM ghcr.io/puppeteer/puppeteer:latest

# Küçük yardımcılar
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Uygulama dosyaları
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY server.js ./

# Ortam
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Puppeteer default kullanıcısına geri dön
USER pptruser

# Uygulamayı başlat
CMD ["node", "server.js"]
