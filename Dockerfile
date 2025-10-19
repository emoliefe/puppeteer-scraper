# Chrome yüklü resmi Puppeteer imajı
FROM ghcr.io/puppeteer/puppeteer:latest

# İçerden testler için curl (ve sertifikalar) ekle
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Uygulama dosyaları
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY server.js ./

# Ortam ve ağ
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Güvenlik: Puppeteer'ın varsayılan kullanıcısına dön
USER pptruser

# Uygulamayı başlat
CMD ["node", "server.js"]
