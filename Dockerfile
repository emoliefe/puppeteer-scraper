# Node 20 tabanlı imaj
FROM node:20-slim

# Root yetkisiyle gerekli bağımlılıklar + Chromium kurulumu
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     fonts-liberation \
     libasound2 \
     libatk-bridge2.0-0 \
     libatk1.0-0 \
     libcups2 \
     libdbus-1-3 \
     libdrm2 \
     libgbm1 \
     libgtk-3-0 \
     libnspr4 \
     libnss3 \
     libx11-xcb1 \
     libxcomposite1 \
     libxdamage1 \
     libxfixes3 \
     libxrandr2 \
     xdg-utils \
     curl \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer ve Express kurulumu
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Ortam değişkenleri
ENV PORT=3000
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]
